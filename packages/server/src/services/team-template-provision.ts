import { createHash } from 'node:crypto';
import {
	type AgentGender,
	type AvatarSpec,
	DocumentType,
	inferGender,
	MemberType,
	makeAvatarSpec,
} from '@hezo/shared';
import type { Db } from '../db/database';
import { deriveSkillSummary } from '../lib/skill-summary';
import { toSlug } from '../lib/slug';
import { withTransaction } from '../lib/sql';
import { logger } from '../logger';
import { resolveAgentBudgets } from './agent-budget';
import { initAgentSystemPrompt, upsertDocument } from './documents';
import { downloadSkillContent, SkillDownloadError } from './skill-downloader';
import type { WebSocketManager } from './ws';

/**
 * A template skill entry is either inline (carries `content`) or downloaded
 * (carries `source_url`). `name`/`title` are interchangeable for backwards
 * compatibility with older template configs.
 */
export interface TemplateSkillConfig {
	name?: string;
	title?: string;
	slug?: string;
	description?: string;
	content?: string;
	source_url?: string;
}

const log = logger.child('team-template-provision');

interface AgentTypeRow {
	id: string;
	name: string;
	slug: string;
	role_description: string;
	default_summary: string;
	default_team_context: string;
	system_prompt_template: string;
	default_effort: string;
	heartbeat_interval_min: number;
	run_timeout_min: number;
	monthly_budget_cents: number;
	touches_code: boolean;
	reports_to_slug: string | null;
	heartbeat_interval_override: number | null;
	monthly_budget_override: number | null;
	daily_budget_override: number | null;
	weekly_budget_override: number | null;
}

/**
 * A single roster agent to provision onto a team, with all its config already
 * resolved. The neutral shape shared by both provisioning sources: DB team
 * templates (mapped from `AgentTypeRow`, `agent_type_id` set) and marketplace
 * teams (mapped from the fetched JSON, `agent_type_id` null — like a hired agent).
 * Array order is the intended provisioning order; `reports_to_slug` references a
 * sibling roster slug or an agent already on the team (e.g. the Captain, which
 * the marketplace path provisions separately as a builtin) — wired in a second pass.
 */
export interface RosterAgentDef {
	slug: string;
	title: string;
	/**
	 * The role's shipped human name, or null for a role that stays name-only.
	 * Marketplace roles carry one; DB team templates do not, and their agents are
	 * named later by the CEO/Captain during the team setup pass.
	 */
	human_name?: string | null;
	gender?: AgentGender | null;
	/** The role's shipped avatar. Generated per member when the source has none. */
	avatar_spec?: AvatarSpec | null;
	role_description: string;
	summary: string;
	team_context: string;
	system_prompt: string;
	default_effort: string;
	heartbeat_interval_min: number;
	run_timeout_min: number;
	monthly_budget_cents: number;
	daily_budget_cents: number;
	weekly_budget_cents: number;
	touches_code: boolean;
	reports_to_slug: string | null;
	agent_type_id: string | null;
}

export interface ProvisionTeamTemplateResult {
	created_slugs: string[];
	skipped_slugs: string[];
}

async function loadTemplateAgentTypes(db: Db, templateIds: string[]): Promise<AgentTypeRow[]> {
	const allRows: AgentTypeRow[] = [];
	for (const typeId of templateIds) {
		const joinRows = await db.query<AgentTypeRow>(
			`SELECT at.id, at.name, at.slug, at.role_description, at.default_summary,
			        at.default_team_context, at.system_prompt_template,
			        at.default_effort, at.heartbeat_interval_min, at.run_timeout_min,
			        at.monthly_budget_cents, at.touches_code,
			        ctat.reports_to_slug,
			        ctat.heartbeat_interval_override, ctat.monthly_budget_override,
				        ctat.daily_budget_override, ctat.weekly_budget_override
			 FROM team_template_agent_types ctat
			 JOIN agent_types at ON at.id = ctat.agent_type_id
			 WHERE ctat.team_template_id = $1
			 ORDER BY ctat.sort_order ASC`,
			[typeId],
		);
		allRows.push(...joinRows.rows);
	}

	const seen = new Set<string>();
	const dedupedRows: AgentTypeRow[] = [];
	for (const row of allRows) {
		if (!seen.has(row.id)) {
			seen.add(row.id);
			dedupedRows.push(row);
		}
	}
	return dedupedRows;
}

