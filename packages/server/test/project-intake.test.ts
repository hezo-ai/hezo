import { DEFAULT_TEAM_ID } from '@hezo/shared';
import type { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../src/db/database';
import type { Env } from '../src/lib/types';
import { PROJECT_INTAKE_MARKER } from '../src/services/project-intake';
import { safeClose } from './helpers';
import { authHeader, createTestApp } from './helpers/app';

let app: Hono<Env>;
let db: Db;
let token: string;

beforeAll(async () => {
	const ctx = await createTestApp();
	app = ctx.app;
	db = ctx.db;
	token = ctx.token;
});

beforeEach(async () => {
	await db.query('DELETE FROM teams WHERE id != $1', [DEFAULT_TEAM_ID]);
});

afterAll(async () => {
	await safeClose(db);
});

interface IntakeResponse {
	intake_task_id: string;
	intake_task_identifier: string;
	project_slug: string;
}

async function startIntake(body: Record<string, unknown>) {
	return app.request('/api/project-intakes', {
		method: 'POST',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify(body),
	});
}

async function fetchComments(projectSlug: string, taskIdentifier: string) {
	const res = await app.request(`/api/projects/${projectSlug}/tasks/${taskIdentifier}/comments`, {
		headers: authHeader(token),
	});
	return (await res.json()).data as Array<{
		author_name: string;
		content_type: string;
		content: { text: string };
	}>;
}

async function countNonHqTeams(): Promise<number> {
	const r = await db.query<{ count: number }>(
		'SELECT count(*)::int AS count FROM teams WHERE id != $1',
		[DEFAULT_TEAM_ID],
	);
	return r.rows[0].count;
}

async function countApprovals(): Promise<number> {
	const r = await db.query<{ count: number }>('SELECT count(*)::int AS count FROM approvals');
	return r.rows[0].count;
}

describe('project intake (CEO-assisted)', () => {
	it('opens an HQ intake conversation — no team, project, or approval is created', async () => {
		const res = await startIntake({
			name: 'Mobile App',
			description: 'A new mobile app for our customers',
		});
		expect(res.status).toBe(201);
		const intake = (await res.json()).data as IntakeResponse;

		// The conversation lives in the HQ project.
		expect(intake.project_slug).toBe('hq');
		expect(intake.intake_task_identifier).toMatch(/^HQ-\d+$/);

		// Nothing is created up front: no new team, no project, no approval row.
		expect(await countNonHqTeams()).toBe(0);
		expect(await countApprovals()).toBe(0);
		const projectCount = await db.query<{ count: number }>(
			`SELECT count(*)::int AS count FROM projects WHERE is_internal = false`,
		);
		expect(projectCount.rows[0].count).toBe(0);

		// The intake ticket carries the marker and records the (default) baseline.
		const taskRow = await db.query<{ description: string; labels: unknown }>(
			'SELECT description, labels FROM tasks WHERE id = $1',
			[intake.intake_task_id],
		);
		expect(taskRow.rows[0].description).toContain(PROJECT_INTAKE_MARKER);
		expect(taskRow.rows[0].description).toContain('Baseline team type');
		expect(taskRow.rows[0].description).toContain('Blank');

		const comments = await fetchComments(intake.project_slug, intake.intake_task_identifier);
		expect(comments.some((c) => c.content.text.includes("I'm the CEO"))).toBe(true);
	});

	it('records the admin-chosen team type as the CEO baseline on the intake ticket', async () => {
		const typesRes = await app.request('/api/team-templates', { headers: authHeader(token) });
		const startup = (await typesRes.json()).data.find(
			(t: { name: string }) => t.name === 'Startup',
		) as { id: string };

		const res = await startIntake({
			name: 'Growth Site',
			description: 'Marketing site and growth experiments',
			template_id: startup.id,
		});
		expect(res.status).toBe(201);
		const intake = (await res.json()).data as IntakeResponse;

		const taskRow = await db.query<{ description: string }>(
			'SELECT description FROM tasks WHERE id = $1',
			[intake.intake_task_id],
		);
		expect(taskRow.rows[0].description).toContain('Startup');
		expect(taskRow.rows[0].description).toContain(startup.id);

		// Still nothing materialised — the team type is only a baseline suggestion.
		expect(await countNonHqTeams()).toBe(0);
		expect(await countApprovals()).toBe(0);
	});

	it('rejects missing name/description with 400 and creates nothing', async () => {
		const res = await startIntake({ name: '', description: 'desc' });
		expect(res.status).toBe(400);
		expect(await countNonHqTeams()).toBe(0);
		expect(await countApprovals()).toBe(0);
	});

	it('rejects an unknown template_id with 404', async () => {
		const res = await startIntake({
			name: 'Ghost',
			description: 'desc',
			template_id: '11111111-1111-1111-1111-111111111111',
		});
		expect(res.status).toBe(404);
		expect(await countNonHqTeams()).toBe(0);
	});
});
