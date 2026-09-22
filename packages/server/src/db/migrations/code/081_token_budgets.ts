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
 *    rows over feed rows, then a normalized model id, then the nearest
 *    segment-aligned prefix). An instance with no priced run in that window
 *    converts at {@link FALLBACK_TOKENS_PER_CENT}.
 * 2. **Every non-zero dollar budget converted at that rate**, on agents,
 *    projects, agent types and team-type overrides, plus the budgets inside hire
 *    proposals (approvals and the cards that show them). 0 stays unlimited.
 *    Nothing valid is converted to unlimited: that would bring an instance up
 *    healthy with no brake on. A hire proposal's budget that is not a usable
 *    dollar amount (a string, a boolean, a negative or absurd number) becomes
 *    unlimited and is named in the notice, rather than failing the upgrade.
 *    Converted windows are raised to the floors the shorter windows imply, so
 *    rounding each on its own never leaves a trio the budget editor refuses.
 * 3. **The usage ledger rebuilt in tokens** from finished `heartbeat_runs` and
 *    from `chat_messages`, for the usage history. A run still `queued` or
 *    `running` is left to startup reconciliation, which records it once.
 *    `cost_entries` is dropped; it held no tokens and missed every run that
 *    priced to $0. Chat compaction and title usage, and the credential a chat
 *    turn used, were never stored outside it, so the history has neither.
 * 4. **Budgets count usage from this migration on**, recorded in `system_meta`:
 *    usage from before it never counted against a budget on a subscription, so
 *    counting it now would pause agents for spend no budget ever measured.
 * 5. **The conversions recorded** in `system_meta` for the first boot to post as
 *    one notice in the admin's inbox, listing each budget old and new.
 * 6. **`held_config_id`** on wakeups, so a provider usage hold releases only the
 *    wakeups held on the credential it lifted; **`chosen_by_user_id`** on
 *    comments and **`resolved_by_*`** on approvals, so an answered card or a
 *    settled approval says which person, if any, decided it; and
 *    **`budget_notice_key`** on agents, the budget window an agent's last
 *    budget-pause notice was about, so a pause that lifts and returns inside one
 *    window tells the admin once.
 * 7. **Every dollar column and the price list dropped.**
 *
 * A code migration because step 1 resolves model ids the way the price service
 * did, which SQL cannot express. That lookup is copied here, frozen: the service
 * is deleted by the same release. So are the budget window floors, which the
 * shared budget rules may change after this has shipped.
 */

/**
 * The rate used when an instance has no priced run in the last 30 days: one
 * million tokens per dollar. Close to what production measured across its own
 * mix of models and cache reads, and stated in the conversion notice.
 */
export const FALLBACK_TOKENS_PER_CENT = 10_000;

/** The `system_meta` key the first boot reads the conversion notice from. */
export const BUDGET_CONVERSION_META_KEY = 'budget_token_conversion';

/**
 * The `system_meta` key holding the instant budgets count usage from: when this
 * migration ran. Earlier usage stays in the ledger for the charts.
 */
export const BUDGET_USAGE_COUNTED_FROM_META_KEY = 'budget_usage_counted_from';

/**
 * The largest token budget a conversion writes. A budget is validated as a safe
 * integer on every later edit, so a larger one could never be changed again.
 */
const MAX_BUDGET_TOKENS = Number.MAX_SAFE_INTEGER;

const BUDGET_WINDOWS = ['daily', 'weekly', 'monthly'] as const;
type BudgetWindow = (typeof BUDGET_WINDOWS)[number];
type WindowValues = Record<BudgetWindow, number>;

/** One budget as it was and as it became, for the conversion notice. */
export interface BudgetConversion {
	scope: 'agent' | 'project' | 'agent_type' | 'team_type' | 'hire_proposal';
	id: string;
	name: string;
	/**
	 * Where the budget sits, so two lines with one name can be told apart: the
	 * project of an agent or a pending hire, or the team type of an override.
	 * Null for a project or an agent type, whose name says it all.
	 */
	context: string | null;
	window: BudgetWindow;
	cents: number;
	tokens: number;
}

