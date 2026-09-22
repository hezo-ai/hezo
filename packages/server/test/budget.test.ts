import type { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../src/db/database';
import { BUDGET_USAGE_COUNTED_FROM_META_KEY } from '../src/db/migrations/code/081_token_budgets';
import type { Env } from '../src/lib/types';
import { checkOverBudget, getAgentBudgetStatus, recordUsage } from '../src/services/budget';
import { safeClose } from './helpers';
import { authHeader, createTestApp, createTestProject, createTestTeam } from './helpers/app';

let app: Hono<Env>;
let db: Db;
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
	const typeId = (await typesRes.json()).data.find((t: any) => t.name === 'App Team').id;

	const teamRes = await createTestTeam(db, { name: 'Budget Co', template_id: typeId });
	const teamSlug = (await teamRes.json()).data.slug;

	const teamRow = await db.query<{ id: string }>('SELECT id FROM teams WHERE slug = $1', [
		teamSlug,
	]);
	teamId = teamRow.rows[0].id;

	// createTestTeam stands up the team + roster; the project is provisioned here.
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
	// Each test owns the usage rows for its agent/project.
	await db.query('DELETE FROM usage_entries WHERE member_id = $1 OR project_id = $2', [
		agentId,
		projectId,
	]);
	await db.query(
		'UPDATE member_agents SET daily_budget_tokens = 0, weekly_budget_tokens = 0, monthly_budget_tokens = 0, runtime_status = $2 WHERE id = $1',
		[agentId, 'idle'],
	);
	await db.query(
		'UPDATE projects SET daily_budget_tokens = 0, weekly_budget_tokens = 0, monthly_budget_tokens = 0 WHERE id = $1',
		[projectId],
	);
});

/** Insert a usage row at an explicit age (negative offset from now). */
async function insertUsage(inputTokens: number, ageInterval: string): Promise<void> {
	await db.query(
		`INSERT INTO usage_entries (member_id, project_id, input_tokens, created_at)
		 VALUES ($1, $2, $3, now() AT TIME ZONE 'UTC' - $4::interval)`,
		[agentId, projectId, inputTokens, ageInterval],
	);
}

/**
 * Insert a usage row anchored to the start of the current UTC day. Use this for
 * "current/today" usage: the timestamp equals the daily window floor and sits at
 * or after the weekly/monthly floors, so the entry counts in every window no
 * matter what time of day the suite runs. A `now() - '1 hour'` entry, by
 * contrast, lands in *yesterday* (and possibly last week/month) when the suite
 * runs in the first hour after UTC midnight — the source of past flakes.
 */
async function insertUsageToday(inputTokens: number, outputTokens = 0): Promise<void> {
	await db.query(
		`INSERT INTO usage_entries (member_id, project_id, input_tokens, output_tokens, created_at)
		 VALUES ($1, $2, $3, $4, date_trunc('day', now() AT TIME ZONE 'UTC'))`,
		[agentId, projectId, inputTokens, outputTokens],
	);
}

