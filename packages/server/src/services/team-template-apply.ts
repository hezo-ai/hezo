import {
	BUILTIN_AGENT_SLUGS,
	CAPTAIN_AGENT_SLUG,
	CEO_AGENT_SLUG,
	COACH_AGENT_SLUG,
	DocumentType,
	type MarketplaceTeamDef,
	MemberType,
} from '@hezo/shared';
import type { Db } from '../db/database';
import { withTransaction } from '../lib/sql';
import { logger } from '../logger';
import { resolveAgentBudgets } from './agent-budget';
import { enqueueTeamCoherenceReviewTask } from './description-tasks';
import { initAgentSystemPrompt, upsertDocument } from './documents';
import {
	createInlineSkillsFromArray,
	downloadSkillsFromArray,
	insertRosterAgents,
	type ProvisionTeamTemplateResult,
	provisionTeamTemplate,
	type RosterAgentDef,
} from './team-template-provision';
import type { WebSocketManager } from './ws';

const log = logger.child('team-template-apply');

export interface ApplyTemplateOptions {
	dataDir?: string;
	wsManager?: WebSocketManager;
}

export interface ApplyTemplateResult extends ProvisionTeamTemplateResult {
	builtin_inserted_slugs: string[];
	builtin_updated_slugs: string[];
	/** Roster roles the team already had that were refreshed to the new version. */
	updated_slugs?: string[];
}

interface BuiltinEffectiveConfig {
	slug: string;
	agentTypeId: string;
	title: string;
	roleDescription: string;
	defaultSummary: string;
	teamContext: string;
	systemPrompt: string;
	defaultEffort: string;
	heartbeatIntervalMin: number;
	runTimeoutMin: number;
	monthlyBudgetCents: number;
	dailyBudgetCents: number;
	weeklyBudgetCents: number;
	touchesCode: boolean;
}

/**
 * Ensures every builtin agent (the per-team Captain) exists on the team. Missing
 * slugs are inserted from `agent_types` defaults. Existing builtins are left
 * untouched here — template-specific overrides are applied by
 * `applyTemplateToTeam`. The CEO and Coach are instance-level singletons (see
 * `ensureInstanceCeo` / `ensureInstanceCoach`), not seeded per team.
 */
export async function ensureBuiltinAgents(db: Db, teamId: string): Promise<string[]> {
	const inserted: string[] = [];
	for (const slug of BUILTIN_AGENT_SLUGS) {
		const existing = await db.query<{ id: string }>(
			`SELECT ma.id FROM member_agents ma
			 JOIN members m ON m.id = ma.id
			 WHERE m.team_id = $1 AND ma.slug = $2`,
			[teamId, slug],
		);
		if (existing.rows[0]) continue;

		const config = await loadBuiltinDefaults(db, slug);
		if (!config) continue;
		await insertBuiltinAgent(db, teamId, config);
		inserted.push(slug);
	}
	return inserted;
}

/**
 * Ensures a single instance-level singleton agent (by slug) exists. If none
 * exists anywhere yet, it is provisioned into the given team (the HQ/default
 * team). Idempotent — one per instance. Returns the member id (or null if the
 * agent type isn't seeded).
 */
async function ensureInstanceAgent(db: Db, teamId: string, slug: string): Promise<string | null> {
	const existing = await db.query<{ id: string }>(
		`SELECT id FROM member_agents WHERE slug = $1 LIMIT 1`,
		[slug],
	);
	if (existing.rows[0]) return existing.rows[0].id;

	const config = await loadBuiltinDefaults(db, slug);
	if (!config) return null;
	await insertBuiltinAgent(db, teamId, config);

	const created = await db.query<{ id: string }>(
		`SELECT ma.id FROM member_agents ma
		 JOIN members m ON m.id = ma.id
		 WHERE m.team_id = $1 AND ma.slug = $2`,
		[teamId, slug],
	);
	return created.rows[0]?.id ?? null;
}

/** Ensures the single instance-level CEO exists, in the HQ team. */
export function ensureInstanceCeo(db: Db, teamId: string): Promise<string | null> {
	return ensureInstanceAgent(db, teamId, CEO_AGENT_SLUG);
}

/** Ensures the single instance-level Coach exists, in the HQ team. */
export function ensureInstanceCoach(db: Db, teamId: string): Promise<string | null> {
	return ensureInstanceAgent(db, teamId, COACH_AGENT_SLUG);
}

