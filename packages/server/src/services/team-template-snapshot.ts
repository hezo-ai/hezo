import { createHash } from 'node:crypto';
import { CAPTAIN_AGENT_SLUG, COACH_AGENT_SLUG, DocumentType, MemberType } from '@hezo/shared';
import type { Db } from '../db/database';
import { withTransaction } from '../lib/sql';

export interface SnapshotTeamInput {
	name: string;
	description?: string;
}

export interface SnapshotTeamResult {
	/** The new custom team template ("type") id. */
	template_id: string;
	/** Slugs of fully-custom agents (no catalog type) that could not be captured. */
	skipped_agents: string[];
}

interface RosterAgent {
	id: string;
	slug: string;
	title: string;
	agent_type_id: string | null;
	reports_to: string | null;
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
}

/**
 * Materialize a `source='custom'` agent type from a live inline agent (one with
 * no catalog `agent_type_id` — e.g. a marketplace-provisioned role or a hire) so
 * a snapshot template can reference it. Prefers the member's own slug so a
 * re-provisioned copy keeps the same handle; if that global slug is already taken
 * by a *different* type, falls back to a content-hashed slug (identical content
 * reuses the existing type). Returns the agent-type id to reference in the join.
 */
async function materializeCustomAgentType(
	db: Db,
	agent: RosterAgent,
	systemPrompt: string,
): Promise<string> {
	const existing = await db.query<{ id: string; system_prompt_template: string }>(
		`SELECT id, system_prompt_template FROM agent_types WHERE slug = $1`,
		[agent.slug],
	);
	let slug = agent.slug;
	if (existing.rows[0]) {
		if (existing.rows[0].system_prompt_template === systemPrompt) return existing.rows[0].id;
		slug = `${agent.slug}-${createHash('sha256').update(systemPrompt).digest('hex').slice(0, 6)}`;
	}
	const res = await db.query<{ id: string }>(
		`INSERT INTO agent_types (name, slug, description, role_description, default_summary,
		                          default_team_context, system_prompt_template, default_effort,
		                          heartbeat_interval_min, run_timeout_min, monthly_budget_cents,
		                          touches_code, is_builtin, source)
		 VALUES ($1, $2, $3, $4, $5, $6, $7, $8::agent_effort, $9, $10, $11, $12, false, 'custom'::agent_type_source)
		 ON CONFLICT (slug) DO UPDATE SET updated_at = now()
		 RETURNING id`,
		[
			agent.title,
			slug,
			agent.role_description,
			agent.role_description,
			agent.summary,
			agent.team_context,
			systemPrompt,
			agent.default_effort,
			agent.heartbeat_interval_min,
			agent.run_timeout_min,
			agent.monthly_budget_cents,
			agent.touches_code,
		],
	);
	return res.rows[0].id;
}

/**
 * Snapshots a team's current live state into a new reusable custom team template
 * ("save this team as a type"): its agent roster (with reporting structure and
 * per-agent overrides), the Captain/Coach system prompts + team contexts, the
 * skills database, team preferences, and MCP/MPP config.
 *
 * Agents whose manager lives outside the team (e.g. the instance CEO) become
 * top-of-roster (reports_to_slug null) in the template — the CEO is re-linked
 * per-team at creation, not carried in the roster. Fully-custom agents with no
 * `agent_type_id` cannot be represented in the agent-types join and are skipped
 * (returned in `skipped_agents`).
 */
