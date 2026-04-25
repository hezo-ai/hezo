import type { PGlite } from '@electric-sql/pglite';
import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MasterKeyManager } from '../../crypto/master-key';
import type { Env } from '../../lib/types';
import {
	type AgentInfo,
	createHeartbeatRun,
	type HeartbeatRunBroadcast,
} from '../../services/agent-runner';
import { safeClose } from '../helpers';
import { authHeader, createTestApp, mintAgentToken } from '../helpers/app';

let app: Hono<Env>;
let db: PGlite;
let token: string;
let masterKeyManager: MasterKeyManager;
let companyId: string;
let agentId: string;
let projectId: string;
let issueId: string;

beforeAll(async () => {
	const ctx = await createTestApp();
	app = ctx.app;
	db = ctx.db;
	token = ctx.token;
	masterKeyManager = ctx.masterKeyManager;

	const companyRes = await app.request('/api/companies', {
		method: 'POST',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify({ name: 'Run Test Co' }),
	});
	companyId = (await companyRes.json()).data.id;

	const projectRes = await app.request(`/api/companies/${companyId}/projects`, {
		method: 'POST',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify({ name: 'Main', description: 'Test project.' }),
	});
	projectId = (await projectRes.json()).data.id;

	const agentRes = await app.request(`/api/companies/${companyId}/agents`, {
		method: 'POST',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify({ title: 'Test Runner' }),
	});
	agentId = (await agentRes.json()).data.id;

	const issueRes = await app.request(`/api/companies/${companyId}/issues`, {
		method: 'POST',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify({
			project_id: projectId,
			title: 'Test Issue',
			assignee_id: agentId,
		}),
	});
	issueId = (await issueRes.json()).data.id;
});

afterAll(async () => {
	await safeClose(db);
});

describe('heartbeat-runs API', () => {
	let runId: string;

	it('stores issue_id on heartbeat_runs', async () => {
		const result = await db.query<{ id: string }>(
			`INSERT INTO heartbeat_runs (member_id, company_id, issue_id, status)
			 VALUES ($1, $2, $3, 'running'::heartbeat_run_status)
			 RETURNING id`,
			[agentId, companyId, issueId],
		);
		runId = result.rows[0].id;
		expect(runId).toBeTruthy();

		const verify = await db.query<{ issue_id: string }>(
			'SELECT issue_id FROM heartbeat_runs WHERE id = $1',
			[runId],
		);
		expect(verify.rows[0].issue_id).toBe(issueId);
	});

	it('lists runs with issue info', async () => {
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

		const res = await app.request(`/api/companies/${companyId}/agents/${agentId}/heartbeat-runs`, {
			headers: authHeader(token),
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.data.length).toBeGreaterThanOrEqual(1);

		const run = body.data.find((r: Record<string, unknown>) => r.id === runId);
		expect(run).toBeTruthy();
		expect(run.issue_id).toBe(issueId);
		expect(run.issue_identifier).toBeTruthy();
		expect(run.issue_title).toBe('Test Issue');
	});

	it('gets a single run by id with issue info', async () => {
		const res = await app.request(
			`/api/companies/${companyId}/agents/${agentId}/heartbeat-runs/${runId}`,
			{ headers: authHeader(token) },
		);
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.data.id).toBe(runId);
		expect(body.data.issue_title).toBe('Test Issue');
		expect(body.data.status).toBe('succeeded');
		expect(body.data.log_text).toBe('test output');
		expect(body.data.invocation_command).toContain('$ claude --mcp-config');
		expect(body.data.working_dir).toBe('/worktrees/RT-1/main');
	});

	it('returns 404 for nonexistent run', async () => {
		const fakeId = '00000000-0000-0000-0000-000000000000';
		const res = await app.request(
			`/api/companies/${companyId}/agents/${agentId}/heartbeat-runs/${fakeId}`,
			{ headers: authHeader(token) },
		);
		expect(res.status).toBe(404);
	});

	it('allows null issue_id on heartbeat_runs', async () => {
		const result = await db.query<{ id: string }>(
			`INSERT INTO heartbeat_runs (member_id, company_id, status)
			 VALUES ($1, $2, 'running'::heartbeat_run_status)
			 RETURNING id`,
			[agentId, companyId],
		);
		expect(result.rows[0].id).toBeTruthy();

		const verify = await db.query<{ issue_id: string | null }>(
			'SELECT issue_id FROM heartbeat_runs WHERE id = $1',
			[result.rows[0].id],
		);
		expect(verify.rows[0].issue_id).toBeNull();
	});
});