/**
 * Points the given team's Captain at the instance CEO. No-op when there is no
 * CEO yet (e.g. before the default team is seeded) or the team has no Captain,
 * so seed/test paths that never create a CEO stay safe. The CEO lives in the
 * default team, so for other teams this is a cross-team reporting line.
 */
export async function linkTeamCaptainToInstanceCeo(db: Db, teamId: string): Promise<void> {
	const ceo = await db.query<{ id: string }>(
		`SELECT id FROM member_agents WHERE slug = $1 LIMIT 1`,
		[CEO_AGENT_SLUG],
	);
	const ceoId = ceo.rows[0]?.id;
	if (!ceoId) return;

	const captain = await db.query<{ id: string }>(
		`SELECT ma.id FROM member_agents ma
		 JOIN members m ON m.id = ma.id
		 WHERE m.team_id = $1 AND ma.slug = $2`,
		[teamId, CAPTAIN_AGENT_SLUG],
	);
	const captainId = captain.rows[0]?.id;
	if (!captainId || captainId === ceoId) return;

	await db.query(`UPDATE member_agents SET reports_to = $1 WHERE id = $2`, [ceoId, captainId]);
}

/**
 * Applies a team template to an existing team:
 *   1. Ensures the Captain exists (with agent_types defaults if missing).
 *   2. Upserts the Captain with the template's overrides when provided —
 *      existing builtins are refreshed in place so their `member_id` (and any
 *      historical comment authorship) stays stable.
 *   3. Additively inserts any non-builtin agents from the template that the
 *      team doesn't already have. Existing non-builtin slugs are left alone.
 *   4. Records the assignment, copies KB docs, provisions skills if dataDir is
 *      set, and enqueues a Captain coherence-review ticket when the roster
 *      actually changed.
 *
 * Safe to call multiple times across different templates.
 */
export async function applyTemplateToTeam(
	db: Db,
	teamId: string,
	templateId: string,
	options: ApplyTemplateOptions = {},
): Promise<ApplyTemplateResult> {
	const builtinResult = await upsertBuiltinAgentsWithTemplateOverrides(
		db,
		teamId,
		templateId,
		options.wsManager,
	);

	const provisionResult = await provisionTeamTemplate(db, teamId, templateId, {
		skipExistingSlugs: true,
		dataDir: options.dataDir,
	});

	// A first-time apply (initial seed of Captain/Coach) doesn't change a roster
	// that previously existed — Captain has nothing to reconcile yet. Only fire
	// the coherence review when something on an EXISTING roster changed: a builtin
	// got upgraded, or non-builtin agents were added on top of an existing team.
	const rosterChanged =
		provisionResult.created_slugs.length > 0 || builtinResult.updated_slugs.length > 0;

	if (rosterChanged) {
		try {
			await enqueueTeamCoherenceReviewTask(db, teamId, 'template_applied');
		} catch (e) {
			log.error('Failed to enqueue team coherence review after template apply:', e);
		}
	}

	return {
		created_slugs: provisionResult.created_slugs,
		skipped_slugs: provisionResult.skipped_slugs,
		builtin_inserted_slugs: builtinResult.inserted_slugs,
		builtin_updated_slugs: builtinResult.updated_slugs,
	};
}

interface BuiltinUpsertResult {
	inserted_slugs: string[];
	updated_slugs: string[];
}

async function upsertBuiltinAgentsWithTemplateOverrides(
	db: Db,
	teamId: string,
	templateId: string,
	wsManager: WebSocketManager | undefined,
): Promise<BuiltinUpsertResult> {
	const inserted: string[] = [];
	const updated: string[] = [];

	for (const slug of BUILTIN_AGENT_SLUGS) {
		const resolved = await resolveBuiltinEffectiveConfig(db, templateId, slug);
		if (!resolved.config) continue;

		const existing = await db.query<{ id: string }>(
			`SELECT ma.id FROM member_agents ma
			 JOIN members m ON m.id = ma.id
			 WHERE m.team_id = $1 AND ma.slug = $2`,
			[teamId, slug],
		);

		if (existing.rows[0]) {
			if (!resolved.templateProvidesOverride) continue;
			const memberId = existing.rows[0].id;
			const didChange = await updateBuiltinAgent(db, teamId, memberId, resolved.config, wsManager);
			if (didChange) updated.push(slug);
		} else {
			await insertBuiltinAgent(db, teamId, resolved.config);
			inserted.push(slug);
		}
	}

	return { inserted_slugs: inserted, updated_slugs: updated };
}