describe('budget service - windowed usage', () => {
	it('sums usage per UTC window and excludes older entries', async () => {
		await insertUsageToday(100); // in daily, weekly, and monthly
		await insertUsage(400, '40 days'); // older than any month → excluded from every window

		const usage = await getAgentBudgetStatus(db, agentId);
		// Today's entry is the only one inside any window; the 40-day-old entry is
		// excluded from all three (40 days predates every window floor year-round).
		expect(usage.daily.usedTokens).toBe(100);
		expect(usage.weekly.usedTokens).toBe(100);
		expect(usage.monthly.usedTokens).toBe(100);
	});

	it('counts input and output tokens together', async () => {
		await insertUsageToday(700, 300);
		expect((await getAgentBudgetStatus(db, agentId)).daily.usedTokens).toBe(1000);
	});

	it('counts only usage from the upgrade that made budgets count tokens', async () => {
		await insertUsageToday(100);
		await db.query(
			`INSERT INTO system_meta (key, value) VALUES ($1, (now() - interval '1 second')::text)`,
			[BUDGET_USAGE_COUNTED_FROM_META_KEY],
		);
		try {
			await db.query(
				`INSERT INTO usage_entries (member_id, project_id, input_tokens) VALUES ($1, $2, 40)`,
				[agentId, projectId],
			);
			const status = await getAgentBudgetStatus(db, agentId);
			expect(status.daily.usedTokens).toBe(40);
			expect(status.monthly.usedTokens).toBe(40);
		} finally {
			await db.query('DELETE FROM system_meta WHERE key = $1', [
				BUDGET_USAGE_COUNTED_FROM_META_KEY,
			]);
		}
	});

	it('starts each window at UTC midnight whatever the session time zone', async () => {
		// Two hours before UTC midnight is yesterday in UTC, but today in a zone 14
		// hours ahead: a window truncated in the session zone would count it.
		await db.query(
			`INSERT INTO usage_entries (member_id, project_id, input_tokens, created_at)
			 VALUES ($1, $2, 55, date_trunc('day', now(), 'UTC') - interval '2 hours')`,
			[agentId, projectId],
		);
		await db.query(`SET TIME ZONE 'Pacific/Kiritimati'`);
		try {
			expect((await getAgentBudgetStatus(db, agentId)).daily.usedTokens).toBe(0);
		} finally {
			await db.query('RESET TIME ZONE');
		}
	});
});

describe('budget service - status & limits', () => {
	it('treats a 0 limit as unlimited', async () => {
		await insertUsageToday(10_000);
		const status = await getAgentBudgetStatus(db, agentId);
		expect(status.daily.limitTokens).toBe(0);
		expect(status.daily.overBudget).toBe(false);
		expect(status.overBudget).toBe(false);
	});

	it('flags over budget when usage meets or exceeds a positive limit', async () => {
		await db.query('UPDATE member_agents SET daily_budget_tokens = 500 WHERE id = $1', [agentId]);
		await insertUsageToday(500);
		const status = await getAgentBudgetStatus(db, agentId);
		expect(status.daily.overBudget).toBe(true);
		expect(status.overBudget).toBe(true);
	});

	it('stays under budget below a positive limit', async () => {
		await db.query('UPDATE member_agents SET monthly_budget_tokens = 500 WHERE id = $1', [agentId]);
		await insertUsageToday(499);
		const status = await getAgentBudgetStatus(db, agentId);
		expect(status.monthly.overBudget).toBe(false);
	});
});

describe('budget service - checkOverBudget gate', () => {
	it('returns null when within budget', async () => {
		await db.query('UPDATE member_agents SET daily_budget_tokens = 1000 WHERE id = $1', [agentId]);
		await insertUsageToday(100);
		expect(await checkOverBudget(db, agentId, projectId)).toBeNull();
	});

	it('blocks on the agent window', async () => {
		await db.query('UPDATE member_agents SET weekly_budget_tokens = 100 WHERE id = $1', [agentId]);
		await insertUsageToday(150);
		const block = await checkOverBudget(db, agentId, projectId);
		expect(block).toEqual({ scope: 'agent', period: 'weekly', usedTokens: 150, limitTokens: 100 });
	});

	it('blocks all agents when the project is over budget', async () => {
		// Agent itself is unlimited; the project cap is what trips.
		await db.query('UPDATE projects SET monthly_budget_tokens = 100 WHERE id = $1', [projectId]);
		await insertUsageToday(200);
		const block = await checkOverBudget(db, agentId, projectId);
		expect(block).toEqual({
			scope: 'project',
			period: 'monthly',
			usedTokens: 200,
			limitTokens: 100,
		});
	});

	it('checks only the agent when projectId is null', async () => {
		await db.query('UPDATE projects SET monthly_budget_tokens = 100 WHERE id = $1', [projectId]);
		await insertUsageToday(200);
		// Project is over, but a null project scope skips it.
		expect(await checkOverBudget(db, agentId, null)).toBeNull();
	});
});

