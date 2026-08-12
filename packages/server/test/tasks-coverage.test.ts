import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MasterKeyManager } from '../src/crypto/master-key';
import type { Db } from '../src/db/database';
import type { Env } from '../src/lib/types';
import { safeClose } from './helpers';
import {
	authHeader,
	createAgentRun,
	createTestApp,
	createTestProject,
	createTestTeam,
	mintAgentToken,
	settleTeamSetupReview,
} from './helpers/app';

// Branch-coverage tests for packages/server/src/routes/tasks.ts.
// Targets error/validation/optional-param branches not hit by tasks.test.ts:
// list filters (parent/priority/search/empty-assignee), batch + resolve
// validation, latest-run null, PATCH 404 / 409-reassign / title-only /
// branch_name / no-op, dependency error paths, ancestors 404, sub-task 404.

let app: Hono<Env>;
let db: Db;
let token: string;
let masterKeyManager: MasterKeyManager;
let teamId: string;
let projectId: string;
let projectSlug: string;
let agentId: string;
let secondAgentId: string;

// Another team + project to exercise cross-team NOT_FOUND.
let otherProjectSlug: string;
let otherTaskId: string;

beforeAll(async () => {
	const ctx = await createTestApp();
	app = ctx.app;
	db = ctx.db;
	token = ctx.token;
	masterKeyManager = ctx.masterKeyManager;

	const teamRes = await createTestTeam(db, { name: 'Tasks Cov Co' });
	teamId = (await teamRes.json()).data.id;

	const projectRes = await createTestProject(db, teamId, { name: 'Cov Project' });
	const projectData = (await projectRes.json()).data;
	projectId = projectData.id;
	projectSlug = projectData.slug;

	const agentRes = await app.request(`/api/projects/${projectSlug}/agents`, {
		method: 'POST',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify({ title: 'Cov Agent' }),
	});
	agentId = (await agentRes.json()).data.id;

	const secondAgentRes = await app.request(`/api/projects/${projectSlug}/agents`, {
		method: 'POST',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify({ title: 'Cov Agent Two' }),
	});
	secondAgentId = (await secondAgentRes.json()).data.id;

	const otherTeamRes = await createTestTeam(db, { name: 'Tasks Cov Other Co' });
	const otherTeamId = (await otherTeamRes.json()).data.id;
	const otherProjectRes = await createTestProject(db, otherTeamId, { name: 'Other Project' });
	const otherProjectData = (await otherProjectRes.json()).data;
	otherProjectSlug = otherProjectData.slug;
	const otherAgentRes = await app.request(`/api/projects/${otherProjectSlug}/agents`, {
		method: 'POST',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify({ title: 'Other Agent' }),
	});
	const otherAgentId = (await otherAgentRes.json()).data.id;
	const otherTaskRes = await app.request(`/api/projects/${otherProjectSlug}/tasks`, {
		method: 'POST',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify({ title: 'Other team task', assignee_id: otherAgentId }),
	});
	otherTaskId = (await otherTaskRes.json()).data.id;

	// This fixture's subject is task behaviour, not agent onboarding: settle the
	// setup review the new agents filed so their tasks start unblocked.
	await settleTeamSetupReview(db, teamId);
	await settleTeamSetupReview(db, otherTeamId);
});

afterAll(async () => {
	await safeClose(db);
});

async function createTask(
	title: string,
	extra: Record<string, unknown> = {},
): Promise<{ id: string; identifier: string }> {
	const res = await app.request(`/api/projects/${projectSlug}/tasks`, {
		method: 'POST',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify({ title, assignee_id: agentId, ...extra }),
	});
	expect(res.status).toBe(201);
	return (await res.json()).data;
}

function flushAsyncWakeups(): Promise<void> {
	return new Promise((resolve) => setImmediate(resolve));
}

