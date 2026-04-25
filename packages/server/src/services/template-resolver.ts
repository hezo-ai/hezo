import type { PGlite } from '@electric-sql/pglite';
import { terminalStatusParams } from '../lib/sql';

interface ResolveContext {
	companyId: string;
	projectId?: string;
	issueId?: string;
	agentId?: string;
	dataDir?: string;
}

const SHARED_INSTRUCTIONS = `

---

## Working Guidelines

### Ticket Maintenance
- **Progress**: Update the current ticket's progress_summary via \`update_issue\` at natural milestones to reflect what you've accomplished and what remains.
- **Rules**: The ticket \`rules\` field captures *how this ticket should be worked on* — approach constraints, guardrails, or required workflows that shape execution (e.g. "run the full suite before pushing", "consult the architect before touching auth", "do not edit migrations"). Add these via \`update_issue\` as you discover them. Do NOT use \`rules\` to pass project domain knowledge to a future agent — domain and scope context belongs in the ticket \`description\`; work-in-flight status belongs in \`progress_summary\`; project- or company-wide knowledge belongs in project docs (\`write_project_doc\`) or the company KB (\`upsert_kb_doc\`).
- **Status**: Update the ticket status as you progress:
  - \`in_progress\` — when you begin active work
  - \`review\` — when handing off for review
  - \`approved\` — after QA approval (QA sets this)
  - \`done\` — when work is complete and merged (triggers Coach review)

### Knowledge Maintenance
- **Project docs**: Use \`list_project_docs\`, \`read_project_doc\`, and \`write_project_doc\` for high-level project context — PRDs, architecture decisions, API designs, schemas, implementation plans. Docs live in the project-doc store and are addressed by bare filename (e.g. \`prd.md\`, \`spec.md\`, \`research.md\`) — they are NOT filesystem paths, so never prefix a folder. Keep them aligned with the actual codebase. Do NOT put agent-specific working knowledge here.
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
		const docs = await db.query<{ title: string; slug: string; content: string }>(
			"SELECT title, slug, content FROM documents WHERE type = 'kb_doc' AND company_id = $1 ORDER BY title",
			[ctx.companyId],
		);
		const kbText =
			docs.rows.length > 0
				? docs.rows.map((d) => `## ${d.title} (link: ${d.slug})\n${d.content}`).join('\n\n---\n\n')
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
			"SELECT content FROM documents WHERE type = 'company_preferences' AND company_id = $1",
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
				"SELECT slug AS filename, content FROM documents WHERE type = 'project_doc' AND project_id = $1 ORDER BY slug",
				[ctx.projectId],
			);
			if (docs.rows.length > 0) {
				docsText = docs.rows
					.map((d) => `## ${d.filename} (link: ${d.filename})\n${d.content}`)
					.join('\n\n---\n\n');
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

	resolved += buildRunContextBlock(ctx);
	resolved += await buildProjectStateBlock(db, ctx);
	resolved += SHARED_INSTRUCTIONS;

	return resolved;
}

const PROJECT_STATE_RECENT_LIMIT = 20;
const PROJECT_STATE_CREATED_LIMIT = 10;

async function buildProjectStateBlock(db: PGlite, ctx: ResolveContext): Promise<string> {
	if (!ctx.projectId) return '';

	const terminal = terminalStatusParams(2, true);
	const recent = await db.query<{
		identifier: string;
		title: string;
		status: string;
		priority: string;
		assignee_name: string | null;
	}>(
		`SELECT i.identifier, i.title, i.status::text AS status, i.priority::text AS priority,
		        m.display_name AS assignee_name
		 FROM issues i
		 LEFT JOIN members m ON m.id = i.assignee_id
		 WHERE i.project_id = $1
		   AND i.status NOT IN (${terminal.placeholders})
		 ORDER BY i.updated_at DESC
		 LIMIT ${PROJECT_STATE_RECENT_LIMIT}`,
		[ctx.projectId, ...terminal.values],
	);

	const recentText =
		recent.rows.length === 0
			? '_No active tickets in this project._'
			: recent.rows.map(formatRecentTicket).join('\n');

	let createdSection = '';
	if (ctx.agentId) {
		const created = await db.query<{
			identifier: string;
			title: string;
			status: string;
			assignee_name: string | null;
		}>(
			`SELECT i.identifier, i.title, i.status::text AS status,
			        m.display_name AS assignee_name
			 FROM issues i
			 JOIN heartbeat_runs r ON r.id = i.created_by_run_id
			 LEFT JOIN members m ON m.id = i.assignee_id
			 WHERE r.member_id = $1
			   AND i.project_id = $2
			 ORDER BY i.created_at DESC
			 LIMIT ${PROJECT_STATE_CREATED_LIMIT}`,
			[ctx.agentId, ctx.projectId],
		);

		const createdText =
			created.rows.length === 0
				? '_You have not created any tickets in this project on prior runs._'
				: created.rows.map(formatCreatedTicket).join('\n');

		createdSection = `

### Tickets you created on prior runs (newest first)

${createdText}`;
	}

	return `

---

## Project State

A live snapshot of this project, regenerated every run from the database. Read this before calling \`list_issues\` — if a ticket is here, it already exists and you don't need to spawn a duplicate.

### Active tickets (top ${PROJECT_STATE_RECENT_LIMIT}, most recently updated, non-terminal)

${recentText}${createdSection}`;
}

function formatRecentTicket(t: {
	identifier: string;
	title: string;
	status: string;
	priority: string;
	assignee_name: string | null;
}): string {
	const assignee = t.assignee_name ?? 'unassigned';
	return `- ${t.identifier} — ${t.title} (${t.status}, ${t.priority}, assigned to ${assignee})`;
}

function formatCreatedTicket(t: {
	identifier: string;
	title: string;
	status: string;
	assignee_name: string | null;
}): string {
	const assignee = t.assignee_name ?? 'unassigned';
	return `- ${t.identifier} — ${t.title} (${t.status}, assigned to ${assignee})`;
}

function buildRunContextBlock(ctx: ResolveContext): string {
	const lines = [`- Company ID: ${ctx.companyId}`];
	if (ctx.projectId) lines.push(`- Project ID: ${ctx.projectId}`);
	if (ctx.issueId) lines.push(`- Issue ID: ${ctx.issueId}`);
	return `

---

## Run Context

You are currently running with the following identifiers. Pass them directly to MCP tools that take \`company_id\` / \`project_id\` / \`issue_id\` — do not guess or re-derive them.

${lines.join('\n')}`;
}
