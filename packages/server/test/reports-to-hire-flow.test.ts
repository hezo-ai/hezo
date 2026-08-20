import { CAPTAIN_AGENT_SLUG, DEFAULT_HEARTBEAT_INTERVAL_MIN } from '@hezo/shared';
import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MasterKeyManager } from '../src/crypto/master-key';
import type { Db } from '../src/db/database';
import { assertSubordinateAssignee } from '../src/lib/assignment-hierarchy';
import type { Env } from '../src/lib/types';
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
let projectSlug: string;
let internalProjectId: string;
let captainId: string;
let architectId: string;
let engineerId: string;

async function callTool(agentToken: string, name: string, args: Record<string, unknown>) {
	const res = await app.request('/mcp', {
		method: 'POST',
		headers: { ...authHeader(agentToken), 'Content-Type': 'application/json' },
		body: JSON.stringify({
			jsonrpc: '2.0',
			method: 'tools/call',
			params: { name, arguments: args },
			id: 1,
		}),
	});
	const body = (await res.json()) as { result: { content: Array<{ text: string }> } };
	return JSON.parse(body.result.content[0].text) as Record<string, unknown>;
}

async function captainToken(): Promise<string> {
	const { token: t } = await mintAgentToken(db, masterKeyManager, captainId, teamId, null, {
		projectId: internalProjectId,
	});
	return t;
}

async function approveLatestHire(slug: string): Promise<string> {
	const approval = await db.query<{ id: string }>(
		`SELECT id FROM approvals WHERE team_id = $1 AND type = 'hire' AND payload->>'slug' = $2
		 ORDER BY created_at DESC LIMIT 1`,
		[teamId, slug],
	);
	const res = await app.request(`/api/approvals/${approval.rows[0].id}/resolve`, {
		method: 'POST',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify({ status: 'approved' }),
	});
	expect(res.status).toBe(200);
	const created = await db.query<{ id: string }>(
		`SELECT ma.id FROM member_agents ma JOIN members m ON m.id = ma.id
		 WHERE m.team_id = $1 AND ma.slug = $2`,
		[teamId, slug],
	);
	return created.rows[0].id;
}

beforeAll(async () => {
	const ctx = await createTestApp();
	app = ctx.app;
	db = ctx.db;
	token = ctx.token;
	masterKeyManager = ctx.masterKeyManager;

	const typesRes = await app.request('/api/team-templates', { headers: authHeader(token) });
	const typeId = (await typesRes.json()).data.find(
		(t: Record<string, unknown>) => t.name === 'App Team',
	).id;
	const teamRes = await createTestTeam(db, { name: 'Reports-To Co', template_id: typeId });
	teamId = (await teamRes.json()).data.id;
	const proj = (await (await createTestProject(db, teamId, { name: 'Setup' })).json()).data;
	projectSlug = proj.slug;
	internalProjectId = proj.id;

	const agents = (
		await (
			await app.request(`/api/projects/${projectSlug}/agents`, { headers: authHeader(token) })
		).json()
	).data;
	captainId = agents.find((a: Record<string, unknown>) => a.slug === CAPTAIN_AGENT_SLUG).id;
	architectId = agents.find((a: Record<string, unknown>) => a.slug === 'architect').id;
	engineerId = agents.find((a: Record<string, unknown>) => a.slug === 'engineer').id;
});

afterAll(async () => {
	await safeClose(db);
});

describe('hire flow captures reports_to', () => {
	it('a hire with reports_to materializes a structurally-managed agent', async () => {
		const result = await callTool(await captainToken(), 'create_hire_proposal', {
			heartbeat_interval_min: 720,
			title: 'Data Scientist',
			system_prompt: 'You are the Data Scientist.',
			reports_to: 'architect',
		});
		expect(result.error).toBeUndefined();
		expect((result.payload as Record<string, unknown>).reports_to).toBe('architect');

		const newId = await approveLatestHire('data-scientist');
		const row = await db.query<{ reports_to: string }>(
			'SELECT reports_to FROM member_agents WHERE id = $1',
			[newId],
		);
		expect(row.rows[0].reports_to).toBe(architectId);

		// The manager can now delegate to the new agent; a non-manager cannot.
		expect((await assertSubordinateAssignee(db, architectId, newId)).ok).toBe(true);
		expect((await assertSubordinateAssignee(db, captainId, newId)).ok).toBe(false);
	});

	it('rejects a hire whose reports_to is not an agent on the team', async () => {
		const result = await callTool(await captainToken(), 'create_hire_proposal', {
			heartbeat_interval_min: 720,
			title: 'Lost Soul',
			system_prompt: 'You are the Lost Soul.',
			reports_to: 'no-such-agent',
		});
		expect(result.error).toContain("no agent 'no-such-agent'");
	});

	it('onboard via REST persists reports_to through the approval', async () => {
		const res = await app.request(`/api/projects/${projectSlug}/agents/onboard`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				title: 'Support Lead',
				system_prompt: 'You are the Support Lead.',
				reports_to: 'captain',
			}),
		});
		expect(res.status).toBe(201);
		const { approval } = (await res.json()).data;
		expect(approval.payload.reports_to).toBe('captain');
		// This route keeps the default for a caller that omits the cadence: only
		// the MCP tool makes the field mandatory, and the admin form always sends
		// one because its submit is gated on picking a cadence.
		expect(approval.payload.heartbeat_interval_min).toBe(DEFAULT_HEARTBEAT_INTERVAL_MIN);

		const newId = await approveLatestHire('support-lead');
		const row = await db.query<{ reports_to: string }>(
			'SELECT reports_to FROM member_agents WHERE id = $1',
			[newId],
		);
		expect(row.rows[0].reports_to).toBe(captainId);
	});
});

