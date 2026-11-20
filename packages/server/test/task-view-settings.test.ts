import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MasterKeyManager } from '../src/crypto/master-key';
import type { Db } from '../src/db/database';
import { waitForBackground } from '../src/lib/background';
import type { Env } from '../src/lib/types';
import { safeClose } from './helpers';
import {
	authHeader,
	createTestApp,
	createTestProject,
	createTestTeam,
	mintAgentToken,
	settleTeamSetupReview,
} from './helpers/app';

let app: Hono<Env>;
let db: Db;
let token: string;
let masterKeyManager: MasterKeyManager;
let teamId: string;
let projectSlug: string;
let otherProjectSlug: string;
let agentId: string;

beforeAll(async () => {
	const ctx = await createTestApp();
	app = ctx.app;
	db = ctx.db;
	token = ctx.token;
	masterKeyManager = ctx.masterKeyManager;

	const team = (await (await createTestTeam(db, { name: 'View Settings Co' })).json()).data;
	teamId = team.id;
	const project = (
		await (
			await createTestProject(db, teamId, { name: 'View Settings', description: 'Test project.' })
		).json()
	).data;
	projectSlug = project.slug;

	const otherTeam = (await (await createTestTeam(db, { name: 'Other View Co' })).json()).data;
	const otherProject = (
		await (
			await createTestProject(db, otherTeam.id, { name: 'Other View', description: 'Other.' })
		).json()
	).data;
	otherProjectSlug = otherProject.slug;

	const agentRes = await app.request(`/api/projects/${projectSlug}/agents`, {
		method: 'POST',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify({ title: 'View Agent' }),
	});
	agentId = (await agentRes.json()).data.id;
	await settleTeamSetupReview(db, teamId);
});

afterAll(async () => {
	await waitForBackground();
	await safeClose(db);
});

/**
 * Insert an unassigned task straight into the table: the subject here is the
 * card state, and a REST create with an assignee would wake an agent.
 */
async function createTask(
	slug: string,
	title: string,
): Promise<{ id: string; identifier: string }> {
	const meta = await db.query<{ id: string; team_id: string; task_prefix: string; number: number }>(
		`SELECT p.id, p.team_id, p.task_prefix, next_project_task_number(p.id) AS number
		 FROM projects p WHERE p.slug = $1`,
		[slug],
	);
	const { id: projectId, team_id, task_prefix, number } = meta.rows[0];
	const res = await db.query<{ id: string; identifier: string }>(
		`INSERT INTO tasks (team_id, project_id, number, identifier, title)
		 VALUES ($1, $2, $3, $4, $5)
		 RETURNING id, identifier`,
		[team_id, projectId, number, `${task_prefix}-${number}`, title],
	);
	return res.rows[0];
}

function patchViewSettings(slug: string, taskRef: string, body: unknown, bearer = token) {
	return app.request(`/api/projects/${slug}/tasks/${taskRef}/view-settings`, {
		method: 'PATCH',
		headers: { ...authHeader(bearer), 'Content-Type': 'application/json' },
		body: JSON.stringify(body),
	});
}

async function getTask(slug: string, taskRef: string) {
	const res = await app.request(`/api/projects/${slug}/tasks/${taskRef}`, {
		headers: authHeader(token),
	});
	expect(res.status).toBe(200);
	return (await res.json()).data as { sections_open: Record<string, boolean>; updated_at: string };
}

async function settingsRow(taskId: string) {
	const rows = await db.query<{ sections_open: Record<string, boolean>; updated_at: string }>(
		`SELECT sections_open, updated_at::text AS updated_at FROM task_view_settings WHERE task_id = $1`,
		[taskId],
	);
	return rows.rows[0];
}

