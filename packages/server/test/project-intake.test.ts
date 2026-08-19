import { DEFAULT_TEAM_ID, WakeupSource } from '@hezo/shared';
import type { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
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

	it('records the admin-chosen team type as the CEO baseline on the intake task', async () => {
		const typesRes = await app.request('/api/team-templates', { headers: authHeader(token) });
		const startup = (await typesRes.json()).data.find(
			(t: { name: string }) => t.name === 'App Team',
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
		expect(taskRow.rows[0].description).toContain('App Team');
		expect(taskRow.rows[0].description).toContain(startup.id);

		// Still nothing materialised — the team type is only a baseline suggestion.
		expect(await countNonHqTeams()).toBe(0);
		expect(await countApprovals()).toBe(0);
	});

	it('starts no CEO run, and reaches the admin through the inbox instead', async () => {
		const res = await startIntake({
			name: 'Translations Workflow',
			description: 'we need a workflow for doing translations',
		});
		expect(res.status).toBe(201);
		const intake = (await res.json()).data as IntakeResponse;

		// The greeting already carries the CEO's opening ask, so a run fired now would
		// only re-introduce and re-ask it - and would then keep re-running while the
		// admin has still said nothing.
		const wakeups = await db.query<{ count: number }>(
			`SELECT count(*)::int AS count FROM agent_wakeup_requests w
			 WHERE w.payload->>'task_id' = $1`,
			[intake.intake_task_id],
		);
		expect(wakeups.rows[0].count).toBe(0);

		// The admin reach the run used to provide comes from the inbox row on the
		// greeting, which carries no literal @admin of its own.
		const mentions = await db.query<{ comment_id: string }>(
			'SELECT comment_id FROM admin_mentions WHERE task_id = $1',
			[intake.intake_task_id],
		);
		expect(mentions.rows.length).toBeGreaterThan(0);

		const greeting = await db.query<{ id: string }>(
			`SELECT id FROM task_comments WHERE task_id = $1 ORDER BY created_at ASC LIMIT 1`,
			[intake.intake_task_id],
		);
		expect(mentions.rows[0].comment_id).toBe(greeting.rows[0].id);
	});

	it('wakes the CEO once the admin replies to the greeting', async () => {
		const res = await startIntake({ name: 'Reply Path', description: 'a project to scope' });
		const intake = (await res.json()).data as IntakeResponse;

		const greeting = await db.query<{ id: string }>(
			`SELECT id FROM task_comments WHERE task_id = $1 ORDER BY created_at ASC LIMIT 1`,
			[intake.intake_task_id],
		);

		// The home panel threads the admin's message onto the last CEO comment, which
		// is now the greeting. That reply is what starts the CEO's first run.
		const posted = await app.request(
			`/api/projects/${intake.project_slug}/tasks/${intake.intake_task_identifier}/comments`,
			{
				method: 'POST',
				headers: { ...authHeader(token), 'Content-Type': 'application/json' },
				body: JSON.stringify({
					content: 'It is a translations pipeline',
					parent_comment_id: greeting.rows[0].id,
				}),
			},
		);
		expect(posted.status).toBe(201);

		await vi.waitFor(async () => {
			const wakeups = await db.query<{ source: string }>(
				`SELECT source::text AS source FROM agent_wakeup_requests
				 WHERE payload->>'task_id' = $1`,
				[intake.intake_task_id],
			);
			expect(wakeups.rows.map((r) => r.source)).toContain(WakeupSource.Reply);
		});
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
