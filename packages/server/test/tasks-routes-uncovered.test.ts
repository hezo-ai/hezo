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
	finalizeAgentRun,
	mintAgentToken,
} from './helpers/app';

// Line-coverage tests for packages/server/src/routes/tasks.ts driven over real
// HTTP requests: list filters/sort/pagination + unread-mention and
// queued-wakeup annotations, agent-authored create, batch, resolve,
// single-task detail aggregates, latest-run, the PATCH field matrix (incl.
// run-scope denial, done-gates, blocker coercion, cancel-terminates-runs,
// reopen-cancels-coach), sub-tasks, ancestors and the dependency CRUD.

const UNKNOWN_UUID = '00000000-0000-0000-0000-000000000000';

let app: Hono<Env>;
let db: Db;
let token: string;
let masterKeyManager: MasterKeyManager;
let teamId: string;
let projectId: string;
let projectSlug: string;
let agentId: string;
let secondAgentId: string;
let adminUserId: string;

beforeAll(async () => {
	const ctx = await createTestApp();
	app = ctx.app;
	db = ctx.db;
	token = ctx.token;
	masterKeyManager = ctx.masterKeyManager;

	const teamRes = await createTestTeam(db, { name: 'Tasks Uncov Co' });
	teamId = (await teamRes.json()).data.id;

	const projectRes = await createTestProject(db, teamId, { name: 'Tasks Uncov Project' });
	const projectData = (await projectRes.json()).data;
	projectId = projectData.id;
	projectSlug = projectData.slug;

	const agentRes = await app.request(`/api/projects/${projectSlug}/agents`, {
		method: 'POST',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify({ title: 'Uncov Agent' }),
	});
	agentId = (await agentRes.json()).data.id;

	const secondAgentRes = await app.request(`/api/projects/${projectSlug}/agents`, {
		method: 'POST',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify({ title: 'Uncov Agent Two' }),
	});
	secondAgentId = (await secondAgentRes.json()).data.id;

	const admin = await db.query<{ id: string }>(
		'SELECT id FROM users WHERE is_superuser = true ORDER BY created_at LIMIT 1',
	);
	adminUserId = admin.rows[0].id;
});

afterAll(async () => {
	await safeClose(db);
});

async function createTask(
	title: string,
	extra: Record<string, unknown> = {},
): Promise<{ id: string; identifier: string; status: string }> {
	const res = await app.request(`/api/projects/${projectSlug}/tasks`, {
		method: 'POST',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify({ title, assignee_id: agentId, ...extra }),
	});
	expect(res.status).toBe(201);
	return (await res.json()).data;
}

async function patchTask(
	taskRef: string,
	body: Record<string, unknown>,
	authToken = token,
): Promise<Response> {
	return app.request(`/api/projects/${projectSlug}/tasks/${taskRef}`, {
		method: 'PATCH',
		headers: { ...authHeader(authToken), 'Content-Type': 'application/json' },
		body: JSON.stringify(body),
	});
}

/** Poll until `fn` resolves truthy (background/tracked work) or ~2s elapse. */
async function eventually(fn: () => Promise<boolean>): Promise<boolean> {
	for (let i = 0; i < 40; i++) {
		if (await fn()) return true;
		await new Promise((r) => setTimeout(r, 50));
	}
	return false;
}

