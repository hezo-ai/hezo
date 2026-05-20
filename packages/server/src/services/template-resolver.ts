import type { PGlite } from '@electric-sql/pglite';
import { terminalStatusParams } from '../lib/sql';

interface ResolveContext {
	teamId: string;
	projectId?: string;
	issueId?: string;
	agentId?: string;
	dataDir?: string;
	mode?: 'runtime' | 'preview' | 'placeholders';
}

const SHARED_INSTRUCTIONS = `

---

## Working Guidelines

### Ticket Maintenance
- **Progress**: Update the current ticket's progress_summary via \`update_issue\` at natural milestones to reflect what you've accomplished and what remains.
- **Rules**: The ticket \`rules\` field captures *how this ticket should be worked on* — approach constraints, guardrails, or required workflows that shape execution (e.g. "run the full suite before pushing", "consult the architect before touching auth", "do not edit migrations"). Add these via \`update_issue\` as you discover them. Do NOT use \`rules\` to pass project domain knowledge to a future agent — domain and scope context belongs in the ticket \`description\`; work-in-flight status belongs in \`progress_summary\`; project- or team-wide knowledge belongs in project docs (\`write_project_doc\`) or the team KB (\`upsert_kb_doc\`).
- **Status**: Update the ticket status as you progress:
  - \`in_progress\` — when you begin active work
  - \`review\` — when handing off for review
  - \`approved\` — after QA approval (QA sets this)
  - \`done\` — when work is complete and merged (triggers Coach review)

### Completion Handoff
- **Mark \`done\` instead of announcing completion via mentions.** When your work on the current ticket is genuinely complete (the deliverable exists, no further step from you is expected), call \`update_issue(status: "done")\`. Do not skip the status update and try to hand off via an \`@\`-mention to the next owner — the status transition *is* the handoff.
- **The server does the wake.** Marking a ticket terminal (\`done\`, \`closed\`, \`cancelled\`) walks the dependency graph: every ticket blocked on it has its status reconciled out of \`blocked\`, and its assignee is auto-woken. Coach is also woken automatically. You do not need to ping anyone — the server already has. To see which tickets your completion will unblock, look at the \`dependents\` field on \`get_issue\`.
- **Wrap-up comment carries no \`@\`-mentions.** A short closing comment (a sentence or two summarizing what shipped, optionally listing the bare identifiers of the dependents that will now unblock, e.g. \`BE-4\`, \`BE-5\`) is the right end-of-run move so humans following along have context. But **whenever a comment coincides with marking the ticket \`done\` in the same wrap-up step, do not \`@\`-mention any agent in that comment** — every notification the mention would serve is already covered by the auto-wake from the status transition, so an \`@\`-mention on top creates a redundant mention-source wakeup. If a truly out-of-band ping is needed (someone whose attention is unrelated to the dependency chain), do it as a separate later comment, not stapled to the done transition.

### Knowledge Maintenance
- **Project docs**: Use \`list_project_docs\`, \`read_project_doc\`, and \`write_project_doc\` for high-level project context — PRDs, architecture decisions, API designs, schemas, implementation plans. Docs live in the project-doc store and are addressed by bare filename (e.g. \`prd.md\`, \`spec.md\`, \`research.md\`) — they are NOT filesystem paths, so never prefix a folder. Keep them aligned with the actual codebase. Do NOT put agent-specific working knowledge here.
- **AGENTS.md**: For practical conventions, commands, and constraints that agents need when working on this project. Update via git in the repo.
- **Team KB**: Use the \`upsert_kb_doc\` tool for organizational knowledge that spans projects — team policies, standards, and shared conventions.

### Sub-Agents & Parallel Exploration
- Use sub-agents aggressively to split up your work and explore alternative approaches in parallel.
- When facing a non-trivial decision, spawn sub-agents to try different approaches simultaneously. Each sub-agent works in an isolated worktree so branches don't interfere.
- Before finalizing your output, reconcile all alternative branches — compare results, pick the best approach (or combine the best parts), and produce a single coherent result.
- Sub-agents are for work within YOUR run. For delegating work to other team members, use sub-issues.

### Sub-Issue Delegation
- Use \`create_issue\` with \`parent_issue_id\` and \`assignee_slug\` to create sub-issues and delegate work to other agents. The Teammates block above lists every enabled peer's slug — use \`list_agents\` only when you need details (description / reports_to) on a specific teammate.

### Comment Timing
- Post comments at the end of your run, after every other action. A comment almost always tends to be either a summary of what you did and/or a request for someone else to take a look — both are end-of-run moves.
- If your run will create new tickets (sub-issues, follow-ups, delegations) that the comment should reference, call \`create_issue\` first and quote the resulting identifiers in the wrap-up comment. A comment announcing work you have not yet filed leaves readers without anywhere to look.
- Skip play-by-play narration ("starting now", "halfway done"). The run record already shows every tool call you made; restating it in a comment burns wakeups for no gain.
- Acknowledging an @-mention per the mention-handoff guidance is itself a single end-of-turn comment, so the same rule applies — do any ticket creation first, then post once and end the turn.
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

	const needsTeam =
		resolved.includes('{{team_name}}') ||
		resolved.includes('{{team_description}}') ||
		resolved.includes('{{team_mission}}');

	if (needsTeam) {
		const result = await db.query<{ name: string; slug: string; description: string }>(
			'SELECT name, slug, description FROM teams WHERE id = $1',
			[ctx.teamId],
		);
		const row = result.rows[0];
		resolved = resolved.replace(/\{\{team_name\}\}/g, row?.name ?? '');
		resolved = resolved.replace(/\{\{team_description\}\}/g, row?.description ?? '');
		resolved = resolved.replace(/\{\{team_mission\}\}/g, row?.description ?? '');
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

	if (resolved.includes('{{team_context}}')) {
		let teamContext = '';
		if (ctx.agentId) {
			const result = await db.query<{ team_context: string }>(
				'SELECT team_context FROM member_agents WHERE id = $1',
				[ctx.agentId],
			);
			teamContext = result.rows[0]?.team_context ?? '';
		}
		resolved = resolved.replace(/\{\{team_context\}\}/g, teamContext);
	}

	if (resolved.includes('{{kb_context}}')) {
		const docs = await db.query<{ title: string; slug: string; content: string }>(
			"SELECT title, slug, content FROM documents WHERE type = 'kb_doc' AND team_id = $1 ORDER BY title",
			[ctx.teamId],
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
			'SELECT name, content FROM skills WHERE team_id = $1 AND is_active = true ORDER BY name',
			[ctx.teamId],
		);
		if (dbSkills.rows.length > 0) {
			skillsText = dbSkills.rows
				.map((s) => `## Skill: ${s.name}\n${s.content}`)
				.join('\n\n---\n\n');
		}
		resolved = resolved.replace(/\{\{skills_context\}\}/g, skillsText);
	}

	if (resolved.includes('{{team_preferences_context}}')) {
		const prefs = await db.query<{ content: string }>(
			"SELECT content FROM documents WHERE type = 'team_preferences' AND team_id = $1",
			[ctx.teamId],
		);
		const prefsText =
			prefs.rows.length > 0 && prefs.rows[0].content
				? prefs.rows[0].content
				: 'No preferences set.';
		resolved = resolved.replace(/\{\{team_preferences_context\}\}/g, prefsText);
	}

	if (resolved.includes('{{project_docs_context}}')) {
		let docsText = 'No project documentation available.';
		if (ctx.projectId) {
			const docs = await db.query<{ filename: string; content: string }>(
				"SELECT slug AS filename, content FROM documents WHERE type = 'project_doc' AND project_id = $1 ORDER BY slug",
				[ctx.projectId],
			);
			if (docs.rows.length > 0) {
				const body = docs.rows.map((d) => `### ${d.filename}\n${d.content}`).join('\n\n---\n\n');
				docsText = [
					'The following project docs are stored in the project-doc database, not the filesystem.',
					'To modify any of them, use `write_project_doc` (with the bare filename, e.g. `prd.md`).',
					'The filesystem `Edit`/`Write` tools will NOT work on these — they are not files in your worktree.',
					'',
					body,
				].join('\n');
			}
		}
		resolved = resolved.replace(/\{\{project_docs_context\}\}/g, docsText);
	}

	if (resolved.includes('{{team_goals}}')) {
		const goals = await db.query<{
			title: string;
			description: string;
			project_name: string | null;
		}>(
			`SELECT g.title, g.description,
			        (SELECT name FROM projects p WHERE p.id = g.project_id) AS project_name
			 FROM goals g
			 WHERE g.team_id = $1 AND g.status = 'active'
			 ORDER BY g.created_at DESC`,
			[ctx.teamId],
		);
		const goalsText =
			goals.rows.length === 0
				? 'No active goals.'
				: goals.rows
						.map((g) => {
							const scope = g.project_name ? `Project: ${g.project_name}` : 'Team-wide';
							const desc = g.description?.trim() ? `\n  ${g.description}` : '';
							return `- **${g.title}** _(${scope})_${desc}`;
						})
						.join('\n\n');
		resolved = resolved.replace(/\{\{team_goals\}\}/g, goalsText);
	}

	resolved = resolved.replace(/\{\{requester_context\}\}/g, '');

	if (ctx.mode === 'placeholders') {
		return resolved;
	}

	if (ctx.mode !== 'preview') {
		resolved += buildRunContextBlock(ctx);
	}
	resolved += await buildProjectStateBlock(db, ctx);
	resolved += await buildTeamContextBlock(db, ctx);
	resolved += await buildTeammatesBlock(db, ctx);
	resolved += SHARED_INSTRUCTIONS;

	return resolved;
}