describe('GET /tasks list filters', () => {
	it('filters by parent_task_id', async () => {
		const parent = await createTask('Parent for filter');
		const subRes = await app.request(`/api/projects/${projectSlug}/tasks/${parent.id}/sub-tasks`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ title: 'Child for filter', assignee_id: agentId }),
		});
		const child = (await subRes.json()).data;

		const res = await app.request(
			`/api/projects/${projectSlug}/tasks?parent_task_id=${parent.id}`,
			{ headers: authHeader(token) },
		);
		expect(res.status).toBe(200);
		const data = (await res.json()).data;
		expect(data.map((t: { id: string }) => t.id)).toContain(child.id);
		expect(data.every((t: { parent_task_id: string }) => t.parent_task_id === parent.id)).toBe(
			true,
		);
	});

	it('filters by priority', async () => {
		await createTask('Urgent task', { priority: 'urgent' });
		const res = await app.request(`/api/projects/${projectSlug}/tasks?priority=urgent`, {
			headers: authHeader(token),
		});
		expect(res.status).toBe(200);
		const data = (await res.json()).data;
		expect(data.length).toBeGreaterThanOrEqual(1);
		expect(data.every((t: { priority: string }) => t.priority === 'urgent')).toBe(true);
	});

	it('filters by search across title and description', async () => {
		await createTask('Zxyzzy searchable title');
		const res = await app.request(`/api/projects/${projectSlug}/tasks?search=zxyzzy`, {
			headers: authHeader(token),
		});
		expect(res.status).toBe(200);
		const data = (await res.json()).data;
		expect(data.length).toBe(1);
		expect(data[0].title).toContain('Zxyzzy');
	});

	it('filters by search on the task identifier', async () => {
		const task = await createTask('Identifier-search target');
		const res = await app.request(
			`/api/projects/${projectSlug}/tasks?search=${task.identifier.toLowerCase()}`,
			{ headers: authHeader(token) },
		);
		expect(res.status).toBe(200);
		const data = (await res.json()).data;
		expect(data.map((t: { id: string }) => t.id)).toContain(task.id);
	});

	it('ignores an assignee_id filter that is only whitespace/commas', async () => {
		// The split/trim/filter leaves no ids, so no IN clause is added (the
		// `ids.length > 0` branch is skipped) and all tasks come back.
		const res = await app.request(`/api/projects/${projectSlug}/tasks?assignee_id=${' , , '}`, {
			headers: authHeader(token),
		});
		expect(res.status).toBe(200);
		const data = (await res.json()).data;
		expect(data.length).toBeGreaterThanOrEqual(1);
	});
});

describe('POST /tasks/batch validation', () => {
	it('rejects when items is not an array', async () => {
		const res = await app.request(`/api/projects/${projectSlug}/tasks/batch`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ items: 'nope' }),
		});
		expect(res.status).toBe(400);
		expect((await res.json()).error.message).toMatch(/must be an array/);
	});

	it('rejects an empty items array', async () => {
		const res = await app.request(`/api/projects/${projectSlug}/tasks/batch`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ items: [] }),
		});
		expect(res.status).toBe(400);
		expect((await res.json()).error.message).toMatch(/at least one/);
	});

	it('rejects more than 50 items', async () => {
		const items = Array.from({ length: 51 }, (_, i) => ({
			title: `Batch ${i}`,
			assignee_id: agentId,
		}));
		const res = await app.request(`/api/projects/${projectSlug}/tasks/batch`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ items }),
		});
		expect(res.status).toBe(400);
		expect((await res.json()).error.message).toMatch(/may not exceed 50/);
	});

	it('creates a small valid batch', async () => {
		const res = await app.request(`/api/projects/${projectSlug}/tasks/batch`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				items: [
					{ title: 'Batch one', assignee_id: agentId },
					{ title: 'Batch two', assignee_id: agentId },
				],
			}),
		});
		expect(res.status).toBe(200);
		const data = (await res.json()).data;
		expect(Array.isArray(data)).toBe(true);
		expect(data.length).toBe(2);
	});
});

