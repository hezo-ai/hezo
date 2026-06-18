import type { PGlite } from '@electric-sql/pglite';
import { CHAT_MEMORY_SLUG } from '@hezo/shared';
import { terminalStatusParams } from '../lib/sql';

interface ResolveContext {
	teamId: string;
	projectId?: string;
	taskId?: string;
	agentId?: string;
	dataDir?: string;
	mode?: 'runtime' | 'preview' | 'placeholders';
	/**
	 * The session roams across every team rather than being scoped to one (the CEO
	 * chat). Run-scoped blocks that pin to a single team/project — Project State,
	 * Teammates, and the identifier list in Run Context — are suppressed, since
	 * pinning them to the home team (HQ) would misreport every other project.
	 */
	crossTeam?: boolean;
}

const SHARED_INSTRUCTIONS = `

---

## Working Guidelines

### Ticket Maintenance
- **Progress**: Update the current ticket's progress_summary via \`update_task\` at natural milestones to reflect what you've accomplished and what remains. The latest progress_summary is surfaced (in full, alongside the description and rules) at the top of every run, so each run picks up where the last one left off — keep it current.
- **Rules**: The ticket \`rules\` field captures *how this ticket should be worked on* — approach constraints, guardrails, or required workflows that shape execution (e.g. "run the full suite before pushing", "consult the architect before touching auth", "do not edit migrations"). Add these via \`update_task\` as you discover them. Do NOT use \`rules\` to pass project domain knowledge to a future agent — domain and scope context belongs in the ticket \`description\`; work-in-flight status belongs in \`progress_summary\`; project- or team-wide knowledge belongs in project docs (\`write_project_doc\`) or the team skills database (\`create_skill\`).
- **Status**: Update the ticket status as you progress:
  - \`in_progress\` — when you begin active work
  - \`review\` — when handing off for review
  - \`approved\` — after QA approval (QA sets this)
  - \`done\` — when work is complete and merged (triggers Coach review)
- **One ticket per run.** This run is scoped to the single ticket shown in the Current Task block above. Drive only *that* ticket to \`in_progress\` and do only its work in this run. If another of your tickets needs progressing, leave it — its own run (your next heartbeat, or an assignment) picks it up. Route work elsewhere through the structural channels (a sub-task, a \`blocked_by\` dependency, or a comment/@-mention), but never flip a *different* ticket to \`in_progress\` or start executing it inside this run.

### Completion Handoff
- **Mark \`done\` instead of announcing completion via mentions.** When your work on the current ticket is genuinely complete (the deliverable exists, no further step from you is expected), call \`update_task(status: "done")\`. Do not skip the status update and try to hand off via an \`@\`-mention to the next owner — the status transition *is* the handoff.
- **The server does the wake.** Marking a ticket terminal (\`done\`, \`closed\`, \`cancelled\`) walks the dependency graph: every ticket blocked on it has its status reconciled out of \`blocked\`, and its assignee is auto-woken. Coach is also woken automatically. You do not need to ping anyone — the server already has. To see which tickets your completion will unblock, look at the \`dependents\` field on \`get_task\`.
- **Wrap-up comment carries no \`@\`-mentions.** A short closing comment (a sentence or two summarizing what shipped, optionally listing the bare identifiers of the dependents that will now unblock, e.g. \`BE-4\`, \`BE-5\`) is the right end-of-run move so humans following along have context. But **whenever a comment coincides with marking the ticket \`done\` in the same wrap-up step, do not \`@\`-mention any agent in that comment** — every notification the mention would serve is already covered by the auto-wake from the status transition, so an \`@\`-mention on top creates a redundant mention-source wakeup. If a truly out-of-band ping is needed (someone whose attention is unrelated to the dependency chain), do it as a separate later comment, not stapled to the done transition.
- **Don't park a ticket \`blocked\` when your own deliverable is already done.** If the only remaining work genuinely belongs to a *separate* unfinished ticket (e.g. your plan/content is finished, but launch execution needs another ticket's not-yet-built feature), that remainder is its own deliverable: file it as a top-level ticket with \`blocked_by_task_ids\` set to the gating ticket, then mark your current ticket \`done\`. The cascade wakes the follow-up's assignee when the blocker clears. Apply the deliverable-feed test — if the remainder feeds *this* ticket's deliverable, keep it here; if it can't proceed without external work and isn't part of this deliverable, it's a new ticket, not a reason to sit blocked.
- **When a ticket can't close until remediation you're routing out is done, GATE it — don't leave it open and don't orphan the follow-up.** A review/audit/QA ticket that surfaces findings cannot be considered done until those findings are fixed and re-verified. The failure mode: you (or a consolidator) open a *fix* ticket for the findings and leave the originating review ticket sitting in \`in_progress\`/\`review\` with only a passive "Linked from …" reference. That link is informational — it creates **no** wake. Nothing re-opens the review when the fix lands, so it rots, and anything \`blocked_by\` the review (a deploy, a release) never unblocks. Instead, the moment the fix ticket exists, set the originating review ticket(s) \`blocked_by\` it via \`add_task_blocker\` (or \`blocked_by_task_ids\` at create time). \`blocked_by\` is many-to-many: one consolidated fix ticket can gate *several* review tickets (e.g. a QA review and a Security review both gated on one remediation ticket), and several fixes can gate one review. When every blocker reaches terminal the server reconciles each review ticket out of \`blocked\` and wakes its owner to re-verify and close — and only then do *their* dependents unblock in turn. Prefer this over a sub-task whenever the fix has its own review/merge lifecycle or feeds more than one review ticket. This applies whether you own the review ticket or are a consolidator wiring someone else's: the edge is what makes the pipeline continuous.

### @-Mention Discipline (\`@\` vs \`@@\`)
- **The test: are you talking *about* a teammate, or *to* them?** Naming, crediting, attributing, tabulating, or summarizing a teammate is talking *about* them → \`@@<slug>\` (passive, no wake). Telling a teammate to do something on **this** ticket — "you can proceed", "go ahead", "please implement / review / merge / fix" — is talking *to* them → \`@<slug>\` (active, wakes them here). Before every mention ask: *am I referring to them, or instructing them?* Referring → \`@@\`; instructing → \`@\`. When unsure which, it's a reference: default to \`@@\`.
- **A direct instruction is the only wake there is — never mark it passive.** The case that bites: telling *this ticket's own assignee* to act while the ticket stays non-terminal — "you can proceed", a reviewer approving and asking the assignee to merge, or handing a ticket back for changes. The assignee being on the ticket is **not** a pending wake; your comment does not re-wake them. A passive \`@@\` there pings no one and the ticket stalls with both sides waiting. If you're writing "proceed / go ahead / please merge / please fix", it must be \`@\`.
- **What \`@<slug>\` does.** An \`@<slug>\` in a comment creates a mention-wakeup for that agent **on the ticket where the comment was posted**. Use it only when you want that agent to act on *this* ticket — answering a question you've asked, taking a decision you're blocked on, or otherwise engaging here.
- **Status updates and review recaps credit people — they don't ping them.** "From @@ui-designer's review", "incorporating @@qa-engineer's findings", "per @@security-engineer" are attributions, not asks → \`@@\`. A recap or status comment that names several teammates should carry **at most one** active \`@\` — the single person you actually need to act here, if any. If you've written more than one \`@\` in a summary, that's the tell you've mis-marked passive references as active and are about to wake the whole roster.
- **Structural routing already wakes the recipient — don't \`@\` them on top of it.** When work has been routed to a teammate through any of the three structural channels — \`create_task\` with \`assignee_slug\`, \`blocked_by_task_ids\` that will unblock when this ticket goes terminal, or an existing dependent ticket assigned to them that the cascade unblock will release — the server is already wiring the wake on *their* ticket. An \`@<slug>\` in the comment here doesn't help them; it spawns a redundant mention-source wakeup on **this** ticket, which is no longer theirs to act on. Write the reference as \`@@<slug>\` instead.
- **Handoff comments specifically.** If your comment is "I'm done with this; the next role's tickets are now unblocked / are now assigned to them," reference the next role as \`@@<slug>\`, not \`@<slug>\`. Then mark this ticket terminal — the cascade unblock (or the existing assignment) is what wakes them, on the ticket the work lives on. Naming them with \`@\` here wakes them on the wrong ticket. Most common antipattern: an "Assignee" column in a plan-fan-out table written with \`@<slug>\` — every row wakes that agent on this ticket for no reason.
- **A handoff with nothing structural behind it uses active \`@\`.** The \`@@\`-for-handoffs rule above holds *only* when something else will wake the recipient: you're marking this ticket terminal and they own a dependent the cascade releases, or you've just assigned them a ticket. When none of that is true — including a handoff back to this ticket's own assignee that flips nothing — the mention is the **only** wake there is, so it must be a single active \`@<slug>\` (see the direct-instruction rule above).
- **Use \`@@<slug>\` for passive references.** When you need to *name* a teammate in prose, a plan table, or a wrap-up / handoff summary without pinging them, write \`@@<slug>\`. The double-\`@\` form renders as a clickable teammate chip — shown as the bare slug, **without** the \`@\` prefix, so a human can see at a glance it won't wake anyone — but is not extracted as a mention, so no wakeup fires.
- **Rubric.** "@ui-designer — you can proceed with the design" — a direct instruction to this ticket's assignee, the only wake there is → \`@\`. "Hey @architect, please confirm the spec here" — active, wakes architect on this ticket → \`@\`. "BE-2 is assigned to @@researcher, BE-3 to @@product-lead" — passive, just naming who owns what → \`@@\`. "Approved. @@architect — BE-4 and BE-5 unblock now" — passive handoff, the cascade does the wake → \`@@\`. "From @@ui-designer review (12 findings); @@security-engineer flagged 3 — all addressed" — passive recap, crediting reviewers → \`@@\`. "Shipped cleanly: @@product-lead drafted the PRD, @@admin approved on first review" — passive recap, crediting the admin; an active \`@admin\` is a decision-needed signal that lands a row in every admin's inbox → \`@@\`.

### Knowledge Maintenance
- **Project docs**: Use \`list_project_docs\`, \`read_project_doc\`, and \`write_project_doc\` for high-level project context — PRDs, architecture decisions, API designs, schemas, implementation plans. Docs live in the project-doc store and are addressed by bare filename (e.g. \`prd.md\`, \`spec.md\`, \`research.md\`) — they are NOT filesystem paths, so never prefix a folder. Keep them aligned with the actual codebase. Do NOT put agent-specific working knowledge here.
- **Project assets**: Use \`list_project_assets\`, \`read_project_asset\`, and \`write_project_asset\` for non-markdown files — UI mockups, wireframes, SVG diagrams, PDFs. Like docs, they are addressed by bare filename (e.g. \`ui-mockups.html\`), not filesystem paths; \`read_project_asset\` returns text-based assets inline. They are also bind-mounted read-only into your container at \`/workspace/.hezo/assets/\` if you need to open one on disk.
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
- For services with an MCP server: call \`register_connector\` with the MCP URL and (if applicable) a \`skill_id\` from \`fetch_skill_file\`. This posts a connect_required comment with a Connect button for the human; once they authorize, the MCP becomes available across every team agent run with the token substituted at egress.
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
- If your tool list doesn't include the MCP's tools but \`oauth_status\` is \`"active"\`, it's NOT a "waiting on auth" situation. Call \`test_connector(connector_id)\` — it resolves the stored token server-side and pings the MCP URL directly, bypassing the container entirely. The result tells you (a) whether the token is still valid against the provider (and if not, surface to the user so they can reconnect), or (b) the token is valid and the issue is in the container/proxy chain (post a wrap-up comment explaining what \`test_connector\` returned so the human can file a bug).
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
			'SELECT name, slug, description FROM skills WHERE is_active = true ORDER BY name',
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

	// Project docs are injected as a manifest (filename + optional title + updated date),
	// not full bodies. The agent calls read_project_doc(filename) to load a doc on demand.
	// Hand-rolled SQL (vs listDocuments) avoids pulling the content column, which is
	// the whole point of switching away from full-body injection.
	if (resolved.includes('{{project_docs_context}}')) {
		let docsText = 'No project documentation available.';
		if (ctx.projectId) {
			// chat-memory.md (HQ) is injected in full into the chatbox prompt, so it
			// is excluded from the manifest — listing it would tell the agent to
			// read_project_doc something it already has verbatim.
			const docs = await db.query<{ filename: string; title: string; updated_at: string }>(
				"SELECT slug AS filename, title, updated_at FROM documents WHERE type = 'project_doc' AND project_id = $1 AND slug != $2 ORDER BY slug",
				[ctx.projectId, CHAT_MEMORY_SLUG],
			);
			if (docs.rows.length > 0) {
				const lines = docs.rows
					.map((d) => {
						const date = new Date(d.updated_at).toISOString().slice(0, 10);
						const titlePart = d.title ? ` — ${d.title}` : '';
						return `- ${d.filename}${titlePart} (updated ${date})`;
					})
					.join('\n');
				docsText = [
					'The project docs database holds high-level project context (PRDs, specs, architecture decisions, research). Entries are listed below by filename.',
					"Call read_project_doc(filename) to load a doc's full contents when relevant to your task. These docs live in the database, not the filesystem — there is no /workspace/.hezo/project-docs path, so don't use the Read/cat file tools; load each one by its bare filename through read_project_doc.",
					'',
					lines,
				].join('\n');
			}
		}
		resolved = resolved.replace(/\{\{project_docs_context\}\}/g, docsText);
	}

	// Instance-wide project roster. Only the CEO's prompt carries this placeholder
	// (it is the one agent with cross-team reach), so a worker prompt never leaks
	// other teams' projects. Regenerated every turn, so the CEO answers "what
	// projects do we have?" from live state instead of memory.
	if (resolved.includes('{{projects_context}}')) {
		resolved = resolved.replace(/\{\{projects_context\}\}/g, await buildProjectsContext(db));
	}

	resolved = resolved.replace(/\{\{requester_context\}\}/g, '');

	if (ctx.mode === 'placeholders') {
		return resolved;
	}

	if (ctx.mode !== 'preview') {
		resolved += await buildRunContextBlock(db, ctx);
		if (!ctx.crossTeam) {
			resolved += await buildRepositoryBlock(db, ctx);
		}
	}
	if (!ctx.crossTeam) {
		resolved += await buildProjectStateBlock(db, ctx);
	}
	resolved += await buildTeamContextBlock(db, ctx);
	if (!ctx.crossTeam) {
		resolved += await buildTeammatesBlock(db, ctx);
	}
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

Whenever you reference a teammate in any output you author (comments, ticket descriptions, progress summaries, project docs, skills, chat messages), write \`@<slug>\` (active) or \`@@<slug>\` (passive) from this list — never the role title. Bare titles do not linkify. **Default to \`@@\`** — passive is the presumption for naming, attribution, plan tables, and summaries; reach for single-\`@\` only when you need that teammate to act on *this* ticket. See "@-Mention Discipline" below.

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

/**
 * Instance-wide roster of every project-team (HQ excluded). Resolved inline for
 * the `{{projects_context}}` placeholder, which only the CEO's prompt carries.
 * Uses slugs/names — never UUIDs — because this text is also what the CEO echoes
 * back to the operator in the chat box.
 */
async function buildProjectsContext(db: PGlite): Promise<string> {
	const terminal = terminalStatusParams(1, true);
	const projects = await db.query<{
		name: string;
		slug: string;
		task_prefix: string;
		open_task_count: number;
		created_at: string;
	}>(
		`SELECT p.name, p.slug, p.task_prefix,
		        (SELECT count(*) FROM tasks i
		         WHERE i.project_id = p.id AND i.status NOT IN (${terminal.placeholders}))::int AS open_task_count,
		        p.created_at
		 FROM projects p
		 WHERE p.is_internal = false
		 ORDER BY p.created_at DESC`,
		terminal.values,
	);

	const intro =
		'Hezo is project-centric: one organisation containing many projects, each with its own Captain and roster of agents. As the instance CEO you have automatic cross-project reach over every one of them. The roster of projects below (HQ, your home, excluded) is regenerated every turn from the live database — trust it over memory, and never tell the operator a project does not exist without checking here first. When you name a project or ticket in the chat box, use its slug, identifier, or name (e.g. the project `todo6`, ticket `TO-1`) — never a raw UUID. To read or act inside a project, pass its slug (shown on its line below) as the `project` argument to tools like `list_tasks` / `list_agents`; or call `list_projects` for this same live list.';

	if (projects.rows.length === 0) {
		return `${intro}\n\n_No projects exist yet beyond HQ. When the operator wants to start one, take it through project intake._`;
	}

	const lines = projects.rows
		.map((p) => {
			const date = new Date(p.created_at).toISOString().slice(0, 10);
			const open = `${p.open_task_count} open ticket${p.open_task_count === 1 ? '' : 's'}`;
			return `- ${p.name} (slug: ${p.slug}, prefix: ${p.task_prefix}) — ${open}, created ${date}`;
		})
		.join('\n');

	return `${intro}\n\n${lines}`;
}

async function buildRunContextBlock(db: PGlite, ctx: ResolveContext): Promise<string> {
	if (ctx.crossTeam) {
		return `

