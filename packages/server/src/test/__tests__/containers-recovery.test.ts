import type { PGlite } from '@electric-sql/pglite';
import {
	AgentRuntimeStatus,
	ContainerStatus,
	HeartbeatRunStatus,
	WakeupStatus,
} from '@hezo/shared';
import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Env } from '../../lib/types';
import {
	type ContainerDeps,
	failProjectRuns,
	requeueContainerKilledRuns,
} from '../../services/containers';
import { LogStreamBroker } from '../../services/log-stream-broker';
import { safeClose } from '../helpers';
import { authHeader, createStubDocker, createTestApp } from '../helpers/app';

let app: Hono<Env>;
let db: PGlite;
let token: string;
let companyId: string;
let projectId: string;
let issueId: string;
let agentId: string;

function buildDeps(): ContainerDeps {
	return {
		db,
		docker: createStubDocker(),
		dataDir: '/tmp/test',
		wsManager: { broadcast: () => {} } as any,
		logs: new LogStreamBroker(),
	};
}

beforeAll(async () => {
	const ctx = await createTestApp();
	app = ctx.app;
	db = ctx.db;
	token = ctx.token;

	const typesRes = await app.request('/api/company-types', { headers: authHeader(token) });
	const typeId = (await typesRes.json()).data.find((t: any) => t.name === 'Startup').id;

	const companyRes = await app.request('/api/companies', {
		method: 'POST',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify({ name: 'Recovery Test Co', template_id: typeId }),
	});
	companyId = (await companyRes.json()).data.id;

	const projectRes = await app.request(`/api/companies/${companyId}/projects`, {
		method: 'POST',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify({ name: 'Recovery Test Project', description: 'Test project.' }),
	});
	projectId = (await projectRes.json()).data.id;

	const agentsRes = await app.request(`/api/companies/${companyId}/agents`, {
		headers: authHeader(token),
	});
	agentId = (await agentsRes.json()).data[0].id;

	const issueRes = await app.request(`/api/companies/${companyId}/issues`, {
		method: 'POST',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify({
			project_id: projectId,
			title: 'Recovery Test Issue',
			assignee_id: agentId,
		}),
	});
	issueId = (await issueRes.json()).data.id;
});

afterAll(async () => {
	await safeClose(db);
});

async function clearState(): Promise<void> {
	await db.query('DELETE FROM heartbeat_runs WHERE company_id = $1', [companyId]);
	await db.query('DELETE FROM agent_wakeup_requests WHERE company_id = $1', [companyId]);
	await db.query('UPDATE execution_locks SET released_at = now() WHERE released_at IS NULL');
	await db.query(
		'UPDATE member_agents SET runtime_status = $1::agent_runtime_status WHERE id = $2',
		[AgentRuntimeStatus.Idle, agentId],
	);
}

async function insertRunningRun(): Promise<string> {
	const res = await db.query<{ id: string }>(
		`INSERT INTO heartbeat_runs (company_id, member_id, issue_id, status)
		 VALUES ($1, $2, $3, $4::heartbeat_run_status) RETURNING id`,
		[companyId, agentId, issueId, HeartbeatRunStatus.Running],
	);
	return res.rows[0].id;
}