describe('POST /tasks/resolve validation', () => {
	it('rejects when identifiers is not an array', async () => {
		const res = await app.request(`/api/projects/${projectSlug}/tasks/resolve`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ identifiers: 'MP-1' }),
		});
		expect(res.status).toBe(400);
		expect((await res.json()).error.message).toMatch(/array of strings/);
	});

	it('rejects more than 100 identifiers', async () => {
		const identifiers = Array.from({ length: 101 }, (_, i) => `MP-${i}`);
		const res = await app.request(`/api/projects/${projectSlug}/tasks/resolve`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ identifiers }),
		});
		expect(res.status).toBe(400);
		expect((await res.json()).error.message).toMatch(/may not exceed 100/);
	});

	it('returns an empty array when all identifiers are blank/non-string', async () => {
		const res = await app.request(`/api/projects/${projectSlug}/tasks/resolve`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ identifiers: ['', '   ', 42, null] }),
		});
		expect(res.status).toBe(200);
		expect((await res.json()).data).toEqual([]);
	});

	it('resolves real identifiers case-insensitively', async () => {
		const task = await createTask('Resolvable task');
		const res = await app.request(`/api/projects/${projectSlug}/tasks/resolve`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ identifiers: [task.identifier.toLowerCase()] }),
		});
		expect(res.status).toBe(200);
		const data = (await res.json()).data;
		expect(data).toHaveLength(1);
		expect(data[0].identifier).toBe(task.identifier);
	});
});

describe('GET /tasks/:taskId/latest-run', () => {
	it('returns null when the task has no runs', async () => {
		const task = await createTask('No-runs task');
		const res = await app.request(`/api/projects/${projectSlug}/tasks/${task.id}/latest-run`, {
			headers: authHeader(token),
		});
		expect(res.status).toBe(200);
		expect((await res.json()).data).toBeNull();
	});

	it('returns 200/null for an unknown UUID (resolveTaskId passes UUIDs through)', async () => {
		// resolveTaskId returns a well-formed UUID as-is without an existence
		// check, so latest-run runs its query and finds no rows → 200 null.
		const res = await app.request(
			`/api/projects/${projectSlug}/tasks/${'00000000-0000-0000-0000-000000000000'}/latest-run`,
			{ headers: authHeader(token) },
		);
		expect(res.status).toBe(200);
		expect((await res.json()).data).toBeNull();
	});

	it('returns 404 for an unknown identifier (non-UUID resolves to null)', async () => {
		const res = await app.request(`/api/projects/${projectSlug}/tasks/MP-99999999/latest-run`, {
			headers: authHeader(token),
		});
		expect(res.status).toBe(404);
	});
});

describe('GET /tasks/:taskId not-found / cross-team', () => {
	it('returns 404 for a task that belongs to another team', async () => {
		// otherTaskId exists, but not under projectSlug's team.
		const res = await app.request(`/api/projects/${projectSlug}/tasks/${otherTaskId}`, {
			headers: authHeader(token),
		});
		expect(res.status).toBe(404);
	});
});

