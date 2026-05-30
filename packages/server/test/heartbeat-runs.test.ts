import type { PGlite } from '@electric-sql/pglite';
import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MasterKeyManager } from '../src/crypto/master-key';
import type { Env } from '../src/lib/types';
import {
	type AgentInfo,
	createHeartbeatRun,
	type HeartbeatRunBroadcast,
} from '../src/services/agent-runner';
import { safeClose } from './helpers';
import { authHeader, createTestApp, createTestProject, mintAgentToken } from './helpers/app';

let app: Hono<Env>;
let db: PGlite;
let token: string;
let masterKeyManager: MasterKeyManager;
let teamId: string;
let agentId: string;
let projectId: string;
let taskId: string;

async function mintTestWakeup(memberId: string, cId: string): Promise<string> {
	const r = await db.query<{ id: string }>(
		`INSERT INTO agent_wakeup_requests (member_id, team_id, source, status, payload, claimed_at)
		 VALUES ($1, $2, 'on_demand'::wakeup_source, 'claimed'::wakeup_status, '{}'::jsonb, now())
		 RETURNING id`,
		[memberId, cId],
	);
	return r.rows[0].id;
}

beforeAll(async () => {
	const ctx = await createTestApp();
	app = ctx.app;
	db = ctx.db;
	token = ctx.token;
	masterKeyManager = ctx.masterKeyManager;

	const teamRes = await app.request('/api/teams', {
		method: 'POST',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify({ name: 'Run Test Co' }),
	});
	teamId = (await teamRes.json()).data.id;

	const projectRes = await createTestProject(db, teamId, {
		name: 'Main',
		description: 'Test project.',
	});
	projectId = (await projectRes.json()).data.id;

	const agentRes = await app.request(`/api/teams/${teamId}/agents`, {
		method: 'POST',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify({ title: 'Test Runner' }),
	});
	agentId = (await agentRes.json()).data.id;

	const taskRes = await app.request(`/api/teams/${teamId}/tasks`, {
		method: 'POST',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify({
			project_id: projectId,
			title: 'Test Task',
			assignee_id: agentId,
		}),
	});
	taskId = (await taskRes.json()).data.id;
});

afterAll(async () => {
	await safeClose(db);
});

describe('heartbeat-runs API', () => {
	let runId: string;

	it('stores task_id on heartbeat_runs', async () => {
		const result = await db.query<{ id: string }>(
			`INSERT INTO heartbeat_runs (member_id, team_id, task_id, status)
			 VALUES ($1, $2, $3, 'running'::heartbeat_run_status)
			 RETURNING id`,
			[agentId, teamId, taskId],
		);
		runId = result.rows[0].id;
		expect(runId).toBeTruthy();

		const verify = await db.query<{ task_id: string }>(
			'SELECT task_id FROM heartbeat_runs WHERE id = $1',
			[runId],
		);
		expect(verify.rows[0].task_id).toBe(taskId);
	});

	it('lists runs with task info', async () => {
		await db.query(
			`UPDATE heartbeat_runs
			 SET status = 'succeeded'::heartbeat_run_status,
			     finished_at = now(),
			     exit_code = 0,
			     log_text = 'test output',
			     invocation_command = '$ claude --mcp-config {...} -p task',
			     working_dir = '/worktrees/RT-1/main',
			     started_at = now()
			 WHERE id = $1`,
			[runId],
		);

		const res = await app.request(`/api/teams/${teamId}/agents/${agentId}/heartbeat-runs`, {
			headers: authHeader(token),
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.data.length).toBeGreaterThanOrEqual(1);

		const run = body.data.find((r: Record<string, unknown>) => r.id === runId);
		expect(run).toBeTruthy();
		expect(run.task_id).toBe(taskId);
		expect(run.task_identifier).toBeTruthy();
		expect(run.task_title).toBe('Test Task');
	});

	it('gets a single run by id with task info', async () => {
		const res = await app.request(
			`/api/teams/${teamId}/agents/${agentId}/heartbeat-runs/${runId}`,
			{ headers: authHeader(token) },
		);
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.data.id).toBe(runId);
		expect(body.data.task_title).toBe('Test Task');
		expect(body.data.status).toBe('succeeded');
		expect(body.data.log_text).toBe('test output');
		expect(body.data.invocation_command).toContain('$ claude --mcp-config');
		expect(body.data.working_dir).toBe('/worktrees/RT-1/main');
	});

	it('returns 404 for nonexistent run', async () => {
		const fakeId = '00000000-0000-0000-0000-000000000000';
		const res = await app.request(
			`/api/teams/${teamId}/agents/${agentId}/heartbeat-runs/${fakeId}`,
			{ headers: authHeader(token) },
		);
		expect(res.status).toBe(404);
	});

	it('allows null task_id on heartbeat_runs', async () => {
		const result = await db.query<{ id: string }>(
			`INSERT INTO heartbeat_runs (member_id, team_id, status)
			 VALUES ($1, $2, 'running'::heartbeat_run_status)
			 RETURNING id`,
			[agentId, teamId],
		);
		expect(result.rows[0].id).toBeTruthy();

		const verify = await db.query<{ task_id: string | null }>(
			'SELECT task_id FROM heartbeat_runs WHERE id = $1',
			[result.rows[0].id],
		);
		expect(verify.rows[0].task_id).toBeNull();
	});
});

