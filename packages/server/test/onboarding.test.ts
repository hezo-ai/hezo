import type { PGlite } from '@electric-sql/pglite';
import { TaskStatus } from '@hezo/shared';
import type { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Env } from '../src/lib/types';
import { ONBOARDING_INTAKE_TITLE } from '../src/services/onboarding-intake';
import { safeClose } from './helpers';
import { authHeader, createTestApp, createTestProject } from './helpers/app';

let app: Hono<Env>;
let db: PGlite;
let token: string;

beforeAll(async () => {
	const ctx = await createTestApp();
	app = ctx.app;
	db = ctx.db;
	token = ctx.token;
});

beforeEach(async () => {
	await db.query('DELETE FROM teams');
});

afterAll(async () => {
	await safeClose(db);
});

async function createBlankTeam(name: string) {
	const blank = await db.query<{ id: string }>(
		"SELECT id FROM team_templates WHERE name = 'Blank' LIMIT 1",
	);
	const teamRes = await app.request('/api/teams', {
		method: 'POST',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify({ name, template_id: blank.rows[0].id }),
	});
	expect(teamRes.status).toBe(201);
	return (await teamRes.json()).data as { id: string; slug: string };
}

describe('onboarding status', () => {
	it('reports intake as pending and no project for a brand-new team', async () => {
		const team = await createBlankTeam('Fresh Onboard Co');

		const res = await app.request(`/api/projects/internal-${team.slug}/onboarding`, {
			headers: authHeader(token),
		});
		expect(res.status).toBe(200);
		const status = (await res.json()).data as {
			show_welcome: boolean;
			current_stage: string;
			stages: Record<string, string>;
			primary_project: unknown;
		};
		expect(status.show_welcome).toBe(true);
		expect(status.current_stage).toBe('intake');
		expect(status.stages.intake).toBe('pending');
		expect(status.stages.done).toBe('pending');
		expect(status.primary_project).toBeNull();
	});

	it('moves intake to current when the onboarding ticket is opened', async () => {
		const team = await createBlankTeam('Open Intake Co');

		await app.request(`/api/projects/internal-${team.slug}/onboarding-intake?ensure=true`, {
			headers: authHeader(token),
		});

		const res = await app.request(`/api/projects/internal-${team.slug}/onboarding`, {
			headers: authHeader(token),
		});
		const status = (await res.json()).data as {
			current_stage: string;
			stages: Record<string, string>;
		};
		expect(status.current_stage).toBe('intake');
		expect(status.stages.intake).toBe('current');
	});

	it('reports done when the onboarding ticket is closed and a user project exists', async () => {
		const team = await createBlankTeam('Done Onboard Co');

		const intakeRes = await app.request(
			`/api/projects/internal-${team.slug}/onboarding-intake?ensure=true`,
			{
				headers: authHeader(token),
			},
		);
		const intake = (await intakeRes.json()).data as { task_id: string };

		const projectRes = await createTestProject(db, team.id, {
			name: 'First Product',
			description: 'Build the thing',
		});
		expect(projectRes.status).toBe(201);

		await app.request(`/api/projects/internal-${team.slug}/tasks/${intake.task_id}`, {
			method: 'PATCH',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ status: TaskStatus.Done }),
		});

		const res = await app.request(`/api/projects/internal-${team.slug}/onboarding`, {
			headers: authHeader(token),
		});
		const status = (await res.json()).data as {
			show_welcome: boolean;
			current_stage: string;
			stages: Record<string, string>;
			primary_project: { name: string } | null;
		};
		expect(status.show_welcome).toBe(false);
		expect(status.current_stage).toBe('done');
		expect(status.stages.intake).toBe('complete');
		expect(status.stages.done).toBe('complete');
		expect(status.primary_project?.name).toBe('First Product');
	});

	it('only ever opens a single onboarding ticket per team', async () => {
		const team = await createBlankTeam('Single Ticket Co');

		const first = await app.request(
			`/api/projects/internal-${team.slug}/onboarding-intake?ensure=true`,
			{
				headers: authHeader(token),
			},
		);
		const intake = (await first.json()).data as { task_id: string };

		await app.request(`/api/projects/internal-${team.slug}/onboarding-intake?ensure=true`, {
			headers: authHeader(token),
		});

		const tasksRes = await app.request(`/api/projects/internal-${team.slug}/tasks`, {
			headers: authHeader(token),
		});
		const tasks = (await tasksRes.json()).data as Array<{ id: string; title: string }>;
		const onboarding = tasks.filter((i) => i.title === ONBOARDING_INTAKE_TITLE);
		expect(onboarding.length).toBe(1);
		expect(onboarding[0].id).toBe(intake.task_id);
	});
});