describe('failProjectRuns', () => {
	it('marks running heartbeat_runs in the project as failed with the given reason', async () => {
		await clearState();
		const runId = await insertRunningRun();
		await db.query(
			'UPDATE member_agents SET runtime_status = $1::agent_runtime_status WHERE id = $2',
			[AgentRuntimeStatus.Active, agentId],
		);

		await failProjectRuns(buildDeps(), projectId, companyId, 'container_error');

		const run = await db.query<{ status: string; error: string; exit_code: number }>(
			'SELECT status, error, exit_code FROM heartbeat_runs WHERE id = $1',
			[runId],
		);
		expect(run.rows[0].status).toBe(HeartbeatRunStatus.Failed);
		expect(run.rows[0].error).toBe('container_error');
		expect(run.rows[0].exit_code).toBe(-1);

		const agent = await db.query<{ runtime_status: string }>(
			'SELECT runtime_status FROM member_agents WHERE id = $1',
			[agentId],
		);
		expect(agent.rows[0].runtime_status).toBe(AgentRuntimeStatus.Idle);
	});

	it('does not touch runs in other projects', async () => {
		await clearState();
		const runId = await insertRunningRun();

		await failProjectRuns(
			buildDeps(),
			'00000000-0000-0000-0000-000000000000',
			companyId,
			'container_error',
		);

		const run = await db.query<{ status: string }>(
			'SELECT status FROM heartbeat_runs WHERE id = $1',
			[runId],
		);
		expect(run.rows[0].status).toBe(HeartbeatRunStatus.Running);
	});

	it('releases execution_locks for the project issues', async () => {
		await clearState();
		await insertRunningRun();
		await db.query('INSERT INTO execution_locks (issue_id, member_id) VALUES ($1, $2)', [
			issueId,
			agentId,
		]);

		await failProjectRuns(buildDeps(), projectId, companyId, 'container_stopped');

		const lock = await db.query<{ released_at: string | null }>(
			'SELECT released_at FROM execution_locks WHERE issue_id = $1 AND member_id = $2',
			[issueId, agentId],
		);
		expect(lock.rows[0].released_at).not.toBeNull();
	});

	it('broadcasts heartbeat_runs and member_agents row changes', async () => {
		await clearState();
		await insertRunningRun();
		await db.query(
			'UPDATE member_agents SET runtime_status = $1::agent_runtime_status WHERE id = $2',
			[AgentRuntimeStatus.Active, agentId],
		);
		const broadcasts: Array<{ table: string }> = [];
		const deps: ContainerDeps = {
			...buildDeps(),
			wsManager: {
				broadcast: (_room: string, msg: { table: string }) => {
					broadcasts.push({ table: msg.table });
				},
			} as any,
		};

		await failProjectRuns(deps, projectId, companyId, 'container_error');

		expect(broadcasts.some((b) => b.table === 'heartbeat_runs')).toBe(true);
		expect(broadcasts.some((b) => b.table === 'member_agents')).toBe(true);
	});
});

describe('requeueContainerKilledRuns', () => {
	it('creates wakeups for runs failed with container_error', async () => {
		await clearState();
		await db.query(
			`INSERT INTO heartbeat_runs (company_id, member_id, issue_id, status, started_at, finished_at, error)
			 VALUES ($1, $2, $3, $4::heartbeat_run_status, now() - interval '5 minutes', now() - interval '4 minutes', 'container_error')`,
			[companyId, agentId, issueId, HeartbeatRunStatus.Failed],
		);

		const count = await requeueContainerKilledRuns(buildDeps(), projectId, companyId);
		expect(count).toBe(1);

		const wakeups = await db.query<{ payload: Record<string, unknown> }>(
			`SELECT payload FROM agent_wakeup_requests
			 WHERE member_id = $1 AND status = $2::wakeup_status
			 ORDER BY created_at DESC LIMIT 1`,
			[agentId, WakeupStatus.Queued],
		);
		expect((wakeups.rows[0]?.payload as Record<string, unknown>)?.reason).toBe(
			'container_recovery',
		);
	});

	it('skips runs failed with container_stopped', async () => {
		await clearState();
		await db.query(
			`INSERT INTO heartbeat_runs (company_id, member_id, issue_id, status, started_at, finished_at, error)
			 VALUES ($1, $2, $3, $4::heartbeat_run_status, now() - interval '5 minutes', now() - interval '4 minutes', 'container_stopped')`,
			[companyId, agentId, issueId, HeartbeatRunStatus.Failed],
		);

		const count = await requeueContainerKilledRuns(buildDeps(), projectId, companyId);
		expect(count).toBe(0);
	});

	it('skips runs that already had a successor run started', async () => {
		await clearState();
		await db.query(
			`INSERT INTO heartbeat_runs (company_id, member_id, issue_id, status, started_at, finished_at, error)
			 VALUES ($1, $2, $3, $4::heartbeat_run_status, now() - interval '10 minutes', now() - interval '9 minutes', 'container_error')`,
			[companyId, agentId, issueId, HeartbeatRunStatus.Failed],
		);
		await db.query(
			`INSERT INTO heartbeat_runs (company_id, member_id, issue_id, status, started_at, finished_at)
			 VALUES ($1, $2, $3, $4::heartbeat_run_status, now() - interval '5 minutes', now() - interval '4 minutes')`,
			[companyId, agentId, issueId, HeartbeatRunStatus.Succeeded],
		);

		const count = await requeueContainerKilledRuns(buildDeps(), projectId, companyId);
		expect(count).toBe(0);
	});
});
