import type { PGlite } from '@electric-sql/pglite';
import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MasterKeyManager } from '../src/crypto/master-key';
import type { Env } from '../src/lib/types';
import { safeClose } from './helpers';
import { authHeader, createTestApp, createTestProject, mintAgentToken } from './helpers/app';

let app: Hono<Env>;
let db: PGlite;
let token: string;
let masterKeyManager: MasterKeyManager;
let teamId: string;
let teamSlug: string;
let projectId: string;
let projectSlug: string;
let agentId: string;

beforeAll(async () => {
	const ctx = await createTestApp();
	app = ctx.app;
	db = ctx.db;
	token = ctx.token;
	masterKeyManager = ctx.masterKeyManager;

	const teamRes = await app.request('/api/teams', {
		method: 'POST',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify({ name: 'Task Test Co' }),
	});
	const teamData = (await teamRes.json()).data;
	teamId = teamData.id;
	teamSlug = teamData.slug;

	const projectRes = await createTestProject(db, teamId, {
		name: 'Main Project',
		description: 'Test project.',
	});
	const projectBody = (await projectRes.json()).data;
	projectId = projectBody.id;
	projectSlug = projectBody.slug;

	const agentRes = await app.request(`/api/projects/${projectSlug}/agents`, {
		method: 'POST',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify({ title: 'Test Agent' }),
	});
	agentId = (await agentRes.json()).data.id;
});

afterAll(async () => {
	await safeClose(db);
});

async function insertTaskDirect(
	assigneeId: string,
	title: string,
): Promise<{ id: string; identifier: string }> {
	const meta = await db.query<{ task_prefix: string; number: number }>(
		`SELECT p.task_prefix, next_project_task_number(p.id) AS number
		 FROM projects p WHERE p.id = $1`,
		[projectId],
	);
	const n = meta.rows[0].number;
	const res = await db.query<{ id: string; identifier: string }>(
		`INSERT INTO tasks (team_id, project_id, assignee_id, number, identifier, title, status, priority, labels)
		 VALUES ($1, $2, $3, $4, $5, $6, 'backlog'::task_status, 'medium'::task_priority, '[]'::jsonb)
		 RETURNING id, identifier`,
		[teamId, projectId, assigneeId, n, `${meta.rows[0].task_prefix}-${n}`, title],
	);
	return res.rows[0];
}

// PATCH /tasks fires wakeAgentIfAssigned without awaiting (fire-and-forget).
// Wait one microtask flush so the catch-handled createWakeup lands before we
// read the wakeup table.
function flushAsyncWakeups(): Promise<void> {
	return new Promise((resolve) => setImmediate(resolve));
}

