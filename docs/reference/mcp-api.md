---
title: MCP API reference
order: 32
section: Reference
---

<!-- GENERATED FILE - do not edit by hand. Source: packages/server/src/mcp/mcp-reference.ts
     (generator + per-tool metadata) and the live MCP tool registry. Regenerate with
     `bun run --cwd packages/server build:docs`; mcp-reference.test.ts fails if this file
     is stale. -->

# MCP API reference

Complete reference for every tool exposed by Hezo's built-in MCP server. For how to
connect, authenticate, and register for access, see
[Hezo's MCP server](/docs/mcp/hezo-mcp-server).

## Connecting

- **Endpoint:** `POST /mcp` - JSON-RPC 2.0 over Streamable HTTP.
- **Authentication:** `Authorization: Bearer <token>`, where the token is an
  instance-scoped API key (`hezo_…`).
- **Discovery:** call `tools/list` for the live machine-readable schemas, then invoke a
  tool with `tools/call`.
- **File uploads:** binary files cannot ride a JSON-RPC call - `POST` them to
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
- **Paging is the norm, in one of three shapes.** A read that can return many rows,
  or content with no size ceiling, always returns a bounded slice plus the cursor to
  continue. A response carrying `has_more: true`, `next_cursor`, `next_offset`, or
  `next_index` is telling you it is partial - keep calling until the cursor is null or
  `has_more` is false. Treating the first page as the whole set is the one failure
  mode none of these shapes can protect you from.
  - **Lists** take `limit` (default 50, ceiling 200) and an opaque `cursor`, and return
    `{ items, next_cursor, has_more }`. Pass back the `next_cursor` you were given;
    do not construct or parse one. `list_comments` also still accepts `before`
    (a comment `id` or `public_id`) to resume from a comment you already know.
  - **Large single content** (`read_project_doc`, `get_agent_system_prompt`,
    `get_run_log`) takes `offset` plus `max_bytes` and returns a UTF-8 window with
    `next_offset`. Note `get_run_log` defaults to the log **tail**; pass `offset: 0`
    to read a run that failed early, since the tail cannot reach the start.
  - **Batch tools** (`get_agent_system_prompts`) return as many items as fit plus
    `next_index`; call again with the same `items` and `start_index` set to it.
- **Result size:** a tool result is capped at 64 KB (higher for a few full-resource
  inspection tools, e.g. `get_agent_system_prompt`). Over the cap the whole result is
  discarded and you get `{ "error": "result_too_large", "remedies": [...] }`. The
  `remedies` are built from the parameters that tool actually declares, so follow
  them rather than guessing - and when the tool takes a batch, they name the exact
  item count to retry with. Split the work and retry; do not fall back to one call
  per item, and do not narrow what you cover to whatever fits in one call.
- **Excerpts (`excerpt_chars`):** list tools return long free-text fields as excerpts
  with `_truncated`/`_length` companions, so one page cannot be dominated by a few
  large rows. An excerpt is cut to fill `excerpt_chars`, so it usually stops
  mid-sentence; always check the `_truncated` companion rather than judging from
  whether the text reads as complete. To get the whole value, call the matching
  single-item read - `get_task` for a task, `get_comment` for a comment,
  `read_project_doc` for a doc - not a larger `excerpt_chars`.
- **Secrets:** agents reference secrets by placeholder (`__HEZO_SECRET_<NAME>__`); the
  egress proxy substitutes the real value only for the secret's `allowed_hosts`.
- **Write tools:** tools marked _Write tool_ persist data - a successful call from an
  agent run marks the run as having produced output.

## Teams

### `list_teams`

_Read-only._

List teams accessible to the caller, by name. An API key and the instance CEO (cross-team session) get every team in the instance; an ordinary agent run gets only its own team. Paged: returns `limit` rows (default 50) plus `next_cursor`/`has_more`; when `has_more` is true, call again with `cursor` set to `next_cursor` until it is false.

**Parameters:**

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `limit` | `integer` | No | Max rows to return in this page (default 50, ceiling 200). |
| `cursor` | `string` | No | Opaque cursor from a previous call. Pass back the `next_cursor` you were given to fetch the following page; keep going until `has_more` is false. Treat it as opaque - do not construct or parse one. |

**Returns:** Team rows (`id`, `name`, `slug`, `description`, …) ordered by name. Paged: returns `{ items, next_cursor, has_more }` - follow `next_cursor` until `has_more` is false. An API key, the instance CEO, and an agent run with cross-team scope get every team; an ordinary agent run gets only its own team; a board user gets the teams they belong to (all teams for a superuser).

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

### `update_project_progress`

_Write tool._

Replace the project progress summary shown at the top of the project dashboard. Only the Captain does this, and only from within a progress-update run. The summary is the high-level read: where the project stands, what has taken place, and what is being planned. Pitch it at what the work means for the project, not a log of what happened inside individual tasks, and leave out mechanics like branches, CI and review round-trips. Do NOT name individual tasks or identifiers - the dashboard lists the specific work beneath this, and a reader who wants a task clicks through to it. This overwrites the whole summary, so include everything that should remain.

**Parameters:**

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `project` | `string` | No | Project slug or ID. Omit to use the project your run is already in; instance agents (CEO/Coach) must name the project to act in. |
| `summary` | `string` | Yes | Markdown summary of where the project stands: what has taken place and what is being planned. Lead with the key points in **bold**, then a short narrative. Do not reference task identifiers. |

**Returns:** `{ summary, updated_at }` after replacing the project progress summary shown at the top of the project dashboard. Returns `{ error }` if the project is HQ/internal (which has no progress summary) or the call is not from within an agent run.

**Authorization:** Captain only, and only from within a progress-update agent run.

### `create_project`

_Write tool._

Create a new project together with its dedicated team. CEO-only. Call this ONLY after the admin has explicitly approved the finalised scope AND team type in the intake conversation - a plain reply approving it is enough (there is no inbox button to wait on), but do not call it while still scoping, on assumed defaults, or in the same turn you propose the plan; creating a project stands up a full team + container, so wait for the go-ahead. Provisions the team from the chosen source (pass template_id from list_team_templates, source_team_id to clone an existing team, or marketplace_slug to provision a marketplace team; defaults to Blank), creates the project, its planning task, and the initial CEO coherence/setup task the planning task is blocked on, then provisions the container. The coherence/setup task is created unassigned and does NOT start automatically on this path: first author its description (update_task on the returned setup_task_identifier) to capture the concrete setup you agreed in intake - the exact roles to hire, any system-prompt rewrites, and the reporting structure - then call start_team_setup(project) to begin the run. When intake_task_id is given, the intake conversation is closed with a completion note. Returns the new project plus its planning and setup task identifiers.

**Parameters:**

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `name` | `string` | Yes | Project name |
| `description` | `string` | Yes | Project description |
| `task_prefix` | `string` | No | Optional 2-4 char uppercase task prefix; derived from the name when omitted |
| `initial_project_plan` | `string` | No | Optional project plan document (markdown), seeded as project-plan.md |
| `template_id` | `string` | No | Team-type template id (from list_team_templates). Mutually exclusive with source_team_id; defaults to Blank when neither is given. |
| `source_team_id` | `string` | No | Existing team to clone into a fresh template. Mutually exclusive with template_id. |
| `marketplace_slug` | `string` | No | A marketplace team slug (from get_marketplace_team / the intake baseline) to provision the roster from directly. Mutually exclusive with template_id and source_team_id. |
| `intake_task_id` | `string` | No | The HQ project-intake task this fulfils (its identifier, e.g. "HQ-1", or its UUID); it is closed with a completion note on success. |

**Returns:** The new project row plus `team_slug`, `planning_task_id`, `planning_task_identifier`, and the initial CEO team-setup task (`setup_task_id`, `setup_task_identifier`) - the project's first task, which the planning task is blocked on. The setup task is created unassigned and does NOT auto-run on this path - draft its description then call `start_team_setup`. Returns `{ error }` if validation fails.

**Authorization:** CEO only - call after the admin has explicitly approved the scope and team type in intake.

### `start_team_setup`

_Write tool._

Kick off the initial team-coherence/setup run for a project you created via create_project. CEO-only. Projects created directly from the admin form start their coherence pass automatically; projects you create do NOT. First author the coherence task with update_task - replace its description with the concrete plan you agreed in intake (the exact roles to hire and why, any system-prompt rewrites, and the reporting structure) - then call this to assign the task to yourself and start the run. Returns the started task; errors if there is no open setup task for the project or a run is already active on it.

**Parameters:**

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `project` | `string` | No | Project slug or ID. Omit to use the project your run is already in; instance agents (CEO/Coach) must name the project to act in. |

**Returns:** `{ started: true, task_id, task_identifier }` after assigning the project’s open coherence/setup task to the CEO and waking them to run it. Returns `{ error }` if there is no open setup task for the project or a run is already active on it.

**Authorization:** CEO only - for a project the CEO created via `create_project`; author the coherence task description first.

### `list_team_templates`

_Read-only._

List local team templates: the built-in Blank template plus any custom templates saved from existing teams. The default specialist rosters (e.g. the app-dev "App Team") live in the marketplace, not here. Use when recommending a team structure to hire. Paged: returns `limit` entries (default 50) plus `next_cursor`/`has_more`; when `has_more` is true, call again with `cursor` set to `next_cursor` until it is false.

**Parameters:**

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `limit` | `integer` | No | Max rows to return in this page (default 50, ceiling 200). |
| `cursor` | `string` | No | Opaque cursor from a previous call. Pass back the `next_cursor` you were given to fetch the following page; keep going until `has_more` is false. Treat it as opaque - do not construct or parse one. |

**Returns:** Local templates (`id`, `name`, `description`, `is_builtin`, `agent_types[]` where each entry has `slug`, `name`, `role_description`). Paged: returns `{ items, next_cursor, has_more }` - follow `next_cursor` until `has_more` is false. Only the built-in Blank template and custom saved templates appear here - the default specialist rosters live in the marketplace (`get_marketplace_team`).

### `list_marketplace_teams`

_Read-only._

Browse the team marketplace: every ready-made team available to this instance, with its name, description, summary, role count, and version. Callable by the CEO or a team Captain. Use it before staffing a team - the marketplace carries proven, fully-written roles, so check whether one already covers the role you need (then pull its prompt with get_marketplace_team) instead of authoring a system prompt from scratch. You can take a whole roster (apply_marketplace_team) or lift out a single role (apply_marketplace_agent). Paged: returns `limit` entries (default 50) plus `next_cursor`/`has_more`; when `has_more` is true, call again with `cursor` set to `next_cursor` until it is false.

**Parameters:**

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `limit` | `integer` | No | Max rows to return in this page (default 50, ceiling 200). |
| `cursor` | `string` | No | Opaque cursor from a previous call. Pass back the `next_cursor` you were given to fetch the following page; keep going until `has_more` is false. Treat it as opaque - do not construct or parse one. |

**Returns:** Marketplace teams available to this instance, each with `slug`, `name`, `description`, `summary`, `version`, and `roster_count`. Paged: returns `{ items, next_cursor, has_more }` - follow `next_cursor` until `has_more` is false. Search keywords are omitted. Fetch one team’s full roster and prompts with `get_marketplace_team`.

**Authorization:** CEO or a team Captain.

### `get_marketplace_team`

_Read-only._

Fetch one marketplace team's full definition: its version, changelog, and every role's title, reporting line, and CURRENT system prompt (including the Captain override). Callable by the CEO or a team Captain. Use it when adding/updating a team, to compare the marketplace's prompts to the agents you already have and decide what to refresh; and when hiring, to start a role from a proven marketplace prompt instead of writing one from scratch - find candidate teams with list_marketplace_teams first.

**Parameters:**

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `slug` | `string` | Yes | The marketplace team slug (e.g. "app-dev"). |

**Returns:** The marketplace team’s `slug`, `name`, `version`, `changelog[]`, `captain` (`system_prompt`, `team_context`), and `roster[]` (each with `slug`, `title`, `reports_to_slug`, `role_description`, `summary`, `team_context`, `system_prompt`). Returns `{ error }` if the slug is unknown.

**Authorization:** CEO or a team Captain.

### `apply_marketplace_team`

_Write tool._

Add or update a marketplace team's roster on a project's team. CEO-only. Fetches the named marketplace team and provisions its members directly onto the project's existing team - a direct add, not an approval-gated hire proposal, so use it only for a team the admin already chose. Roles the team already has are SKIPPED by default; pass refresh_existing=true to instead refresh those roles' descriptions and system prompts to this team's current versions (use this when the project was created from an earlier version of THIS SAME team - it is a version update, not a duplicate add). refresh_existing overwrites prompts, so before using it on roles that may carry local customizations, read them (get_agent_system_prompt) and the new versions (get_marketplace_team) and refresh selectively with update_agent_system_prompt instead. After it returns, reconcile the merged roster. Returns the roles added, refreshed, and skipped.

**Parameters:**

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `project` | `string` | No | Project slug or ID. Omit to use the project your run is already in; instance agents (CEO/Coach) must name the project to act in. |
| `slug` | `string` | Yes | The marketplace team slug to add (e.g. "app-dev"). |
| `refresh_existing` | `boolean` | No | When true, refresh roles the team already has to this team's current prompts/descriptions instead of skipping them. Default false. Use for a version update of the same team; prefer selective update_agent_system_prompt when roles carry customizations. |

**Returns:** `{ added, refreshed, skipped, captain_updated, version }` - the roster slugs added, refreshed in place (with `refresh_existing`), and skipped. Provisions members directly (no approval flow). Returns `{ error }` if the slug is unknown.

**Authorization:** CEO only - use only for a team the admin already chose; reconcile the merged roster afterwards.

### `apply_marketplace_agent`

_Write tool._

Add ONE role from a marketplace team to a project's team. CEO-only. Use this when the admin wants a single role (e.g. just the security engineer) rather than a whole roster - it provisions that one member directly, a direct add rather than an approval-gated hire proposal, and leaves the rest of the roster, including the Captain, untouched. The team already having that slug is a no-op (skipped). The role's prompt was written for its home team, so AFTER this returns you MUST fit it to this project: rewrite its system prompt and team context (update_agent_system_prompt, set_agent_team_context) so every teammate and hand-off they name is an agent that actually exists here, set a real manager with set_agent_reports_to, and update the existing agents whose work now flows through it. When the role's own manager is not on this team the reporting line is wired to the Captain as a placeholder and reports_to_fell_back comes back true - re-point it. Returns whether the role was added or skipped, plus the reporting line applied.

**Parameters:**

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `project` | `string` | No | Project slug or ID. Omit to use the project your run is already in; instance agents (CEO/Coach) must name the project to act in. |
| `slug` | `string` | Yes | The marketplace team slug the role comes from (e.g. "app-dev"). |
| `role` | `string` | Yes | The roster role slug to add (e.g. "security-engineer"), as listed by get_marketplace_team. The Captain is not a roster role and cannot be added this way. |

**Returns:** `{ role, added, skipped, reports_to, reports_to_fell_back, version }` for the single role provisioned. `skipped` is true when the team already had that slug. `reports_to_fell_back` is true when the role’s own manager is not on this team, so the line was wired to the Captain as a placeholder. Returns `{ error }` if the team slug or role slug is unknown.

**Authorization:** CEO only - use only for a role the admin already chose; fit the role’s prompt and reporting line to the existing roster afterwards.

### `list_projects`

_Read-only._

List projects, by name. With CEO cross-team access (or as superuser) returns every project across the instance; a board user gets the projects on teams they belong to; an agent run gets its own project. description comes back as an excerpt capped at `excerpt_chars` (default 500); read a project's full description with get_team or the project's own docs. Paged: returns `limit` rows (default 50) plus `next_cursor`/`has_more`; when `has_more` is true, call again with `cursor` set to `next_cursor` until it is false.

**Parameters:**

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `excerpt_chars` | `integer` | No | Cap for the description excerpt, with description_truncated/_length companions (default 500). |
| `limit` | `integer` | No | Max rows to return in this page (default 50, ceiling 200). |
| `cursor` | `string` | No | Opaque cursor from a previous call. Pass back the `next_cursor` you were given to fetch the following page; keep going until `has_more` is false. Treat it as opaque - do not construct or parse one. |

**Returns:** Project rows (`id`, `team_id`, `name`, `slug`, `task_prefix`, `is_internal`, `created_at`, `updated_at`) ordered by name. Paged: returns `{ items, next_cursor, has_more }` - follow `next_cursor` until `has_more` is false. `description` comes back as an excerpt (default 500 chars) with `description_truncated`/`description_length` companions; raise or lower it with `excerpt_chars`.

**Authorization:** An API key, CEO cross-team access, or a superuser returns every project; a board user gets the projects on their teams; an agent run gets its own project.

## Tasks

### `list_tasks`

_Read-only._

List a project's tasks, newest first. Omit `project` to use the project your run is in; pass it (slug or ID) to inspect another project. Narrow with status (comma-separated) or assignee_id/assignee_slug. The Project State block in your system prompt already gives you the active tasks in the current project - only call this if you need older or terminal tasks, another project, or a specific status filter. Paged: returns `limit` rows (default 50) plus `next_cursor`/`has_more`; when `has_more` is true, call again with `cursor` set to `next_cursor` until it is false. description and rules come back as excerpts capped at `excerpt_chars` (default 500) so one page cannot be dominated by a few long tasks - read a task's full text with get_task.

**Parameters:**

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `project` | `string` | No | Project slug or ID. Omit to use the project your run is already in; instance agents (CEO/Coach) must name the project to act in. |
| `status` | `string` | No | Filter by status (comma-separated) |
| `assignee_id` | `string` | No | Filter by assignee - an agent slug (e.g. "engineer") or a member UUID |
| `assignee_slug` | `string` | No | Filter by assignee agent slug (alternative to assignee_id) |
| `excerpt_chars` | `integer` | No | Cap for the description and rules excerpts, with _truncated and _length companion fields (default 500). Use get_task for a task's full text. |
| `limit` | `integer` | No | Max rows to return in this page (default 50, ceiling 200). |
| `cursor` | `string` | No | Opaque cursor from a previous call. Pass back the `next_cursor` you were given to fetch the following page; keep going until `has_more` is false. Treat it as opaque - do not construct or parse one. |

**Returns:** Task rows ordered newest-first, each including `project_name`. Paged: returns `{ items, next_cursor, has_more }` - follow `next_cursor` until `has_more` is false. `description` and `rules` come back as excerpts (default 500 chars) plus `_truncated`/`_length` companions; read a task in full with `get_task`.

### `get_task`

_Read-only._

Get task details, including the task's declared blockers (upstream - what this task is waiting on) and dependents (downstream - tasks that are blocked on this one). Each entry has identifier, title, and current status. A non-empty blockers list means an automatic agent run on this task is paused until every blocker reaches a terminal status (done, cancelled). The dependents list shows which teammates' tasks will be auto-unblocked when this task is marked terminal - you do not need to @-mention them, the auto-wake handles it.

**Parameters:**

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `project` | `string` | No | Project slug or ID. Omit to use the project your run is already in; instance agents (CEO/Coach) must name the project to act in. |
| `task_id` | `string` | Yes | Task identifier or UUID |

**Returns:** The task row plus `blockers[]` (upstream) and `dependents[]` (downstream); each entry has `dependency_id`, `id`, `identifier`, `title`, `status`. Returns `null` if the task is not found.

### `create_task`

_Write tool._

Create a new task. Use parent_task_id for sub-tasks - prefer this over a top-level task whenever the new work is part of the task you are on. Sub-tasks themselves can have sub-tasks, and those one further level, but no deeper (depth is capped at 3). Use assignee_slug as alternative to assignee_id. As an agent caller, you may only assign to yourself or to your direct subordinates - to request work from anyone else (peers, your manager, or agents elsewhere in the org), use create_comment with @<agent-slug> on a relevant task instead. Use blocked_by_task_ids to declare prerequisites - the assignee will not be woken on this task until every blocker reaches a terminal status (done, cancelled). When splitting work into sequential phases, prefer create_tasks and chain the items with '#<index>' blockers instead of filing them unordered. In title/description, reference teammates with @<agent-slug>. Reference tasks and project docs by their bare identifier/filename (e.g. IN-42, spec.md), and skills by their slug - no @ prefix. Do not wrap any of these in backticks - that makes them inert.

**Parameters:**

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `project` | `string` | No | Project slug or ID. Omit to use the project your run is already in; instance agents (CEO/Coach) must name the project to act in. |
| `title` | `string` | Yes | Task title |
| `description` | `string` | No | Task description |
| `priority` | `string` | No | Priority: low, medium, high, urgent |
| `assignee_id` | `string` | No | Assignee member ID |
| `assignee_slug` | `string` | No | Assignee agent slug (alternative to assignee_id) |
| `parent_task_id` | `string` | No | Parent task to nest this under as a sub-task - a task identifier (e.g. "BE-2") or UUID. Sub-tasks can themselves have sub-tasks, and those one further level, but no deeper - depth is capped at 3. |
| `runtime_type` | `string` | No | Pin this task to a specific AI runtime (claude_code, codex, antigravity). Leave unset to use the instance default. |
| `blocked_by_task_ids` | `string[]` | No | Task identifiers (e.g. ["BE-2", "BE-3"]) or UUIDs that must reach a terminal status before this task is started. The assignee will not be woken on this task until every blocker is satisfied. |
| `goal_id` | `string` | No | UUID of the project goal this task advances. Links the task to the goal for traceability; it does not gate or change how the task runs. (Captain) set this when filing work to move a goal forward. |

**Returns:** The created task row (it may carry an advisory `warning` string, e.g. when the description backticks a Hezo reference such as an `assets/<path>` - flagged even before that asset exists). Returns `{ error }` on a validation failure.

**Authorization:** An agent caller may only assign to itself or a direct subordinate; sub-task depth is capped at 3.

### `create_tasks`

_Write tool._

Create multiple tasks in one call (max 50). Items are created in order; each has the same shape as create_task, and per-item errors are returned without aborting the rest. When the items are slices of the task you are on - delegated tracks handed to direct reports, parallel slices, phases of its deliverable - set parent_task_id on EACH item (normally your current task) so they are sub-tasks; filing them top-level detaches them and lets the parent close while they are still open. Within a batch, blocked_by_task_ids entries may reference an earlier item in the same call by zero-based index token - '#0' is the first item. To chain sequential work (e.g. implementation phases that must run one at a time), set blocked_by_task_ids: ['#<previous index>'] on every item after the first; each task then stays blocked until the one before it reaches a terminal status. Filing sequential phases WITHOUT these blockers makes all of them runnable at once. Index tokens may only point at earlier items; a token that is self-referencing, forward-referencing, or points at an item that failed errors that item. Use this when filing a related set of tasks in one go (planning a feature, splitting a task into phases or sub-tasks). For a single task, use create_task.

**Parameters:**

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `project` | `string` | No | Project slug or ID. Omit to use the project your run is already in; instance agents (CEO/Coach) must name the project to act in. |
| `items` | `object[]` | Yes | Up to 50 items. |

**Returns:** An array of per-item results: `{ ok: true, index, task }` or `{ ok: false, index, error }`. Items are created in order; a per-item failure does not abort the rest. `blocked_by_task_ids` may reference an earlier item with a `#<index>` token.

**Authorization:** Same as `create_task`; up to 50 items per call.

### `update_task`

_Write tool._

Update a task. Agents can use this to change status, update progress, set rules, and record branch names. To finish a task, set status to `done` - that is the final completed state and wakes Coach to review the task for prompt-learning (the task stays `done`). Use `cancelled` for abandoned work. Setting `done` is rejected for agent callers while the task has an @admin question no human has answered yet - keep the task `in_progress` until the admin replies. Re-opening a completed task (`done`/`cancelled`) is admin-only. As an agent caller, reassigning is limited to yourself or your direct subordinates; to hand work to a peer or manager use create_comment with @<agent-slug> instead. A run on the task blocks a reassignment only when it belongs to some other agent - your own run never blocks you, so you can hand off a task you are running, and neither does a run belonging to the agent you are assigning to. Set `parent_task_id` to move this task under a different parent, or to an empty string to promote it to a top-level task; prefer that over cancelling a mis-filed sub-task and re-filing it as a new top-level task. In description, progress_summary, and rules, reference teammates with @<agent-slug>. Reference tasks and project docs by their bare identifier/filename (e.g. IN-42, spec.md), and skills by their slug - no @ prefix. Do not wrap any of these in backticks - that makes them inert.

**Parameters:**

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `project` | `string` | No | Project slug or ID. Omit to use the project your run is already in; instance agents (CEO/Coach) must name the project to act in. |
| `task_id` | `string` | Yes | Task identifier or UUID |
| `title` | `string` | No | New title |
| `description` | `string` | No | New description |
| `status` | `string` | No | New status (backlog, in_progress, blocked, done, cancelled). `done` = completed (final); marking a task `done` wakes Coach to review it for prompt-learning but leaves it `done`. `cancelled` = abandoned. Re-opening a completed task (done/cancelled) is admin-only. |
| `priority` | `string` | No | New priority |
| `assignee_id` | `string` | No | New assignee - an agent slug (e.g. "engineer") or a member UUID |
| `progress_summary` | `string` | No | Progress summary update |
| `rules` | `string` | No | How-to-work-on guardrails for this task - approach constraints that shape execution (e.g. "run tests before committing", "consult the architect before auth changes"). Not a channel for passing project domain knowledge to other agents; put that in description instead. |
| `branch_name` | `string` | No | Git branch name for this task |
| `runtime_type` | `string` | No | Override the AI runtime for this task (claude_code, codex, antigravity). Pass an empty string to clear. |
| `parent_task_id` | `string` \| `null` | No | Move this task under a different parent - a task identifier (e.g. "BE-2") or UUID. Pass an empty string or null to promote it to a top-level task. Omit to leave the parent unchanged. The parent must be in the same project, cannot be the task itself or one of its own sub-tasks, and the whole sub-tree being moved must still fit within the depth cap of 3. An open task cannot be nested under a parent that is already done or cancelled. |

**Returns:** The updated task row (may carry a `warning` string), `{ unchanged: true }` when no fields changed, `null` if not found, or `{ error }` on a validation failure.

**Authorization:** `done` is the final completed state; marking a task `done` wakes Coach to review it but the task stays `done`. `cancelled` is for abandoned work. Agents cannot set `done` while an @admin mention on the task is unanswered by a human; human admins are exempt. Only the admin can re-open a completed (`done`/`cancelled`) task. An agent run is scoped to its own task and may reassign only to itself or a direct subordinate. A run on the task blocks a reassignment only when it belongs to some other agent: an agent can always hand off a task it is running, and a task can always move to whichever agent is already running it. A `parent_task_id` change is rejected when the new parent is in a different project, is the task itself or one of its own sub-tasks, would push the moved sub-tree past the depth cap of 3, or is already done or cancelled while the task being moved is still open. Moving a task out of its former parent wakes that parent when it was the last open sub-task, exactly as closing it would.

### `add_task_blocker`

_Write tool._

Declare that one task blocks another. The downstream task will not start an automatic agent run until the blocker reaches a terminal status (done, cancelled). Use this when you discover that a task you have been woken on depends on work that has not landed yet - declare the blocker and end your turn; the system will wake you again when the blocker resolves. Cycles are rejected.

**Parameters:**

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `project` | `string` | No | Project slug or ID. Omit to use the project your run is already in; instance agents (CEO/Coach) must name the project to act in. |
| `task_id` | `string` | Yes | Task identifier or UUID that should be blocked |
| `blocked_by_task_id` | `string` | Yes | Task identifier or UUID of the upstream blocker |

**Returns:** The dependency row (`id`, `task_id`, `blocked_by_task_id`, `created_at`). Returns `{ error }` for a self-block, an existing dependency, a missing task, or a cycle.

### `remove_task_blocker`

_Write tool._

Remove a blocker between two tasks. Call this when a dependency that was previously declared no longer applies. If removing this dependency clears the downstream task's last open blocker, its assignee is woken automatically.

**Parameters:**

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `project` | `string` | No | Project slug or ID. Omit to use the project your run is already in; instance agents (CEO/Coach) must name the project to act in. |
| `task_id` | `string` | Yes | Task identifier or UUID that is currently blocked |
| `blocked_by_task_id` | `string` | Yes | Task identifier or UUID of the blocker to remove |

**Returns:** `{ removed: true }`, or `{ error }` if the dependency or blocker is not found. Clearing the last open blocker wakes the downstream assignee.

### `list_task_runs`

_Read-only._

List the agent runs (container executions) recorded for a task, newest first. Each row is one run: which agent ran, its status and exit code, when it started/finished, the invocation command, and the log length. Metadata only - fetch a run's actual container log with get_run_log(run_id). Useful for reviewing HOW a task was worked (e.g. the Coach checking what an agent actually did, beyond the comments it left). Paged: returns `limit` rows (default 50) plus `next_cursor`/`has_more`; when `has_more` is true, call again with `cursor` set to `next_cursor` until it is false.

**Parameters:**

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `project` | `string` | No | Project slug or ID. Omit to use the project your run is already in; instance agents (CEO/Coach) must name the project to act in. |
| `task_id` | `string` | Yes | Task identifier or UUID |
| `limit` | `integer` | No | Max rows to return in this page (default 50, ceiling 200). |
| `cursor` | `string` | No | Opaque cursor from a previous call. Pass back the `next_cursor` you were given to fetch the following page; keep going until `has_more` is false. Treat it as opaque - do not construct or parse one. |

**Returns:** Run rows for the task, newest-first: `id`, `status`, `exit_code`, `started_at`, `finished_at`, `invocation_command`, `log_length` (characters), plus `agent_title`/`agent_slug`. Paged: returns `{ items, next_cursor, has_more }` - follow `next_cursor` until `has_more` is false. Metadata only - fetch a run's log with `get_run_log`.

### `get_run_log`

_Read-only._

Fetch the container log for a single agent run (a run_id from list_task_runs). Team-scoped: the run must belong to the project you're acting in. By default returns the most recent excerpt_chars characters (default 12000 - the tail, where the outcome and any errors usually are). To read a run that failed EARLY, pass offset (start at 0) and page forward with next_offset until it is null: the tail default would otherwise hide the start of the log, which is where a setup, clone, or install failure appears.

**Parameters:**

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `project` | `string` | No | Project slug or ID. Omit to use the project your run is already in; instance agents (CEO/Coach) must name the project to act in. |
| `run_id` | `string` | Yes | Run ID (UUID) from list_task_runs |
| `excerpt_chars` | `integer` | No | Max characters to return from the END of the log (default 12000). Ignored when `offset` is set. |
| `offset` | `integer` | No | Byte offset to read forward from, instead of the tail. Pass 0 to start at the beginning of the log, then pass back `next_offset` until it is null. Snapped down to a UTF-8 character boundary. |
| `max_bytes` | `integer` | No | Max bytes of log to return in this window when paging with `offset` (default and ceiling is the read budget). |

**Returns:** `{ id, status, exit_code, task_id, log, length, truncated }` for one run. By default `log` is the **tail** of the container log capped at `excerpt_chars` (default 12000), and `truncated` flags dropped earlier output. Pass `offset` (start at 0) to read forward from the beginning instead: the result then also carries `offset`, `returned_chars`, and `next_offset`, and you page until `next_offset` is null. The tail default cannot reach the start of a long log, so use `offset` for a run that failed during setup, clone, or install. Returns `{ error }` for a malformed `run_id` or a run outside the resolved project's team.

## Goals

### `suggest_goal`

_Write tool._

Suggest a project goal for the admin to approve. Callable only by the team Captain (or the CEO targeting a team via `project`). Goals come from the admin, so ask first: before suggesting anything, ask the admin what they want the project to achieve (on the planning/onboarding task or via an @admin comment), wait for their reply, and formulate each suggestion from their stated objectives - never file a suggestion the admin's own words do not support. This does NOT create a goal directly - it files a suggestion the admin reviews as an Approve/Deny card; the real goal exists only once they approve. A goal is an OUTCOME or MILESTONE the admin wants the project to achieve - a state of the world to reach, or reach and hold (e.g. "reach 10k monthly readers", "100 active customers, held"); its `measurement` judges results, never activity performance. If the candidate reads as "do X every day/week" - monitor, sweep, deliver a periodic report, keep a process running - it is NOT a goal: that is recurring operational work, filed with `create_task` as a standing task that stays open (optionally linked to a goal via `goal_id`), and so is any finite deliverable with a fixed done state - a document to produce, a one-time analysis, a feature to ship. Pass a `title`, a `measurement` (the precise definition of when it is achieved - the bar to judge against; write it SMART), optional `actions` (guidance on what to do/check when assessing it), a `check_frequency` (daily/weekly/monthly - how often the Captain re-assesses progress, not a schedule for doing work), and an optional `target_date` (deadline, ISO YYYY-MM-DD - milestones with target dates are legitimate goals). Pass `task_id` (recommended - usually your planning task) to surface the suggestion as an Approve/Deny card in that task's thread; it also appears on the project's Goals page.

**Parameters:**

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `project` | `string` | No | Project slug or ID. Omit to use the project your run is already in; instance agents (CEO/Coach) must name the project to act in. |
| `title` | `string` | Yes | Short goal title. |
| `measurement` | `string` | No | The precise, measurable definition of when the goal is achieved. |
| `actions` | `string` | No | Optional guidance on what the Captain should do or check when assessing the goal. |
| `check_frequency` | `daily` \| `weekly` \| `monthly` | No | How often the goal is re-assessed once created (default daily). This is the Captain's re-assessment cadence, not a schedule for doing work: pick by how often the measurement meaningfully changes - daily for fast-moving measurements, weekly for steady ones, monthly for slow-moving outcomes. Checks recur indefinitely - this is a cadence, not a deadline. |
| `target_date` | `string` | No | Optional deadline as an ISO date (YYYY-MM-DD). |
| `task_id` | `string` | No | Optional originating task to attach the suggestion card to - a task identifier (e.g. "HM-1") or UUID. |

**Returns:** `{ approval_id, status: "pending", payload }`. Files a goal *suggestion* the admin must approve - no goal exists until then. On approval the real goal is created and appears on the Goals page. Surfaces as an Approve/Deny card on the `task_id` thread (when given) and on the project Goals page. Returns `{ error }` if the caller is not the Captain/CEO, the project is HQ/internal, or the inputs are invalid.

**Authorization:** Captain (its own team) or CEO (any team via `project`), and only from within an agent run.

### `list_goals`

_Read-only._

List a project's goals (the objectives the Captain tracks). Each goal has a title, a `measurement` (the precise definition of when the goal is achieved - the bar to judge against), optional `actions` (admin guidance on what to do/check toward it), the Captain's current progress_percent (0-100), a health (pending/on_track/at_risk/off_track), a status_blurb, a check_frequency (daily/weekly/monthly), an optional target_date (deadline), and last_checked_at. As the Captain, call this during your heartbeat to see which goals are due for a fresh assessment, then call update_goal_progress for each. Archived goals are excluded unless include_archived is true.

**Parameters:**

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `project` | `string` | No | Project slug or ID. Omit to use the project your run is already in; instance agents (CEO/Coach) must name the project to act in. |
| `include_archived` | `boolean` | No | Include archived goals (default false). |
| `limit` | `integer` | No | Max rows to return in this page (default 50, ceiling 200). |
| `cursor` | `string` | No | Opaque cursor from a previous call. Pass back the `next_cursor` you were given to fetch the following page; keep going until `has_more` is false. Treat it as opaque - do not construct or parse one. |

**Returns:** An array of the project's goal rows, each with `project_name`/`project_slug` and an embedded `history[]` of recent progress snapshots (`{ t, percent, health }`). Archived goals are excluded unless `include_archived` is true.

### `update_goal_progress`

_Write tool._

Record your current assessment of a goal's progress. Only the Captain does this, and only from within a progress-update run. Pass progress_percent (0-100, your honest estimate - do not lower it without a reason in the blurb), health (on_track / at_risk / off_track, weighing progress against the target_date), and a one-paragraph status_blurb explaining where the goal stands and what is needed next. This updates the goal's live status and appends a point to its progress history; the goal then won't be re-surfaced for checking until its cadence elapses again. Reaching 100 does not end tracking: the goal stays on its cadence forever (progress can later drop back below 100, and some goals are never-ending, measured continuously), so keep recording your honest current assessment on every check.

**Parameters:**

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `project` | `string` | No | Project slug or ID. Omit to use the project your run is already in; instance agents (CEO/Coach) must name the project to act in. |
| `goal_id` | `string` | Yes | UUID of the goal to update. |
| `progress_percent` | `integer` | Yes | Estimated progress toward the goal, 0-100. |
| `health` | `on_track` \| `at_risk` \| `off_track` | Yes | on_track, at_risk, or off_track. |
| `status_blurb` | `string` | Yes | One-paragraph summary of where the goal stands and the next step. |

**Returns:** The updated goal row (with the new `progress_percent`, `health`, `status_blurb`, and a refreshed `last_checked_at`). Appends a point to the goal’s progress history keyed to the calling run. Returns `{ error }` if the goal is not in the project or the inputs are invalid.

**Authorization:** Captain only, and only from within a progress-update agent run (the run records the history point).

## Comments & reactions

### `get_comment`

_Read-only._

Read one comment in full by its id (the UUID from a list_comments row, or its public_id slug). list_comments returns long text comments as excerpts capped at `excerpt_chars`; this is the single-item read that serves the whole body, so reach for it whenever a row comes back with `text_truncated: true`. Very long comments come back one byte-window at a time: when `truncated` is true, call again with `offset` set to the returned `next_offset` and keep going until `next_offset` is null. Structured comments (system/option/task_link) are returned whole.

**Parameters:**

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `project` | `string` | No | Project slug or ID. Omit to use the project your run is already in; instance agents (CEO/Coach) must name the project to act in. |
| `comment_id` | `string` | Yes | Comment UUID or public_id (e.g. "20261009112345"). Both forms from a list_comments row work. |
| `offset` | `integer` | No | Byte offset to start reading the comment text from (default 0). To page a comment too large for one read, pass back the `next_offset` from the previous call. Snapped down to a UTF-8 character boundary so a window never begins mid-character. |
| `max_bytes` | `integer` | No | Max bytes of comment text to return in this window (default and ceiling is the read budget, so a normal-size comment comes back whole). Clamped to the budget; the returned slice ends on a UTF-8 character boundary, so it can come back a few bytes short. |

**Returns:** One comment row in the same shape `list_comments` returns (plus `task_identifier`), with the body served whole rather than excerpted. For a text comment the result also carries a byte window - `offset`, `returned_bytes`, `total_bytes`, `next_offset`, `truncated` - and the windowed text sits in `content.text`; when `truncated` is true, call again with `offset` set to `next_offset` until `next_offset` is null. Structured comments (system/option/task_link) are returned whole with no window. Accepts either the comment UUID or its `public_id`. Returns `{ error }` if no such comment exists in the project.

**Authorization:** Scoped to the caller's project: a comment is only readable through the project whose team owns its task, the same boundary `list_comments` enforces.

### `list_comments`

_Read-only._

List comments for a task, newest first. Returns the conversation and the task's own changes by default and leaves out the one-row-per-execution agent run markers - pass `categories` to change that, and prefer `list_task_runs`, which reports each run's status, exit code and log length rather than a bare marker. To catch up rather than re-read, pass `since` with the timestamp your last read ended at; a run prompt gives you the time of your previous run on the task. Paged: returns `limit` rows (default 50) plus `next_cursor`/`has_more`; when `has_more` is true, call again with `cursor` set to `next_cursor` until it is false. (`before`, taking a comment id or public_id, still works for walking back from a known comment.) Long text comments come back truncated at `excerpt_chars` (default 2000, narrowed to whatever a page of `limit` rows can carry and reported as `excerpt_chars_applied`); structured comments (system/option/task_link) are always returned whole. A truncated row sets `text_truncated: true` alongside `text_length` and a `text_paging_hint` naming the exact follow-up call - the excerpt sits in `content.text`, the same field a whole comment uses, so check `text_truncated` before treating what you got as the entire comment. Read the full body with `get_comment`; raising `excerpt_chars` is not the intended recovery path. Each row includes parent_comment_id (UUID or null) so you can see reply threading - when you reply substantively to a comment, pass that comment's id back as parent_comment_id in create_comment. Each row also has a public_id (a creation-timestamp slug like 20261009112345); that's how you cite a specific comment elsewhere: write a comment link as <TASK-ID>#comment-<public_id> (e.g. IN-42#comment-20261009112345), which renders as a clickable link straight to that comment. A `run` row also carries `run_status` - how that run actually ended - because the row itself is written when the run starts and the failure notices beside it are not written for every failure.

**Parameters:**

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `project` | `string` | No | Project slug or ID. Omit to use the project your run is already in; instance agents (CEO/Coach) must name the project to act in. |
| `task_id` | `string` | Yes | Task identifier or UUID |
| `before` | `string` | No | A comment id (UUID) or public_id - return only comments created before that one. Prefer `cursor` for straight paging; this is for resuming from a comment you already know. |
| `excerpt_chars` | `integer` | No | Cap for content.text on text-typed comments, with text_truncated/text_length companions (default 2000, ceiling 4000). Narrowed further when a page of `limit` rows could not otherwise fit; the value used comes back as `excerpt_chars_applied`. |
| `categories` | `string[]` | No | Which kinds of row to return. `conversation` is what people and agents wrote plus anything awaiting a person (credential requests, approvals); `events` is the task's own machinery - status, assignee, title and parent changes, task links and run-failure notices; `runs` is one marker per agent execution. Defaults to ["conversation","events"], because run markers are the bulk of a long thread and say nothing the thread does not. |
| `since` | `string` | No | ISO-8601 timestamp. Return only comments created strictly after it, newest first. Use this to read what is new instead of walking a thread you have already read. |
| `limit` | `integer` | No | Max rows to return in this page (default 50, ceiling 200). |
| `cursor` | `string` | No | Opaque cursor from a previous call. Pass back the `next_cursor` you were given to fetch the following page; keep going until `has_more` is false. Treat it as opaque - do not construct or parse one. |

**Returns:** Comment rows newest-first, each with `id`, `public_id`, `task_id`, `author_member_id`, `author_api_key_id`, `parent_comment_id`, `content_type`, `content`, `chosen_option`, `created_at`, `author_type`, `author_name`, `reactions[]`, and `attachments[]`. A `run` row carries `run_status` as well (`queued`, `running`, `succeeded`, `failed`, `cancelled` or `timed_out`, or null when the run no longer exists) - the row is written when the run starts, so its `content` cannot say how the run ended. `categories_applied` echoes which kinds of row the page holds: `conversation` (what people and agents wrote, plus anything awaiting a person), `events` (status, assignee, title and parent changes, task links, run-failure notices) and `runs` (one marker per agent execution). The default is `["conversation","events"]`, leaving run markers out - they are the bulk of a long thread, and `list_task_runs` reports the same executions with their outcome attached. Pass `since` with an ISO-8601 timestamp to read only what is newer. Paged: returns `{ items, next_cursor, has_more }` - follow `next_cursor` until `has_more` is false. `before` still walks back from a comment you already know. Text comments come back truncated at `excerpt_chars` (default 2000, ceiling 4000), with `text_truncated`/`text_length` companions and a `text_paging_hint` naming the follow-up call; `excerpt_chars_applied` reports the width actually used, narrowed when a page of `limit` rows could not otherwise fit the result cap. The excerpt is written into `content.text`, the same field a whole comment uses, so check `text_truncated` before treating what you got as the entire comment; read the full body with `get_comment`.

### `add_reaction`

_Write tool._

React to a comment without waking its author. Use this to acknowledge mentions or signal "seen / picked up" without forcing the original commenter to run again. Prefer this over a follow-up create_comment when you have nothing substantive to add - comments wake the author, reactions do not. Only react when the situation calls for it: a clean handoff to your own new task (✓ on the mention), or a brief acknowledgement that a request landed. If you need the original commenter to read something, post a comment instead.

**Parameters:**

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `project` | `string` | No | Project slug or ID. Omit to use the project your run is already in; instance agents (CEO/Coach) must name the project to act in. |
| `task_id` | `string` | Yes | Task identifier or UUID the comment belongs to |
| `comment_id` | `string (uuid)` | Yes | UUID of the comment to react to, as returned by list_comments. Sentinels like "last" / "latest" are not supported - you must pass an explicit UUID. |
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
| `comment_id` | `string (uuid)` | Yes | UUID of the comment to remove the reaction from, as returned by list_comments. Sentinels like "last" / "latest" are not supported - you must pass an explicit UUID. |
| `kind` | `ack` | Yes | Reaction kind. v1 supports: ack |

**Returns:** `{ comment_id, kind, reactions[] }`, or `{ error }` if the reaction is not found.

### `create_comment`

_Write tool._

Add a comment to a task. In content, reference teammates with @<agent-slug>. Reference tasks and project docs by their bare identifier/filename (e.g. IN-42, spec.md), and skills by their slug - no @ prefix. Do not wrap any of these in backticks - that makes them inert. To point at a specific earlier comment (in this task or another), write a comment link as <TASK-ID>#comment-<public_id> (e.g. IN-42#comment-20261009112345) using a comment public_id from list_comments - do not paraphrase "the comment above". When your comment is a direct response to a specific earlier one (answering a question, confirming/pushing back on a request, providing the follow-up that was asked for) ALWAYS set parent_comment_id to that comment's UUID - it wakes the original author with source=reply (so they're notified the conversation moved forward) and shows "replying to ..." threading in the UI so other readers can follow the dialogue. Skip parent_comment_id only when the comment is genuinely standalone (a new observation, an unrelated update). If you only need to acknowledge a mention without adding substance, use add_reaction instead.

**Parameters:**

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `project` | `string` | No | Project slug or ID. Omit to use the project your run is already in; instance agents (CEO/Coach) must name the project to act in. |
| `task_id` | `string` | Yes | Task identifier or UUID |
| `content` | `string` | Yes | Comment text |
| `parent_comment_id` | `string` | No | The comment you are replying to - its id (UUID) or its public_id. Setting this wakes that comment's author with source=reply and renders this comment as "replying to ..." in the UI. |

**Returns:** The created comment row (`id`, `public_id`, `created_at`, …), always with a `wake` receipt and optionally with an advisory `warning` string. `wake.woke` lists the teammate slugs the comment actually notified (an active `@slug`, `admin` for the admin inbox fan-out, or the reply target); `wake.named_not_woken` lists roster teammates the text names without notifying them - a passive `@@slug`, or a bare or bold name. Returns `{ error }` if `parent_comment_id` does not belong to the task. Setting `parent_comment_id` wakes the parent comment's author.

### `update_comment`

_Write tool._

Edit the text of a comment you posted earlier in THIS run - use it to fix a mistake (a typo, a broken reference, wrong markdown) instead of posting a correction as a new comment. You can only edit a text comment authored by your current run; comments from earlier runs, other agents, or humans are not editable. Editing re-runs the same notification side effects create_comment does, but idempotently: a teammate already notified by this comment is not woken again, while a mention you ADD in the edit (e.g. a bare @<agent-slug> that replaces a backticked, inert one) wakes that teammate for the first time - so fixing a missed mention by editing works. Same reference rules as create_comment: reference tasks and project docs by their bare identifier/filename, teammates with @<agent-slug>, skills by their slug, and never wrap any of these in backticks.

**Parameters:**

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `project` | `string` | No | Project slug or ID. Omit to use the project your run is already in; instance agents (CEO/Coach) must name the project to act in. |
| `task_id` | `string` | Yes | Task identifier or UUID the comment belongs to |
| `comment_id` | `string (uuid)` | Yes | UUID of the comment to edit, as returned by create_comment or list_comments. |
| `content` | `string` | Yes | The replacement comment text (overwrites the existing body). |

**Returns:** The updated comment row, always with a `wake` receipt (same shape as `create_comment`) and optionally with an advisory `warning` string. Returns `{ error }` if the comment is not a text comment the caller authored during the current run. Re-runs create-time side effects (mention/reply wakeups, task links) idempotently, so only references the edit newly introduces notify anyone.

**Authorization:** An agent editing a text comment its own current run authored. Comments from earlier runs, other agents, or humans are not editable.

## Agents & hiring

### `list_agents`

_Read-only._

List the agents on a project's team, by title. Each row carries `reports_to` (the manager's member ID, null when unset) plus `reports_to_slug`/`reports_to_title` - this is the structural reporting line that gates delegation, so it is what to read when auditing the org chart for orphans (`reports_to` null) or cycles. Do NOT infer reporting lines from an agent's team_context prose: that prose is a rendered description which can itself be stale, and is exactly what a coherence review is meant to check against this field. Paged: returns `limit` rows (default 50) plus `next_cursor`/`has_more`; when `has_more` is true, call again with `cursor` set to `next_cursor` until it is false.

