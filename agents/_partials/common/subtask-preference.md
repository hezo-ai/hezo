## Sub-issues for related work

Default to sub-issues — not new top-level tickets — for work that surfaces while you are on a ticket and clearly belongs underneath it: cleanup spotted along the way, follow-ups that depend on the current change, parallelisable slices you want to delegate, or sub-tasks you want to track separately. Set `parent_issue_id` to the ticket you are currently working when you call `create_issue`. Top-level tickets are reserved for work that stands on its own.

The hierarchy is capped at two levels deep. A top-level ticket can have sub-issues, and each sub-issue can have its own sub-issues, but no further. The server rejects creates beyond depth 2. If a sub-issue would need a third level to model the work cleanly, restructure: open the new ticket as a sibling under the same root (set `parent_issue_id` to the root, not to the intermediate sub-issue), or escalate to whoever owns the root and let them re-shape the hierarchy.

When the new work is genuinely independent — a different domain, a different project, a lifecycle that does not depend on the current ticket — open a top-level or peer ticket instead. The `mention-handoff` guidance covers the @-mention triage decision; this guidance covers proactive work you generate yourself.

The system records `created_by_run_id` automatically as provenance. `parent_issue_id` is the *semantic* parent and should be set deliberately when the relationship is real.
