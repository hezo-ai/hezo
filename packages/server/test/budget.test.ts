import type { PGlite } from '@electric-sql/pglite';
import type { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Env } from '../src/lib/types';
import {
	checkOverBudget,
	getAgentBudgetStatus,
	getAgentSpend,
	getProjectBudgetStatus,
	recordRunCost,
} from '../src/services/budget';
import { safeClose } from './helpers';
import { authHeader, createTestApp, createTestProject } from './helpers/app';

let app: Hono<Env>;
let db: PGlite;
let token: string;
let teamId: string;
let projectId: string;
let projectSlug: string;
let agentId: string;

beforeAll(async () => {
	const ctx = await createTestApp();
	app = ctx.app;
	db = ctx.db;
	token = ctx.token;

	const typesRes = await app.request('/api/team-templates', { headers: authHeader(token) });
	// biome-ignore lint/suspicious/noExplicitAny: test JSON
	const typeId = (await typesRes.json()).data.find((t: any) => t.name === 'Startup').id;

	const teamRes = await app.request('/api/teams', {
		method: 'POST',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify({ name: 'Budget Co', template_id: typeId }),
	});
	const teamSlug = (await teamRes.json()).data.slug;

	const teamRow = await db.query<{ id: string }>('SELECT id FROM teams WHERE slug = $1', [
		teamSlug,
	]);
	teamId = teamRow.rows[0].id;

	// POST /api/teams creates the team + roster; the project is provisioned here.
	const projectRes = await createTestProject(db, teamId, { name: 'Budget Project' });
	const project = (await projectRes.json()).data;
	projectId = project.id;
	projectSlug = project.slug;

	const agentsRes = await app.request(`/api/projects/${projectSlug}/agents`, {
		headers: authHeader(token),
	});
	// biome-ignore lint/suspicious/noExplicitAny: test JSON
	agentId = (await agentsRes.json()).data.find((a: any) => a.slug === 'engineer').id;
});

afterAll(async () => {
	await safeClose(db);
});

beforeEach(async () => {
	// Each test owns the spend surface for its agent/project.
	await db.query('DELETE FROM cost_entries WHERE member_id = $1 OR project_id = $2', [
		agentId,
		projectId,
	]);
	await db.query(
		'UPDATE member_agents SET daily_budget_cents = 0, weekly_budget_cents = 0, monthly_budget_cents = 0, runtime_status = $2 WHERE id = $1',
		[agentId, 'idle'],
	);
	await db.query(
		'UPDATE projects SET daily_budget_cents = 0, weekly_budget_cents = 0, monthly_budget_cents = 0 WHERE id = $1',
		[projectId],
	);
});

/** Insert a cost_entry at an explicit age (negative offset from now). */
async function insertCost(amountCents: number, ageInterval: string): Promise<void> {
	await db.query(
		`INSERT INTO cost_entries (member_id, project_id, amount_cents, created_at)
		 VALUES ($1, $2, $3, now() AT TIME ZONE 'UTC' - $4::interval)`,
		[agentId, projectId, amountCents, ageInterval],
	);
}

describe('budget service - windowed spend', () => {
	it('sums spend per UTC window and excludes older entries', async () => {
		await insertCost(100, '1 hour'); // today
		await insertCost(200, '2 days'); // this week (not today) — but only if same week
		await insertCost(400, '40 days'); // older than a month

		const spend = await getAgentSpend(db, agentId);
		// Daily includes only the 1-hour-old entry.
		expect(spend.daily).toBe(100);
		// Monthly excludes the 40-day-old entry (older than start-of-month for most of
		// the month; at minimum it is excluded once we're >40 days into enforcement —
		// assert the floor that today's entry is always counted and the 40d one is not
		// counted in daily/weekly).
		expect(spend.weekly).toBeGreaterThanOrEqual(100);
		expect(spend.monthly).toBeGreaterThanOrEqual(spend.weekly);
		expect(spend.monthly).toBeLessThan(700);
	});
});

describe('budget service - status & limits', () => {
	it('treats a 0 limit as unlimited', async () => {
		await insertCost(10_000, '1 hour');
		const status = await getAgentBudgetStatus(db, agentId);
		expect(status.daily.limitCents).toBe(0);
		expect(status.daily.overBudget).toBe(false);
		expect(status.overBudget).toBe(false);
	});

	it('flags over budget when spend meets or exceeds a positive limit', async () => {
		await db.query('UPDATE member_agents SET daily_budget_cents = 500 WHERE id = $1', [agentId]);
		await insertCost(500, '1 hour');
		const status = await getAgentBudgetStatus(db, agentId);
		expect(status.daily.overBudget).toBe(true);
		expect(status.overBudget).toBe(true);
	});

	it('stays under budget below a positive limit', async () => {
		await db.query('UPDATE member_agents SET monthly_budget_cents = 500 WHERE id = $1', [agentId]);
		await insertCost(499, '1 hour');
		const status = await getAgentBudgetStatus(db, agentId);
		expect(status.monthly.overBudget).toBe(false);
	});
});