**Parameters:**

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `project` | `string` | No | Project slug or ID. Omit to use the project your run is already in; instance agents (CEO/Coach) must name the project to act in. |
| `limit` | `integer` | No | Max rows to return in this page (default 50, ceiling 200). |
| `cursor` | `string` | No | Opaque cursor from a previous call. Pass back the `next_cursor` you were given to fetch the following page; keep going until `has_more` is false. Treat it as opaque - do not construct or parse one. |

**Returns:** Agent rows (`id`, `agent_type_id`, `title`, `slug`, `daily_budget_cents`, `weekly_budget_cents`, `monthly_budget_cents`, `runtime_status`, `admin_status`) ordered by title, each with `reports_to` (manager member ID, null when unset) plus `reports_to_slug`/`reports_to_title`. `reports_to` is the structural line that gates delegation, so it is the field to audit for orphans and cycles - not an agent’s team_context prose, which is a rendered description that can itself be stale. Paged: returns `{ items, next_cursor, has_more }` - follow `next_cursor` until `has_more` is false.

### `update_hire_proposal`

_Write tool._

Revise the draft of a pending hire approval. Captain-only. Use this to expand or rewrite the system prompt, adjust role description, budget, heartbeat, or touches_code before admin review. All fields are optional - pass only what you want to change.