describe('tasks CRUD', () => {
	it('creates an task with auto-generated identifier', async () => {
		const res = await app.request(`/api/projects/${projectSlug}/tasks`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				project_id: projectId,
				title: 'First task',
				priority: 'high',
				assignee_id: agentId,
			}),
		});
		expect(res.status).toBe(201);
		const body = await res.json();
		expect(body.data.identifier).toMatch(/^MP-\d+$/);
		expect(body.data.number).toBeGreaterThanOrEqual(1);
		expect(body.data.status).toBe('backlog');
		expect(body.data.priority).toBe('high');
		expect(body.data.runtime_type).toBeNull();
	});

	it('accepts a runtime_type override on create and honors it on update', async () => {
		const createRes = await app.request(`/api/projects/${projectSlug}/tasks`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				project_id: projectId,
				title: 'Codex-only task',
				assignee_id: agentId,
				runtime_type: 'codex',
			}),
		});
		expect(createRes.status).toBe(201);
		const created = (await createRes.json()).data;
		expect(created.runtime_type).toBe('codex');

		const patchRes = await app.request(`/api/projects/${projectSlug}/tasks/${created.id}`, {
			method: 'PATCH',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ runtime_type: 'gemini' }),
		});
		expect(patchRes.status).toBe(200);
		expect((await patchRes.json()).data.runtime_type).toBe('gemini');
	});

	it('PATCH blocks an agent run from starting a different ticket (run-task scope)', async () => {
		const runTask = await insertTaskDirect(agentId, 'REST scope run ticket');
		const otherTask = await insertTaskDirect(agentId, 'REST scope other ticket');
		const { token: agentToken } = await mintAgentToken(
			db,
			masterKeyManager,
			agentId,
			teamId,
			runTask.id,
		);

		// Blocked: a DIFFERENT ticket moved to in_progress inside this run.
		const blocked = await app.request(`/api/projects/${projectSlug}/tasks/${otherTask.id}`, {
			method: 'PATCH',
			headers: { ...authHeader(agentToken), 'Content-Type': 'application/json' },
			body: JSON.stringify({ status: 'in_progress' }),
		});
		expect(blocked.status).toBe(403);
		const otherRow = await db.query<{ status: string }>('SELECT status FROM tasks WHERE id = $1', [
			otherTask.id,
		]);
		expect(otherRow.rows[0].status).toBe('backlog');

		// Allowed: the run's OWN ticket moved to in_progress.
		const allowed = await app.request(`/api/projects/${projectSlug}/tasks/${runTask.id}`, {
			method: 'PATCH',
			headers: { ...authHeader(agentToken), 'Content-Type': 'application/json' },
			body: JSON.stringify({ status: 'in_progress' }),
		});
		expect(allowed.status).toBe(200);
		expect((await allowed.json()).data.status).toBe('in_progress');
	});

	it('creates sequential task numbers', async () => {
		const firstRes = await app.request(`/api/projects/${projectSlug}/tasks`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				project_id: projectId,
				title: 'Sequential A',
				assignee_id: agentId,
			}),
		});
		expect(firstRes.status).toBe(201);
		const firstNum = (await firstRes.json()).data.number;

		const secondRes = await app.request(`/api/projects/${projectSlug}/tasks`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				project_id: projectId,
				title: 'Sequential B',
				assignee_id: agentId,
			}),
		});
		expect(secondRes.status).toBe(201);
		const secondNum = (await secondRes.json()).data.number;
		expect(secondNum).toBe(firstNum + 1);
	});

	it('lists tasks with pagination', async () => {
		const res = await app.request(`/api/projects/${projectSlug}/tasks?per_page=1`, {
			headers: authHeader(token),
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.data).toHaveLength(1);
		expect(body.meta.total).toBeGreaterThanOrEqual(2);
		expect(body.meta.per_page).toBe(1);
	});

	it('filters tasks by status', async () => {
		const res = await app.request(`/api/projects/${projectSlug}/tasks?status=backlog`, {
			headers: authHeader(token),
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.data.every((i: any) => i.status === 'backlog')).toBe(true);
	});

	it('gets an task by id with computed fields', async () => {
		const listRes = await app.request(`/api/projects/${projectSlug}/tasks`, {
			headers: authHeader(token),
		});
		const task = (await listRes.json()).data[0];

		const res = await app.request(`/api/projects/${projectSlug}/tasks/${task.id}`, {
			headers: authHeader(token),
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.data).toHaveProperty('project_name');
		expect(body.data).toHaveProperty('comment_count');
		expect(body.data).toHaveProperty('cost_cents');
	});

	it('resolves an task by identifier (case-insensitive)', async () => {
		const listRes = await app.request(`/api/projects/${projectSlug}/tasks`, {
			headers: authHeader(token),
		});
		const task = (await listRes.json()).data[0];

		const upperRes = await app.request(`/api/projects/${projectSlug}/tasks/${task.identifier}`, {
			headers: authHeader(token),
		});
		expect(upperRes.status).toBe(200);
		expect((await upperRes.json()).data.id).toBe(task.id);

		const lowerRes = await app.request(
			`/api/projects/${projectSlug}/tasks/${task.identifier.toLowerCase()}`,
			{ headers: authHeader(token) },
		);
		expect(lowerRes.status).toBe(200);
		expect((await lowerRes.json()).data.id).toBe(task.id);
	});

	it('updates an task status', async () => {
		const listRes = await app.request(`/api/projects/${projectSlug}/tasks`, {
			headers: authHeader(token),
		});
		const task = (await listRes.json()).data[0];

		const res = await app.request(`/api/projects/${projectSlug}/tasks/${task.id}`, {
			method: 'PATCH',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ status: 'in_progress' }),
		});
		expect(res.status).toBe(200);
		expect((await res.json()).data.status).toBe('in_progress');
	});

	it('creates a sub-task', async () => {
		const listRes = await app.request(`/api/projects/${projectSlug}/tasks`, {
			headers: authHeader(token),
		});
		const parentTask = (await listRes.json()).data[0];

		const res = await app.request(`/api/projects/${projectSlug}/tasks/${parentTask.id}/sub-tasks`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ title: 'Sub-task', assignee_id: agentId }),
		});
		expect(res.status).toBe(201);
		const body = await res.json();
		expect(body.data.parent_task_id).toBe(parentTask.id);
		expect(body.data.identifier).toMatch(/^MP-\d+$/);
	});

	it('manages task dependencies', async () => {
		const listRes = await app.request(`/api/projects/${projectSlug}/tasks`, {
			headers: authHeader(token),
		});
		const tasks = (await listRes.json()).data;

		// Add dependency
		const addRes = await app.request(
			`/api/projects/${projectSlug}/tasks/${tasks[0].id}/dependencies`,
			{
				method: 'POST',
				headers: { ...authHeader(token), 'Content-Type': 'application/json' },
				body: JSON.stringify({ blocked_by_task_id: tasks[1].id }),
			},
		);
		expect(addRes.status).toBe(201);

		// List dependencies
		const listDepsRes = await app.request(
			`/api/projects/${projectSlug}/tasks/${tasks[0].id}/dependencies`,
			{ headers: authHeader(token) },
		);
		expect(listDepsRes.status).toBe(200);
		const deps = (await listDepsRes.json()).data;
		expect(deps).toHaveLength(1);
		expect(deps[0].blocked_by_project_slug).toBe(projectSlug);
		expect(deps[0].blocked_by_identifier).toBe(tasks[1].identifier);

		// Remove dependency
		const removeRes = await app.request(
			`/api/projects/${projectSlug}/tasks/${tasks[0].id}/dependencies/${deps[0].id}`,
			{ method: 'DELETE', headers: authHeader(token) },
		);
		expect(removeRes.status).toBe(200);
	});

	it('updates and retrieves progress_summary', async () => {
		const listRes = await app.request(`/api/projects/${projectSlug}/tasks`, {
			headers: authHeader(token),
		});
		const task = (await listRes.json()).data[0];

		const summary =
			'## Requirements\n- Build auth module\n\n## Done\n- Set up project\n\n## Next\n- Implement login';
		const patchRes = await app.request(`/api/projects/${projectSlug}/tasks/${task.id}`, {
			method: 'PATCH',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ progress_summary: summary }),
		});
		expect(patchRes.status).toBe(200);
		const patched = (await patchRes.json()).data;
		expect(patched.progress_summary).toBe(summary);
		expect(patched.progress_summary_updated_at).toBeTruthy();

		// GET detail includes progress_summary and updater name
		const detailRes = await app.request(`/api/projects/${projectSlug}/tasks/${task.id}`, {
			headers: authHeader(token),
		});
		expect(detailRes.status).toBe(200);
		const detail = (await detailRes.json()).data;
		expect(detail.progress_summary).toBe(summary);
		expect(detail.progress_summary_updated_at).toBeTruthy();
	});

	it('clears progress_summary with null', async () => {
		const listRes = await app.request(`/api/projects/${projectSlug}/tasks`, {
			headers: authHeader(token),
		});
		const task = (await listRes.json()).data[0];

		// Set it first
		await app.request(`/api/projects/${projectSlug}/tasks/${task.id}`, {
			method: 'PATCH',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ progress_summary: 'Some summary' }),
		});

		// Clear it
		const clearRes = await app.request(`/api/projects/${projectSlug}/tasks/${task.id}`, {
			method: 'PATCH',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ progress_summary: null }),
		});
		expect(clearRes.status).toBe(200);
		expect((await clearRes.json()).data.progress_summary).toBeNull();
	});

	it('does not include progress_summary in list view', async () => {
		const listRes = await app.request(`/api/projects/${projectSlug}/tasks`, {
			headers: authHeader(token),
		});
		expect(listRes.status).toBe(200);
		const tasks = (await listRes.json()).data;
		// List query selects specific columns, progress_summary should not be there
		expect(tasks[0]).not.toHaveProperty('progress_summary');
	});

	it('updates and retrieves rules', async () => {
		const listRes = await app.request(`/api/projects/${projectSlug}/tasks`, {
			headers: authHeader(token),
		});
		const task = (await listRes.json()).data[0];

		const rules = 'Consult the architect before making changes.\nPrioritize performance.';
		const patchRes = await app.request(`/api/projects/${projectSlug}/tasks/${task.id}`, {
			method: 'PATCH',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ rules }),
		});
		expect(patchRes.status).toBe(200);
		const patched = (await patchRes.json()).data;
		expect(patched.rules).toBe(rules);

		const detailRes = await app.request(`/api/projects/${projectSlug}/tasks/${task.id}`, {
			headers: authHeader(token),
		});
		expect(detailRes.status).toBe(200);
		expect((await detailRes.json()).data.rules).toBe(rules);
	});

	it('clears rules with null', async () => {
		const listRes = await app.request(`/api/projects/${projectSlug}/tasks`, {
			headers: authHeader(token),
		});
		const task = (await listRes.json()).data[0];

		await app.request(`/api/projects/${projectSlug}/tasks/${task.id}`, {
			method: 'PATCH',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ rules: 'Some rules' }),
		});

		const clearRes = await app.request(`/api/projects/${projectSlug}/tasks/${task.id}`, {
			method: 'PATCH',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ rules: null }),
		});
		expect(clearRes.status).toBe(200);
		expect((await clearRes.json()).data.rules).toBeNull();
	});

	it('does not include rules in list view', async () => {
		const listRes = await app.request(`/api/projects/${projectSlug}/tasks`, {
			headers: authHeader(token),
		});
		expect(listRes.status).toBe(200);
		const tasks = (await listRes.json()).data;
		expect(tasks[0]).not.toHaveProperty('rules');
	});

	it('rejects task creation without assignee_id', async () => {
		const res = await app.request(`/api/projects/${projectSlug}/tasks`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				project_id: projectId,
				title: 'No assignee task',
			}),
		});
		expect(res.status).toBe(400);
		const body = await res.json();
		expect(body.error.message).toMatch(/assignee_(id|slug)/);
	});

	it('rejects sub-task creation without assignee_id', async () => {
		const listRes = await app.request(`/api/projects/${projectSlug}/tasks`, {
			headers: authHeader(token),
		});
		const parentTask = (await listRes.json()).data[0];

		const res = await app.request(`/api/projects/${projectSlug}/tasks/${parentTask.id}/sub-tasks`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ title: 'Sub without assignee' }),
		});
		expect(res.status).toBe(400);
		const body = await res.json();
		expect(body.error.message).toMatch(/assignee_(id|slug)/);
	});

	it('rejects setting assignee_id to null on update', async () => {
		const listRes = await app.request(`/api/projects/${projectSlug}/tasks`, {
			headers: authHeader(token),
		});
		const task = (await listRes.json()).data[0];

		const res = await app.request(`/api/projects/${projectSlug}/tasks/${task.id}`, {
			method: 'PATCH',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ assignee_id: null }),
		});
		expect(res.status).toBe(400);
		const body = await res.json();
		expect(body.error.message).toContain('assignee_id cannot be null');
	});

	it('filters by multiple assignee_ids when comma-separated', async () => {
		const secondAgentRes = await app.request(`/api/projects/${projectSlug}/agents`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ title: 'Second Agent' }),
		});
		const secondAgentId = (await secondAgentRes.json()).data.id;

		await app.request(`/api/projects/${projectSlug}/tasks`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				project_id: projectId,
				title: 'Agent two ticket',
				assignee_id: secondAgentId,
			}),
		});

		const listRes = await app.request(
			`/api/projects/${projectSlug}/tasks?assignee_id=${agentId},${secondAgentId}`,
			{ headers: authHeader(token) },
		);
		expect(listRes.status).toBe(200);
		const tasks = (await listRes.json()).data;
		const assigneeIds = new Set(tasks.map((i: any) => i.assignee_id));
		expect(assigneeIds.has(agentId)).toBe(true);
		expect(assigneeIds.has(secondAgentId)).toBe(true);
	});

	it('pins tasks with active runs to the top regardless of sort order', async () => {
		const oldRes = await app.request(`/api/projects/${projectSlug}/tasks`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				project_id: projectId,
				title: 'Old running task',
				assignee_id: agentId,
			}),
		});
		const oldTask = (await oldRes.json()).data;

		await new Promise((r) => setTimeout(r, 10));

		const newRes = await app.request(`/api/projects/${projectSlug}/tasks`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				project_id: projectId,
				title: 'New idle task',
				assignee_id: agentId,
			}),
		});
		const newTask = (await newRes.json()).data;

		await db.query(
			`INSERT INTO heartbeat_runs (team_id, member_id, task_id, status)
			 VALUES ($1, $2, $3, 'running')`,
			[teamId, agentId, oldTask.id],
		);

		const listRes = await app.request(
			`/api/projects/${projectSlug}/tasks?project_id=${projectId}&sort=created_at:desc`,
			{ headers: authHeader(token) },
		);
		const data = (await listRes.json()).data;
		const oldIdx = data.findIndex((i: any) => i.id === oldTask.id);
		const newIdx = data.findIndex((i: any) => i.id === newTask.id);
		expect(oldIdx).toBeGreaterThanOrEqual(0);
		expect(newIdx).toBeGreaterThanOrEqual(0);
		expect(oldIdx).toBeLessThan(newIdx);
		expect(data[oldIdx].has_active_run).toBe(true);

		await db.query(`DELETE FROM heartbeat_runs WHERE task_id = $1`, [oldTask.id]);
	});

	it('rejects a non-Coach agent trying to close an task via PATCH', async () => {
		const createRes = await app.request(`/api/projects/${projectSlug}/tasks`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				project_id: projectId,
				title: 'Agent-close target',
				assignee_id: agentId,
			}),
		});
		const task = (await createRes.json()).data;

		const { token: agentToken } = await mintAgentToken(
			db,
			masterKeyManager,
			agentId,
			teamId,
			null,
			{ projectId },
		);

		const res = await app.request(`/api/projects/${projectSlug}/tasks/${task.id}`, {
			method: 'PATCH',
			headers: { ...authHeader(agentToken), 'Content-Type': 'application/json' },
			body: JSON.stringify({ status: 'closed' }),
		});
		expect(res.status).toBe(403);
		expect((await res.json()).error.message).toMatch(/coach/i);

		const row = await db.query<{ status: string }>('SELECT status FROM tasks WHERE id = $1', [
			task.id,
		]);
		expect(row.rows[0].status).not.toBe('closed');
	});

	it('allows Coach to close an task via PATCH', async () => {
		const createRes = await app.request(`/api/projects/${projectSlug}/tasks`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				project_id: projectId,
				title: 'Coach-close target',
				assignee_id: agentId,
			}),
		});
		const task = (await createRes.json()).data;

		const coachRow = await db.query<{ id: string }>(
			"SELECT id FROM member_agents WHERE slug = 'coach' LIMIT 1",
		);
		const coachId = coachRow.rows[0].id;
		const { token: coachToken } = await mintAgentToken(
			db,
			masterKeyManager,
			coachId,
			teamId,
			null,
			{ projectId },
		);

		const res = await app.request(`/api/projects/${projectSlug}/tasks/${task.id}`, {
			method: 'PATCH',
			headers: { ...authHeader(coachToken), 'Content-Type': 'application/json' },
			body: JSON.stringify({ status: 'closed' }),
		});
		expect(res.status).toBe(200);
		expect((await res.json()).data.status).toBe('closed');
	});

	it('rejects an agent trying to re-open a closed task via PATCH', async () => {
		const createRes = await app.request(`/api/projects/${projectSlug}/tasks`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				project_id: projectId,
				title: 'Agent-reopen target',
				assignee_id: agentId,
			}),
		});
		const task = (await createRes.json()).data;

		await app.request(`/api/projects/${projectSlug}/tasks/${task.id}`, {
			method: 'PATCH',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ status: 'closed' }),
		});

		const { token: agentToken } = await mintAgentToken(
			db,
			masterKeyManager,
			agentId,
			teamId,
			null,
			{ projectId },
		);

		const reopenRes = await app.request(`/api/projects/${projectSlug}/tasks/${task.id}`, {
			method: 'PATCH',
			headers: { ...authHeader(agentToken), 'Content-Type': 'application/json' },
			body: JSON.stringify({ status: 'backlog' }),
		});
		expect(reopenRes.status).toBe(403);
		const body = await reopenRes.json();
		expect(body.error.message).toMatch(/admin/i);

		const bypassRes = await app.request(`/api/projects/${projectSlug}/tasks/${task.id}`, {
			method: 'PATCH',
			headers: { ...authHeader(agentToken), 'Content-Type': 'application/json' },
			body: JSON.stringify({ status: 'in_progress' }),
		});
		expect(bypassRes.status).toBe(403);
	});

	it('allows a the admin to close and re-open an task', async () => {
		const createRes = await app.request(`/api/projects/${projectSlug}/tasks`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				project_id: projectId,
				title: 'Admin close/reopen target',
				assignee_id: agentId,
			}),
		});
		const task = (await createRes.json()).data;

		const closeRes = await app.request(`/api/projects/${projectSlug}/tasks/${task.id}`, {
			method: 'PATCH',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ status: 'closed' }),
		});
		expect(closeRes.status).toBe(200);
		expect((await closeRes.json()).data.status).toBe('closed');

		const reopenRes = await app.request(`/api/projects/${projectSlug}/tasks/${task.id}`, {
			method: 'PATCH',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ status: 'backlog' }),
		});
		expect(reopenRes.status).toBe(200);
		expect((await reopenRes.json()).data.status).toBe('backlog');
	});

	it('allows agents to set non-terminal statuses via PATCH', async () => {
		const createRes = await app.request(`/api/projects/${projectSlug}/tasks`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				project_id: projectId,
				title: 'Agent progress target',
				assignee_id: agentId,
			}),
		});
		const task = (await createRes.json()).data;

		const { token: agentToken } = await mintAgentToken(
			db,
			masterKeyManager,
			agentId,
			teamId,
			null,
			{ projectId },
		);

		const res = await app.request(`/api/projects/${projectSlug}/tasks/${task.id}`, {
			method: 'PATCH',
			headers: { ...authHeader(agentToken), 'Content-Type': 'application/json' },
			body: JSON.stringify({ status: 'in_progress' }),
		});
		expect(res.status).toBe(200);
		expect((await res.json()).data.status).toBe('in_progress');
	});

	it('does not create an assignment wakeup when PATCH leaves assignee unchanged', async () => {
		const task = await insertTaskDirect(agentId, 'Wakeup guard target');

		const res = await app.request(`/api/projects/${projectSlug}/tasks/${task.id}`, {
			method: 'PATCH',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ status: 'in_progress', assignee_id: agentId }),
		});
		expect(res.status).toBe(200);

		await flushAsyncWakeups();

		const wakeups = await db.query<{ source: string }>(
			`SELECT source::text AS source
			 FROM agent_wakeup_requests
			 WHERE payload->>'task_id' = $1`,
			[task.id],
		);
		expect(wakeups.rows.filter((r) => r.source === 'assignment')).toEqual([]);
	});

	it('creates an assignment wakeup when PATCH actually changes the assignee', async () => {
		const secondAgentRes = await app.request(`/api/projects/${projectSlug}/agents`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ title: 'Reassign Target Agent' }),
		});
		const secondAgentId = (await secondAgentRes.json()).data.id;

		const task = await insertTaskDirect(agentId, 'Reassignment fires wakeup');

		const res = await app.request(`/api/projects/${projectSlug}/tasks/${task.id}`, {
			method: 'PATCH',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ assignee_id: secondAgentId }),
		});
		expect(res.status).toBe(200);

		await flushAsyncWakeups();

		const wakeups = await db.query<{ source: string; member_id: string }>(
			`SELECT source::text AS source, member_id
			 FROM agent_wakeup_requests
			 WHERE payload->>'task_id' = $1`,
			[task.id],
		);
		const assignmentWakeups = wakeups.rows.filter((r) => r.source === 'assignment');
		expect(assignmentWakeups.length).toBe(1);
		expect(assignmentWakeups[0].member_id).toBe(secondAgentId);
	});
});