describe('GET /tasks — list filters, sort, pagination, annotations', () => {
	it('applies assignee, status, priority and search filters together', async () => {
		await createTask('Filterme alpha combo', { priority: 'high' });
		const res = await app.request(
			`/api/projects/${projectSlug}/tasks?assignee_id=${agentId},${secondAgentId}&status=backlog,in_progress&priority=high,urgent&search=filterme%20alpha`,
			{ headers: authHeader(token) },
		);
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.data.length).toBe(1);
		expect(body.data[0].title).toBe('Filterme alpha combo');
		expect(body.data[0].priority).toBe('high');
		expect(body.data[0].assignee_id).toBe(agentId);
	});

	it('filters by parent_task_id', async () => {
		const parent = await createTask('Parent filter root');
		const subRes = await app.request(`/api/projects/${projectSlug}/tasks/${parent.id}/sub-tasks`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ title: 'Parent filter child', assignee_id: agentId }),
		});
		const child = (await subRes.json()).data;
		const res = await app.request(
			`/api/projects/${projectSlug}/tasks?parent_task_id=${parent.id}`,
			{ headers: authHeader(token) },
		);
		expect(res.status).toBe(200);
		const data = (await res.json()).data;
		expect(data.map((t: { id: string }) => t.id)).toEqual([child.id]);
	});

	it('serves the phase banner for the project', async () => {
		const res = await app.request(`/api/projects/${projectSlug}/tasks/phase-banner`, {
			headers: authHeader(token),
		});
		expect(res.status).toBe(200);
		expect((await res.json()).data).toBeDefined();
	});

	it('paginates with meta and honours an explicit sort', async () => {
		await createTask('Paginated one');
		await createTask('Paginated two');
		const res = await app.request(
			`/api/projects/${projectSlug}/tasks?page=1&per_page=1&sort=created_at:asc&search=Paginated`,
			{ headers: authHeader(token) },
		);
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.data.length).toBe(1);
		expect(body.meta.total).toBe(2);
		expect(body.meta.page).toBe(1);
		expect(body.data[0].title).toBe('Paginated one');
	});

	it('flags has_active_run and has_unread_admin_mention for the admin caller', async () => {
		const task = await createTask('Annotated task');
		const runId = await createAgentRun(db, agentId, teamId, task.id);

		// An unread inbox mention for the authenticated admin on this task.
		const comment = await db.query<{ id: string }>(
			`INSERT INTO task_comments (task_id, author_member_id, content_type, content)
			 VALUES ($1, $2, 'text'::comment_content_type, '{"text":"@admin look"}'::jsonb)
			 RETURNING id`,
			[task.id, agentId],
		);
		await db.query(
			'INSERT INTO admin_mentions (team_id, task_id, comment_id, user_id) VALUES ($1, $2, $3, $4)',
			[teamId, task.id, comment.rows[0].id, adminUserId],
		);

		const res = await app.request(`/api/projects/${projectSlug}/tasks?search=Annotated`, {
			headers: authHeader(token),
		});
		expect(res.status).toBe(200);
		const row = (await res.json()).data.find((t: { id: string }) => t.id === task.id);
		expect(row.has_active_run).toBe(true);
		expect(row.has_unread_admin_mention).toBe(true);

		await finalizeAgentRun(db, runId);
		// Answer the mention so later done-gates on other tasks stay unaffected.
		await db.query('UPDATE admin_mentions SET read_at = now() WHERE task_id = $1', [task.id]);
	});

	it('surfaces the queued_wakeup skip annotation with blocker details', async () => {
		const blocker = await createTask('Skip blocker');
		const task = await createTask('Skipped task');
		// Seed the queued-but-skipped wakeup the dispatcher would have annotated.
		await db.query(
			`INSERT INTO agent_wakeup_requests
			   (member_id, team_id, source, status, payload,
			    last_skipped_at, last_skipped_reason, last_skipped_blocker_task_id)
			 VALUES ($1, $2, 'assignment'::wakeup_source, 'queued'::wakeup_status, $3::jsonb,
			         now(), 'blocked', $4)`,
			[agentId, teamId, JSON.stringify({ task_id: task.id }), blocker.id],
		);
		const res = await app.request(`/api/projects/${projectSlug}/tasks?search=Skipped%20task`, {
			headers: authHeader(token),
		});
		const row = (await res.json()).data.find((t: { id: string }) => t.id === task.id);
		expect(row.queued_wakeup).not.toBeNull();
		expect(row.queued_wakeup.reason).toBe('blocked');
		expect(row.queued_wakeup.blocker_identifier).toBe(blocker.identifier);
		expect(row.queued_wakeup.blocker_project_slug).toBe(projectSlug);
	});
});