**Parameters:**

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `approval_id` | `string` | Yes | Hire approval ID |
| `title` | `string` | No | Updated role title |
| `human_name` | `string` | No | Updated human name for the new teammate, or an empty string to clear it |
| `role_description` | `string` | No | Updated short role description |
| `system_prompt` | `string` | No | Updated system prompt. No substitution variable is required: Hezo composes the agent identity above this body and the live skills, preferences and project-docs context below it, adding only what the body does not already name. |
| `reports_to` | `string` | No | Updated manager - an existing agent's slug. Pass an empty string to clear the reporting line. |
| `default_effort` | `string` | No | Updated default effort: minimal, low, medium, high, max |
| `heartbeat_interval_min` | `integer` | No | Updated heartbeat interval. How often this agent wakes to look for work, in minutes. Ask the admin for the cadence rather than assuming one - it drives both how fast the agent picks up work and how much it spends. Minimum 60; a lower value is rejected. Typical choices: 60 for a fast-moving role, 720 (12 hours) for a steady one, 1440 (daily) for an occasional reviewer. |
| `monthly_budget_cents` | `number` | No | Updated monthly budget in cents |
| `touches_code` | `boolean` | No | Whether this agent reads/writes repo code |

**Returns:** The updated approval row, or `{ error }` if no field changed or the approval is invalid.

