import type { PGlite } from '@electric-sql/pglite';

interface ResolveContext {
	companyId: string;
	projectId?: string;
	agentId?: string;
	dataDir?: string;
}

const SHARED_INSTRUCTIONS = `

---

## Working Guidelines

### Ticket Maintenance
- **Progress**: Update the current ticket's progress_summary via \`update_issue\` at natural milestones to reflect what you've accomplished and what remains.
- **Rules**: If you discover constraints, requirements, or decisions specific to this ticket, add them to the ticket's rules field via \`update_issue\`.
- **Status**: Update the ticket status as you progress:
  - \`in_progress\` — when you begin active work
  - \`review\` — when handing off for review
  - \`approved\` — after QA approval (QA sets this)
  - \`done\` — when work is complete and merged (triggers Coach review)

### Knowledge Maintenance
- **Project docs** (\`.dev/\` folder): Use the \`write_project_doc\` tool for high-level project context — architecture decisions, API designs, schema, implementation plans. Keep these aligned with the actual codebase. Do NOT put agent-specific working knowledge here.
- **AGENTS.md**: For practical conventions, commands, and constraints that agents need when working on this project. Update via git in the repo.
- **Company KB**: Use the \`upsert_kb_doc\` tool for organizational knowledge that spans projects — company policies, standards, and shared conventions.

### Sub-Agents & Parallel Exploration
- Use sub-agents aggressively to split up your work and explore alternative approaches in parallel.
- When facing a non-trivial decision, spawn sub-agents to try different approaches simultaneously. Each sub-agent works in an isolated worktree so branches don't interfere.
- Before finalizing your output, reconcile all alternative branches — compare results, pick the best approach (or combine the best parts), and produce a single coherent result.
- Sub-agents are for work within YOUR run. For delegating work to other team members, use sub-issues.

### Sub-Issue Delegation
- Use \`create_issue\` with \`parent_issue_id\` and \`assignee_slug\` to create sub-issues and delegate work to other agents.
- Use \`list_agents\` to find available agents and their slugs.
`;

export async function resolveSystemPrompt(
	db: PGlite,
	template: string,
	ctx: ResolveContext,
): Promise<string> {
	let resolved = template;

	// Cache companySlug for reuse across multiple resolutions
	let companySlug: string | undefined;

	if (resolved.includes('{{current_date}}')) {
		resolved = resolved.replace(/\{\{current_date\}\}/g, new Date().toISOString().slice(0, 10));
	}

	const needsCompany =
		resolved.includes('{{company_name}}') ||
		resolved.includes('{{company_description}}') ||
		resolved.includes('{{company_mission}}');

	if (needsCompany) {
		const result = await db.query<{ name: string; slug: string; description: string }>(
			'SELECT name, slug, description FROM companies WHERE id = $1',
			[ctx.companyId],
		);
		const row = result.rows[0];
		companySlug = row?.slug;
		resolved = resolved.replace(/\{\{company_name\}\}/g, row?.name ?? '');
		resolved = resolved.replace(/\{\{company_description\}\}/g, row?.description ?? '');
		resolved = resolved.replace(/\{\{company_mission\}\}/g, row?.description ?? '');
	}

	if (resolved.includes('{{reports_to}}')) {
		let managerName = '';
		if (ctx.agentId) {
			const result = await db.query<{ display_name: string }>(
				`SELECT m.display_name FROM member_agents ma
				 JOIN members m ON m.id = ma.reports_to
				 WHERE ma.id = $1`,
				[ctx.agentId],
			);
			managerName = result.rows[0]?.display_name ?? '';
		}
		resolved = resolved.replace(/\{\{reports_to\}\}/g, managerName);
	}

	if (resolved.includes('{{kb_context}}')) {
		const docs = await db.query<{ title: string; content: string }>(
			'SELECT title, content FROM kb_docs WHERE company_id = $1 ORDER BY title',
			[ctx.companyId],
		);
		const kbText =
			docs.rows.length > 0
				? docs.rows.map((d) => `## ${d.title}\n${d.content}`).join('\n\n---\n\n')
				: 'No knowledge base documents available.';
		resolved = resolved.replace(/\{\{kb_context\}\}/g, kbText);
	}

	if (resolved.includes('{{skills_context}}')) {
		let skillsText = 'No skills configured.';
		const dbSkills = await db.query<{ name: string; content: string }>(
			'SELECT name, content FROM skills WHERE company_id = $1 AND is_active = true ORDER BY name',
			[ctx.companyId],
		);
		if (dbSkills.rows.length > 0) {
			skillsText = dbSkills.rows
				.map((s) => `## Skill: ${s.name}\n${s.content}`)
				.join('\n\n---\n\n');
		}
		resolved = resolved.replace(/\{\{skills_context\}\}/g, skillsText);
	}

	if (resolved.includes('{{company_preferences_context}}')) {
		const prefs = await db.query<{ content: string }>(
			'SELECT content FROM company_preferences WHERE company_id = $1',
			[ctx.companyId],
		);
		const prefsText =
			prefs.rows.length > 0 && prefs.rows[0].content
				? prefs.rows[0].content
				: 'No preferences set.';
		resolved = resolved.replace(/\{\{company_preferences_context\}\}/g, prefsText);
	}

	if (resolved.includes('{{project_docs_context}}')) {
		let docsText = 'No project documentation available.';
		if (ctx.projectId) {
			const docs = await db.query<{ filename: string; content: string }>(
				'SELECT filename, content FROM project_docs WHERE project_id = $1 ORDER BY filename',
				[ctx.projectId],
			);
			if (docs.rows.length > 0) {
				docsText = docs.rows.map((d) => `## ${d.filename}\n${d.content}`).join('\n\n---\n\n');
			}
		}
		resolved = resolved.replace(/\{\{project_docs_context\}\}/g, docsText);
	}

	if (resolved.includes('{{company_goals}}')) {
		const goals = await db.query<{
			title: string;
			description: string;
			project_name: string | null;
		}>(
			`SELECT g.title, g.description,
			        (SELECT name FROM projects p WHERE p.id = g.project_id) AS project_name
			 FROM goals g
			 WHERE g.company_id = $1 AND g.status = 'active'
			 ORDER BY g.created_at DESC`,
			[ctx.companyId],
		);
		const goalsText =
			goals.rows.length === 0
				? 'No active goals.'
				: goals.rows
						.map((g) => {
							const scope = g.project_name ? `Project: ${g.project_name}` : 'Company-wide';
							const desc = g.description?.trim() ? `\n  ${g.description}` : '';
							return `- **${g.title}** _(${scope})_${desc}`;
						})
						.join('\n\n');
		resolved = resolved.replace(/\{\{company_goals\}\}/g, goalsText);
	}

	resolved = resolved.replace(/\{\{requester_context\}\}/g, '');

	// Append shared working guidelines to every agent prompt
	resolved += SHARED_INSTRUCTIONS;

	return resolved;
}
