import {
	AgentEffort,
	CEO_AGENT_SLUG,
	DEFAULT_HEARTBEAT_INTERVAL_MIN,
	INSTANCE_AGENT_SLUGS,
} from '@hezo/shared';
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
			name: 'Architect',
			slug: 'architect',
			reports_to_slug: 'captain',
			sort_order: 1,
			// Planning is the core job — always ultrathink.
			default_effort: AgentEffort.Max,
			heartbeat_interval_min: DEFAULT_HEARTBEAT_INTERVAL_MIN,
			run_timeout_min: 60,
			monthly_budget_cents: 4000,
			touches_code: false,
			role_description:
				'Owns technical vision, translates product requirements into technical specifications, and makes architecture decisions.',
		},
		{
			name: 'Product Lead',
			slug: 'product-lead',
			reports_to_slug: 'captain',
			sort_order: 2,
			// Scoping/PRD work is planning-heavy.
			default_effort: AgentEffort.High,
			heartbeat_interval_min: DEFAULT_HEARTBEAT_INTERVAL_MIN,
			run_timeout_min: 60,
			monthly_budget_cents: 3000,
			touches_code: false,
			role_description:
				'Owns product requirements, writes PRDs, manages scope, and ensures development aligns with team mission.',
		},
		{
			name: 'Engineer',
			slug: 'engineer',
			reports_to_slug: 'architect',
			sort_order: 3,
			// Implementation default — callers/comments can bump to high for tricky work.
			default_effort: AgentEffort.Medium,
			heartbeat_interval_min: DEFAULT_HEARTBEAT_INTERVAL_MIN,
			run_timeout_min: 60,
			monthly_budget_cents: 5000,
			touches_code: true,
			role_description:
				"Primary implementer who writes code, tests, and documentation based on the Architect's technical specification.",
		},
		{
			name: 'QA Engineer',
			slug: 'qa-engineer',
			reports_to_slug: 'architect',
			sort_order: 4,
			// Review needs careful thought about correctness and coverage.
			default_effort: AgentEffort.High,
			heartbeat_interval_min: DEFAULT_HEARTBEAT_INTERVAL_MIN,
			run_timeout_min: 60,
			monthly_budget_cents: 4000,
			touches_code: true,
			role_description:
				'Final approval gate for every ticket, responsible for test coverage, security audits, and code quality.',
		},
		{
			name: 'Security Engineer',
			slug: 'security-engineer',
			reports_to_slug: 'architect',
			sort_order: 5,
			default_effort: AgentEffort.High,
			heartbeat_interval_min: DEFAULT_HEARTBEAT_INTERVAL_MIN,
			run_timeout_min: 60,
			monthly_budget_cents: 3000,
			touches_code: true,
			role_description:
				'Reviews implementation plans and code for security vulnerabilities, threat models new features, and escalates uncertainties to the admin.',
		},
		{
			name: 'UI Designer',
			slug: 'ui-designer',
			reports_to_slug: 'architect',
			sort_order: 6,
			default_effort: AgentEffort.Medium,
			heartbeat_interval_min: DEFAULT_HEARTBEAT_INTERVAL_MIN,
			run_timeout_min: 60,
			monthly_budget_cents: 3000,
			touches_code: true,
			role_description:
				'Owns visual and interaction layer, defines component architecture, and creates HTML preview mockups.',
		},
		{
			name: 'DevOps Engineer',
			slug: 'devops-engineer',
			reports_to_slug: 'architect',
			sort_order: 7,
			default_effort: AgentEffort.Medium,
			heartbeat_interval_min: DEFAULT_HEARTBEAT_INTERVAL_MIN,
			run_timeout_min: 60,
			monthly_budget_cents: 3000,
			touches_code: true,
			role_description:
				'Owns infrastructure and deployment pipeline, manages staging and production environments, and configures CI/CD.',
		},
		{
			name: 'Marketing Lead',
			slug: 'marketing-lead',
			reports_to_slug: 'captain',
			sort_order: 8,
			default_effort: AgentEffort.Medium,
			heartbeat_interval_min: DEFAULT_HEARTBEAT_INTERVAL_MIN,
			run_timeout_min: 60,
			monthly_budget_cents: 2000,
			touches_code: false,
			role_description:
				'Owns marketing strategy and content creation including blog posts, social media, and public-facing documentation.',
		},
		{
			name: 'Researcher',
			slug: 'researcher',
			reports_to_slug: 'captain',
			sort_order: 9,
			// Research benefits from deep thinking.
			default_effort: AgentEffort.High,
			heartbeat_interval_min: DEFAULT_HEARTBEAT_INTERVAL_MIN,
			run_timeout_min: 60,
			monthly_budget_cents: 3000,
			touches_code: false,
			role_description:
				'Conducts competitive analysis, technical research, and feasibility studies to inform strategic decisions.',
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
				'Reviews completed tickets to extract lessons and improve agent system prompts over time.',
		},
	];
}