export async function snapshotTeamAsTemplate(
	db: Db,
	teamId: string,
	input: SnapshotTeamInput,
): Promise<SnapshotTeamResult> {
	const name = input.name.trim();

	return withTransaction(db, async () => {
		const agentsRes = await db.query<RosterAgent>(
			`SELECT ma.id, ma.slug, ma.title, ma.agent_type_id, ma.reports_to,
			        ma.role_description, ma.summary, ma.team_context, ma.default_effort::text,
			        ma.heartbeat_interval_min, ma.run_timeout_min, ma.monthly_budget_cents,
			        ma.daily_budget_cents, ma.weekly_budget_cents, ma.touches_code
			 FROM member_agents ma
			 JOIN members m ON m.id = ma.id
			 WHERE m.team_id = $1 AND m.member_type = $2
			 ORDER BY ma.slug`,
			[teamId, MemberType.Agent],
		);
		const agents = agentsRes.rows;
		const idToSlug = new Map(agents.map((a) => [a.id, a.slug]));

		// Captain/Coach prompts + team contexts round-trip via the template's
		// builtin override dicts (they're provisioned as builtins, not roster rows).
		const builtinPrompts: Record<string, string> = {};
		const builtinTeamContexts: Record<string, string> = {};
		for (const a of agents) {
			if (a.slug !== CAPTAIN_AGENT_SLUG && a.slug !== COACH_AGENT_SLUG) continue;
			const promptRes = await db.query<{ content: string }>(
				`SELECT content FROM documents
				 WHERE type = $1 AND team_id = $2 AND member_agent_id = $3`,
				[DocumentType.AgentSystemPrompt, teamId, a.id],
			);
			if (promptRes.rows[0]?.content) builtinPrompts[a.slug] = promptRes.rows[0].content;
			if (a.team_context) builtinTeamContexts[a.slug] = a.team_context;
		}

		const teamCfg = await db.query<{ mcp_servers: unknown; mpp_config: unknown }>(
			`SELECT mcp_servers, mpp_config FROM teams WHERE id = $1`,
			[teamId],
		);
		const mcpServers = teamCfg.rows[0]?.mcp_servers ?? [];
		const mppConfig = teamCfg.rows[0]?.mpp_config ?? { enabled: false };

		const skillsRes = await db.query<{
			name: string;
			slug: string;
			description: string;
			content: string;
			// Only global skills go into a reusable template — a project-scoped skill
			// is private to one project and must not be captured for other teams.
		}>(
			`SELECT name, slug, description, content FROM skills WHERE is_active = true AND project_id IS NULL`,
		);
		const skillsConfig = skillsRes.rows;

		const prefRes = await db.query<{ content: string }>(
			`SELECT content FROM documents WHERE type = $1 AND team_id = $2`,
			[DocumentType.TeamPreferences, teamId],
		);
		const preferencesConfig = prefRes.rows[0]?.content ? { content: prefRes.rows[0].content } : {};

		const ctRes = await db.query<{ id: string }>(
			`INSERT INTO team_templates (name, description, default_summary, is_builtin, source,
			                             skills_config, preferences_config, mcp_servers, mpp_config,
			                             builtin_agent_prompts, builtin_agent_team_contexts)
			 VALUES ($1, $2, '', false, 'custom'::team_template_source,
			         $3::jsonb, $4::jsonb, $5::jsonb, $6::jsonb, $7::jsonb, $8::jsonb)
			 RETURNING id`,
			[
				name,
				input.description ?? '',
				JSON.stringify(skillsConfig),
				JSON.stringify(preferencesConfig),
				JSON.stringify(mcpServers),
				JSON.stringify(mppConfig),
				JSON.stringify(builtinPrompts),
				JSON.stringify(builtinTeamContexts),
			],
		);
		const newTemplateId = ctRes.rows[0].id;

		const skippedAgents: string[] = [];
		let sortOrder = 0;
		for (const a of agents) {
			let agentTypeId = a.agent_type_id;
			if (!agentTypeId) {
				// An inline agent with no catalog type (a marketplace-provisioned role or a
				// hire). Materialize a custom agent type from its live config + prompt so this
				// template can reference it — otherwise the roster role would be lost on copy.
				const promptRes = await db.query<{ content: string }>(
					`SELECT content FROM documents
					 WHERE type = $1 AND team_id = $2 AND member_agent_id = $3`,
					[DocumentType.AgentSystemPrompt, teamId, a.id],
				);
				const systemPrompt = promptRes.rows[0]?.content ?? '';
				if (!systemPrompt) {
					// No prompt to represent the role — cannot capture it faithfully.
					skippedAgents.push(a.slug);
					continue;
				}
				agentTypeId = await materializeCustomAgentType(db, a, systemPrompt);
			}
			// Manager's in-team slug, or null when the manager is outside the team
			// (e.g. the instance CEO) or there is none (reports to the admin).
			const reportsToSlug = a.reports_to ? (idToSlug.get(a.reports_to) ?? null) : null;
			await db.query(
				`INSERT INTO team_template_agent_types
				   (team_template_id, agent_type_id, reports_to_slug, heartbeat_interval_override,
				    monthly_budget_override, daily_budget_override, weekly_budget_override, sort_order)
				 VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
				 ON CONFLICT (team_template_id, agent_type_id) DO NOTHING`,
				[
					newTemplateId,
					agentTypeId,
					reportsToSlug,
					a.heartbeat_interval_min,
					a.monthly_budget_cents,
					a.daily_budget_cents,
					a.weekly_budget_cents,
					sortOrder,
				],
			);
			sortOrder++;
		}

		return { template_id: newTemplateId, skipped_agents: skippedAgents };
	});
}