---

## Run Context

You are not scoped to a single project — you roam across the whole org, so there is no "current" project for tools to default to. To read or act inside a specific project, take its slug from the roster above and pass it as the \`project\` argument to tools like \`list_tasks\` / \`list_agents\`.`;
	}

	let projectSlug = '';
	if (ctx.projectId) {
		const r = await db.query<{ slug: string }>('SELECT slug FROM projects WHERE id = $1', [
			ctx.projectId,
		]);
		projectSlug = r.rows[0]?.slug ?? '';
	}
	let taskIdentifier = '';
	if (ctx.taskId) {
		const r = await db.query<{ identifier: string }>('SELECT identifier FROM tasks WHERE id = $1', [
			ctx.taskId,
		]);
		taskIdentifier = r.rows[0]?.identifier ?? '';
	}

	const lines: string[] = [];
	if (projectSlug) lines.push(`- Project: \`${projectSlug}\``);
	if (taskIdentifier) lines.push(`- Current ticket: \`${taskIdentifier}\``);

	return `

---

## Run Context

This run operates inside one project. MCP tools that take a \`project\` argument default to it — omit \`project\` to act here, and only pass another project's slug to reach a different one. Reference tickets by their identifier (e.g. \`${taskIdentifier || 'ABC-12'}\`), never a UUID.${lines.length ? `\n\n${lines.join('\n')}` : ''}`;
}

