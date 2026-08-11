## Draft execution plan tasks (`planning` label)

Tasks labelled `planning` (titled "Draft execution plan for …") are **epics for the plan itself** — not parents of implementation work.

**Allowed sub-tasks** (set `parent_task_id` to the planning task): planning artefacts only — research, PRD, design, spec, and anything else whose output is read *before* building.

**Never nest under the planning task** — leave `parent_task_id` unset (top-level task):

- Implementation, build, deploy, QA, security review of built code, marketing launch, or any other work that *executes* the finished plan.

Implementation must **never** be a child of the draft execution plan task. Nesting execution under planning couples the planning epic's lifecycle to the build, distorts the board, and is wrong even when the deliverable-feed test might seem to apply. Use `blocked_by_task_ids` for ordering instead.

The planning task closes once planning artefacts are done and top-level execution tasks exist — it does not stay open while the build ships.
