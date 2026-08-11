import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MasterKeyManager } from '../src/crypto/master-key';
import type { Db } from '../src/db/database';
import { appendRunLogChunks } from '../src/db/run-log-chunks';
import type { Env } from '../src/lib/types';
import {
	type AgentInfo,
	createHeartbeatRun,
	type HeartbeatRunBroadcast,
} from '../src/services/agent-runner';
import { safeClose } from './helpers';
import {
	authHeader,
	createTestApp,
	createTestProject,
	createTestTeam,
	mintAgentToken,
} from './helpers/app';

let app: Hono<Env>;
let db: Db;
let token: string;
let masterKeyManager: MasterKeyManager;
let teamId: string;
let agentId: string;
let projectId: string;
let projectSlug: string;
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

	const teamRes = await createTestTeam(db, { name: 'Run Test Co' });
	const team = (await teamRes.json()).data;
	teamId = team.id;

	const projectRes = await createTestProject(db, teamId, {
		name: 'Main',
		description: 'Test project.',
	});
	const projectData = (await projectRes.json()).data;
	projectId = projectData.id;
	projectSlug = projectData.slug;

	const agentRes = await app.request(`/api/projects/${projectSlug}/agents`, {
		method: 'POST',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify({ title: 'Test Runner' }),
	});
	agentId = (await agentRes.json()).data.id;

	const taskRes = await app.request(`/api/projects/${projectSlug}/tasks`, {
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
			     invocation_command = '$ claude --mcp-config {...} -p task',
			     working_dir = '/worktrees/RT-1/main',
			     started_at = now()
			 WHERE id = $1`,
			[runId],
		);
		await appendRunLogChunks(db, runId, 'test output');

		const res = await app.request(`/api/projects/${projectSlug}/agents/${agentId}/heartbeat-runs`, {
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
		// The task's project is surfaced on the run so CEO/Coach pages can show it.
		expect(run.project_slug).toBe(projectSlug);
		expect(run.project_name).toBe('Main');
	});

	it('paginates the runs list with offset + total meta', async () => {
		// A fresh agent so the count is exactly what this test inserts.
		const agentRes = await app.request(`/api/projects/${projectSlug}/agents`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ title: 'Paged Runner' }),
		});
		const pagedAgentId = (await agentRes.json()).data.id as string;

		// Insert 5 runs with strictly increasing started_at so ORDER BY started_at
		// DESC is deterministic (newest = run #5).
		const ids: string[] = [];
		for (let i = 0; i < 5; i++) {
			const r = await db.query<{ id: string }>(
				`INSERT INTO heartbeat_runs (member_id, team_id, status, started_at)
				 VALUES ($1, $2, 'succeeded'::heartbeat_run_status, now() + ($3 || ' seconds')::interval)
				 RETURNING id`,
				[pagedAgentId, teamId, String(i)],
			);
			ids.push(r.rows[0].id);
		}

		const base = `/api/projects/${projectSlug}/agents/${pagedAgentId}/heartbeat-runs`;
		const p1 = await app.request(`${base}?page=1&per_page=2`, { headers: authHeader(token) });
		const b1 = await p1.json();
		expect(b1.meta).toEqual({ page: 1, per_page: 2, total: 5 });
		expect(b1.data).toHaveLength(2);
		// Newest first: run #5 then #4.
		expect(b1.data[0].id).toBe(ids[4]);
		expect(b1.data[1].id).toBe(ids[3]);

		const p3 = await app.request(`${base}?page=3&per_page=2`, { headers: authHeader(token) });
		const b3 = await p3.json();
		expect(b3.meta).toEqual({ page: 3, per_page: 2, total: 5 });
		// Last page holds the single oldest run (#1) — previously unreachable past 50.
		expect(b3.data).toHaveLength(1);
		expect(b3.data[0].id).toBe(ids[0]);
	});

	it('gets a single run by id with task info', async () => {
		const res = await app.request(
			`/api/projects/${projectSlug}/agents/${agentId}/heartbeat-runs/${runId}`,
			{ headers: authHeader(token) },
		);
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.data.id).toBe(runId);
		expect(body.data.task_title).toBe('Test Task');
		expect(body.data.project_slug).toBe(projectSlug);
		expect(body.data.project_name).toBe('Main');
		expect(body.data.status).toBe('succeeded');
		expect(body.data.log_text).toBe('test output');
		expect(body.data.invocation_command).toContain('$ claude --mcp-config');
		expect(body.data.working_dir).toBe('/worktrees/RT-1/main');
	});

	it('returns 404 for nonexistent run', async () => {
		const fakeId = '00000000-0000-0000-0000-000000000000';
		const res = await app.request(
			`/api/projects/${projectSlug}/agents/${agentId}/heartbeat-runs/${fakeId}`,
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
			progress_summary: null,
		};
		const broadcast: HeartbeatRunBroadcast = {
			teamId,
			taskId,
			memberId: agentId,
		};

		const runId = await createHeartbeatRun(
			db,
			agent,
			teamId,
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
		expect(comments.rows[0].content.actor_name).toBeUndefined();
	});

	it('embeds triggeredBy actor into the run comment content', async () => {
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
			progress_summary: null,
		};

		const runId = await createHeartbeatRun(
			db,
			agent,
			teamId,
			task,
			{ teamId, taskId, memberId: agentId },
			await mintTestWakeup(agentId, teamId),
			{ member_id: null, name: 'Admin' },
		);

		const comments = await db.query<{ content: Record<string, unknown> }>(
			`SELECT content FROM task_comments
			 WHERE task_id = $1 AND content_type = 'run'::comment_content_type
			   AND content->>'run_id' = $2`,
			[taskId, runId],
		);
		expect(comments.rows[0].content.actor_name).toBe('Admin');
		expect(comments.rows[0].content.actor_id).toBeNull();
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
			progress_summary: null,
		};
		const before = await db.query<{ n: number }>(
			'SELECT COUNT(*)::int AS n FROM task_comments WHERE task_id = $1',
			[taskId],
		);

		const newRunId = await createHeartbeatRun(
			db,
			agent,
			teamId,
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
		const res = await app.request(`/api/projects/${projectSlug}/tasks`, {
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
			progress_summary: null,
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
			teamId,
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
		const otherRes = await app.request(`/api/projects/${projectSlug}/agents`, {
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
			teamId,
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
			teamId,
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
			teamId,
			buildTask(localTaskId),
			broadcast,
			await mintTestWakeup(agentId, teamId),
		);
		const run2 = await createHeartbeatRun(
			db,
			agent,
			teamId,
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
						project: projectId,
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
			`/api/projects/${projectSlug}/agents/${agentId}/heartbeat-runs/${runId}`,
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
			`/api/projects/${projectSlug}/agents/${agentId}/heartbeat-runs/${emptyRunId}`,
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
			project: projectId,
			filename: 'spec.md',
			content: '# Spec\n\nDetails.',
		});
		await callMcp('create_skill', {
			project: projectId,
			name: 'Deploy Flow',
			slug: 'deploy-flow',
			content: '# Deploy Flow\n\nHow to deploy.',
		});
		// A global skill (scope: 'global') has no owning project — project_slug null.
		await callMcp('create_skill', {
			project: projectId,
			name: 'Global Runbook',
			slug: 'global-runbook',
			content: '# Global Runbook\n\nShared everywhere.',
			scope: 'global',
		});
		await callMcp('propose_skill', {
			project: projectId,
			skill_name: 'Linear Triage',
			skill_slug: 'linear-triage',
			content: '# Linear Triage',
			reason: 'Reusable triage steps',
		});

		const res = await app.request(
			`/api/projects/${projectSlug}/agents/${agentId}/heartbeat-runs/${runId}`,
			{ headers: authHeader(token) },
		);
		expect(res.status).toBe(200);
		const body = await res.json();

		const createdDocs = body.data.created_docs as Array<{
			filename: string;
			project_slug: string;
		}>;
		const specDoc = createdDocs.find((d) => d.filename === 'spec.md');
		expect(specDoc).toBeDefined();
		expect(specDoc?.project_slug).toBe(projectSlug);

		const createdSkills = body.data.created_skills as Array<{
			name: string;
			slug: string;
			created: boolean;
			project_slug: string | null;
		}>;
		const deploySkill = createdSkills.find((s) => s.slug === 'deploy-flow');
		expect(deploySkill).toBeDefined();
		expect(deploySkill?.created).toBe(true);
		// create_skill defaults to project scope, so this skill carries the owning
		// project's slug — the frontend links it to that project's Skills page.
		expect(deploySkill?.project_slug).toBe(projectSlug);
		// A global skill has no owning project — project_slug is null.
		const globalSkill = createdSkills.find((s) => s.slug === 'global-runbook');
		expect(globalSkill).toBeDefined();
		expect(globalSkill?.project_slug).toBeNull();

		const proposedSlugs = (body.data.proposed_skills as Array<{ name: string; slug: string }>).map(
			(s) => s.slug,
		);
		expect(proposedSlugs).toContain('linear-triage');
	});

	it('leaves created_by_run_id null when a the admin creates a task via MCP', async () => {
		const mcpRes = await app.request('/mcp', {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				jsonrpc: '2.0',
				method: 'tools/call',
				params: {
					name: 'create_task',
					arguments: {
						project: projectId,
						title: 'Admin-created Task',
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