describe('POST /tasks — creation callers', () => {
	it('lets an agent run create a task (agent caller identity)', async () => {
		const scopeTask = await createTask('Agent-create scope task');
		const { token: agentToken, runId } = await mintAgentToken(
			db,
			masterKeyManager,
			agentId,
			teamId,
			scopeTask.id,
		);
		const res = await app.request(`/api/projects/${projectSlug}/tasks`, {
			method: 'POST',
			headers: { ...authHeader(agentToken), 'Content-Type': 'application/json' },
			body: JSON.stringify({ title: 'Created by an agent', assignee_id: agentId }),
		});
		expect(res.status).toBe(201);
		const data = (await res.json()).data;
		expect(data.title).toBe('Created by an agent');
		const row = await db.query<{ created_by_member_id: string | null }>(
			'SELECT created_by_member_id FROM tasks WHERE id = $1',
			[data.id],
		);
		expect(row.rows[0].created_by_member_id).toBe(agentId);
		await finalizeAgentRun(db, runId);
	});

	it('maps CreateTaskError NOT_FOUND to 404 on an explicit foreign project', async () => {
		const res = await app.request(`/api/projects/${projectSlug}/tasks`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				title: 'Bad slug ref',
				assignee_slug: 'definitely-not-an-agent',
			}),
		});
		expect(res.status).toBe(404);
		expect((await res.json()).error.code).toBe('NOT_FOUND');
	});

	it('maps CreateTaskError INVALID_REQUEST to 400', async () => {
		const res = await app.request(`/api/projects/${projectSlug}/tasks`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ title: 'No assignee here' }),
		});
		expect(res.status).toBe(400);
		expect((await res.json()).error.code).toBe('INVALID_REQUEST');
	});
});

describe('POST /tasks/batch', () => {
	it('rejects non-array, empty and oversized items', async () => {
		for (const [items, msg] of [
			['nope', /must be an array/],
			[[], /at least one/],
			[Array.from({ length: 51 }, (_, i) => ({ title: `b${i}` })), /may not exceed 50/],
		] as const) {
			const res = await app.request(`/api/projects/${projectSlug}/tasks/batch`, {
				method: 'POST',
				headers: { ...authHeader(token), 'Content-Type': 'application/json' },
				body: JSON.stringify({ items }),
			});
			expect(res.status).toBe(400);
			expect((await res.json()).error.message).toMatch(msg);
		}
	});

	it('creates a batch and reports per-item failures', async () => {
		const res = await app.request(`/api/projects/${projectSlug}/tasks/batch`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				items: [
					{ title: 'Batch ok one', assignee_id: agentId, project_id: projectId },
					{ title: 'Batch missing assignee', project_id: projectId },
				],
			}),
		});
		expect(res.status).toBe(200);
		const data = (await res.json()).data;
		expect(data).toHaveLength(2);
		expect(data[0].ok).toBe(true);
		expect(data[0].task.title).toBe('Batch ok one');
		expect(data[1].ok).toBe(false);
		expect(data[1].code).toBe('INVALID_REQUEST');
	});
});