**Authorization:** Captain only; the approval must be a pending hire request on the Captain's team.

### `create_hire_proposal`

_Write tool._

File a new hire proposal. Callable by a team Captain (for its own team) or the CEO (for any team - pass `project` to target it, including HQ). Use this when directed or deciding to staff or expand a team: author the full role spec - title, role description, and a complete system prompt - and submit it. The proposal surfaces as a pending approval in the admin inbox; the admin reviews, may modify it, and approves, at which point the agent is created automatically. Pass task_id to link the proposal back to the task that prompted it.

**Parameters:**

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `project` | `string` | No | Project slug or ID. Omit to use the project your run is already in; instance agents (CEO/Coach) must name the project to act in. |
| `title` | `string` | Yes | Role title (the slug is derived from it) |
| `human_name` | `string` | No | Optional human name for the new teammate (e.g. "Max"). Shown in place of the role and usable as a mention handle. Leave it out unless the admin asked for a name - an agent is normally addressed by its role. |
| `role_description` | `string` | No | Short role description |
| `system_prompt` | `string` | No | Full system prompt for the new agent. Write the role itself; no substitution variable is required. Hezo composes the agent identity (team, description, manager) above this body and the live skills, preferences and project-docs context below it, adding only what the body does not already name. Author it in the style of the built-in role docs. |
| `reports_to` | `string` | No | The manager this agent reports to - an existing agent's slug (e.g. "architect"). Sets the structural reporting line so work can be delegated to and from this agent. Must be an agent already on the team. |
| `default_effort` | `string` | No | Default reasoning effort: minimal, low, medium, high, max |
| `heartbeat_interval_min` | `integer` | Yes | How often this agent wakes to look for work, in minutes. Ask the admin for the cadence rather than assuming one - it drives both how fast the agent picks up work and how much it spends. Minimum 60; a lower value is rejected. Typical choices: 60 for a fast-moving role, 720 (12 hours) for a steady one, 1440 (daily) for an occasional reviewer. |
| `daily_budget_cents` | `number` | No | Daily budget in cents |
| `weekly_budget_cents` | `number` | No | Weekly budget in cents |
| `monthly_budget_cents` | `number` | No | Monthly budget in cents |
| `touches_code` | `boolean` | No | Whether this agent reads/writes repo code |
| `task_id` | `string` | No | Optional originating task to link the proposal to - a task identifier (e.g. "HM-1") or UUID |

**Returns:** `{ approval_id, status, payload }` for the new pending hire approval, or `{ error }` if the spec is rejected (missing title, invalid effort/budget, reserved or duplicate slug, or an unknown `task_id`).

**Authorization:** A team Captain (for its own team) or the CEO (for any team - pass `project`, including HQ). The proposal surfaces as a pending approval for the admin.

### `report_no_work`

_Read-only._

Declare that, after evaluating the current task this run, there is genuinely nothing to do - no comment, sub-task, status change, code change, or other action is warranted. Records the run as an intentional no-op so it is NOT flagged as a failed empty run, and is the correct, auditable way to end such a turn (preferred over posting a redundant "nothing to do" comment). Use ONLY when you have truly concluded no action is needed this turn - never to skip, defer, or avoid real work.

**Parameters:**

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `reason` | `string` | Yes | One-line explanation of why there is nothing to do this run. |

**Returns:** `{ ok: true }`, or `{ error }` outside an agent run. Records the run as an intentional no-op so it is not flagged as a failed empty run.

**Authorization:** Available only within an agent run (requires a run identity).

### `set_agent_reports_to`

_Write tool._

Set or change the manager an agent reports to - the structural reporting line in the org chart that gates delegation. Work can only be assigned to/from an agent along this line, so an agent whose manager is unset can't be delegated to or hand work down. Use this to wire up reporting structure (e.g. after hiring specialists, point them at their lead) or fix it during a coherence review. Pass the target agent and its new manager (both by slug or member ID); pass an empty reports_to to clear the line. Callable by the team's Captain or an HQ instance agent (CEO/Coach) acting in the team. The Captain, CEO, and Coach have fixed reporting lines (Captain → CEO; CEO/Coach → admin) that cannot be changed.

**Parameters:**

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `project` | `string` | No | Project slug or ID. Omit to use the project your run is already in; instance agents (CEO/Coach) must name the project to act in. |
| `agent_id` | `string` | Yes | Target agent - its slug (e.g. "engineer") or member ID |
| `reports_to` | `string` | Yes | The new manager - an existing agent's slug (or member ID) on this team. Pass an empty string to clear the reporting line. |

**Returns:** `{ applied: true, agent, reports_to }` (`reports_to` is null when cleared), or `{ error }` if the agent/manager is not in the team, the target is the Captain/CEO/Coach (whose reporting lines are fixed), the manager is the agent itself, or the link would create a reporting cycle.

**Authorization:** The team's Captain, or an HQ instance agent (CEO/Coach) acting in the team.

### `set_agent_status`

_Write tool._

Retire (disable) or reinstate (enable) an agent on a project's team. Callable by the team's Captain or by the CEO running in the team. Disabling stops the agent from being scheduled and unassigns it from every open task; enabling resumes scheduling. The change is fully reversible and preserves all of the agent's history, so this is the right way to remove a role the team no longer needs (e.g. after a coherence review). The Captain and the instance agents (CEO/Coach) cannot be disabled this way. Confirm with the admin before retiring an agent.

**Parameters:**

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `project` | `string` | No | Project slug or ID. Omit to use the project your run is already in; instance agents (CEO/Coach) must name the project to act in. |
| `agent` | `string` | Yes | Target agent - its slug (e.g. "engineer") or member ID. Must be a member of this project's team. |
| `status` | `enabled` \| `disabled` | Yes | "disabled" retires the agent; "enabled" reinstates it. |

**Returns:** `{ updated: true, agent_id, slug, admin_status }`, or `{ error }`. Disabling unassigns the agent from every open task; the change is reversible.

**Authorization:** The team's Captain or the CEO. The Captain, CEO, and Coach roles cannot be disabled with this tool.

## Agent prompts & context

### `get_agent_system_prompt`

_Read-only._

Read an agent's system prompt. Accessible by any agent or the admin in the same team. Returns the resolved role doc by default - `{{…}}` placeholders substituted with the real team name, manager, skills, project docs, and team context - so you can see what the agent actually says about itself with real values. Pass placeholders=false to get the raw stored template with `{{…}}` placeholders intact; only do this when you intend to edit the prompt and need a safe round-trip back through update_agent_system_prompt. A prompt too large for one read comes back as a byte window: when `next_offset` is non-null, call again with `offset` set to it until it is null. To read several prompts, use get_agent_system_prompts rather than looping this tool.

**Parameters:**

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `project` | `string` | No | Project slug or ID. Omit to use the project your run is already in; instance agents (CEO/Coach) must name the project to act in. |
| `agent_id` | `string` | Yes | Target agent - its slug (e.g. "engineer") or member ID |
| `placeholders` | `boolean` | No | When true (default) substitutes `{{…}}` placeholders with real team/team values. When false returns the raw stored template - needed when reading before update_agent_system_prompt so placeholders survive the round-trip. |
| `offset` | `integer` | No | Byte offset to start reading the prompt from (default 0). Pass back `next_offset` to page a prompt too large for one read. Snapped down to a UTF-8 character boundary. |
| `max_bytes` | `integer` | No | Max bytes of prompt text to return in this window (default and ceiling is the read budget, so a normal-size prompt comes back whole). |

**Returns:** `{ title, slug, system_prompt, offset, returned_bytes, total_bytes, next_offset, truncated }`, or `{ error }` if the agent is not in the team. By default `{{…}}` placeholders are resolved; pass `placeholders: false` for the raw stored template. A prompt larger than the cap comes back as a byte window - page it with `offset` until `next_offset` is null.

**Authorization:** Any agent or the admin in the same team.

### `get_agent_system_prompts`

_Read-only._

Read multiple agent system prompts in one call (max 50). Per-item `mode` chooses the resolution depth: `placeholders` (default) substitutes `{{…}}` with real values and stops, matching get_agent_system_prompt's default; `preview` additionally appends the resolver's runtime blocks (Project State, Team Context, Teammates, Working Guidelines) minus the per-run Run Context, matching the web UI's preview panel; `raw` returns the stored template untouched. Use this to compare prompts across the team in one round-trip - e.g. Captain auditing how team_context renders for every agent. PAGING: batch as many items as you like in any mode. The result carries as many prompts as fit under the cap plus `next_index`; when it is non-null, call again with the SAME `items` and `start_index` set to it, and repeat until it is null. Do not split the roster into single-item calls. For one prompt, use get_agent_system_prompt.

**Parameters:**

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `project` | `string` | No | Project slug or ID. Omit to use the project your run is already in; instance agents (CEO/Coach) must name the project to act in. |
| `items` | `object[]` | Yes | Up to 50 items. |
| `start_index` | `integer` | No | Index into `items` to resume from (default 0). Pass back the `next_index` from the previous call, with the same `items`, to fetch the prompts that did not fit. |

**Returns:** `{ items, start_index, returned, total, next_index }`, where `items` are per-item results: `{ index, ok: true, title, slug, system_prompt }` or `{ index, ok: false, agent_id, error }`. Up to 50 items per call; each `mode` is `placeholders` (default), `preview`, or `raw`. Only the prompts that fit under the cap are returned - when `next_index` is non-null, call again with the same `items` and `start_index` set to it, and repeat until it is null. A single prompt too large on its own comes back truncated with `truncated: true` rather than stalling the cursor.

**Authorization:** Any agent or the admin in the same team.

### `update_agent_system_prompt`

_Write tool._

Apply a system prompt change for an agent. Callable by the Coach agent (for after-task learned-rules updates), the CEO (during cross-project coherence, from anywhere including its live chat), or the Captain of the same team (during team-coherence reviews). The change is applied immediately and a revision snapshot is stored so the admin can restore previous versions.

**Parameters:**

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `project` | `string` | No | Project slug or ID. Omit to use the project your run is already in; instance agents (CEO/Coach) must name the project to act in. |
| `agent_id` | `string` | Yes | Target agent - its slug (e.g. "engineer") or member ID |
| `new_system_prompt` | `string` | Yes | The full updated system prompt. No substitution variable is required: Hezo composes the agent identity above this body and the live skills, preferences and project-docs context below it, adding only what the body does not already name. Read the current prompt with get_agent_system_prompt(placeholders=false) first so the round-trip is safe. |
| `change_summary` | `string` | Yes | Summary of what changed and why |

**Returns:** `{ applied: true, document_id }`, or `{ error }` if denied or the agent is not in the team. A revision snapshot is stored so the admin can restore previous versions, and a team-coherence review is filed.

**Authorization:** The CEO, the Coach, or the team's Captain.

### `update_agent_system_prompts`

_Write tool._

Apply system prompt changes to MULTIPLE agents in one call - the preferred way when a review touches several agents at once (e.g. the Coach applying learned rules across everyone in a feedback loop). Same callers and rules as update_agent_system_prompt (the CEO, the Coach, or the team's Captain); each change is applied immediately with its own revision snapshot. Files a SINGLE team-coherence review that summarises all the updates, so the Captain/CEO can account for them together. Prefer this over calling update_agent_system_prompt in a loop. Up to 50 at once.

**Parameters:**

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `project` | `string` | No | Project slug or ID. Omit to use the project your run is already in; instance agents (CEO/Coach) must name the project to act in. |
| `updates` | `object[]` | Yes | Up to 50 prompt updates. |

**Returns:** Batch form - `{ results, applied_count }`, where `results` is a per-item array (`{ index, agent_id, slug, ok: true, document_id }` or `{ index, agent_id, ok: false, error }`). Each applied change stores its own revision, and a SINGLE team-coherence review is filed summarising all of them. Up to 50 updates per call; prefer this over calling update_agent_system_prompt in a loop.

**Authorization:** The CEO, the Coach, or the team's Captain.

### `get_project_custom_prompt`

_Read-only._

Read this project's Custom Prompt - the project-wide instruction block (the project context / "preferences") that is injected verbatim into every agent's system prompt in this project. Returns the current content plus its length and last-updated time (empty content when none is set yet). Read this before update_project_custom_prompt so you extend the existing guidance rather than overwrite it.

**Parameters:**

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `project` | `string` | No | Project slug or ID. Omit to use the project your run is already in; instance agents (CEO/Coach) must name the project to act in. |

**Returns:** `{ content, length, updated_at }` - the project's Custom Prompt (the project-wide instruction block injected verbatim into every agent's system prompt in the project). `content` is empty when none is set yet.

### `update_project_custom_prompt`

_Write tool._

Replace this project's Custom Prompt - the project-wide instruction block (the project context / "preferences") injected verbatim into every agent's system prompt in this project. Reach for this when guidance should apply to ALL of the project's agents from the very start of every run (a shared convention, standard, or fact) - it saves editing each agent's prompt one by one. This sends the WHOLE value and replaces it, so prefer edit_project_custom_prompt for any change to existing guidance - it sends only the span you are changing, so one bad rewrite cannot drop conventions you meant to keep. Reach for this tool to author the first version, or to restructure the whole thing deliberately; when you do, call get_project_custom_prompt first and extend what is there. Applied immediately; a revision snapshot is stored so the admin can restore previous versions. Only callable by the CEO, Coach, or the project's Captain.

**Parameters:**

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `project` | `string` | No | Project slug or ID. Omit to use the project your run is already in; instance agents (CEO/Coach) must name the project to act in. |
| `content` | `string` | Yes | The full new Custom Prompt content (Markdown). Replaces the current value entirely - include the existing guidance you want to keep. |
| `change_summary` | `string` | No | Short summary of what changed and why (stored on the revision). |

**Returns:** `{ applied: true, document_id, length }`, or `{ error }` if denied. Replaces the project Custom Prompt wholesale - prefer edit_project_custom_prompt to change part of it, so a rewrite cannot drop guidance you meant to keep. A revision snapshot is stored so the admin can restore previous versions, and a content change files a team-coherence review so it is reviewed against the roster.

**Authorization:** The CEO, the Coach, or the team's Captain.

### `edit_project_custom_prompt`

_Write tool._

Replace one span of this project's Custom Prompt, leaving the rest untouched. Prefer this over update_project_custom_prompt for any change to existing guidance: it sends only the text you are changing, so a rewrite cannot silently drop a convention you meant to keep, and the argument stays proportional to the edit rather than to the whole prompt. `old_string` must match the current text EXACTLY, including indentation and line breaks: call get_project_custom_prompt first and copy the span verbatim rather than retyping it. It must also be unique - if it matches several places the call is refused, so extend it with surrounding lines until it is unique, or pass replace_all to change every match. The result returns the applied hunk with surrounding context plus the new length, so you can confirm what landed without reading it back. Records a revision, and files a team-coherence review when the content really changed. Only callable by the CEO, Coach, or the project's Captain.