describe('PATCH /tasks/:taskId branches', () => {
	it('returns 404 for an unknown task', async () => {
		const res = await app.request(
			`/api/projects/${projectSlug}/tasks/00000000-0000-0000-0000-000000000000`,
			{
				method: 'PATCH',
				headers: { ...authHeader(token), 'Content-Type': 'application/json' },
				body: JSON.stringify({ title: 'nope' }),
			},
		);
		expect(res.status).toBe(404);
	});

	it('returns the existing row unchanged when the body has no updatable fields', async () => {
		const task = await createTask('No-op patch target');
		const res = await app.request(`/api/projects/${projectSlug}/tasks/${task.id}`, {
			method: 'PATCH',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({}),
		});
		expect(res.status).toBe(200);
		const data = (await res.json()).data;
		expect(data.id).toBe(task.id);
		expect(data.title).toBe('No-op patch target');
	});

	it('updates the title only and records the change without erroring', async () => {
		const task = await createTask('Original title');
		const res = await app.request(`/api/projects/${projectSlug}/tasks/${task.id}`, {
			method: 'PATCH',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ title: '  Renamed title  ' }),
		});
		expect(res.status).toBe(200);
		expect((await res.json()).data.title).toBe('Renamed title');

		// A title-change system comment was recorded synchronously (awaited).
		const comments = await db.query<{ content: { text?: string } }>(
			`SELECT content FROM task_comments WHERE task_id = $1 AND content_type = 'system'`,
			[task.id],
		);
		expect(comments.rows.some((r) => /title/i.test(r.content?.text ?? ''))).toBe(true);
	});

	it('sets branch_name and description', async () => {
		const task = await createTask('Branch + desc target');
		const res = await app.request(`/api/projects/${projectSlug}/tasks/${task.id}`, {
			method: 'PATCH',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ branch_name: 'feature/x', description: 'A new description' }),
		});
		expect(res.status).toBe(200);
		const data = (await res.json()).data;
		expect(data.branch_name).toBe('feature/x');
		expect(data.description).toBe('A new description');
	});

	it('sets labels', async () => {
		const task = await createTask('Labels target');
		const res = await app.request(`/api/projects/${projectSlug}/tasks/${task.id}`, {
			method: 'PATCH',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ labels: ['frontend', 'urgent'] }),
		});
		expect(res.status).toBe(200);
		expect((await res.json()).data.labels).toEqual(['frontend', 'urgent']);
	});

	it('returns 409 when reassigning while an agent run is active on the task', async () => {
		const task = await createTask('Reassign-while-running target');
		// Spawn an active (running) run on the task via a real wakeup+run.
		const runId = await createAgentRun(db, agentId, teamId, task.id);

		const res = await app.request(`/api/projects/${projectSlug}/tasks/${task.id}`, {
			method: 'PATCH',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ assignee_id: secondAgentId }),
		});
		expect(res.status).toBe(409);
		// The message must name the blocking agent - an unnamed "a run is active"
		// is what left agents with no next move but a human escalation.
		const message = (await res.json()).error.message as string;
		expect(message).toMatch(/running/i);
		const slug = await db.query<{ slug: string }>('SELECT slug FROM member_agents WHERE id = $1', [
			agentId,
		]);
		expect(message).toContain(`@${slug.rows[0].slug}`);

		// The assignee must not have changed.
		const row = await db.query<{ assignee_id: string }>(
			'SELECT assignee_id FROM tasks WHERE id = $1',
			[task.id],
		);
		expect(row.rows[0].assignee_id).toBe(agentId);

		// Finish the run so it doesn't leak into other reads.
		await db.query(
			`UPDATE heartbeat_runs SET status = 'succeeded'::heartbeat_run_status, finished_at = now() WHERE id = $1`,
			[runId],
		);
	});

	it('allows reassigning the same agent (no-change skips the blocking-run check)', async () => {
		const task = await createTask('Same-assignee target');
		const runId = await createAgentRun(db, agentId, teamId, task.id);
		// Passing the SAME assignee_id skips assertNoActiveRun, so this succeeds
		// even with a running run.
		const res = await app.request(`/api/projects/${projectSlug}/tasks/${task.id}`, {
			method: 'PATCH',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ assignee_id: agentId }),
		});
		expect(res.status).toBe(200);
		await db.query(
			`UPDATE heartbeat_runs SET status = 'succeeded'::heartbeat_run_status, finished_at = now() WHERE id = $1`,
			[runId],
		);
	});

	it('fires a reopen wakeup when the admin re-opens a terminal task with an assignee', async () => {
		const task = await createTask('Reopen wakeup target');
		await app.request(`/api/projects/${projectSlug}/tasks/${task.id}`, {
			method: 'PATCH',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ status: 'cancelled' }),
		});
		await db.query('DELETE FROM agent_wakeup_requests WHERE team_id = $1', [teamId]);

		const res = await app.request(`/api/projects/${projectSlug}/tasks/${task.id}`, {
			method: 'PATCH',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ status: 'backlog' }),
		});
		expect(res.status).toBe(200);

		await flushAsyncWakeups();
		await new Promise((r) => setTimeout(r, 50));

		const wakeups = await db.query<{ source: string; payload: Record<string, unknown> }>(
			`SELECT source::text AS source, payload FROM agent_wakeup_requests
			 WHERE payload->>'task_id' = $1 AND source = 'automation'`,
			[task.id],
		);
		expect(wakeups.rows.length).toBe(1);
		expect(wakeups.rows[0].payload.trigger).toBe('task_reopened');
	});
});