describe('GET /tasks/:taskId + resolve + latest-run', () => {
	it('returns the detail row with aggregates and resolves by identifier', async () => {
		const task = await createTask('Detail aggregates task', { description: 'desc here' });
		const runId = await createAgentRun(db, agentId, teamId, task.id);
		await finalizeAgentRun(db, runId, 'succeeded');
		await db.query(
			`INSERT INTO cost_entries (member_id, task_id, project_id, amount_cents, description)
			 VALUES ($1, $2, $3, 42, 'test cost')`,
			[agentId, task.id, projectId],
		);

		const res = await app.request(
			`/api/projects/${projectSlug}/tasks/${task.identifier.toLowerCase()}`,
			{ headers: authHeader(token) },
		);
		expect(res.status).toBe(200);
		const data = (await res.json()).data;
		expect(data.id).toBe(task.id);
		expect(data.project_slug).toBe(projectSlug);
		expect(data.assignee_name).toBe('Uncov Agent');
		expect(data.run_count).toBe(1);
		expect(data.total_cost_cents).toBe(42);
		expect(data.last_run_status).toBe('succeeded');
		expect(data.has_active_run).toBe(false);
	});

	it('404s on an unknown UUID and an unknown identifier', async () => {
		const byUuid = await app.request(`/api/projects/${projectSlug}/tasks/${UNKNOWN_UUID}`, {
			headers: authHeader(token),
		});
		expect(byUuid.status).toBe(404);
		const byIdent = await app.request(`/api/projects/${projectSlug}/tasks/ZZ-424242`, {
			headers: authHeader(token),
		});
		expect(byIdent.status).toBe(404);
	});

	it('resolve validates, dedupes and matches case-insensitively', async () => {
		const task = await createTask('Resolve me task');
		const bad = await app.request(`/api/projects/${projectSlug}/tasks/resolve`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ identifiers: 'nope' }),
		});
		expect(bad.status).toBe(400);

		const tooMany = await app.request(`/api/projects/${projectSlug}/tasks/resolve`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ identifiers: Array.from({ length: 101 }, (_, i) => `X-${i}`) }),
		});
		expect(tooMany.status).toBe(400);

		const blank = await app.request(`/api/projects/${projectSlug}/tasks/resolve`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ identifiers: ['', 7, null] }),
		});
		expect(blank.status).toBe(200);
		expect((await blank.json()).data).toEqual([]);

		const ok = await app.request(`/api/projects/${projectSlug}/tasks/resolve`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				identifiers: [task.identifier.toLowerCase(), ` ${task.identifier} `],
			}),
		});
		expect(ok.status).toBe(200);
		const rows = (await ok.json()).data;
		expect(rows).toHaveLength(1);
		expect(rows[0].identifier).toBe(task.identifier);
		expect(rows[0].project_slug).toBe(projectSlug);
	});

	it('latest-run returns the most recent run row (and null when none)', async () => {
		const bare = await createTask('Latest-run empty');
		const empty = await app.request(`/api/projects/${projectSlug}/tasks/${bare.id}/latest-run`, {
			headers: authHeader(token),
		});
		expect(empty.status).toBe(200);
		expect((await empty.json()).data).toBeNull();

		const task = await createTask('Latest-run target');
		const runId = await createAgentRun(db, agentId, teamId, task.id);
		await finalizeAgentRun(db, runId, 'failed');
		const res = await app.request(`/api/projects/${projectSlug}/tasks/${task.id}/latest-run`, {
			headers: authHeader(token),
		});
		expect(res.status).toBe(200);
		const data = (await res.json()).data;
		expect(data.id).toBe(runId);
		expect(data.status).toBe('failed');
		expect(data.agent_title).toBe('Uncov Agent');
	});
});

