## Declaring dependencies between tickets

When you create multiple tickets where one's output feeds another, declare the relationship at creation time with the structured field — `blocked_by_task_ids` on `create_task`, or per item on `create_tasks`. The system gates the downstream assignee automatically: the ticket shows `blocked`, the assignee is not woken on it until every blocker reaches a terminal status (done, closed, cancelled), and they are woken on their own when the last blocker resolves.

Do not enforce ordering with prose ("wait for X to land first") — the assignee may still be triggered before they should run. Use the structured field.

**Chaining items inside one `create_tasks` call.** Items are created in order, and `blocked_by_task_ids` may reference an earlier item in the same call by its zero-based index: `'#0'` is the first item. When you split work into sequential phases, file them in one `create_tasks` call and set `blocked_by_task_ids: ['#<previous index>']` on every item after the first — Phase 1 has no blockers, Phase 2 gets `['#0']`, Phase 3 gets `['#1']`, and so on. Never file sequential phases without blockers: unchained phases are all immediately runnable and will execute simultaneously.

**Gate upstream too — not only downstream.** An execution ticket (implementation, build, deploy, QA, security review, launch) must be created `blocked_by` **every** ticket whose output it consumes. Gating the tickets *below* it — declaring that QA and security review are `blocked_by` the implementation ticket — is not enough; that leaves the implementation ticket itself with no open blocker, so it is immediately runnable and its assignee starts before the plan, spec, and design have landed. In particular, an implementation ticket must be `blocked_by` the spec ticket (and any design ticket that is not a sub-task of that spec). Wire both directions: each ticket gated on the work it depends on, and the work that depends on it gated on this ticket.

If a missed prerequisite is discovered after creation, declare it with `add_task_blocker` — don't chase the ordering manually in comments.

## When your own ticket gets blocked mid-run

If you discover partway through a run that your current ticket cannot finish until another in-flight ticket lands, call `add_task_blocker(task_id=<current ticket>, blocked_by_task_id=<the gating ticket>)` and end your turn. The current ticket flips to `blocked` and the system re-wakes you automatically the moment the gating ticket reaches a terminal status (done, closed, cancelled).

**Never** stop with only a prose "waiting on X" note — in a comment, a progress summary, or your final message — while leaving the ticket `in_progress`. A passive textual reference (even a bare task identifier) records at most a display link; it creates no dependency edge, so nothing re-engages your ticket when the other one closes and the work strands silently. A short comment summarising what you're waiting on is fine **in addition to** the `add_task_blocker` edge, never instead of it.
