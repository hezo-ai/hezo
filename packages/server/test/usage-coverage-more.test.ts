/**
 * Coverage-focused tests for the usage routes: every group_by/breakdown
 * aggregation shape with exact math over seeded entries, the query filters,
 * usage-entry creation (validation, explicit project attribution, over-budget
 * reactive pause), and the project budget-status payload.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authHeader, createTestProject, createTestTeam } from './helpers/app';
import { createTestContext, destroyTestContext, type ServerTestContext } from './helpers/context';

let ctx: ServerTestContext;
let token: string;
let teamId: string;
let projectId: string;
let projectSlug: string;
let planningTaskId: string;
let engineerId: string;
let otherAgentId: string;

beforeAll(async () => {
	ctx = await createTestContext();
	token = ctx.token;
	const { app, db } = ctx;

	const typesRes = await app.request('/api/team-templates', { headers: authHeader(token) });
	const templateId = (await typesRes.json()).data.find(
		(t: { name: string }) => t.name === 'App Team',
	).id;
	const teamRes = await createTestTeam(db, { name: 'Usage Cov Co', template_id: templateId });
	teamId = (await teamRes.json()).data.id;

	const projectRes = await createTestProject(db, teamId, { name: 'Usage Cov Project' });
	const project = (await projectRes.json()).data;
	projectId = project.id;
	projectSlug = project.slug;
	planningTaskId = project.planning_task_id as string;

	const agents = await db.query<{ id: string; slug: string }>(
		`SELECT ma.id, ma.slug FROM member_agents ma JOIN members m ON m.id = ma.id
		 WHERE m.team_id = $1 ORDER BY ma.slug`,
		[teamId],
	);
	engineerId = agents.rows.find((a) => a.slug === 'engineer')?.id as string;
	otherAgentId = agents.rows.find((a) => a.slug !== 'engineer')?.id as string;
	expect(engineerId).toBeTruthy();
	expect(otherAgentId).toBeTruthy();

	// Deterministic usage: two entries "now" (inside every budget window) and two
	// 40 days back (outside day/week/month windows — a month is at most 31 days).
	const seed = async (
		memberId: string,
		amount: number,
		agoDays: number,
		opts: { taskId?: string; provider?: string } = {},
	) => {
		await db.query(
			`INSERT INTO usage_entries (member_id, project_id, task_id, provider, input_tokens, description, created_at)
			 VALUES ($1, $2, $3, ${opts.provider ? `'${opts.provider}'::ai_provider` : 'NULL'}, $4, 'seeded', now() - make_interval(days => $5))`,
			[memberId, projectId, opts.taskId ?? null, amount, agoDays],
		);
	};
	await seed(engineerId, 300, 0);
	await seed(engineerId, 500, 40);
	await seed(otherAgentId, 200, 0, { taskId: planningTaskId, provider: 'anthropic' });
	await seed(otherAgentId, 100, 40, { provider: 'anthropic' });
});

afterAll(async () => {
	await destroyTestContext(ctx);
});

function jsonHeaders() {
	return { ...authHeader(token), 'content-type': 'application/json' };
}

async function getUsage(query = ''): Promise<{
	entries?: Array<Record<string, unknown>>;
	summary?: Array<Record<string, unknown>>;
	total_tokens: number;
}> {
	const res = await ctx.app.request(`/api/projects/${projectSlug}/usage${query}`, {
		headers: authHeader(token),
	});
	expect(res.status).toBe(200);
	return (await res.json()).data;
}

describe('GET /projects/:projectId/usage aggregations', () => {
	it('lists raw entries with the grand total', async () => {
		const data = await getUsage();
		expect(data.entries).toHaveLength(4);
		expect(data.total_tokens).toBe(1100);
	});

	it('filters by agent_id', async () => {
		const data = await getUsage(`?agent_id=${engineerId}`);
		expect(data.entries).toHaveLength(2);
		expect(data.total_tokens).toBe(800);
	});

	it('filters by task_id', async () => {
		const data = await getUsage(`?task_id=${planningTaskId}`);
		expect(data.entries).toHaveLength(1);
		expect(data.total_tokens).toBe(200);
	});

	it('filters by from/to window', async () => {
		const from = new Date(Date.now() - 30 * 86_400_000).toISOString();
		const to = new Date(Date.now() + 86_400_000).toISOString();
		const recent = await getUsage(`?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`);
		expect(recent.total_tokens).toBe(500); // only the two "now" entries

		const old = await getUsage(
			`?to=${encodeURIComponent(new Date(Date.now() - 35 * 86_400_000).toISOString())}`,
		);
		expect(old.total_tokens).toBe(600); // only the two 40-day-old entries
	});

	it('composes filters (agent_id + from)', async () => {
		const from = new Date(Date.now() - 30 * 86_400_000).toISOString();
		const data = await getUsage(`?agent_id=${engineerId}&from=${encodeURIComponent(from)}`);
		expect(data.total_tokens).toBe(300);
	});

	it('group_by=agent sums per agent with a resolved title', async () => {
		const data = await getUsage('?group_by=agent');
		expect(data.total_tokens).toBe(1100);
		const rows = data.summary as Array<{
			agent_id: string;
			agent_title: string;
			total_tokens: number;
		}>;
		expect(rows).toHaveLength(2);
		expect(rows.find((r) => r.agent_id === engineerId)?.total_tokens).toBe(800);
		expect(rows.find((r) => r.agent_id === otherAgentId)?.total_tokens).toBe(300);
		for (const row of rows) expect(row.agent_title).toBeTruthy();
	});

	it('group_by=day buckets by date-only strings', async () => {
		const data = await getUsage('?group_by=day');
		expect(data.total_tokens).toBe(1100);
		const rows = data.summary as Array<{ day: string; total_tokens: number }>;
		expect(rows).toHaveLength(2);
		for (const row of rows) expect(row.day).toMatch(/^\d{4}-\d{2}-\d{2}$/);
		// Ordered by day ascending: the 40-day-old bucket first.
		expect(rows[0].total_tokens).toBe(600);
		expect(rows[1].total_tokens).toBe(500);
	});

	it('group_by=day&breakdown=agent splits each day per agent', async () => {
		const data = await getUsage('?group_by=day&breakdown=agent');
		expect(data.total_tokens).toBe(1100);
		const rows = data.summary as Array<{
			day: string;
			agent_id: string;
			total_tokens: number;
		}>;
		expect(rows).toHaveLength(4); // 2 days x 2 agents
		const engineerToday = rows.filter((r) => r.agent_id === engineerId).at(-1);
		expect(engineerToday?.total_tokens).toBe(300);
		expect(rows.reduce((s, r) => s + r.total_tokens, 0)).toBe(1100);
	});

	it('group_by=day&breakdown=adapter splits each day per provider adapter', async () => {
		const data = await getUsage('?group_by=day&breakdown=adapter');
		expect(data.total_tokens).toBe(1100);
		const rows = data.summary as Array<{
			day: string;
			provider: string | null;
			adapter_label: string | null;
			total_tokens: number;
		}>;
		expect(rows).toHaveLength(4); // 2 days x (anthropic + no-provider)
		const anthropicTotal = rows
			.filter((r) => r.provider === 'anthropic')
			.reduce((s, r) => s + r.total_tokens, 0);
		expect(anthropicTotal).toBe(300);
		const unattributedTotal = rows
			.filter((r) => r.provider === null)
			.reduce((s, r) => s + r.total_tokens, 0);
		expect(unattributedTotal).toBe(800);
	});
});

describe('GET /projects/:projectId/budget-status', () => {
	it('reports per-window usage for the project and each agent plus the month run count', async () => {
		const res = await ctx.app.request(`/api/projects/${projectSlug}/budget-status`, {
			headers: authHeader(token),
		});
		expect(res.status).toBe(200);
		const data = (await res.json()).data;

		// Project windows: only the two "now" entries fall inside day/week/month.
		expect(data.project.daily.usedTokens).toBe(500);
		expect(data.project.weekly.usedTokens).toBe(500);
		expect(data.project.monthly.usedTokens).toBe(500);
		expect(data.project.overBudget).toBe(false);

		// Month-to-date run count: one usage entry ~ one run; the 40-day-old rows are out.
		expect(data.runsThisMonth).toBe(2);

		const engineer = data.agents.find((a: { agent_id: string }) => a.agent_id === engineerId);
		expect(engineer.agent_slug).toBe('engineer');
		expect(engineer.daily.usedTokens).toBe(300);
		expect(engineer.weekly.usedTokens).toBe(300);
		expect(engineer.monthly.usedTokens).toBe(300);
		expect(engineer.agent_over_budget).toBe(false);
		expect(engineer.project_over_budget).toBe(false);
		expect(engineer.overBudget).toBe(false);

		const other = data.agents.find((a: { agent_id: string }) => a.agent_id === otherAgentId);
		expect(other.daily.usedTokens).toBe(200);
		expect(other.monthly.usedTokens).toBe(200);

		// Agents with no usage at all still appear with zeroed windows.
		const idle = data.agents.find(
			(a: { agent_id: string }) => a.agent_id !== engineerId && a.agent_id !== otherAgentId,
		);
		if (idle) {
			expect(idle.daily.usedTokens).toBe(0);
			expect(idle.monthly.usedTokens).toBe(0);
		}
	});
});

describe('POST /projects/:projectId/usage', () => {
	it('rejects a missing member_id, missing tokens, and non-positive token counts', async () => {
		const post = (body: Record<string, unknown>) =>
			ctx.app.request(`/api/projects/${projectSlug}/usage`, {
				method: 'POST',
				headers: jsonHeaders(),
				body: JSON.stringify(body),
			});

		for (const body of [
			{ input_tokens: 100 },
			{ member_id: otherAgentId },
			{ member_id: otherAgentId, input_tokens: 0 },
			{ member_id: otherAgentId, input_tokens: -5 },
		]) {
			const res = await post(body);
			expect(res.status).toBe(400);
			expect((await res.json()).error.code).toBe('INVALID_REQUEST');
		}
	});

	it('records a usage entry attributed to the path project with task and description', async () => {
		const res = await ctx.app.request(`/api/projects/${projectSlug}/usage`, {
			method: 'POST',
			headers: jsonHeaders(),
			body: JSON.stringify({
				member_id: otherAgentId,
				input_tokens: 150,
				task_id: planningTaskId,
				description: 'run usage',
			}),
		});
		expect(res.status).toBe(201);
		const entry = (await res.json()).data;
		expect(entry.input_tokens).toBe(150);
		expect(entry.project_id).toBe(projectId);
		expect(entry.task_id).toBe(planningTaskId);
		expect(entry.description).toBe('run usage');

		const row = await ctx.db.query<{ input_tokens: number }>(
			`SELECT input_tokens FROM usage_entries WHERE id = $1`,
			[entry.id],
		);
		expect(row.rows[0].input_tokens).toBe(150);
	});

	it('honours an explicit project_id in the body over the path project', async () => {
		const res = await ctx.app.request(`/api/projects/${projectSlug}/usage`, {
			method: 'POST',
			headers: jsonHeaders(),
			body: JSON.stringify({
				member_id: otherAgentId,
				input_tokens: 75,
				project_id: projectId,
			}),
		});
		expect(res.status).toBe(201);
		const entry = (await res.json()).data;
		expect(entry.project_id).toBe(projectId);
		expect(entry.task_id).toBeNull();
		expect(entry.description).toBe('');
	});

	it('records over-budget usage (never a 402) and reactively pauses the agent', async () => {
		// Give the engineer a window to blow. Agents ship uncapped now, and an
		// unlimited window never trips - so without this there is no over-budget
		// state for the usage below to reach.
		await ctx.db.query(`UPDATE member_agents SET monthly_budget_tokens = 3000 WHERE id = $1`, [
			engineerId,
		]);
		const res = await ctx.app.request(`/api/projects/${projectSlug}/usage`, {
			method: 'POST',
			headers: jsonHeaders(),
			body: JSON.stringify({
				member_id: engineerId,
				input_tokens: 9_999_999,
				description: 'blows the monthly window',
			}),
		});
		expect(res.status).toBe(201);

		// The engineer's own window trips (the project is unlimited), so it lands in
		// the agent-scoped budget-pause state.
		const agent = await ctx.db.query<{ runtime_status: string }>(
			`SELECT runtime_status FROM member_agents WHERE id = $1`,
			[engineerId],
		);
		expect(agent.rows[0].runtime_status).toBe('out_of_agent_budget');

		// budget-status now flags the agent (and any agent inherits project overage flags).
		const status = await ctx.app.request(`/api/projects/${projectSlug}/budget-status`, {
			headers: authHeader(token),
		});
		const data = (await status.json()).data;
		const engineer = data.agents.find((a: { agent_id: string }) => a.agent_id === engineerId);
		expect(engineer.agent_over_budget).toBe(true);
		expect(engineer.overBudget).toBe(true);
	});
});
