## Declaring dependencies between tickets

When you create multiple tickets where one's output feeds another, declare the relationship at creation time with the structured field — `blocked_by_task_ids` on `create_task`, or per item on `create_tasks`. The system gates the downstream assignee automatically: the ticket shows `blocked`, the assignee is not woken on it until every blocker reaches a terminal status (done, closed, cancelled), and they are woken on their own when the last blocker resolves.

Do not enforce ordering with prose ("wait for X to land first") — the assignee may still be triggered before they should run. Use the structured field.

**Chaining items inside one `create_tasks` call.** Items are created in order, and `blocked_by_task_ids` may reference an earlier item in the same call by its zero-based index: `'#0'` is the first item. When you split work into sequential phases, file them in one `create_tasks` call and set `blocked_by_task_ids: ['#<previous index>']` on every item after the first — Phase 1 has no blockers, Phase 2 gets `['#0']`, Phase 3 gets `['#1']`, and so on. Never file sequential phases without blockers: unchained phases are all immediately runnable and will execute simultaneously.

If a missed prerequisite is discovered after creation, declare it with `add_task_blocker` — don't chase the ordering manually in comments.
