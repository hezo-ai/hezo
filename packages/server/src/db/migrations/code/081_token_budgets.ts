import type { Queryable } from '../../database';
import type { CodeMigration } from '../../migrate';

/**
 * Budgets count tokens, and Hezo keeps no price list.
 *
 * Dollar budgets skipped every run on a subscription, and the dollar figure they
 * compared against was wrong wherever a model was missing from the price list,
 * so an instance could spend a whole provider allowance with every budget
 * reading zero. From here a budget counts every token a run sent and received:
 * input, cached input included, plus output.
 *
 * In order:
 *
 * 1. **The instance's own rate.** Tokens per cent over its last 30 days of runs,
 *    priced from `model_pricing` with the lookup the price service used (manual
 *    rows over feed rows, then a normalized model id). An instance with no
 *    priced run in that window converts at {@link FALLBACK_TOKENS_PER_CENT}.
 * 2. **Every non-zero dollar budget converted at that rate**, on agents,
 *    projects, agent types and team-type overrides, plus the budgets inside hire
 *    proposals (pending approvals and the cards that show them). 0 stays
 *    unlimited. Nothing is converted to unlimited: that would bring an instance
 *    up healthy with no brake on.
 * 3. **The usage ledger rebuilt in tokens** from `heartbeat_runs` and
 *    `chat_messages`, so the budget windows are right from the first dispatch
 *    after the upgrade. `cost_entries` is dropped; it held no tokens and missed
 *    every run that priced to $0.
 * 4. **The conversions recorded** in `system_meta` for the first boot to post as
 *    one notice in the admin's inbox, listing each budget old and new.
 * 5. **`held_config_id`** on wakeups, so a provider usage hold releases only the
 *    wakeups held on the credential it lifted.
 * 6. **Every dollar column and the price list dropped.**
 *
 * A code migration because step 1 resolves model ids the way the price service
 * did, which SQL cannot express. That lookup is copied here, frozen: the service
 * is deleted by the same release.
 */

/**
 * The rate used when an instance has no priced run in the last 30 days: one
 * million tokens per dollar. Close to what production measured across its own
 * mix of models and cache reads, and stated in the conversion notice.
 */
export const FALLBACK_TOKENS_PER_CENT = 10_000;

/** The `system_meta` key the first boot reads the conversion notice from. */
export const BUDGET_CONVERSION_META_KEY = 'budget_token_conversion';

/** One budget as it was and as it became, for the conversion notice. */
export interface BudgetConversion {
	scope: 'agent' | 'project' | 'agent_type';
	id: string;
	name: string;
	window: 'daily' | 'weekly' | 'monthly';
	cents: number;
	tokens: number;
}

/** What the migration records for the first boot. */
export interface BudgetConversionRecord {
	tokens_per_cent: number;
	basis: 'history' | 'fallback';
	conversions: BudgetConversion[];
}

interface PricingRow {
	model_id: string;
	source: string;
	input_per_token: number;
	output_per_token: number;
	cache_read_per_token: number | null;
	cache_creation_per_token: number | null;
}

interface ModelUsageRow {
	model: string;
	input: number;
	cache_read: number;
	cache_creation: number;
	output: number;
}

/** The price service's model id normalization, frozen as it shipped. */
function normalizeModelId(id: string): string {
	let s = id.toLowerCase().trim();
	const slash = s.lastIndexOf('/');
	if (slash >= 0) s = s.slice(slash + 1);
	s = s.replace(/\[[^\]]*\]/g, '');
	s = s.replace(/-\d{8}$/, '').replace(/-\d{4}-\d{2}-\d{2}$/, '');
	return s.replaceAll('.', '-');
}