describe('sub-task depth + ancestors', () => {
	async function createTask(parent_task_id?: string) {
		const res = await app.request(`/api/projects/${projectSlug}/tasks`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				project_id: projectId,
				title: parent_task_id ? 'Child' : 'Root',
				assignee_id: agentId,
				...(parent_task_id ? { parent_task_id } : {}),
			}),
		});
		return { res, body: await res.json() };
	}

	async function createSub(parentId: string) {
		const res = await app.request(`/api/projects/${projectSlug}/tasks/${parentId}/sub-tasks`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ title: 'Sub', assignee_id: agentId }),
		});
		return { res, body: await res.json() };
	}

	it('allows creating a depth-2 sub-task (sub-task of a sub-task)', async () => {
		const root = (await createTask()).body.data;
		const sub = (await createSub(root.id)).body.data;
		const subSubViaRest = await createTask(sub.id);
		expect(subSubViaRest.res.status).toBe(201);
		expect(subSubViaRest.body.data.parent_task_id).toBe(sub.id);

		const sub2 = (await createSub(root.id)).body.data;
		const subSubViaSubRoute = await createSub(sub2.id);
		expect(subSubViaSubRoute.res.status).toBe(201);
		expect(subSubViaSubRoute.body.data.parent_task_id).toBe(sub2.id);
	});

	it('rejects depth-3 creation via POST /tasks with parent_task_id', async () => {
		const root = (await createTask()).body.data;
		const sub = (await createSub(root.id)).body.data;
		const subSub = (await createSub(sub.id)).body.data;

		const tooDeep = await createTask(subSub.id);
		expect(tooDeep.res.status).toBe(400);
		expect(tooDeep.body.error.message).toMatch(/2 levels deep/);
	});

	it('resolves a parent_task_id passed by identifier (not just UUID)', async () => {
		const root = (await createTask()).body.data;
		// Reference the parent by its bare identifier (lowercased), the way an
		// agent or API caller would — must resolve to the parent UUID, not 500.
		const childRes = await app.request(`/api/projects/${projectSlug}/tasks`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				project_id: projectId,
				title: 'Child by identifier',
				assignee_id: agentId,
				parent_task_id: root.identifier.toLowerCase(),
			}),
		});
		expect(childRes.status).toBe(201);
		expect((await childRes.json()).data.parent_task_id).toBe(root.id);
	});

	it('returns 404 (not 500) when parent_task_id references an unknown task', async () => {
		const res = await app.request(`/api/projects/${projectSlug}/tasks`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				project_id: projectId,
				title: 'Orphan child',
				assignee_id: agentId,
				parent_task_id: 'MP-999999',
			}),
		});
		expect(res.status).toBe(404);
		expect((await res.json()).error.message).toMatch(/parent task/i);
	});

	it('rejects depth-3 creation via POST /tasks/:id/sub-tasks', async () => {
		const root = (await createTask()).body.data;
		const sub = (await createSub(root.id)).body.data;
		const subSub = (await createSub(sub.id)).body.data;

		const tooDeep = await createSub(subSub.id);
		expect(tooDeep.res.status).toBe(400);
		expect(tooDeep.body.error.message).toMatch(/2 levels deep/);
	});

	it('returns ancestors in root-first order, excluding the current task', async () => {
		const root = (await createTask()).body.data;
		const sub = (await createSub(root.id)).body.data;
		const subSub = (await createSub(sub.id)).body.data;

		const rootRes = await app.request(`/api/projects/${projectSlug}/tasks/${root.id}/ancestors`, {
			headers: authHeader(token),
		});
		expect(rootRes.status).toBe(200);
		expect((await rootRes.json()).data).toEqual([]);

		const subRes = await app.request(`/api/projects/${projectSlug}/tasks/${sub.id}/ancestors`, {
			headers: authHeader(token),
		});
		expect(subRes.status).toBe(200);
		const subAncestors = (await subRes.json()).data;
		expect(subAncestors).toHaveLength(1);
		expect(subAncestors[0].id).toBe(root.id);

		const subSubRes = await app.request(
			`/api/projects/${projectSlug}/tasks/${subSub.id}/ancestors`,
			{
				headers: authHeader(token),
			},
		);
		expect(subSubRes.status).toBe(200);
		const subSubAncestors = (await subSubRes.json()).data;
		expect(subSubAncestors).toHaveLength(2);
		expect(subSubAncestors[0].id).toBe(root.id);
		expect(subSubAncestors[1].id).toBe(sub.id);
	});

	it('resolves identifier-based path for ancestors', async () => {
		const root = (await createTask()).body.data;
		const sub = (await createSub(root.id)).body.data;

		const res = await app.request(
			`/api/projects/${projectSlug}/tasks/${sub.identifier.toLowerCase()}/ancestors`,
			{ headers: authHeader(token) },
		);
		expect(res.status).toBe(200);
		const ancestors = (await res.json()).data;
		expect(ancestors).toHaveLength(1);
		expect(ancestors[0].identifier).toBe(root.identifier);
	});

	it('returns 404 on ancestors for an unknown task', async () => {
		const res = await app.request(
			`/api/projects/${projectSlug}/tasks/00000000-0000-0000-0000-000000000000/ancestors`,
			{ headers: authHeader(token) },
		);
		expect(res.status).toBe(404);
	});
});

