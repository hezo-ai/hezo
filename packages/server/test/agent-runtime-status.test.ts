import type { PGlite } from '@electric-sql/pglite';
import { AgentRuntimeStatus, HeartbeatRunStatus } from '@hezo/shared';
import type { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Env } from '../src/lib/types';
import { setAgentIdleIfNoActiveRuns } from '../src/services/agent-runtime-status';
import { safeClose } from './helpers';
import { authHeader, createTestApp } from './helpers/app';

let db: PGlite;
let app: Hono<Env>;
let token: string;
let teamId: string;
let agentId: string;

beforeAll(async () => {
	const ctx = await createTestApp();
	db = ctx.db;
	app = ctx.app;
	token = ctx.token;

	const typesRes = await app.request('/api/team-templates', { headers: authHeader(token) });
	const teamTemplateId = (await typesRes.json()).data.find((t: any) => t.name === 'Startup').id;

	const teamRes = await app.request('/api/teams', {
		method: 'POST',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify({ name: 'Runtime Status Test', template_id: teamTemplateId }),
	});
	teamId = (await teamRes.json()).data.id;

	const agentsRes = await app.request(`/api/teams/${teamId}/agents`, {
		headers: authHeader(token),
	});
	agentId = (await agentsRes.json()).data[0].id;
});

afterAll(async () => {
	await safeClose(db);
});

beforeEach(async () => {
	await db.query('DELETE FROM heartbeat_runs WHERE team_id = $1', [teamId]);
	await db.query(
		`UPDATE member_agents SET runtime_status = $1::agent_runtime_status WHERE id = $2`,
		[AgentRuntimeStatus.Active, agentId],
	);
});

async function insertRun(status: HeartbeatRunStatus): Promise<string> {
	const r = await db.query<{ id: string }>(
		`INSERT INTO heartbeat_runs (team_id, member_id, status, started_at)
		 VALUES ($1, $2, $3::heartbeat_run_status, now())
		 RETURNING id`,
		[teamId, agentId, status],
	);
	return r.rows[0].id;
}

async function getStatus(): Promise<string> {
	const r = await db.query<{ runtime_status: string }>(
		'SELECT runtime_status FROM member_agents WHERE id = $1',
		[agentId],
	);
	return r.rows[0].runtime_status;
}

