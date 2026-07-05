import { createHash } from 'node:crypto';
import { MemberType } from '@hezo/shared';
import type { Db } from '../db/database';
import { deriveSkillSummary } from '../lib/skill-summary';
import { toSlug } from '../lib/slug';
import { withTransaction } from '../lib/sql';
import { logger } from '../logger';
import { resolveAgentBudgets } from './agent-budget';
import { initAgentSystemPrompt } from './documents';
import { downloadSkillContent, SkillDownloadError } from './skill-downloader';

/**
 * A template skill entry is either inline (carries `content`) or downloaded
 * (carries `source_url`). `name`/`title` are interchangeable for backwards
 * compatibility with older template configs.
 */
interface TemplateSkillConfig {
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
	monthly_budget_cents: number;
	touches_code: boolean;
	reports_to_slug: string | null;
	heartbeat_interval_override: number | null;
	monthly_budget_override: number | null;
	daily_budget_override: number | null;
	weekly_budget_override: number | null;
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
			        at.default_effort, at.heartbeat_interval_min, at.monthly_budget_cents,
			        at.touches_code,
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
 * Provision the template's inline skills (those carrying `content`) directly
 * into the team's skills database. No network — safe to run inside the
 * provisioning transaction.
 */
async function createInlineSkillsFromTemplate(
	db: Db,
	teamId: string,
	templateId: string,
): Promise<void> {
	const skills = await loadTemplateSkills(db, templateId);
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
			 ON CONFLICT (slug) DO NOTHING`,
			[name, slug, description, skill.content, hash],
		);
	}
}

/**
 * Provision the template's downloaded skills (those carrying `source_url`) by
 * fetching each from its source. Runs outside the transaction because it makes
 * network calls.
 */
export async function createSkillsFromTemplate(
	db: Db,
	teamId: string,
	templateId: string,
): Promise<void> {
	const skills = await loadTemplateSkills(db, templateId);
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
				 ON CONFLICT (slug) DO NOTHING`,
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

	const existingSlugRows = await db.query<{ slug: string }>(
		`SELECT ma.slug FROM member_agents ma
		 JOIN members m ON m.id = ma.id
		 WHERE m.team_id = $1`,
		[teamId],
	);
	const existingSlugs = new Set(existingSlugRows.rows.map((r) => r.slug));

	const createdSlugs: string[] = [];
	const skippedSlugs: string[] = [];
	const slugToMemberId = new Map<string, string>();

	await withTransaction(db, async () => {
		for (const row of dedupedRows) {
			if (skipExistingSlugs && existingSlugs.has(row.slug)) {
				skippedSlugs.push(row.slug);
				const existing = await db.query<{ id: string }>(
					`SELECT ma.id FROM member_agents ma
				 JOIN members m ON m.id = ma.id
				 WHERE m.team_id = $1 AND ma.slug = $2`,
					[teamId, row.slug],
				);
				if (existing.rows[0]) slugToMemberId.set(row.slug, existing.rows[0].id);
				continue;
			}

			const heartbeat = row.heartbeat_interval_override ?? row.heartbeat_interval_min;
			const budgets = resolveAgentBudgets(row.monthly_budget_cents, row);

			const memberResult = await db.query<{ id: string }>(
				`INSERT INTO members (team_id, member_type, display_name)
			 VALUES ($1, $2, $3)
			 RETURNING id`,
				[teamId, MemberType.Agent, row.name],
			);
			const memberId = memberResult.rows[0].id;
			slugToMemberId.set(row.slug, memberId);
			createdSlugs.push(row.slug);

			await db.query(
				`INSERT INTO member_agents (id, agent_type_id, title, slug, role_description, summary,
			                            team_context,
			                            default_effort, heartbeat_interval_min, monthly_budget_cents,
			                            daily_budget_cents, weekly_budget_cents,
			                            touches_code)
			 VALUES ($1, $2, $3, $4, $5, $6, $7, $8::agent_effort, $9, $10, $11, $12, $13)`,
				[
					memberId,
					row.id,
					row.name,
					row.slug,
					row.role_description,
					row.default_summary ?? '',
					row.default_team_context ?? '',
					row.default_effort,
					heartbeat,
					budgets.monthlyBudgetCents,
					budgets.dailyBudgetCents,
					budgets.weeklyBudgetCents,
					row.touches_code ?? false,
				],
			);

			await initAgentSystemPrompt(db, teamId, memberId, row.system_prompt_template, null);
		}

		for (const row of dedupedRows) {
			if (row.reports_to_slug && row.reports_to_slug !== 'admin') {
				const reportsToId = slugToMemberId.get(row.reports_to_slug);
				const memberId = slugToMemberId.get(row.slug);
				if (reportsToId && memberId) {
					await db.query('UPDATE member_agents SET reports_to = $1 WHERE id = $2', [
						reportsToId,
						memberId,
					]);
				}
			}
		}

		await db.query(
			`INSERT INTO team_template_assignments (team_id, team_template_id)
		 VALUES ($1, $2)
		 ON CONFLICT DO NOTHING`,
			[teamId, templateId],
		);

		await createInlineSkillsFromTemplate(db, teamId, templateId);
	});

	if (options?.dataDir) {
		await createSkillsFromTemplate(db, teamId, templateId);
	}

	return { created_slugs: createdSlugs, skipped_slugs: skippedSlugs };
}