describe('closure rules — sub-tasks must be closed before parent', () => {
	async function createParent(): Promise<{ id: string; identifier: string }> {
		const res = await app.request(`/api/projects/${projectSlug}/tasks`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				project_id: projectId,
				title: 'Parent ticket',
				assignee_id: agentId,
			}),
		});
		expect(res.status).toBe(201);
		return (await res.json()).data;
	}

	async function createChild(parentId: string): Promise<{ id: string; identifier: string }> {
		const res = await app.request(`/api/projects/${projectSlug}/tasks/${parentId}/sub-tasks`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ title: 'Child ticket', assignee_id: agentId }),
		});
		expect(res.status).toBe(201);
		return (await res.json()).data;
	}

	async function setStatus(taskId: string, status: string): Promise<Response> {
		return app.request(`/api/projects/${projectSlug}/tasks/${taskId}`, {
			method: 'PATCH',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ status }),
		});
	}

	async function forceStatus(taskId: string, status: string): Promise<void> {
		await db.query(`UPDATE tasks SET status = $1::task_status WHERE id = $2`, [status, taskId]);
	}

	it('rejects done on a parent while a sub-task is still in_progress', async () => {
		const parent = await createParent();
		const child = await createChild(parent.id);
		await forceStatus(child.id, 'in_progress');

		const res = await setStatus(parent.id, 'done');
		expect(res.status).toBe(400);
		const body = await res.json();
		expect(body.error.message).toContain(child.identifier);
		expect(body.error.message).toMatch(/sub-task/i);
	});

	it('rejects done on a parent while a sub-task is in done (not yet closed)', async () => {
		const parent = await createParent();
		const child = await createChild(parent.id);
		await forceStatus(child.id, 'done');

		const res = await setStatus(parent.id, 'done');
		expect(res.status).toBe(400);
		expect((await res.json()).error.message).toContain(child.identifier);
	});

	it('rejects closed on a parent while a sub-task is still open', async () => {
		const parent = await createParent();
		const child = await createChild(parent.id);
		await forceStatus(child.id, 'in_progress');

		const res = await setStatus(parent.id, 'closed');
		expect(res.status).toBe(400);
	});

	it('allows done once every sub-task is closed', async () => {
		const parent = await createParent();
		const child = await createChild(parent.id);
		await forceStatus(child.id, 'closed');

		const res = await setStatus(parent.id, 'done');
		expect(res.status).toBe(200);
		expect((await res.json()).data.status).toBe('done');
	});

	it('allows done on a parent with no sub-tasks', async () => {
		const parent = await createParent();
		const res = await setStatus(parent.id, 'done');
		expect(res.status).toBe(200);
	});
});