/** Map a DB agent-type join row to the neutral roster shape (budgets/heartbeat resolved). */
function agentTypeRowToRosterDef(row: AgentTypeRow): RosterAgentDef {
	const budgets = resolveAgentBudgets(row.monthly_budget_cents, row);
	return {
		slug: row.slug,
		title: row.name,
		role_description: row.role_description,
		summary: row.default_summary ?? '',
		team_context: row.default_team_context ?? '',
		system_prompt: row.system_prompt_template,
		default_effort: row.default_effort,
		heartbeat_interval_min: row.heartbeat_interval_override ?? row.heartbeat_interval_min,
		run_timeout_min: row.run_timeout_min,
		monthly_budget_cents: budgets.monthlyBudgetCents,
		daily_budget_cents: budgets.dailyBudgetCents,
		weekly_budget_cents: budgets.weeklyBudgetCents,
		touches_code: row.touches_code ?? false,
		reports_to_slug: row.reports_to_slug,
		agent_type_id: row.id,
	};
}

/**
 * Refresh an existing roster member's descriptive fields + system prompt from a
 * def — used when re-importing a marketplace team the project already has (a
 * version update). Deliberately leaves operational tuning (effort, budgets,
 * heartbeat, run timeout, touches_code) as the admin set it; only the
 * template-authored prose is refreshed.
 *
 * Identity (`human_name`, `gender`, `avatar_spec`) is left alone for the same
 * reason: a project that renamed an agent or regenerated its face has made that
 * agent its own, and a team version bump must not rename someone the admin has
 * been working with. New projects still get the team's shipped identity, since
 * that path inserts rather than refreshes.
 */
async function refreshRosterAgent(
	db: Db,
	teamId: string,
	memberId: string,
	def: RosterAgentDef,
	wsManager?: WebSocketManager,
): Promise<void> {
	await db.query(
		`UPDATE member_agents
		 SET title = $1, role_description = $2, summary = $3, team_context = $4
		 WHERE id = $5`,
		[def.title, def.role_description, def.summary ?? '', def.team_context ?? '', memberId],
	);
	// Mirrors whatever the agent is displayed as: its own name once it has one,
	// otherwise the (possibly refreshed) role.
	await db.query(
		`UPDATE members SET display_name = COALESCE(NULLIF(
		   (SELECT human_name FROM member_agents WHERE id = $2), ''), $1)
		 WHERE id = $2`,
		[def.title, memberId],
	);
	await upsertDocument(db, wsManager, {
		scope: { type: DocumentType.AgentSystemPrompt, teamId, memberAgentId: memberId },
		content: def.system_prompt,
		changeSummary: 'Refreshed from marketplace team update',
		authorMemberId: null,
	});
}

/**
 * Insert a roster of agents onto a team and wire their reporting lines. Shared by
 * the DB-template and marketplace provisioning paths. For a slug the team already
 * has: with `updateExisting` the member's prose + prompt are refreshed (a version
 * update); otherwise it is skipped (when `skipExistingSlugs`, default true).
 * Existing members always contribute their id to the reports_to map. MUST run
 * inside the caller's transaction. Does not touch `team_template_assignments` or
 * skills — those stay source-specific.
 */
