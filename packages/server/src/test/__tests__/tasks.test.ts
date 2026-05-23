import type { PGlite } from '@electric-sql/pglite';
import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MasterKeyManager } from '../../crypto/master-key';
import type { Env } from '../../lib/types';
import { safeClose } from '../helpers';
import { authHeader, createTestApp, mintAgentToken } from '../helpers/app';

let app: Hono<Env>;
let db: PGlite;
let token: string;
let masterKeyManager: MasterKeyManager;
let teamId: string;
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
	teamId = (await teamRes.json()).data.id;

	const projectRes = await app.request(`/api/teams/${teamId}/projects`, {
		method: 'POST',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify({ name: 'Main Project', description: 'Test project.' }),
	});
	const projectBody = (await projectRes.json()).data;
	projectId = projectBody.id;
	projectSlug = projectBody.slug;

	const agentRes = await app.request(`/api/teams/${teamId}/agents`, {
		method: 'POST',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify({ title: 'Test Agent' }),
	});
	agentId = (await agentRes.json()).data.id;
});

afterAll(async () => {
	await safeClose(db);
});

describe('tasks CRUD', () => {
	it('creates an task with auto-generated identifier', async () => {
		const res = await app.request(`/api/teams/${teamId}/tasks`, {
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
		const createRes = await app.request(`/api/teams/${teamId}/tasks`, {
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

		const patchRes = await app.request(`/api/teams/${teamId}/tasks/${created.id}`, {
			method: 'PATCH',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ runtime_type: 'gemini' }),
		});
		expect(patchRes.status).toBe(200);
		expect((await patchRes.json()).data.runtime_type).toBe('gemini');
	});

	it('creates sequential task numbers', async () => {
		const firstRes = await app.request(`/api/teams/${teamId}/tasks`, {
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

		const secondRes = await app.request(`/api/teams/${teamId}/tasks`, {
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
		const res = await app.request(`/api/teams/${teamId}/tasks?per_page=1`, {
			headers: authHeader(token),
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.data).toHaveLength(1);
		expect(body.meta.total).toBeGreaterThanOrEqual(2);
		expect(body.meta.per_page).toBe(1);
	});

	it('filters tasks by status', async () => {
		const res = await app.request(`/api/teams/${teamId}/tasks?status=backlog`, {
			headers: authHeader(token),
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.data.every((i: any) => i.status === 'backlog')).toBe(true);
	});

	it('gets an task by id with computed fields', async () => {
		const listRes = await app.request(`/api/teams/${teamId}/tasks`, {
			headers: authHeader(token),
		});
		const task = (await listRes.json()).data[0];

		const res = await app.request(`/api/teams/${teamId}/tasks/${task.id}`, {
			headers: authHeader(token),
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.data).toHaveProperty('project_name');
		expect(body.data).toHaveProperty('comment_count');
		expect(body.data).toHaveProperty('cost_cents');
	});

	it('resolves an task by identifier (case-insensitive)', async () => {
		const listRes = await app.request(`/api/teams/${teamId}/tasks`, {
			headers: authHeader(token),
		});
		const task = (await listRes.json()).data[0];

		const upperRes = await app.request(`/api/teams/${teamId}/tasks/${task.identifier}`, {
			headers: authHeader(token),
		});
		expect(upperRes.status).toBe(200);
		expect((await upperRes.json()).data.id).toBe(task.id);

		const lowerRes = await app.request(
			`/api/teams/${teamId}/tasks/${task.identifier.toLowerCase()}`,
			{ headers: authHeader(token) },
		);
		expect(lowerRes.status).toBe(200);
		expect((await lowerRes.json()).data.id).toBe(task.id);
	});

	it('updates an task status', async () => {
		const listRes = await app.request(`/api/teams/${teamId}/tasks`, {
			headers: authHeader(token),
		});
		const task = (await listRes.json()).data[0];

		const res = await app.request(`/api/teams/${teamId}/tasks/${task.id}`, {
			method: 'PATCH',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ status: 'in_progress' }),
		});
		expect(res.status).toBe(200);
		expect((await res.json()).data.status).toBe('in_progress');
	});

	it('creates a sub-task', async () => {
		const listRes = await app.request(`/api/teams/${teamId}/tasks`, {
			headers: authHeader(token),
		});
		const parentTask = (await listRes.json()).data[0];

		const res = await app.request(`/api/teams/${teamId}/tasks/${parentTask.id}/sub-tasks`, {
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
		const listRes = await app.request(`/api/teams/${teamId}/tasks`, {
			headers: authHeader(token),
		});
		const tasks = (await listRes.json()).data;

		// Add dependency
		const addRes = await app.request(`/api/teams/${teamId}/tasks/${tasks[0].id}/dependencies`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ blocked_by_task_id: tasks[1].id }),
		});
		expect(addRes.status).toBe(201);

		// List dependencies
		const listDepsRes = await app.request(
			`/api/teams/${teamId}/tasks/${tasks[0].id}/dependencies`,
			{ headers: authHeader(token) },
		);
		expect(listDepsRes.status).toBe(200);
		const deps = (await listDepsRes.json()).data;
		expect(deps).toHaveLength(1);
		expect(deps[0].blocked_by_project_slug).toBe(projectSlug);
		expect(deps[0].blocked_by_identifier).toBe(tasks[1].identifier);

		// Remove dependency
		const removeRes = await app.request(
			`/api/teams/${teamId}/tasks/${tasks[0].id}/dependencies/${deps[0].id}`,
			{ method: 'DELETE', headers: authHeader(token) },
		);
		expect(removeRes.status).toBe(200);
	});

	it('updates and retrieves progress_summary', async () => {
		const listRes = await app.request(`/api/teams/${teamId}/tasks`, {
			headers: authHeader(token),
		});
		const task = (await listRes.json()).data[0];

		const summary =
			'## Requirements\n- Build auth module\n\n## Done\n- Set up project\n\n## Next\n- Implement login';
		const patchRes = await app.request(`/api/teams/${teamId}/tasks/${task.id}`, {
			method: 'PATCH',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ progress_summary: summary }),
		});
		expect(patchRes.status).toBe(200);
		const patched = (await patchRes.json()).data;
		expect(patched.progress_summary).toBe(summary);
		expect(patched.progress_summary_updated_at).toBeTruthy();

		// GET detail includes progress_summary and updater name
		const detailRes = await app.request(`/api/teams/${teamId}/tasks/${task.id}`, {
			headers: authHeader(token),
		});
		expect(detailRes.status).toBe(200);
		const detail = (await detailRes.json()).data;
		expect(detail.progress_summary).toBe(summary);
		expect(detail.progress_summary_updated_at).toBeTruthy();
	});

	it('clears progress_summary with null', async () => {
		const listRes = await app.request(`/api/teams/${teamId}/tasks`, {
			headers: authHeader(token),
		});
		const task = (await listRes.json()).data[0];

		// Set it first
		await app.request(`/api/teams/${teamId}/tasks/${task.id}`, {
			method: 'PATCH',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ progress_summary: 'Some summary' }),
		});

		// Clear it
		const clearRes = await app.request(`/api/teams/${teamId}/tasks/${task.id}`, {
			method: 'PATCH',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ progress_summary: null }),
		});
		expect(clearRes.status).toBe(200);
		expect((await clearRes.json()).data.progress_summary).toBeNull();
	});

	it('does not include progress_summary in list view', async () => {
		const listRes = await app.request(`/api/teams/${teamId}/tasks`, {
			headers: authHeader(token),
		});
		expect(listRes.status).toBe(200);
		const tasks = (await listRes.json()).data;
		// List query selects specific columns, progress_summary should not be there
		expect(tasks[0]).not.toHaveProperty('progress_summary');
	});

	it('updates and retrieves rules', async () => {
		const listRes = await app.request(`/api/teams/${teamId}/tasks`, {
			headers: authHeader(token),
		});
		const task = (await listRes.json()).data[0];

		const rules = 'Consult the architect before making changes.\nPrioritize performance.';
		const patchRes = await app.request(`/api/teams/${teamId}/tasks/${task.id}`, {
			method: 'PATCH',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ rules }),
		});
		expect(patchRes.status).toBe(200);
		const patched = (await patchRes.json()).data;
		expect(patched.rules).toBe(rules);

		const detailRes = await app.request(`/api/teams/${teamId}/tasks/${task.id}`, {
			headers: authHeader(token),
		});
		expect(detailRes.status).toBe(200);
		expect((await detailRes.json()).data.rules).toBe(rules);
	});

	it('clears rules with null', async () => {
		const listRes = await app.request(`/api/teams/${teamId}/tasks`, {
			headers: authHeader(token),
		});
		const task = (await listRes.json()).data[0];

		await app.request(`/api/teams/${teamId}/tasks/${task.id}`, {
			method: 'PATCH',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ rules: 'Some rules' }),
		});

		const clearRes = await app.request(`/api/teams/${teamId}/tasks/${task.id}`, {
			method: 'PATCH',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ rules: null }),
		});
		expect(clearRes.status).toBe(200);
		expect((await clearRes.json()).data.rules).toBeNull();
	});

	it('does not include rules in list view', async () => {
		const listRes = await app.request(`/api/teams/${teamId}/tasks`, {
			headers: authHeader(token),
		});
		expect(listRes.status).toBe(200);
		const tasks = (await listRes.json()).data;
		expect(tasks[0]).not.toHaveProperty('rules');
	});

	it('rejects task creation without assignee_id', async () => {
		const res = await app.request(`/api/teams/${teamId}/tasks`, {
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
		const listRes = await app.request(`/api/teams/${teamId}/tasks`, {
			headers: authHeader(token),
		});
		const parentTask = (await listRes.json()).data[0];

		const res = await app.request(`/api/teams/${teamId}/tasks/${parentTask.id}/sub-tasks`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ title: 'Sub without assignee' }),
		});
		expect(res.status).toBe(400);
		const body = await res.json();
		expect(body.error.message).toMatch(/assignee_(id|slug)/);
	});

	it('rejects setting assignee_id to null on update', async () => {
		const listRes = await app.request(`/api/teams/${teamId}/tasks`, {
			headers: authHeader(token),
		});
		const task = (await listRes.json()).data[0];

		const res = await app.request(`/api/teams/${teamId}/tasks/${task.id}`, {
			method: 'PATCH',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ assignee_id: null }),
		});
		expect(res.status).toBe(400);
		const body = await res.json();
		expect(body.error.message).toContain('assignee_id cannot be null');
	});

	it('filters by multiple assignee_ids when comma-separated', async () => {
		const secondAgentRes = await app.request(`/api/teams/${teamId}/agents`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ title: 'Second Agent' }),
		});
		const secondAgentId = (await secondAgentRes.json()).data.id;

		await app.request(`/api/teams/${teamId}/tasks`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				project_id: projectId,
				title: 'Agent two ticket',
				assignee_id: secondAgentId,
			}),
		});

		const listRes = await app.request(
			`/api/teams/${teamId}/tasks?assignee_id=${agentId},${secondAgentId}`,
			{ headers: authHeader(token) },
		);
		expect(listRes.status).toBe(200);
		const tasks = (await listRes.json()).data;
		const assigneeIds = new Set(tasks.map((i: any) => i.assignee_id));
		expect(assigneeIds.has(agentId)).toBe(true);
		expect(assigneeIds.has(secondAgentId)).toBe(true);
	});

	it('pins tasks with active runs to the top regardless of sort order', async () => {
		const oldRes = await app.request(`/api/teams/${teamId}/tasks`, {
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

		const newRes = await app.request(`/api/teams/${teamId}/tasks`, {
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
			`/api/teams/${teamId}/tasks?project_id=${projectId}&sort=created_at:desc`,
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

	it('allows an agent to close an task via PATCH', async () => {
		const createRes = await app.request(`/api/teams/${teamId}/tasks`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				project_id: projectId,
				title: 'Agent-close target',
				assignee_id: agentId,
			}),
		});
		const task = (await createRes.json()).data;

		const { token: agentToken } = await mintAgentToken(db, masterKeyManager, agentId, teamId);

		const res = await app.request(`/api/teams/${teamId}/tasks/${task.id}`, {
			method: 'PATCH',
			headers: { ...authHeader(agentToken), 'Content-Type': 'application/json' },
			body: JSON.stringify({ status: 'closed' }),
		});
		expect(res.status).toBe(200);
		expect((await res.json()).data.status).toBe('closed');
	});

	it('rejects an agent trying to re-open a closed task via PATCH', async () => {
		const createRes = await app.request(`/api/teams/${teamId}/tasks`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				project_id: projectId,
				title: 'Agent-reopen target',
				assignee_id: agentId,
			}),
		});
		const task = (await createRes.json()).data;

		await app.request(`/api/teams/${teamId}/tasks/${task.id}`, {
			method: 'PATCH',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ status: 'closed' }),
		});

		const { token: agentToken } = await mintAgentToken(db, masterKeyManager, agentId, teamId);

		const reopenRes = await app.request(`/api/teams/${teamId}/tasks/${task.id}`, {
			method: 'PATCH',
			headers: { ...authHeader(agentToken), 'Content-Type': 'application/json' },
			body: JSON.stringify({ status: 'backlog' }),
		});
		expect(reopenRes.status).toBe(403);
		const body = await reopenRes.json();
		expect(body.error.message).toMatch(/board/i);

		const bypassRes = await app.request(`/api/teams/${teamId}/tasks/${task.id}`, {
			method: 'PATCH',
			headers: { ...authHeader(agentToken), 'Content-Type': 'application/json' },
			body: JSON.stringify({ status: 'in_progress' }),
		});
		expect(bypassRes.status).toBe(403);
	});

	it('allows a board member to close and re-open an task', async () => {
		const createRes = await app.request(`/api/teams/${teamId}/tasks`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				project_id: projectId,
				title: 'Board close/reopen target',
				assignee_id: agentId,
			}),
		});
		const task = (await createRes.json()).data;

		const closeRes = await app.request(`/api/teams/${teamId}/tasks/${task.id}`, {
			method: 'PATCH',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ status: 'closed' }),
		});
		expect(closeRes.status).toBe(200);
		expect((await closeRes.json()).data.status).toBe('closed');

		const reopenRes = await app.request(`/api/teams/${teamId}/tasks/${task.id}`, {
			method: 'PATCH',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ status: 'backlog' }),
		});
		expect(reopenRes.status).toBe(200);
		expect((await reopenRes.json()).data.status).toBe('backlog');
	});

	it('allows agents to set non-terminal statuses via PATCH', async () => {
		const createRes = await app.request(`/api/teams/${teamId}/tasks`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				project_id: projectId,
				title: 'Agent progress target',
				assignee_id: agentId,
			}),
		});
		const task = (await createRes.json()).data;

		const { token: agentToken } = await mintAgentToken(db, masterKeyManager, agentId, teamId);

		const res = await app.request(`/api/teams/${teamId}/tasks/${task.id}`, {
			method: 'PATCH',
			headers: { ...authHeader(agentToken), 'Content-Type': 'application/json' },
			body: JSON.stringify({ status: 'in_progress' }),
		});
		expect(res.status).toBe(200);
		expect((await res.json()).data.status).toBe('in_progress');
	});
});