async function loadBuiltinDefaults(db: Db, slug: string): Promise<BuiltinEffectiveConfig | null> {
	const result = await db.query<{
		id: string;
		name: string;
		role_description: string;
		default_summary: string;
		default_team_context: string;
		system_prompt_template: string;
		default_effort: string;
		heartbeat_interval_min: number;
		run_timeout_min: number;
		monthly_budget_cents: number;
		touches_code: boolean;
	}>(
		`SELECT id, name, role_description, default_summary, default_team_context,
		        system_prompt_template, default_effort, heartbeat_interval_min,
		        run_timeout_min, monthly_budget_cents, touches_code
		 FROM agent_types WHERE slug = $1`,
		[slug],
	);
	const base = result.rows[0];
	if (!base) return null;
	return {
		slug,
		agentTypeId: base.id,
		title: base.name,
		roleDescription: base.role_description,
		defaultSummary: base.default_summary ?? '',
		teamContext: base.default_team_context || '',
		systemPrompt: base.system_prompt_template,
		defaultEffort: base.default_effort,
		heartbeatIntervalMin: base.heartbeat_interval_min,
		runTimeoutMin: base.run_timeout_min,
		// No team-type override here — the agent-type monthly default, daily/weekly unlimited.
		...resolveAgentBudgets(base.monthly_budget_cents, null),
		touchesCode: base.touches_code ?? false,
	};
}

async function resolveBuiltinEffectiveConfig(
	db: Db,
	templateId: string,
	slug: string,
): Promise<{ config: BuiltinEffectiveConfig | null; templateProvidesOverride: boolean }> {
	const base = await loadBuiltinDefaults(db, slug);
	if (!base) return { config: null, templateProvidesOverride: false };

	const templateResult = await db.query<{
		builtin_agent_prompts: Record<string, string> | null;
		builtin_agent_team_contexts: Record<string, string> | null;
	}>(
		`SELECT builtin_agent_prompts, builtin_agent_team_contexts
		 FROM team_templates WHERE id = $1`,
		[templateId],
	);
	const tmpl = templateResult.rows[0];

	const joinResult = await db.query<{
		heartbeat_interval_override: number | null;
		monthly_budget_override: number | null;
		daily_budget_override: number | null;
		weekly_budget_override: number | null;
	}>(
		`SELECT ctat.heartbeat_interval_override, ctat.monthly_budget_override,
		        ctat.daily_budget_override, ctat.weekly_budget_override
		 FROM team_template_agent_types ctat
		 JOIN agent_types at ON at.id = ctat.agent_type_id
		 WHERE ctat.team_template_id = $1 AND at.slug = $2`,
		[templateId, slug],
	);
	const join = joinResult.rows[0];

	const promptOverride = tmpl?.builtin_agent_prompts?.[slug] || '';
	const teamContextOverride = tmpl?.builtin_agent_team_contexts?.[slug] || '';
	const templateProvidesOverride = !!join || !!promptOverride || !!teamContextOverride;

	const budgets = resolveAgentBudgets(base.monthlyBudgetCents, join);

	return {
		config: {
			...base,
			teamContext: teamContextOverride || base.teamContext,
			systemPrompt: promptOverride || base.systemPrompt,
			heartbeatIntervalMin: join?.heartbeat_interval_override ?? base.heartbeatIntervalMin,
			monthlyBudgetCents: budgets.monthlyBudgetCents,
			dailyBudgetCents: budgets.dailyBudgetCents,
			weeklyBudgetCents: budgets.weeklyBudgetCents,
		},
		templateProvidesOverride,
	};
}

