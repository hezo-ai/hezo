---
title: MCP API reference
order: 27
section: Reference
---

<!-- GENERATED FILE — do not edit by hand. Source: packages/server/src/mcp/mcp-reference.ts
     (generator + per-tool metadata) and the live MCP tool registry. Regenerate with
     `bun run build:docs`; mcp-reference.test.ts fails if this file is stale. -->

# MCP API reference

Complete reference for every tool exposed by Hezo's built-in MCP server. For how to
connect, authenticate, and register for access, see
[Hezo's MCP server](/docs/mcp/hezo-mcp-server).

## Connecting

- **Endpoint:** `POST /mcp` — JSON-RPC 2.0 over Streamable HTTP.
- **Authentication:** `Authorization: Bearer <token>`, where the token is an
  instance-scoped API key (`hezo_…`).
- **Discovery:** call `tools/list` for the live machine-readable schemas, then invoke a
  tool with `tools/call`.
- **File uploads:** binary files cannot ride a JSON-RPC call — `POST` them to
  `/mcp/assets` as `multipart/form-data` (a `file` field, plus an optional `project`
  field). They then appear in `list_project_assets` / `read_project_asset`.

## Conventions

- **Project scope (`project`):** most tools take an optional `project` (slug or ID).
  Omit it to act in the project your run is already in; an API key and instance agents
  (CEO/Coach) must name the project they are acting in.
- **Authorization:** every call is scoped to the resolved project's team and the caller
  must have access to it. Tools that restrict callers further note it under
  **Authorization** below.
- **Errors:** a handled failure comes back as `{ "error": "<message>" }` in the tool
  result (the HTTP response itself stays successful).
- **Result size:** a tool result is capped at 64 KB; over that you get
  `{ "error": "result_too_large", … }`. Narrow it with filters, a single-resource
  `get_*`, `before` pagination, or `excerpt_chars`.
- **Excerpts (`excerpt_chars`):** list tools accept `excerpt_chars` to truncate long
  text fields, adding `_truncated`/`_length` companions.
- **Pagination (`before`):** `list_comments` walks older items by passing the oldest
  `id` you have seen as `before`.
- **Secrets:** agents reference secrets by placeholder (`__HEZO_SECRET_<NAME>__`); the
  egress proxy substitutes the real value only for the secret's `allowed_hosts`.
- **Write tools:** tools marked _Write tool_ persist data — a successful call from an
  agent run marks the run as having produced output.

## Teams

### `list_teams`

_Read-only._

List teams accessible to the caller. An API key and the instance CEO (cross-team session) get every team in the instance; an ordinary agent run gets only its own team.

**Parameters:** none.

**Returns:** An array of team rows (`id`, `name`, `slug`, `description`, …). An API key, the instance CEO, and an agent run with cross-team scope get every team; an ordinary agent run gets only its own team; a board user gets the teams they belong to (all teams for a superuser).

### `get_team`

_Read-only._

Get the team backing a project

**Parameters:**

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `project` | `string` | No | Project slug or ID. Omit to use the project your run is already in; instance agents (CEO/Coach) must name the project to act in. |

**Returns:** The single team row backing the resolved project, or `null` if none.

### `create_team`

_Write tool._

Create a new team (superuser only)

**Parameters:**

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `name` | `string` | Yes | Team name |
| `description` | `string` | No | Team description |

**Returns:** The created team row.

**Authorization:** Superuser only.

## Projects

### `create_project`

_Write tool._

Create a new project together with its dedicated team. CEO-only. Call this ONLY after the admin has explicitly approved the finalised scope AND team type in the intake conversation — a plain reply approving it is enough (there is no inbox button to wait on), but do not call it while still scoping, on assumed defaults, or in the same turn you propose the plan; creating a project stands up a full team + container, so wait for the go-ahead. Provisions the team from the chosen team-type template (pass template_id from list_team_templates, or source_team_id to clone an existing team; defaults to Blank), creates the project, its planning ticket, and the initial CEO coherence/setup ticket the planning ticket is blocked on, then provisions the container. The coherence/setup ticket is created unassigned and does NOT start automatically on this path: first author its description (update_task on the returned coherence_task_identifier) to capture the concrete setup you agreed in intake — the exact roles to hire, any system-prompt rewrites, and the reporting structure — then call start_team_setup(project) to begin the run. When intake_task_id is given, the intake conversation is closed with a completion note. Returns the new project plus its planning and coherence ticket identifiers.

**Parameters:**

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `name` | `string` | Yes | Project name |
| `description` | `string` | Yes | Project description |
| `task_prefix` | `string` | No | Optional 2-4 char uppercase ticket prefix; derived from the name when omitted |
| `initial_project_plan` | `string` | No | Optional project plan document (markdown), seeded as project-plan.md |
| `template_id` | `string` | No | Team-type template id (from list_team_templates). Mutually exclusive with source_team_id; defaults to Blank when neither is given. |
| `source_team_id` | `string` | No | Existing team to clone into a fresh template. Mutually exclusive with template_id. |
| `intake_task_id` | `string` | No | The HQ project-intake ticket this fulfils; it is closed with a completion note on success. |

**Returns:** The new project row plus `team_slug`, `planning_task_id`, `planning_task_identifier`, and the initial coherence/setup ticket (`coherence_task_id`, `coherence_task_identifier`). The coherence ticket is created unassigned and does NOT auto-run on this path — draft its description then call `start_team_setup`. Returns `{ error }` if validation fails.

**Authorization:** CEO only — call after the admin has explicitly approved the scope and team type in intake.

### `start_team_setup`

_Write tool._

Kick off the initial team-coherence/setup run for a project you created via create_project. CEO-only. Projects created directly from the admin form start their coherence pass automatically; projects you create do NOT. First author the coherence ticket with update_task — replace its description with the concrete plan you agreed in intake (the exact roles to hire and why, any system-prompt rewrites, and the reporting structure) — then call this to assign the ticket to yourself and start the run. Returns the started ticket; errors if there is no open setup ticket for the project or a run is already active on it.

**Parameters:**

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `project` | `string` | No | Project slug or ID. Omit to use the project your run is already in; instance agents (CEO/Coach) must name the project to act in. |

**Returns:** `{ started: true, task_id, task_identifier }` after assigning the project’s open coherence/setup ticket to the CEO and waking them to run it. Returns `{ error }` if there is no open setup ticket for the project or a run is already active on it.

**Authorization:** CEO only — for a project the CEO created via `create_project`; author the coherence ticket description first.

### `list_team_templates`

_Read-only._

List team templates (built-in Startup for software development, Blank, and custom). Use when recommending a team structure to hire.

**Parameters:** none.

**Returns:** An array of templates (`id`, `name`, `description`, `is_builtin`, `agent_types[]` where each entry has `slug`, `name`, `role_description`).

### `list_projects`

_Read-only._

List projects. With CEO cross-team access (or as superuser) returns every project across the instance; a board user gets the projects on teams they belong to; an agent run gets its own project. Pass excerpt_chars (e.g. 300) to truncate description; omit for full content.

**Parameters:**

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `excerpt_chars` | `integer` | No | When set, truncates description and adds description_truncated/_length |

**Returns:** An array of project rows (`id`, `team_id`, `name`, `slug`, `task_prefix`, `description`, `is_internal`, `created_at`, `updated_at`). With `excerpt_chars`, `description` is truncated and `description_truncated`/`description_length` companions are added.

**Authorization:** An API key, CEO cross-team access, or a superuser returns every project; a board user gets the projects on their teams; an agent run gets its own project.

## Tasks

### `list_tasks`

_Read-only._

List a project's tasks. Returns up to 50 tasks ordered by creation date (newest first). Omit `project` to use the project your run is in; pass it (slug or ID) to inspect another project. Narrow with status (comma-separated) or assignee_id/assignee_slug. The Project State block in your system prompt already gives you the active tickets in the current project — only call this if you need older or terminal tickets, another project, or a specific status filter. Pass excerpt_chars (e.g. 300) to truncate description and rules to triage-sized excerpts; omit for full content.

**Parameters:**

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `project` | `string` | No | Project slug or ID. Omit to use the project your run is already in; instance agents (CEO/Coach) must name the project to act in. |
| `status` | `string` | No | Filter by status (comma-separated) |
| `assignee_id` | `string` | No | Filter by assignee member ID |
| `assignee_slug` | `string` | No | Filter by assignee agent slug (alternative to assignee_id) |
| `excerpt_chars` | `integer` | No | When set, replaces description and rules with first-paragraph excerpts capped at this many characters, plus _truncated and _length companion fields |

**Returns:** Up to 50 task rows ordered newest-first, each including `project_name`. With `excerpt_chars`, `description` and `rules` are replaced with excerpts plus `_truncated`/`_length` companions.

### `get_task`

_Read-only._

Get task details, including the ticket's declared blockers (upstream — what this ticket is waiting on) and dependents (downstream — tickets that are blocked on this one). Each entry has identifier, title, and current status. A non-empty blockers list means an automatic agent run on this ticket is paused until every blocker reaches a terminal status (done, closed, cancelled). The dependents list shows which teammates' tickets will be auto-unblocked when this ticket is marked terminal — you do not need to @-mention them, the auto-wake handles it.

**Parameters:**

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `project` | `string` | No | Project slug or ID. Omit to use the project your run is already in; instance agents (CEO/Coach) must name the project to act in. |
| `task_id` | `string` | Yes | Task identifier or UUID |

**Returns:** The task row plus `blockers[]` (upstream) and `dependents[]` (downstream); each entry has `dependency_id`, `id`, `identifier`, `title`, `status`. Returns `null` if the task is not found.

### `create_task`

_Write tool._

Create a new task. Use parent_task_id for sub-tasks — prefer this over a top-level ticket whenever the new work is part of the ticket you are on. Sub-tasks themselves can have sub-tasks, but no deeper (depth is capped at 2). Use assignee_slug as alternative to assignee_id. As an agent caller, you may only assign to yourself or to your direct subordinates — to request work from anyone else (peers, your manager, or agents elsewhere in the org), use create_comment with @<agent-slug> on a relevant ticket instead. Use blocked_by_task_ids to declare prerequisites — the assignee will not be woken on this ticket until every blocker reaches a terminal status (done, closed, cancelled). When splitting work into sequential phases, prefer create_tasks and chain the items with '#<index>' blockers instead of filing them unordered. In title/description, reference teammates with @<agent-slug>. Reference tickets and project docs by their bare identifier/filename (e.g. IN-42, spec.md), and skills by their slug — no @ prefix. Do not wrap any of these in backticks — that makes them inert.

**Parameters:**

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `project` | `string` | No | Project slug or ID. Omit to use the project your run is already in; instance agents (CEO/Coach) must name the project to act in. |
| `title` | `string` | Yes | Task title |
| `description` | `string` | No | Task description |
| `priority` | `string` | No | Priority: low, medium, high, urgent |
| `assignee_id` | `string` | No | Assignee member ID |
| `assignee_slug` | `string` | No | Assignee agent slug (alternative to assignee_id) |
| `parent_task_id` | `string` | No | Parent task to nest this under as a sub-task — a task identifier (e.g. "BE-2") or UUID. Sub-tasks can themselves have sub-tasks, but no deeper — depth is capped at 2. |
| `runtime_type` | `string` | No | Pin this task to a specific AI runtime (claude_code, codex, gemini). Leave unset to use the instance default. |
| `blocked_by_task_ids` | `string[]` | No | Task identifiers (e.g. ["BE-2", "BE-3"]) or UUIDs that must reach a terminal status before this ticket is started. The assignee will not be woken on this ticket until every blocker is satisfied. |

**Returns:** The created task row (it may carry an advisory `warning` string when the description backticked a real entity). Returns `{ error }` on a validation failure.

**Authorization:** An agent caller may only assign to itself or a direct subordinate; sub-task depth is capped at 2.

### `create_tasks`

_Write tool._

Create multiple tasks in one call (max 50). Items are created in order; each has the same shape as create_task, and per-item errors are returned without aborting the rest. Within a batch, blocked_by_task_ids entries may reference an earlier item in the same call by zero-based index token — '#0' is the first item. To chain sequential work (e.g. implementation phases that must run one at a time), set blocked_by_task_ids: ['#<previous index>'] on every item after the first; each task then stays blocked until the one before it reaches a terminal status. Filing sequential phases WITHOUT these blockers makes all of them runnable at once. Index tokens may only point at earlier items; a token that is self-referencing, forward-referencing, or points at an item that failed errors that item. Use this when filing a related set of tickets in one go (planning a feature, splitting a ticket into phases or sub-tasks). For a single task, use create_task.

**Parameters:**

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `project` | `string` | No | Project slug or ID. Omit to use the project your run is already in; instance agents (CEO/Coach) must name the project to act in. |
| `items` | `object[]` | Yes | Up to 50 items. |

**Returns:** An array of per-item results: `{ ok: true, index, task }` or `{ ok: false, index, error }`. Items are created in order; a per-item failure does not abort the rest. `blocked_by_task_ids` may reference an earlier item with a `#<index>` token.

**Authorization:** Same as `create_task`; up to 50 items per call.

### `update_task`

_Write tool._

Update an task. Agents can use this to change status, update progress, set rules, and record branch names. To finish a ticket, set status to `done` — that wakes Coach for review, who will set the ticket to `closed` after the review passes. Agents other than Coach cannot set status to `closed` directly. Re-opening a closed task is admin-only. As an agent caller, reassigning is limited to yourself or your direct subordinates; to hand work to a peer or manager use create_comment with @<agent-slug> instead. In description, progress_summary, and rules, reference teammates with @<agent-slug>. Reference tickets and project docs by their bare identifier/filename (e.g. IN-42, spec.md), and skills by their slug — no @ prefix. Do not wrap any of these in backticks — that makes them inert.

**Parameters:**

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `project` | `string` | No | Project slug or ID. Omit to use the project your run is already in; instance agents (CEO/Coach) must name the project to act in. |
| `task_id` | `string` | Yes | Task identifier or UUID |
| `title` | `string` | No | New title |
| `description` | `string` | No | New description |
| `status` | `string` | No | New status (backlog, in_progress, review, blocked, done, cancelled). To finish a ticket, set `done` — Coach will review and set it to `closed`. Setting `closed` directly is reserved for Coach. Once a task is `closed`, only the admin can change its status again. |
| `priority` | `string` | No | New priority |
| `assignee_id` | `string` | No | New assignee ID |
| `progress_summary` | `string` | No | Progress summary update |
| `rules` | `string` | No | How-to-work-on guardrails for this ticket — approach constraints that shape execution (e.g. "run tests before committing", "consult the architect before auth changes"). Not a channel for passing project domain knowledge to other agents; put that in description instead. |
| `branch_name` | `string` | No | Git branch name for this task |
| `runtime_type` | `string` | No | Override the AI runtime for this task (claude_code, codex, gemini). Pass an empty string to clear. |

**Returns:** The updated task row (may carry a `warning` string), `{ unchanged: true }` when no fields changed, `null` if not found, or `{ error }` on a validation failure.

**Authorization:** A non-Coach agent cannot set `closed` (set `done`; Coach closes after review); only the admin can re-open a closed task. An agent run is scoped to its own task and may reassign only to itself or a direct subordinate.

### `add_task_blocker`

_Write tool._

Declare that one task blocks another. The downstream ticket will not start an automatic agent run until the blocker reaches a terminal status (done, closed, cancelled). Use this when you discover that a ticket you have been woken on depends on work that has not landed yet — declare the blocker and end your turn; the system will wake you again when the blocker resolves. Cycles are rejected.

**Parameters:**

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `project` | `string` | No | Project slug or ID. Omit to use the project your run is already in; instance agents (CEO/Coach) must name the project to act in. |
| `task_id` | `string` | Yes | Task identifier or UUID that should be blocked |
| `blocked_by_task_id` | `string` | Yes | Task identifier or UUID of the upstream blocker |

**Returns:** The dependency row (`id`, `task_id`, `blocked_by_task_id`, `created_at`). Returns `{ error }` for a self-block, an existing dependency, a missing task, or a cycle.

### `remove_task_blocker`

_Write tool._

Remove a blocker between two tasks. Call this when a dependency that was previously declared no longer applies. If removing this dependency clears the downstream ticket's last open blocker, its assignee is woken automatically.

**Parameters:**

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `project` | `string` | No | Project slug or ID. Omit to use the project your run is already in; instance agents (CEO/Coach) must name the project to act in. |
| `task_id` | `string` | Yes | Task identifier or UUID that is currently blocked |
| `blocked_by_task_id` | `string` | Yes | Task identifier or UUID of the blocker to remove |

**Returns:** `{ removed: true }`, or `{ error }` if the dependency or blocker is not found. Clearing the last open blocker wakes the downstream assignee.

## Comments & reactions

### `list_comments`

_Read-only._

List comments for an task. Returns up to 50 most-recent comments (newest first). Pass before (a comment ID) to walk older. Pass excerpt_chars (e.g. 500) to truncate long text comments; structured comments (system/option/task_link) are always returned whole. Each row includes parent_comment_id (UUID or null) so you can see reply threading — when you reply substantively to a comment, pass that comment's id back as parent_comment_id in create_comment. Each row also has a public_id (a creation-timestamp slug like 20261009112345); that's how you cite a specific comment elsewhere: write a comment link as <TASK-ID>#comment-<public_id> (e.g. IN-42#comment-20261009112345), which renders as a clickable link straight to that comment.

**Parameters:**

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `project` | `string` | No | Project slug or ID. Omit to use the project your run is already in; instance agents (CEO/Coach) must name the project to act in. |
| `task_id` | `string` | Yes | Task identifier or UUID |
| `before` | `string` | No | Comment ID — return only comments created before this one |
| `excerpt_chars` | `integer` | No | When set, truncates content.text on text-typed comments to this many characters and adds text_truncated/text_length |

**Returns:** Up to 50 comment rows newest-first, each with `id`, `public_id`, `task_id`, `author_member_id`, `author_api_key_id`, `parent_comment_id`, `content_type`, `content`, `chosen_option`, `created_at`, `author_type`, `author_name`, `reactions[]`, and `attachments[]`. Pass `before` to walk older; `excerpt_chars` truncates text comments (adds `text_truncated`/`text_length`).

### `add_reaction`

_Write tool._

React to a comment without waking its author. Use this to acknowledge mentions or signal "seen / picked up" without forcing the original commenter to run again. Prefer this over a follow-up create_comment when you have nothing substantive to add — comments wake the author, reactions do not. Only react when the situation calls for it: a clean handoff to your own new ticket (✓ on the mention), or a brief acknowledgement that a request landed. If you need the original commenter to read something, post a comment instead.

**Parameters:**

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `project` | `string` | No | Project slug or ID. Omit to use the project your run is already in; instance agents (CEO/Coach) must name the project to act in. |
| `task_id` | `string` | Yes | Task identifier or UUID the comment belongs to |
| `comment_id` | `string (uuid)` | Yes | UUID of the comment to react to, as returned by list_comments. Sentinels like "last" / "latest" are not supported — you must pass an explicit UUID. |
| `kind` | `ack` | Yes | Reaction kind. v1 supports: ack |

**Returns:** `{ comment_id, kind, reactions[] }`, or `{ error }` if the comment is invalid. Reacting does not wake the comment author.

### `remove_reaction`

_Write tool._

Remove your own reaction from a comment. Removing a reaction does not wake the comment author.

**Parameters:**

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `project` | `string` | No | Project slug or ID. Omit to use the project your run is already in; instance agents (CEO/Coach) must name the project to act in. |
| `task_id` | `string` | Yes | Task identifier or UUID the comment belongs to |
| `comment_id` | `string (uuid)` | Yes | UUID of the comment to remove the reaction from, as returned by list_comments. Sentinels like "last" / "latest" are not supported — you must pass an explicit UUID. |
| `kind` | `ack` | Yes | Reaction kind. v1 supports: ack |

**Returns:** `{ comment_id, kind, reactions[] }`, or `{ error }` if the reaction is not found.

### `create_comment`

_Write tool._

Add a comment to an task. In content, reference teammates with @<agent-slug>. Reference tickets and project docs by their bare identifier/filename (e.g. IN-42, spec.md), and skills by their slug — no @ prefix. Do not wrap any of these in backticks — that makes them inert. To point at a specific earlier comment (in this ticket or another), write a comment link as <TASK-ID>#comment-<public_id> (e.g. IN-42#comment-20261009112345) using a comment public_id from list_comments — do not paraphrase "the comment above". When your comment is a direct response to a specific earlier one (answering a question, confirming/pushing back on a request, providing the follow-up that was asked for) ALWAYS set parent_comment_id to that comment's UUID — it wakes the original author with source=reply (so they're notified the conversation moved forward) and shows "replying to ..." threading in the UI so other readers can follow the dialogue. Skip parent_comment_id only when the comment is genuinely standalone (a new observation, an unrelated update). If you only need to acknowledge a mention without adding substance, use add_reaction instead.

**Parameters:**

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `project` | `string` | No | Project slug or ID. Omit to use the project your run is already in; instance agents (CEO/Coach) must name the project to act in. |
| `task_id` | `string` | Yes | Task identifier or UUID |
| `content` | `string` | Yes | Comment text |
| `parent_comment_id` | `string` | No | UUID of the comment you are replying to. Setting this wakes that comment's author with source=reply and renders this comment as "replying to ..." in the UI. |

**Returns:** The created comment row (`id`, `public_id`, `created_at`, …), optionally with an advisory `warning` string. Returns `{ error }` if `parent_comment_id` does not belong to the task. Setting `parent_comment_id` wakes the parent comment's author.

## Agents & hiring

### `list_agents`

_Read-only._

List the agents on a project's team

**Parameters:**

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `project` | `string` | No | Project slug or ID. Omit to use the project your run is already in; instance agents (CEO/Coach) must name the project to act in. |

**Returns:** An array of agent rows (`id`, `agent_type_id`, `title`, `slug`, `daily_budget_cents`, `weekly_budget_cents`, `monthly_budget_cents`, `runtime_status`, `admin_status`).

### `update_hire_proposal`

_Write tool._

Revise the draft of a pending hire approval. Captain-only. Use this to expand or rewrite the system prompt, adjust role description, budget, heartbeat, or touches_code before admin review. All fields are optional — pass only what you want to change.

**Parameters:**

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `approval_id` | `string` | Yes | Hire approval ID |
| `title` | `string` | No | Updated role title |
| `role_description` | `string` | No | Updated short role description |
| `system_prompt` | `string` | No | Updated system prompt |
| `default_effort` | `string` | No | Updated default effort: minimal, low, medium, high, max |
| `heartbeat_interval_min` | `number` | No | Updated heartbeat interval (min) |
| `monthly_budget_cents` | `number` | No | Updated monthly budget in cents |
| `touches_code` | `boolean` | No | Whether this agent reads/writes repo code |

**Returns:** The updated approval row, or `{ error }` if no field changed or the approval is invalid.

**Authorization:** Captain only; the approval must be a pending hire request on the Captain's team.

### `create_hire_proposal`

_Write tool._

File a new hire proposal. Callable by a team Captain (for its own team) or the CEO (for any team — pass `project` to target it, including HQ). Use this when directed or deciding to staff or expand a team: author the full role spec — title, role description, and a complete system prompt — and submit it. The proposal surfaces as a pending approval in the admin inbox; the admin reviews, may modify it, and approves, at which point the agent is created automatically. Pass task_id to link the proposal back to the ticket that prompted it.

**Parameters:**

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `project` | `string` | No | Project slug or ID. Omit to use the project your run is already in; instance agents (CEO/Coach) must name the project to act in. |
| `title` | `string` | Yes | Role title (the slug is derived from it) |
| `role_description` | `string` | No | Short role description |
| `system_prompt` | `string` | No | Full system prompt for the new agent |
| `default_effort` | `string` | No | Default reasoning effort: minimal, low, medium, high, max |
| `heartbeat_interval_min` | `number` | No | Heartbeat interval (min) |
| `daily_budget_cents` | `number` | No | Daily budget in cents |
| `weekly_budget_cents` | `number` | No | Weekly budget in cents |
| `monthly_budget_cents` | `number` | No | Monthly budget in cents |
| `touches_code` | `boolean` | No | Whether this agent reads/writes repo code |
| `task_id` | `string` | No | Optional originating ticket id to link the proposal to |

**Returns:** `{ approval_id, status, payload }` for the new pending hire approval, or `{ error }` if the spec is rejected (missing title, invalid effort/budget, reserved or duplicate slug, or an unknown `task_id`).

**Authorization:** A team Captain (for its own team) or the CEO (for any team — pass `project`, including HQ). The proposal surfaces as a pending approval for the admin.

### `report_no_work`

_Read-only._

Declare that, after evaluating the current task this run, there is genuinely nothing to do — no comment, sub-task, status change, code change, or other action is warranted. Records the run as an intentional no-op so it is NOT flagged as a failed empty run, and is the correct, auditable way to end such a turn (preferred over posting a redundant "nothing to do" comment). Use ONLY when you have truly concluded no action is needed this turn — never to skip, defer, or avoid real work.

**Parameters:**

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `reason` | `string` | Yes | One-line explanation of why there is nothing to do this run. |

**Returns:** `{ ok: true }`, or `{ error }` outside an agent run. Records the run as an intentional no-op so it is not flagged as a failed empty run.

**Authorization:** Available only within an agent run (requires a run identity).

### `set_agent_status`

_Write tool._

Retire (disable) or reinstate (enable) an agent on a project's team. Callable by the team's Captain or by the CEO running in the team. Disabling stops the agent from being scheduled and unassigns it from every open task; enabling resumes scheduling. The change is fully reversible and preserves all of the agent's history, so this is the right way to remove a role the team no longer needs (e.g. after a coherence review). The Captain and the instance agents (CEO/Coach) cannot be disabled this way. Confirm with the admin before retiring an agent.

**Parameters:**

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `project` | `string` | No | Project slug or ID. Omit to use the project your run is already in; instance agents (CEO/Coach) must name the project to act in. |
| `agent` | `string` | Yes | Target agent — its slug (e.g. "engineer") or member ID. Must be a member of this project's team. |
| `status` | `enabled` \| `disabled` | Yes | "disabled" retires the agent; "enabled" reinstates it. |

**Returns:** `{ updated: true, agent_id, slug, admin_status }`, or `{ error }`. Disabling unassigns the agent from every open task; the change is reversible.

**Authorization:** The team's Captain or the CEO. The Captain, CEO, and Coach roles cannot be disabled with this tool.

## Agent prompts & context

### `get_agent_system_prompt`

_Read-only._

Read an agent's system prompt. Accessible by any agent or the admin in the same team. Returns the resolved role doc by default — `{{…}}` placeholders substituted with the real team name, mission, manager, KB, project docs, and team context — so you can see what the agent actually says about itself with real values. Pass placeholders=false to get the raw stored template with `{{…}}` placeholders intact; only do this when you intend to edit the prompt and need a safe round-trip back through update_agent_system_prompt.

**Parameters:**

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `project` | `string` | No | Project slug or ID. Omit to use the project your run is already in; instance agents (CEO/Coach) must name the project to act in. |
| `agent_id` | `string` | Yes | Target agent member ID |
| `placeholders` | `boolean` | No | When true (default) substitutes `{{…}}` placeholders with real team/team values. When false returns the raw stored template — needed when reading before update_agent_system_prompt so placeholders survive the round-trip. |

**Returns:** `{ title, slug, system_prompt }`, or `{ error }` if the agent is not in the team. By default `{{…}}` placeholders are resolved; pass `placeholders: false` for the raw stored template.

**Authorization:** Any agent or the admin in the same team.

### `get_agent_system_prompts`

_Read-only._

Read multiple agent system prompts in one call (max 50). Per-item `mode` chooses the resolution depth: `placeholders` (default) substitutes `{{…}}` with real values and stops, matching get_agent_system_prompt's default; `preview` additionally appends the resolver's runtime blocks (Project State, Team Context, Teammates, Working Guidelines) minus the per-run Run Context, matching the web UI's preview panel; `raw` returns the stored template untouched. Use this to compare prompts across the team in one round-trip — e.g. Captain auditing how team_context renders for every agent. For a single prompt, use get_agent_system_prompt.

**Parameters:**

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `project` | `string` | No | Project slug or ID. Omit to use the project your run is already in; instance agents (CEO/Coach) must name the project to act in. |
| `items` | `object[]` | Yes | Up to 50 items. |

**Returns:** An array of per-item results: `{ index, ok: true, title, slug, system_prompt }` or `{ index, ok: false, agent_id, error }`. Up to 50 items; each `mode` is `placeholders` (default), `preview`, or `raw`.

**Authorization:** Any agent or the admin in the same team.

### `update_agent_system_prompt`

_Write tool._

Apply a system prompt change for an agent. Callable by the Coach agent (for after-task learned-rules updates) or by the Captain of the same team (during team-coherence reviews). The change is applied immediately and a revision snapshot is stored so the admin can restore previous versions.

**Parameters:**

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `project` | `string` | No | Project slug or ID. Omit to use the project your run is already in; instance agents (CEO/Coach) must name the project to act in. |
| `agent_id` | `string` | Yes | Target agent member ID |
| `new_system_prompt` | `string` | Yes | The full updated system prompt |
| `change_summary` | `string` | Yes | Summary of what changed and why |

**Returns:** `{ applied: true, document_id }`, or `{ error }` if denied or the agent is not in the team. A revision snapshot is stored so the admin can restore previous versions.

**Authorization:** The Coach or the team's Captain.

### `set_agent_summary`

_Write tool._

Save a short human-readable summary for an agent (≤1000 chars, single paragraph, plain prose). Callable by any agent in the same team or any the admin; the Captain is the expected caller, but agents may also self-summarise.

**Parameters:**

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `project` | `string` | No | Project slug or ID. Omit to use the project your run is already in; instance agents (CEO/Coach) must name the project to act in. |
| `agent_id` | `string` | Yes | Target agent member ID |
| `summary` | `string` | Yes | The new summary, ≤1000 chars |

**Returns:** `{ updated: true }`, or `{ error }` (summary empty, over 1000 chars, or agent not in team).

**Authorization:** Any agent or the admin in the same team (the Captain is the expected caller; agents may self-summarise).

### `set_team_summary`

_Write tool._

Save the team-level collaboration summary for a team (≤4000 chars, plain prose, may span paragraphs). Only callable by the Captain of that team.

**Parameters:**

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `project` | `string` | No | Project slug or ID. Omit to use the project your run is already in; instance agents (CEO/Coach) must name the project to act in. |
| `summary` | `string` | Yes | The new team summary, ≤4000 chars |

**Returns:** `{ updated: true }`, or `{ error }` (summary empty or over 4000 chars).

**Authorization:** The team's Captain only.

### `set_agent_team_context`

_Write tool._

Save the team-relationships context for an agent (≤6000 chars, plain prose, second-person 'you', describes how this agent relates to its manager, direct reports, peers, indirect reports, and humans). This blob is injected into the agent's system prompt at the start of every run. Only callable by the Captain of the same team.

**Parameters:**

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `project` | `string` | No | Project slug or ID. Omit to use the project your run is already in; instance agents (CEO/Coach) must name the project to act in. |
| `agent_id` | `string` | Yes | Target agent member ID |
| `content` | `string` | Yes | The new team_context, ≤6000 chars |

**Returns:** `{ updated: true }`, or `{ error }` (content empty, over 6000 chars, or agent not in team).

**Authorization:** The team's Captain only.

### `get_agent_team_context`

_Read-only._

Read an agent's stored team-relationships context. Useful for the Captain when regenerating siblings' contexts. Accessible by any agent or the admin in the same team.

**Parameters:**

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `project` | `string` | No | Project slug or ID. Omit to use the project your run is already in; instance agents (CEO/Coach) must name the project to act in. |
| `agent_id` | `string` | Yes | Target agent member ID |

**Returns:** `{ title, slug, team_context }`, or `{ error }` if the agent is not in the team.

**Authorization:** Any agent or the admin in the same team.

## Approvals

### `list_approvals`

_Read-only._

List pending approvals. Pass excerpt_chars (e.g. 500) to truncate long fields inside payload (e.g. skill-proposal content); omit for full payload.

**Parameters:**

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `project` | `string` | No | Project slug or ID. Omit to use the project your run is already in; instance agents (CEO/Coach) must name the project to act in. |
| `excerpt_chars` | `integer` | No | When set, truncates long string fields inside payload (e.g. skill-proposal content) and adds *_truncated/_length companions |

**Returns:** An array of pending approval rows (`id`, `team_id`, `type`, `status`, `requested_by_member_id`, `resolution_note`, `resolved_at`, `created_at`, `payload`). `excerpt_chars` truncates long string fields inside `payload`.

### `resolve_approval`

_Write tool._

Approve or deny an approval

**Parameters:**

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `approval_id` | `string` | Yes | Approval ID |
| `status` | `approved` \| `denied` | Yes | Resolution status |
| `resolution_note` | `string` | No | Note |

**Returns:** The updated approval row, or `{ error }` if not found or denied.

**Authorization:** Authorized against the approval's own team/project; an agent run must be scoped to act on it.

## Skills & search

### `propose_skill`

_Write tool._

Propose a new skill for the team's skills database (reusable team know-how: MCP server usage, integration steps, conventions, how agents coordinate). Creates an approval request; when approved the skill is written to the skills database.

**Parameters:**

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `project` | `string` | No | Project slug or ID. Omit to use the project your run is already in; instance agents (CEO/Coach) must name the project to act in. |
| `skill_name` | `string` | Yes | Human-readable skill name |
| `skill_slug` | `string` | Yes | URL-safe slug for the skill file |
| `content` | `string` | Yes | Skill content (markdown) |
| `reason` | `string` | Yes | Why this skill should be added |

**Returns:** `{ approval_id, status }` — creates a skill-proposal approval that writes the skill when approved.

### `semantic_search`

_Read-only._

Full-text keyword search across the team skills database, tasks, project docs, and task comments. Returns results ranked by relevance (keyword + stemming match).

**Parameters:**

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `project` | `string` | No | Project slug or ID. Omit to use the project your run is already in; instance agents (CEO/Coach) must name the project to act in. |
| `query` | `string` | Yes | Search query (keywords) |
| `scope` | `all` \| `tasks` \| `skills` \| `project_docs` \| `comments` | No | Limit search to specific content type (default: all) |
| `limit` | `number` | No | Max results per type (default: 10) |

**Returns:** `{ results, count }` — full-text (keyword + stemming) matches ranked by relevance across skills, tasks, project docs, and comments.

### `list_skills`

_Read-only._

List the team's skills database — the manifest of reusable team know-how (MCP server usage, integration steps, conventions, how agents coordinate). Returns each skill's name, slug, and description; call get_skill to load a skill's full body on demand.

**Parameters:**

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `project` | `string` | No | Project slug or ID. Omit to use the project your run is already in; instance agents (CEO/Coach) must name the project to act in. |
| `tags` | `string` | No | Filter by tag (comma-separated) |

**Returns:** `{ skills: [{ id, name, slug, description, tags, created_at, updated_at }] }`. Pass `tags` (comma-separated) to filter.

### `get_skill`

_Read-only._

Load the full body of a skill from the team's skills database by slug. Use after list_skills surfaces a relevant skill in the manifest.

**Parameters:**

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `project` | `string` | No | Project slug or ID. Omit to use the project your run is already in; instance agents (CEO/Coach) must name the project to act in. |
| `slug` | `string` | Yes | Skill slug |

**Returns:** The full skill row (including `content`), or `{ error }` if not found.

### `create_skill`

_Write tool._

Add or update a skill in the team's skills database directly (no approval needed) — record reusable team know-how such as MCP server usage, integration steps, conventions, and how agents coordinate. Use propose_skill when approval is required. If description is omitted it is derived from the skill body.

**Parameters:**

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `project` | `string` | No | Project slug or ID. Omit to use the project your run is already in; instance agents (CEO/Coach) must name the project to act in. |
| `name` | `string` | Yes | Human-readable skill name |
| `slug` | `string` | Yes | URL-safe slug |
| `content` | `string` | Yes | Skill content (markdown) |
| `description` | `string` | No | Short description |
| `tags` | `string` | No | Comma-separated tags |

**Returns:** `{ skill_id, slug, created: true }`. Upserts by `slug` and writes a skill revision; `description` is derived from the body when omitted.

## Credentials & connectors

### `request_credential`

_Write tool._

Ask the human assignee to provide a secret value (API key, SSH private key, OAuth token, etc.). Posts a structured comment on the task with a paste form. The agent never sees the value; it gets a placeholder string to embed in env vars or HTTP headers, which the egress proxy later substitutes. Returns immediately with the placeholder; the agent should stop work on whatever needed the credential and wait for a credential_provided wakeup. For HTTP-auth kinds (api_key, oauth_token, github_pat) allowed_hosts is REQUIRED — scope it to the provider API host(s) so the secret can only ever reach those hosts. Always ask for the narrowest scope and shortest expiry the provider offers. If a registered connector capability already covers the provider (e.g. a remote MCP server with OAuth), prefer register_connector over a raw paste.

**Parameters:**

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `project` | `string` | No | Project slug or ID. Omit to use the project your run is already in; instance agents (CEO/Coach) must name the project to act in. |
| `task_id` | `string` | Yes | Task identifier or UUID — the request comment is posted here |
| `name` | `string` | Yes | Secret name. Must match [A-Z][A-Z0-9_]{0,63} (e.g. GITHUB_PAT, ANTHROPIC_API_KEY). The placeholder returned will be __HEZO_SECRET_<name>__. |
| `kind` | `api_key` \| `ssh_private_key` \| `github_pat` \| `oauth_token` \| `webhook_secret` \| `other` | Yes | Type of credential — drives validation when the human submits the value |
| `instructions` | `string` | Yes | Human-facing prose explaining why you need this credential and how the human can obtain it. Tell the human to set the minimal scope and the shortest expiry the provider supports (e.g. "I need a GitHub PAT with only `repo` scope to push branches, ideally expiring in 7 days. Create one at https://github.com/settings/tokens"). |
| `input_type` | `text` \| `textarea` \| `file` | No | Form input type. Defaults: text for short keys, textarea for SSH/multiline. |
| `confirmation_text` | `string` | No | Optional yes/no confirmation prompt instead of a paste form (e.g. "Have you added the public key to github.com/owner/repo/settings/keys?"). When set, input_type is ignored. |
| `allowed_hosts` | `string[]` | No | Hostname allowlist for the egress proxy. The credential is only substituted into outbound requests to these hosts. REQUIRED for HTTP-auth kinds (api_key, oauth_token, github_pat) — e.g. ["api.netlify.com"]. Wildcards: *.github.com matches one label segment. |

**Returns:** `{ placeholder, comment_id, status: "pending", reused }`. The agent never sees the value; it embeds `placeholder` (`__HEZO_SECRET_<NAME>__`) and the egress proxy substitutes the real value. Returns `{ error }` for an invalid name, or for an HTTP-auth kind requested without `allowed_hosts`. Idempotent on `name`.

### `register_connector`

_Write tool._

Register a third-party MCP server connector for the team and ask the human to authenticate. Posts a connect_required comment on the task with a Connect button; the human clicks it to run OAuth in their own browser. The agent never sees the token; subsequent runs receive the MCP via the egress proxy + placeholder substitution. Idempotent: re-registering an already-active connector returns its current state and fires the wakeup immediately. Auth mechanism is chosen automatically by what the provider supports: servers that advertise OAuth Dynamic Client Registration (most MCP servers) need only mcp_url and authorize with zero config. Providers whose Authorization Server cannot do DCR (e.g. GitHub) require a pre-registered client_id and use the device flow instead — these MUST be registered with provider_id set to a known registry key (e.g. "github"); passing only a raw mcp_url for such a provider will fail to authorize.

**Parameters:**

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `project` | `string` | No | Project slug or ID. Omit to use the project your run is already in; instance agents (CEO/Coach) must name the project to act in. |
| `task_id` | `string` | Yes | Task identifier or UUID where the connect_required comment is posted |
| `display_name` | `string` | Yes | Human-readable connector name shown in the task chat and on the Connectors page (e.g. "DatoCMS", "Linear"). |
| `mcp_url` | `string` | Yes | URL of the MCP server (HTTP / SSE). The OAuth dance is discovered by probing this URL for a 401 + WWW-Authenticate header. |
| `mcp_transport` | `http` \| `sse` | No | Transport for the MCP server. Defaults to http. |
| `provider_id` | `string` | No | Optional registry key (e.g. "datocms"). When set, capability defaults from the shared registry pre-fill display name and allowed hosts. |
| `skill_id` | `string` | No | Optional ID of a previously-fetched skill document (see fetch_skill_file). When set, the skill file is exposed to every team agent run via the per-adapter skill path. |

**Returns:** `{ connector_id, status, name, display_name, comment_id?, reused }`. `status` is `active` (OAuth already complete) or `pending` (a connect_required comment is posted for the human). Idempotent.

### `fetch_skill_file`

_Read-only._

Fetch a remote agent skill file (Markdown describing how to use a third-party MCP server) and store it as a global skill (auto_load). Returns the skill_id and slug. Subsequent agent runs across every team get this skill file injected into their adapter's skills directory. Idempotent on the derived slug — re-fetching the same URL updates the existing skill.

**Parameters:**

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `project` | `string` | No | Project slug or ID. Omit to use the project your run is already in; instance agents (CEO/Coach) must name the project to act in. |
| `url` | `string` | Yes | HTTPS URL of the skill file. Only http/https schemes are allowed; response must be < 256KB; 10s timeout. |
| `title` | `string` | No | Human-readable title shown in the team KB. Defaults to the URL pathname. |

**Returns:** `{ skill_id, slug, source_url, size_bytes, reused }`, or `{ error }` (invalid URL, non-HTTP(S), over 256 KB, or fetch failure). Stored as an auto-load global skill; idempotent on the derived slug.

## MCP connections

### `list_mcp_connections`

_Read-only._

List the MCP server connections available to agent runs (instance-global — the same catalog for every team). Each row includes a derived `oauth_status` so you can tell whether a connector is usable: "active" means OAuth completed and the MCP tools should appear in your tool list on your next run; "pending" means waiting on the human to click Connect; "failed" means the OAuth flow errored (see auth_error); "revoked" means a human disconnected it; "none" means no OAuth needed (e.g., an env-var-token MCP or a public one). Do NOT confuse `install_status` (which tracks local-package install state and is meaningless for SaaS MCPs) with `oauth_status`. An active OAuth-backed connector also carries `rest_auth` = `{ placeholder, allowed_hosts, scopes }`: put `placeholder` (e.g. in an `Authorization: Bearer <placeholder>` header) on a raw HTTP request to authenticate the provider's REST API directly when no MCP tool covers what you need — the egress proxy substitutes the real token, but ONLY for requests to `allowed_hosts`; you never see the value. Use this instead of requesting a PAT (e.g. for GitHub repo-settings edits that the `github` MCP does not expose).

**Parameters:**

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `project` | `string` | No | Project slug or ID. Omit to use the project your run is already in; instance agents (CEO/Coach) must name the project to act in. |

**Returns:** An array of connector rows with a derived `oauth_status` (`active` | `pending` | `failed` | `revoked` | `none`) and, for an active OAuth-backed connector, `rest_auth` = `{ placeholder, allowed_hosts, scopes }` (else `null`). Other fields include `id`, `name`, `display_name`, `kind`, `config`, `install_status`, `install_error`, `skill_id`, `created_by_task_id`, `activated_at`, `revoked_at`, `auth_error`. Instance-global.

### `test_connector`

_Read-only._

Test an MCP connector end-to-end from the server side. Resolves the stored OAuth token from the vault and makes a direct HTTP call to the MCP server (bypassing the agent container and its egress proxy entirely). Returns the upstream status code, response excerpt, and the secret name + masked-token-prefix used. Use this when oauth_status says "active" but the MCP's tools are absent from your tool list — it isolates "is the token still valid against the provider?" from "does the proxy chain in the container work?".

**Parameters:**

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `project` | `string` | No | Project slug or ID. Omit to use the project your run is already in; instance agents (CEO/Coach) must name the project to act in. |
| `connector_id` | `string` | Yes | mcp_connections.id from list_mcp_connections |

**Returns:** `{ ok, status, mcp_url, secret_name, token_prefix, token_length, www_authenticate, body_excerpt, hint }` from a direct server-side probe of the MCP URL. Returns `{ error }` if the connector is missing, not `saas`, or its token cannot be decrypted.

### `add_mcp_connection`

_Write tool._

Register an MCP server (SaaS HTTP or local stdio). Connections are instance-global — available to every team's agent runs. SaaS servers go into the agent's descriptor list immediately. Header values may include __HEZO_SECRET_<NAME>__ placeholders that the egress proxy substitutes at request time. Local servers must be installed before they take effect.

**Parameters:**

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `project` | `string` | No | Project slug or ID. Omit to use the project your run is already in; instance agents (CEO/Coach) must name the project to act in. |
| `name` | `string` | Yes | Server identifier — used as the MCP descriptor name and as the unique key. |
| `kind` | `saas` \| `local` | Yes | saas = HTTP MCP, local = stdio MCP |
| `config` | `object` | Yes | For saas: { url, headers? }. For local: { command, args?, env?, package? }. |

**Returns:** `{ id, install_status, note }`, or `{ error }` if `config.url` (saas) / `config.command` (local) is missing. Upserts by `name`; instance-global.

### `remove_mcp_connection`

_Write tool._

Remove a registered MCP connection (instance-global — removing it affects every team). The next agent run will not see it.

**Parameters:**

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `project` | `string` | No | Project slug or ID. Omit to use the project your run is already in; instance agents (CEO/Coach) must name the project to act in. |
| `id` | `string` | Yes | mcp_connections.id (returned by add_mcp_connection or list_mcp_connections) |

**Returns:** `{ removed: true, id }`, or `{ error }` if the connection is not found. Instance-global.

## Project docs & assets

### `list_project_docs`

_Read-only._

List project documentation files (PRD, spec, implementation plan, etc.)

**Parameters:**

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `project` | `string` | No | Project slug or ID. Omit to use the project your run is already in; instance agents (CEO/Coach) must name the project to act in. |

**Returns:** `{ files: [{ id, filename, title, updated_at }] }` — the markdown project docs.

### `list_project_assets`

_Read-only._

List the project's assets — non-markdown files (UI mockups, wireframes, diagrams, PDFs). Reference one in a comment or doc as `assets/<filename>` (e.g. assets/login-mockup.png), no backticks. You can author text-based assets (.html, .svg, .txt) with write_project_asset; binary assets (images, PDFs) are human-uploaded.

**Parameters:**

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `project` | `string` | No | Project slug or ID. Omit to use the project your run is already in; instance agents (CEO/Coach) must name the project to act in. |

**Returns:** `{ files: [{ id, filename, content_type, created_at }] }` — the non-markdown assets.

### `write_project_asset`

_Write tool._

Save a text-based file to the project assets library so a human can open it (an interactive HTML mockup, an SVG diagram, a plain-text export). Allowed extensions: .html, .svg, .txt. Re-saving the same filename overwrites it, so the reference stays stable. Returns the reference string to drop into a comment as `assets/<filename>` (no backticks). HTML opens interactively in a new tab. Mockups and other deliverables belong here, never committed to the source repo.

**Parameters:**

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `project` | `string` | No | Project slug or ID. Omit to use the project your run is already in; instance agents (CEO/Coach) must name the project to act in. |
| `filename` | `string` | Yes | Filename to write (e.g. "ui-mockups.html") |
| `content` | `string` | Yes | File content |

**Returns:** `{ written: true, id, reference: "assets/<filename>" }`, or `{ error }` if the type is not text-based (`.html`, `.svg`, `.txt`) or exceeds 10 MB. Re-saving the same filename overwrites it.

### `read_project_asset`

_Read-only._

Read a project asset's contents by filename (e.g. "ui-mockups.html") — the non-markdown files that list_project_assets returns (UI mockups, wireframes, SVG diagrams, text exports). Text-based assets (HTML, SVG, plain text) come back inline as `content`. Binary assets (images, PDFs, media) are not inlined; the response gives a read-only container path under /workspace/.hezo/assets/ to open directly. For markdown project docs use read_project_doc instead.

**Parameters:**

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `project` | `string` | No | Project slug or ID. Omit to use the project your run is already in; instance agents (CEO/Coach) must name the project to act in. |
| `filename` | `string` | Yes | Asset filename to read (e.g. "ui-mockups.html") |

**Returns:** For a text asset, `{ filename, content_type, content }`. For a binary asset, `{ filename, content_type, byte_size, binary: true, path }` (a read-only container path). Returns `{ error }` if not found.

### `read_project_doc`

_Read-only._

Read a markdown project doc by filename (e.g. "spec.md") — the high-level project context (PRDs, specs, architecture decisions, research) that list_project_docs returns; the full body comes back inline as `content`. These docs live in the project-doc store in the database, NOT on the filesystem: there is no /workspace/.hezo/project-docs path, so do not reach for the Read/cat file tools — always load a doc through this tool by its bare filename. For non-markdown assets (mockups, wireframes, diagrams) use read_project_asset instead.

**Parameters:**

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `project` | `string` | No | Project slug or ID. Omit to use the project your run is already in; instance agents (CEO/Coach) must name the project to act in. |
| `filename` | `string` | Yes | Filename to read (e.g. "spec.md") |

**Returns:** `{ filename, content }` (the full markdown body), or `{ error }` if the file is not found.

### `write_project_doc`

_Write tool._

Write a project documentation file. Project docs are markdown only — the filename must end in .md. For high-level project context: PRD, spec, implementation plan, research. Non-markdown files (mockups, wireframes, images, PDFs) live in the project assets library instead — reference those as `assets/<filename>`. In content, reference teammates with @<agent-slug>. Reference tickets and project docs by their bare identifier/filename (e.g. IN-42, spec.md), and skills by their slug — no @ prefix. Do not wrap any of these in backticks — that makes them inert.

**Parameters:**

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `project` | `string` | No | Project slug or ID. Omit to use the project your run is already in; instance agents (CEO/Coach) must name the project to act in. |
| `filename` | `string` | Yes | Markdown filename to write (e.g. "spec.md") |
| `content` | `string` | Yes | File content (markdown) |

**Returns:** `{ written: true, id, filename }`, or `{ error }` if the filename is not `.md`.

## Costs

### `get_costs`

_Read-only._

Get the cost summary for a project

**Parameters:**

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `project` | `string` | No | Project slug or ID. Omit to use the project your run is already in; instance agents (CEO/Coach) must name the project to act in. |
| `group_by` | `agent` \| `day` | No | Group costs by |

**Returns:** With `group_by: "agent"`, an array of `{ member_id, agent_title, total_cents }`; with `group_by: "day"`, an array of `{ day, total_cents }`; otherwise `{ total_cents, entry_count }`.

## Onboarding

### `register`

_Read-only._

Register this agent with Hezo. Returns an access token (shown once) — set it as your `Authorization: Bearer` token. The registration is inert until a Hezo admin approves it under Settings → API keys; once approved you have full instance access (every project and team). Poll `connection_status` to learn when you are approved.

**Parameters:**

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `name` | `string` | Yes | A human-readable name for this agent, shown to the admin who approves it. |
| `client_info` | `object` | No | Optional MCP client info (e.g. {"name":"claude","version":"…"}). |

**Returns:** `{ id, token, status, message }` — the `hezo_…` token is shown once. Returns `{ error }` if `name` is missing.

**Authorization:** No token required — this is how an external agent self-registers. The registration stays inert until a Hezo admin approves it.

### `connection_status`

_Read-only._

Check whether this agent has been approved yet. Send your token as the `Authorization: Bearer` token. Returns {"status":"pending"} or {"status":"approved"}.

**Parameters:** none.

**Returns:** `{ status: "pending" | "approved" }`, or `{ error }` if no/unknown token is sent.

**Authorization:** Keyed by the bearer token from `register`; no approved principal required.

---

Generated from the MCP tool registry. Full docs: https://hezo.ai/docs/introduction
