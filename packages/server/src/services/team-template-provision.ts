import type { PGlite } from '@electric-sql/pglite';
import { MemberType } from '@hezo/shared';
import { trackBackground } from '../lib/background';
import { toSlug } from '../lib/slug';
import { logger } from '../logger';
import { enqueueTeamContextTaskForAllAgents } from './description-tasks';
import { initAgentSystemPrompt } from './documents';
import { downloadSkillContent, SkillDownloadError } from './skill-downloader';

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
}

export interface ProvisionTeamTemplateResult {
	created_slugs: string[];
	skipped_slugs: string[];
}

async function loadTemplateAgentTypes(db: PGlite, templateIds: string[]): Promise<AgentTypeRow[]> {
	const allRows: AgentTypeRow[] = [];
	for (const typeId of templateIds) {
		const joinRows = await db.query<AgentTypeRow>(
			`SELECT at.id, at.name, at.slug, at.role_description, at.default_summary,
			        at.default_team_context, at.system_prompt_template,
			        at.default_effort, at.heartbeat_interval_min, at.monthly_budget_cents,
			        at.touches_code,
			        ctat.reports_to_slug,
			        ctat.heartbeat_interval_override, ctat.monthly_budget_override
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

async function createKbDocsFromTemplate(
	db: PGlite,
	teamId: string,
	templateId: string,
): Promise<void> {
	const result = await db.query<{
		kb_docs_config: Array<{ title: string; slug: string; content: string }>;
	}>('SELECT kb_docs_config FROM team_templates WHERE id = $1', [templateId]);

	const docs = result.rows[0]?.kb_docs_config ?? [];
	for (const doc of docs) {
		await db.query(
			`INSERT INTO documents (team_id, type, slug, title, content)
			 VALUES ($1, 'kb_doc', $2, $3, $4)
			 ON CONFLICT DO NOTHING`,
			[teamId, doc.slug, doc.title, doc.content],
		);
	}
}

export async function createSkillsFromTemplate(
	db: PGlite,
	teamId: string,
	templateId: string,
): Promise<void> {
	const result = await db.query<{
		skills_config: Array<{ name: string; source_url: string; description?: string }>;
	}>('SELECT skills_config FROM team_templates WHERE id = $1', [templateId]);

	const skills = result.rows[0]?.skills_config ?? [];
	if (skills.length === 0) return;

	for (const skill of skills) {
		const slug = toSlug(skill.name);
		if (!slug) continue;
		try {
			const { content, hash } = await downloadSkillContent(skill.source_url);
			await db.query(
				`INSERT INTO skills (team_id, name, slug, description, content, source_url, content_hash)
				 VALUES ($1, $2, $3, $4, $5, $6, $7)
				 ON CONFLICT (team_id, slug) DO NOTHING`,
				[teamId, skill.name, slug, skill.description ?? '', content, skill.source_url, hash],
			);
		} catch (e) {
			if (e instanceof SkillDownloadError) {
				log.warn(`Failed to download template skill "${skill.name}": ${e.message}`);
				continue;
			}
			throw e;
		}
	}
}

/**
 * Adds agents (and optional KB docs / skills) from a team template onto an existing team.
 * Skips agent slugs that already exist when skipExistingSlugs is true (default).
 */
export async function provisionTeamTemplate(
	db: PGlite,
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

	await db.query('BEGIN');
	try {
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
			const budget = row.monthly_budget_override ?? row.monthly_budget_cents;

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
			                            touches_code)
			 VALUES ($1, $2, $3, $4, $5, $6, $7, $8::agent_effort, $9, $10, $11)`,
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
					budget,
					row.touches_code ?? false,
				],
			);

			await initAgentSystemPrompt(db, teamId, memberId, row.system_prompt_template, null);
		}

		for (const row of dedupedRows) {
			if (row.reports_to_slug && row.reports_to_slug !== 'board') {
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

		await createKbDocsFromTemplate(db, teamId, templateId);

		await db.query('COMMIT');
	} catch (e) {
		await db.query('ROLLBACK');
		throw e;
	}

	if (options?.dataDir) {
		await createSkillsFromTemplate(db, teamId, templateId);
	}

	if (createdSlugs.length > 0) {
		trackBackground(
			enqueueTeamContextTaskForAllAgents(db, teamId, 'agent_added').catch((e) =>
				log.error('Failed to fan out team_context tasks after template provision:', e),
			),
		);
	}

	return { created_slugs: createdSlugs, skipped_slugs: skippedSlugs };
}

/** Used when creating a new team (no skip — template is authoritative). */
export async function provisionAgentsFromTeamTypes(
	db: PGlite,
	teamId: string,
	teamTypeIds: string[],
): Promise<void> {
	for (const templateId of teamTypeIds) {
		await provisionTeamTemplate(db, teamId, templateId, { skipExistingSlugs: false });
	}
}