describe('budget service - checkOverBudget gate', () => {
	it('returns null when within budget', async () => {
		await db.query('UPDATE member_agents SET daily_budget_cents = 1000 WHERE id = $1', [agentId]);
		await insertCost(100, '1 hour');
		expect(await checkOverBudget(db, agentId, projectId)).toBeNull();
	});

	it('blocks on the agent window', async () => {
		await db.query('UPDATE member_agents SET weekly_budget_cents = 100 WHERE id = $1', [agentId]);
		await insertCost(150, '1 hour');
		const block = await checkOverBudget(db, agentId, projectId);
		expect(block).toEqual({ scope: 'agent', period: 'weekly' });
	});

	it('blocks all agents when the project is over budget', async () => {
		// Agent itself is unlimited; the project cap is what trips.
		await db.query('UPDATE projects SET monthly_budget_cents = 100 WHERE id = $1', [projectId]);
		await insertCost(200, '1 hour');
		const block = await checkOverBudget(db, agentId, projectId);
		expect(block).toEqual({ scope: 'project', period: 'monthly' });
	});

	it('checks only the agent when projectId is null', async () => {
		await db.query('UPDATE projects SET monthly_budget_cents = 100 WHERE id = $1', [projectId]);
		await insertCost(200, '1 hour');
		// Project is over, but a null project scope skips it.
		expect(await checkOverBudget(db, agentId, null)).toBeNull();
	});
});

describe('budget service - recordRunCost', () => {
	it('inserts exactly one cost_entry for a positive amount', async () => {
		const entry = await recordRunCost(db, {
			memberId: agentId,
			taskId: null,
			projectId,
			amountCents: 250,
			description: 'Agent run abc',
			aiProviderConfigId: null,
			provider: null,
		});
		expect(entry).not.toBeNull();
		const spend = await getAgentSpend(db, agentId);
		expect(spend.daily).toBe(250);
	});

	it('attributes the cost to the AI adapter config that produced it', async () => {
		const cfg = await db.query<{ id: string }>(
			`INSERT INTO ai_provider_configs (provider, auth_method, label, encrypted_credential)
			 VALUES ('anthropic', 'api_key', 'Attribution Test Key', 'x') RETURNING id`,
		);
		const configId = cfg.rows[0].id;
		const entry = await recordRunCost(db, {
			memberId: agentId,
			taskId: null,
			projectId,
			amountCents: 99,
			description: 'Agent run xyz',
			aiProviderConfigId: configId,
			provider: 'anthropic',
		});
		expect(entry).not.toBeNull();
		expect((entry as Record<string, unknown>).ai_provider_config_id).toBe(configId);
		expect((entry as Record<string, unknown>).provider).toBe('anthropic');
	});

	it('is a no-op for non-positive amounts', async () => {
		const entry = await recordRunCost(db, {
			memberId: agentId,
			taskId: null,
			projectId,
			amountCents: 0,
			description: 'free run',
			aiProviderConfigId: null,
			provider: null,
		});
		expect(entry).toBeNull();
		const spend = await getAgentSpend(db, agentId);
		expect(spend.daily).toBe(0);
	});
});

describe('budget-status API', () => {
	it('returns project + per-agent window status with over-budget flags', async () => {
		await db.query('UPDATE member_agents SET daily_budget_cents = 100 WHERE id = $1', [agentId]);
		await insertCost(150, '1 hour');

		const res = await app.request(`/api/projects/${projectSlug}/budget-status`, {
			headers: authHeader(token),
		});
		expect(res.status).toBe(200);
		const { data } = await res.json();
		expect(data.project).toHaveProperty('daily');
		expect(Array.isArray(data.agents)).toBe(true);
		// biome-ignore lint/suspicious/noExplicitAny: test JSON
		const engineer = data.agents.find((a: any) => a.agent_id === agentId);
		expect(engineer.daily.spentCents).toBe(150);
		expect(engineer.daily.limitCents).toBe(100);
		expect(engineer.agent_over_budget).toBe(true);
		// One cost entry was recorded this month for the project → one "run".
		expect(data.runsThisMonth).toBe(1);
	});
});
