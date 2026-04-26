## Sub-issues vs top-level tickets

A sub-issue is for work whose deliverable **feeds into the parent ticket's deliverable** — the parent cannot be considered done until the sub-issue's output has been produced or consumed. That is the test. If the new ticket can ship independently of the parent, it is not a sub-issue.

Use a sub-issue (set `parent_issue_id` to the current ticket on `create_issue`) when:

- The work is a parallelisable slice of the parent's own deliverable.
- The work is a prerequisite that blocks the parent (e.g. PRD gating spec, spec gating implementation).
- The work is a sub-task you want to track separately, but its output rolls back into the parent.

Use a top-level (or peer) ticket — do **not** set `parent_issue_id` — when:

- You are delegating to another agent and the new ticket is their own first-class deliverable, not a contribution to your current ticket. A CEO drafting a plan and opening tickets for direct reports is the canonical case: each delegated ticket is the report's work, even though it was spawned from a planning ticket.
- The work has its own lifecycle and can ship independently of the parent (cleanup, monitoring, follow-up improvements).
- The work belongs in a different domain or project from the parent.
- The parent ticket is labeled `planning` or `goal-update`. Tickets spawned from planning/goal-update tickets are **always** top-level, never sub-issues — even if the deliverable feels like a slice of the plan.

A ticket with sub-issues cannot be moved to `done` or `closed` until every sub-issue is `closed` (Coach-reviewed). Choosing a sub-issue therefore commits the parent to staying open until each child finishes its full lifecycle, including the Coach's post-mortem. Pick a top-level ticket when that coupling does not match the work.

The hierarchy is capped at two levels deep. A top-level ticket can have sub-issues, and each sub-issue can have its own sub-issues, but no further. The server rejects creates beyond depth 2. If a sub-issue would need a third level to model the work cleanly, restructure: open the new ticket as a sibling under the same root, or escalate to whoever owns the root and let them re-shape the hierarchy.

The `mention-handoff` guidance covers the @-mention triage decision; this guidance covers proactive work you generate yourself.

The system records `created_by_run_id` automatically as provenance — that linkage is separate from `parent_issue_id`. Set `parent_issue_id` only when the deliverable-feed relationship is real; provenance is recorded on its own and is not a reason to nest.
