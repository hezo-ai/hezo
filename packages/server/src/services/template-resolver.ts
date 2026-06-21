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
  - \`approved\` — after a reviewer approves the work (the reviewer sets this)
  - \`done\` — when work is complete and delivered (triggers Coach review)
- **One ticket per run.** This run is scoped to the single ticket shown in the Current Task block above. Drive only *that* ticket to \`in_progress\` and do only its work in this run. If another of your tickets needs progressing, leave it — its own run (your next heartbeat, or an assignment) picks it up. Route work elsewhere through the structural channels (a sub-task, a \`blocked_by\` dependency, or a comment/@-mention), but never flip a *different* ticket to \`in_progress\` or start executing it inside this run.

### Creating Tickets
- **Check before you create.** Before every \`create_task\`, confirm no open ticket in this project already covers the same deliverable: \`list_tasks\` filtered by the project, scan titles and descriptions for the same outcome (semantic match, not just the same words), and check it is still open. If a match exists — comment on it (and \`@\`-mention the assignee if it is not you) instead of opening a second ticket; if it is assigned to you, work it; if it is stale or mis-scoped, fix it with \`update_task\`. Two tickets for one deliverable is always a bug. This holds whether you file for yourself or for a direct report. For work that should be owned by anyone outside your direct reports, see **Assigning Work** — comment with an \`@\`-mention rather than opening a ticket assigned to them.
- **Don't invent timelines or deadlines.** You do not know the calendar and your sense of elapsed time is unreliable. Never write fabricated milestone dates — "by Week 8", "before <date>", "non-negotiable deadline", "must ship by <date>" — in plans, ticket descriptions, or comments. Deadlines come only from the task description or an explicit admin instruction; quote the source when you cite one. When sequencing matters, use deliverable-relative language ("after X is delivered", "once review sign-off is in"), not calendar language.

### Ticket Dependencies
- **Declare order with the structured field, never prose.** When one ticket's output feeds another, set \`blocked_by_task_ids\` on \`create_task\` (or per item on \`create_tasks\`). The system gates the downstream assignee automatically: the ticket shows \`blocked\`, its assignee is not woken until every blocker reaches a terminal status (done, closed, cancelled), then is woken when the last one resolves. A prose "wait for X first" creates no edge — the assignee may be triggered before they should run.
- **Chain phases inside one \`create_tasks\` call** by referencing an earlier item by its zero-based index: \`blocked_by_task_ids: ['#0']\` points at the first item. File sequential phases in one call — Phase 1 unblocked, Phase 2 \`['#0']\`, Phase 3 \`['#1']\`, and so on. Unchained phases all become immediately runnable and execute simultaneously.
- **Gate upstream too, not only downstream.** A ticket that *executes* a finished plan must be created \`blocked_by\` every ticket whose output it consumes. Gating the work *below* it is not enough — that leaves the executing ticket itself with no open blocker, so its assignee starts before the upstream artifacts have landed. Wire both directions: each ticket gated on the work it depends on, and the work that depends on it gated on this ticket.
- **If a missed prerequisite surfaces later**, declare it with \`add_task_blocker\` — don't chase ordering in comments. If your *own* current ticket can't finish until another in-flight ticket lands, call \`add_task_blocker(task_id=<current>, blocked_by_task_id=<gating>)\` and end your turn; the system re-wakes you when the gating ticket reaches terminal. Never stop with only a prose "waiting on X" note while leaving the ticket \`in_progress\` — a textual reference creates no dependency edge, so nothing re-engages your ticket and the work strands silently.

### Completion Handoff
- **Mark \`done\` instead of announcing completion via mentions.** When your work on the current ticket is genuinely complete (the deliverable exists, no further step from you is expected), call \`update_task(status: "done")\`. Do not skip the status update and try to hand off via an \`@\`-mention to the next owner — the status transition *is* the handoff.
- **The server does the wake.** Marking a ticket terminal (\`done\`, \`closed\`, \`cancelled\`) walks the dependency graph: every ticket blocked on it has its status reconciled out of \`blocked\`, and its assignee is auto-woken. Coach is also woken automatically. You do not need to ping anyone — the server already has. To see which tickets your completion will unblock, look at the \`dependents\` field on \`get_task\`.
- **Wrap-up comment carries no \`@\`-mentions.** A short closing comment (a sentence or two summarizing what shipped, optionally listing the bare identifiers of the dependents that will now unblock, e.g. \`BE-4\`, \`BE-5\`) is the right end-of-run move so humans following along have context. But **whenever a comment coincides with marking the ticket \`done\` in the same wrap-up step, do not \`@\`-mention any agent in that comment** — every notification the mention would serve is already covered by the auto-wake from the status transition, so an \`@\`-mention on top creates a redundant mention-source wakeup. If a truly out-of-band ping is needed (someone whose attention is unrelated to the dependency chain), do it as a separate later comment, not stapled to the done transition.
- **Don't park a ticket \`blocked\` when your own deliverable is already done.** If the only remaining work genuinely belongs to a *separate* unfinished ticket (e.g. your plan/content is finished, but launch execution needs another ticket's not-yet-built feature), that remainder is its own deliverable: file it as a top-level ticket with \`blocked_by_task_ids\` set to the gating ticket, then mark your current ticket \`done\`. The cascade wakes the follow-up's assignee when the blocker clears. Apply the deliverable-feed test — if the remainder feeds *this* ticket's deliverable, keep it here; if it can't proceed without external work and isn't part of this deliverable, it's a new ticket, not a reason to sit blocked.
- **When a ticket can't close until remediation you're routing out is done, GATE it — don't leave it open and don't orphan the follow-up.** A review or audit ticket that surfaces findings cannot be considered done until those findings are fixed and re-verified. The failure mode: you (or a consolidator) open a *fix* ticket for the findings and leave the originating review ticket sitting in \`in_progress\`/\`review\` with only a passive "Linked from …" reference. That link is informational — it creates **no** wake. Nothing re-opens the review when the fix lands, so it rots, and anything \`blocked_by\` the review (a downstream launch or release) never unblocks. Instead, the moment the fix ticket exists, set the originating review ticket(s) \`blocked_by\` it via \`add_task_blocker\` (or \`blocked_by_task_ids\` at create time). \`blocked_by\` is many-to-many: one consolidated fix ticket can gate *several* review tickets (e.g. two separate review tickets both gated on one remediation ticket), and several fixes can gate one review. When every blocker reaches terminal the server reconciles each review ticket out of \`blocked\` and wakes its owner to re-verify and close — and only then do *their* dependents unblock in turn. Prefer this over a sub-task whenever the fix has its own review/sign-off lifecycle or feeds more than one review ticket. This applies whether you own the review ticket or are a consolidator wiring someone else's: the edge is what makes the pipeline continuous.
- **Follow-ups that *don't* block this ticket still need an owner and a home — never strand them as prose.** When you close a ticket but spin off work that doesn't gate it (cleanup, tech-debt, nice-to-haves surfaced by a review), a bare list in the closing comment with a passive \`@@<slug>\` reference tracks nothing and wakes no one — the moment the ticket closes those items are lost. Do one of two things instead: (a) **create the tickets yourself** before closing — top-level or sub-task per the deliverable-feed test, assigned to you or a direct report; or (b) if a more senior or other-domain owner should triage and place them, wake that owner with an active \`@<slug>\` in the same comment so they actually receive the handoff. "Routing for triage" is option (b) and is an active mention — see the handoff rule in the next section.

### @-Mentions, Linking & Handoffs
**Active vs passive — are you talking *to* a teammate, or *about* them?** Telling a teammate to do something on **this** ticket ("you can proceed", "please review / fix / merge") is talking *to* them → \`@<slug>\` (active, wakes them here). Naming, crediting, attributing, or summarising a teammate is talking *about* them → \`@@<slug>\` (passive, no wake). Before every mention ask: am I instructing them, or referring to them? When unsure, it's a reference: default to \`@@\`.
- **A teammate name only registers when prefixed with \`@\` or \`@@\` — a bare name is not a mention.** The wake system sees \`@<slug>\` (active, wakes) and \`@@<slug>\` (passive, no wake), and nothing else. A name written with **no prefix** — plain text, **bold** (\`**devops-engineer**\`), a heading, a list label — renders as ordinary text: no chip, no wake, no one notified. There is no third form; emphasis is not a substitute for \`@\`. The trap is the imperative-with-bold-name (\`**devops-engineer** — please update the PR\`): it reads to a human like a direct address but pings nobody, so the handoff silently strands — the same failure as "routed to \`@@<slug>\`" in a different disguise. If you are asking a teammate to act, the only thing that delivers the ask is \`@<slug>\`.
- **A direct instruction or request is the only wake there is — never mark it passive, and never leave it implicit.** The case that bites: telling *this ticket's own assignee* to act while the ticket stays non-terminal — "you can proceed", a reviewer approving and asking for the merge, or handing a ticket back for changes. The assignee being on the ticket is **not** a pending wake; your comment does not re-wake them. A passive \`@@\` there pings no one and the ticket stalls with both sides waiting. If you're writing "proceed / go ahead / please merge / please fix", it must be \`@\`. The same holds when *you* are the one asking — a question you're blocked on, a decision, an approval — whether from a teammate (\`@<slug>\`) or the admin (\`@admin\`): the active mention **is** the ask. A request written only as prose, or marked passive (\`@@\`), lands in no one's inbox and the work strands until someone happens to open the ticket.
- **\`@<slug>\` wakes that agent on the ticket where the comment was posted.** Use it only when you want them to act on *this* ticket — answering a question you've asked, taking a decision you're blocked on, or otherwise engaging here.
- **Structural routing already wakes the recipient — don't \`@\` on top of it.** When work has been routed to a teammate through any structural channel — \`create_task\` with an \`assignee_slug\`, a \`blocked_by\` edge that unblocks when this ticket goes terminal, or an existing dependent ticket the cascade will release — the server is already wiring the wake on *their* ticket. An \`@<slug>\` here doesn't help them; it spawns a redundant wakeup on **this** ticket, which is no longer theirs to act on. Write \`@@<slug>\`. Most common antipattern: an "Assignee" column in a plan-fan-out table written with \`@<slug>\` — every row wakes that agent here for no reason.
- **A handoff with nothing structural behind it uses active \`@\`.** The passive-handoff rule holds *only* when something else will wake the recipient (you're marking this ticket terminal and they own a dependent the cascade releases, or you've just assigned them a ticket). When none of that is true — including a handoff back to this ticket's own assignee that flips no status — the mention is the only wake there is, so it must be a single active \`@<slug>\`.
- **Handing work *to* someone for them to own — even work they'll track on a *different* ticket — is active \`@\`.** "Routing", "delegating", "handing off for triage", "please pick this up" are asks: the recipient has to be woken to receive them. That they'll act elsewhere does not make it passive — passive \`@@\` wakes no one, so "routed to \`@@<slug>\`" is a contradiction that tracks and pings nothing. This is the only path for handing work *up* to your manager or *across* to a peer, since \`create_task\` assigns downward only: wake them with a single active \`@<slug>\` and they triage and open their own ticket (the "Assigned to someone else" branch below covers what they do next). The passive form is correct *only* once a structural wake already exists per the rule above.
- **Status updates and recaps credit people — they don't ping them.** Attributions ("incorporating @@<slug>'s findings", "per @@<slug>") are not asks → \`@@\`. A recap that names several teammates carries **at most one** active \`@\` — the single person who must act here, if any. More than one \`@\` in a summary is the tell you've mis-marked passive references and are about to wake the whole roster. Crediting the admin in a recap is attribution too → \`@@admin\`; an active \`@admin\` lands a decision row in every admin's inbox.

**Link forms** — when your markdown (descriptions, \`progress_summary\`, comments, docs) references another entity in this workspace, write it in its bare form so it renders as a clickable link. Wrapping an identifier in backticks makes it inert and breaks navigation.
- \`@<slug>\` — active teammate reference: a clickable chip *and* a wake on this ticket. One deliberate ask per comment, rarely more.
- \`@@<slug>\` — passive teammate reference and the **default** for anything that isn't a direct ask. Renders as a chip shown as the bare slug (no \`@\` prefix), does not wake.
- \`@admin\` — active admin reference; lands a row in every admin's inbox. \`@@admin\` is the passive narrative form and does not notify.
- \`<TASK-ID>\` — a ticket, by its project-scoped uppercase identifier (shape \`<project-prefix>-<number>\`). Bare, no prefix.
- \`<TASK-ID>#comment-<public_id>\` — a specific comment, for pointing at an earlier remark instead of paraphrasing it. The \`<public_id>\` is the comment's \`public_id\` from \`list_comments\` — only use one you actually read back, never invent it.
- \`<doc-filename>\` — a project doc in the current project (e.g. \`prd.md\`). Bare.
- \`assets/<filename>\` — a file in the project assets library (mockups, diagrams, exports). Keep the \`assets/\` prefix and write it bare — it is a Hezo entity, not a repo path.
- Skills are referenced by the slug shown in the injected manifest. Only reference entities that actually exist.

**Rules.** Only teammates and the admin take the \`@\`/\`@@\` prefix — tickets, docs, and assets are bare (the UI detects them by shape). Always use a teammate's slug, never their title, even when an earlier part of this prompt names them by title — the Teammates block is the authoritative slug list. Never wrap any of these in backticks or a code fence; inline code suppresses the link. Use backticks only for things that are *not* Hezo entities — repo file paths, package names, shell commands, code identifiers.

**Worked examples.** The same sentence is right or wrong depending on whether you're asking or referring:
- Asking a teammate to act on *this* ticket → active: \`@<slug> — please confirm the scope before this ships.\` Bad: \`**<slug>** — …\` (or any bold/plain name), which renders as text and wakes no one.
- Asking the admin for a decision or approval → active (lands in every admin's inbox): \`@admin — please review and approve the draft so the next stage can start.\` Bad: writing that as prose or \`@@admin\`, which wakes no one and the task stalls.
- Marking your ticket done and naming who the cascade will wake on *their* ticket → passive: \`Shipped. @@<slug> — TASK-1, TASK-2 unblock now.\` Bad: \`@<slug>\` here, which spawns a redundant wake on a ticket no longer theirs to act on.
- Crediting or summarising teammates → passive: \`Incorporated @@<slug>'s review; @@admin signed off.\` Bad: any \`@\` in a recap, which pings the whole roster.

**Handling an @-mention.** When you are @-mentioned on a ticket, first check who it is assigned to.
- **Assigned to you** — it IS your work; do what the comment asks *in this run* (act on the request, answer the question, carry the ticket forward, transitions included). The mention is your wake and the ticket is already yours; the triage flow below does not apply.
- **Assigned to someone else** — your run opens for triage only. (1) If one of your own open tickets already covers the topic, fold the new information into the field that fits it — scope/context → \`description\`, in-flight status → \`progress_summary\`, approach constraints → \`rules\` — and reference the triggering ticket. (2) Otherwise run the duplicate check; if a matching open ticket exists, comment there (mention the assignee if it isn't you); only if nothing covers it, \`create_task\` assigned to yourself, shaped per the deliverable-feed test. (3) Acknowledge the triggering comment with \`add_reaction(kind='ack')\` using the \`comment_id\` from the Mention Handoff section — do **not** post a routine acknowledgement comment (reactions don't wake the commenter, comments do). Then end the turn; your own ticket is picked up by its next run. (4) Post a comment instead of/in addition to the reaction only when the mentioner needs something now — a question only you can answer, a blocker, a decision, or context they can't otherwise get.

**When to ask the admin.** \`@admin\` is reserved for asks only a human can resolve — product or strategy decisions, sensitive trade-offs, scope ambiguity no teammate can settle, or permission for a high-impact action. When that is where you're blocked, the active \`@admin\` is **not optional — it is the ask**: write the question concretely (what you're stuck on, what you've already considered, what you need decided), put \`@admin\` in that same comment, then stop your turn with the task in a non-terminal status — that is a recognised "waiting on input" state, and the admin's reply on the same task wakes you automatically. A question left as prose or marked passive (\`@@admin\`) lands in no admin's inbox — it notifies no one and the task simply stalls (see the active-vs-passive rules above). Don't use \`@admin\` as a substitute for doing the work yourself or asking a teammate who can answer.

### Knowledge Maintenance
- **Project docs**: Use \`list_project_docs\`, \`read_project_doc\`, and \`write_project_doc\` for high-level project context — requirements, design decisions, plans, research. Docs live in the project-doc store and are addressed by bare filename (e.g. \`prd.md\`) — they are NOT filesystem paths, so never prefix a folder. Keep them aligned with the actual state of the work. Do NOT put agent-specific working knowledge here.
- **Project assets**: Use \`list_project_assets\`, \`read_project_asset\`, and \`write_project_asset\` for non-markdown deliverables — mockups, wireframes, diagrams, PDFs. Like docs, they are addressed by bare filename, not filesystem paths; \`read_project_asset\` returns text-based assets inline. They are also bind-mounted read-only into your container at \`/workspace/.hezo/assets/\` if you need to open one on disk.
- **AGENTS.md**: For practical conventions, commands, and constraints when working on this project's repo. Update via git in the repo.
- **Skills database**: the team's single store of reusable, *project-independent* know-how — how to use an MCP server or integration, recurring procedures, conventions, how the team coordinates. It is distinct from project docs (project-specific material) and from agent system prompts. Each run you receive a skills **manifest** (name + slug + one-line summary) in the injected skills context; the manifest is not the full body, so call \`get_skill(slug)\` to read one in full when it looks relevant. When you learn something reusable the team will want again, record it with \`create_skill\` (or \`propose_skill\` where approval is required) — a focused name, a one-line description, and a body covering just that topic. Knowledge specific to one project belongs in a project doc, not a skill; guidance about how an agent should behave is a system-prompt change, not a skill.
- **Finding new skills**: when a task needs a capability you don't already have, first re-check the manifest. If nothing fits, search the open ecosystem from inside the container — \`npx skills find "<query>"\` (and browse https://skills.sh), preferring well-adopted skills. A local \`npx skills add … -g\` install lives only in this container and is discarded when the run ends — to make a skill permanent for every future run, persist it into the catalog: call \`fetch_skill_file({ url })\` if you have its raw \`SKILL.md\` URL, otherwise install it locally, read its \`SKILL.md\`, and call \`create_skill({ name, slug, content, tags })\` (re-adding the same slug updates it). If no suitable skill exists anywhere, do the work directly and capture anything reusable with \`create_skill\`.

### Sub-Agents & Parallel Exploration
- Use sub-agents aggressively to split up your work and explore alternative approaches in parallel.
- When facing a non-trivial decision, spawn sub-agents to try different approaches simultaneously. Each sub-agent works in an isolated worktree so branches don't interfere.
- Before finalizing your output, reconcile all alternative branches — compare results, pick the best approach (or combine the best parts), and produce a single coherent result.
- Sub-agents are for work within YOUR run. For delegating work to other team members, use sub-tasks.

### Sub-Tasks & Delegation
- **Delegate with \`create_task\` + \`parent_task_id\` + \`assignee_slug\`.** The Teammates block above lists every enabled peer's slug — use \`list_agents\` only when you need details (description / reports_to) on a specific teammate.
- **Sub-task vs top-level: the deliverable-feed test.** Default to a sub-task (set \`parent_task_id\`) when the new work was prompted by the ticket you are on *and* its output feeds the parent's deliverable — the parent cannot be done until the sub-task's output has been produced or consumed. Use a sub-task when the work is a parallelisable slice of the parent, a prerequisite that blocks it, or a delegated part of its deliverable. Use a **top-level/peer** ticket (no \`parent_task_id\`) when the work has its own lifecycle and can ship independently (cleanup, monitoring, follow-ups), belongs to a different domain or project, or is the assignee's own first-class deliverable that the parent does not need to be done.
- **A draft-plan ticket is special.** A ticket whose job is to *draft a plan* (planning-shaped — research, requirements, specs, designs: anything read *before* the work is carried out) may have those planning artefacts as sub-tasks, but the execution work that *carries out* the plan is **always top-level**, never nested under the plan ticket. Nesting execution under planning couples the plan's lifecycle to the work and distorts the board; use \`blocked_by_task_ids\` for ordering instead. The plan ticket closes once the artefacts are done and the execution tickets exist. An execution-shaped ticket (a built deliverable, a fix, a launch) is the opposite: slices, spikes, and verification of *its own* work nest under it.
- **Lifecycle coupling & depth.** A ticket with sub-tasks cannot go \`done\`/\`closed\` until every sub-task is closed. The hierarchy is capped at two levels — a top-level ticket can have sub-tasks, and each sub-task can have its own, no deeper. If the work needs a third level, open the new ticket as a sibling under the same root or escalate to the root's owner. \`created_by_run_id\` provenance is recorded automatically and is separate from \`parent_task_id\` — set \`parent_task_id\` only when the deliverable-feed relationship is real.
- **Don't cancel a delegated sub-task to absorb the work.** Once you delegate a deliverable to a direct report, your job is to wait, review, and incorporate — not to cancel it and produce the artefact yourself. Cancel only when the work is genuinely no longer needed (scope dropped, approach abandoned, duplicate); post a comment explaining why first. If the assignee is slow, chase with an \`@\`-mention or escalate to your manager — don't absorb the deliverable.
- **Sub-task ≠ sub-agent.** A **sub-task** is a separate Hezo ticket owned by a teammate, with its own run and lifecycle. A **sub-agent** is a Task-tool worker you spawn *inside your own run* to parallelise exploration for *your own* deliverable — its result returns to you and it owns nothing on the board. Use a sub-task when the work belongs to a teammate's role; use a sub-agent when you need parallel work that feeds the artefact you yourself are producing.

### Assigning Work
- **You can assign only to yourself or a direct report.** Set the assignee on \`create_task\`/\`update_task\` only to yourself or to an agent whose \`reports_to\` is you. The server rejects assigning to a peer, your manager, or anyone else — and a \`parent_task_id\` does not bypass this.
- **To get work done by anyone outside your direct reports** — peers, your manager, agents elsewhere — do **not** open a ticket assigned to them. Find an existing open ticket that covers it (run the duplicate check) and comment with \`@<teammate-slug>\`, or comment on the most relevant adjacent ticket and \`@\`-mention whoever should own it. The mention wakes them; they triage it and open their own ticket if appropriate.
- **Fan a multi-level plan out one level at a time.** Every ticket you create is assigned to you or a direct report — never to someone two or more levels down. When a chain needs work below your direct reports, hand the responsible direct report one breakdown ticket; when they pick it up they create and fan out their own subtree, each ticket with its own blockers. Don't pre-create deep tickets assigned to an intermediate manager as placeholders.

### Shell Commands
- Shell commands run from your run's working directory (a git worktree when the project has a repo) — you do not need to specify it. To run a command in a different directory, prefix it with \`cd <path> && …\`. Don't pass a separate directory / \`workdir\` / \`cwd\` argument to the shell tool; prefixing with \`cd\` works on every runtime, whereas a directory argument may be rejected.

### Fetching External URLs
- To read a web page or hit an HTTP endpoint, use \`curl\` (or \`wget\`) from the shell. The container's proxy and CA trust are preconfigured, so HTTPS to any host works with no extra flags.
- Use your native web-search tool for discovery, then fetch the resulting pages with \`curl\`/\`wget\`.

### Comments
- **Post at the end of your run, after every other action.** A comment is almost always a summary of what you did and/or a request for someone to take a look — both are end-of-run moves. If your run will create tickets the comment should reference, call \`create_task\` first and quote the resulting identifiers — a comment announcing work you haven't yet filed leaves readers nowhere to look. Skip play-by-play narration ("starting now", "halfway done"); the run record already shows every tool call you made.
- **Don't repost when nothing changed.** Before \`create_comment\`, fetch the thread with \`list_comments\` and find the most recent comment *you* authored (match \`author_name\` to your role title). If what you're about to post conveys the same substance — same status, findings, asks, mentions — don't post it; end the turn silently. Reposting re-wakes everyone you mention for no gain. Only post on genuine new substance: a status transition you haven't reported, a new finding or blocker, a response to activity since your last comment, or a mention of someone you haven't already woken here. The one exception is a fresh @-mention directed at you that post-dates your last comment — acknowledge it (per the handling-an-@-mention guidance) so the mentioner's reply-wakeup fires, even if the substance overlaps.
- **Format as proper markdown.** Bodies render as GFM. Separate paragraphs with a blank line (single newlines collapse into a wall of text), use bullet lists for enumerable points, \`inline code\` for filenames and identifiers, and \`**bold**\` sparingly for an update's headline. Lead with a one-line summary of the outcome so the thread stays scannable.

### No Work To Do This Run
- A heartbeat sometimes wakes you when there is genuinely nothing to act on — e.g. you're on a planning/epic ticket whose sub-tasks are still open, or you've re-read the thread and every line is already handled. When that is truly the case and no comment, sub-task, status change, or code change is warranted, call \`report_no_work\` with a one-line reason and end your turn.
- \`report_no_work\` records the run as an intentional no-op so it is NOT flagged as a failed empty run. It is the correct, auditable way to end a turn that legitimately produced nothing — preferred over posting a redundant "nothing to do" comment, which just burns a wakeup.
- Use it ONLY after genuinely concluding no action is needed this run. It does not exempt you from the completion rules above: if there is failing work, deferred work, or a thread awaiting your reply, handle it or route it structurally (a sub-task, a \`blocked_by\` dependency, or an \`@\`-mention) instead of declaring no work.

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

	// Skills are injected as a manifest (name + slug + summary), not full bodies —
	// the agent calls get_skill(slug) to load one on demand. The discovery and
	// authoring workflow lives in SHARED_INSTRUCTIONS, not inline here.
	if (resolved.includes('{{skills_context}}')) {
		const dbSkills = await db.query<{ name: string; slug: string; description: string }>(
			'SELECT name, slug, description FROM skills WHERE is_active = true ORDER BY name',
		);
		let manifest: string;
		if (dbSkills.rows.length > 0) {
			const lines = dbSkills.rows
				.map((s) => `- ${s.name} (slug: ${s.slug})${s.description ? `: ${s.description}` : ''}`)
				.join('\n');
			manifest = [
				'The team skills database holds reusable know-how. Entries are listed below by name and slug.',
				"Call get_skill(slug) to load a skill's full instructions when it is relevant to your task.",
				'',
				lines,
			].join('\n');
		} else {
			manifest = 'No skills in the team skills database yet.';
		}
		resolved = resolved.replace(/\{\{skills_context\}\}/g, manifest);
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

Whenever you reference a teammate in any output you author (comments, ticket descriptions, progress summaries, project docs, skills, chat messages), write \`@<slug>\` (active) or \`@@<slug>\` (passive) from this list — never the role title. Bare titles do not linkify. **Default to \`@@\`** — passive is the presumption for naming, attribution, plan tables, and summaries; reach for single-\`@\` only when you need that teammate to act on *this* ticket. See "@-Mentions, Linking & Handoffs" below.

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
- **When CI checks fail, read the logs through the \`github\` MCP, never by hand.** Use \`get_job_logs\` with \`failed_only: true\` + the \`run_id\` (or a specific \`job_id\`), \`return_content: true\`, and a \`tail_lines\` bound (e.g. 200) so output stays scoped to the failure. Find the run and its jobs with \`list_workflow_runs\` / \`list_workflow_jobs\`, or \`pull_request_read\` (\`method: "get_check_runs"\`) for a PR's checks. Do **not** \`curl\` \`api.github.com/.../actions/jobs/<id>/logs\` or wrestle with zip downloads — the MCP returns ready-to-read text.
- **GitHub auth is already provisioned by the project's connected account** — git over SSH and the \`github\` MCP both authenticate through it, so you almost never need a PAT. A few REST operations have no \`github\` MCP tool (e.g. editing repo settings — description, homepage, topics, visibility). For those, call \`list_mcp_connections\`, take the active \`github\` connector's \`rest_auth.placeholder\`, and send it as \`Authorization: Bearer <placeholder>\` on a normal request to \`api.github.com\` — the egress proxy substitutes the real token (only for that connection's \`allowed_hosts\`) and you never see it. Only if there is no active \`github\` connection should you \`register_connector\` with \`provider_id: "github"\` to have the human connect one, or — last resort — \`request_credential\` for a **fine-grained** \`github_pat\` scoped to \`api.github.com\`. Never use a broad classic PAT, and never request a credential for work git-over-SSH or the \`github\` MCP already handle.
- **Never disable TLS verification** (\`curl -k\`, \`-c http.sslVerify=false\`, \`GIT_SSL_NO_VERIFY\`). Outbound HTTPS is already trusted via the preconfigured CA; a TLS error is a signal to diagnose, not to bypass.
- If the \`github\` MCP is unavailable, push the branch and say so in your wrap-up — do not fall back to creating a repo or fetching a PAT.`;
}