describe('run comments', () => {
	it('createHeartbeatRun inserts a run-type comment linked to the run', async () => {
		const agent: AgentInfo = {
			id: agentId,
			title: 'Test Runner',
			company_id: companyId,
		};
		const issue = {
			id: issueId,
			identifier: 'RT-1',
			title: 'Test Issue',
			description: '',
			status: 'backlog',
			priority: 'medium',
			project_id: projectId,
			rules: null,
		};
		const broadcast: HeartbeatRunBroadcast = {
			companyId,
			issueId,
			memberId: agentId,
		};

		const runId = await createHeartbeatRun(db, agent, issue, broadcast);
		expect(runId).toBeTruthy();

		const runRow = await db.query<{ id: string; status: string }>(
			'SELECT id, status FROM heartbeat_runs WHERE id = $1',
			[runId],
		);
		expect(runRow.rows[0].status).toBe('running');

		const comments = await db.query<{
			id: string;
			content_type: string;
			content: Record<string, unknown>;
			author_member_id: string | null;
		}>(
			`SELECT id, content_type, content, author_member_id
			 FROM issue_comments
			 WHERE issue_id = $1 AND content_type = 'run'::comment_content_type
			   AND content->>'run_id' = $2`,
			[issueId, runId],
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
			company_id: companyId,
		};
		const issue = {
			id: issueId,
			identifier: 'RT-1',
			title: 'Test Issue',
			description: '',
			status: 'backlog',
			priority: 'medium',
			project_id: projectId,
			rules: null,
		};
		const before = await db.query<{ n: number }>(
			'SELECT COUNT(*)::int AS n FROM issue_comments WHERE issue_id = $1',
			[issueId],
		);

		const newRunId = await createHeartbeatRun(db, agent, issue, {
			companyId,
			issueId,
			memberId: agentId,
		});

		await db.query(
			`UPDATE heartbeat_runs
			 SET status = 'succeeded'::heartbeat_run_status, finished_at = now(), exit_code = 0
			 WHERE id = $1`,
			[newRunId],
		);

		const after = await db.query<{ n: number }>(
			'SELECT COUNT(*)::int AS n FROM issue_comments WHERE issue_id = $1',
			[issueId],
		);
		expect(after.rows[0].n).toBe(before.rows[0].n + 1);
	});
});

describe('issue status auto-transition on run start', () => {
	async function createIssue(opts?: { assigneeId?: string; status?: string }): Promise<string> {
		const res = await app.request(`/api/companies/${companyId}/issues`, {
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
			await db.query(`UPDATE issues SET status = $1::issue_status WHERE id = $2`, [
				opts.status,
				id,
			]);
		}
		return id;
	}

	function buildIssue(localIssueId: string, overrides: Record<string, unknown> = {}) {
		return {
			id: localIssueId,
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

	const agent: AgentInfo = { id: '', title: 'Test Runner', company_id: '' };

	beforeAll(() => {
		agent.id = agentId;
		agent.company_id = companyId;
	});

	it('flips backlog → in_progress when the running agent is the assignee', async () => {
		const localIssueId = await createIssue();
		const issue = buildIssue(localIssueId);

		await createHeartbeatRun(db, agent, issue, {
			companyId,
			issueId: localIssueId,
			memberId: agentId,
		});

		const row = await db.query<{ status: string }>(
			'SELECT status::text AS status FROM issues WHERE id = $1',
			[localIssueId],
		);
		expect(row.rows[0].status).toBe('in_progress');
		expect(issue.status).toBe('in_progress');
	});

	it('does not flip status when the running agent is not the assignee', async () => {
		const otherRes = await app.request(`/api/companies/${companyId}/agents`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ title: 'Other Runner' }),
		});
		const otherAgentId = (await otherRes.json()).data.id as string;
		const localIssueId = await createIssue({ assigneeId: otherAgentId });
		const issue = buildIssue(localIssueId, { assignee_id: otherAgentId });

		await createHeartbeatRun(db, agent, issue, {
			companyId,
			issueId: localIssueId,
			memberId: agentId,
		});

		const row = await db.query<{ status: string }>(
			'SELECT status::text AS status FROM issues WHERE id = $1',
			[localIssueId],
		);
		expect(row.rows[0].status).toBe('backlog');
	});

	it('does not flip status when the issue is in a non-backlog status', async () => {
		const localIssueId = await createIssue({ status: 'blocked' });
		const issue = buildIssue(localIssueId, { status: 'blocked' });

		await createHeartbeatRun(db, agent, issue, {
			companyId,
			issueId: localIssueId,
			memberId: agentId,
		});

		const row = await db.query<{ status: string }>(
			'SELECT status::text AS status FROM issues WHERE id = $1',
			[localIssueId],
		);
		expect(row.rows[0].status).toBe('blocked');
		expect(issue.status).toBe('blocked');
	});

	it('is idempotent across repeated runs on the same backlog issue', async () => {
		const localIssueId = await createIssue();
		const broadcast: HeartbeatRunBroadcast = {
			companyId,
			issueId: localIssueId,
			memberId: agentId,
		};

		const run1 = await createHeartbeatRun(db, agent, buildIssue(localIssueId), broadcast);
		const run2 = await createHeartbeatRun(db, agent, buildIssue(localIssueId), broadcast);

		expect(run1).toBeTruthy();
		expect(run2).toBeTruthy();
		expect(run1).not.toBe(run2);

		const row = await db.query<{ status: string }>(
			'SELECT status::text AS status FROM issues WHERE id = $1',
			[localIssueId],
		);
		expect(row.rows[0].status).toBe('in_progress');
	});
});