/** A pending hire's budget that was not a usable dollar amount, now unlimited. */
export interface InvalidBudget {
	id: string;
	name: string;
	context: string | null;
	window: BudgetWindow;
	/** What the proposal held, as JSON text. */
	value: string;
}

/** What the migration records for the first boot. */
export interface BudgetConversionRecord {
	tokens_per_cent: number;
	basis: 'history' | 'fallback';
	conversions: BudgetConversion[];
	invalid: InvalidBudget[];
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

/** Model id segment separators: ids break on dashes and version dots. */
const SEGMENT_SEPARATOR = /[-.]/;

/**
 * The price service's prefix match, frozen as it shipped: the length of the
 * longest common prefix of two normalized ids that ends on a segment boundary,
 * so `gpt-5` matches `gpt-5-codex` and `gpt-5.1` does not match `gpt-5.2`.
 */
function segmentPrefixLen(a: string, b: string): number {
	if (a === b) return a.length;
	const [short, long] = a.length <= b.length ? [a, b] : [b, a];
	if (short.length === 0 || !long.startsWith(short)) return 0;
	return SEGMENT_SEPARATOR.test(long[short.length]) ? short.length : 0;
}

/** The nearest priced model by segment-aligned prefix, ties to the shorter then smaller id. */
function resolveByPrefix(norm: string, byNorm: Map<string, PricingRow>): PricingRow | undefined {
	if (!norm) return undefined;
	let bestKey: string | undefined;
	let bestLen = 0;
	for (const key of byNorm.keys()) {
		const len = segmentPrefixLen(norm, key);
		if (len === 0) continue;
		const closer =
			bestKey !== undefined &&
			(key.length !== bestKey.length ? key.length < bestKey.length : key < bestKey);
		if (len > bestLen || (len === bestLen && closer)) {
			bestKey = key;
			bestLen = len;
		}
	}
	return bestKey === undefined ? undefined : byNorm.get(bestKey);
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
		const norm = normalizeModelId(u.model);
		const rate =
			byId.get(u.model.toLowerCase()) ?? byNorm.get(norm) ?? resolveByPrefix(norm, byNorm);
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

/** Cents to tokens at the rate: at least one token for a positive budget, 0 stays 0. */
function centsToTokens(cents: number, tokensPerCent: number): number {
	if (cents <= 0) return 0;
	return Math.min(Math.max(Math.round(cents * tokensPerCent), 1), MAX_BUDGET_TOKENS);
}

/**
 * The shared budget rules' floors, frozen as they shipped: weekly at least 7 x
 * daily, monthly at least daily x 365/12 and weekly x 52/12, each over the
 * enabled windows only. Raises a window to its floor, never lowers one.
 */
function raiseToFloors(t: WindowValues): WindowValues {
	const weekly =
		t.weekly > 0 && t.daily > 0
			? Math.min(Math.max(t.weekly, t.daily * 7), MAX_BUDGET_TOKENS)
			: t.weekly;
	let monthlyFloor = 0;
	if (t.daily > 0) monthlyFloor = Math.max(monthlyFloor, Math.ceil(t.daily * (365 / 12)));
	if (weekly > 0) monthlyFloor = Math.max(monthlyFloor, Math.ceil(weekly * (52 / 12)));
	const monthly =
		t.monthly > 0 ? Math.min(Math.max(t.monthly, monthlyFloor), MAX_BUDGET_TOKENS) : t.monthly;
	return { daily: t.daily, weekly, monthly };
}

/**
 * The same floors as {@link raiseToFloors}, as two UPDATEs over a table's token
 * columns. Doubles on both sides, so the ceilings agree with the JS to the token.
 * A NULL window (a team-type override inheriting) counts as unlimited.
 */
function raiseToFloorsSql(table: string, columns: Record<BudgetWindow, string>): string[] {
	const v = (w: BudgetWindow) => `COALESCE(${columns[w]}, 0)`;
	const monthlyFloor = `GREATEST(
		CASE WHEN ${v('daily')} > 0 THEN ceil(${v('daily')}::float8 * (365::float8 / 12)) ELSE 0 END,
		CASE WHEN ${v('weekly')} > 0 THEN ceil(${v('weekly')}::float8 * (52::float8 / 12)) ELSE 0 END)`;
	return [
		`UPDATE ${table} SET ${columns.weekly} = LEAST(${v('daily')} * 7, ${MAX_BUDGET_TOKENS})
		  WHERE ${v('daily')} > 0 AND ${v('weekly')} > 0 AND ${v('weekly')} < ${v('daily')} * 7`,
		`UPDATE ${table} SET ${columns.monthly} = LEAST(${monthlyFloor}, ${MAX_BUDGET_TOKENS})::bigint
		  WHERE ${v('monthly')} > 0 AND ${v('monthly')} < ${monthlyFloor}`,
	];
}

/**
 * A dollar budget as a hire proposal holds it in JSON: its cents when it is a
 * usable amount, 0 when absent, or null when it is anything else. A proposal is
 * written by an agent, so a string, a boolean or a number no budget could hold
 * is possible and must not fail the upgrade.
 */
function jsonBudgetCents(value: unknown, tokensPerCent: number): number | null {
	if (value === undefined || value === null) return 0;
	if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null;
	return value * tokensPerCent <= MAX_BUDGET_TOKENS ? value : null;
}

/**
 * A column of a team's own project: its name tells two teams apart in the
 * notice, and its id is where a task-less run's usage belongs.
 */
const teamProjectSql = (teamIdExpr: string, column: 'id' | 'name') =>
	`(SELECT p.${column} FROM projects p WHERE p.team_id = ${teamIdExpr}
	   ORDER BY p.is_internal, p.created_at LIMIT 1)`;

interface ConvertedRow {
	scope: BudgetConversion['scope'];
	id: string;
	name: string;
	context: string | null;
	daily_cents: number | null;
	weekly_cents: number | null;
	monthly_cents: number | null;
	daily_tokens: number | null;
	weekly_tokens: number | null;
	monthly_tokens: number | null;
}

/** One notice line per converted window of each row. */
function toConversions(rows: ConvertedRow[]): BudgetConversion[] {
	const out: BudgetConversion[] = [];
	for (const row of rows) {
		for (const window of BUDGET_WINDOWS) {
			const cents = Number(row[`${window}_cents`] ?? 0);
			if (cents <= 0) continue;
			out.push({
				scope: row.scope,
				id: row.id,
				name: row.name,
				context: row.context,
				window,
				cents,
				tokens: Number(row[`${window}_tokens`] ?? 0),
			});
		}
	}
	return out;
}

/**
 * Convert the budgets inside hire proposals. Every hire approval is converted,
 * so a resolved one reads in the new field names too, but only a pending one is
 * listed in the notice: it is the only one still to become an agent. The card
 * showing a proposal takes its approval's monthly budget, so the two agree.
 */
async function convertHireProposals(
	db: Queryable,
	tokensPerCent: number,
): Promise<{ conversions: BudgetConversion[]; invalid: InvalidBudget[] }> {
	const conversions: BudgetConversion[] = [];
	const invalid: InvalidBudget[] = [];
	const approvals = await db.query<{
		id: string;
		status: string;
		payload: Record<string, unknown>;
		context: string | null;
	}>(
		`SELECT a.id, a.status::text AS status, a.payload, ${teamProjectSql('a.team_id', 'name')} AS context
		   FROM approvals a
		  WHERE a.type = 'hire'
		    AND (a.payload ? 'daily_budget_cents' OR a.payload ? 'weekly_budget_cents'
		         OR a.payload ? 'monthly_budget_cents')`,
	);
	const monthlyByApproval = new Map<string, number>();
	for (const approval of approvals.rows) {
		const pending = approval.status === 'pending';
		const name = typeof approval.payload.title === 'string' ? approval.payload.title : '';
		const cents: WindowValues = { daily: 0, weekly: 0, monthly: 0 };
		const converted: WindowValues = { daily: 0, weekly: 0, monthly: 0 };
		for (const window of BUDGET_WINDOWS) {
			const raw = approval.payload[`${window}_budget_cents`];
			const value = jsonBudgetCents(raw, tokensPerCent);
			if (value === null) {
				if (pending) {
					invalid.push({
						id: approval.id,
						name,
						context: approval.context,
						window,
						value: JSON.stringify(raw),
					});
				}
				continue;
			}
			cents[window] = value;
			converted[window] = centsToTokens(value, tokensPerCent);
		}
		const tokens = raiseToFloors(converted);
		monthlyByApproval.set(approval.id, tokens.monthly);

		const payload = { ...approval.payload };
		for (const window of BUDGET_WINDOWS) {
			delete payload[`${window}_budget_cents`];
			payload[`${window}_budget_tokens`] = tokens[window];
			if (pending && cents[window] > 0) {
				conversions.push({
					scope: 'hire_proposal',
					id: approval.id,
					name,
					context: approval.context,
					window,
					cents: cents[window],
					tokens: tokens[window],
				});
			}
		}
		await db.query(`UPDATE approvals SET payload = $2::jsonb WHERE id = $1`, [
			approval.id,
			JSON.stringify(payload),
		]);
	}

	const cards = await db.query<{ id: string; content: Record<string, unknown> }>(
		`SELECT id, content FROM task_comments
		  WHERE content_type = 'action' AND content->>'kind' = 'hire_proposal'
		    AND content ? 'monthly_budget_cents'`,
	);
	for (const card of cards.rows) {
		const { monthly_budget_cents: raw, ...rest } = card.content;
		const approvalId = typeof rest.approval_id === 'string' ? rest.approval_id : null;
		const fromApproval = approvalId ? monthlyByApproval.get(approvalId) : undefined;
		const own = jsonBudgetCents(raw, tokensPerCent);
		const monthly = fromApproval ?? (own === null ? 0 : centsToTokens(own, tokensPerCent));
		await db.query(`UPDATE task_comments SET content = $2::jsonb WHERE id = $1`, [
			card.id,
			JSON.stringify({ ...rest, monthly_budget_tokens: monthly }),
		]);
	}
	return { conversions, invalid };
}

export const migration081TokenBudgets: CodeMigration = {
	// Explicit, stable - a minifier rewriting run.toString() must not shift it.
	checksum: '081_token_budgets_v1',
	run: async (db: Queryable) => {
		const { tokensPerCent, basis } = await instanceRate(db);
		if (!Number.isFinite(tokensPerCent) || tokensPerCent <= 0) {
			throw new Error(`081_token_budgets: computed an unusable rate (${tokensPerCent})`);
		}

		// 2. Budgets. A converted value rounds to the nearest token and never to
		// zero: a positive budget stays a brake, however cheap the instance's mix.
		// Rounded half up, as the JS conversion of hire proposals rounds. The rate
		// is a literal rather than a bind parameter because an ALTER ... USING
		// takes none; it is a number this migration computed, never input.
		const rate = `${tokensPerCent}::float8`;
		const convert = (value: string) =>
			`CASE WHEN ${value} > 0
			      THEN LEAST(GREATEST(floor(${value} * ${rate} + 0.5), 1), ${MAX_BUDGET_TOKENS})::bigint
			      ELSE 0 END`;
		const tokenColumns: Record<BudgetWindow, string> = {
			daily: 'daily_budget_tokens',
			weekly: 'weekly_budget_tokens',
			monthly: 'monthly_budget_tokens',
		};

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
			for (const sql of raiseToFloorsSql(table, tokenColumns)) await db.query(sql);
		}
		await db.query(
			`UPDATE agent_types SET monthly_budget_tokens = ${convert('monthly_budget_cents')}
			  WHERE monthly_budget_cents > 0`,
		);

		// Read back after the floors, before the dollar columns go, so each line
		// states the budget as it now stands.
		const tableRows = await db.query<ConvertedRow>(
			`SELECT 'agent' AS scope, ma.id, COALESCE(NULLIF(ma.human_name, ''), ma.title) AS name,
			        ${teamProjectSql('m.team_id', 'name')} AS context,
			        ma.daily_budget_cents AS daily_cents, ma.weekly_budget_cents AS weekly_cents,
			        ma.monthly_budget_cents AS monthly_cents,
			        ma.daily_budget_tokens AS daily_tokens, ma.weekly_budget_tokens AS weekly_tokens,
			        ma.monthly_budget_tokens AS monthly_tokens
			   FROM member_agents ma
			   JOIN members m ON m.id = ma.id
			  WHERE ma.daily_budget_cents > 0 OR ma.weekly_budget_cents > 0 OR ma.monthly_budget_cents > 0
			 UNION ALL
			 SELECT 'project', p.id, p.name, NULL, p.daily_budget_cents, p.weekly_budget_cents,
			        p.monthly_budget_cents, p.daily_budget_tokens, p.weekly_budget_tokens,
			        p.monthly_budget_tokens
			   FROM projects p
			  WHERE p.daily_budget_cents > 0 OR p.weekly_budget_cents > 0 OR p.monthly_budget_cents > 0
			 UNION ALL
			 SELECT 'agent_type', at.id, at.name, NULL, 0, 0, at.monthly_budget_cents, 0, 0,
			        at.monthly_budget_tokens
			   FROM agent_types at
			  -- A built-in type's default is set by the release on every boot, not
			  -- converted, so it is not the instance's to be told about.
			  WHERE at.monthly_budget_cents > 0 AND NOT at.is_builtin`,
		);

		// Team-type overrides keep their names - nothing in them says cents - and
		// widen to BIGINT, since a token budget outgrows an INTEGER. NULL still
		// means "inherit the agent type's default". Their dollars are read before
		// the conversion replaces them in place.
		const overrideCents = await db.query<{
			id: string;
			daily: number | null;
			weekly: number | null;
			monthly: number | null;
		}>(
			`SELECT id, daily_budget_override AS daily, weekly_budget_override AS weekly,
			        monthly_budget_override AS monthly
			   FROM team_template_agent_types
			  WHERE daily_budget_override > 0 OR weekly_budget_override > 0
			     OR monthly_budget_override > 0`,
		);
		const overrideColumns: Record<BudgetWindow, string> = {
			daily: 'daily_budget_override',
			weekly: 'weekly_budget_override',
			monthly: 'monthly_budget_override',
		};
		for (const column of Object.values(overrideColumns)) {
			await db.query(
				`ALTER TABLE team_template_agent_types
				   ALTER COLUMN ${column} TYPE BIGINT
				   USING CASE WHEN ${column} IS NULL THEN NULL ELSE ${convert(column)} END`,
			);
		}
		for (const sql of raiseToFloorsSql('team_template_agent_types', overrideColumns)) {
			await db.query(sql);
		}
		const overrideTokens = await db.query<{
			id: string;
			name: string;
			context: string;
			daily: number | null;
			weekly: number | null;
			monthly: number | null;
		}>(
			`SELECT tta.id, at.name, tt.name AS context, tta.daily_budget_override AS daily,
			        tta.weekly_budget_override AS weekly, tta.monthly_budget_override AS monthly
			   FROM team_template_agent_types tta
			   JOIN agent_types at ON at.id = tta.agent_type_id
			   JOIN team_templates tt ON tt.id = tta.team_template_id
			  WHERE tta.id = ANY($1::uuid[])`,
			[overrideCents.rows.map((r) => r.id)],
		);
		const centsById = new Map(overrideCents.rows.map((r) => [r.id, r]));
		const overrideRows: ConvertedRow[] = overrideTokens.rows.map((r) => {
			const before = centsById.get(r.id);
			return {
				scope: 'team_type',
				id: r.id,
				name: r.name,
				context: r.context,
				daily_cents: before?.daily ?? null,
				weekly_cents: before?.weekly ?? null,
				monthly_cents: before?.monthly ?? null,
				daily_tokens: r.daily,
				weekly_tokens: r.weekly,
				monthly_tokens: r.monthly,
			};
		});

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

		const hires = await convertHireProposals(db, tokensPerCent);
		const conversions = [
			...toConversions(tableRows.rows),
			...toConversions(overrideRows),
			...hires.conversions,
		];

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
			-- Finished runs only: startup reconciliation fails a run left queued or
			-- running and records its usage then, so rebuilding it here would count
			-- it twice.
			INSERT INTO usage_entries
			  (member_id, task_id, project_id, ai_provider_config_id, provider,
			   input_tokens, output_tokens, description, created_at)
			SELECT hr.member_id, hr.task_id,
			       COALESCE(t.project_id, ${teamProjectSql('hr.team_id', 'id')}),
			       hr.ai_provider_config_id, hr.provider,
			       hr.input_tokens, hr.output_tokens, 'Agent run ' || hr.id,
			       COALESCE(hr.finished_at, hr.started_at, hr.created_at)
			  FROM heartbeat_runs hr
			  LEFT JOIN tasks t ON t.id = hr.task_id
			 WHERE hr.input_tokens + hr.output_tokens > 0
			   AND hr.status NOT IN ('queued', 'running');

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

		// 4. Budgets count from here on.
		await db.query(`INSERT INTO system_meta (key, value) VALUES ($1, now()::text)`, [
			BUDGET_USAGE_COUNTED_FROM_META_KEY,
		]);

		// 6. The credential a provider usage hold was placed for. Released by
		// credential when the hold lifts, so the lookup is indexed; partial, since
		// only held rows carry one. Then who decided a card or an approval, and the
		// window an agent's last budget-pause notice covered.
		await db.exec(`
			ALTER TABLE agent_wakeup_requests
				ADD COLUMN held_config_id UUID REFERENCES ai_provider_configs(id) ON DELETE SET NULL;
			CREATE INDEX idx_wakeups_held_config ON agent_wakeup_requests (held_config_id)
				WHERE held_config_id IS NOT NULL;
			ALTER TABLE task_comments
				ADD COLUMN chosen_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL;
			ALTER TABLE approvals
				ADD COLUMN resolved_by_user_id    UUID REFERENCES users(id) ON DELETE SET NULL,
				ADD COLUMN resolved_by_api_key_id UUID REFERENCES api_keys(id) ON DELETE SET NULL;
			ALTER TABLE member_agents ADD COLUMN budget_notice_key TEXT;
		`);

		// 7. Dollars and prices.
		await db.exec(`
			ALTER TABLE heartbeat_runs DROP COLUMN cost_cents, DROP COLUMN cost_billed;
			ALTER TABLE chat_messages DROP COLUMN cost_cents;
			DROP TABLE model_pricing;
		`);

		// 5. Last, so a failure above leaves no notice about a conversion that
		// rolled back.
		if (conversions.length > 0 || hires.invalid.length > 0) {
			const record: BudgetConversionRecord = {
				tokens_per_cent: tokensPerCent,
				basis,
				conversions,
				invalid: hires.invalid,
			};
			await db.query(`INSERT INTO system_meta (key, value) VALUES ($1, $2)`, [
				BUDGET_CONVERSION_META_KEY,
				JSON.stringify(record),
			]);
		}
	},
};