describe('PATCH /tasks/:taskId — field matrix', () => {
	it('updates every writable field in one request', async () => {
		const task = await createTask('Full patch target');
		const res = await patchTask(task.id, {
			title: '  Fully patched  ',
			description: 'new description',
			status: 'in_progress',
			priority: 'urgent',
			labels: ['a', 'b'],
			progress_summary: 'halfway there',
			rules: 'be nice',
			branch_name: 'feat/full-patch',
			runtime_type: 'codex',
		});
		expect(res.status).toBe(200);
		const data = (await res.json()).data;
		expect(data.title).toBe('Fully patched');
		expect(data.description).toBe('new description');
		expect(data.status).toBe('in_progress');
		expect(data.priority).toBe('urgent');
		expect(data.labels).toEqual(['a', 'b']);
		expect(data.progress_summary).toBe('halfway there');
		expect(data.rules).toBe('be nice');
		expect(data.branch_name).toBe('feat/full-patch');
		expect(data.runtime_type).toBe('codex');
		// Admin-set progress summary attributes to no member.
		expect(data.progress_summary_updated_by).toBeNull();
		expect(data.progress_summary_updated_at).not.toBeNull();
	});

	it('attributes an agent-set progress_summary to the agent', async () => {
		const task = await createTask('Agent summary target');
		const { token: agentToken, runId } = await mintAgentToken(
			db,
			masterKeyManager,
			agentId,
			teamId,
			task.id,
		);
		const res = await patchTask(task.id, { progress_summary: 'agent did this' }, agentToken);
		expect(res.status).toBe(200);
		expect((await res.json()).data.progress_summary_updated_by).toBe(agentId);
		await finalizeAgentRun(db, runId);
	});

	it('rejects a null assignee_id', async () => {
		const task = await createTask('Null assignee target');
		const res = await patchTask(task.id, { assignee_id: null });
		expect(res.status).toBe(400);
		expect((await res.json()).error.message).toMatch(/assignee_id cannot be null/);
	});

	it('409s a reassignment while a run is active on the task', async () => {
		const task = await createTask('Reassign conflict target');
		const runId = await createAgentRun(db, agentId, teamId, task.id);
		const res = await patchTask(task.id, { assignee_id: secondAgentId });
		expect(res.status).toBe(409);
		expect((await res.json()).error.code).toBe('CONFLICT');
		const row = await db.query<{ assignee_id: string }>(
			'SELECT assignee_id FROM tasks WHERE id = $1',
			[task.id],
		);
		expect(row.rows[0].assignee_id).toBe(agentId);
		await finalizeAgentRun(db, runId);
	});

	it('reassigns and wakes the new agent assignee', async () => {
		const task = await createTask('Reassign wake target');
		const res = await patchTask(task.id, { assignee_id: secondAgentId });
		expect(res.status).toBe(200);
		expect((await res.json()).data.assignee_id).toBe(secondAgentId);
		expect(
			await eventually(async () => {
				const w = await db.query(
					`SELECT 1 FROM agent_wakeup_requests
					 WHERE member_id = $1 AND payload->>'task_id' = $2`,
					[secondAgentId, task.id],
				);
				return w.rows.length > 0;
			}),
		).toBe(true);
		// The assignee-change system comment was recorded synchronously.
		const comments = await db.query<{ content: { text?: string } }>(
			`SELECT content FROM task_comments WHERE task_id = $1 AND content_type = 'system'`,
			[task.id],
		);
		expect(comments.rows.some((r) => /assign/i.test(r.content?.text ?? ''))).toBe(true);
	});

	it('denies an agent run moving a different task to in_progress (run scope)', async () => {
		const own = await createTask('Scope own task');
		const other = await createTask('Scope other task');
		const { token: agentToken, runId } = await mintAgentToken(
			db,
			masterKeyManager,
			agentId,
			teamId,
			own.id,
		);
		const denied = await patchTask(other.id, { status: 'in_progress' }, agentToken);
		expect(denied.status).toBe(403);
		expect((await denied.json()).error.message).toMatch(/scoped to its own ticket/);

		// The same transition on the run's own task is allowed.
		const allowed = await patchTask(own.id, { status: 'in_progress' }, agentToken);
		expect(allowed.status).toBe(200);
		expect((await allowed.json()).data.status).toBe('in_progress');
		await finalizeAgentRun(db, runId);
	});

	it('forbids an agent re-opening a terminal task', async () => {
		const task = await createTask('Terminal guard task');
		expect((await patchTask(task.id, { status: 'cancelled' })).status).toBe(200);
		const { token: agentToken, runId } = await mintAgentToken(
			db,
			masterKeyManager,
			agentId,
			teamId,
			task.id,
		);
		const res = await patchTask(task.id, { status: 'backlog' }, agentToken);
		expect(res.status).toBe(403);
		expect((await res.json()).error.message).toMatch(/re-open/i);
		await finalizeAgentRun(db, runId);
	});

	it('blocks done while a sub-task is still open', async () => {
		const parent = await createTask('Done gate parent');
		const sub = await app.request(`/api/projects/${projectSlug}/tasks/${parent.id}/sub-tasks`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ title: 'Open child', assignee_id: agentId }),
		});
		expect(sub.status).toBe(201);
		const res = await patchTask(parent.id, { status: 'done' });
		expect(res.status).toBe(400);
		expect((await res.json()).error.message).toMatch(/sub-task/i);
	});

	it("blocks done while another agent's run is active on the task", async () => {
		const task = await createTask('Done gate activity');
		const runId = await createAgentRun(db, secondAgentId, teamId, task.id);
		const res = await patchTask(task.id, { status: 'done' });
		expect(res.status).toBe(400);
		expect((await res.json()).error.message).toMatch(/still has a running run/);
		await finalizeAgentRun(db, runId);
	});

	it('blocks an agent closing over an unanswered @admin ask (humans may)', async () => {
		const task = await createTask('Done gate admin ask');
		const comment = await db.query<{ id: string }>(
			`INSERT INTO task_comments (task_id, author_member_id, content_type, content)
			 VALUES ($1, $2, 'text'::comment_content_type, '{"text":"@admin should I?"}'::jsonb)
			 RETURNING id`,
			[task.id, agentId],
		);
		await db.query(
			'INSERT INTO admin_mentions (team_id, task_id, comment_id, user_id) VALUES ($1, $2, $3, $4)',
			[teamId, task.id, comment.rows[0].id, adminUserId],
		);
		const { token: agentToken, runId } = await mintAgentToken(
			db,
			masterKeyManager,
			agentId,
			teamId,
			task.id,
		);
		const res = await patchTask(task.id, { status: 'done' }, agentToken);
		expect(res.status).toBe(400);
		expect((await res.json()).error.message).toMatch(/@admin question/);
		await finalizeAgentRun(db, runId);

		// A human closing the same task bypasses the ask gate.
		const human = await patchTask(task.id, { status: 'done' });
		expect(human.status).toBe(200);
		expect((await human.json()).data.status).toBe('done');
	});

	it('coerces a non-terminal target to blocked while blockers are open', async () => {
		const blocker = await createTask('Coerce blocker');
		const task = await createTask('Coerce target');
		const dep = await app.request(`/api/projects/${projectSlug}/tasks/${task.id}/dependencies`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ blocked_by_task_id: blocker.identifier }),
		});
		expect(dep.status).toBe(201);
		const res = await patchTask(task.id, { status: 'in_progress' });
		expect(res.status).toBe(200);
		expect((await res.json()).data.status).toBe('blocked');
	});

	it('coerces a blocked target to backlog when no blockers remain', async () => {
		const task = await createTask('Coerce unblocked');
		const res = await patchTask(task.id, { status: 'blocked' });
		expect(res.status).toBe(200);
		expect((await res.json()).data.status).toBe('backlog');
	});

	it('cancelling a task terminates its queued/running runs in the background', async () => {
		const task = await createTask('Cancel terminates runs');
		const runId = await createAgentRun(db, agentId, teamId, task.id);
		const res = await patchTask(task.id, { status: 'cancelled' });
		expect(res.status).toBe(200);
		expect(
			await eventually(async () => {
				const r = await db.query<{ status: string }>(
					'SELECT status::text AS status FROM heartbeat_runs WHERE id = $1',
					[runId],
				);
				return r.rows[0]?.status === 'cancelled';
			}),
		).toBe(true);
	});

	it('re-opening a done task retires queued Coach wakeups and wakes the assignee', async () => {
		const task = await createTask('Reopen coach retire');
		expect((await patchTask(task.id, { status: 'done' })).status).toBe(200);

		// Seed a queued Coach wakeup for this task, as the done-automation would.
		const coach = await db.query<{ id: string }>(
			"SELECT id FROM member_agents WHERE slug = 'coach' LIMIT 1",
		);
		const coachId = coach.rows[0].id;
		await db.query(
			`INSERT INTO agent_wakeup_requests (member_id, team_id, source, status, payload)
			 VALUES ($1, $2, 'automation'::wakeup_source, 'queued'::wakeup_status, $3::jsonb)`,
			[coachId, teamId, JSON.stringify({ task_id: task.id })],
		);

		const res = await patchTask(task.id, { status: 'backlog' });
		expect(res.status).toBe(200);
		expect(
			await eventually(async () => {
				const w = await db.query(
					`SELECT 1 FROM agent_wakeup_requests
					 WHERE member_id = $1 AND payload->>'task_id' = $2 AND status = 'queued'`,
					[coachId, task.id],
				);
				return w.rows.length === 0;
			}),
		).toBe(true);

		// The assignee got a task_reopened automation wakeup.
		expect(
			await eventually(async () => {
				const w = await db.query(
					`SELECT 1 FROM agent_wakeup_requests
					 WHERE member_id = $1 AND payload->>'task_id' = $2 AND payload->>'trigger' = 'task_reopened'`,
					[agentId, task.id],
				);
				return w.rows.length > 0;
			}),
		).toBe(true);
	});

	it('404s for unknown tasks and no-ops on an empty body', async () => {
		expect((await patchTask(UNKNOWN_UUID, { title: 'x' })).status).toBe(404);
		const task = await createTask('No-op patch');
		const res = await patchTask(task.id, {});
		expect(res.status).toBe(200);
		expect((await res.json()).data.title).toBe('No-op patch');
	});
});