describe('run comments', () => {
	it('createHeartbeatRun inserts a run-type comment linked to the run', async () => {
		const agent: AgentInfo = {
			id: agentId,
			title: 'Test Runner',
			team_id: teamId,
		};
		const task = {
			id: taskId,
			identifier: 'RT-1',
			title: 'Test Task',
			description: '',
			status: 'backlog',
			priority: 'medium',
			project_id: projectId,
			rules: null,
		};
		const broadcast: HeartbeatRunBroadcast = {
			teamId,
			taskId,
			memberId: agentId,
		};

		const runId = await createHeartbeatRun(
			db,
			agent,
			task,
			broadcast,
			await mintTestWakeup(agentId, teamId),
		);
		expect(runId).toBeTruthy();

		const runRow = await db.query<{ id: string; status: string }>(
			'SELECT id, status FROM heartbeat_runs WHERE id = $1',
			[runId],
		);
		expect(runRow.rows[0].status).toBe('queued');

		const comments = await db.query<{
			id: string;
			content_type: string;
			content: Record<string, unknown>;
			author_member_id: string | null;
		}>(
			`SELECT id, content_type, content, author_member_id
			 FROM task_comments
			 WHERE task_id = $1 AND content_type = 'run'::comment_content_type
			   AND content->>'run_id' = $2`,
			[taskId, runId],
		);
		expect(comments.rows.length).toBe(1);
		expect(comments.rows[0].author_member_id).toBe(agentId);
		expect(comments.rows[0].content.run_id).toBe(runId);
		expect(comments.rows[0].content.agent_id).toBe(agentId);
		expect(comments.rows[0].content.agent_title).toBe('Test Runner');
	});

	it('does not insert a second comment when the run finishes', async () => {
		const agent: AgentInfo = {
			id: agentId,
			title: 'Test Runner',
			team_id: teamId,
		};
		const task = {
			id: taskId,
			identifier: 'RT-1',
			title: 'Test Task',
			description: '',
			status: 'backlog',
			priority: 'medium',
			project_id: projectId,
			rules: null,
		};
		const before = await db.query<{ n: number }>(
			'SELECT COUNT(*)::int AS n FROM task_comments WHERE task_id = $1',
			[taskId],
		);

		const newRunId = await createHeartbeatRun(
			db,
			agent,
			task,
			{
				teamId,
				taskId,
				memberId: agentId,
			},
			await mintTestWakeup(agentId, teamId),
		);

		await db.query(
			`UPDATE heartbeat_runs
			 SET status = 'succeeded'::heartbeat_run_status, finished_at = now(), exit_code = 0
			 WHERE id = $1`,
			[newRunId],
		);

		const after = await db.query<{ n: number }>(
			'SELECT COUNT(*)::int AS n FROM task_comments WHERE task_id = $1',
			[taskId],
		);
		expect(after.rows[0].n).toBe(before.rows[0].n + 1);
	});
});