describe('closure rules — outstanding pinged-agent activity blocks done', () => {
	async function createTask(): Promise<{ id: string; identifier: string }> {
		const res = await app.request(`/api/projects/${projectSlug}/tasks`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				project_id: projectId,
				title: 'Activity-guarded ticket',
				assignee_id: agentId,
			}),
		});
		return (await res.json()).data;
	}

	it('rejects done while a heartbeat_run for the task is running', async () => {
		const task = await createTask();
		await db.query(
			`INSERT INTO heartbeat_runs (member_id, team_id, task_id, status, started_at)
			 VALUES ($1, $2, $3, 'running'::heartbeat_run_status, now())`,
			[agentId, teamId, task.id],
		);

		const res = await app.request(`/api/projects/${projectSlug}/tasks/${task.id}`, {
			method: 'PATCH',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ status: 'done' }),
		});
		expect(res.status).toBe(400);
		expect((await res.json()).error.message).toMatch(/run/i);
	});

	it('rejects done while a queued wakeup payload references the task', async () => {
		const task = await createTask();
		await db.query(
			`INSERT INTO agent_wakeup_requests (member_id, team_id, source, status, payload)
			 VALUES ($1, $2, 'mention'::wakeup_source, 'queued'::wakeup_status, $3::jsonb)`,
			[agentId, teamId, JSON.stringify({ task_id: task.id })],
		);

		const res = await app.request(`/api/projects/${projectSlug}/tasks/${task.id}`, {
			method: 'PATCH',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ status: 'done' }),
		});
		expect(res.status).toBe(400);
		expect((await res.json()).error.message).toMatch(/wakeup/i);
	});

	it('allows done once outstanding runs and wakeups have terminal statuses', async () => {
		const task = await createTask();
		await db.query(
			`INSERT INTO heartbeat_runs (member_id, team_id, task_id, status, started_at, finished_at)
			 VALUES ($1, $2, $3, 'succeeded'::heartbeat_run_status, now(), now())`,
			[agentId, teamId, task.id],
		);
		await db.query(
			`INSERT INTO agent_wakeup_requests (member_id, team_id, source, status, payload, completed_at)
			 VALUES ($1, $2, 'mention'::wakeup_source, 'completed'::wakeup_status, $3::jsonb, now())`,
			[agentId, teamId, JSON.stringify({ task_id: task.id })],
		);

		const res = await app.request(`/api/projects/${projectSlug}/tasks/${task.id}`, {
			method: 'PATCH',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ status: 'done' }),
		});
		expect(res.status).toBe(200);
	});
});
