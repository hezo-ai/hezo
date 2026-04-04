import type { PGlite } from '@electric-sql/pglite';

interface AgentTypeDef {
	name: string;
	slug: string;
	reports_to_slug: string | null;
	sort_order: number;
	runtime_type: string;
	heartbeat_interval_min: number;
	monthly_budget_cents: number;
	role_description: string;
}

function buildAgentTypeDefs(): AgentTypeDef[] {
	return [
		{
			name: 'CEO',
			slug: 'ceo',
			reports_to_slug: null,
			sort_order: 0,
			runtime_type: 'claude_code',
			heartbeat_interval_min: 120,
			monthly_budget_cents: 2000,
			role_description:
				'Translates company mission into actionable strategy, delegates work across leadership, and resolves disputes between agents.',
		},
		{
			name: 'Architect',
			slug: 'architect',
			reports_to_slug: 'ceo',
			sort_order: 1,
			runtime_type: 'claude_code',
			heartbeat_interval_min: 60,
			monthly_budget_cents: 4000,
			role_description:
				'Owns technical vision, translates product requirements into technical specifications, and makes architecture decisions.',
		},
		{
			name: 'Product Lead',
			slug: 'product-lead',
			reports_to_slug: 'ceo',
			sort_order: 2,
			runtime_type: 'claude_code',
			heartbeat_interval_min: 60,
			monthly_budget_cents: 3000,
			role_description:
				'Owns product requirements, writes PRDs, manages scope, and ensures development aligns with company mission.',
		},
		{
			name: 'Engineer',
			slug: 'engineer',
			reports_to_slug: 'architect',
			sort_order: 3,
			runtime_type: 'claude_code',
			heartbeat_interval_min: 30,
			monthly_budget_cents: 5000,
			role_description:
				"Primary implementer who writes code, tests, and documentation based on the Architect's technical specification.",
		},
		{
			name: 'QA Engineer',
			slug: 'qa-engineer',
			reports_to_slug: 'architect',
			sort_order: 4,
			runtime_type: 'claude_code',
			heartbeat_interval_min: 60,
			monthly_budget_cents: 4000,
			role_description:
				'Final approval gate for every ticket, responsible for test coverage, security audits, and code quality.',
		},
		{
			name: 'UI Designer',
			slug: 'ui-designer',
			reports_to_slug: 'architect',
			sort_order: 5,
			runtime_type: 'claude_code',
			heartbeat_interval_min: 60,
			monthly_budget_cents: 3000,
			role_description:
				'Owns visual and interaction layer, defines component architecture, and creates HTML preview mockups.',
		},
		{
			name: 'DevOps Engineer',
			slug: 'devops-engineer',
			reports_to_slug: 'architect',
			sort_order: 6,
			runtime_type: 'claude_code',
			heartbeat_interval_min: 60,
			monthly_budget_cents: 3000,
			role_description:
				'Owns infrastructure and deployment pipeline, manages staging and production environments, and configures CI/CD.',
		},
		{
			name: 'Marketing Lead',
			slug: 'marketing-lead',
			reports_to_slug: 'ceo',
			sort_order: 7,
			runtime_type: 'claude_code',
			heartbeat_interval_min: 120,
			monthly_budget_cents: 2000,
			role_description:
				'Owns marketing strategy and content creation including blog posts, social media, and public-facing documentation.',
		},
		{
			name: 'Researcher',
			slug: 'researcher',
			reports_to_slug: 'ceo',
			sort_order: 8,
			runtime_type: 'claude_code',
			heartbeat_interval_min: 120,
			monthly_budget_cents: 3000,
			role_description:
				'Conducts competitive analysis, technical research, and feasibility studies to inform strategic decisions.',
		},
	];
}