describe('sub-tasks and ancestors', () => {
	it('creates a sub-task inheriting the parent project', async () => {
		const parent = await createTask('Sub parent');
		const res = await app.request(
			`/api/projects/${projectSlug}/tasks/${parent.identifier}/sub-tasks`,
			{
				method: 'POST',
				headers: { ...authHeader(token), 'Content-Type': 'application/json' },
				body: JSON.stringify({ title: 'Sub child', assignee_id: agentId }),
			},
		);
		expect(res.status).toBe(201);
		const data = (await res.json()).data;
		expect(data.parent_task_id).toBe(parent.id);
		expect(data.project_id).toBe(projectId);
	});

	it('maps CreateTaskError to 400 on a sub-task without an assignee', async () => {
		const parent = await createTask('Sub err parent');
		const res = await app.request(`/api/projects/${projectSlug}/tasks/${parent.id}/sub-tasks`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ title: 'No assignee child' }),
		});
		expect(res.status).toBe(400);
	});

	it('404s creating a sub-task under an unknown parent', async () => {
		const res = await app.request(`/api/projects/${projectSlug}/tasks/ZZ-9999/sub-tasks`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ title: 'orphan', assignee_id: agentId }),
		});
		expect(res.status).toBe(404);

		// A well-formed UUID passes identifier resolution but misses the parent
		// row lookup — the second 404 branch.
		const byUuid = await app.request(
			`/api/projects/${projectSlug}/tasks/${UNKNOWN_UUID}/sub-tasks`,
			{
				method: 'POST',
				headers: { ...authHeader(token), 'Content-Type': 'application/json' },
				body: JSON.stringify({ title: 'orphan uuid', assignee_id: agentId }),
			},
		);
		expect(byUuid.status).toBe(404);
	});

	it('lists ancestors from a grandchild (deepest first) and [] for a root', async () => {
		const parent = await createTask('Anc parent');
		const childRes = await app.request(
			`/api/projects/${projectSlug}/tasks/${parent.id}/sub-tasks`,
			{
				method: 'POST',
				headers: { ...authHeader(token), 'Content-Type': 'application/json' },
				body: JSON.stringify({ title: 'Anc child', assignee_id: agentId }),
			},
		);
		const child = (await childRes.json()).data;
		const grandRes = await app.request(`/api/projects/${projectSlug}/tasks/${child.id}/sub-tasks`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ title: 'Anc grandchild', assignee_id: agentId }),
		});
		const grandchild = (await grandRes.json()).data;

		const res = await app.request(`/api/projects/${projectSlug}/tasks/${grandchild.id}/ancestors`, {
			headers: authHeader(token),
		});
		expect(res.status).toBe(200);
		const data = (await res.json()).data;
		expect(data.map((a: { id: string }) => a.id)).toEqual([parent.id, child.id]);

		const root = await app.request(`/api/projects/${projectSlug}/tasks/${parent.id}/ancestors`, {
			headers: authHeader(token),
		});
		expect((await root.json()).data).toEqual([]);

		const missing = await app.request(`/api/projects/${projectSlug}/tasks/ZZ-8888/ancestors`, {
			headers: authHeader(token),
		});
		expect(missing.status).toBe(404);
	});
});