describe('budget service - recordUsage', () => {
	it('inserts exactly one usage row for a run that used tokens', async () => {
		const entry = await recordUsage(db, {
			memberId: agentId,
			taskId: null,
			projectId,
			inputTokens: 200,
			outputTokens: 50,
			description: 'Agent run abc',
		});
		expect(entry).toMatchObject({ input_tokens: 200, output_tokens: 50 });
		expect((await getAgentBudgetStatus(db, agentId)).daily.usedTokens).toBe(250);
	});

	it('attributes the usage to the AI provider credential that produced it', async () => {
		const cfg = await db.query<{ id: string }>(
			`INSERT INTO ai_provider_configs (provider, auth_method, label, encrypted_credential)
			 VALUES ('anthropic', 'subscription', 'Attribution Test Key', 'x') RETURNING id`,
		);
		const configId = cfg.rows[0].id;
		const entry = await recordUsage(db, {
			memberId: agentId,
			taskId: null,
			projectId,
			inputTokens: 99,
			outputTokens: 1,
			description: 'Agent run xyz',
			aiProviderConfigId: configId,
			provider: 'anthropic',
		});
		expect(entry).toMatchObject({ ai_provider_config_id: configId, provider: 'anthropic' });
		// A subscription credential counts toward the budget like any other.
		await db.query('UPDATE member_agents SET daily_budget_tokens = 100 WHERE id = $1', [agentId]);
		expect(await checkOverBudget(db, agentId, projectId)).toMatchObject({ scope: 'agent' });
		await db.query('DELETE FROM usage_entries WHERE ai_provider_config_id = $1', [configId]);
		await db.query('DELETE FROM ai_provider_configs WHERE id = $1', [configId]);
	});

	it('is a no-op when the run used no tokens', async () => {
		const entry = await recordUsage(db, {
			memberId: agentId,
			taskId: null,
			projectId,
			inputTokens: 0,
			outputTokens: 0,
			description: 'empty run',
		});
		expect(entry).toBeNull();
		expect((await getAgentBudgetStatus(db, agentId)).daily.usedTokens).toBe(0);
	});
});

describe('budget-status API', () => {
	it('returns project + per-agent window status with over-budget flags', async () => {
		await db.query('UPDATE member_agents SET daily_budget_tokens = 100 WHERE id = $1', [agentId]);
		await insertUsageToday(150);

		const res = await app.request(`/api/projects/${projectSlug}/budget-status`, {
			headers: authHeader(token),
		});
		expect(res.status).toBe(200);
		const { data } = await res.json();
		expect(data.project).toHaveProperty('daily');
		expect(Array.isArray(data.agents)).toBe(true);
		// biome-ignore lint/suspicious/noExplicitAny: test JSON
		const engineer = data.agents.find((a: any) => a.agent_id === agentId);
		expect(engineer.daily.usedTokens).toBe(150);
		expect(engineer.daily.limitTokens).toBe(100);
		expect(engineer.agent_over_budget).toBe(true);
		// One usage entry was recorded this month for the project → one "run".
		expect(data.runsThisMonth).toBe(1);
	});

	it("carries an agent's name and avatar spec so the breakdown can put a face on a row", async () => {
		const res = await app.request(`/api/projects/${projectSlug}/budget-status`, {
			headers: authHeader(token),
		});
		const { data } = await res.json();
		// biome-ignore lint/suspicious/noExplicitAny: test JSON
		const engineer = data.agents.find((a: any) => a.agent_id === agentId);
		// An agent has no uploaded image; its sprite is drawn client-side from the
		// spec the row carries, and the built-in CEO/Coach portraits resolve from
		// the slug.
		expect(engineer).not.toHaveProperty('agent_icon_url');
		expect(engineer.agent_avatar_spec).toMatchObject({
			seed: expect.any(String),
			style: expect.any(String),
		});
		expect(engineer).toHaveProperty('agent_name');
	});
});
