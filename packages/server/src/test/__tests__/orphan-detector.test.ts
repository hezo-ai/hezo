import type { PGlite } from '@electric-sql/pglite';
import { ApprovalType, HeartbeatRunStatus, WakeupSource } from '@hezo/shared';
import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Env } from '../../lib/types';
import { detectOrphans } from '../../services/orphan-detector';
import { safeClose } from '../helpers';
import { authHeader, createTestApp } from '../helpers/app';

let db: PGlite;
let app: Hono<Env>;
let token: string;
let companyId: string;
let agentId: string;

beforeAll(async () => {
	const ctx = await createTestApp();
	db = ctx.db;
	app = ctx.app;
	token = ctx.token;

	const typesRes = await app.request('/api/company-types', { headers: authHeader(token) });
	const companyTypeId = (await typesRes.json()).data.find((t: any) => t.name === 'Startup').id;

	const companyRes = await app.request('/api/companies', {
		method: 'POST',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify({
			name: 'Orphan Test Co',
			issue_prefix: 'OTC',
			template_id: companyTypeId,
		}),
	});
	companyId = (await companyRes.json()).data.id;

	const agentsRes = await app.request(`/api/companies/${companyId}/agents`, {
		headers: authHeader(token),
	});
	agentId = (await agentsRes.json()).data[0].id;
});

afterAll(async () => {
	await safeClose(db);
});

async function insertOrphanRun(
	memberId: string,
	coId: string,
	opts: { pid?: number | null; retryCount?: number } = {},
): Promise<string> {
	const { pid = null, retryCount = 0 } = opts;
	const result = await db.query<{ id: string }>(
		`INSERT INTO heartbeat_runs
		   (company_id, member_id, status, started_at, process_pid, process_loss_retry_count)
		 VALUES ($1, $2, $3::heartbeat_run_status, now() - interval '10 minutes', $4, $5)
		 RETURNING id`,
		[coId, memberId, HeartbeatRunStatus.Running, pid, retryCount],
	);
	return result.rows[0].id;
}

async function insertLock(memberId: string, issueId: string): Promise<string> {
	const result = await db.query<{ id: string }>(
		`INSERT INTO execution_locks (issue_id, member_id) VALUES ($1, $2) RETURNING id`,
		[issueId, memberId],
	);
	return result.rows[0].id;
}

async function createIssue(coId: string): Promise<string> {
	const projectRes = await app.request(`/api/companies/${coId}/projects`, {
		method: 'POST',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify({ name: 'Orphan Project', description: 'Test project.' }),
	});
	const projectId = (await projectRes.json()).data.id;

	const issueRes = await app.request(`/api/companies/${coId}/issues`, {
		method: 'POST',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify({ project_id: projectId, title: 'Orphan Issue', assignee_id: agentId }),
	});
	return (await issueRes.json()).data.id;
}

describe('detectOrphans', () => {
	it('returns 0 when no orphaned runs exist', async () => {
		// Clean state — no running heartbeat runs
		await db.query(
			`DELETE FROM heartbeat_runs WHERE company_id = $1 AND status = $2::heartbeat_run_status`,
			[companyId, HeartbeatRunStatus.Running],
		);

		const count = await detectOrphans(db, new Set());
		expect(count).toBe(0);
	});

	it('detects orphaned heartbeat runs and marks them failed', async () => {
		const runId = await insertOrphanRun(agentId, companyId);

		const count = await detectOrphans(db, new Set());
		expect(count).toBeGreaterThanOrEqual(1);

		const run = await db.query<{ status: string; error: string; finished_at: string | null }>(
			'SELECT status, error, finished_at FROM heartbeat_runs WHERE id = $1',
			[runId],
		);
		expect(run.rows[0].status).toBe(HeartbeatRunStatus.Failed);
		expect(run.rows[0].error).toContain('Orphaned');
		expect(run.rows[0].finished_at).not.toBeNull();
	});

	it('skips runs whose PID is still in the runningPids set', async () => {
		const activePid = 99999;
		const runId = await insertOrphanRun(agentId, companyId, { pid: activePid });

		const countBefore = await detectOrphans(db, new Set([activePid]));

		const run = await db.query<{ status: string }>(
			'SELECT status FROM heartbeat_runs WHERE id = $1',
			[runId],
		);
		// The run we inserted should still be running (skipped by detector)
		expect(run.rows[0].status).toBe(HeartbeatRunStatus.Running);

		// Clean up
		await db.query('DELETE FROM heartbeat_runs WHERE id = $1', [runId]);
	});

	it('releases execution locks for orphaned agents', async () => {
		const issueId = await createIssue(companyId);
		const lockId = await insertLock(agentId, issueId);
		await insertOrphanRun(agentId, companyId);

		await detectOrphans(db, new Set());

		const lock = await db.query<{ released_at: string | null }>(
			'SELECT released_at FROM execution_locks WHERE id = $1',
			[lockId],
		);
		expect(lock.rows[0].released_at).not.toBeNull();
	});

	it('creates a retry wakeup when retry count < 3', async () => {
		await db.query('DELETE FROM agent_wakeup_requests WHERE member_id = $1', [agentId]);

		await insertOrphanRun(agentId, companyId, { retryCount: 1 });

		await detectOrphans(db, new Set());

		const wakeups = await db.query<{ source: string; payload: unknown }>(
			`SELECT source, payload FROM agent_wakeup_requests
			 WHERE member_id = $1 AND source = $2
			 ORDER BY created_at DESC
			 LIMIT 1`,
			[agentId, WakeupSource.Timer],
		);
		expect(wakeups.rows.length).toBeGreaterThanOrEqual(1);
		const payload = wakeups.rows[0].payload as Record<string, unknown>;
		expect(payload.reason).toBe('orphan_retry');
	});

	it('creates an approval request when retry count >= 3 (MAX_RETRIES)', async () => {
		await db.query('DELETE FROM approvals WHERE company_id = $1', [companyId]);

		// retry_count = 2, so process_loss_retry_count + 1 = 3 which is not < MAX_RETRIES (3)
		await insertOrphanRun(agentId, companyId, { retryCount: 2 });

		await detectOrphans(db, new Set());

		const approvals = await db.query<{ type: string; payload: unknown }>(
			`SELECT type, payload FROM approvals
			 WHERE company_id = $1 AND type = $2::approval_type
			 ORDER BY created_at DESC
			 LIMIT 1`,
			[companyId, ApprovalType.Strategy],
		);
		expect(approvals.rows.length).toBeGreaterThanOrEqual(1);
		const payload = approvals.rows[0].payload as Record<string, unknown>;
		expect(payload.type).toBe('agent_error');
		expect(payload.member_id).toBe(agentId);
	});

	it('returns correct orphan count for multiple orphans', async () => {
		// Remove all existing running runs
		await db.query(
			`DELETE FROM heartbeat_runs WHERE company_id = $1 AND status = $2::heartbeat_run_status`,
			[companyId, HeartbeatRunStatus.Running],
		);

		// Insert 3 orphaned runs (no PIDs)
		await insertOrphanRun(agentId, companyId);
		await insertOrphanRun(agentId, companyId);
		await insertOrphanRun(agentId, companyId);

		const count = await detectOrphans(db, new Set());
		expect(count).toBe(3);
	});
});