async function insertBuiltinAgent(
	db: Db,
	teamId: string,
	config: BuiltinEffectiveConfig,
): Promise<void> {
	const memberResult = await db.query<{ id: string }>(
		`INSERT INTO members (team_id, member_type, display_name)
		 VALUES ($1, $2, $3)
		 RETURNING id`,
		[teamId, MemberType.Agent, config.title],
	);
	const memberId = memberResult.rows[0].id;

	await db.query(
		`INSERT INTO member_agents (id, agent_type_id, title, slug, role_description, summary,
		                            team_context,
		                            default_effort, heartbeat_interval_min, run_timeout_min,
		                            monthly_budget_cents, daily_budget_cents, weekly_budget_cents,
		                            touches_code)
		 VALUES ($1, $2, $3, $4, $5, $6, $7, $8::agent_effort, $9, $10, $11, $12, $13, $14)`,
		[
			memberId,
			config.agentTypeId,
			config.title,
			config.slug,
			config.roleDescription,
			config.defaultSummary,
			config.teamContext,
			config.defaultEffort,
			config.heartbeatIntervalMin,
			config.runTimeoutMin,
			config.monthlyBudgetCents,
			config.dailyBudgetCents,
			config.weeklyBudgetCents,
			config.touchesCode,
		],
	);

	await initAgentSystemPrompt(db, teamId, memberId, config.systemPrompt, null);
}

/** True when any builtin metadata or the system prompt actually changed. */
async function updateBuiltinAgent(
	db: Db,
	teamId: string,
	memberId: string,
	config: BuiltinEffectiveConfig,
	wsManager: WebSocketManager | undefined,
): Promise<boolean> {
	const currentResult = await db.query<{
		title: string;
		role_description: string;
		summary: string;
		team_context: string;
		default_effort: string;
		heartbeat_interval_min: number;
		run_timeout_min: number;
		monthly_budget_cents: number;
		daily_budget_cents: number;
		weekly_budget_cents: number;
		touches_code: boolean;
	}>(
		`SELECT title, role_description, summary, team_context, default_effort::text,
		        heartbeat_interval_min, run_timeout_min, monthly_budget_cents,
		        daily_budget_cents, weekly_budget_cents, touches_code
		 FROM member_agents WHERE id = $1`,
		[memberId],
	);
	const current = currentResult.rows[0];

	const metadataChanged =
		!current ||
		current.title !== config.title ||
		current.role_description !== config.roleDescription ||
		current.team_context !== config.teamContext ||
		current.default_effort !== config.defaultEffort ||
		current.heartbeat_interval_min !== config.heartbeatIntervalMin ||
		current.run_timeout_min !== config.runTimeoutMin ||
		current.monthly_budget_cents !== config.monthlyBudgetCents ||
		current.daily_budget_cents !== config.dailyBudgetCents ||
		current.weekly_budget_cents !== config.weeklyBudgetCents ||
		current.touches_code !== config.touchesCode;

	if (metadataChanged) {
		await db.query(
			`UPDATE member_agents
			 SET title = $1,
			     role_description = $2,
			     team_context = $3,
			     default_effort = $4::agent_effort,
			     heartbeat_interval_min = $5,
			     run_timeout_min = $6,
			     monthly_budget_cents = $7,
			     daily_budget_cents = $8,
			     weekly_budget_cents = $9,
			     touches_code = $10
			 WHERE id = $11`,
			[
				config.title,
				config.roleDescription,
				config.teamContext,
				config.defaultEffort,
				config.heartbeatIntervalMin,
				config.runTimeoutMin,
				config.monthlyBudgetCents,
				config.dailyBudgetCents,
				config.weeklyBudgetCents,
				config.touchesCode,
				memberId,
			],
		);

		await db.query(`UPDATE members SET display_name = $1 WHERE id = $2`, [config.title, memberId]);
	}

	const promptDoc = await db.query<{ content: string }>(
		`SELECT content FROM documents
		 WHERE type = $1 AND team_id = $2 AND member_agent_id = $3`,
		[DocumentType.AgentSystemPrompt, teamId, memberId],
	);
	const promptUnchanged = promptDoc.rows[0]?.content === config.systemPrompt;

	if (!promptUnchanged) {
		await upsertDocument(db, wsManager, {
			scope: {
				type: DocumentType.AgentSystemPrompt,
				teamId,
				memberAgentId: memberId,
			},
			content: config.systemPrompt,
			changeSummary: `Updated by team template apply`,
			authorMemberId: null,
		});
	}

	return metadataChanged || !promptUnchanged;
}

/**
 * Ensures the team's Captain exists with a marketplace team's Captain override
 * applied. The Captain stays a builtin (its `agent_type_id` + reports-to-CEO link
 * come from the catalog default); only its system prompt and team context are
 * overridden by the def. Insert-or-update-in-place keeps the member id stable.
 */