describe('set_agent_reports_to', () => {
	it('the Captain wires a manager so delegation is then allowed', async () => {
		// Re-point the engineer (defaults to the architect) at the captain.
		const result = await callTool(await captainToken(), 'set_agent_reports_to', {
			project: projectSlug,
			agent_id: 'engineer',
			reports_to: 'captain',
		});
		expect(result.error).toBeUndefined();
		expect(result.applied).toBe(true);
		expect((await assertSubordinateAssignee(db, captainId, engineerId)).ok).toBe(true);
	});

	it('rejects self-reports and reporting cycles', async () => {
		const self = await callTool(await captainToken(), 'set_agent_reports_to', {
			project: projectSlug,
			agent_id: 'engineer',
			reports_to: 'engineer',
		});
		expect(self.error).toContain('cannot report to itself');

		// engineer→captain now. Point the architect at the engineer, then closing the
		// loop by pointing the engineer back at the architect is rejected as a cycle.
		// (Uses two ordinary roles — the Captain's own line is fixed, see below.)
		const link = await callTool(await captainToken(), 'set_agent_reports_to', {
			project: projectSlug,
			agent_id: 'architect',
			reports_to: 'engineer',
		});
		expect(link.error).toBeUndefined();
		const cycle = await callTool(await captainToken(), 'set_agent_reports_to', {
			project: projectSlug,
			agent_id: 'engineer',
			reports_to: 'architect',
		});
		expect(cycle.error).toContain('cycle');
	});

	it('refuses to re-point a structurally-fixed reporting line (Captain)', async () => {
		const result = await callTool(await captainToken(), 'set_agent_reports_to', {
			project: projectSlug,
			agent_id: 'captain',
			reports_to: 'engineer',
		});
		expect(result.error).toContain('fixed');
	});

	it('an empty reports_to clears the reporting line', async () => {
		const result = await callTool(await captainToken(), 'set_agent_reports_to', {
			project: projectSlug,
			agent_id: 'architect',
			reports_to: '',
		});
		expect(result.error).toBeUndefined();
		expect(result.reports_to).toBeNull();
		const row = await db.query<{ reports_to: string | null }>(
			'SELECT reports_to FROM member_agents WHERE id = $1',
			[architectId],
		);
		expect(row.rows[0].reports_to).toBeNull();
	});

	it('denies a plain worker agent', async () => {
		const { token: engToken } = await mintAgentToken(
			db,
			masterKeyManager,
			engineerId,
			teamId,
			null,
			{
				projectId: internalProjectId,
			},
		);
		const result = await callTool(engToken, 'set_agent_reports_to', {
			project: projectSlug,
			agent_id: 'architect',
			reports_to: 'captain',
		});
		expect(result.error).toContain('Access denied');
	});
});

describe('REST PATCH locks fixed reporting lines', () => {
	async function patchReportsTo(agentId: string, reportsTo: string | null) {
		return app.request(`/api/projects/${projectSlug}/agents/${agentId}`, {
			method: 'PATCH',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ reports_to: reportsTo }),
		});
	}

	it("rejects changing the Captain's reports_to to another agent", async () => {
		const res = await patchReportsTo(captainId, engineerId);
		expect(res.status).toBe(400);
		const body = await res.json();
		expect(body.error.message).toContain('Captain');
	});

	it("allows a no-op resubmission of the Captain's current reports_to", async () => {
		const cur = await db.query<{ reports_to: string | null }>(
			'SELECT reports_to FROM member_agents WHERE id = $1',
			[captainId],
		);
		const res = await patchReportsTo(captainId, cur.rows[0].reports_to);
		expect(res.status).toBe(200);
	});

	it('still allows re-pointing an ordinary worker agent', async () => {
		const res = await patchReportsTo(engineerId, captainId);
		expect(res.status).toBe(200);
		const row = await db.query<{ reports_to: string | null }>(
			'SELECT reports_to FROM member_agents WHERE id = $1',
			[engineerId],
		);
		expect(row.rows[0].reports_to).toBe(captainId);
	});
});