export async function seedBuiltins(db: Db, roleDocs: Record<string, string>): Promise<void> {
	summaries = (await import('./agent-summaries.json')).default as AgentSummaries;
	const defs = buildAgentTypeDefs();
	// The Coach is an instance-level role (like the CEO), so its prompt lives under
	// _instance/, not in any team template.
	const role = (slug: string) =>
		(slug === 'coach'
			? roleDocs['_instance/coach.md']
			: roleDocs[`software-development/${slug}.md`]) ?? '';

	const defaultTeamContextFor = (slug: string): string => {
		if (slug === 'coach') return summaries.team_contexts.builtin?.coach ?? '';
		return summaries.team_contexts['software-development']?.[slug] ?? '';
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

	const skillsConfig = [
		{
			name: 'Development Workflow',
			slug: 'development-workflow.md',
			content: `# Development Workflow

## Task Lifecycle

Tasks progress through these statuses:
1. **Backlog** — captured but not yet picked up
2. **In Progress** — actively being worked on
3. **Review** — implementation complete, awaiting QA review
4. **Done** — QA-approved and landed, awaiting Coach post-mortem
5. **Closed** — Coach review complete

Approval is conveyed via comment, not status. From **Review**, the ticket either goes back to **In Progress** (more work needed) or forward to **Done** (work complete and approved). The **Blocked** status is reserved for explicit "I'm stuck" signals; agents and the system also use ticket dependencies to gate runs on prerequisites without setting this status.

## Branching Strategy

<!-- TODO: customize for your repository -->

- Main branch: \`main\`
- Feature branches: \`feat/<task-id>-short-description\`
- Bug fix branches: \`fix/<task-id>-short-description\`

## Pull Requests

- Every change requires a PR with a clear description
- PRs must pass CI checks before merge
- QA Engineer performs final review before approval
`,
		},
		{
			name: 'Code Review Standards',
			slug: 'code-review-standards.md',
			content: `# Code Review Standards

## What Reviewers Check

- **Correctness** — does it solve the stated problem?
- **Security** — no injection vulnerabilities, proper input validation
- **Performance** — no obvious bottlenecks or N+1 queries
- **Readability** — clear naming, logical structure, minimal complexity
- **Test coverage** — new behavior has corresponding tests

## Quality Gates

- All CI checks must pass
- No unresolved review comments
- Test coverage for new functionality
- No known security vulnerabilities introduced

## Testing Expectations

- Unit tests for business logic
- Integration tests for API endpoints and database queries
- E2E tests for critical user flows
`,
		},
	];

	const startupResult = await db.query<{ id: string }>(
		`INSERT INTO team_templates (name, description, default_summary, is_builtin, source,
		                             skills_config)
		 VALUES ($1, $2, $3, true, 'builtin'::team_template_source, $4::jsonb)
		 ON CONFLICT (name) DO UPDATE SET
		     description = EXCLUDED.description,
		     default_summary = EXCLUDED.default_summary,
		     skills_config = EXCLUDED.skills_config,
		     source = EXCLUDED.source
		 RETURNING id`,
		[
			'Startup',
			'Full-stack software development team with 10 specialized agents and a starter skills database',
			summaries.teams.Startup ?? '',
			JSON.stringify(skillsConfig),
		],
	);
	const startupTemplateId = startupResult.rows[0].id;

	// Instance-level agents (CEO, Coach) live in HQ and are never part of a team
	// template's roster.
	const templateDefs = defs.filter(
		(d) => !(INSTANCE_AGENT_SLUGS as readonly string[]).includes(d.slug),
	);
	for (const def of templateDefs) {
		await db.query(
			`INSERT INTO team_template_agent_types (team_template_id, agent_type_id, reports_to_slug, sort_order)
			 VALUES ($1, (SELECT id FROM agent_types WHERE slug = $2), $3, $4)
			 ON CONFLICT (team_template_id, agent_type_id) DO UPDATE SET
			     reports_to_slug = EXCLUDED.reports_to_slug,
			     sort_order = EXCLUDED.sort_order`,
			[startupTemplateId, def.slug, def.reports_to_slug, def.sort_order],
		);
	}

	// Coach is an instance-level singleton (seeded in HQ), not part of any team
	// template — templates carry only the per-team Captain override.
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
			'Start from scratch with only the built-in Captain',
			summaries.teams.Blank ?? '',
			JSON.stringify(blankBuiltinPrompts),
			JSON.stringify(blankBuiltinTeamContexts),
		],
	);
}