export async function insertRosterAgents(
	db: Db,
	teamId: string,
	roster: RosterAgentDef[],
	options?: { skipExistingSlugs?: boolean; updateExisting?: boolean; wsManager?: WebSocketManager },
): Promise<{
	created_slugs: string[];
	updated_slugs: string[];
	skipped_slugs: string[];
	slugToMemberId: Map<string, string>;
}> {
	const skipExistingSlugs = options?.skipExistingSlugs ?? true;
	const updateExisting = options?.updateExisting ?? false;

	const existingSlugRows = await db.query<{ slug: string; id: string }>(
		`SELECT ma.slug, ma.id FROM member_agents ma
		 JOIN members m ON m.id = ma.id
		 WHERE m.team_id = $1`,
		[teamId],
	);
	const existingSlugToId = new Map(existingSlugRows.rows.map((r) => [r.slug, r.id]));

	const createdSlugs: string[] = [];
	const updatedSlugs: string[] = [];
	const skippedSlugs: string[] = [];
	const slugToMemberId = new Map<string, string>();

	for (const def of roster) {
		const existingId = existingSlugToId.get(def.slug);
		if (existingId && updateExisting) {
			slugToMemberId.set(def.slug, existingId);
			await refreshRosterAgent(db, teamId, existingId, def, options?.wsManager);
			updatedSlugs.push(def.slug);
			continue;
		}
		if (skipExistingSlugs && existingId) {
			skippedSlugs.push(def.slug);
			slugToMemberId.set(def.slug, existingId);
			continue;
		}

		const humanName = def.human_name?.trim() || null;
		const memberResult = await db.query<{ id: string }>(
			`INSERT INTO members (team_id, member_type, display_name)
			 VALUES ($1, $2, $3)
			 RETURNING id`,
			[teamId, MemberType.Agent, humanName ?? def.title],
		);
		const memberId = memberResult.rows[0].id;
		slugToMemberId.set(def.slug, memberId);
		createdSlugs.push(def.slug);

		const gender = def.gender ?? inferGender(humanName);
		// A source with no authored avatar (a DB team template) still gets one, seeded
		// from the member id so it is unique to this agent rather than shared by every
		// project provisioned from the same template.
		const avatarSpec =
			def.avatar_spec ??
			makeAvatarSpec({ seed: memberId, gender, roleSlug: def.slug, roleTitle: def.title });

		await db.query(
			`INSERT INTO member_agents (id, agent_type_id, title, slug, human_name, human_name_slug,
			                            gender, avatar_spec, role_description, summary,
			                            team_context,
			                            default_effort, heartbeat_interval_min, run_timeout_min,
			                            monthly_budget_cents, daily_budget_cents, weekly_budget_cents,
			                            touches_code)
			 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::agent_effort, $13, $14, $15,
			         $16, $17, $18)`,
			[
				memberId,
				def.agent_type_id,
				def.title,
				def.slug,
				humanName,
				humanName ? toSlug(humanName) : null,
				gender,
				JSON.stringify(avatarSpec),
				def.role_description,
				def.summary ?? '',
				def.team_context ?? '',
				def.default_effort,
				def.heartbeat_interval_min,
				def.run_timeout_min,
				def.monthly_budget_cents,
				def.daily_budget_cents,
				def.weekly_budget_cents,
				def.touches_code ?? false,
			],
		);

		await initAgentSystemPrompt(db, teamId, memberId, def.system_prompt, null);
	}

	for (const def of roster) {
		if (def.reports_to_slug && def.reports_to_slug !== 'admin') {
			// Resolve against the roster first, then any agent already on the team —
			// the Captain is provisioned as a builtin before the roster (never inside
			// it on the marketplace path), so a `reports_to_slug: "captain"` must fall
			// back to the existing-members map or the reporting line is silently lost.
			const reportsToId =
				slugToMemberId.get(def.reports_to_slug) ?? existingSlugToId.get(def.reports_to_slug);
			const memberId = slugToMemberId.get(def.slug);
			if (reportsToId && memberId) {
				await db.query('UPDATE member_agents SET reports_to = $1 WHERE id = $2', [
					reportsToId,
					memberId,
				]);
			}
		}
	}

	return {
		created_slugs: createdSlugs,
		updated_slugs: updatedSlugs,
		skipped_slugs: skippedSlugs,
		slugToMemberId,
	};
}

async function loadTemplateSkills(db: Db, templateId: string): Promise<TemplateSkillConfig[]> {
	const result = await db.query<{ skills_config: TemplateSkillConfig[] }>(
		'SELECT skills_config FROM team_templates WHERE id = $1',
		[templateId],
	);
	return result.rows[0]?.skills_config ?? [];
}