**Parameters:**

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `project` | `string` | No | Project slug or ID. Omit to use the project your run is already in; instance agents (CEO/Coach) must name the project to act in. |
| `old_string` | `string` | Yes | The exact text to replace, copied verbatim from the Custom Prompt (including indentation and line breaks). Must be unique unless replace_all is set. |
| `new_string` | `string` | Yes | The text to put in its place. May be empty to delete the span. |
| `replace_all` | `boolean` | No | Replace every occurrence of `old_string` rather than requiring it to be unique. Use for a rename that legitimately recurs; otherwise prefer extending `old_string` so the edit is unambiguous. |
| `change_summary` | `string` | No | Short summary of what changed and why (stored on the revision). |

**Returns:** `{ edited: true, document_id, replacements, length, hunk }` - `hunk` is the applied change with surrounding context and `length` the new size, so you can confirm what landed without reading the Custom Prompt back. Returns `{ error }` if there is no Custom Prompt yet (author the first version with update_project_custom_prompt), or if `old_string` is absent, unchanged, or matches more than one place without `replace_all` - the ambiguous case is refused rather than guessing which match you meant. Prefer this over update_project_custom_prompt for any change to existing guidance: the argument scales with the edit rather than the whole prompt, so a rewrite cannot silently drop a convention. Records a revision and files a team-coherence review on a real change, exactly as a full replace does.

**Authorization:** The CEO, the Coach, or the team's Captain.

### `set_agent_summary`

_Write tool._

Save a short human-readable summary for an agent (≤1000 chars, single paragraph, plain prose). Callable by any agent in the same team or any the admin; the Captain is the expected caller, but agents may also self-summarise.

**Parameters:**

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `project` | `string` | No | Project slug or ID. Omit to use the project your run is already in; instance agents (CEO/Coach) must name the project to act in. |
| `agent_id` | `string` | Yes | Target agent - its slug (e.g. "engineer") or member ID |
| `summary` | `string` | Yes | The new summary, ≤1000 chars |

**Returns:** `{ updated: true }`, or `{ error }` (summary empty, over 1000 chars, or agent not in team).

**Authorization:** Any agent or the admin in the same team (the Captain is the expected caller; agents may self-summarise).

### `set_agent_name`

_Write tool._

Give an agent the human name it is addressed by (e.g. "Max" for the Engineer), or clear it with an empty string to fall back to its role. The name displays in place of the role everywhere and becomes a second mention handle, so both @max and @engineer reach the agent. Names must be unique within the team, and the Captain, CEO and Coach are always addressed by role and cannot be named. Callable by the Captain of that team, or the CEO.

**Parameters:**

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `project` | `string` | No | Project slug or ID. Omit to use the project your run is already in; instance agents (CEO/Coach) must name the project to act in. |
| `agent_id` | `string` | Yes | Target agent - its slug (e.g. "engineer") or member ID |
| `name` | `string` | Yes | The name to use, or an empty string to clear it |

**Returns:** `{ updated: true, name }` where `name` is the stored name or null when cleared, or `{ error }` (name taken, reserved, malformed, a name-only role, or agent not in team).

**Authorization:** The Captain of that team, or the CEO.

### `generate_agent_avatar`

_Write tool._

Generate a fresh pixel avatar for an agent. The face is composed from the agent's role and name, so there is nothing to choose beyond asking for a new one; call it again for a different face. Use it for a newly hired agent, or one that still has no avatar. Callable by the Captain of that team, or the CEO.

**Parameters:**

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `project` | `string` | No | Project slug or ID. Omit to use the project your run is already in; instance agents (CEO/Coach) must name the project to act in. |
| `agent_id` | `string` | Yes | Target agent - its slug (e.g. "engineer") or member ID |

**Returns:** `{ updated: true }`, or `{ error }` (agent not in team).

**Authorization:** The Captain of that team, or the CEO.

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
| `agent_id` | `string` | Yes | Target agent - its slug (e.g. "engineer") or member ID |
| `content` | `string` | Yes | The new team_context, ≤6000 chars |

**Returns:** `{ updated: true }`, or `{ error }` (content empty, over 6000 chars, or agent not in team).

**Authorization:** The team's Captain only.

### `set_agent_team_contexts`

_Write tool._

Save team-relationships contexts for MULTIPLE agents in one call (max 50) - the preferred way during a coherence review, which rewrites every affected agent's context together. Same rules and caller as set_agent_team_context (the Captain of the same team); each content is ≤6000 chars of plain second-person prose. Returns a per-item result so one bad agent_id does not lose the rest of the batch. Prefer this over calling set_agent_team_context in a loop.

**Parameters:**

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `project` | `string` | No | Project slug or ID. Omit to use the project your run is already in; instance agents (CEO/Coach) must name the project to act in. |
| `updates` | `object[]` | Yes | Up to 50 context updates. |

**Returns:** `{ items, updated, total }`, where `items` are per-item results: `{ index, agent_id, slug, ok: true }` or `{ index, agent_id, ok: false, error }`. A bad agent_id fails only its own item; the rest of the batch still applies.

**Authorization:** The team's Captain only.

### `set_agent_summaries`

_Write tool._

Save short human-readable summaries for MULTIPLE agents in one call (max 50) - the preferred way during a coherence review, which rewrites every affected agent's summary together. Same rules and callers as set_agent_summary (any agent in the same team, or the admin); each summary is ≤1000 chars, a single plain-prose paragraph. Files a SINGLE team-coherence review for the whole batch rather than one per agent. Returns a per-item result so one bad agent_id does not lose the rest of the batch. Prefer this over calling set_agent_summary in a loop.

**Parameters:**

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `project` | `string` | No | Project slug or ID. Omit to use the project your run is already in; instance agents (CEO/Coach) must name the project to act in. |
| `updates` | `object[]` | Yes | Up to 50 summary updates. |

**Returns:** `{ items, updated, total }`, where `items` are per-item results: `{ index, agent_id, slug, ok: true }` or `{ index, agent_id, ok: false, error }`. Files a single team-coherence review for the whole batch rather than one per agent.

**Authorization:** Any agent or the admin in the same team (the Captain is the expected caller).

### `get_agent_team_context`

_Read-only._

Read an agent's stored team-relationships context. Useful for the Captain when regenerating siblings' contexts. Accessible by any agent or the admin in the same team.

**Parameters:**

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `project` | `string` | No | Project slug or ID. Omit to use the project your run is already in; instance agents (CEO/Coach) must name the project to act in. |
| `agent_id` | `string` | Yes | Target agent - its slug (e.g. "engineer") or member ID |

**Returns:** `{ title, slug, team_context }`, or `{ error }` if the agent is not in the team.

**Authorization:** Any agent or the admin in the same team.

### `get_agent_team_contexts`

_Read-only._

Read the stored team-relationships context for MULTIPLE agents in one call (max 50). This is the read a coherence review wants: regenerating one agent's context requires seeing its siblings', so fetch the whole roster at once rather than calling get_agent_team_context per agent. Contexts are capped at 6000 chars each, so a normal roster comes back whole. PAGING: the result carries as many contexts as fit under the cap plus `next_index`; when it is non-null, call again with the SAME `items` and `start_index` set to it, and repeat until it is null. Accessible by any agent or the admin in the same team.

**Parameters:**

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `project` | `string` | No | Project slug or ID. Omit to use the project your run is already in; instance agents (CEO/Coach) must name the project to act in. |
| `items` | `object[]` | Yes | Up to 50 items. |
| `start_index` | `integer` | No | Index into `items` to resume from (default 0). Pass back the `next_index` from the previous call, with the same `items`. |

**Returns:** `{ items, start_index, returned, total, next_index }`, where `items` are per-item results: `{ index, ok: true, agent_id, title, slug, team_context }` or `{ index, ok: false, agent_id, error }`. Up to 50 items per call. Only the contexts that fit under the cap are returned - when `next_index` is non-null, call again with the same `items` and `start_index` set to it, and repeat until it is null.

**Authorization:** Any agent or the admin in the same team.

### `update_chat_memory`

_Write tool._

Replace your long-term chat memory - the durable notes carried into every turn of your live operator chat. Pass the FULL revised markdown; it overwrites the stored memory wholesale (there is no append). Record durable, standing knowledge only: operator preferences, decisions, and a rough gist of off-project threads. Do NOT store live data you can re-fetch each turn (project/task/roster state). Memory is compacted automatically when the conversation window fills - you'll be handed the window and asked to fold it in via this tool - but you may also call it any time to record something standing.

**Parameters:**

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `content` | `string` | Yes | The full long-term memory markdown (replaces existing memory) |

**Returns:** `{ written: true, updated_at }`. Overwrites the calling agent's long-term chat memory wholesale (no append; no revision history).

**Authorization:** An agent updating its own memory only.

## Approvals

### `list_approvals`

_Read-only._

List pending approvals, newest first. Long string fields inside payload (e.g. skill-proposal content) come back truncated at `excerpt_chars` (default 500) with *_truncated/_length companions, so one page cannot be dominated by a single large proposal - read a proposal in full from the approval itself. Paged: returns `limit` rows (default 50) plus `next_cursor`/`has_more`; when `has_more` is true, call again with `cursor` set to `next_cursor` until it is false.

**Parameters:**

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `project` | `string` | No | Project slug or ID. Omit to use the project your run is already in; instance agents (CEO/Coach) must name the project to act in. |
| `excerpt_chars` | `integer` | No | Cap for long string fields inside payload, with *_truncated/_length companions (default 500). |
| `limit` | `integer` | No | Max rows to return in this page (default 50, ceiling 200). |
| `cursor` | `string` | No | Opaque cursor from a previous call. Pass back the `next_cursor` you were given to fetch the following page; keep going until `has_more` is false. Treat it as opaque - do not construct or parse one. |

**Returns:** Pending approval rows (`id`, `team_id`, `type`, `status`, `requested_by_member_id`, `resolution_note`, `resolved_at`, `created_at`, `payload`) newest-first. Paged: returns `{ items, next_cursor, has_more }` - follow `next_cursor` until `has_more` is false. Long string fields inside `payload` come back truncated at `excerpt_chars` (default 500) with `_truncated`/`_length` companions.

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

Propose a new skill for the team's skills database (reusable team know-how: MCP server usage, integration steps, conventions, how agents coordinate). Creates an approval request; when approved the skill is written to the skills database. Choose `scope`: 'global' shares it with every project, 'project' keeps it private to this project. Defaults to 'project'.

**Parameters:**

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `project` | `string` | No | Project slug or ID. Omit to use the project your run is already in; instance agents (CEO/Coach) must name the project to act in. |
| `skill_name` | `string` | Yes | Human-readable skill name |
| `skill_slug` | `string` | Yes | URL-safe slug for the skill file |
| `content` | `string` | Yes | Skill content (markdown) |
| `reason` | `string` | Yes | Why this skill should be added |
| `scope` | `project` \| `global` | No | 'global' shares the skill with every project; 'project' keeps it private to this project. Defaults to 'project'. |

**Returns:** `{ approval_id, status }` - creates a skill-proposal approval that writes the skill when approved.

### `full_text_search`

_Read-only._

Full-text keyword search across the team skills database, tasks, project docs, task comments, and project assets. Returns results ranked by relevance (keyword + stemming match). A bare task number or full identifier (e.g. "169" or "HM-169") resolves directly to that task, ranked first. Assets match on their library path, folders included, so any segment of "launch/hero-image.png" finds it; textual assets (.md, .txt, .html, .svg, and the script/data formats stored as plain text such as .py, .js, .json, .csv, .yaml) also match on their content, while binary ones (images, PDFs, media, archives) match on path alone. Use it to find work product an earlier run produced before rebuilding it; an asset hit returns its path, which you pass to read_project_asset. An asset saved before this search existed matches on path until it is next written. Archived items are excluded.

**Parameters:**

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `project` | `string` | No | Project slug or ID. Omit to use the project your run is already in; instance agents (CEO/Coach) must name the project to act in. |
| `query` | `string` | Yes | Search query (keywords) |
| `scope` | `all` \| `tasks` \| `skills` \| `project_docs` \| `comments` \| `assets` | No | Limit search to specific content type (default: all) |
| `limit` | `number` | No | Max results per type (default: 10) |

**Returns:** `{ results, count }` - full-text (keyword + stemming) matches ranked by relevance across skills, tasks, project docs, comments, and assets. A bare task number or full identifier resolves directly to that task, ranked first. An asset result carries `assetFilename` (its library path) and `assetContentType`; pass the path to read_project_asset. Assets match on any segment of their path, and textual ones on their content as well.

### `list_skills`

_Read-only._

List the team's skills database - the manifest of reusable team know-how (MCP server usage, integration steps, conventions, how agents coordinate). Returns each skill's name, slug, and description; call get_skill to load a skill's full body on demand. Paged: returns `limit` entries (default 50) plus `next_cursor`/`has_more`; when `has_more` is true, call again with `cursor` set to `next_cursor` until it is false.

**Parameters:**

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `project` | `string` | No | Project slug or ID. Omit to use the project your run is already in; instance agents (CEO/Coach) must name the project to act in. |
| `tags` | `string` | No | Filter by tag (comma-separated) |
| `limit` | `integer` | No | Max rows to return in this page (default 50, ceiling 200). |
| `cursor` | `string` | No | Opaque cursor from a previous call. Pass back the `next_cursor` you were given to fetch the following page; keep going until `has_more` is false. Treat it as opaque - do not construct or parse one. |

**Returns:** Skill rows (`id`, `name`, `slug`, `description`, `tags`, `created_at`, `updated_at`) ordered by name. Paged: returns `{ items, next_cursor, has_more }` - follow `next_cursor` until `has_more` is false. Pass `tags` (comma-separated) to filter. A project skill shadows a global one of the same slug.

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

Add or update a skill in the team's skills database directly (no approval needed) - record reusable team know-how such as MCP server usage, integration steps, conventions, and how agents coordinate. Use propose_skill when approval is required. If description is omitted it is derived from the skill body. Choose `scope` deliberately: 'global' when the know-how helps agents in ANY project (related or not), 'project' when it is specific to this project. Omitting scope defaults to 'project'.

**Parameters:**

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `project` | `string` | No | Project slug or ID. Omit to use the project your run is already in; instance agents (CEO/Coach) must name the project to act in. |
| `name` | `string` | Yes | Human-readable skill name |
| `slug` | `string` | Yes | URL-safe slug |
| `content` | `string` | Yes | Skill content (markdown) |
| `description` | `string` | No | Short description |
| `tags` | `string` | No | Comma-separated tags |
| `scope` | `project` \| `global` | No | 'global' shares the skill with every project; 'project' keeps it private to this project. Defaults to 'project'. |

**Returns:** `{ skill_id, slug, created: true }`. Upserts by `slug` and writes a skill revision; `description` is derived from the body when omitted.

## Credentials & connectors

### `request_credential`

_Write tool._

Ask the human assignee to provide a secret value (API key, SSH private key, OAuth token, etc.). Posts a structured comment on the task with a paste form. The agent never sees the value; it gets a placeholder string to embed in env vars or HTTP headers, which the egress proxy later substitutes. Returns immediately with the placeholder; the agent should stop work on whatever needed the credential and wait for a credential_provided wakeup. For HTTP-auth kinds (api_key, oauth_token, github_pat) allowed_hosts is REQUIRED - scope it to the provider API host(s) so the secret can only ever reach those hosts. Always ask for the narrowest scope and shortest expiry the provider offers. If a registered connector capability already covers the provider (e.g. a remote MCP server with OAuth), prefer register_connector over a raw paste.

**Parameters:**

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `project` | `string` | No | Project slug or ID. Omit to use the project your run is already in; instance agents (CEO/Coach) must name the project to act in. |
| `task_id` | `string` | Yes | Task identifier or UUID - the request comment is posted here |
| `name` | `string` | Yes | Secret name. Must match [A-Z][A-Z0-9_]{0,63} (e.g. GITHUB_PAT, ANTHROPIC_API_KEY). The placeholder returned will be __HEZO_SECRET_<name>__. |
| `kind` | `api_key` \| `ssh_private_key` \| `github_pat` \| `oauth_token` \| `webhook_secret` \| `other` | Yes | Type of credential - drives validation when the human submits the value |
| `instructions` | `string` | Yes | Human-facing prose explaining why you need this credential and how the human can obtain it. Tell the human to set the minimal scope and the shortest expiry the provider supports (e.g. "I need a GitHub PAT with only `repo` scope to push branches, ideally expiring in 7 days. Create one at https://github.com/settings/tokens"). |
| `input_type` | `text` \| `textarea` \| `file` | No | Form input type. Defaults: text for short keys, textarea for SSH/multiline. |
| `confirmation_text` | `string` | No | Optional yes/no confirmation prompt instead of a paste form (e.g. "Have you added the public key to github.com/owner/repo/settings/keys?"). When set, input_type is ignored. |
| `allowed_hosts` | `string[]` | No | Hostname allowlist for the egress proxy. The credential is only substituted into outbound requests to these hosts. REQUIRED for HTTP-auth kinds (api_key, oauth_token, github_pat) - e.g. ["api.netlify.com"]. Wildcards: *.github.com matches one label segment. |
| `allow_body_substitution` | `boolean` | No | Request that this credential may be substituted into a small JSON request body, not just headers/URL - for APIs that take the secret in the body, e.g. a login POST that returns a token. The human sees this as a pre-checked box on the paste form and can decline it. Body substitution is gated to a single application/json request under 8KB with a fixed Content-Length; after a login, read the returned token and use it via the Authorization header on later calls. |