interface RepoContextRow {
	repo_identifier: string;
	host_type: string;
	is_designated: boolean | null;
}

/**
 * Names the project's designated repository in-prompt so an agent never has to
 * guess where its code goes. The repo is already cloned and the run's working
 * directory is a worktree checked out from it (so `origin` is preconfigured to
 * it over SSH). Without this, agents that need to push or open a PR have no idea
 * the repo exists and invent a name — then chase a PAT / disable TLS / create a
 * brand-new repo to make their invented name work. Regenerated every run from
 * live DB state; omitted entirely when the project has no linked repo (a
 * code-touching run with no repo is gated upstream by the repo-setup approval).
 */
async function buildRepositoryBlock(db: PGlite, ctx: ResolveContext): Promise<string> {
	if (!ctx.projectId) return '';

	const repos = await db.query<RepoContextRow>(
		`SELECT r.repo_identifier, r.host_type::text AS host_type,
		        (r.id = p.designated_repo_id) AS is_designated
		 FROM repos r
		 JOIN projects p ON p.id = r.project_id
		 WHERE r.project_id = $1
		 ORDER BY (r.id = p.designated_repo_id) DESC NULLS LAST, r.created_at ASC`,
		[ctx.projectId],
	);
	if (repos.rows.length === 0) return '';

	const designated = repos.rows.find((r) => r.is_designated === true) ?? repos.rows[0];
	const others = repos.rows.filter((r) => r !== designated);

	const repoLines = [
		`- Designated repository: \`${designated.repo_identifier}\` (${designated.host_type})`,
	];
	if (others.length > 0) {
		repoLines.push(`- Also linked: ${others.map((r) => `\`${r.repo_identifier}\``).join(', ')}`);
	}

	return `

---

## Repository

This project has a **designated repository** — the one and only place your code goes. It is already cloned into your workspace, and your run's working directory is a git worktree checked out from it, so the \`origin\` remote is already pointed at it. **Never create a new repository, invent a repo name, or repoint \`origin\`** — the repo below already exists and is the target for every push and pull request.

${repoLines.join('\n')}

- **Push to \`origin\` as-is.** \`git push -u origin <branch>\` (e.g. \`git push -u origin hezo/<TICKET>\`) works out of the box — git authenticates over **SSH** with the project's key. You do **not** need a GitHub Personal Access Token for git, so never call \`request_credential\` for a PAT to push or to create a repo.
- **Open and manage pull requests against this repository** with the \`github\` MCP tools (e.g. \`create_pull_request\`), targeting this repo. Use the \`github\` MCP for any other GitHub API need rather than raw \`curl\` to \`api.github.com\`.
- **Never disable TLS verification** (\`curl -k\`, \`-c http.sslVerify=false\`, \`GIT_SSL_NO_VERIFY\`). Outbound HTTPS is already trusted via the preconfigured CA; a TLS error is a signal to diagnose, not to bypass.
- If the \`github\` MCP is unavailable, push the branch and say so in your wrap-up — do not fall back to creating a repo or fetching a PAT.`;
}