export async function seedBuiltins(db: PGlite, roleDocs: Record<string, string>): Promise<void> {
	const defs = buildAgentTypeDefs();
	const role = (slug: string) => roleDocs[`${slug}.md`] ?? '';

	for (const def of defs) {
		await db.query(
			`INSERT INTO agent_types (name, slug, description, role_description, system_prompt_template,
			                          runtime_type, heartbeat_interval_min, monthly_budget_cents,
			                          is_builtin, source)
			 VALUES ($1, $2, $3, $4, $5, $6::agent_runtime, $7, $8, true, 'builtin'::agent_type_source)
			 ON CONFLICT (slug) DO UPDATE SET
			     name = EXCLUDED.name,
			     role_description = EXCLUDED.role_description,
			     system_prompt_template = EXCLUDED.system_prompt_template,
			     runtime_type = EXCLUDED.runtime_type,
			     heartbeat_interval_min = EXCLUDED.heartbeat_interval_min,
			     monthly_budget_cents = EXCLUDED.monthly_budget_cents,
			     updated_at = now()`,
			[
				def.name,
				def.slug,
				def.role_description,
				def.role_description,
				role(def.slug),
				def.runtime_type,
				def.heartbeat_interval_min,
				def.monthly_budget_cents,
			],
		);
	}

	const kbDocsConfig = [
		{
			title: 'Company Overview',
			slug: 'company-overview',
			content: `# Company Overview

<!-- TODO: customize this document for your company -->

## Mission

Describe your company's mission and what problem you're solving.

## Product

Describe your product, its target users, and key value propositions.

## Decision Making

- Strategic decisions escalate to the board
- Technical architecture decisions go through the Architect
- Product scope decisions go through the Product Lead
- Day-to-day implementation decisions are made by the assigned agent
`,
		},
		{
			title: 'Development Workflow',
			slug: 'development-workflow',
			content: `# Development Workflow

## Issue Lifecycle

Issues progress through these statuses:
1. **Backlog** — captured but not yet prioritized
2. **Open** — prioritized and ready for work
3. **In Progress** — actively being worked on
4. **Review** — implementation complete, awaiting QA review
5. **Done** — reviewed and approved

## Branching Strategy

<!-- TODO: customize for your repository -->

- Main branch: \`main\`
- Feature branches: \`feat/<issue-id>-short-description\`
- Bug fix branches: \`fix/<issue-id>-short-description\`

## Pull Requests

- Every change requires a PR with a clear description
- PRs must pass CI checks before merge
- QA Engineer performs final review before approval
`,
		},
		{
			title: 'Architecture Guidelines',
			slug: 'architecture-guidelines',
			content: `# Architecture Guidelines

<!-- TODO: customize for your tech stack -->

## Tech Stack

Describe your primary languages, frameworks, and infrastructure.

## Project Structure

Describe your repository layout and key directories.

## Coding Conventions

- Follow the language's standard style guide
- Write self-documenting code with minimal comments
- Prefer composition over inheritance
- Keep functions focused and small

## Architecture Decision Records

Significant technical decisions should be documented with:
- **Context** — what prompted the decision
- **Decision** — what was chosen
- **Consequences** — trade-offs and implications
`,
		},
		{
			title: 'Code Review Standards',
			slug: 'code-review-standards',
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
		`INSERT INTO company_types (name, description, is_builtin, source, kb_docs_config)
		 VALUES ($1, $2, true, 'builtin'::company_type_source, $3::jsonb)
		 ON CONFLICT (name) DO UPDATE SET
		     description = EXCLUDED.description,
		     kb_docs_config = EXCLUDED.kb_docs_config,
		     source = EXCLUDED.source
		 RETURNING id`,
		[
			'Startup',
			'Full-stack software development team with 9 specialized agents and starter knowledge base',
			JSON.stringify(kbDocsConfig),
		],
	);
	const startupTypeId = startupResult.rows[0].id;

	for (const def of defs) {
		await db.query(
			`INSERT INTO company_type_agent_types (company_type_id, agent_type_id, reports_to_slug, sort_order)
			 VALUES ($1, (SELECT id FROM agent_types WHERE slug = $2), $3, $4)
			 ON CONFLICT (company_type_id, agent_type_id) DO UPDATE SET
			     reports_to_slug = EXCLUDED.reports_to_slug,
			     sort_order = EXCLUDED.sort_order`,
			[startupTypeId, def.slug, def.reports_to_slug, def.sort_order],
		);
	}

	await db.query(
		`INSERT INTO company_types (name, description, is_builtin, source)
		 VALUES ($1, $2, true, 'builtin'::company_type_source)
		 ON CONFLICT (name) DO UPDATE SET
		     description = EXCLUDED.description,
		     source = EXCLUDED.source`,
		['Blank', 'Start from scratch with no agents or documents'],
	);
}