describe('created_issues tracking', () => {
	it('stamps created_by_run_id when an agent calls create_issue and returns it on the run', async () => {
		const { token: agentToken, runId } = await mintAgentToken(
			db,
			masterKeyManager,
			agentId,
			companyId,
			issueId,
		);

		const mcpRes = await app.request('/mcp', {
			method: 'POST',
			headers: { ...authHeader(agentToken), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				jsonrpc: '2.0',
				method: 'tools/call',
				params: {
					name: 'create_issue',
					arguments: {
						company_id: companyId,
						project_id: projectId,
						title: 'Spawned Issue',
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
			'SELECT created_by_run_id FROM issues WHERE id = $1',
			[created.id],
		);
		expect(dbRow.rows[0].created_by_run_id).toBe(runId);

		const runRes = await app.request(
			`/api/companies/${companyId}/agents/${agentId}/heartbeat-runs/${runId}`,
			{ headers: authHeader(token) },
		);
		expect(runRes.status).toBe(200);
		const runBody = await runRes.json();
		const createdIssues = runBody.data.created_issues as Array<{
			id: string;
			identifier: string;
			title: string;
			project_slug: string;
		}>;
		expect(createdIssues).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					id: created.id,
					identifier: created.identifier,
					title: 'Spawned Issue',
					project_slug: expect.any(String),
				}),
			]),
		);
		const spawned = createdIssues.find((ci) => ci.id === created.id);
		expect(spawned?.project_slug).toBeTruthy();
		expect(runBody.data.project_slug).toBeTruthy();
	});

	it('returns empty created_issues when the run has created none', async () => {
		const result = await db.query<{ id: string }>(
			`INSERT INTO heartbeat_runs (member_id, company_id, issue_id, status)
			 VALUES ($1, $2, $3, 'running'::heartbeat_run_status)
			 RETURNING id`,
			[agentId, companyId, issueId],
		);
		const emptyRunId = result.rows[0].id;

		const res = await app.request(
			`/api/companies/${companyId}/agents/${agentId}/heartbeat-runs/${emptyRunId}`,
			{ headers: authHeader(token) },
		);
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.data.created_issues).toEqual([]);
	});

	it('leaves created_by_run_id null when a board user creates an issue via MCP', async () => {
		const mcpRes = await app.request('/mcp', {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				jsonrpc: '2.0',
				method: 'tools/call',
				params: {
					name: 'create_issue',
					arguments: {
						company_id: companyId,
						project_id: projectId,
						title: 'Board-created Issue',
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
			'SELECT created_by_run_id FROM issues WHERE id = $1',
			[created.id],
		);
		expect(row.rows[0].created_by_run_id).toBeNull();
	});
});
