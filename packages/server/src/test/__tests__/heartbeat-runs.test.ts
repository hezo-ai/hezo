import type { PGlite } from '@electric-sql/pglite';
import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Env } from '../../lib/types';
import { safeClose } from '../helpers';
import { authHeader, createTestApp } from '../helpers/app';

let app: Hono<Env>;
let db: PGlite;
let token: string;
let companyId: string;
let agentId: string;
let projectId: string;
let issueId: string;

beforeAll(async () => {
	const ctx = await createTestApp();
	app = ctx.app;
	db = ctx.db;
	token = ctx.token;

	const companyRes = await app.request('/api/companies', {
		method: 'POST',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify({ name: 'Run Test Co', issue_prefix: 'RT' }),
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

describe('execution comments', () => {
	it('creates an execution-type comment', async () => {
		const runResult = await db.query<{ id: string }>(
			`INSERT INTO heartbeat_runs (member_id, company_id, issue_id, status, started_at, finished_at, exit_code)
			 VALUES ($1, $2, $3, 'succeeded'::heartbeat_run_status, now() - interval '30 seconds', now(), 0)
			 RETURNING id`,
			[agentId, companyId, issueId],
		);
		const heartbeatRunId = runResult.rows[0].id;

		const res = await app.request(`/api/companies/${companyId}/issues/${issueId}/comments`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				content_type: 'execution',
				content: {
					heartbeat_run_id: heartbeatRunId,
					agent_id: agentId,
					agent_title: 'Test Runner',
					status: 'succeeded',
					exit_code: 0,
					duration_ms: 30000,
					stdout_preview: 'did some work',
				},
			}),
		});
		expect(res.status).toBe(201);
		const body = await res.json();
		expect(body.data.content_type).toBe('execution');
		expect(body.data.content.heartbeat_run_id).toBe(heartbeatRunId);
		expect(body.data.content.agent_title).toBe('Test Runner');
	});

	it('execution comments appear in comment list', async () => {
		const res = await app.request(`/api/companies/${companyId}/issues/${issueId}/comments`, {
			headers: authHeader(token),
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		const execComment = body.data.find(
			(c: Record<string, unknown>) => c.content_type === 'execution',
		);
		expect(execComment).toBeTruthy();
		expect((execComment.content as Record<string, unknown>).status).toBe('succeeded');
	});
});