**Returns:** `{ placeholder, comment_id, status: "pending", reused }`. The agent never sees the value; it embeds `placeholder` (`__HEZO_SECRET_<NAME>__`) and the egress proxy substitutes the real value. Returns `{ error }` for an invalid name, or for an HTTP-auth kind requested without `allowed_hosts`. Idempotent on `name`.

### `register_connector`

_Write tool._

Register a third-party connector for the team and ask the human to authenticate. Posts a connect_required comment on the task with a Connect button; the human completes it inline (in the task comment or on the Connectors page). The agent never sees the token; subsequent runs receive the connector via the egress proxy + placeholder substitution. Idempotent: re-registering an already-active connector returns its current state and fires the wakeup immediately.

Two kinds:
- kind "saas" (default): a hosted MCP server. Give mcp_url. Auth is chosen by what the provider supports: servers that advertise OAuth Dynamic Client Registration (most MCP servers) authorize with zero config; providers whose Authorization Server cannot do DCR (e.g. GitHub) require a pre-registered client_id and the device flow - register those with provider_id set to a known registry key (e.g. "github").
- kind "api": a credentialed REST API the agent calls directly (no MCP server). Give base_url + allowed_hosts (+ optional auth placement). For an OAuth-backed API, also set oauth_provider_id to a bundled OAuth-broker provider (e.g. "google-youtube"): the human then completes the OAuth device flow by pasting just a client id, with the provider pre-selected and locked. For a plain static-key API, omit oauth_provider_id and the human attaches an API key.

**Parameters:**

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `project` | `string` | No | Project slug or ID. Omit to use the project your run is already in; instance agents (CEO/Coach) must name the project to act in. |
| `task_id` | `string` | Yes | Task identifier or UUID where the connect_required comment is posted |
| `display_name` | `string` | Yes | Human-readable connector name shown in the task chat and on the Connectors page (e.g. "DatoCMS", "Linear"). |
| `kind` | `saas` \| `api` | No | Connector kind. 'saas' (default) = a hosted MCP server (needs mcp_url). 'api' = a credentialed REST API the agent calls directly with no MCP server (needs base_url + allowed_hosts) - use this for an OAuth-backed HTTP API like a Google API. |
| `mcp_url` | `string` | No | URL of the MCP server (HTTP / SSE) - required for kind 'saas'. The OAuth dance is discovered by probing this URL for a 401 + WWW-Authenticate header. |
| `mcp_transport` | `http` \| `sse` | No | Transport for the MCP server. Defaults to http. |
| `provider_id` | `string` | No | Optional MCP capability-registry key (e.g. "datocms", "github"). When set, capability defaults from the shared registry pre-fill display name and allowed hosts. This is the MCP-server registry namespace - not the OAuth-broker provider (see oauth_provider_id). |
| `base_url` | `string` | No | For kind 'api' - the REST API base URL agents call (e.g. https://www.googleapis.com/youtube/v3). |
| `allowed_hosts` | `string[]` | No | For kind 'api' - the hosts the credential may be sent to (e.g. ["*.googleapis.com"]). Required for api connectors. |
| `auth` | `object` | No | For kind 'api' - where the credential rides. Defaults to an `Authorization: Bearer ` header when omitted (the right default for OAuth access tokens). |
| `oauth_provider_id` | `string` | No | For kind 'api' only - a bundled OAuth-broker provider key (e.g. "google-youtube") to pre-select for the human. The provider is then LOCKED in the completion UI: the human finishes the OAuth device flow inline (in the task comment or on the Connectors page) by pasting only a client id - no provider picker. Omit for a plain API-key REST connector. |
| `skill_id` | `string` | No | Optional ID of a previously-fetched skill document (see fetch_skill_file). When set, the skill file is exposed to every team agent run via the per-adapter skill path. |
| `access` | `read` \| `write` | No | How much of the server you need. 'write' (default) leaves every method the server advertises available. 'read' asks for read-only: once the human connects it, every write method the server advertises is disabled automatically, and runs never see them. Ask for 'read' whenever the task only needs to look things up - it is the narrowest scope that still does the job, and the human can widen it later. This is a request, not a grant: if the human has already chosen which methods are enabled, their choice stands. |

**Returns:** `{ connector_id, status, name, display_name, comment_id?, reused }`. `status` is `active` (OAuth already complete) or `pending` (a connect_required comment is posted for the human). Idempotent. Pass `access: "read"` when the task only needs to look things up: every write method the server advertises is disabled once the human connects it, and the connect card says so before they authorize. The request narrows only - it never widens access, and it is skipped entirely if the human has already chosen which methods are enabled.

### `fetch_skill_file`

_Read-only._

Fetch a remote agent skill file (Markdown describing how to use a third-party MCP server) and store it as a skill (auto_load). Returns the skill_id and slug. Subsequent agent runs get this skill file injected into their adapter's skills directory. Idempotent on the derived slug - re-fetching the same URL updates the existing skill. Choose `scope`: 'global' shares it with every project (e.g. a widely-used MCP's usage docs), 'project' keeps it private to this project. Defaults to 'project'.

**Parameters:**

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `project` | `string` | No | Project slug or ID. Omit to use the project your run is already in; instance agents (CEO/Coach) must name the project to act in. |
| `url` | `string` | Yes | HTTPS URL of the skill file. Only http/https schemes are allowed; response must be < 256KB; 10s timeout. |
| `title` | `string` | No | Human-readable title shown in the team KB. Defaults to the URL pathname. |
| `scope` | `project` \| `global` | No | 'global' shares the skill with every project; 'project' keeps it private to this project. Defaults to 'project'. |

**Returns:** `{ skill_id, slug, source_url, size_bytes, reused }`, or `{ error }` (invalid URL, non-HTTP(S), over 256 KB, or fetch failure). Stored as an auto-load global skill; idempotent on the derived slug.

## MCP connections

### `list_connectors`

_Read-only._

List the connectors available to agent runs in your project (its own connectors plus global "all projects" ones; a project connector shadows a global one of the same name). Each row includes a derived `oauth_status` so you can tell whether a connector is usable: "active" means it is credentialed and connected, or Hezo probed the server and it answered with no credential needed, so its MCP tools should appear in your tool list on your next run; "degraded" means it WAS connected and its stored token has stopped working (the grant expired or was revoked - see auth_error), so its tools may still be listed but calls through them fail, and only the human can fix it by reconnecting; "pending" means it cannot reach a run yet, either waiting on the human to click Connect or waiting on a probe that has not yet found the server answering without a credential; "failed" means the connect attempt errored before it ever connected (see auth_error); "revoked" means a human disconnected it; "none" means the row is not a hosted MCP server at all (a local stdio server, or an `api` REST connector), so it has no OAuth story to report. A "degraded" connector is not a Hezo bug and not something to retry around silently - report it to the human with an active @admin comment naming the connector and asking them to reconnect it. Two fields carry the probe evidence behind a hosted row: `probed_at` is when Hezo last checked the server, and `probe_error` is why that check failed ("auth_required" when the server demanded a credential Hezo does not have, "unreachable" when it did not answer), or null when it completed the MCP handshake. A connector whose auth rides a __HEZO_SECRET_<NAME>__ header is exempt: the egress proxy substitutes that at request time, which a server-side probe cannot reproduce, so it reads "active" with no probe needed. Do NOT confuse `install_status` (which tracks local-package install state and is meaningless for SaaS MCPs) with `oauth_status`. An active OAuth-backed connector also carries `rest_auth` = `{ placeholder, allowed_hosts, scopes }`: put `placeholder` (e.g. in an `Authorization: Bearer <placeholder>` header) on a raw HTTP request to authenticate the provider's REST API directly when no MCP tool covers what you need - the egress proxy substitutes the real token, but ONLY for requests to `allowed_hosts`; you never see the value. Use this instead of requesting a PAT (e.g. for GitHub repo-settings edits that the `github` MCP does not expose). A connector of kind `api` (a credentialed REST API with no MCP server) carries `api_auth` = `{ base_url, placeholder, allowed_hosts, placement, name, docs_url }` instead: put `placeholder` in the `name` header (when `placement` is "header", prefixed by any scheme) or `name` query parameter (when `placement` is "query") and send the request to `base_url` - the egress proxy substitutes the real key, scoped to `allowed_hosts`. `placeholder` is null until a human attaches the credential on the Connectors page; `api_auth` is null for non-api rows. An `api` connector may instead be OAuth-backed (a human connected it via the device flow): then `api_auth.placeholder` is a broker-managed OAuth access token that Hezo keeps refreshed host-side - use it exactly the same way.

**Parameters:**

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `project` | `string` | No | Project slug or ID. Omit to use the project your run is already in; instance agents (CEO/Coach) must name the project to act in. |
| `limit` | `integer` | No | Max rows to return in this page (default 50, ceiling 200). |
| `cursor` | `string` | No | Opaque cursor from a previous call. Pass back the `next_cursor` you were given to fetch the following page; keep going until `has_more` is false. Treat it as opaque - do not construct or parse one. |

**Returns:** An array of connector rows with a derived `oauth_status` (`active` | `degraded` | `pending` | `failed` | `revoked` | `none`) and, for an OAuth-backed connector that is `active` or `degraded`, `rest_auth` = `{ placeholder, allowed_hosts, scopes }` (else `null`). `active` covers both a credentialed connector that is connected and an uncredentialed hosted server Hezo has probed and found answering with no credential; `pending` covers both a connect the human has not completed and a hosted server no probe has yet proved public. `degraded` means the connector was connected and its stored token has stopped working - a human must reconnect it, so report it rather than retrying around it. `none` means the row is not a hosted MCP server at all (a local stdio server, or an `api` REST connector), so it has no OAuth story to report. Other fields include `id`, `name`, `display_name`, `kind`, `config`, `project_id`, `oauth_account_label`, `install_status`, `install_error`, `skill_id`, `created_by_task_id`, `activated_at`, `revoked_at`, `auth_error`, plus the probe evidence behind a hosted row: `probed_at` (when Hezo last checked the server, `null` if never) and `probe_error` (`auth_required` when the server demanded a credential Hezo does not have, `unreachable` when it did not answer, `null` when it completed the MCP handshake). A connector whose auth rides a `__HEZO_SECRET_<NAME>__` header is exempt from needing that evidence: the egress proxy substitutes the value at request time, which a server-side probe cannot reproduce. A hosted MCP connector whose methods have been listed also carries `method_access` = `{ mode: "all" | "restricted", enabled, total, disabled_write }` (else `null`) - when `mode` is `restricted`, the withheld methods are absent from your tool list on purpose, so a tool you expect and cannot see is disabled rather than missing. Every row carries `tools_this_run`: how many of that connector's tools your current run actually received, or `null` when nothing measured it (outside an agent run, or on a runtime that reports no tool list). This is a measurement of your own run, not a guess - if you cannot find a connector's tools, read this before concluding it is broken. A `0` alongside an `active` connector means it connected and contributed nothing callable, which is worth reporting to the human; a non-zero count means the tools are there and worth searching your tool list for again. Every row also carries `linked_repos`: the git repos that authenticate through the same OAuth connection, each with `id`, `repo_identifier`, `project_id` and `project_name`, across every project of your team that shares the connection, not only your own project - a connection may be shared, and the repo that breaks may not be the one in front of you. Repos in other teams are deliberately absent: the removal guard still counts them, so it refuses on a repo you cannot see, but naming it would disclose another team's project. A non-empty `linked_repos` is why remove_connector will refuse that connector, and an empty one is not proof that nothing is linked. Scoped to your project: its own connectors plus global ("all projects") ones, with a project connector shadowing a global one of the same name.

### `test_connector`

_Read-only._

Test an MCP connector end-to-end from the server side. Resolves the stored OAuth token from the vault and makes a direct HTTP call to the MCP server. Returns the upstream status code, a response excerpt, the secret name used, and whether a token was attached - never the token or any part of it. Use this when oauth_status says "active" but the MCP's tools are absent from your tool list - it isolates "is the token still valid against the provider?" from "does the proxy chain in the container work?". A 401 here means the stored credential is no longer accepted: report it to the human with an active @admin comment asking them to reconnect the connector. You do not need this call when oauth_status already says "degraded" - that answer is known.

**Parameters:**

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `project` | `string` | No | Project slug or ID. Omit to use the project your run is already in; instance agents (CEO/Coach) must name the project to act in. |
| `connector_id` | `string` | Yes | connector id or name (both shown by list_connectors) |

**Returns:** `{ ok, status, mcp_url, secret_name, token_sent, www_authenticate, body_excerpt, hint }` from a direct server-side probe of the MCP URL. `token_sent` is a boolean - no part of the token value is ever returned, and any occurrence of it in `body_excerpt` / `www_authenticate` is redacted in case the upstream echoes what it was sent. Returns `{ error }` if the connector is missing, not `saas`, or its token cannot be decrypted.

### `add_connector`

_Write tool._

Register a connector for your project - a SaaS HTTP MCP server (`saas`), a local stdio MCP server (`local`), or a credentialed REST API you call directly with no MCP server (`api`). The connection is scoped to your project - available to this project's agent runs, alongside any global "all projects" connectors. Hezo checks a SaaS server at registration and hands it to agent runs only while it answers that check without a credential; the response tells you which happened in `reachable`, `probe` and `note`. A server that wants auth stays out of runs until a human connects it or attaches an API key. Header values may include __HEZO_SECRET_<NAME>__ placeholders that the egress proxy substitutes at request time; those count as the connector's credential, so a server authenticated that way reaches runs without needing to pass the check. Local servers must be installed before they take effect. An `api` connector has no MCP server: attach a credential to it (Connectors page → API key) and it surfaces in `list_connectors` as an `api_auth` block whose placeholder you put in the auth header/query and send to `base_url` directly - the egress proxy substitutes, scoped to `allowed_hosts`.

**Parameters:**

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `project` | `string` | No | Project slug or ID. Omit to use the project your run is already in; instance agents (CEO/Coach) must name the project to act in. |
| `name` | `string` | Yes | Server identifier - used as the MCP descriptor name and as the unique key. |
| `kind` | `saas` \| `local` \| `api` | Yes | saas = HTTP MCP, local = stdio MCP, api = direct REST API (no MCP server) |
| `config` | `object` | Yes | For saas: { url, headers? }. For local: { command, args?, env?, package? }. For api: { base_url, allowed_hosts: string[], auth: { placement: "header"\|"query", name, scheme? }, docs_url? }. |

**Returns:** `{ id, install_status, reachable, probe, note }`, or `{ error }` if `config.url` (saas) / `config.command` (local) is missing. Upserts by `name` within your project. Registering a `saas` server probes it before returning: `reachable` says whether it completed the MCP handshake, `probe` is `ok`, `auth_required`, `unreachable`, or `unverifiable` (its credential is a `__HEZO_SECRET_<NAME>__` header the egress proxy substitutes, which cannot be reproduced from the server side), and `note` says what that means for agent runs. A server that wants a credential Hezo does not have stays out of runs until a human connects it or attaches an API key. `reachable` and `probe` are `null` for `local` and `api` connectors, which have no server to probe. A connector that already carries a credential (a completed OAuth connection or an attached API key) cannot be re-pointed from here: changing its `kind` or `config` returns `{ error, connector_id, hint }` and leaves the row untouched, since re-binding a credentialed connector is a human-only operation on the Connectors page. Re-registering it at its existing configuration still succeeds, and re-pointing an uncredentialed one clears its probe evidence so the new URL is proved on its own.

### `remove_connector`

_Write tool._

Remove one of your project's registered MCP connections. Only connectors owned by your project can be removed - global "all projects" connectors and other projects' are managed elsewhere. Refused when the connector's OAuth connection still authenticates a linked git repo anywhere on the instance: that returns an error naming what blocks it and changes nothing. If you reached for this because a connector's tools were missing, read the run log's `[runner] MCP connectors:` line and list_connectors first - removing the connector is not how a missing tool is fixed. Otherwise the next agent run will not see it.

