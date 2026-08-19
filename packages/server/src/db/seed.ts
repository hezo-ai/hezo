import { AgentEffort, CEO_AGENT_SLUG, DEFAULT_HEARTBEAT_INTERVAL_MIN } from '@hezo/shared';
import type { Db } from './/database';

interface AgentSummaries {
	agents: Record<string, string>;
	teams: Record<string, string>;
	team_contexts: Record<string, Record<string, string>>;
}

// Loaded via a literal dynamic import (read `.default`) rather than a static
// import-attributes form: this is the JSON-loading shape that survives both
// `bun build --compile` embedding and `bun --hot` reloads. The static
// `with { type: 'json' }` variant leaves this dynamically-imported module's
// namespace unpopulated after a hot reload. Mirrors loadBundledAgentRoles.
let summaries: AgentSummaries;

interface AgentTypeDef {
	name: string;
	slug: string;
	reports_to_slug: string | null;
	sort_order: number;
	default_effort: string;
	heartbeat_interval_min: number;
	run_timeout_min: number;
	monthly_budget_cents: number;
	touches_code: boolean;
	role_description: string;
}

/**
 * The agent types seeded into the binary catalog. Trimmed to the roles that must
 * always exist without the marketplace: the per-team **Captain** (BUILTIN_AGENT_SLUGS)
 * and the instance-level **Coach**. The **CEO** is seeded separately below. Every
 * specialist role (Engineer, Architect, …) now lives in the marketplace team
 * templates (`marketplace/teams/*.json`) and is provisioned directly from there —
 * no longer baked into the binary. The Captain's base prompt is the Blank
 * captain; marketplace teams override it with their own.
 */
function buildAgentTypeDefs(): AgentTypeDef[] {
	return [
		{
			name: 'Captain',
			slug: 'captain',
			reports_to_slug: null,
			sort_order: 0,
			// Strategy + delegation requires deep reasoning — default to max (ultrathink).
			default_effort: AgentEffort.Max,
			heartbeat_interval_min: DEFAULT_HEARTBEAT_INTERVAL_MIN,
			run_timeout_min: 60,
			monthly_budget_cents: 2000,
			touches_code: false,
			role_description:
				'Translates team mission into actionable strategy, delegates work across leadership, and resolves disputes between agents.',
		},
		{
			name: 'Coach',
			slug: 'coach',
			reports_to_slug: null,
			sort_order: 10,
			default_effort: AgentEffort.Medium,
			heartbeat_interval_min: DEFAULT_HEARTBEAT_INTERVAL_MIN,
			run_timeout_min: 60,
			monthly_budget_cents: 3000,
			touches_code: false,
			role_description:
				'Reviews completed tasks to extract lessons and improve agent system prompts over time.',
		},
	];
}