function templateSkillName(skill: TemplateSkillConfig): string {
	return (skill.name ?? skill.title ?? '').trim();
}

/**
 * Provision inline skills (those carrying `content`) directly into the global
 * skills database. No network — safe to run inside a provisioning transaction.
 */
export async function createInlineSkillsFromArray(
	db: Db,
	skills: TemplateSkillConfig[],
): Promise<void> {
	for (const skill of skills) {
		if (!skill.content) continue;
		const name = templateSkillName(skill);
		const slug = skill.slug?.trim() || toSlug(name);
		if (!name || !slug) continue;
		const description = skill.description?.trim() || deriveSkillSummary(skill.content);
		const hash = createHash('sha256').update(skill.content).digest('hex');
		await db.query(
			`INSERT INTO skills (name, slug, description, content, content_hash)
			 VALUES ($1, $2, $3, $4, $5)
			 ON CONFLICT (slug) WHERE project_id IS NULL DO NOTHING`,
			[name, slug, description, skill.content, hash],
		);
	}
}

/**
 * Provision downloaded skills (those carrying `source_url`) by fetching each from
 * its source. Runs outside the transaction because it makes network calls.
 */
export async function downloadSkillsFromArray(
	db: Db,
	skills: TemplateSkillConfig[],
): Promise<void> {
	for (const skill of skills) {
		if (!skill.source_url) continue;
		const name = templateSkillName(skill);
		const slug = skill.slug?.trim() || toSlug(name);
		if (!name || !slug) continue;
		try {
			const { content, hash } = await downloadSkillContent(skill.source_url);
			const description = skill.description?.trim() || deriveSkillSummary(content);
			await db.query(
				`INSERT INTO skills (name, slug, description, content, source_url, content_hash)
				 VALUES ($1, $2, $3, $4, $5, $6)
				 ON CONFLICT (slug) WHERE project_id IS NULL DO NOTHING`,
				[name, slug, description, content, skill.source_url, hash],
			);
		} catch (e) {
			if (e instanceof SkillDownloadError) {
				log.warn(`Failed to download template skill "${name}": ${e.message}`);
				continue;
			}
			throw e;
		}
	}
}

/** Back-compat wrapper: provision a DB template's inline skills. */
async function createInlineSkillsFromTemplate(db: Db, templateId: string): Promise<void> {
	await createInlineSkillsFromArray(db, await loadTemplateSkills(db, templateId));
}

/** Provision a DB template's downloaded skills. Runs outside the transaction. */
export async function createSkillsFromTemplate(db: Db, templateId: string): Promise<void> {
	await downloadSkillsFromArray(db, await loadTemplateSkills(db, templateId));
}

/**
 * Adds agents (and optional inline/downloaded skills) from a team template onto an existing team.
 * Skips agent slugs that already exist when skipExistingSlugs is true (default).
 */
export async function provisionTeamTemplate(
	db: Db,
	teamId: string,
	templateId: string,
	options?: { skipExistingSlugs?: boolean; dataDir?: string },
): Promise<ProvisionTeamTemplateResult> {
	const skipExistingSlugs = options?.skipExistingSlugs ?? true;
	const dedupedRows = await loadTemplateAgentTypes(db, [templateId]);
	const roster = dedupedRows.map(agentTypeRowToRosterDef);

	let result: { created_slugs: string[]; skipped_slugs: string[] } = {
		created_slugs: [],
		skipped_slugs: [],
	};

	await withTransaction(db, async () => {
		const inserted = await insertRosterAgents(db, teamId, roster, { skipExistingSlugs });
		result = { created_slugs: inserted.created_slugs, skipped_slugs: inserted.skipped_slugs };

		await db.query(
			`INSERT INTO team_template_assignments (team_id, team_template_id)
			 VALUES ($1, $2)
			 ON CONFLICT DO NOTHING`,
			[teamId, templateId],
		);

		await createInlineSkillsFromTemplate(db, templateId);
	});

	if (options?.dataDir) {
		await createSkillsFromTemplate(db, templateId);
	}

	return result;
}
