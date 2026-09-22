import { DEFAULT_TEAM_ID, validateBudgetWindows } from '@hezo/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PgliteDb } from '../src/db/drivers/pglite';
import {
	BUDGET_CONVERSION_META_KEY,
	BUDGET_USAGE_COUNTED_FROM_META_KEY,
	type BudgetConversionRecord,
	FALLBACK_TOKENS_PER_CENT,
} from '../src/db/migrations/code/081_token_budgets';
import { postBudgetConversionNotice } from '../src/services/budget-conversion-notice';
import { createDataPreservationHarness, type DataPreservationHarness } from './helpers/migrate';

const TARGET = '081_token_budgets';

/** A team, its project and one agent member, at the schema before the target. */
async function seedTeam(
	db: PgliteDb,
	opts: { teamId?: string; slug: string; internal?: boolean },
): Promise<{ teamId: string; projectId: string; memberId: string }> {
	const team = await db.query<{ id: string }>(
		`INSERT INTO teams (id, name, slug) VALUES (COALESCE($1::uuid, gen_random_uuid()), $2, $2)
		 RETURNING id`,
		[opts.teamId ?? null, opts.slug],
	);
	const teamId = team.rows[0].id;
	const project = await db.query<{ id: string }>(
		`INSERT INTO projects (team_id, name, slug, task_prefix, is_internal)
		 VALUES ($1, $2, $2, upper(left($2, 2)), $3) RETURNING id`,
		[teamId, opts.slug, opts.internal ?? false],
	);
	const member = await db.query<{ id: string }>(
		`INSERT INTO members (team_id, member_type, display_name)
		 VALUES ($1, 'agent', 'Engineer') RETURNING id`,
		[teamId],
	);
	return { teamId, projectId: project.rows[0].id, memberId: member.rows[0].id };
}

