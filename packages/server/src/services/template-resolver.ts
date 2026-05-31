import type { PGlite } from '@electric-sql/pglite';
import { terminalStatusParams } from '../lib/sql';

interface ResolveContext {
	teamId: string;
	projectId?: string;
	taskId?: string;
	agentId?: string;
	dataDir?: string;
	mode?: 'runtime' | 'preview' | 'placeholders';
}

const SHARED_INSTRUCTIONS = `

---

## Working Guidelines

### Ticket Maintenance
- **Progress**: Update the current ticket's progress_summary via \`update_task\` at natural milestones to reflect what you've accomplished and what remains.
- **Rules**: The ticket \`rules\` field captures *how this ticket should be worked on* — approach constraints, guardrails, or required workflows that shape execution (e.g. "run the full suite before pushing", "consult the architect before touching auth", "do not edit migrations"). Add these via \`update_task\` as you discover them. Do NOT use \`rules\` to pass project domain knowledge to a future agent — domain and scope context belongs in the ticket \`description\`; work-in-flight status belongs in \`progress_summary\`; project- or team-wide knowledge belongs in project docs (\`write_project_doc\`) or the team skills database (\`create_skill\`).
- **Status**: Update the ticket status as you progress:
  - \`in_progress\` — when you begin active work
  - \`review\` — when handing off for review
  - \`approved\` — after QA approval (QA sets this)
  - \`done\` — when work is complete and merged (triggers Coach review)

### Completion Handoff
- **Mark \`done\` instead of announcing completion via mentions.** When your work on the current ticket is genuinely complete (the deliverable exists, no further step from you is expected), call \`update_task(status: "done")\`. Do not skip the status update and try to hand off via an \`@\`-mention to the next owner — the status transition *is* the handoff.
- **The server does the wake.** Marking a ticket terminal (\`done\`, \`closed\`, \`cancelled\`) walks the dependency graph: every ticket blocked on it has its status reconciled out of \`blocked\`, and its assignee is auto-woken. Coach is also woken automatically. You do not need to ping anyone — the server already has. To see which tickets your completion will unblock, look at the \`dependents\` field on \`get_task\`.
- **Wrap-up comment carries no \`@\`-mentions.** A short closing comment (a sentence or two summarizing what shipped, optionally listing the bare identifiers of the dependents that will now unblock, e.g. \`BE-4\`, \`BE-5\`) is the right end-of-run move so humans following along have context. But **whenever a comment coincides with marking the ticket \`done\` in the same wrap-up step, do not \`@\`-mention any agent in that comment** — every notification the mention would serve is already covered by the auto-wake from the status transition, so an \`@\`-mention on top creates a redundant mention-source wakeup. If a truly out-of-band ping is needed (someone whose attention is unrelated to the dependency chain), do it as a separate later comment, not stapled to the done transition.
- **Don't park a ticket \`blocked\` when your own deliverable is already done.** If the only remaining work genuinely belongs to a *separate* unfinished ticket (e.g. your plan/content is finished, but launch execution needs another ticket's not-yet-built feature), that remainder is its own deliverable: file it as a top-level ticket with \`blocked_by_task_ids\` set to the gating ticket, then mark your current ticket \`done\`. The cascade wakes the follow-up's assignee when the blocker clears. Apply the deliverable-feed test — if the remainder feeds *this* ticket's deliverable, keep it here; if it can't proceed without external work and isn't part of this deliverable, it's a new ticket, not a reason to sit blocked.

### @-Mention Discipline (\`@\` vs \`@@\`)
- **What \`@<slug>\` does.** An \`@<slug>\` in a comment creates a mention-wakeup for that agent **on the ticket where the comment was posted**. Use it only when you want that agent to act on *this* ticket — answering a question you've asked, taking a decision you're blocked on, or otherwise engaging here.
- **Structural routing already wakes the recipient — don't \`@\` them on top of it.** When work has been routed to a teammate through any of the three structural channels — \`create_task\` with \`assignee_slug\`, \`blocked_by_task_ids\` that will unblock when this ticket goes terminal, or an existing dependent ticket assigned to them that the cascade unblock will release — the server is already wiring the wake on *their* ticket. An \`@<slug>\` in the comment here doesn't help them; it spawns a redundant mention-source wakeup on **this** ticket, which is no longer theirs to act on. Write the reference as \`@@<slug>\` instead.
- **Handoff comments specifically.** If your comment is "I'm done with this; the next role's tickets are now unblocked / are now assigned to them," reference the next role as \`@@<slug>\`, not \`@<slug>\`. Then mark this ticket terminal — the cascade unblock (or the existing assignment) is what wakes them, on the ticket the work lives on. Naming them with \`@\` here wakes them on the wrong ticket. Most common antipattern: an "Assignee" column in a plan-fan-out table written with \`@<slug>\` — every row wakes that agent on this ticket for no reason.
- **Use \`@@<slug>\` for passive references.** When you need to *name* a teammate in prose, a plan table, or a wrap-up / handoff summary without pinging them, write \`@@<slug>\`. The double-\`@\` form renders as the same teammate chip as \`@<slug>\` in the board UI but is not extracted as a mention, so no wakeup fires.
- **Rubric.** "Hey @architect, please confirm the spec here" — active, wakes architect on this ticket → \`@\`. "BE-2 is assigned to @@researcher, BE-3 to @@product-lead" — passive, just naming who owns what → \`@@\`. "Approved. @@architect — BE-4 and BE-5 unblock now" — passive handoff, the cascade does the wake → \`@@\`.

### Knowledge Maintenance
- **Project docs**: Use \`list_project_docs\`, \`read_project_doc\`, and \`write_project_doc\` for high-level project context — PRDs, architecture decisions, API designs, schemas, implementation plans. Docs live in the project-doc store and are addressed by bare filename (e.g. \`prd.md\`, \`spec.md\`, \`research.md\`) — they are NOT filesystem paths, so never prefix a folder. Keep them aligned with the actual codebase. Do NOT put agent-specific working knowledge here.
- **AGENTS.md**: For practical conventions, commands, and constraints that agents need when working on this project. Update via git in the repo.
- **Skills database**: Use \`create_skill\` (or \`propose_skill\` when approval is required) to capture reusable, cross-project team know-how — MCP server usage, integration steps, conventions, how agents coordinate. A manifest of available skills is injected each run; call \`get_skill(slug)\` to read one in full.

### Sub-Agents & Parallel Exploration
- Use sub-agents aggressively to split up your work and explore alternative approaches in parallel.
- When facing a non-trivial decision, spawn sub-agents to try different approaches simultaneously. Each sub-agent works in an isolated worktree so branches don't interfere.
- Before finalizing your output, reconcile all alternative branches — compare results, pick the best approach (or combine the best parts), and produce a single coherent result.
- Sub-agents are for work within YOUR run. For delegating work to other team members, use sub-tasks.

### Sub-Task Delegation
- Use \`create_task\` with \`parent_task_id\` and \`assignee_slug\` to create sub-tasks and delegate work to other agents. The Teammates block above lists every enabled peer's slug — use \`list_agents\` only when you need details (description / reports_to) on a specific teammate.

### Fetching External URLs
- To read a web page or hit an HTTP endpoint, use \`curl\` (or \`wget\`) from the shell. The container's proxy and CA trust are preconfigured, so HTTPS to any host works with no extra flags.
- Use your native web-search tool for discovery, then fetch the resulting pages with \`curl\`/\`wget\`.

### Comment Timing
- Post comments at the end of your run, after every other action. A comment almost always tends to be either a summary of what you did and/or a request for someone else to take a look — both are end-of-run moves.
- If your run will create new tickets (sub-tasks, follow-ups, delegations) that the comment should reference, call \`create_task\` first and quote the resulting identifiers in the wrap-up comment. A comment announcing work you have not yet filed leaves readers without anywhere to look.
- Skip play-by-play narration ("starting now", "halfway done"). The run record already shows every tool call you made; restating it in a comment burns wakeups for no gain.
- Acknowledging an @-mention per the mention-handoff guidance is itself a single end-of-turn comment, so the same rule applies — do any ticket creation first, then post once and end the turn.

### Third-Party Credentials Always Land in the Hezo Vault
- Whenever you need to authenticate with a third-party service — MCP server, REST API, CLI tool, anything — the credential must be stored in the Hezo vault. Never leave a token, API key, OAuth bearer, or password in code, ticket descriptions, comments, project docs, or environment files you write.
- For services with an MCP server: call \`register_connector\` with the MCP URL and (if applicable) a \`skill_doc_id\` from \`fetch_skill_file\`. This posts a connect_required comment with a Connect button for the human; once they authorize, the MCP becomes available across every team agent run with the token substituted at egress.
- For bare API credentials (no MCP): call \`request_credential\` to ask the human for a paste, then reference the credential by its \`__HEZO_SECRET_<NAME>__\` placeholder in env vars or HTTP headers. The egress proxy substitutes the real value at request time; you never see it.
- If a CLI you ran has captured a token to disk in the container (e.g. a vendor login wrote \`~/.<vendor>/config.json\`), read that file, post the contents back to Hezo via \`request_credential\` so the value lands in the vault, then delete the local copy. The container is ephemeral; the vault is the long-term store.
- Whatever you do, do NOT commit credentials, paste them into a comment, log them, or write them into a file we'll persist. If you suspect a credential has leaked, mark it for rotation and surface the incident in a wrap-up comment.

#### Discovering MCP server URLs and skill files
- Most providers publish their MCP server URL on a docs page (e.g. \`https://www.<vendor>.com/docs/mcp-server\` or \`https://docs.<vendor>.com/mcp\`). When the user gives you a vendor name without a URL, \`WebSearch\` for \`"<vendor> MCP server"\` or fetch their docs page directly.
- An "agent skill file" is just markdown a vendor publishes describing how to use their MCP — same idea as \`AGENTS.md\`. Try in order: (1) the vendor's docs page itself (often the skill file content IS the docs page); (2) common GitHub paths like \`https://raw.githubusercontent.com/<vendor>/mcp-server/{main,master}/{AGENTS,SKILL,README}.md\`; (3) the MCP server's own discovery endpoints (after the connector is active, call \`tools/list\` to enumerate its capabilities).
- \`fetch_skill_file\` is not mandatory. If you can't find one, register the connector anyway — the MCP server's \`tools/list\` is the authoritative source of truth for what tools exist, and once auth completes those tools appear in your tool list with \`mcp__<connector_name>__<tool>\` names.

#### Interpreting connector status
- After calling \`register_connector\` or seeing an existing connector via \`list_mcp_connections\`, the field that tells you whether the MCP is **usable** is \`oauth_status\` (NOT \`install_status\`, which tracks local-package install for stdio MCPs and is meaningless for SaaS).
  - \`oauth_status = "active"\` → OAuth done, the MCP's tools appear in your tool list on this and future runs as \`mcp__<connector_name>__<tool>\`. If you've registered the connector and a previous run posted a Connect button, but you see "active" now AND no tools — flag it as a bug (auth completed but token isn't being used) rather than re-asking the human to connect.
  - \`oauth_status = "pending"\` → human hasn't clicked Connect yet. Don't repost the ask; the connect_required comment is still live.
  - \`oauth_status = "failed"\` → an attempt errored (read \`auth_error\` for the AS's message). Surface this to the human; they may need to retry or fix something.
  - \`oauth_status = "revoked"\` → a human explicitly disconnected. Don't auto-reconnect; ask first.
- If your tool list doesn't include the MCP's tools but \`oauth_status\` is \`"active"\`, it's NOT a "waiting on auth" situation. Call \`test_connector(team_id, connector_id)\` — it resolves the stored token server-side and pings the MCP URL directly, bypassing the container entirely. The result tells you (a) whether the token is still valid against the provider (and if not, surface to the user so they can reconnect), or (b) the token is valid and the issue is in the container/proxy chain (post a wrap-up comment explaining what \`test_connector\` returned so the human can file a bug).
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

	// kb_context retired: the knowledge base merged into the skills database.
	// Strip any leftover placeholder so it never leaks into a prompt.
	if (resolved.includes('{{kb_context}}')) {
		resolved = resolved.replace(/\{\{kb_context\}\}\n?/g, '');
	}

	// Skills are injected as a manifest (name + slug + summary), not full bodies.
	// The agent calls get_skill(slug) to load a skill's content on demand.
	if (resolved.includes('{{skills_context}}')) {
		const dbSkills = await db.query<{ name: string; slug: string; description: string }>(
			'SELECT name, slug, description FROM skills WHERE team_id = $1 AND is_active = true ORDER BY name',
			[ctx.teamId],
		);
		let skillsText = 'No skills in the team skills database yet.';
		if (dbSkills.rows.length > 0) {
			const lines = dbSkills.rows
				.map((s) => `- ${s.name} (slug: ${s.slug})${s.description ? `: ${s.description}` : ''}`)
				.join('\n');
			skillsText = [
				'The team skills database holds reusable know-how. Entries are listed below by name and slug.',
				"Call get_skill(slug) to load a skill's full instructions when it is relevant to your task.",
				'',
				lines,
			].join('\n');
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

Whenever you reference a teammate in any output you author (comments, ticket descriptions, progress summaries, project docs, skills, chat messages), write \`@<slug>\` (active) or \`@@<slug>\` (passive) from this list — never the role title. Bare titles do not linkify. See "@-Mention Discipline" below for when to use which: \`@\` for direct asks on this ticket, \`@@\` for naming, attribution, plan tables, and summaries.

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
		 FROM tasks i
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
			 FROM tasks i
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

A live snapshot of this project, regenerated every run from the database. Read this before calling \`list_tasks\` — if a ticket is here, it already exists and you don't need to spawn a duplicate.

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
	if (ctx.taskId) lines.push(`- Task ID: ${ctx.taskId}`);
	return `

---

## Run Context

You are currently running with the following identifiers. Pass them directly to MCP tools that take \`team_id\` / \`project_id\` / \`task_id\` — do not guess or re-derive them.

${lines.join('\n')}`;
}