describe('POST /tasks/:taskId/dependencies error paths', () => {
	it('rejects a missing blocked_by_task_id', async () => {
		const task = await createTask('Dep missing-blocker target');
		const res = await app.request(`/api/projects/${projectSlug}/tasks/${task.id}/dependencies`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({}),
		});
		expect(res.status).toBe(400);
		expect((await res.json()).error.message).toMatch(/blocked_by_task_id is required/);
	});

	it('returns 404 when the blocker is not in the team', async () => {
		const task = await createTask('Dep unknown-blocker target');
		const res = await app.request(`/api/projects/${projectSlug}/tasks/${task.id}/dependencies`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ blocked_by_task_id: 'MP-999999' }),
		});
		expect(res.status).toBe(404);
		expect((await res.json()).error.message).toMatch(/Blocking task not found/);
	});

	it('rejects a task blocking itself', async () => {
		const task = await createTask('Dep self-block target');
		const res = await app.request(`/api/projects/${projectSlug}/tasks/${task.id}/dependencies`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ blocked_by_task_id: task.id }),
		});
		expect(res.status).toBe(400);
		expect((await res.json()).error.message).toMatch(/cannot block itself/);
	});

	it('rejects a dependency that would create a cycle', async () => {
		const a = await createTask('Cycle A');
		const b = await createTask('Cycle B');
		// A is blocked by B.
		const first = await app.request(`/api/projects/${projectSlug}/tasks/${a.id}/dependencies`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ blocked_by_task_id: b.id }),
		});
		expect(first.status).toBe(201);
		// Now B blocked by A would close the loop.
		const cycle = await app.request(`/api/projects/${projectSlug}/tasks/${b.id}/dependencies`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ blocked_by_task_id: a.id }),
		});
		expect(cycle.status).toBe(400);
		expect((await cycle.json()).error.message).toMatch(/cycle/i);
	});

	it('returns 409 when the dependency already exists', async () => {
		const a = await createTask('Dup dep A');
		const b = await createTask('Dup dep B');
		const first = await app.request(`/api/projects/${projectSlug}/tasks/${a.id}/dependencies`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ blocked_by_task_id: b.id }),
		});
		expect(first.status).toBe(201);
		const dup = await app.request(`/api/projects/${projectSlug}/tasks/${a.id}/dependencies`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ blocked_by_task_id: b.id }),
		});
		expect(dup.status).toBe(409);
		expect((await dup.json()).error.message).toMatch(/already exists/);
	});

	it('returns 404 on dependency add for an unknown task', async () => {
		const res = await app.request(
			`/api/projects/${projectSlug}/tasks/00000000-0000-0000-0000-000000000000/dependencies`,
			{
				method: 'POST',
				headers: { ...authHeader(token), 'Content-Type': 'application/json' },
				body: JSON.stringify({ blocked_by_task_id: 'MP-1' }),
			},
		);
		expect(res.status).toBe(404);
	});
});