describe('setAgentIdleIfNoActiveRuns', () => {
	it('flips active → idle when no in-flight runs remain', async () => {
		const broadcasts: Array<{ table: string; payload: unknown }> = [];
		const wsManager = {
			broadcast: (_room: string, msg: { table: string; payload: unknown }) => {
				broadcasts.push({ table: msg.table, payload: msg.payload });
			},
		} as any;

		const transitioned = await setAgentIdleIfNoActiveRuns(
			db,
			agentId,
			teamId,
			undefined,
			wsManager,
		);

		expect(transitioned).toBe(true);
		expect(await getStatus()).toBe(AgentRuntimeStatus.Idle);
		expect(broadcasts.filter((b) => b.table === 'member_agents').length).toBe(1);
	});

	it('keeps agent active when another run is still running', async () => {
		const otherRunId = await insertRun(HeartbeatRunStatus.Running);

		const broadcasts: Array<{ table: string }> = [];
		const wsManager = {
			broadcast: (_room: string, msg: { table: string }) => {
				broadcasts.push({ table: msg.table });
			},
		} as any;

		const transitioned = await setAgentIdleIfNoActiveRuns(
			db,
			agentId,
			teamId,
			undefined,
			wsManager,
		);

		expect(transitioned).toBe(false);
		expect(await getStatus()).toBe(AgentRuntimeStatus.Active);
		expect(broadcasts.length).toBe(0);

		await db.query('DELETE FROM heartbeat_runs WHERE id = $1', [otherRunId]);
	});

	it('excludes the just-finished run when checking for remaining in-flight runs', async () => {
		const justFinishedId = await insertRun(HeartbeatRunStatus.Running);

		const transitioned = await setAgentIdleIfNoActiveRuns(
			db,
			agentId,
			teamId,
			justFinishedId,
			undefined,
		);

		expect(transitioned).toBe(true);
		expect(await getStatus()).toBe(AgentRuntimeStatus.Idle);
	});

	it('treats queued runs as in-flight (does not flip to idle)', async () => {
		await insertRun(HeartbeatRunStatus.Queued);

		const transitioned = await setAgentIdleIfNoActiveRuns(
			db,
			agentId,
			teamId,
			undefined,
			undefined,
		);

		expect(transitioned).toBe(false);
		expect(await getStatus()).toBe(AgentRuntimeStatus.Active);
	});

	it('preserves paused status', async () => {
		await db.query(
			`UPDATE member_agents SET runtime_status = $1::agent_runtime_status WHERE id = $2`,
			[AgentRuntimeStatus.Paused, agentId],
		);

		const broadcasts: Array<{ table: string }> = [];
		const wsManager = {
			broadcast: (_room: string, msg: { table: string }) => {
				broadcasts.push({ table: msg.table });
			},
		} as any;

		const transitioned = await setAgentIdleIfNoActiveRuns(
			db,
			agentId,
			teamId,
			undefined,
			wsManager,
		);

		expect(transitioned).toBe(false);
		expect(await getStatus()).toBe(AgentRuntimeStatus.Paused);
		expect(broadcasts.length).toBe(0);
	});

	it('is a no-op when agent is already idle (no spurious broadcast)', async () => {
		await db.query(
			`UPDATE member_agents SET runtime_status = $1::agent_runtime_status WHERE id = $2`,
			[AgentRuntimeStatus.Idle, agentId],
		);

		const broadcasts: Array<{ table: string }> = [];
		const wsManager = {
			broadcast: (_room: string, msg: { table: string }) => {
				broadcasts.push({ table: msg.table });
			},
		} as any;

		const transitioned = await setAgentIdleIfNoActiveRuns(
			db,
			agentId,
			teamId,
			undefined,
			wsManager,
		);

		expect(transitioned).toBe(false);
		expect(broadcasts.length).toBe(0);
	});

	it('advances last_heartbeat_at when transitioning to idle', async () => {
		await db.query(
			`UPDATE member_agents SET last_heartbeat_at = now() - interval '2 hours' WHERE id = $1`,
			[agentId],
		);

		const before = await db.query<{ last_heartbeat_at: string }>(
			'SELECT last_heartbeat_at FROM member_agents WHERE id = $1',
			[agentId],
		);

		await setAgentIdleIfNoActiveRuns(db, agentId, teamId, undefined, undefined);

		const after = await db.query<{ last_heartbeat_at: string }>(
			'SELECT last_heartbeat_at FROM member_agents WHERE id = $1',
			[agentId],
		);

		expect(new Date(after.rows[0].last_heartbeat_at).getTime()).toBeGreaterThan(
			new Date(before.rows[0].last_heartbeat_at).getTime(),
		);
	});

	it('advances last_heartbeat_at even when runtime_status is not active', async () => {
		await db.query(
			`UPDATE member_agents
			 SET runtime_status = $1::agent_runtime_status,
			     last_heartbeat_at = now() - interval '2 hours'
			 WHERE id = $2`,
			[AgentRuntimeStatus.Idle, agentId],
		);

		const before = await db.query<{ last_heartbeat_at: string }>(
			'SELECT last_heartbeat_at FROM member_agents WHERE id = $1',
			[agentId],
		);

		const transitioned = await setAgentIdleIfNoActiveRuns(
			db,
			agentId,
			teamId,
			undefined,
			undefined,
		);

		const after = await db.query<{ last_heartbeat_at: string }>(
			'SELECT last_heartbeat_at FROM member_agents WHERE id = $1',
			[agentId],
		);

		expect(transitioned).toBe(false);
		expect(new Date(after.rows[0].last_heartbeat_at).getTime()).toBeGreaterThan(
			new Date(before.rows[0].last_heartbeat_at).getTime(),
		);
	});

	it('does not advance last_heartbeat_at when other runs are still in-flight', async () => {
		await db.query(
			`UPDATE member_agents SET last_heartbeat_at = now() - interval '2 hours' WHERE id = $1`,
			[agentId],
		);
		const otherRunId = await insertRun(HeartbeatRunStatus.Running);

		const before = await db.query<{ last_heartbeat_at: string }>(
			'SELECT last_heartbeat_at FROM member_agents WHERE id = $1',
			[agentId],
		);

		await setAgentIdleIfNoActiveRuns(db, agentId, teamId, undefined, undefined);

		const after = await db.query<{ last_heartbeat_at: string }>(
			'SELECT last_heartbeat_at FROM member_agents WHERE id = $1',
			[agentId],
		);

		expect(new Date(after.rows[0].last_heartbeat_at).getTime()).toBe(
			new Date(before.rows[0].last_heartbeat_at).getTime(),
		);

		await db.query('DELETE FROM heartbeat_runs WHERE id = $1', [otherRunId]);
	});
});