/** Tokens per cent over the instance's recent runs, or the stated fallback. */
async function instanceRate(
	db: Queryable,
): Promise<{ tokensPerCent: number; basis: 'history' | 'fallback' }> {
	const pricing = await db.query<PricingRow>(
		`SELECT model_id, source, input_per_token, output_per_token,
		        cache_read_per_token, cache_creation_per_token
		   FROM model_pricing`,
	);
	// Manual rows are applied last so they win, as the service ordered them.
	const byId = new Map<string, PricingRow>();
	const byNorm = new Map<string, PricingRow>();
	for (const row of [...pricing.rows].sort(
		(a, b) => Number(a.source === 'manual') - Number(b.source === 'manual'),
	)) {
		byId.set(row.model_id.toLowerCase(), row);
		byNorm.set(normalizeModelId(row.model_id), row);
	}

	// One row per model: the window is summed in the database, not in memory.
	const usage = await db.query<ModelUsageRow>(
		`SELECT model,
		        sum(input_tokens)::float8 AS input,
		        sum(COALESCE(cache_read_tokens, 0))::float8 AS cache_read,
		        sum(COALESCE(cache_creation_tokens, 0))::float8 AS cache_creation,
		        sum(output_tokens)::float8 AS output
		   FROM heartbeat_runs
		  WHERE model IS NOT NULL
		    AND started_at > now() - interval '30 days'
		    AND input_tokens + output_tokens > 0
		  GROUP BY model`,
	);

	let tokens = 0;
	let cents = 0;
	for (const u of usage.rows) {
		const rate = byId.get(u.model.toLowerCase()) ?? byNorm.get(normalizeModelId(u.model));
		if (!rate) continue;
		const uncached = Math.max(0, u.input - u.cache_read - u.cache_creation);
		const dollars =
			uncached * rate.input_per_token +
			u.cache_read * (rate.cache_read_per_token ?? rate.input_per_token) +
			u.cache_creation * (rate.cache_creation_per_token ?? rate.input_per_token) +
			u.output * rate.output_per_token;
		if (dollars <= 0) continue;
		tokens += u.input + u.output;
		cents += dollars * 100;
	}
	if (cents <= 0 || tokens <= 0) {
		return { tokensPerCent: FALLBACK_TOKENS_PER_CENT, basis: 'fallback' };
	}
	return { tokensPerCent: tokens / cents, basis: 'history' };
}

/** The non-zero dollar budgets that are about to be converted, for the notice. */
async function listConversions(db: Queryable, tokensPerCent: number): Promise<BudgetConversion[]> {
	const rows = await db.query<{
		scope: BudgetConversion['scope'];
		id: string;
		name: string;
		daily: number;
		weekly: number;
		monthly: number;
	}>(
		`SELECT 'agent' AS scope, ma.id, COALESCE(NULLIF(ma.human_name, ''), ma.title) AS name,
		        ma.daily_budget_cents AS daily, ma.weekly_budget_cents AS weekly,
		        ma.monthly_budget_cents AS monthly
		   FROM member_agents ma
		  WHERE ma.daily_budget_cents > 0 OR ma.weekly_budget_cents > 0 OR ma.monthly_budget_cents > 0
		 UNION ALL
		 SELECT 'project', p.id, p.name, p.daily_budget_cents, p.weekly_budget_cents,
		        p.monthly_budget_cents
		   FROM projects p
		  WHERE p.daily_budget_cents > 0 OR p.weekly_budget_cents > 0 OR p.monthly_budget_cents > 0
		 UNION ALL
		 SELECT 'agent_type', at.id, at.name, 0, 0, at.monthly_budget_cents
		   FROM agent_types at
		  -- A built-in type's default is set by the release on every boot, not
		  -- converted, so it is not the instance's to be told about.
		  WHERE at.monthly_budget_cents > 0 AND NOT at.is_builtin`,
	);
	const out: BudgetConversion[] = [];
	for (const row of rows.rows) {
		for (const window of ['daily', 'weekly', 'monthly'] as const) {
			const cents = Number(row[window]);
			if (cents <= 0) continue;
			out.push({
				scope: row.scope,
				id: row.id,
				name: row.name,
				window,
				cents,
				tokens: Math.max(1, Math.round(cents * tokensPerCent)),
			});
		}
	}
	return out;
}

