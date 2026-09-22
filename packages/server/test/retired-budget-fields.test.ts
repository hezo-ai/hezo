import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MasterKeyManager } from '../src/crypto/master-key';
import type { Db } from '../src/db/database';
import type { Env } from '../src/lib/types';
import { parseMarketplaceTeam } from '../src/services/marketplace';
import { safeClose } from './helpers';
import {
	authHeader,
	createTestApp,
	createTestProject,
	createTestTeam,
	mintAgentToken,
} from './helpers/app';
import { callMcpTool } from './helpers/mcp-call';

// Budgets count tokens. A request still sending a dollar budget field is
// refused with the field that replaced it, never saved or ignored in silence.

let app: Hono<Env>;
let db: Db;
let token: string;
let projectSlug: string;
let agentId: string;
let agentTypeId: string;
let masterKeyManager: MasterKeyManager;

beforeAll(async () => {
	const ctx = await createTestApp();
	app = ctx.app;
	db = ctx.db;
	token = ctx.token;
	masterKeyManager = ctx.masterKeyManager;
	const typesRes = await app.request('/api/team-templates', { headers: authHeader(token) });
	// biome-ignore lint/suspicious/noExplicitAny: test JSON
	const templateId = (await typesRes.json()).data.find((t: any) => t.name === 'App Team').id;
	const teamRes = await createTestTeam(db, { name: 'Retired Fields Co', template_id: templateId });
	const teamId = (await teamRes.json()).data.id;
	const project = (await (await createTestProject(db, teamId, { name: 'Retired' })).json()).data;
	projectSlug = project.slug;
	const agentsRes = await app.request(`/api/projects/${projectSlug}/agents`, {
		headers: authHeader(token),
	});
	agentId = (await agentsRes.json()).data[0].id;
	const typeRes = await app.request('/api/agent-types', {
		method: 'POST',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify({ name: 'Retired fields analyst', monthly_budget_tokens: 5_000_000 }),
	});
	agentTypeId = (await typeRes.json()).data.id;
});

afterAll(async () => {
	await safeClose(db);
});

async function send(method: 'POST' | 'PATCH', path: string, body: Record<string, unknown>) {
	const res = await app.request(path, {
		method,
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify(body),
	});
	return { status: res.status, body: await res.json() };
}

describe('a retired dollar budget field', () => {
	it('is refused on a project update, and the budget is left alone', async () => {
		const res = await send('PATCH', `/api/projects/${projectSlug}`, { monthly_budget_cents: 3000 });
		expect(res.status).toBe(400);
		expect(res.body.error.message).toContain('monthly_budget_cents -> monthly_budget_tokens');
		const row = await db.query<{ monthly_budget_tokens: number }>(
			'SELECT monthly_budget_tokens FROM projects WHERE slug = $1',
			[projectSlug],
		);
		expect(row.rows[0].monthly_budget_tokens).toBe(0);
	});

	it('is refused on an agent update, naming every retired field sent', async () => {
		const res = await send('PATCH', `/api/projects/${projectSlug}/agents/${agentId}`, {
			daily_budget_cents: 100,
			weekly_budget_cents: 700,
		});
		expect(res.status).toBe(400);
		expect(res.body.error.message).toContain('daily_budget_cents -> daily_budget_tokens');
		expect(res.body.error.message).toContain('weekly_budget_cents -> weekly_budget_tokens');
	});

	it('is refused when hiring an agent', async () => {
		const res = await send('POST', `/api/projects/${projectSlug}/agents`, {
			title: 'Priced hire',
			monthly_budget_cents: 3000,
		});
		expect(res.status).toBe(400);
		expect(res.body.error.message).toContain('monthly_budget_tokens');
		const hired = await db.query("SELECT 1 FROM member_agents WHERE title = 'Priced hire'");
		expect(hired.rows).toEqual([]);
	});

	it('is refused on an agent type, created or updated', async () => {
		const created = await send('POST', '/api/agent-types', {
			name: 'Priced type',
			monthly_budget_cents: 3000,
		});
		expect(created.status).toBe(400);
		const updated = await send('PATCH', `/api/agent-types/${agentTypeId}`, {
			monthly_budget_cents: 3000,
		});
		expect(updated.status).toBe(400);
		expect(updated.body.error.message).toContain('monthly_budget_tokens');
	});

	it('leaves the token field working', async () => {
		const res = await send('PATCH', `/api/agent-types/${agentTypeId}`, {
			monthly_budget_tokens: 9_000_000,
		});
		expect(res.status).toBe(200);
		expect(res.body.data.monthly_budget_tokens).toBe(9_000_000);
	});
});