describe('DELETE /tasks/:taskId/dependencies/:depId', () => {
	it('returns 404 when the dependency does not exist', async () => {
		const task = await createTask('Dep delete target');
		const res = await app.request(
			`/api/projects/${projectSlug}/tasks/${task.id}/dependencies/00000000-0000-0000-0000-000000000000`,
			{ method: 'DELETE', headers: authHeader(token) },
		);
		expect(res.status).toBe(404);
		expect((await res.json()).error.message).toMatch(/Dependency not found/);
	});

	it('returns 404 when the task itself is unknown', async () => {
		const res = await app.request(
			`/api/projects/${projectSlug}/tasks/00000000-0000-0000-0000-000000000000/dependencies/00000000-0000-0000-0000-000000000000`,
			{ method: 'DELETE', headers: authHeader(token) },
		);
		expect(res.status).toBe(404);
	});
});

describe('sub-tasks + ancestors + dependencies not-found', () => {
	it('returns 404 creating a sub-task under an unknown parent', async () => {
		const res = await app.request(
			`/api/projects/${projectSlug}/tasks/00000000-0000-0000-0000-000000000000/sub-tasks`,
			{
				method: 'POST',
				headers: { ...authHeader(token), 'Content-Type': 'application/json' },
				body: JSON.stringify({ title: 'orphan sub', assignee_id: agentId }),
			},
		);
		expect(res.status).toBe(404);
		expect((await res.json()).error.message).toMatch(/Parent task not found/);
	});

	it('returns 404 listing dependencies for an unknown identifier', async () => {
		// A non-UUID identifier that resolves to no task yields null → 404.
		const res = await app.request(`/api/projects/${projectSlug}/tasks/MP-99999999/dependencies`, {
			headers: authHeader(token),
		});
		expect(res.status).toBe(404);
	});

	it('returns an empty list for an unknown UUID (passed through, no rows)', async () => {
		const res = await app.request(
			`/api/projects/${projectSlug}/tasks/${'00000000-0000-0000-0000-000000000000'}/dependencies`,
			{ headers: authHeader(token) },
		);
		expect(res.status).toBe(200);
		expect((await res.json()).data).toEqual([]);
	});

	it('returns an empty dependencies list for a task with no dependencies', async () => {
		const task = await createTask('No-deps task');
		const res = await app.request(`/api/projects/${projectSlug}/tasks/${task.id}/dependencies`, {
			headers: authHeader(token),
		});
		expect(res.status).toBe(200);
		expect((await res.json()).data).toEqual([]);
	});
});

describe('POST /tasks create error path', () => {
	it('returns 400 when neither assignee_id nor assignee_slug is supplied', async () => {
		const res = await app.request(`/api/projects/${projectSlug}/tasks`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ title: 'No assignee at all' }),
		});
		expect(res.status).toBe(400);
		expect((await res.json()).error.message).toMatch(/assignee_(id|slug)/);
	});

	it('returns 404 when assignee_slug names an unknown agent', async () => {
		const res = await app.request(`/api/projects/${projectSlug}/tasks`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ title: 'Bad slug', assignee_slug: 'no-such-agent-xyz' }),
		});
		expect(res.status).toBe(404);
		expect((await res.json()).error.message).toMatch(/not found/i);
	});
});

describe('agent PATCH terminal guard with unused agent token var', () => {
	it('mints an agent token and is forbidden from re-opening a terminal task', async () => {
		const task = await createTask('Agent terminal guard');
		await app.request(`/api/projects/${projectSlug}/tasks/${task.id}`, {
			method: 'PATCH',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ status: 'cancelled' }),
		});
		const { token: agentToken } = await mintAgentToken(
			db,
			masterKeyManager,
			agentId,
			teamId,
			null,
			{
				projectId,
			},
		);
		const res = await app.request(`/api/projects/${projectSlug}/tasks/${task.id}`, {
			method: 'PATCH',
			headers: { ...authHeader(agentToken), 'Content-Type': 'application/json' },
			body: JSON.stringify({ status: 'backlog' }),
		});
		expect(res.status).toBe(403);
	});
});