export async function ensureBuiltinCaptainFromDef(
	db: Db,
	teamId: string,
	override: { system_prompt?: string; team_context?: string } | null,
	wsManager?: WebSocketManager,
): Promise<{ inserted: boolean; updated: boolean }> {
	const base = await loadBuiltinDefaults(db, CAPTAIN_AGENT_SLUG);
	if (!base) return { inserted: false, updated: false };

	const config: BuiltinEffectiveConfig = {
		...base,
		systemPrompt: override?.system_prompt?.trim() ? override.system_prompt : base.systemPrompt,
		teamContext: override?.team_context?.trim() ? override.team_context : base.teamContext,
	};

	const existing = await db.query<{ id: string }>(
		`SELECT ma.id FROM member_agents ma
		 JOIN members m ON m.id = ma.id
		 WHERE m.team_id = $1 AND ma.slug = $2`,
		[teamId, CAPTAIN_AGENT_SLUG],
	);
	if (existing.rows[0]) {
		const changed = await updateBuiltinAgent(db, teamId, existing.rows[0].id, config, wsManager);
		return { inserted: false, updated: changed };
	}
	await insertBuiltinAgent(db, teamId, config);
	return { inserted: true, updated: false };
}

/**
 * Provisions a marketplace team def onto a team WITHOUT creating any
 * `team_templates` / `agent_types` rows: the Captain via the builtin path (with
 * the def's override), the rest of the roster as inline agents (`agent_type_id`
 * null, like hires), plus the def's inline/downloaded skills. Used by both
 * launch-a-project (fresh team) and add-a-team-to-a-project (existing team, skips
 * roles it already has). `enqueueReconcile` fires a coherence review only when the
 * roster actually changed (off for the launch path, which enqueues its own
 * initial review, and for the CEO add-team task, which reconciles in-task).
 */
export async function applyMarketplaceTeamToTeam(
	db: Db,
	teamId: string,
	teamDef: MarketplaceTeamDef,
	options: {
		dataDir?: string;
		wsManager?: WebSocketManager;
		enqueueReconcile?: boolean;
		/**
		 * Refresh the prose + system prompt of roles the team already has to this
		 * def's versions (a version update), instead of skipping them. The Captain
		 * override always applies in place regardless.
		 */
		refreshExisting?: boolean;
	} = {},
): Promise<ApplyTemplateResult> {
	const captainResult = await ensureBuiltinCaptainFromDef(
		db,
		teamId,
		teamDef.captain,
		options.wsManager,
	);

	const roster: RosterAgentDef[] = teamDef.roster.map((a) => ({
		slug: a.slug,
		title: a.title,
		role_description: a.role_description,
		summary: a.summary,
		team_context: a.team_context,
		system_prompt: a.system_prompt,
		default_effort: a.default_effort,
		heartbeat_interval_min: a.heartbeat_interval_min,
		run_timeout_min: a.run_timeout_min,
		monthly_budget_cents: a.monthly_budget_cents,
		daily_budget_cents: a.daily_budget_cents,
		weekly_budget_cents: a.weekly_budget_cents,
		touches_code: a.touches_code,
		reports_to_slug: a.reports_to_slug,
		// Marketplace roles are not catalog agent types — provisioned inline, like hires.
		agent_type_id: null,
	}));

	let created: string[] = [];
	let updated: string[] = [];
	let skipped: string[] = [];
	await withTransaction(db, async () => {
		const inserted = await insertRosterAgents(db, teamId, roster, {
			skipExistingSlugs: true,
			updateExisting: options.refreshExisting ?? false,
			wsManager: options.wsManager,
		});
		created = inserted.created_slugs;
		updated = inserted.updated_slugs;
		skipped = inserted.skipped_slugs;
		await createInlineSkillsFromArray(db, teamDef.skills_config);
	});

	if (options.dataDir) {
		await downloadSkillsFromArray(db, teamDef.skills_config);
	}

	const rosterChanged = created.length > 0 || updated.length > 0 || captainResult.updated;
	if (options.enqueueReconcile && rosterChanged) {
		try {
			await enqueueTeamCoherenceReviewTask(db, teamId, 'template_applied');
		} catch (e) {
			log.error('Failed to enqueue team coherence review after marketplace apply:', e);
		}
	}

	return {
		created_slugs: created,
		updated_slugs: updated,
		skipped_slugs: skipped,
		builtin_inserted_slugs: captainResult.inserted ? [CAPTAIN_AGENT_SLUG] : [],
		builtin_updated_slugs: captainResult.updated ? [CAPTAIN_AGENT_SLUG] : [],
	};
}