export const migration081TokenBudgets: CodeMigration = {
	// Explicit, stable - a minifier rewriting run.toString() must not shift it.
	checksum: '081_token_budgets_v1',
	run: async (db: Queryable) => {
		const { tokensPerCent, basis } = await instanceRate(db);
		if (!Number.isFinite(tokensPerCent) || tokensPerCent <= 0) {
			throw new Error(`081_token_budgets: computed an unusable rate (${tokensPerCent})`);
		}
		const conversions = await listConversions(db, tokensPerCent);

		// 1-2. Budgets. A converted value rounds to the nearest token and never to
		// zero: a positive budget stays a brake, however cheap the instance's mix.
		// The rate is a literal rather than a bind parameter because an ALTER ...
		// USING takes none; it is a number this migration computed, never input.
		const rate = `${tokensPerCent}::float8`;
		const convert = (value: string) =>
			`CASE WHEN ${value} > 0 THEN GREATEST(round(${value} * ${rate}), 1)::bigint ELSE 0 END`;

		await db.exec(`
			ALTER TABLE member_agents
				ADD COLUMN daily_budget_tokens   BIGINT NOT NULL DEFAULT 0,
				ADD COLUMN weekly_budget_tokens  BIGINT NOT NULL DEFAULT 0,
				ADD COLUMN monthly_budget_tokens BIGINT NOT NULL DEFAULT 0;
			ALTER TABLE projects
				ADD COLUMN daily_budget_tokens   BIGINT NOT NULL DEFAULT 0,
				ADD COLUMN weekly_budget_tokens  BIGINT NOT NULL DEFAULT 0,
				ADD COLUMN monthly_budget_tokens BIGINT NOT NULL DEFAULT 0;
			ALTER TABLE agent_types
				ADD COLUMN monthly_budget_tokens BIGINT NOT NULL DEFAULT 0;
		`);
		for (const table of ['member_agents', 'projects']) {
			await db.query(
				`UPDATE ${table}
				    SET daily_budget_tokens = ${convert('daily_budget_cents')},
				        weekly_budget_tokens = ${convert('weekly_budget_cents')},
				        monthly_budget_tokens = ${convert('monthly_budget_cents')}
				  WHERE daily_budget_cents > 0 OR weekly_budget_cents > 0 OR monthly_budget_cents > 0`,
			);
		}
		await db.query(
			`UPDATE agent_types SET monthly_budget_tokens = ${convert('monthly_budget_cents')}
			  WHERE monthly_budget_cents > 0`,
		);
		// Team-type overrides keep their names - nothing in them says cents - and
		// widen to BIGINT, since a token budget outgrows an INTEGER. NULL still
		// means "inherit the agent type's default".
		for (const column of [
			'monthly_budget_override',
			'daily_budget_override',
			'weekly_budget_override',
		]) {
			await db.query(
				`ALTER TABLE team_template_agent_types
				   ALTER COLUMN ${column} TYPE BIGINT
				   USING CASE WHEN ${column} IS NULL THEN NULL ELSE ${convert(column)} END`,
			);
		}
		await db.exec(`
			ALTER TABLE member_agents
				DROP COLUMN daily_budget_cents,
				DROP COLUMN weekly_budget_cents,
				DROP COLUMN monthly_budget_cents;
			ALTER TABLE projects
				DROP COLUMN daily_budget_cents,
				DROP COLUMN weekly_budget_cents,
				DROP COLUMN monthly_budget_cents;
			ALTER TABLE agent_types DROP COLUMN monthly_budget_cents;
		`);

		// Hire proposals carry their budgets in JSON: the approval's payload, which
		// becomes the agent on approval, and the card showing it on the task.
		for (const window of ['daily', 'weekly', 'monthly']) {
			const cents = `${window}_budget_cents`;
			const tokens = `${window}_budget_tokens`;
			const value = `COALESCE((payload->>'${cents}')::float8, 0)`;
			await db.query(
				`UPDATE approvals
				    SET payload = (payload - '${cents}') || jsonb_build_object('${tokens}', ${convert(value)})
				  WHERE type = 'hire' AND payload ? '${cents}'`,
			);
		}
		const cardValue = `COALESCE((content->>'monthly_budget_cents')::float8, 0)`;
		await db.query(
			`UPDATE task_comments
			    SET content = (content - 'monthly_budget_cents')
			                  || jsonb_build_object('monthly_budget_tokens', ${convert(cardValue)})
			  WHERE content_type = 'action' AND content->>'kind' = 'hire_proposal'
			    AND content ? 'monthly_budget_cents'`,
		);

		// 3. The usage ledger, in tokens, rebuilt from the rows that carry them.
		await db.exec(`
			CREATE TABLE usage_entries (
				id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
				member_id             UUID NOT NULL REFERENCES members(id) ON DELETE CASCADE,
				task_id               UUID REFERENCES tasks(id) ON DELETE SET NULL,
				project_id            UUID REFERENCES projects(id) ON DELETE SET NULL,
				ai_provider_config_id UUID REFERENCES ai_provider_configs(id) ON DELETE SET NULL,
				provider              ai_provider,
				input_tokens          BIGINT NOT NULL DEFAULT 0,
				output_tokens         BIGINT NOT NULL DEFAULT 0,
				description           TEXT NOT NULL DEFAULT '',
				created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
			);
			-- The budget windows sum an entity's rows over a created_at range, per
			-- dispatch and per run completion.
			CREATE INDEX idx_usage_member_created  ON usage_entries (member_id, created_at);
			CREATE INDEX idx_usage_project_created ON usage_entries (project_id, created_at);
			CREATE INDEX idx_usage_task            ON usage_entries (task_id);
			CREATE INDEX idx_usage_provider_config ON usage_entries (ai_provider_config_id);

			-- A run's project is its task's, or for a task-less run its team's own.
			INSERT INTO usage_entries
			  (member_id, task_id, project_id, ai_provider_config_id, provider,
			   input_tokens, output_tokens, description, created_at)
			SELECT hr.member_id, hr.task_id,
			       COALESCE(t.project_id,
			                (SELECT p.id FROM projects p WHERE p.team_id = hr.team_id
			                  ORDER BY p.is_internal, p.created_at LIMIT 1)),
			       hr.ai_provider_config_id, hr.provider,
			       hr.input_tokens, hr.output_tokens, 'Agent run ' || hr.id,
			       COALESCE(hr.finished_at, hr.started_at, hr.created_at)
			  FROM heartbeat_runs hr
			  LEFT JOIN tasks t ON t.id = hr.task_id
			 WHERE hr.input_tokens + hr.output_tokens > 0;

			INSERT INTO usage_entries
			  (member_id, project_id, input_tokens, output_tokens, description, created_at)
			SELECT COALESCE(m.author_member_id, c.member_id), c.project_id,
			       m.input_tokens, m.output_tokens, 'Chat turn',
			       COALESCE(m.completed_at, m.created_at)
			  FROM chat_messages m
			  JOIN chat_conversations c ON c.id = m.conversation_id
			 WHERE m.input_tokens + m.output_tokens > 0;

			DROP TABLE cost_entries;
		`);

		// 5. The credential a provider usage hold was placed for. Released by
		// credential when the hold lifts, so the lookup is indexed; partial, since
		// only held rows carry one.
		await db.exec(`
			ALTER TABLE agent_wakeup_requests
				ADD COLUMN held_config_id UUID REFERENCES ai_provider_configs(id) ON DELETE SET NULL;
			CREATE INDEX idx_wakeups_held_config ON agent_wakeup_requests (held_config_id)
				WHERE held_config_id IS NOT NULL;
		`);

		// 6. Dollars and prices.
		await db.exec(`
			ALTER TABLE heartbeat_runs DROP COLUMN cost_cents, DROP COLUMN cost_billed;
			ALTER TABLE chat_messages DROP COLUMN cost_cents;
			DROP TABLE model_pricing;
		`);

		// 4. Last, so a failure above leaves no notice about a conversion that
		// rolled back.
		if (conversions.length > 0) {
			const record: BudgetConversionRecord = { tokens_per_cent: tokensPerCent, basis, conversions };
			await db.query(`INSERT INTO system_meta (key, value) VALUES ($1, $2)`, [
				BUDGET_CONVERSION_META_KEY,
				JSON.stringify(record),
			]);
		}
	},
};