describe('every hire path', () => {
	async function captainToken(): Promise<string> {
		const captain = await db.query<{ id: string; team_id: string }>(
			`SELECT ma.id, m.team_id FROM member_agents ma JOIN members m ON m.id = ma.id
			  JOIN projects p ON p.team_id = m.team_id
			  WHERE p.slug = $1 AND ma.slug = 'captain' LIMIT 1`,
			[projectSlug],
		);
		const projectId = await db.query<{ id: string }>('SELECT id FROM projects WHERE slug = $1', [
			projectSlug,
		]);
		const { token: agentToken } = await mintAgentToken(
			db,
			masterKeyManager,
			captain.rows[0].id,
			captain.rows[0].team_id,
			null,
			{ projectId: projectId.rows[0].id },
		);
		return agentToken;
	}

	/** A pending hire proposal the Captain filed, for the edit paths to revise. */
	async function fileProposal(title: string): Promise<string> {
		const filed = await callMcpTool(app, await captainToken(), 'create_hire_proposal', {
			title,
			system_prompt: 'You analyse the numbers.',
			heartbeat_interval_min: 720,
			monthly_budget_tokens: 30_000_000,
		});
		expect(filed.error).toBeUndefined();
		return filed.approval_id as string;
	}

	it('refuses a retired field on the MCP create and update tools, rather than dropping it', async () => {
		const token = await captainToken();
		const created = await callMcpTool(app, token, 'create_hire_proposal', {
			title: 'Priced by tool',
			system_prompt: 'You analyse the numbers.',
			heartbeat_interval_min: 720,
			monthly_budget_cents: 3000,
		});
		expect(created.error).toContain('monthly_budget_cents -> monthly_budget_tokens');

		const approvalId = await fileProposal('Revised by tool');
		const updated = await callMcpTool(app, token, 'update_hire_proposal', {
			approval_id: approvalId,
			daily_budget_cents: 100,
		});
		expect(updated.error).toContain('daily_budget_cents -> daily_budget_tokens');
	});

	it('refuses a budget the create path would refuse, on both edit paths', async () => {
		const approvalId = await fileProposal('Edited budget');
		// Fractional, negative, and a weekly window below seven of its daily ones.
		for (const bad of [
			{ monthly_budget_tokens: 1.5 },
			{ monthly_budget_tokens: -1 },
			{ daily_budget_tokens: 10_000_000, weekly_budget_tokens: 1 },
		]) {
			const viaTool = await callMcpTool(app, await captainToken(), 'update_hire_proposal', {
				approval_id: approvalId,
				...bad,
			});
			expect(viaTool.error, JSON.stringify(bad)).toBeTruthy();
			const viaRest = await send('PATCH', `/api/approvals/${approvalId}`, bad);
			expect(viaRest.status, JSON.stringify(bad)).toBe(400);
		}
		const viaRest = await send('PATCH', `/api/approvals/${approvalId}`, {
			monthly_budget_cents: 3000,
		});
		expect(viaRest.body.error.message).toContain('monthly_budget_tokens');
		const stored = await db.query<{ payload: Record<string, unknown> }>(
			'SELECT payload FROM approvals WHERE id = $1',
			[approvalId],
		);
		expect(stored.rows[0].payload.monthly_budget_tokens).toBe(30_000_000);
	});

	it('checks a hire filed through the generic approvals route like any other', async () => {
		const res = await send('POST', `/api/projects/${projectSlug}/approvals`, {
			type: 'hire',
			payload: { title: 'Generic hire', monthly_budget_cents: 3000 },
		});
		expect(res.status).toBe(400);
		expect(res.body.error.message).toContain('monthly_budget_tokens');
	});
});

describe('an agent type budget', () => {
	it('is refused when it is not a whole, non-negative token count', async () => {
		for (const monthly of [-5, 1.5]) {
			const created = await send('POST', '/api/agent-types', {
				name: `Bad budget ${monthly}`,
				monthly_budget_tokens: monthly,
			});
			expect(created.status).toBe(400);
			const updated = await send('PATCH', `/api/agent-types/${agentTypeId}`, {
				monthly_budget_tokens: monthly,
			});
			expect(updated.status).toBe(400);
		}
	});
});

describe('a marketplace catalog', () => {
	const catalog = () =>
		JSON.parse(
			readFileSync(
				join(__dirname, '..', '..', '..', 'marketplace', 'teams', 'app-dev.json'),
				'utf8',
			),
		);

	it('parses with the retired fields at 0, as it is still published', () => {
		expect(parseMarketplaceTeam(catalog())).not.toBeNull();
	});

	it('refuses a role whose retired dollar budget is set, rather than making it unlimited', () => {
		const team = catalog();
		team.roster[0].monthly_budget_cents = 3000;
		expect(parseMarketplaceTeam(team)).toBeNull();
	});
});