describe('081_token_budgets migration, on an instance with priced history', () => {
	let h: DataPreservationHarness;
	let teamId: string;
	let projectId: string;
	let cappedAgentId: string;
	let unlimitedAgentId: string;
	let agentTypeId: string;
	let templateId: string;
	let approvalId: string;
	let cardId: string;
	let runId: string;
	let wakeupId: string;

	// One run in the window: 1,000,000 input and 100,000 output tokens, priced at
	// $1 and $2 per million, costs $1.20. That is 1,100,000 tokens per 120 cents.
	const TOKENS_PER_CENT = 1_100_000 / 120;
	const toTokens = (cents: number) => Math.round(cents * TOKENS_PER_CENT);
	// A daily $1 implies more than a monthly $30 (365/12 days), so the monthly
	// window is raised to the floor its daily window sets.
	const engineerMonthly = Math.ceil(toTokens(100) * (365 / 12));
	let flooredAgentId: string;
	let runningRunId: string;
	let badApprovalId: string;
	let resolvedBadApprovalId: string;

	beforeAll(async () => {
		h = await createDataPreservationHarness();
		await h.applyUpToExclusive(TARGET);

		({ teamId, projectId, memberId: cappedAgentId } = await seedTeam(h.db, { slug: 'acme' }));
		const other = await h.db.query<{ id: string }>(
			`INSERT INTO members (team_id, member_type, display_name)
			 VALUES ($1, 'agent', 'Designer') RETURNING id`,
			[teamId],
		);
		unlimitedAgentId = other.rows[0].id;

		const type = await h.db.query<{ id: string }>(
			`INSERT INTO agent_types (name, slug, monthly_budget_cents, is_builtin)
			 VALUES ('Custom analyst', 'custom-analyst', 5000, false) RETURNING id`,
		);
		agentTypeId = type.rows[0].id;
		const template = await h.db.query<{ id: string }>(
			`INSERT INTO team_templates (name) VALUES ('Custom team') RETURNING id`,
		);
		templateId = template.rows[0].id;
		await h.db.query(
			`INSERT INTO team_template_agent_types
			   (team_template_id, agent_type_id, monthly_budget_override, daily_budget_override)
			 VALUES ($1, $2, 2000, NULL)`,
			[templateId, agentTypeId],
		);

		await h.db.query(
			`INSERT INTO member_agents
			   (id, title, slug, daily_budget_cents, weekly_budget_cents, monthly_budget_cents)
			 VALUES ($1, 'Engineer', 'engineer', 100, 0, 3000),
			        ($2, 'Designer', 'designer', 0, 0, 0)`,
			[cappedAgentId, unlimitedAgentId],
		);
		await h.db.query(`UPDATE projects SET monthly_budget_cents = 10000 WHERE id = $1`, [projectId]);

		const approval = await h.db.query<{ id: string }>(
			`INSERT INTO approvals (team_id, type, payload)
			 VALUES ($1, 'hire', $2::jsonb) RETURNING id`,
			[
				teamId,
				JSON.stringify({
					title: 'Analyst',
					daily_budget_cents: 0,
					weekly_budget_cents: 0,
					monthly_budget_cents: 1200,
				}),
			],
		);
		approvalId = approval.rows[0].id;
		const task = await h.db.query<{ id: string }>(
			`INSERT INTO tasks (team_id, project_id, number, identifier, title)
			 VALUES ($1, $2, 1, 'AC-1', 'Hire an analyst') RETURNING id`,
			[teamId, projectId],
		);
		const card = await h.db.query<{ id: string }>(
			`INSERT INTO task_comments (task_id, content_type, content)
			 VALUES ($1, 'action', $2::jsonb) RETURNING id`,
			[task.rows[0].id, JSON.stringify({ kind: 'hire_proposal', monthly_budget_cents: 1200 })],
		);
		cardId = card.rows[0].id;

		// Pinned rate for the one model the instance ran. A manual row wins over a
		// feed row for the same model, as the price service ordered them.
		await h.db.query(
			`INSERT INTO model_pricing (model_id, input_per_token, output_per_token, source)
			 VALUES ('test-model', 0.000001, 0.000002, 'manual')
			 ON CONFLICT (model_id, source) DO UPDATE
			   SET input_per_token = EXCLUDED.input_per_token,
			       output_per_token = EXCLUDED.output_per_token`,
		);
		const run = await h.db.query<{ id: string }>(
			`INSERT INTO heartbeat_runs
			   (team_id, member_id, task_id, status, started_at, finished_at, model,
			    input_tokens, output_tokens, cost_cents)
			 VALUES ($1, $2, $3, 'succeeded'::heartbeat_run_status, now() - interval '1 day',
			         now() - interval '1 day', 'test-model', 1000000, 100000, 120)
			 RETURNING id`,
			[teamId, cappedAgentId, task.rows[0].id],
		);
		runId = run.rows[0].id;
		// An old run and a run with no model do not move the rate.
		await h.db.query(
			`INSERT INTO heartbeat_runs
			   (team_id, member_id, status, started_at, model, input_tokens, output_tokens)
			 VALUES ($1, $2, 'succeeded'::heartbeat_run_status, now() - interval '60 days',
			         'test-model', 50000000, 0),
			        ($1, $2, 'succeeded'::heartbeat_run_status, now(), NULL, 7000, 3000)`,
			[teamId, cappedAgentId],
		);
		await h.db.query(
			`INSERT INTO cost_entries (member_id, task_id, project_id, amount_cents, description)
			 VALUES ($1, $2, $3, 120, 'Agent run')`,
			[cappedAgentId, task.rows[0].id, projectId],
		);

		const convo = await h.db.query<{ id: string }>(
			`INSERT INTO chat_conversations (member_id, team_id, project_id, channel)
			 VALUES ($1, $2, $3, 'web') RETURNING id`,
			[cappedAgentId, teamId, projectId],
		);
		await h.db.query(
			`INSERT INTO chat_messages
			   (conversation_id, role, channel, status, content, input_tokens, output_tokens, cost_cents)
			 VALUES ($1, 'assistant', 'web', 'complete', 'hi', 400, 100, 1)`,
			[convo.rows[0].id],
		);

		const wakeup = await h.db.query<{ id: string }>(
			`INSERT INTO agent_wakeup_requests (member_id, team_id, source, status, payload)
			 VALUES ($1, $2, 'heartbeat', 'queued', '{}'::jsonb) RETURNING id`,
			[cappedAgentId, teamId],
		);
		wakeupId = wakeup.rows[0].id;

		// Daily $0.01 and weekly $0.07 round to 9,167 and 64,167 tokens, below the
		// 64,169 that seven days of the daily budget imply.
		const floored = await h.db.query<{ id: string }>(
			`INSERT INTO members (team_id, member_type, display_name)
			 VALUES ($1, 'agent', 'Writer') RETURNING id`,
			[teamId],
		);
		flooredAgentId = floored.rows[0].id;
		await h.db.query(
			`INSERT INTO member_agents
			   (id, title, slug, daily_budget_cents, weekly_budget_cents, monthly_budget_cents)
			 VALUES ($1, 'Writer', 'writer', 1, 7, 31)`,
			[flooredAgentId],
		);

		// A run still going when the old process stopped: its mid-run snapshot is on
		// the row, and startup reconciliation records it, so the rebuild must not.
		const running = await h.db.query<{ id: string }>(
			`INSERT INTO heartbeat_runs
			   (team_id, member_id, status, started_at, input_tokens, output_tokens)
			 VALUES ($1, $2, 'running'::heartbeat_run_status, now(), 900, 90) RETURNING id`,
			[teamId, cappedAgentId],
		);
		runningRunId = running.rows[0].id;

		// An agent wrote these: every value a JSON number cast could choke on.
		const bad = await h.db.query<{ id: string }>(
			`INSERT INTO approvals (team_id, type, payload)
			 VALUES ($1, 'hire', $2::jsonb) RETURNING id`,
			[
				teamId,
				JSON.stringify({
					title: 'Scout',
					daily_budget_cents: 'NaN',
					weekly_budget_cents: true,
					monthly_budget_cents: 1e30,
				}),
			],
		);
		badApprovalId = bad.rows[0].id;
		const resolvedBad = await h.db.query<{ id: string }>(
			`INSERT INTO approvals (team_id, type, status, payload)
			 VALUES ($1, 'hire', 'approved', $2::jsonb) RETURNING id`,
			[teamId, JSON.stringify({ title: 'Old', monthly_budget_cents: -5 })],
		);
		resolvedBadApprovalId = resolvedBad.rows[0].id;

		await h.applyTarget(TARGET);
	});

	afterAll(() => h.close());

	it('converts every non-zero dollar budget at the instance rate', async () => {
		const agent = await h.db.query<{
			daily_budget_tokens: number;
			weekly_budget_tokens: number;
			monthly_budget_tokens: number;
		}>(
			`SELECT daily_budget_tokens, weekly_budget_tokens, monthly_budget_tokens
			 FROM member_agents WHERE id = $1`,
			[cappedAgentId],
		);
		expect(agent.rows[0]).toEqual({
			daily_budget_tokens: toTokens(100),
			weekly_budget_tokens: 0,
			monthly_budget_tokens: engineerMonthly,
		});
		const project = await h.db.query<{ monthly_budget_tokens: number }>(
			`SELECT monthly_budget_tokens FROM projects WHERE id = $1`,
			[projectId],
		);
		expect(project.rows[0].monthly_budget_tokens).toBe(toTokens(10000));
		const type = await h.db.query<{ monthly_budget_tokens: number }>(
			`SELECT monthly_budget_tokens FROM agent_types WHERE id = $1`,
			[agentTypeId],
		);
		expect(type.rows[0].monthly_budget_tokens).toBe(toTokens(5000));
	});

	it('raises a converted window to the floor its shorter windows set', async () => {
		const agent = await h.db.query<{
			daily_budget_tokens: number;
			weekly_budget_tokens: number;
			monthly_budget_tokens: number;
		}>(
			`SELECT daily_budget_tokens, weekly_budget_tokens, monthly_budget_tokens
			 FROM member_agents WHERE id = $1`,
			[flooredAgentId],
		);
		const trio = {
			daily_budget_tokens: Number(agent.rows[0].daily_budget_tokens),
			weekly_budget_tokens: Number(agent.rows[0].weekly_budget_tokens),
			monthly_budget_tokens: Number(agent.rows[0].monthly_budget_tokens),
		};
		expect(trio).toEqual({
			daily_budget_tokens: toTokens(1),
			weekly_budget_tokens: toTokens(1) * 7,
			monthly_budget_tokens: toTokens(31),
		});
		// The budget editor accepts it, so a later edit of any one window is not refused.
		expect(validateBudgetWindows(trio)).toEqual([]);
	});

	it('keeps an unlimited budget unlimited', async () => {
		const agent = await h.db.query<{ daily: number; weekly: number; monthly: number }>(
			`SELECT daily_budget_tokens AS daily, weekly_budget_tokens AS weekly,
			        monthly_budget_tokens AS monthly
			 FROM member_agents WHERE id = $1`,
			[unlimitedAgentId],
		);
		expect(agent.rows[0]).toEqual({ daily: 0, weekly: 0, monthly: 0 });
	});

	it('converts a team-type override and keeps a NULL one inheriting', async () => {
		const row = await h.db.query<{ monthly: number; daily: number | null }>(
			`SELECT monthly_budget_override AS monthly, daily_budget_override AS daily
			 FROM team_template_agent_types WHERE team_template_id = $1`,
			[templateId],
		);
		expect(Number(row.rows[0].monthly)).toBe(toTokens(2000));
		expect(row.rows[0].daily).toBeNull();
	});

	it('converts the budgets inside a pending hire proposal and its card', async () => {
		const approval = await h.db.query<{ payload: Record<string, unknown> }>(
			`SELECT payload FROM approvals WHERE id = $1`,
			[approvalId],
		);
		expect(approval.rows[0].payload).toMatchObject({
			title: 'Analyst',
			daily_budget_tokens: 0,
			weekly_budget_tokens: 0,
			monthly_budget_tokens: toTokens(1200),
		});
		expect(approval.rows[0].payload).not.toHaveProperty('monthly_budget_cents');
	});

	it('leaves a hire budget that is not a dollar amount unlimited, rather than failing', async () => {
		const approvals = await h.db.query<{ id: string; payload: Record<string, unknown> }>(
			`SELECT id, payload FROM approvals WHERE id = ANY($1::uuid[])`,
			[[badApprovalId, resolvedBadApprovalId]],
		);
		for (const row of approvals.rows) {
			expect(row.payload).toMatchObject({
				daily_budget_tokens: 0,
				weekly_budget_tokens: 0,
				monthly_budget_tokens: 0,
			});
			expect(Object.keys(row.payload).some((k) => k.endsWith('_cents'))).toBe(false);
		}
		const card = await h.db.query<{ content: Record<string, unknown> }>(
			`SELECT content FROM task_comments WHERE id = $1`,
			[cardId],
		);
		expect(card.rows[0].content).toEqual({
			kind: 'hire_proposal',
			monthly_budget_tokens: toTokens(1200),
		});
	});

	it('rebuilds the usage ledger in tokens from runs and chat turns', async () => {
		const rows = await h.db.query<{
			description: string;
			input_tokens: number;
			output_tokens: number;
			project_id: string;
		}>(
			`SELECT description, input_tokens, output_tokens, project_id FROM usage_entries
			 WHERE member_id = $1 ORDER BY input_tokens DESC`,
			[cappedAgentId],
		);
		// Every run and chat turn that used tokens, the old run and the unpriced one
		// included: the ledger holds usage, not price.
		// The running run is left to startup reconciliation.
		expect(rows.rows.map((r) => [r.input_tokens, r.output_tokens])).toEqual([
			[50_000_000, 0],
			[1_000_000, 100_000],
			[7000, 3000],
			[400, 100],
		]);
		const running = await h.db.query(`SELECT 1 FROM usage_entries WHERE description = $1`, [
			`Agent run ${runningRunId}`,
		]);
		expect(running.rows).toEqual([]);
		expect(rows.rows.find((r) => r.input_tokens === 1_000_000)?.description).toBe(
			`Agent run ${runId}`,
		);
		// A task-less run is attributed to its team's project.
		expect(new Set(rows.rows.map((r) => r.project_id))).toEqual(new Set([projectId]));
	});

	it('keeps every run and chat message, and drops every dollar column and the price list', async () => {
		const run = await h.db.query<{ input_tokens: number; model: string }>(
			`SELECT input_tokens, model FROM heartbeat_runs WHERE id = $1`,
			[runId],
		);
		expect(run.rows[0]).toEqual({ input_tokens: 1_000_000, model: 'test-model' });
		const chat = await h.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM chat_messages`);
		expect(chat.rows[0].n).toBe(1);

		const dollarColumns = await h.db.query<{ table_name: string; column_name: string }>(
			`SELECT table_name, column_name FROM information_schema.columns
			 WHERE table_schema = 'public'
			   AND (column_name LIKE '%cents%' OR column_name IN ('cost_billed', 'billed'))`,
		);
		expect(dollarColumns.rows).toEqual([]);
		const tables = await h.db.query<{ table_name: string }>(
			`SELECT table_name FROM information_schema.tables
			 WHERE table_schema = 'public' AND table_name IN ('model_pricing', 'cost_entries')`,
		);
		expect(tables.rows).toEqual([]);
	});

	it('adds held_config_id to wakeups without touching the existing rows', async () => {
		const row = await h.db.query<{ status: string; held_config_id: string | null }>(
			`SELECT status::text AS status, held_config_id FROM agent_wakeup_requests WHERE id = $1`,
			[wakeupId],
		);
		expect(row.rows[0]).toEqual({ status: 'queued', held_config_id: null });
	});

	it('records when budgets start counting usage, and adds the decider and notice columns', async () => {
		const meta = await h.db.query<{ at: string }>(
			`SELECT value::timestamptz AS at FROM system_meta WHERE key = $1`,
			[BUDGET_USAGE_COUNTED_FROM_META_KEY],
		);
		expect(Date.now() - new Date(meta.rows[0].at).getTime()).toBeLessThan(60_000);
		const columns = await h.db.query<{ table_name: string; column_name: string }>(
			`SELECT table_name, column_name FROM information_schema.columns
			 WHERE (table_name, column_name) IN (
			   ('task_comments', 'chosen_by_user_id'),
			   ('approvals', 'resolved_by_user_id'),
			   ('approvals', 'resolved_by_api_key_id'),
			   ('member_agents', 'budget_notice_keys'))`,
		);
		expect(columns.rows).toHaveLength(4);
	});

	it('records each conversion, old and new, for the first-boot notice', async () => {
		const meta = await h.db.query<{ value: string }>(
			`SELECT value FROM system_meta WHERE key = $1`,
			[BUDGET_CONVERSION_META_KEY],
		);
		const record = JSON.parse(meta.rows[0].value) as BudgetConversionRecord;
		expect(record.basis).toBe('history');
		expect(record.tokens_per_cent).toBeCloseTo(TOKENS_PER_CENT, 6);
		expect(
			record.conversions
				.map((c) => [c.scope, c.name, c.context, c.window, c.cents, c.tokens])
				.sort(),
		).toEqual(
			[
				['agent', 'Engineer', 'acme', 'daily', 100, toTokens(100)],
				['agent', 'Engineer', 'acme', 'monthly', 3000, engineerMonthly],
				['agent', 'Writer', 'acme', 'daily', 1, toTokens(1)],
				['agent', 'Writer', 'acme', 'weekly', 7, toTokens(1) * 7],
				['agent', 'Writer', 'acme', 'monthly', 31, toTokens(31)],
				['agent_type', 'Custom analyst', null, 'monthly', 5000, toTokens(5000)],
				['team_type', 'Custom analyst', 'Custom team', 'monthly', 2000, toTokens(2000)],
				['hire_proposal', 'Analyst', 'acme', 'monthly', 1200, toTokens(1200)],
				['project', 'acme', null, 'monthly', 10000, toTokens(10000)],
			].sort(),
		);
		// Only the pending proposal's bad values are listed: a resolved one will
		// never become an agent.
		expect(record.invalid.map((b) => [b.id, b.name, b.window, b.value]).sort()).toEqual(
			[
				[badApprovalId, 'Scout', 'daily', '"NaN"'],
				[badApprovalId, 'Scout', 'weekly', 'true'],
				[badApprovalId, 'Scout', 'monthly', '1e+30'],
			].sort(),
		);
	});
});

describe('081_token_budgets migration, on an instance with no priced history', () => {
	let h: DataPreservationHarness;
	let agentId: string;

	beforeAll(async () => {
		h = await createDataPreservationHarness();
		await h.applyUpToExclusive(TARGET);
		const team = await seedTeam(h.db, { teamId: DEFAULT_TEAM_ID, slug: 'hq', internal: true });
		agentId = team.memberId;
		await h.db.query(
			`INSERT INTO member_agents (id, title, slug, weekly_budget_cents)
			 VALUES ($1, 'Engineer', 'engineer', 700)`,
			[agentId],
		);
		await h.db.query(`INSERT INTO users (display_name, is_superuser) VALUES ('Admin', true)`);
		await h.applyTarget(TARGET);
	});

	afterAll(() => h.close());

	it('converts at the stated fallback rate and says so', async () => {
		const agent = await h.db.query<{ weekly_budget_tokens: number }>(
			`SELECT weekly_budget_tokens FROM member_agents WHERE id = $1`,
			[agentId],
		);
		expect(agent.rows[0].weekly_budget_tokens).toBe(700 * FALLBACK_TOKENS_PER_CENT);
		const meta = await h.db.query<{ value: string }>(
			`SELECT value FROM system_meta WHERE key = $1`,
			[BUDGET_CONVERSION_META_KEY],
		);
		const record = JSON.parse(meta.rows[0].value) as BudgetConversionRecord;
		expect(record).toMatchObject({ basis: 'fallback', tokens_per_cent: FALLBACK_TOKENS_PER_CENT });
	});

	it('posts the conversion notice once, @-mentioning the admin, on an unassigned HQ task', async () => {
		await postBudgetConversionNotice(h.db, undefined);
		// A second boot finds no record and posts nothing.
		await postBudgetConversionNotice(h.db, undefined);

		const notices = await h.db.query<{
			id: string;
			content: Record<string, unknown>;
			assignee_id: string | null;
		}>(
			`SELECT tc.id, tc.content, t.assignee_id
			 FROM task_comments tc JOIN tasks t ON t.id = tc.task_id
			 WHERE tc.content->>'kind' = 'budget_conversion'`,
		);
		expect(notices.rows).toHaveLength(1);
		expect(notices.rows[0].assignee_id).toBeNull();
		expect(notices.rows[0].content.text).toContain(
			'The Engineer agent in hq, weekly: $7.00 became 7,000,000 tokens',
		);
		const mentions = await h.db.query<{ n: number }>(
			`SELECT count(*)::int AS n FROM admin_mentions WHERE comment_id = $1`,
			[notices.rows[0].id],
		);
		expect(mentions.rows[0].n).toBe(1);
		const meta = await h.db.query(`SELECT 1 FROM system_meta WHERE key = $1`, [
			BUDGET_CONVERSION_META_KEY,
		]);
		expect(meta.rows).toEqual([]);
	});
});

describe('081_token_budgets migration, on an instance with every budget unlimited', () => {
	let h: DataPreservationHarness;

	beforeAll(async () => {
		h = await createDataPreservationHarness();
		await h.applyUpToExclusive(TARGET);
		const team = await seedTeam(h.db, { slug: 'free' });
		await h.db.query(`INSERT INTO member_agents (id, title, slug) VALUES ($1, 'Engineer', 'eng')`, [
			team.memberId,
		]);
		await h.applyTarget(TARGET);
	});

	afterAll(() => h.close());

	it('records nothing for the first boot to post', async () => {
		const meta = await h.db.query(`SELECT 1 FROM system_meta WHERE key = $1`, [
			BUDGET_CONVERSION_META_KEY,
		]);
		expect(meta.rows).toEqual([]);
	});
});

describe('081_token_budgets migration, on an instance whose models priced by prefix', () => {
	let h: DataPreservationHarness;

	beforeAll(async () => {
		h = await createDataPreservationHarness();
		await h.applyUpToExclusive(TARGET);
		const team = await seedTeam(h.db, { slug: 'prefix' });
		await h.db.query(
			`INSERT INTO member_agents (id, title, slug, monthly_budget_cents)
			 VALUES ($1, 'Engineer', 'engineer', 100)`,
			[team.memberId],
		);
		// The catalog lists the model only undated; the run names a dated variant,
		// which the price service priced by its segment-aligned prefix.
		await h.db.query(
			`INSERT INTO model_pricing (model_id, input_per_token, output_per_token, source)
			 VALUES ('acme-pro', 0.000002, 0.000002, 'manual')`,
		);
		await h.db.query(
			`INSERT INTO heartbeat_runs
			   (team_id, member_id, status, started_at, finished_at, model, input_tokens, output_tokens)
			 VALUES ($1, $2, 'succeeded'::heartbeat_run_status, now() - interval '1 day',
			         now() - interval '1 day', 'acme-pro-0606', 500000, 500000)`,
			[team.teamId, team.memberId],
		);
		await h.applyTarget(TARGET);
	});

	afterAll(() => h.close());

	it('prices the run by prefix, as the price service did, rather than falling back', async () => {
		const meta = await h.db.query<{ value: string }>(
			`SELECT value FROM system_meta WHERE key = $1`,
			[BUDGET_CONVERSION_META_KEY],
		);
		const record = JSON.parse(meta.rows[0].value) as BudgetConversionRecord;
		// 1,000,000 tokens at $2 per million is $2.00: 5,000 tokens per cent.
		expect(record.basis).toBe('history');
		expect(record.tokens_per_cent).toBeCloseTo(5_000, 6);
	});
});