describe('dependencies CRUD', () => {
	it('adds a dependency, reflects it in GET and derives blocked status', async () => {
		const blocker = await createTask('Dep blocker task');
		const task = await createTask('Dep dependent task');

		const missing = await app.request(
			`/api/projects/${projectSlug}/tasks/${task.id}/dependencies`,
			{
				method: 'POST',
				headers: { ...authHeader(token), 'Content-Type': 'application/json' },
				body: JSON.stringify({}),
			},
		);
		expect(missing.status).toBe(400);

		const self = await app.request(`/api/projects/${projectSlug}/tasks/${task.id}/dependencies`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ blocked_by_task_id: task.id }),
		});
		expect(self.status).toBe(400);

		const created = await app.request(
			`/api/projects/${projectSlug}/tasks/${task.id}/dependencies`,
			{
				method: 'POST',
				headers: { ...authHeader(token), 'Content-Type': 'application/json' },
				body: JSON.stringify({ blocked_by_task_id: blocker.id }),
			},
		);
		expect(created.status).toBe(201);
		const dep = (await created.json()).data;
		expect(dep.blocked_by_task_id).toBe(blocker.id);

		const dup = await app.request(`/api/projects/${projectSlug}/tasks/${task.id}/dependencies`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ blocked_by_task_id: blocker.id }),
		});
		expect(dup.status).toBe(409);

		const cycle = await app.request(
			`/api/projects/${projectSlug}/tasks/${blocker.id}/dependencies`,
			{
				method: 'POST',
				headers: { ...authHeader(token), 'Content-Type': 'application/json' },
				body: JSON.stringify({ blocked_by_task_id: task.id }),
			},
		);
		expect(cycle.status).toBe(400);
		expect((await cycle.json()).error.message).toMatch(/cycle/i);

		const list = await app.request(`/api/projects/${projectSlug}/tasks/${task.id}/dependencies`, {
			headers: authHeader(token),
		});
		expect(list.status).toBe(200);
		const rows = (await list.json()).data;
		expect(rows).toHaveLength(1);
		expect(rows[0].blocked_by_identifier).toBe(blocker.identifier);
		expect(rows[0].blocked_by_title).toBe('Dep blocker task');
		expect(rows[0].blocked_by_project_slug).toBe(projectSlug);
		expect(rows[0].blocked_by_has_active_run).toBe(false);

		// The dependent's status was reconciled to blocked.
		const detail = await app.request(`/api/projects/${projectSlug}/tasks/${task.id}`, {
			headers: authHeader(token),
		});
		expect((await detail.json()).data.status).toBe('blocked');

		// Deleting the dependency flips it back to backlog.
		const del = await app.request(
			`/api/projects/${projectSlug}/tasks/${task.id}/dependencies/${dep.id}`,
			{ method: 'DELETE', headers: authHeader(token) },
		);
		expect(del.status).toBe(200);
		expect((await del.json()).data).toBeNull();
		const gone = await db.query('SELECT 1 FROM task_dependencies WHERE id = $1', [dep.id]);
		expect(gone.rows).toHaveLength(0);
		const after = await app.request(`/api/projects/${projectSlug}/tasks/${task.id}`, {
			headers: authHeader(token),
		});
		expect((await after.json()).data.status).toBe('backlog');
	});

	it('404s on the dependency error lookups', async () => {
		const task = await createTask('Dep 404 task');
		const unknownBlocker = await app.request(
			`/api/projects/${projectSlug}/tasks/${task.id}/dependencies`,
			{
				method: 'POST',
				headers: { ...authHeader(token), 'Content-Type': 'application/json' },
				body: JSON.stringify({ blocked_by_task_id: 'ZZ-777777' }),
			},
		);
		expect(unknownBlocker.status).toBe(404);

		const unknownTask = await app.request(
			`/api/projects/${projectSlug}/tasks/ZZ-777777/dependencies`,
			{
				method: 'POST',
				headers: { ...authHeader(token), 'Content-Type': 'application/json' },
				body: JSON.stringify({ blocked_by_task_id: task.id }),
			},
		);
		expect(unknownTask.status).toBe(404);

		const unknownDep = await app.request(
			`/api/projects/${projectSlug}/tasks/${task.id}/dependencies/${UNKNOWN_UUID}`,
			{ method: 'DELETE', headers: authHeader(token) },
		);
		expect(unknownDep.status).toBe(404);
	});
});