async function buildTeamContextBlock(db: PGlite, ctx: ResolveContext): Promise<string> {
	if (!ctx.agentId) return '';

	const result = await db.query<{ team_context: string }>(
		'SELECT team_context FROM member_agents WHERE id = $1',
		[ctx.agentId],
	);
	const content = result.rows[0]?.team_context?.trim() ?? '';
	if (!content) return '';

	return `

---

## Your Team

Your relationship to every other employee in the team, precomputed so you don't need to derive the org chart from scratch. Regenerated by the Captain when teammates are added, removed, or restructured.

${content}`;
}

async function buildTeammatesBlock(db: PGlite, ctx: ResolveContext): Promise<string> {
	const teammates = await db.query<{ slug: string; title: string }>(
		`SELECT ma.slug, ma.title
		 FROM member_agents ma
		 JOIN members m ON m.id = ma.id
		 WHERE m.team_id = $1
		   AND ma.admin_status = 'enabled'
		   AND ($2::uuid IS NULL OR ma.id <> $2::uuid)
		 ORDER BY ma.title`,
		[ctx.teamId, ctx.agentId ?? null],
	);

	const list =
		teammates.rows.length === 0
			? '_No other enabled teammates in this team._'
			: teammates.rows.map((t) => `- @${t.slug} — ${t.title}`).join('\n');

	return `

---

## Teammates

Whenever you reference a teammate in any output you author (comments, ticket descriptions, progress summaries, project docs, KB docs, chat messages), write \`@<slug>\` from this list — not the role title. Bare titles do not linkify and do not wake the teammate. This applies even when a role section above names a teammate by title; the canonical reference form is the slug.

${list}`;
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
	const lines = [`- Team ID: ${ctx.teamId}`];
	if (ctx.projectId) lines.push(`- Project ID: ${ctx.projectId}`);
	if (ctx.issueId) lines.push(`- Issue ID: ${ctx.issueId}`);
	return `

---

## Run Context

You are currently running with the following identifiers. Pass them directly to MCP tools that take \`team_id\` / \`project_id\` / \`issue_id\` — do not guess or re-derive them.

${lines.join('\n')}`;
}