describe('task status auto-transition on run start', () => {
	async function createTask(opts?: { assigneeId?: string; status?: string }): Promise<string> {
		const res = await app.request(`/api/teams/${teamId}/tasks`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				project_id: projectId,
				title: 'Auto-transition fixture',
				assignee_id: opts?.assigneeId ?? agentId,
			}),
		});
		const id = (await res.json()).data.id as string;
		if (opts?.status && opts.status !== 'backlog') {
			await db.query(`UPDATE tasks SET status = $1::task_status WHERE id = $2`, [opts.status, id]);
		}
		return id;
	}

	function buildTask(localTaskId: string, overrides: Record<string, unknown> = {}) {
		return {
			id: localTaskId,
			identifier: 'RT-X',
			title: 'Auto-transition',
			description: '',
			status: 'backlog',
			priority: 'medium',
			project_id: projectId,
			rules: null,
			assignee_id: agentId,
			...overrides,
		};
	}

	const agent: AgentInfo = { id: '', title: 'Test Runner', team_id: '' };

	beforeAll(() => {
		agent.id = agentId;
		agent.team_id = teamId;
	});

	it('flips backlog → in_progress when the running agent is the assignee', async () => {
		const localTaskId = await createTask();
		const task = buildTask(localTaskId);

		await createHeartbeatRun(
			db,
			agent,
			task,
			{
				teamId,
				taskId: localTaskId,
				memberId: agentId,
			},
			await mintTestWakeup(agentId, teamId),
		);

		const row = await db.query<{ status: string }>(
			'SELECT status::text AS status FROM tasks WHERE id = $1',
			[localTaskId],
		);
		expect(row.rows[0].status).toBe('in_progress');
		expect(task.status).toBe('in_progress');
	});

	it('does not flip status when the running agent is not the assignee', async () => {
		const otherRes = await app.request(`/api/teams/${teamId}/agents`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ title: 'Other Runner' }),
		});
		const otherAgentId = (await otherRes.json()).data.id as string;
		const localTaskId = await createTask({ assigneeId: otherAgentId });
		const task = buildTask(localTaskId, { assignee_id: otherAgentId });

		await createHeartbeatRun(
			db,
			agent,
			task,
			{
				teamId,
				taskId: localTaskId,
				memberId: agentId,
			},
			await mintTestWakeup(agentId, teamId),
		);

		const row = await db.query<{ status: string }>(
			'SELECT status::text AS status FROM tasks WHERE id = $1',
			[localTaskId],
		);
		expect(row.rows[0].status).toBe('backlog');
	});

	it('does not flip status when the task is in a non-backlog status', async () => {
		const localTaskId = await createTask({ status: 'blocked' });
		const task = buildTask(localTaskId, { status: 'blocked' });

		await createHeartbeatRun(
			db,
			agent,
			task,
			{
				teamId,
				taskId: localTaskId,
				memberId: agentId,
			},
			await mintTestWakeup(agentId, teamId),
		);

		const row = await db.query<{ status: string }>(
			'SELECT status::text AS status FROM tasks WHERE id = $1',
			[localTaskId],
		);
		expect(row.rows[0].status).toBe('blocked');
		expect(task.status).toBe('blocked');
	});

	it('is idempotent across repeated runs on the same backlog task', async () => {
		const localTaskId = await createTask();
		const broadcast: HeartbeatRunBroadcast = {
			teamId,
			taskId: localTaskId,
			memberId: agentId,
		};

		const run1 = await createHeartbeatRun(
			db,
			agent,
			buildTask(localTaskId),
			broadcast,
			await mintTestWakeup(agentId, teamId),
		);
		const run2 = await createHeartbeatRun(
			db,
			agent,
			buildTask(localTaskId),
			broadcast,
			await mintTestWakeup(agentId, teamId),
		);

		expect(run1).toBeTruthy();
		expect(run2).toBeTruthy();
		expect(run1).not.toBe(run2);

		const row = await db.query<{ status: string }>(
			'SELECT status::text AS status FROM tasks WHERE id = $1',
			[localTaskId],
		);
		expect(row.rows[0].status).toBe('in_progress');
	});
});