describe('task view settings', () => {
	it('returns an empty saved state for a task nobody has toggled', async () => {
		const task = await createTask(projectSlug, 'Fresh task');
		const detail = await getTask(projectSlug, task.identifier.toLowerCase());
		expect(detail.sections_open).toEqual({});
		expect(await settingsRow(task.id)).toBeUndefined();
	});

	it('merges partial updates and returns the saved state on the task read', async () => {
		const task = await createTask(projectSlug, 'Fold and unfold');

		const first = await patchViewSettings(projectSlug, task.identifier.toLowerCase(), {
			sections_open: { sub_tasks: false },
		});
		expect(first.status).toBe(200);
		expect((await first.json()).data).toEqual({ sections_open: { sub_tasks: false } });

		const second = await patchViewSettings(projectSlug, task.id, {
			sections_open: { rules: true, progress_summary: true },
		});
		expect(second.status).toBe(200);
		expect((await second.json()).data).toEqual({
			sections_open: { sub_tasks: false, rules: true, progress_summary: true },
		});

		const third = await patchViewSettings(projectSlug, task.id, {
			sections_open: { rules: false },
		});
		expect((await third.json()).data.sections_open).toEqual({
			sub_tasks: false,
			rules: false,
			progress_summary: true,
		});

		const detail = await getTask(projectSlug, task.identifier.toLowerCase());
		expect(detail.sections_open).toEqual({
			sub_tasks: false,
			rules: false,
			progress_summary: true,
		});
	});

	it('keeps each task state separate', async () => {
		const a = await createTask(projectSlug, 'Task A');
		const b = await createTask(projectSlug, 'Task B');
		await patchViewSettings(projectSlug, a.id, { sections_open: { rules: true } });
		expect((await getTask(projectSlug, a.id)).sections_open).toEqual({ rules: true });
		expect((await getTask(projectSlug, b.id)).sections_open).toEqual({});
	});

	it('leaves the task itself untouched: no updated_at change, no audit entry', async () => {
		const task = await createTask(projectSlug, 'Quiet toggle');
		await waitForBackground();
		const before = await db.query<{ updated_at: string }>(
			`SELECT updated_at::text AS updated_at FROM tasks WHERE id = $1`,
			[task.id],
		);
		const auditBefore = await db.query<{ count: number }>(
			`SELECT count(*)::int AS count FROM audit_log WHERE entity_type = 'task' AND entity_id = $1`,
			[task.id],
		);

		const res = await patchViewSettings(projectSlug, task.id, {
			sections_open: { sub_tasks: false, rules: true },
		});
		expect(res.status).toBe(200);
		await waitForBackground();

		const after = await db.query<{ updated_at: string }>(
			`SELECT updated_at::text AS updated_at FROM tasks WHERE id = $1`,
			[task.id],
		);
		expect(after.rows[0].updated_at).toBe(before.rows[0].updated_at);
		const auditAfter = await db.query<{ count: number }>(
			`SELECT count(*)::int AS count FROM audit_log WHERE entity_type = 'task' AND entity_id = $1`,
			[task.id],
		);
		expect(auditAfter.rows[0].count).toBe(auditBefore.rows[0].count);
	});

	it('does not rewrite the row when the update changes nothing', async () => {
		const task = await createTask(projectSlug, 'Same value twice');
		await patchViewSettings(projectSlug, task.id, { sections_open: { rules: true } });
		const first = await settingsRow(task.id);

		const again = await patchViewSettings(projectSlug, task.id, {
			sections_open: { rules: true },
		});
		expect(again.status).toBe(200);
		expect((await again.json()).data).toEqual({ sections_open: { rules: true } });
		const second = await settingsRow(task.id);
		expect(second.updated_at).toBe(first.updated_at);
	});

	it.each([
		['an unknown section', { sections_open: { comments: true } }, 'unknown section'],
		['a value that is not a boolean', { sections_open: { rules: 'yes' } }, 'must be a boolean'],
		['an empty update', { sections_open: {} }, 'at least one'],
		['a missing sections_open', { rules: true }, 'must be an object'],
	])('rejects %s with 400', async (_label, body, message) => {
		const task = await createTask(projectSlug, `Bad body ${message}`);
		const res = await patchViewSettings(projectSlug, task.id, body);
		expect(res.status).toBe(400);
		expect((await res.json()).error.message).toContain(message);
		expect(await settingsRow(task.id)).toBeUndefined();
	});

	it('returns 404 for a task outside the addressed project', async () => {
		const foreign = await createTask(otherProjectSlug, 'Not yours');
		const res = await patchViewSettings(projectSlug, foreign.id, {
			sections_open: { rules: true },
		});
		expect(res.status).toBe(404);
		expect(await settingsRow(foreign.id)).toBeUndefined();
	});

	it('refuses an agent run token, since the REST surface is for people', async () => {
		const task = await createTask(projectSlug, 'Agent tries');
		const agent = await mintAgentToken(db, masterKeyManager, agentId, teamId, task.id);
		const res = await patchViewSettings(
			projectSlug,
			task.id,
			{ sections_open: { rules: true } },
			agent.token,
		);
		expect(res.status).toBe(401);
		expect(await settingsRow(task.id)).toBeUndefined();
	});
});