export async function seedBuiltins(db: Db, roleDocs: Record<string, string>): Promise<void> {
	summaries = (await import('./agent-summaries.json')).default as AgentSummaries;
	const defs = buildAgentTypeDefs();
	// The Coach is an instance-level role (like the CEO), so its prompt lives under
	// _instance/. The Captain's base prompt is the Blank captain (the one captain
	// prompt that stays in the binary); marketplace teams override it per-team.
	const role = (slug: string) => {
		if (slug === 'coach') return roleDocs['_instance/coach.md'] ?? '';
		if (slug === 'captain') return roleDocs['blank/captain.md'] ?? '';
		return '';
	};

	const defaultTeamContextFor = (slug: string): string => {
		if (slug === 'coach') return summaries.team_contexts.builtin?.coach ?? '';
		if (slug === 'captain') return summaries.team_contexts.blank?.captain ?? '';
		return '';
	};

	for (const def of defs) {
		await db.query(
			`INSERT INTO agent_types (name, slug, description, role_description, default_summary,
			                          default_team_context, system_prompt_template,
			                          default_effort, heartbeat_interval_min, run_timeout_min,
			                          monthly_budget_cents, touches_code, is_builtin, source)
			 VALUES ($1, $2, $3, $4, $5, $6, $7, $8::agent_effort, $9, $10, $11, $12, true, 'builtin'::agent_type_source)
			 ON CONFLICT (slug) DO UPDATE SET
			     name = EXCLUDED.name,
			     role_description = EXCLUDED.role_description,
			     default_summary = EXCLUDED.default_summary,
			     default_team_context = EXCLUDED.default_team_context,
			     system_prompt_template = EXCLUDED.system_prompt_template,
			     default_effort = EXCLUDED.default_effort,
			     heartbeat_interval_min = EXCLUDED.heartbeat_interval_min,
			     run_timeout_min = EXCLUDED.run_timeout_min,
			     monthly_budget_cents = EXCLUDED.monthly_budget_cents,
			     touches_code = EXCLUDED.touches_code,
			     updated_at = now()`,
			[
				def.name,
				def.slug,
				def.role_description,
				def.role_description,
				summaries.agents[def.slug] ?? '',
				defaultTeamContextFor(def.slug),
				role(def.slug),
				def.default_effort,
				def.heartbeat_interval_min,
				def.run_timeout_min,
				def.monthly_budget_cents,
				def.touches_code,
			],
		);
	}

	// The CEO is an instance-level role (one per Hezo instance), not part of any
	// team template — it is seeded into the catalog so it can be provisioned into
	// the default team, but is intentionally kept out of the template rosters so
	// additional teams never spawn a second CEO.
	await db.query(
		`INSERT INTO agent_types (name, slug, description, role_description, default_summary,
		                          default_team_context, system_prompt_template,
		                          default_effort, heartbeat_interval_min, run_timeout_min,
		                          monthly_budget_cents, touches_code, is_builtin, source)
		 VALUES ($1, $2, $3, $4, $5, $6, $7, $8::agent_effort, $9, $10, $11, $12, true, 'builtin'::agent_type_source)
		 ON CONFLICT (slug) DO UPDATE SET
		     name = EXCLUDED.name,
		     role_description = EXCLUDED.role_description,
		     default_summary = EXCLUDED.default_summary,
		     default_team_context = EXCLUDED.default_team_context,
		     system_prompt_template = EXCLUDED.system_prompt_template,
		     default_effort = EXCLUDED.default_effort,
		     heartbeat_interval_min = EXCLUDED.heartbeat_interval_min,
		     run_timeout_min = EXCLUDED.run_timeout_min,
		     monthly_budget_cents = EXCLUDED.monthly_budget_cents,
		     touches_code = EXCLUDED.touches_code,
		     updated_at = now()`,
		[
			'CEO',
			CEO_AGENT_SLUG,
			'Instance-level chief executive overseeing every team; the team Captains report to the CEO.',
			'Oversees all teams in the instance, sets cross-team direction, and is the escalation point above each team Captain.',
			summaries.agents.ceo ?? '',
			summaries.team_contexts.builtin?.ceo ?? '',
			roleDocs['_instance/ceo.md'] ?? '',
			AgentEffort.Max,
			DEFAULT_HEARTBEAT_INTERVAL_MIN,
			60,
			3000,
			false,
		],
	);

	// The former built-in "Startup" team template + its specialist roster now live
	// in the marketplace (`marketplace/teams/software-development.json`), fetched at
	// runtime and provisioned directly — never seeded as team_templates/agent_types
	// rows. Only the **Blank** template stays seeded as the always-available
	// bootstrap fallback (Captain-only, no network required).
	const blankBuiltinPrompts = {
		captain: roleDocs['blank/captain.md'] ?? '',
	};

	const blankBuiltinTeamContexts = {
		captain: summaries.team_contexts.blank?.captain ?? '',
	};

	await db.query(
		`INSERT INTO team_templates (name, description, default_summary, is_builtin, source,
		                             builtin_agent_prompts, builtin_agent_team_contexts)
		 VALUES ($1, $2, $3, true, 'builtin'::team_template_source, $4::jsonb, $5::jsonb)
		 ON CONFLICT (name) DO UPDATE SET
		     description = EXCLUDED.description,
		     default_summary = EXCLUDED.default_summary,
		     source = EXCLUDED.source,
		     builtin_agent_prompts = EXCLUDED.builtin_agent_prompts,
		     builtin_agent_team_contexts = EXCLUDED.builtin_agent_team_contexts`,
		[
			'Blank',
			'Start with only the built-in Captain and hire the roles you need later',
			summaries.teams.Blank ?? '',
			JSON.stringify(blankBuiltinPrompts),
			JSON.stringify(blankBuiltinTeamContexts),
		],
	);
}
