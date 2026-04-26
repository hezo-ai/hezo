## Sub-issues vs top-level tickets

Default to a sub-issue when the new work was prompted by the ticket you are on. Pick top-level only when one of the conditions below applies. The test for a sub-issue is whether its deliverable **feeds into the parent ticket's deliverable** — the parent cannot be considered done until the sub-issue's output has been produced or consumed.

Use a sub-issue (set `parent_issue_id` to the current ticket on `create_issue`) when:

- The work is a parallelisable slice of the parent's own deliverable.
- The work is a prerequisite that blocks the parent (e.g. PRD gating spec, spec gating implementation).
- The work is a sub-task you want to track separately, but its output rolls back into the parent.
- You are delegating part of the parent's deliverable to another agent — delegation alone does not force top-level; apply the deliverable-feed test like any other case.

Use a top-level (or peer) ticket — do **not** set `parent_issue_id` — when:

- The work has its own lifecycle and can ship independently of the parent (cleanup, monitoring, follow-up improvements).
- The work belongs in a different domain or project from the parent.
- The new ticket is the assignee's first-class deliverable in their own right and the parent does not need its output to be done.

## What counts as the parent's deliverable

The deliverable-feed test depends on what the parent ticket is for:

- **Planning ticket parent** — the parent is a `planning` / `goal-update` ticket, or any ticket whose deliverable is itself a *plan* (research, PRD, spec, design, anything other tickets will execute against). Sub-issues: the artefacts the plan itself depends on (research.md, prd.md, spec.md, design mockups). Top-level: the implementation / build / launch / post-impl review tickets that execute the finished plan. The planning ticket is complete once the plan exists and the work tickets have been created — it does not stay open while the build ships.
- **Implementation / feature / bug-fix parent** — the parent's deliverable is the built thing itself (a feature, a fix, a deployed service). Sub-tasks of any kind — a small design spike, a sub-implementation slice, a test ticket — are sub-issues of the parent if they are part of completing it. Planning steps inside an implementation ticket count as part of the work; they are sub-issues, not top-level peers.

The same shape recurs at each level. An Architect's spec ticket is planning-shaped: it can have research sub-issues and spawns the Engineer's implementation tickets as top-level peers. An Engineer's implementation ticket is feature-shaped: it can have sub-implementation sub-issues, design spike sub-issues, and test sub-issues — all nested under it.

## Lifecycle coupling

A ticket with sub-issues cannot be moved to `done` or `closed` until every sub-issue is `closed` (Coach-reviewed). Weigh that lifecycle coupling when choosing — it is a real consequence of the hierarchy, not a reason to avoid sub-issues, but it does mean a parent stays open while children finish.

The hierarchy is capped at two levels deep. A top-level ticket can have sub-issues, and each sub-issue can have its own sub-issues, but no further. The server rejects creates beyond depth 2. If a sub-issue would need a third level to model the work cleanly, restructure: open the new ticket as a sibling under the same root, or escalate to whoever owns the root and let them re-shape the hierarchy.

The `mention-handoff` guidance covers the @-mention triage decision; this guidance covers proactive work you generate yourself. Either path goes through the duplicate check in `check-before-create` first.

The system records `created_by_run_id` automatically as provenance — that linkage is separate from `parent_issue_id`. Set `parent_issue_id` only when the deliverable-feed relationship is real; provenance is recorded on its own and is not a reason to nest.
