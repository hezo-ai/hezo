import type { Db } from '../../src/db/database';
import { getMarketplaceTeam } from '../../src/services/marketplace';

/**
 * TEST FIXTURE ONLY. Production no longer seeds the "App Team" team template — its
 * roster lives in the marketplace (`marketplace/teams/software-development.json`)
 * and is provisioned directly. But a large body of existing tests provisions a
 * full software-development team via `GET /api/team-templates` → find `App Team` →
 * `createTestTeam({ template_id })`. To keep that affordance without rewriting
 * every test, the harness materializes an equivalent `App Team` DB template from
 * the marketplace def: `agent_types` for each roster role, a non-builtin
 * `team_templates` row (so the API's builtin filter still surfaces it), the join
 * rows, and the Captain override. Seeded right after
 * `seedBuiltins` in `createTestApp`.
 */
export async function seedTestAppTeamTemplate(db: Db): Promise<void> {
	const def = await getMarketplaceTeam('software-development');
	if (!def) {
		throw new Error(
			'seedTestAppTeamTemplate: marketplace "software-development" team not found — is HEZO_MARKETPLACE_DIR set and marketplace/teams built?',
		);
	}

	const idBySlug = new Map<string, string>();
	for (const a of def.roster) {
		// Seeded as builtin agent types so the catalog matches what the pre-marketplace
		// binary seeded (a body of tests inspects /api/agent-types). This is a test
		// fixture only — production never creates these rows.
		const res = await db.query<{ id: string }>(
			`INSERT INTO agent_types (name, slug, description, role_description, default_summary,
			                          default_team_context, system_prompt_template, default_effort,
			                          heartbeat_interval_min, run_timeout_min, monthly_budget_cents,
			                          touches_code, is_builtin, source)
			 VALUES ($1, $2, $3, $4, $5, $6, $7, $8::agent_effort, $9, $10, $11, $12, true, 'builtin'::agent_type_source)
			 ON CONFLICT (slug) DO UPDATE SET system_prompt_template = EXCLUDED.system_prompt_template
			 RETURNING id`,
			[
				a.title,
				a.slug,
				a.role_description,
				a.role_description,
				a.summary,
				a.team_context,
				a.system_prompt,
				a.default_effort,
				a.heartbeat_interval_min,
				a.run_timeout_min,
				a.monthly_budget_cents,
				a.touches_code,
			],
		);
		idBySlug.set(a.slug, res.rows[0].id);
	}

	const captainType = await db.query<{ id: string }>(
		`SELECT id FROM agent_types WHERE slug = 'captain'`,
	);
	const captainTypeId = captainType.rows[0]?.id;

	const tt = await db.query<{ id: string }>(
		`INSERT INTO team_templates (name, description, default_summary, is_builtin, source,
		                             skills_config, builtin_agent_prompts, builtin_agent_team_contexts)
		 VALUES ($1, $2, $3, false, 'marketplace'::team_template_source, $4::jsonb, $5::jsonb, $6::jsonb)
		 ON CONFLICT (name) DO UPDATE SET description = EXCLUDED.description
		 RETURNING id`,
		[
			'App Team',
			def.description,
			def.summary,
			// Marketplace teams no longer bundle skills; the DB template column stays but is empty.
			JSON.stringify([]),
			JSON.stringify({ captain: def.captain.system_prompt }),
			JSON.stringify({ captain: def.captain.team_context }),
		],
	);
	const templateId = tt.rows[0].id;

	// Captain join row (references the builtin captain type; prompt comes from the
	// override above) + one row per roster role — mirrors the pre-marketplace App Team roster.
	if (captainTypeId) {
		await db.query(
			`INSERT INTO team_template_agent_types (team_template_id, agent_type_id, reports_to_slug, sort_order)
			 VALUES ($1, $2, NULL, 0)
			 ON CONFLICT (team_template_id, agent_type_id) DO NOTHING`,
			[templateId, captainTypeId],
		);
	}
	for (const a of def.roster) {
		await db.query(
			`INSERT INTO team_template_agent_types (team_template_id, agent_type_id, reports_to_slug, sort_order)
			 VALUES ($1, $2, $3, $4)
			 ON CONFLICT (team_template_id, agent_type_id) DO NOTHING`,
			[templateId, idBySlug.get(a.slug), a.reports_to_slug, a.sort_order],
		);
	}
}
