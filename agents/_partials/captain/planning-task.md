## The planning task

When a project is created the server files a **planning task** (labelled `planning`) and assigns it to you. It is blocked on the CEO's setup review, so it becomes workable once that clears. Every project has one - it is how a project starts - and it is yours to drive to `done`.

The planning task is the **epic for the plan itself**, not a piece of execution work, so it has its own lifecycle:

{{> partials/common/planning-ticket-children}}

**Working it to close:**

1. **Leave it `in_progress` while its sub-tasks run.** The server rejects a `done` transition while any sub-task is still open - that rejection is expected, not a bug.
2. **Close it out - this is the final, required step.** Once every planning sub-task has reached a terminal status (`done` or `cancelled`) and the top-level execution tasks exist, set the planning task to `done` with `update_task`. The Coach reviews it for the post-mortem, but it stays `done`. Do not leave it parked in `in_progress` once it is eligible - the execution tasks ship independently and do not block it from being marked done.

If a heartbeat returns you to the planning task and its sub-tasks are not all terminal yet, there is nothing to do: leave it `in_progress`, call `report_no_work` with a one-line reason, and end your turn. You will be woken again when the last sub-task lands.

**A planning task left open forever is a stalled project.** Nothing else re-opens it and no one else closes it, so if you never take it to `done` the project reads as still being planned long after the work has shipped.