describe('created_tasks tracking', () => {
	it('stamps created_by_run_id when an agent calls create_task and returns it on the run', async () => {
		const { token: agentToken, runId } = await mintAgentToken(
			db,
			masterKeyManager,
			agentId,
			teamId,
			taskId,
		);

		const mcpRes = await app.request('/mcp', {
			method: 'POST',
			headers: { ...authHeader(agentToken), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				jsonrpc: '2.0',
				method: 'tools/call',
				params: {
					name: 'create_task',
					arguments: {
						team_id: teamId,
						project_id: projectId,
						title: 'Spawned Task',
						description: 'Created by agent during run',
						assignee_id: agentId,
					},
				},
				id: 1,
			}),
		});
		expect(mcpRes.status).toBe(200);
		const mcpBody = (await mcpRes.json()) as {
			result: { content: Array<{ type: string; text: string }> };
		};
		const created = JSON.parse(mcpBody.result.content[0].text) as {
			id: string;
			identifier: string;
		};

		const dbRow = await db.query<{ created_by_run_id: string | null }>(
			'SELECT created_by_run_id FROM tasks WHERE id = $1',
			[created.id],
		);
		expect(dbRow.rows[0].created_by_run_id).toBe(runId);

		const runRes = await app.request(
			`/api/teams/${teamId}/agents/${agentId}/heartbeat-runs/${runId}`,
			{ headers: authHeader(token) },
		);
		expect(runRes.status).toBe(200);
		const runBody = await runRes.json();
		const createdTasks = runBody.data.created_tasks as Array<{
			id: string;
			identifier: string;
			title: string;
			project_slug: string;
		}>;
		expect(createdTasks).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					id: created.id,
					identifier: created.identifier,
					title: 'Spawned Task',
					project_slug: expect.any(String),
				}),
			]),
		);
		const spawned = createdTasks.find((ci) => ci.id === created.id);
		expect(spawned?.project_slug).toBeTruthy();
		expect(runBody.data.project_slug).toBeTruthy();
	});

	it('returns empty created_tasks when the run has created none', async () => {
		const result = await db.query<{ id: string }>(
			`INSERT INTO heartbeat_runs (member_id, team_id, task_id, status)
			 VALUES ($1, $2, $3, 'running'::heartbeat_run_status)
			 RETURNING id`,
			[agentId, teamId, taskId],
		);
		const emptyRunId = result.rows[0].id;

		const res = await app.request(
			`/api/teams/${teamId}/agents/${agentId}/heartbeat-runs/${emptyRunId}`,
			{ headers: authHeader(token) },
		);
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.data.created_tasks).toEqual([]);
		expect(body.data.created_docs).toEqual([]);
		expect(body.data.created_skills).toEqual([]);
		expect(body.data.proposed_skills).toEqual([]);
	});

	it('lists project docs and skills the agent produced during the run', async () => {
		const { token: agentToken, runId } = await mintAgentToken(
			db,
			masterKeyManager,
			agentId,
			teamId,
			taskId,
		);
		// The run window opens when the run starts; docs/skills/approvals are
		// attributed by the agent within [started_at, finished_at].
		await db.query(
			`UPDATE heartbeat_runs SET started_at = now() - interval '1 minute' WHERE id = $1`,
			[runId],
		);

		const callMcp = async (name: string, args: Record<string, unknown>) => {
			const res = await app.request('/mcp', {
				method: 'POST',
				headers: { ...authHeader(agentToken), 'Content-Type': 'application/json' },
				body: JSON.stringify({
					jsonrpc: '2.0',
					method: 'tools/call',
					params: { name, arguments: args },
					id: Math.floor(Math.random() * 1e6),
				}),
			});
			expect(res.status).toBe(200);
		};

		await callMcp('write_project_doc', {
			team_id: teamId,
			project_id: projectId,
			filename: 'spec.md',
			content: '# Spec\n\nDetails.',
		});
		await callMcp('create_skill', {
			team_id: teamId,
			name: 'Deploy Flow',
			slug: 'deploy-flow',
			content: '# Deploy Flow\n\nHow to deploy.',
		});
		await callMcp('propose_skill', {
			team_id: teamId,
			skill_name: 'Linear Triage',
			skill_slug: 'linear-triage',
			content: '# Linear Triage',
			reason: 'Reusable triage steps',
		});

		const res = await app.request(
			`/api/teams/${teamId}/agents/${agentId}/heartbeat-runs/${runId}`,
			{ headers: authHeader(token) },
		);
		expect(res.status).toBe(200);
		const body = await res.json();

		const docFilenames = (body.data.created_docs as Array<{ filename: string }>).map(
			(d) => d.filename,
		);
		expect(docFilenames).toContain('spec.md');

		const skillSlugs = (body.data.created_skills as Array<{ name: string; slug: string }>).map(
			(s) => s.slug,
		);
		expect(skillSlugs).toContain('deploy-flow');

		const proposedSlugs = (body.data.proposed_skills as Array<{ name: string; slug: string }>).map(
			(s) => s.slug,
		);
		expect(proposedSlugs).toContain('linear-triage');
	});

	it('leaves created_by_run_id null when a board user creates an task via MCP', async () => {
		const mcpRes = await app.request('/mcp', {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				jsonrpc: '2.0',
				method: 'tools/call',
				params: {
					name: 'create_task',
					arguments: {
						team_id: teamId,
						project_id: projectId,
						title: 'Board-created Task',
						assignee_id: agentId,
					},
				},
				id: 2,
			}),
		});
		const mcpBody = (await mcpRes.json()) as {
			result: { content: Array<{ type: string; text: string }> };
		};
		const created = JSON.parse(mcpBody.result.content[0].text) as { id: string };

		const row = await db.query<{ created_by_run_id: string | null }>(
			'SELECT created_by_run_id FROM tasks WHERE id = $1',
			[created.id],
		);
		expect(row.rows[0].created_by_run_id).toBeNull();
	});
});