describe('sub-task depth + ancestors', () => {
	async function createTask(parent_task_id?: string) {
		const res = await app.request(`/api/teams/${teamId}/tasks`, {
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
		const res = await app.request(`/api/teams/${teamId}/tasks/${parentId}/sub-tasks`, {
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

		const rootRes = await app.request(`/api/teams/${teamId}/tasks/${root.id}/ancestors`, {
			headers: authHeader(token),
		});
		expect(rootRes.status).toBe(200);
		expect((await rootRes.json()).data).toEqual([]);

		const subRes = await app.request(`/api/teams/${teamId}/tasks/${sub.id}/ancestors`, {
			headers: authHeader(token),
		});
		expect(subRes.status).toBe(200);
		const subAncestors = (await subRes.json()).data;
		expect(subAncestors).toHaveLength(1);
		expect(subAncestors[0].id).toBe(root.id);

		const subSubRes = await app.request(`/api/teams/${teamId}/tasks/${subSub.id}/ancestors`, {
			headers: authHeader(token),
		});
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
			`/api/teams/${teamId}/tasks/${sub.identifier.toLowerCase()}/ancestors`,
			{ headers: authHeader(token) },
		);
		expect(res.status).toBe(200);
		const ancestors = (await res.json()).data;
		expect(ancestors).toHaveLength(1);
		expect(ancestors[0].identifier).toBe(root.identifier);
	});

	it('returns 404 on ancestors for an unknown task', async () => {
		const res = await app.request(
			`/api/teams/${teamId}/tasks/00000000-0000-0000-0000-000000000000/ancestors`,
			{ headers: authHeader(token) },
		);
		expect(res.status).toBe(404);
	});
});

describe('operations project assignee restriction', () => {
	let operationsProjectId: string;
	let captainAgentId: string;

	beforeAll(async () => {
		const opsResult = await db.query<{ id: string }>(
			`SELECT id FROM projects WHERE team_id = $1 AND slug = 'operations'`,
			[teamId],
		);
		operationsProjectId = opsResult.rows[0].id;

		const captainResult = await db.query<{ id: string }>(
			`SELECT ma.id FROM member_agents ma
			 JOIN members m ON m.id = ma.id
			 WHERE m.team_id = $1 AND ma.slug = 'captain'`,
			[teamId],
		);
		captainAgentId = captainResult.rows[0].id;
	});

	it('rejects creating an Operations task assigned to a non-Captain agent', async () => {
		const res = await app.request(`/api/teams/${teamId}/tasks`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				project_id: operationsProjectId,
				title: 'Non-Captain on Operations',
				assignee_id: agentId,
			}),
		});
		expect(res.status).toBe(400);
		expect((await res.json()).error.message).toContain('Captain');
	});

	it('accepts creating an Operations task assigned to the Captain', async () => {
		const res = await app.request(`/api/teams/${teamId}/tasks`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				project_id: operationsProjectId,
				title: 'Captain on Operations',
				assignee_id: captainAgentId,
			}),
		});
		expect(res.status).toBe(201);
		expect((await res.json()).data.assignee_id).toBe(captainAgentId);
	});

	it('allows non-Captain assignees on non-Operations projects', async () => {
		const res = await app.request(`/api/teams/${teamId}/tasks`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				project_id: projectId,
				title: 'Non-Captain on regular project',
				assignee_id: agentId,
			}),
		});
		expect(res.status).toBe(201);
	});

	it('rejects reassigning an Operations task to a non-Captain agent', async () => {
		const createRes = await app.request(`/api/teams/${teamId}/tasks`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				project_id: operationsProjectId,
				title: 'Reassignable Operations task',
				assignee_id: captainAgentId,
			}),
		});
		const task = (await createRes.json()).data;

		const res = await app.request(`/api/teams/${teamId}/tasks/${task.id}`, {
			method: 'PATCH',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ assignee_id: agentId }),
		});
		expect(res.status).toBe(400);
		expect((await res.json()).error.message).toContain('Captain');
	});

	it('allows reassigning an Operations task back to the Captain', async () => {
		const createRes = await app.request(`/api/teams/${teamId}/tasks`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				project_id: operationsProjectId,
				title: 'Operations keep-Captain task',
				assignee_id: captainAgentId,
			}),
		});
		const task = (await createRes.json()).data;

		const res = await app.request(`/api/teams/${teamId}/tasks/${task.id}`, {
			method: 'PATCH',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ assignee_id: captainAgentId }),
		});
		expect(res.status).toBe(200);
	});

	it('rejects sub-task of an Operations parent assigned to a non-Captain agent', async () => {
		const parentRes = await app.request(`/api/teams/${teamId}/tasks`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				project_id: operationsProjectId,
				title: 'Operations parent',
				assignee_id: captainAgentId,
			}),
		});
		const parent = (await parentRes.json()).data;

		const res = await app.request(`/api/teams/${teamId}/tasks/${parent.id}/sub-tasks`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ title: 'Sub with non-Captain', assignee_id: agentId }),
		});
		expect(res.status).toBe(400);
		expect((await res.json()).error.message).toContain('Captain');
	});

	it('exposes project_slug on the task detail response', async () => {
		const createRes = await app.request(`/api/teams/${teamId}/tasks`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				project_id: operationsProjectId,
				title: 'Operations detail check',
				assignee_id: captainAgentId,
			}),
		});
		const task = (await createRes.json()).data;

		const detailRes = await app.request(`/api/teams/${teamId}/tasks/${task.id}`, {
			headers: authHeader(token),
		});
		const detail = (await detailRes.json()).data;
		expect(detail.project_slug).toBe('operations');
	});
});

describe('closure rules — sub-tasks must be closed before parent', () => {
	async function createParent(): Promise<{ id: string; identifier: string }> {
		const res = await app.request(`/api/teams/${teamId}/tasks`, {
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
		const res = await app.request(`/api/teams/${teamId}/tasks/${parentId}/sub-tasks`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ title: 'Child ticket', assignee_id: agentId }),
		});
		expect(res.status).toBe(201);
		return (await res.json()).data;
	}

	async function setStatus(taskId: string, status: string): Promise<Response> {
		return app.request(`/api/teams/${teamId}/tasks/${taskId}`, {
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
		const res = await app.request(`/api/teams/${teamId}/tasks`, {
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

		const res = await app.request(`/api/teams/${teamId}/tasks/${task.id}`, {
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

		const res = await app.request(`/api/teams/${teamId}/tasks/${task.id}`, {
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

		const res = await app.request(`/api/teams/${teamId}/tasks/${task.id}`, {
			method: 'PATCH',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ status: 'done' }),
		});
		expect(res.status).toBe(200);
	});
});
