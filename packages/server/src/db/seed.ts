import type { PGlite } from '@electric-sql/pglite';
import { AgentStatus } from '@hezo/shared';

function buildAgentConfigs(roleDocs: Record<string, string>) {
	const role = (slug: string) => roleDocs[`${slug}.md`] ?? '';
	return [
		{
			title: 'CEO',
			slug: 'ceo',
			reports_to_slug: null,
			runtime_type: 'claude_code',
			heartbeat_interval_min: 120,
			monthly_budget_cents: 2000,
			role_description:
				'Translates company mission into actionable strategy, delegates work across leadership, and resolves disputes between agents.',
			status: AgentStatus.Active,
			system_prompt: role('ceo'),
		},
		{
			title: 'Architect',
			slug: 'architect',
			reports_to_slug: 'ceo',
			runtime_type: 'claude_code',
			heartbeat_interval_min: 60,
			monthly_budget_cents: 4000,
			role_description:
				'Owns technical vision, translates product requirements into technical specifications, and makes architecture decisions.',
			status: AgentStatus.Active,
			system_prompt: role('architect'),
		},
		{
			title: 'Product Lead',
			slug: 'product-lead',
			reports_to_slug: 'ceo',
			runtime_type: 'claude_code',
			heartbeat_interval_min: 60,
			monthly_budget_cents: 3000,
			role_description:
				'Owns product requirements, writes PRDs, manages scope, and ensures development aligns with company mission.',
			status: AgentStatus.Active,
			system_prompt: role('product-lead'),
		},
		{
			title: 'Engineer',
			slug: 'engineer',
			reports_to_slug: 'architect',
			runtime_type: 'claude_code',
			heartbeat_interval_min: 30,
			monthly_budget_cents: 5000,
			role_description:
				"Primary implementer who writes code, tests, and documentation based on the Architect's technical specification.",
			status: AgentStatus.Active,
			system_prompt: role('engineer'),
		},
		{
			title: 'QA Engineer',
			slug: 'qa-engineer',
			reports_to_slug: 'architect',
			runtime_type: 'claude_code',
			heartbeat_interval_min: 60,
			monthly_budget_cents: 4000,
			role_description:
				'Final approval gate for every ticket, responsible for test coverage, security audits, and code quality.',
			status: AgentStatus.Active,
			system_prompt: role('qa-engineer'),
		},
		{
			title: 'UI Designer',
			slug: 'ui-designer',
			reports_to_slug: 'architect',
			runtime_type: 'claude_code',
			heartbeat_interval_min: 60,
			monthly_budget_cents: 3000,
			role_description:
				'Owns visual and interaction layer, defines component architecture, and creates HTML preview mockups.',
			status: AgentStatus.Active,
			system_prompt: role('ui-designer'),
		},
		{
			title: 'DevOps Engineer',
			slug: 'devops-engineer',
			reports_to_slug: 'architect',
			runtime_type: 'claude_code',
			heartbeat_interval_min: 60,
			monthly_budget_cents: 3000,
			role_description:
				'Owns infrastructure and deployment pipeline, manages staging and production environments, and configures CI/CD.',
			status: AgentStatus.Idle,
			system_prompt: role('devops-engineer'),
		},
		{
			title: 'Marketing Lead',
			slug: 'marketing-lead',
			reports_to_slug: 'ceo',
			runtime_type: 'claude_code',
			heartbeat_interval_min: 120,
			monthly_budget_cents: 2000,
			role_description:
				'Owns marketing strategy and content creation including blog posts, social media, and public-facing documentation.',
			status: AgentStatus.Active,
			system_prompt: role('marketing-lead'),
		},
		{
			title: 'Researcher',
			slug: 'researcher',
			reports_to_slug: 'ceo',
			runtime_type: 'claude_code',
			heartbeat_interval_min: 120,
			monthly_budget_cents: 3000,
			role_description:
				'Conducts competitive analysis, technical research, and feasibility studies to inform strategic decisions.',
			status: AgentStatus.Active,
			system_prompt: role('researcher'),
		},
	];
}

export async function seedBuiltins(db: PGlite, roleDocs: Record<string, string>): Promise<void> {
	const agentsConfig = JSON.stringify(buildAgentConfigs(roleDocs));

	await db.query(
		`INSERT INTO company_types (name, description, is_builtin, agents_config)
     VALUES ($1, $2, true, $3::jsonb)
     ON CONFLICT (name) DO NOTHING`,
		[
			'Software Development',
			'Full-stack software development team with 9 specialized agents',
			agentsConfig,
		],
	);
}