**Parameters:**

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `project` | `string` | No | Project slug or ID. Omit to use the project your run is already in; instance agents (CEO/Coach) must name the project to act in. |
| `id` | `string` | Yes | connector id or name (returned by add_connector or list_connectors) |

**Returns:** `{ removed: true, id }`, or `{ error }` if the connection is not found. Removes only your project's own connector (never a global or another project's). Refused when the connector's OAuth connection still authenticates one or more linked git repos anywhere on the instance, including ones outside your own project: that returns `{ error, connector_id, hint }` and leaves the row untouched. Removing it would not break git - the repos keep their own reference to the connection - but every MCP tool the connector carried would disappear from the next run. The `[runner] MCP connectors:` line at the top of a run log names what that run received, so check it there before concluding a connector is broken. Unlinking the repo, or removing the connector anyway, is a human operation on the project Git page and the Connectors page. If you reached for this because a connector's tools were missing, read `tools_this_run` and `linked_repos` from list_connectors first.

## Project docs & assets

### `list_project_docs`

_Read-only._

List project documentation files (PRD, spec, implementation plan, etc.). Each entry carries its `filename`, a one-line `description` (what the doc is / when to read it, '' if unset), and `content_length` - the doc's size, so you can tell before opening it whether read_project_doc will need more than one window. Bodies are not returned here; read one with read_project_doc. Archived (soft-deleted) docs are excluded by default - set filter: 'archived' or 'all' to see them (entries then carry an `archived` flag). Paged: returns `limit` entries (default 50) plus `next_cursor`/`has_more`; when `has_more` is true, call again with `cursor` set to `next_cursor` until it is false.

**Parameters:**

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `project` | `string` | No | Project slug or ID. Omit to use the project your run is already in; instance agents (CEO/Coach) must name the project to act in. |
| `filter` | `active` \| `archived` \| `all` | No | Which archive states to consider: 'active' (default - archived items are excluded), 'archived' (only archived), or 'all'. |
| `limit` | `integer` | No | Max rows to return in this page (default 50, ceiling 200). |
| `cursor` | `string` | No | Opaque cursor from a previous call. Pass back the `next_cursor` you were given to fetch the following page; keep going until `has_more` is false. Treat it as opaque - do not construct or parse one. |

**Returns:** Markdown project doc entries (`id`, `filename`, `description`, `content_length`, `created_at`, `updated_at`), where `description` is the overall "what this is" summary (`''` if unset) and `content_length` is the doc's size so you can tell before opening it whether `read_project_doc` will need more than one window. Bodies are not returned here. Paged: returns `{ items, next_cursor, has_more }` - follow `next_cursor` until `has_more` is false. The `filter` param defaults to `'active'` (archived docs excluded); with `'archived'` or `'all'` each entry also carries `archived: boolean`.

### `list_project_assets`

_Read-only._

List the project's assets - files in the assets library (UI mockups, wireframes, diagrams, images, PDFs, scripts, and generated markdown such as blog posts or reports). Filenames may carry a folder prefix up to 2 levels deep (e.g. `launch/images/hero.png`); reference one in a comment or doc as `assets/<path>` exactly as returned here (e.g. assets/launch/images/hero.png), no backticks. Author both text and binary assets with write_project_asset (binary via encoding: 'base64') and reorganize with move_project_asset / copy_project_asset; obsolete assets are archived with archive_project_asset (hard deletion is admin-only). Archived assets are excluded by default - set filter: 'archived' or 'all' to see them (entries then carry an `archived` flag). Raster image entries (PNG/JPEG/GIF/WebP) also carry their pixel `width`/`height`. Every entry carries `byte_size`, so you can tell before opening one whether read_project_asset will need more than one window. Results are ordered newest-first by default; pass sort: 'oldest' or 'alphabetical' to change the order.

**Parameters:**

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `project` | `string` | No | Project slug or ID. Omit to use the project your run is already in; instance agents (CEO/Coach) must name the project to act in. |
| `filter` | `active` \| `archived` \| `all` | No | Which archive states to consider: 'active' (default - archived items are excluded), 'archived' (only archived), or 'all'. |
| `sort` | `newest` \| `oldest` \| `alphabetical` | No | Order of the returned assets: 'newest' (default - most recently created first), 'oldest', or 'alphabetical' (by filename, A→Z). |
| `limit` | `integer` | No | Max rows to return in this page (default 50, ceiling 200). |
| `cursor` | `string` | No | Opaque cursor from a previous call. Pass back the `next_cursor` you were given to fetch the following page; keep going until `has_more` is false. Treat it as opaque - do not construct or parse one. |

**Returns:** Project asset entries (`id`, `filename`, `content_type`, `created_at`, `width?`, `height?`); raster images (PNG/JPEG/GIF/WebP) also carry pixel `width`/`height`. `filename` is the full path and may carry a folder prefix up to 2 levels (e.g. `launch/images/hero.png`). Paged: returns `{ items, next_cursor, has_more }` - follow `next_cursor` until `has_more` is false. The `filter` param defaults to `'active'` (archived assets excluded); with `'archived'` or `'all'` each entry also carries `archived: boolean`.

### `write_project_asset`

_Write tool._

Save a file to the project assets library so a human can open it AND other agents (your teammates and your own future runs) can read it back with read_project_asset - including a binary deliverable or generation output you produced (a rendered image, chart, diagram, screenshot, PDF, dataset, or media file). This is how such a file reaches both the admin and the next agent: a file left on the ephemeral container disk vanishes when the run ends and is invisible to everyone else, so anything a later step or teammate will reuse belongs here. Text formats (.html, .svg, .txt, .md, plus script/text formats stored as plain text: .sh, .py, .js, .ts, .json, .csv, .yaml, .yml) are written with the default encoding "utf8". Binary formats - any type a human can upload (.png, .jpg, .jpeg, .gif, .webp, .pdf, .mp3, .mp4, .webm, archives such as .zip/.tar/.tar.gz/.7z, …) - MUST pass encoding: "base64" with the file's bytes base64-encoded in `content`. For a LARGE binary, upload it instead via a multipart/form-data POST to `/mcp/assets` (fields `file` and `path` for the full destination path, plus optional `overwrite=true` to replace an existing asset in place, same Bearer auth): base64 in a JSON-RPC tool call can be silently truncated by a runtime's argument-size cap, whereas the multipart endpoint streams the bytes; the result is identical and shows up in list_project_assets / read_project_asset. When you DO write a binary through this tool, pass `byte_size` (the file's exact byte length) so a truncated `content` is rejected instead of stored corrupt. The filename may include a folder path up to 2 levels deep (e.g. "scripts/deploy-check.sh" or "launch/images/hero.png") - folders spring into existence with their first asset. Re-saving the same path overwrites it, so the reference stays stable; overwrite matching is PATH-EXACT ("x.html" and "blog/x.html" are different assets - after a move, write to the new full path or you will fork the file). IMPORTANT: any write to an existing path deletes ALL of its pending review comments (the admin's feedback returned by read_project_asset) - capture every comment in your context before the first write, and make all desired edits in one consolidated write. Returns the reference string to drop into a comment as `assets/<path>` (no backticks). HTML opens interactively in a new tab; markdown renders with a rich preview and a view-source toggle; a .csv renders as a table with the raw file behind the same toggle; images render inline in the assets library. Use a markdown asset for a standalone deliverable opened from the assets library; use write_project_doc for project context docs (specs, PRDs, research). Mockups and other deliverables belong here, never committed to the source repo.

**Parameters:**

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `project` | `string` | No | Project slug or ID. Omit to use the project your run is already in; instance agents (CEO/Coach) must name the project to act in. |
| `filename` | `string` | Yes | Path to write, optionally foldered (e.g. "ui-mockups.html", "launch/images/hero.png") |
| `content` | `string` | Yes | File content - raw text for utf8, or base64-encoded bytes for base64 |
| `encoding` | `utf8` \| `base64` | No | utf8 (default) for text assets; base64 for binary assets (images, PDFs, media) - required for any non-text type |
| `byte_size` | `integer` | No | For a base64 binary: the file's exact byte length. When provided, the decoded content is checked against it and a truncated upload (a runtime capping the tool-call argument size, cutting `content` mid-stream) is rejected instead of silently stored. Strongly recommended for binaries. |

**Returns:** `{ written: true, id, reference: "assets/<path>", byte_size, width?, height? }` (raster images also report their pixel `width`/`height`), or `{ error }`. Accepts any type a human can upload: text formats (`.html`, `.svg`, `.txt`, `.md`, and `.sh`/`.py`/`.js`/`.ts`/`.json`/`.csv`/`.yaml`/`.yml` stored as plain text) with the default `encoding: "utf8"`, and binary formats (`.png`, `.jpg`, `.gif`, `.webp`, `.pdf`, media, archives such as `.zip`/`.tar`/`.tar.gz`/`.7z`, …) with `encoding: "base64"` - a non-text type written without base64 is rejected, as is invalid or truncated base64 (a runtime argument-size cap can cut a large base64 `content` mid-stream - pass `byte_size` (the file’s exact byte length) so a short decode is rejected, or upload large binaries via a multipart POST to `/mcp/assets` with a `path` field and optional `overwrite=true`, which streams the bytes with no argument limit). Also errors if the type is unsupported, the path is invalid (max 2 folder levels), the content exceeds 10 MB, or an archived asset holds the path (unarchive it first or pick another path). Re-saving the same path overwrites it; matching is path-exact. Overwriting deletes ALL pending review comments on the asset (the admin feedback returned by read_project_asset) - read them first and make all edits in one consolidated write.

### `read_project_asset`

_Read-only._

Read a project asset's contents by path (e.g. "ui-mockups.html" or "scripts/check.sh") - the files that list_project_assets returns (UI mockups, wireframes, SVG diagrams, text exports, scripts, markdown deliverables). Use the full path exactly as listed, folder prefix included. Text-based assets (HTML, SVG, plain text, markdown) come back inline as `content`. Raster images (PNG/JPEG/GIF/WebP) come back with their pixel `width`/`height` AND the image itself inline, so a vision-capable model can see it to review it - pass `include_image: false` to skip the pixels and get metadata only, and images above ~4 MB return metadata + `url` only. Other binary assets (PDFs, media, archives) are not inlined; the response gives a signed download `url` - fetch it with a plain `curl -fsSL '<url>' -o /tmp/<filename>` (no auth header needed; the URL is valid for 24h, re-call this tool for a fresh one). An archive (.zip, .tar, .tar.gz/.tgz, .7z) is downloaded that same way and then unpacked in your container - `unzip`, `tar` and `7z` are preinstalled. If an admin has left review comments on the asset they come back as `review_comments`: for text assets (markdown, plain text) each anchors to an exact `quote` (with `occurrence` = 0-based Nth match of that snippet); a comment without a quote applies to the whole file. Capture them all before any write_project_asset to the path - overwriting deletes every review comment. Archived assets are not readable by default - set filter: 'archived' or 'all' to read one. Large text assets come back one byte-window at a time: when `truncated` is true, call again with `offset` set to the returned `next_offset` and keep going until `next_offset` is null (`list_project_assets` reports each asset's `byte_size`, so you can tell in advance whether that will be needed). For markdown project docs use read_project_doc instead.

**Parameters:**

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `project` | `string` | No | Project slug or ID. Omit to use the project your run is already in; instance agents (CEO/Coach) must name the project to act in. |
| `filename` | `string` | Yes | Asset path to read (e.g. "ui-mockups.html", "launch/images/hero.png") |
| `filter` | `active` \| `archived` \| `all` | No | Which archive states to consider: 'active' (default - archived items are excluded), 'archived' (only archived), or 'all'. |
| `include_image` | `boolean` | No | For raster images (PNG/JPEG/GIF/WebP): when true (default) the image is returned inline so a vision-capable model can see it. Pass false to get metadata only (dimensions + download URL) and skip the pixels. |
| `offset` | `integer` | No | For a text asset: byte offset to start reading from (default 0). To page an asset too large for one read, pass back the `next_offset` from the previous call. Snapped down to a UTF-8 character boundary so a window never begins mid-character. Ignored for binary assets, which return a download URL instead. |
| `max_bytes` | `integer` | No | For a text asset: max bytes of content to return in this window (default and ceiling is the read budget, so a normal-size asset comes back whole). Clamped to the budget; the returned slice ends on a UTF-8 character boundary, so it can come back a few bytes short. |

**Returns:** For a text asset, `{ filename, content_type, content }`. For a raster image (PNG/JPEG/GIF/WebP) at or under ~4 MB, the image is returned inline as an MCP image content block alongside a text block of `{ filename, content_type, byte_size, binary: true, width, height, url }` so a vision-capable model can see it - pass `include_image: false` (or exceed the size cap) for that metadata alone with no image block. Other binary assets - PDFs, media, and archives (`.zip`, `.tar`, `.tar.gz`/`.tgz`, `.7z`, `.rar`) - return `{ filename, content_type, byte_size, binary: true, url }` - a signed download URL valid for 24h; fetch it with plain `curl` (no auth header), and re-call the tool for a fresh one if it expires. An archive is unpacked in the run container after download. Either shape also carries `review_comments: [{ id, quote?, occurrence?, comment, created_at }]` when the admin has left pending review feedback on the asset: on a text asset (markdown, plain text) a comment anchors to an exact `quote` snippet (`occurrence` disambiguates repeats); a comment without a quote applies to the whole file. Any write to the asset's path deletes all of its review comments, so capture them before writing. Returns `{ error }` if not found - match the full path, folder prefix included - or if the asset's archive state doesn't match `filter` (default `'active'`, so archived assets need `filter: 'archived'` or `'all'`; an archived read carries `archived: true`).

### `edit_project_asset`

_Write tool._

Replace one span of a TEXT project asset (HTML, SVG, markdown, plain text, a script), leaving the rest untouched. Prefer this over write_project_asset for any change to an existing text asset: it sends only the text you are changing, so the argument stays proportional to the edit rather than to the file - which matters most for exactly the assets that get tweaked, like a self-contained interactive HTML mockup, where re-sending the whole file risks a runtime's tool-call argument-size cap cutting it mid-stream. Binary assets (images, PDFs, media, archives) cannot be edited this way; rewrite them with write_project_asset. `old_string` must match the current text EXACTLY, including indentation and line breaks: read the asset first and copy the span verbatim rather than retyping it. It must also be unique - if it matches several places the call is refused, so extend it with surrounding lines until it is unique, or pass replace_all to change every match. The result returns the applied hunk with surrounding context plus the asset's new `byte_size`, so you can confirm what landed without reading it again. Like any overwrite this clears the asset's pending review comments, so capture those first.

**Parameters:**

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `project` | `string` | No | Project slug or ID. Omit to use the project your run is already in; instance agents (CEO/Coach) must name the project to act in. |
| `filename` | `string` | Yes | Asset path to edit (e.g. "ui-mockups.html", "launch/notes.md") |
| `old_string` | `string` | Yes | The exact text to replace, copied verbatim from the asset (including indentation and line breaks). Must be unique in the asset unless replace_all is set. |
| `new_string` | `string` | Yes | The text to put in its place. May be empty to delete the span. |
| `replace_all` | `boolean` | No | Replace every occurrence of `old_string` rather than requiring it to be unique. Use for a rename that legitimately recurs; otherwise prefer extending `old_string` so the edit is unambiguous. |

**Returns:** `{ edited: true, id, reference: "assets/<path>", replacements, byte_size, hunk }` - `hunk` is the applied change with surrounding context and line numbers, so you can confirm what landed without reading the asset back. TEXT assets only (HTML, SVG, markdown, plain text, scripts); a binary asset returns `{ error }` naming its content type, and must be rewritten whole with write_project_asset. Also returns `{ error }` if the asset does not exist, is archived, the result exceeds 10 MB, or `old_string` is empty, unchanged, absent, or matches more than one place without `replace_all`. Prefer this over write_project_asset for any change to an existing text asset: the argument scales with the edit rather than the file, which matters most for the assets that get tweaked (a self-contained interactive HTML mockup re-sent whole is exactly the payload a runtime argument-size cap truncates). Like any overwrite it clears the asset's pending review comments.

### `move_project_asset`

_Write tool._

Move or rename a project asset within the assets library: change its folder (up to 2 levels deep), its filename, or both - folders spring into existence when the first asset lands in them and vanish with their last one. The stored file does not change, so the destination must keep the same extension. Moves never overwrite: if the destination path is taken the call fails. IMPORTANT: existing text references to the old `assets/<path>` in comments and docs are NOT rewritten - they degrade to plain text - so update the places that cite the old path, and prefer organizing assets early over moving them later. To retire an obsolete asset, use archive_project_asset instead of moving it aside (hard deletion is admin-only).

**Parameters:**

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `project` | `string` | No | Project slug or ID. Omit to use the project your run is already in; instance agents (CEO/Coach) must name the project to act in. |
| `from` | `string` | Yes | Current asset path (e.g. "hero.png" or "launch/hero.png") |
| `to` | `string` | Yes | Destination path (e.g. "launch/images/hero.png") |

**Returns:** `{ moved: true, id, from, reference: "assets/<path>", note }`, or `{ error }` when the source is missing or archived, the destination exists (moves never overwrite; an archived asset still holds its path), the extension changes, or a path is invalid. Metadata-only - the stored bytes do not move. Existing text references to the old path are not rewritten.

### `copy_project_asset`

_Write tool._

Copy a project asset to a new path in the assets library (any type, including binary). The copy is a new asset with its own id; the source is untouched and existing references keep pointing at it. Copies never overwrite: if the destination path is taken the call fails. Use it to duplicate a template before editing, or to stage related files into a folder.

**Parameters:**

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `project` | `string` | No | Project slug or ID. Omit to use the project your run is already in; instance agents (CEO/Coach) must name the project to act in. |
| `from` | `string` | Yes | Source asset path (e.g. "templates/report.md") |
| `to` | `string` | Yes | Destination path (e.g. "2026-q3/report.md") |

**Returns:** `{ copied: true, id, reference: "assets/<path>" }` - a new asset with its own id, any type including binary. Returns `{ error }` when the source is missing or archived, the destination exists (copies never overwrite), or a path is invalid.

### `archive_project_asset`

_Write tool._

Archive a project asset - the reversible soft delete, and the ONLY way an agent retires an asset (hard deletion is admin-only, so treat any "delete this asset" instruction as archive). The asset disappears from list_project_assets and default reads but keeps its path reserved; existing assets/<path> references in comments and docs keep resolving. Reverse with unarchive_project_asset. No approval needed.

**Parameters:**

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `project` | `string` | No | Project slug or ID. Omit to use the project your run is already in; instance agents (CEO/Coach) must name the project to act in. |
| `filename` | `string` | Yes | Asset path to archive - the full path exactly as list_project_assets returns it (e.g. "drafts/old-v1.md") |

**Returns:** `{ archived: true, reference: "assets/<path>", changed }` (`changed: false` when it was already archived - the call is idempotent), or `{ error }` if the asset is not found. The archived asset leaves listings and default reads but keeps its path reserved; existing `assets/<path>` references keep resolving. While archived it is read-only: it cannot be overwritten, moved, renamed, or reviewed until unarchive_project_asset restores it.

**Authorization:** Archival is the agent-facing soft delete; hard deletion of assets is admin-only in the web app.

### `unarchive_project_asset`

_Write tool._

Restore an archived project asset to active. It reappears in list_project_assets, becomes readable and writable again, and its assets/<path> reference links as before.

**Parameters:**

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `project` | `string` | No | Project slug or ID. Omit to use the project your run is already in; instance agents (CEO/Coach) must name the project to act in. |
| `filename` | `string` | Yes | Asset path to restore (the same path it was archived under) |

**Returns:** `{ archived: false, reference: "assets/<path>", changed }` (`changed: false` when it was already active), or `{ error }` if the asset is not found. Restoring is recorded in the project activity log, naming the task and run it came from - so restore an asset because it is genuinely back in use, not merely to get around the archived-write refusal.

### `read_project_doc`

_Read-only._

Read a markdown project doc by filename (e.g. "spec.md") - the high-level project context (PRDs, specs, architecture decisions, research) that list_project_docs returns; the full body comes back inline as `content`. These docs live in the project-doc store in the database, NOT on the filesystem: there is no /workspace/.hezo/project-docs path, so do not reach for the Read/cat file tools - always load a doc through this tool by its bare filename. Archived docs are not readable by default - set filter: 'archived' or 'all' to read one. When the admin has left review feedback on the doc, the result includes `review_comments` - each anchors a `comment` to a `quote` (an exact text snippet; `occurrence` disambiguates repeated snippets). Action them when asked to. IMPORTANT: any write to the doc deletes ALL of its review comments, so capture every comment from this result BEFORE your first write_project_doc call - after one write they are gone. For non-markdown assets (mockups, wireframes, diagrams) use read_project_asset instead. Large docs come back one byte-window at a time: when `truncated` is true, call again with `offset` set to the returned `next_offset` and keep going until `next_offset` is null.

**Parameters:**

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `project` | `string` | No | Project slug or ID. Omit to use the project your run is already in; instance agents (CEO/Coach) must name the project to act in. |
| `filename` | `string` | Yes | Filename to read (e.g. "spec.md") |
| `filter` | `active` \| `archived` \| `all` | No | Which archive states to consider: 'active' (default - archived items are excluded), 'archived' (only archived), or 'all'. |
| `offset` | `integer` | No | Byte offset to start reading from (default 0). To page through a doc too large for one read, pass back the `next_offset` from the previous call. Snapped down to a UTF-8 character boundary so a window never begins mid-character. |
| `max_bytes` | `integer` | No | Max bytes of content to return in this window (default and ceiling is the read budget, so a normal-size doc comes back whole). Clamped to the budget; the returned slice ends on a UTF-8 character boundary, so it can come back a few bytes short. |

**Returns:** `{ filename, content, offset, returned_bytes, total_bytes, next_offset, truncated }`. `content` is a UTF-8 byte window of the markdown body starting at `offset` (default 0). A doc that fits in one read comes back whole (`offset: 0`, `next_offset: null`, `truncated: false`, `returned_bytes === total_bytes`). A larger doc is paged: `truncated` is true, `next_offset` is the byte offset to pass back as `offset` on the next call, and a `paging_hint` string spells out the loop - keep calling until `next_offset` is null, concatenating each `content`. The optional `max_bytes` param shrinks a window. `description` is included when the doc has an overall summary set. `review_comments: [{ id, quote, occurrence, comment, created_at }]` is included when the admin has left pending review feedback (each anchors to an exact `quote` snippet; `occurrence` disambiguates repeats); any write to the doc deletes all of its review comments, so capture them before writing. Returns `{ error }` if the file is not found or its archive state doesn't match `filter` (default `'active'`, so archived docs need `filter: 'archived'` or `'all'`; an archived read carries `archived: true`).

### `write_project_doc`

_Write tool._

Write a project documentation file, replacing its whole body. These docs live in the project-doc store in the database, NOT on the filesystem: there is no /workspace/.hezo/project-docs path, so never author or edit one with the Write/Edit file tools or a shell redirect - a markdown file you save to disk persists nothing, is invisible to every teammate, and leaves the real doc stale. To change PART of an existing doc, prefer edit_project_doc: this tool sends the entire body, so a large doc means a large argument, and a runtime that caps tool-call argument size can cut `content` mid-stream. Pass `content_length` (the exact character count of `content`) so a truncated argument is rejected rather than silently overwriting the doc and wiping its review comments. Project docs are markdown only - the filename must end in .md. For high-level project context: PRD, spec, implementation plan, research. Make ALL desired edits in ONE consolidated write per run, for two reasons: (1) writing a doc deletes ALL of its pending review comments (the admin's highlight feedback returned by read_project_doc) - a single write clears the whole review, so capture every comment in your context before the first write; (2) docs are revisioned - every content-changing write records a revision, so many partial writes bury the history in noise. Pass a `changelog` summarizing what changed in this write and why - it becomes that revision's entry in the document's history; keep update/changelog logs OUT of the document body and put them in `changelog` instead. Also pass a `description`: an overall summary of what the doc is and when to read it, in no more than one or two sentences, shown next to the filename in the Documents list and the doc header so teammates and future runs can tell what the doc is at a glance. Describe the doc's stable purpose, NOT its current contents: do not list its sections, findings, dates, counts, or latest revisions (those live in the body and the `changelog`), so the description stays steady across updates. Keep it short and out of the body. Non-markdown files (mockups, wireframes, images, PDFs) live in the project assets library instead - reference those as `assets/<filename>`. In content, reference teammates with @<agent-slug>. Reference tasks and project docs by their bare identifier/filename (e.g. IN-42, spec.md), and skills by their slug - no @ prefix. Do not wrap any of these in backticks - that makes them inert.

**Parameters:**

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `project` | `string` | No | Project slug or ID. Omit to use the project your run is already in; instance agents (CEO/Coach) must name the project to act in. |
| `filename` | `string` | Yes | Markdown filename to write (e.g. "spec.md") |
| `content` | `string` | Yes | File content (markdown) |
| `description` | `string` | No | An overall summary of what this doc is and when to read it, in no more than one or two sentences (e.g. "How we track and report campaign analytics each week"). Describe its stable purpose, not its current contents: do NOT list the sections, findings, dates, counts, or latest revisions here (those belong in the body and the `changelog`), so the description stays steady across updates. Shown next to the filename in the Documents list and the doc header so teammates and future runs can tell what the doc is without opening it. It is NOT the changelog and NOT part of the body. Omit to leave any existing description unchanged. |
| `changelog` | `string` | No | Markdown summary of what changed in THIS update and why - recorded as the revision's changelog and shown in the document's revision history. Put update/status notes here, never in the document body. Reference tasks/docs/agents by bare identifier as in content. |
| `content_length` | `integer` | No | The exact character count of `content`. When provided, a mismatch is rejected instead of stored, so an argument the runtime truncated mid-stream cannot silently overwrite the doc with a partial body (which would also delete every pending review comment on it). Strongly recommended for anything large. |
| `allow_empty` | `boolean` | No | Permit an empty `content` to blank an existing non-empty doc. Off by default, because an empty body is far more often a truncated argument than an intent - and blanking also deletes every pending review comment. To retire a doc, call archive_project_doc instead. |

**Returns:** `{ written: true, id, filename }`, or `{ error }` if the filename is not `.md` or the doc is archived (unarchive first - archived docs are read-only). Make all edits in one consolidated write: a content-changing write deletes ALL pending review comments on the doc (read them first) and records a document revision, so many partial writes lose review context and bury the revision history. The optional `description` sets the doc's overall "what this is" summary - one or two sentences describing the doc's stable purpose, not its current contents (shown in the Documents list and doc header; omit to leave it unchanged). The optional `changelog` is stored as that revision's changelog and shown in the document's history - put update/status notes there, not in the document body.

### `edit_project_doc`

_Write tool._

Replace one span of a project doc, leaving the rest untouched. Prefer this over write_project_doc for any change to an existing doc: it sends only the text you are changing, so the argument stays proportional to the edit rather than to the document, which keeps a large doc out of reach of a runtime's tool-call argument-size cap. These docs live in the database, not the filesystem - the Write/Edit file tools target disk and will not touch them. `old_string` must match the current text EXACTLY, including indentation and line breaks: read the doc first and copy the span verbatim rather than retyping it. It must also be unique - if it matches several places the call is refused, so extend it with surrounding lines until it is unique, or pass replace_all to change every match. The result returns the applied hunk with surrounding context plus the doc's new `content_length`, so you can confirm what landed without reading the doc again. Like any content-changing write this records a revision and clears the doc's pending review comments, so capture those first.

**Parameters:**

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `project` | `string` | No | Project slug or ID. Omit to use the project your run is already in; instance agents (CEO/Coach) must name the project to act in. |
| `filename` | `string` | Yes | Markdown filename to edit (e.g. "spec.md") |
| `old_string` | `string` | Yes | The exact text to replace, copied verbatim from the doc (including indentation and line breaks). Must be unique in the doc unless replace_all is set. |
| `new_string` | `string` | Yes | The text to put in its place. May be empty to delete the span. |
| `replace_all` | `boolean` | No | Replace every occurrence of `old_string` rather than requiring it to be unique. Use for a rename that legitimately recurs; otherwise prefer extending `old_string` so the edit is unambiguous. |
| `changelog` | `string` | No | Markdown summary of what changed in THIS edit and why - recorded as the revision's changelog. Put update/status notes here, never in the document body. |

**Returns:** `{ edited: true, id, filename, replacements, content_length, hunk }` - `hunk` is the applied change with surrounding context and line numbers, and `content_length` the doc's new size, so you can confirm what landed without reading the doc back. Returns `{ error }` if the doc does not exist (create one with write_project_doc), is archived, or `old_string` is empty, unchanged, absent, or matches more than one place without `replace_all` - the ambiguous case is refused rather than guessing which match you meant. Prefer this over write_project_doc for any change to an existing doc: the argument scales with the edit rather than the document, which keeps a large doc clear of a runtime's tool-call argument-size cap. Like any content-changing write it records a revision and clears the doc's pending review comments. A `warning` is returned when a supplied `changelog` had no revision to land on.

### `archive_project_doc`

_Write tool._

Archive a project doc - the reversible soft delete, and the ONLY way an agent retires a doc (hard deletion is admin-only, so treat any "delete this doc" instruction as archive). The doc disappears from list_project_docs, default reads, and future runs' context, but keeps its filename reserved and its revision history; existing references keep resolving. Reverse with unarchive_project_doc. No approval needed.

**Parameters:**

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `project` | `string` | No | Project slug or ID. Omit to use the project your run is already in; instance agents (CEO/Coach) must name the project to act in. |
| `filename` | `string` | Yes | Doc filename to archive (e.g. "old-plan.md") |

**Returns:** `{ archived: true, filename, changed }` (`changed: false` when it was already archived - the call is idempotent), or `{ error }` if the file is not found. The archived doc leaves listings, search, and agent-run context but keeps its filename reserved and its revision history. While archived it is read-only: no writes and no revision restores until unarchive_project_doc restores it.

**Authorization:** Archival is the agent-facing soft delete; hard deletion of docs is admin-only in the web app.

### `unarchive_project_doc`

_Write tool._

Restore an archived project doc to active. It reappears in list_project_docs and agent-run context, and becomes readable and writable again with its content and revision history intact.

**Parameters:**

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `project` | `string` | No | Project slug or ID. Omit to use the project your run is already in; instance agents (CEO/Coach) must name the project to act in. |
| `filename` | `string` | Yes | Doc filename to restore (e.g. "old-plan.md") |

**Returns:** `{ archived: false, filename, changed }` (`changed: false` when it was already active), or `{ error }` if the file is not found. Restoring is recorded in the project activity log, naming the task and run it came from - so restore a doc because it is genuinely back in use, not merely to get around the archived-write refusal.

## Costs

### `get_costs`

_Read-only._

Get the cost summary for a project. Ungrouped returns a single total. group_by: 'agent' returns one row per agent (bounded by the roster). group_by: 'day' returns one row per day, newest first - that set grows for as long as the project runs, so it is paged: it returns `limit` days (default 50) plus `next_cursor`/`has_more`, and when `has_more` is true you call again with `cursor` set to `next_cursor` until it is false.

**Parameters:**

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `project` | `string` | No | Project slug or ID. Omit to use the project your run is already in; instance agents (CEO/Coach) must name the project to act in. |
| `group_by` | `agent` \| `day` | No | Group costs by |
| `limit` | `integer` | No | Max rows to return in this page (default 50, ceiling 200). |
| `cursor` | `string` | No | Opaque cursor from a previous call. Pass back the `next_cursor` you were given to fetch the following page; keep going until `has_more` is false. Treat it as opaque - do not construct or parse one. |

**Returns:** With `group_by: "agent"`, an array of `{ member_id, agent_title, total_cents }` (bounded by the roster). With `group_by: "day"`, day rows `{ day, total_cents }` newest-first Paged: returns `{ items, next_cursor, has_more }` - follow `next_cursor` until `has_more` is false. - that set grows for the life of the project, so it is the one grouping that pages. Otherwise `{ total_cents, entry_count }`.

## Onboarding

### `register`

_Read-only._

Register this agent with Hezo. Returns an access token (shown once) - set it as your `Authorization: Bearer` token. The registration is inert until a Hezo admin approves it under Settings → API keys; once approved you have full instance access (every project and team). Poll `connection_status` to learn when you are approved.

**Parameters:**

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `name` | `string` | Yes | A human-readable name for this agent, shown to the admin who approves it. |
| `client_info` | `object` | No | Optional MCP client info (e.g. {"name":"claude","version":"…"}). |

**Returns:** `{ id, token, status, message }` - the `hezo_…` token is shown once. Returns `{ error }` if `name` is missing.

**Authorization:** No token required - this is how an external agent self-registers. The registration stays inert until a Hezo admin approves it.

### `connection_status`

_Read-only._

Check whether this agent has been approved yet. Send your token as the `Authorization: Bearer` token. Returns {"status":"pending"} or {"status":"approved"}.

**Parameters:** none.

**Returns:** `{ status: "pending" | "approved" }`, or `{ error }` if no/unknown token is sent.

**Authorization:** Keyed by the bearer token from `register`; no approved principal required.

---

Generated from the MCP tool registry. Full docs: https://hezo.ai/docs/introduction
