# Data Model — Design Decisions

## Tables and functions

| Table | Purpose | Key relationships |
|-------|---------|-------------------|
| `system_meta` | Key-value config store. Holds master key canary. | Standalone. |
| `users` | Global human identity. Display name, avatar. One per human across all teams. | Standalone (identity). |
| `user_auth_methods` | OAuth login methods (GitHub, GitLab). Links provider identity to user. | belongs to user |
| `members` | Base table for all team participants (agents and users). Has `member_type` enum discriminator. Shared UUID used by child tables. | belongs to team |
| `member_agents` | Agent-specific extension. System prompt, runtime type, `default_effort` (reasoning level applied to runs), budget, heartbeat, org chart, `summary` (auto-generated agent description, ≤5 lines), `touches_code` (capability flag used by the job manager to gate runs on designated-repo setup). `model_override_provider` + `model_override_model` let a single agent target a specific provider/model; when set they take precedence over the instance-default provider and the provider config's `default_model` (both must be set together — enforced by `model_override_requires_provider` CHECK). References agent_type_id for provenance. | extends member (PK = member.id), optionally references agent_type |
| `member_users` | User-in-team extension. Role (board/member), role_title, permissions_text, project_ids. Links to global user. | extends member (PK = member.id), references user |
| `agent_types` | First-class agent type catalog. Each type defines a role template: name, slug, system prompt template, default runtime config, budget, `default_summary` (pre-generated description loaded from `packages/server/src/db/agent-summaries.json`), `touches_code` (default capability flag — seeded true for builder roles, copied onto `member_agents` at hire time). Built-in types ship with Hezo; custom types can be user-created; remote types can be loaded from hezo connect. | Referenced by team_template_agent_types, member_agents. |
| `team_templates` | Team blueprints (team type recipes). Groups of agent types plus default skills, preferences, MCP servers, `default_summary` (pre-generated team collaboration description). | Referenced by team_template_assignments. |
| `team_template_agent_types` | Join table linking team types to agent types. Stores org chart hierarchy (reports_to_slug) and per-team-type config overrides (runtime type, heartbeat, budget). | belongs to team_template + agent_type |
| `teams` | Top-level tenant. Has `mcp_servers` (JSONB), `mpp_config` (JSONB), `settings` (JSONB), `summary` (auto-generated team collaboration description, ≤20 lines). No team budget — budgets live on agents/projects. | Parent of everything. |
| `team_template_assignments` | Many-to-many join table linking teams to the team types they were created from. | belongs to team + team_template |
| `invites` | Pending invitations. Carries role, title, permissions, project scope. | belongs to team |
| `api_keys` | Team-scoped keys for external orchestrators. Stored bcrypt-hashed. | belongs to team |
| `projects` | Group of related work under a team. Has `task_prefix` (2–4 uppercase chars used for task identifiers), Docker container config, dev ports, designated repo. `is_internal` flag marks auto-created projects (e.g. Internal) that cannot be deleted. | belongs to team |
| `repos` | Git repo (GitHub only). Stores `org/repo` identifier; the repo name (segment after the owner) is the display label, directory name, and @-mention handle. | belongs to project |
| `tasks` | Ticket. Must have a project. Linear-style `identifier` (e.g. `IN-42`) built from the project's `task_prefix` + per-project number. Assignee references `members.id`. Has `rules` (approach instructions) and `progress_summary` (agent-maintained status). | belongs to team + project, assigned to member |
| `task_dependencies` | Many-to-many blocking relationships between tasks. | links task ↔ task |
| `task_comments` | Thread entries. Polymorphic via `content_type` + `content` JSONB. Includes execution-type comments auto-created when agent runs complete. | belongs to task |
| `task_attachments` | Links uploaded files to tasks. | links asset ↔ task |
| `tool_calls` | Trace log entries. Linked to a comment (the agent message that triggered them). | belongs to comment + member_agent |
| `secrets` | Encrypted key/value. Scoped to team or team+project; `team_id NULL` = an instance-level credential shared with every team's egress (Admin-managed, unique by name). | belongs to team (or instance), optionally project |
| `secret_grants` | Which agent has access to which secret. Revocable. | links secret ↔ member_agent |
| `approvals` | Pending board decisions. Polymorphic payload. | belongs to team, requested by member_agent |
| `cost_entries` | Immutable spend records per agent per task. | belongs to team + member_agent, optionally task/project |
| `audit_log` | Append-only activity trail. `team_id` is nullable (NULL = an instance-level admin action not bound to a team); `project_id` is nullable (set for project-scoped events). Read at three scopes: instance (`GET /api/audit-log`, superuser), team, and per-project. | optionally team, optionally project |
| `documents` | Unified Markdown document store keyed by `type` (`project_doc` / `team_preferences` / `agent_system_prompt`). Project docs scope by `(project_id, slug)`; preferences by `(team_id)` (one per team); agent system prompts by `(member_agent_id)` (one per agent). Embeddings live on this table for project docs. The team-level reference store is the `skills` table, not this one. | belongs to team, optionally project or member_agent |
| `document_revisions` | Snapshot of prior content created on every change. `change_summary` captures intent; `Restored to revision N` is set automatically by the rollback path. Shared by all document types — agent system prompt history lives here too. | belongs to document |
| `connected_platforms` | OAuth connections to external services. Tokens stored in secrets. | belongs to team |
| `team_ssh_keys` | Generated SSH key pairs per team. Private key stored encrypted in secrets vault. Registered on GitHub via OAuth API. | belongs to team |
| `execution_locks` | Task work ownership tracking. Read/write locks — multiple readers (reviewers) or one exclusive writer. | belongs to task + member_agent |
| `skills` | The reference store (unified skills database). Each row has `name`, `slug`, `description`, `content`, optional `source_url` (set for downloaded skills), `content_hash`, `tags`, `is_active`, `embedding`. Authored manually in the UI, created by agents via MCP, or downloaded from a URL. Surfaces in `semantic_search` and is injected into runs as a manifest. `team_id NULL` = an instance-level skill shared with every team (Admin-managed, unique by slug). | belongs to team (or instance) |
| `skill_revisions` | Version history for skills — a snapshot row on every content change. | belongs to skill |
| `agent_wakeup_requests` | Wakeup queue with coalescing and idempotency. Every run row points back to the wakeup that triggered it via `heartbeat_runs.wakeup_id`. | belongs to member_agent + team |
| `heartbeat_runs` | One row per agent execution. Status, timing, usage, logs. Links to the task being worked on via `task_id`, and to the wakeup that triggered the run via `wakeup_id`. | belongs to member_agent + team, optionally task, optionally wakeup |
| `agent_task_sessions` | Per-task session persistence for session compaction. | belongs to member_agent, keyed by task |
| `assets` | Uploaded files. Provider, object key, content type, SHA-256 hash. | belongs to team |
| `plugins` | Installed plugins. Manifest, status, config. | belongs to team |
| `plugin_state` | Scoped key-value store for plugin data. | belongs to plugin + team |
| `plugin_jobs` | Cron job declarations for plugins. | belongs to plugin |
| `instance_user_roles` | Instance-level admin roles for users. First user gets instance_admin. | belongs to user |
| `project_task_counters` | Helper for atomic task numbering per project. | belongs to project |
| `notification_preferences` | Per-user notification routing (web/telegram/slack). Event types, enabled flag. | belongs to user |
| `slack_connections` | Per-team Slack app config. Bot token encrypted in secrets. | belongs to team |
| `ai_provider_configs` | Instance-level AI provider credentials shared across every team in the Hezo instance. The `provider` enum is `anthropic \| openai \| google \| deepseek`; each value carries its own runtime mapping, env-var contract, and (optionally) static env entries via `PROVIDER_RUNTIME_ADAPTERS` in `packages/shared/src/types/common.ts`. Multiple providers can target the same runtime (Anthropic and DeepSeek both run via `claude_code`, with DeepSeek injecting `ANTHROPIC_BASE_URL` + model defaults to point Claude Code at DeepSeek's Anthropic-compatible gateway). Each row inlines the encrypted credential (`encrypted_credential`). Auth method distinguishes API key vs subscription credential blob (DeepSeek and Anthropic do not support subscription auth). A partial unique index on `is_default` enforces one default per provider; `(provider, label)` is unique so multiple rows per provider coexist — typically one `api_key` and one `subscription` — and `getProviderCredential` / `resolveRuntimeForTask` pick the `is_default` row at runtime. When several providers share a runtime, `resolveRuntimeForTask` filters via `PROVIDERS_BY_RUNTIME[runtime]` then orders by `is_default DESC, created_at ASC`. `default_model` (nullable) holds the CLI `--model` value applied to every run that uses this config when the agent has no explicit override. Agent runner decrypts at execution time and either injects as env var (api keys) or materialises to a per-run mount inside the container (subscriptions). | instance-scoped |

## Key design decisions

### Members base table (unified identity)

Both agents and human users participate in teams as "members." The `members`
table is the base identity table for all team participants:

- `members(id UUID PK, team_id FK, member_type ENUM('agent','user'), display_name TEXT, created_at)`
- `member_agents(id PK/FK → members.id, system_prompt, default_effort, ...)` — agent-specific fields
- `member_users(id PK/FK → members.id, user_id FK → users.id, role, role_title, permissions_text, project_ids)` — user-in-team fields

`members.id` is the shared UUID — it IS the agent or user-in-team ID. No
separate FK needed. All references to assignees, authors, and actors point to
`members.id` with a single FK.

The global `users` table stores cross-team identity (display_name, avatar_url).
`user_auth_methods` stores OAuth providers (GitHub, GitLab). No email field on
users — email may be added as an auth type later.

### Custom authentication

Hezo uses custom auth (no third-party auth library). OAuth only for MVP:

- `users` — global identity, one per human
- `user_auth_methods(id, user_id FK, provider ENUM, provider_user_id, created_at)` — OAuth links
- Sessions are stateless JWTs signed with the master key. No sessions table.
- JWT contains: `{ user_id, member_id, team_id, iat, exp }`
- Always authenticated — no unauthenticated "local_trusted" mode

First-run flow: Hezo Connect must be running → user logs in via OAuth → master
key set in web UI → forced team creation.

### Polymorphic JSONB columns

`task_comments.content`, `approvals.payload`, and `audit_log.details` use JSONB
rather than separate tables per type. This keeps the schema flat and avoids
join-heavy queries for the most common operation (rendering an task thread).

The `content_type` enum discriminates the shape:
- `text` → `{ "text": "..." }`
- `options` → `{ "prompt": "...", "options": [{ "id", "label", "description" }] }`
- `preview` → `{ "filename": "...", "label": "...", "description": "..." }`
- `trace` → `{ "summary": "4 tool calls" }` (detail lives in `tool_calls` table)
- `system` → `{ "text": "...", "kind"?: "status_change" | "task_link" | <other>, ... }`. Auto-generated timeline entries. The renderer shows `text`; `kind` plus per-kind fields let the server dedup and tooling filter without re-parsing prose.
  - `status_change`: `{ "kind": "status_change", "from": "<old>", "to": "<new>", "actor_id": "<member_uuid|null>", "text": "<actor> changed status from <old> to <new>" }` — written for every task status transition.
  - `task_link`: `{ "kind": "task_link", "source_task_id": "<uuid>", "source_identifier": "<e.g. IN-42>", "actor_id": "<member_uuid|null>", "text": "Linked from <source_identifier> by <actor>" }` — written on the **target** task the first time a given source task mentions it; subsequent mentions from the same source are deduped via the `source_task_id` JSONB key.
- `execution` → `{ "heartbeat_run_id", "agent_id", "agent_title", "status", "exit_code", "duration_ms", "stdout_preview" }` (auto-created on agent run completion)
- `action` → `{ "kind": "setup_repo", "approval_id": "..." }` — surfaces a board-required action inline on the ticket. Resolves by setting `chosen_option` to `{ status: 'complete', result: {...} }`. Currently only `setup_repo` is defined, used by the designated-repo gate.

### Budget enforcement (windowed)

Budgets live on `member_agents` and `projects` as `daily_/weekly_/monthly_budget_cents`
(0 = unlimited for that window). There is **no team budget** (project-centric model).
Spend is **computed on demand** by summing `cost_entries.amount_cents` over rolling
UTC windows (`date_trunc('day'|'week'|'month', now() AT TIME ZONE 'UTC')`) — there is
no running counter to reset. The logic lives in `services/budget.ts` (`getAgentSpend`,
`getProjectSpend`, `getAgentBudgetStatus`, `getProjectBudgetStatus`, `checkOverBudget`,
`recordRunCost`), not a stored function.

A run is blocked when the agent **or** its project is over **any** window. Enforcement
points: (1) a **pre-run gate** in `JobManager.activateAgent` skips the run (no
`heartbeat_runs` row, no container/repo work), pauses the agent, and marks the wakeup
skipped with `WakeupSkipReason.OverBudget`; (2) **run completion** (`agent-runner.ts`)
records the run's cost as one `cost_entries` row and reactively pauses the agent if it
is now over; (3) the manual `POST /costs` path does the same reactive pause. Run
completion is the single source of truth for run spend — the tool-call report path
(`agent-api.ts`) records `tool_calls.cost_cents` for display only and does **not** debit
(the run total already includes tool-call cost).

### Atomic task numbering

`next_project_task_number()` uses upsert + returning to atomically assign
per-project task numbers. No gaps under normal operation.

### Master key lifecycle

The master key is held in memory only — never written to disk. On first startup
(no canary in `system_meta`), the server either uses `--master-key` from CLI or
prompts the user to generate a new key or enter an existing one. The key is
displayed once and the user is warned to write it down. A canary value
(`encrypt("CANARY", key)`) is stored in `system_meta`.

On subsequent startups, the server attempts to decrypt the canary using the
provided or prompted key. On failure, the user can re-enter a different key or
generate a new key and start fresh (all existing data is wiped).

### Secret encryption

All secret values are encrypted at the app layer using AES-256-GCM with the
`MASTER_KEY` (derived via HKDF). The DB stores ciphertext only.

Platform OAuth tokens (GitHub, Gmail, Stripe, etc.) are stored as team-scoped
secrets, managed automatically by the Hezo Connect OAuth flow. Each connected
platform has its access and refresh tokens stored as separate secrets, referenced
by ID from the `connected_platforms` table.

Team-wide secrets have `project_id = NULL`. Project-scoped secrets have both
`team_id` and `project_id` set. The unique constraint `(team_id, project_id, name)`
allows the same secret name at different scopes (e.g. a team-level secret
and a project-level secret with the same name — project scope takes precedence).

Instance-level secrets have `team_id = NULL` (and `project_id = NULL`); they are
shared with every team's egress and are unique by name across the instance
(partial unique index `WHERE team_id IS NULL`). The egress substitution loader
resolves the most specific scope on a name clash: **project > team > instance**.
The same nullable-`team_id` + partial-unique-index pattern applies to `skills`
(unique by slug) and `mcp_connections` (SaaS only, unique by name) — `team_id
NULL` means an instance-level row shared across teams, managed by the Admin.

### Repo storage and validation

The `repos.repo_identifier` column stores the `org/repo` format (e.g.
`acme-corp/frontend`). The full SSH URL (`git@github.com:org/repo.git`) is
constructed at clone time. No URL CHECK constraint — validation is at the app
layer.

The app layer performs a two-step validation before inserting:

1. **GitHub connection check** — verifies the team has an active GitHub OAuth
   connection in `connected_platforms`. If not, the request fails with
   `GITHUB_NOT_CONNECTED` and a board inbox item of type `oauth_request` is
   created to prompt the user to connect GitHub via Hezo Connect.
2. **Repo access check** — calls the GitHub API (`GET /repos/{owner}/{repo}`)
   using the OAuth token. If the connected GitHub user doesn't have access
   (403/404), the request fails with `REPO_ACCESS_FAILED` and includes the
   GitHub username so the board knows which account needs to be added.

The repo's name — `split_part(repo_identifier, '/', 2)` — is its display label
and the name of its workspace/worktree directories, so it is unique within a
project (unique expression index), even across owners. It is also used for
@-mentions in task comments (`@frontend`, `@api`).

### Designated repo immutability

The first repo linked to a project is automatically set as
`projects.designated_repo_id` and cannot be changed thereafter. The FK is
`ON DELETE RESTRICT`, so deleting the designated repo directly is blocked at
the DB level; cascade from `projects` still cleans it up cleanly because repos
are deleted before the parent project row. The `DELETE /repos/:id` route also
returns 409 `DESIGNATED_REPO_IMMUTABLE` to make the invariant explicit.

Additional (non-designated) repos can be added at any time from project
settings. They are cloned into the project container alongside the designated
repo but have no special protection.

### Setup-repo approval and action comment

Projects start without a designated repo. When an agent with
`member_agents.touches_code = true` is activated on an task whose project
still has `designated_repo_id IS NULL`, the job manager:

1. Upserts a single pending `oauth_request` approval per `(team_id,
   project_id)` with `payload.reason = 'designated_repo'`. A partial unique
   index `idx_one_pending_repo_setup` dedupes concurrent runs.
2. Inserts a comment of type `action` on the triggering task with content
   `{ kind: 'setup_repo', approval_id }`.
3. Marks the wakeup `Deferred` with `payload.reason = 'awaiting_repo_setup'`.

When the board drives the wizard to completion (via `POST /repos`):

- The repo insert atomically sets `designated_repo_id` under a `FOR UPDATE`
  lock on the project row.
- Every pending `action` comment attached to this approval gets its
  `chosen_option` set to `{ status: 'complete', result: {...} }`, and a
  `system` comment is appended per affected task.
- The approval is resolved to `approved`.
- The host workspace clone and container provisioning run post-commit.
- Each deferred wakeup is re-enqueued as a fresh `Automation` wakeup with
  `payload.reason = 'repo_setup_complete'`.

### SSH keys per team

Hezo generates an SSH key pair per team for git operations. The private key
is stored encrypted in the secrets vault. The public key is registered on the
connected GitHub account via the OAuth API (`POST /user/keys`).

The `team_ssh_keys` table tracks: `team_id`, `public_key`, `fingerprint`,
`private_key_secret_id` (FK to secrets), `github_key_id` (for cleanup on
disconnect), `created_at`.

Git clone/push/pull uses SSH with the team's generated key. GitHub OAuth
token is used for API calls (repo validation, PRs, Actions).

### Audit log immutability

The `audit_log` table has no `updated_at`. The app layer never issues UPDATE or
DELETE on this table — rows are written once by the audit observer and only ever
read. The two FK-driven exceptions are referential, not content edits: a deleted
team cascade-deletes its rows (`team_id ... ON DELETE CASCADE`) and a deleted
project nulls the back-reference (`project_id ... ON DELETE SET NULL`), so a
blanket `DO INSTEAD NOTHING` rule on UPDATE/DELETE is intentionally **not**
added (it would break those FK actions). Immutability is enforced at the app
layer: the observer is the only writer, and nothing else touches the table.

### Budget windows (no resets)

There is no reset bookkeeping. Each window's spend is the sum of `cost_entries`
since the window's UTC start (today / this ISO-week / this month), so windows
"reset" implicitly as the clock advances. Limits are `daily_/weekly_/monthly_budget_cents`
on `member_agents` and `projects`; 0 means unlimited.

When an agent goes over budget it is paused (`runtime_status = 'paused'`) and its
pending wakeup is skipped — no run is started. The board can raise the limit or
wait for the window to roll over; the next eligible wakeup then runs.

### Preview files (not in DB)

HTML previews are ephemeral filesystem artifacts, not DB records. The agent writes
to `/workspace/.previews/{agent_id}/` inside the project container, which is
visible on the host via the shared workspace volume at:
```
~/.hezo/teams/{slug}/projects/{project}/.previews/{agent_id}/
```
The web app serves these via `/preview/{team_id}/{project_id}/{agent_id}/{filename}`.
A cron job expires files older than 72 hours. The only DB reference is the
`preview` content_type in `task_comments` which stores the filename.

### API keys for external orchestrators

The `api_keys` table stores team-scoped API keys for remote access by
OpenClaw, scripts, or other AI agents orchestrating Hezo. Keys are bcrypt-hashed
— the raw key is shown once at creation and never returned again. A `prefix`
column stores the first 8 characters for display ("hezo_a3b8...").
`last_used_at` is updated on each authenticated request.

Keys use the `hezo_` prefix to distinguish them from agent JWTs during auth
middleware parsing.

### Agent slugs and @-mentions

Each agent has a `slug` derived from its title (lowercased, spaces → hyphens).
For example, "Dev Engineer" → `dev-engineer`. Slugs are unique within a team
(enforced via `members.team_id` + `member_agents.slug` unique index) to
ensure unambiguous @-mentions.

All inter-agent communication happens via @-mentions in task comments — no
side channels, no direct messaging. The server parses `@<slug>` from comment
text and creates notifications for mentioned agents. Repo names can also
be @-referenced (`@frontend`, `@api`).

### Subagents

Agents can spawn subagents using their runtime's native parallelism (Claude
Code subagents, Codex parallel tasks). These are ephemeral child processes
inside the parent's subprocess — not Hezo agents. They share the parent's budget
and secrets. Tool calls are reported under the parent. Hezo does not manage
their lifecycle.

### MCP servers

Both `teams.mcp_servers` and `member_agents.mcp_servers` are JSONB arrays
storing manually configured MCP server entries:
`[{ "name": "...", "url": "...", "description": "..." }]`.

At runtime, the effective MCP server list is computed by merging:
1. Manually configured team-level servers (`teams.mcp_servers`)
2. Manually configured agent-level servers (`member_agents.mcp_servers`)
3. Active connected platforms (auto-derived from `connected_platforms` table)

Agent-level takes precedence on name conflicts with team-level. Connected
platform servers are added automatically — they are NOT written to the JSONB
columns. The merged list is injected into the agent's subprocess runtime
configuration.

### Team Settings

`teams.settings` is a JSONB object for team-level configuration:
```json
{
  "wake_mentioner_on_reply": true
}
```

- `wake_mentioner_on_reply` — when true, replying to an @-mention on a ticket wakes the original mentioner. Default true.

Settings are merged on PATCH (`settings = settings || $1::jsonb`), so partial updates preserve existing keys.

### MPP (Machine Payments Protocol)

`teams.mpp_config` is a JSONB object:
```json
{
  "wallet_address": "0x...",
  "wallet_key_secret_name": "MPP_WALLET_KEY",
  "default_currency": "USD",
  "enabled": false
}
```

The wallet private key is not stored in `mpp_config` — it lives in the
`secrets` table, referenced by `wallet_key_secret_name`. When MPP is enabled,
the project container gets `mppx` CLI and wallet credentials are injected into agent subprocesses. Every MPP
payment is reported as a tool call cost (`tool_calls.cost_cents`) for display; the
run's total cost is recorded once at run completion and counts against the agent's
windowed budgets (see "Budget enforcement (windowed)").

### Team onboarding

When a team is created via `POST /teams`, the server automatically:
1. Creates the `~/.hezo/teams/{slug}/` folder structure
2. Creates the full 11-agent team (Captain, Product Lead, Architect, Engineer, QA Engineer,
   Security Engineer, UI Designer, DevOps Engineer, Marketing Lead, Researcher, Coach)
   with pre-filled system prompts from built-in role templates. DevOps Engineer starts
   in `idle` status.
3. Prompts the owner to connect platforms via OAuth (GitHub required, Gmail recommended)
4. Creates an "Internal" project (`is_internal = true`) with an onboarding task assigned to the Captain
5. Generates an SSH key pair for the team and registers it on the connected GitHub account
6. Auto-generates the team AGENTS.md KB doc with default engineering rules and writes it to disk
7. Auto-provisions a Docker container for the Internal project in the background

This ensures the user never lands on an empty team.

### Team type provisioning

`POST /teams` accepts an optional `template_id` (a single team type UUID). The server provisions
agents from the selected team type via the `team_template_agent_types` join table:

1. Queries `team_template_agent_types JOIN agent_types` for the selected template, ordered by `sort_order`
2. For each agent type, creates `members` + `member_agents` rows with:
   - `agent_type_id` set to the originating agent type (for provenance tracking)
   - System prompt copied from `agent_types.system_prompt_template`
   - Config overrides applied from the join table (runtime type, heartbeat, monthly budget)
4. Second pass resolves `reports_to_slug` → `reports_to` UUID for the org chart
5. Creates `skills` rows from the team type's default skills
6. Creates `documents` row of type `team_preferences` from `team_templates.preferences_config`
7. Copies `mcp_servers` array from team type
8. Copies `mpp_config` structure (with `enabled: false` — wallet keys must be set up fresh)
9. Inserts rows into `team_template_assignments` to record the association

Project containers are provisioned when projects are created (not at team creation).

NOT copied: projects, repos, tasks, secrets, cost_entries, audit_log, api_keys,
secret_grants, approvals, connected_platforms, SSH keys. Platform connections
and SSH keys are generated fresh for each team.

### Agent types

Agent types are a first-class entity in the `agent_types` table. Each type
defines a reusable role template with a system prompt template, default config
(runtime type, heartbeat interval, monthly budget), and metadata.

**Sources:**
- `builtin` — shipped with Hezo (11 built-in types: Captain, Product Lead, Architect, Engineer, QA Engineer, Security Engineer, UI Designer, DevOps Engineer, Marketing Lead, Researcher, Coach). Security Engineer reports to Architect. Coach is a standalone role that reviews completed tickets to extract lessons and improve system prompts.
- `custom` — created by users for their specific needs
- `remote` — loaded from hezo connect marketplace (future)

The `source_url` and `source_version` fields support future remote type loading
without schema changes.

Agent types are linked to team types through the `team_template_agent_types`
join table, which stores:
- `reports_to_slug` — org chart hierarchy specific to this team type composition
- Override columns — allow a team type to customize an agent type's defaults
  (`heartbeat_interval_override`, and the per-window budget overrides
  `monthly_budget_override` / `daily_budget_override` / `weekly_budget_override`,
  nullable; an unset override falls back to the agent type / unlimited). Cloning a
  team snapshots its agents' live daily/weekly/monthly budgets into these columns.
- `sort_order` — ensures parents are created before children during agent provisioning

When agents are created from a team type, `member_agents.agent_type_id`
records which agent type was used. This is for provenance tracking only — the
system prompt is copied at creation time, giving each agent instance its own
mutable copy.

### Agent and team auto-descriptions

Each agent has a `summary` (TEXT, ≤1000 chars) on `member_agents` — a short
auto-generated description of the agent's role and capabilities (≤5 lines).
Each team has a `summary` (TEXT, ≤4000 chars) on `teams` — a
description of how the team collaborates (≤20 lines).

**Pre-baked defaults:** Built-in agent types carry a `default_summary` on
`agent_types`, loaded from committed source data at
`packages/server/src/db/agent-summaries.json`. Team types carry a
`default_summary` on `team_templates`. These defaults are copied to
`member_agents.summary` and `teams.summary` during team
provisioning.

**Runtime updates:** The Captain agent regenerates descriptions at runtime by
processing `team-coherence-review` tasks (created in the Internal project on
every roster, prompt, or summary change). One task covers the org-chart audit
AND the descriptive blobs for every affected agent. Three MCP tools —
`set_agent_summary`, `set_agent_team_context`, and `set_team_summary` — write
the new text directly to the database. Only agents and board members within
the team can set agent summaries; only the Captain agent can set the team
summary.

### Agent system prompts

Agent system prompts live as `agent_system_prompt` documents, one per agent,
keyed by `(team_id, member_agent_id)`. Reads go through the unified
`documents` service; history, restore, and WS broadcasts are inherited from
the document revisioning machinery. There is no dedicated agent self-update
endpoint — agents cannot change their own prompts. Only the Coach agent (via
the `update_agent_system_prompt` MCP tool) and the board (via
`PATCH /teams/:teamId/agents/:agentId` with a `system_prompt` field)
can write. Coach writes apply immediately and a revision snapshot is recorded
for undo; the board surface is the revisions panel on the agent settings page.

### Documents

`documents` is a single table that backs three kinds of Markdown content,
distinguished by the `type` column (`project_doc` /
`team_preferences` / `agent_system_prompt`). The same write path, revision
capture, restore, embedding, and broadcast logic apply to all of them;
per-type quirks (URL surface, agent approval gates) live in thin route
handlers.

Scoping is enforced by partial unique indexes:

- `project_doc` — unique on `(project_id, slug)`. Slug holds the filename
  (e.g. `spec.md`); `title` is empty (the filename is the display label).
- `team_preferences` — partial unique on `(team_id)` with slug fixed
  to `preferences`. Enforces one row per team.
- `agent_system_prompt` — partial unique on `(member_agent_id)` with slug
  fixed to `system-prompt`. Enforces one row per agent; a CHECK constraint
  requires `member_agent_id IS NOT NULL` for this type.

Every content change snapshots the prior content into `document_revisions`
with an auto-incremented `revision_number` per document, the change summary,
and the author. Restore is board-only: it inserts a fresh revision capturing
the pre-restore content (`change_summary = 'Restored to revision N'`,
`author_member_id = the restoring board user`), then writes the historic
content back to the parent row.

Project doc PRD updates (`slug = 'prd.md'`) from agents create a Strategy
approval instead of writing directly. Preferences updates from agents apply
directly. Approval apply paths flow through the same `upsertDocument` service
so revisions are recorded on materialisation. Team-level reference content is
not a document type — it lives in the `skills` table (see the Skills database).

The `{{team_preferences_context}}` and `{{project_docs_context}}` template
variables in system prompts pull from this table filtered by type, so agents
see the current document set. Team skills are injected separately as a manifest
via `{{skills_context}}` (see the Skills database) — not from this table.

AGENTS.md remains a filesystem file in the repo (git tracks its history) and
is not part of the documents table.

**AGENTS.md** is a filesystem file that contains team-wide engineering rules
and agent conventions, written to the project root (`AGENTS.md`) so that any
coding agent (Claude Code, Codex, Gemini) automatically reads it.

### Connected platforms (Hezo Connect)

`connected_platforms` stores OAuth connections to external services. Each team
can have one connection per platform (enforced by `UNIQUE (team_id, platform)`).

The table references the `secrets` table for token storage — `access_token_secret_id`
and `refresh_token_secret_id` point to encrypted secret entries. This means tokens
benefit from the same AES-256-GCM encryption as all other secrets.

**OAuth flow:**
1. User initiates connection via the Hezo UI
2. Hezo app redirects browser to Hezo Connect (self-hosted or centrally hosted)
3. Hezo Connect handles the OAuth dance with the provider
4. Hezo Connect redirects the browser back to the Hezo app's callback URL with tokens as query params
5. Hezo app verifies the state signature (fetched from Connect's public key endpoint), encrypts tokens, stores them as secrets, creates the connection record
6. Hezo Connect purges tokens from memory — it never stores them long-term

Token delivery uses browser redirects rather than server-to-server POST calls.
This keeps the architecture simple and avoids Connect needing to make outbound
HTTP calls to the local Hezo instance. In self-hosted mode, Hezo Connect is
stateless — no database needed, just OAuth app credentials as environment variables.

**State signing:** Hezo Connect generates the signing key and exposes it via a
public endpoint (`GET /signing-key`). The Hezo app fetches it on startup — no
shared secret configuration needed.

**Platform token access:** All agents in a team automatically receive all
connected platform OAuth tokens as environment variables in their subprocess.
No per-agent role-based filtering — all agents get all tokens.

**Token lifecycle:**
- Access tokens are refreshed automatically by the Hezo app using the stored
  refresh token. No round-trip to Hezo Connect needed for refresh.
- If refresh fails (user revoked access, token expired), `status` is set to
  `expired` and the board is notified to re-authorize.
- The `metadata` JSONB column stores platform-specific data like the GitHub
  username, Gmail address, or Stripe account ID.

**MCP auto-registration:** When a platform is connected, it is automatically
added to the team's `mcp_servers` list so agents can discover and use the
platform's tools via MCP tool calls.

**Self-hosting:** Users who want full control can deploy their own Hezo Connect
instance, register their own OAuth apps with each provider, and point their
Hezo app to it via `--connect-url`.

### Task identifiers (Linear-style)

Each project has an `task_prefix` column (2–4 uppercase alphanumeric chars,
e.g. `OP` for "Internal", `WA` for "Web App") auto-derived from the project
name at creation time. Single-word names use the first two characters;
multi-word names use the initials, capped at four characters. Callers may
override via the project-creation `task_prefix` field. On collision within a
team, a numeric suffix is appended (`OP`, `OP2`, `OP3`). Prefixes are
unique per team, not globally.

Tasks have an `identifier` column computed at creation as `{project_prefix}-{number}`
(e.g. `IN-42`), with `number` being the per-project task counter. Identifiers
are unique per team. The identifier is the primary human-facing reference
for tasks — used in UI, API responses, @-mentions (`@IN-42`), and git branch
names. Identifiers are frozen at creation time: renaming a project does not
retroactively change the prefix on existing tasks.

### Task assignees

Tasks have a required `assignee_id` FK pointing to `members.id`. Every task
must have an assignee — the API enforces this on creation and prevents
unsetting it. Both agents and human users (board members and team members)
can be assigned tickets.

When a human is assigned an task, they can work on it outside Hezo, pass it
to another member (human or agent), or @-mention an agent in a comment to
request specific help. When an agent is assigned, the standard agent execution
flow applies.

### Execution locks (observational)

The `execution_locks` table tracks which agents are currently running against an task:
- `task_id` FK
- `member_id` FK → members.id
- `lock_type` TEXT — retained from an earlier read/write design; every active lock is `'read'` under the current model
- `locked_at` timestamp
- `released_at` timestamp (soft delete)

Locks are observational, not exclusive — multiple agents can run against the same task concurrently, with one active lock row per agent. The only acquisition guard is per-agent-per-task: a second wakeup for an agent that already holds an active lock on that task is coalesced (deferred). This lets a comment that @-mentions several agents trigger concurrent runs while still driving the "currently running" display on the task page.

### Task dependencies

The `task_dependencies` join table enables many-to-many blocking:
- `task_id` FK — the task that is blocked
- `blocked_by_task_id` FK — the task that blocks it
- `UNIQUE(task_id, blocked_by_task_id)` — no duplicate dependencies
- `CHECK(task_id != blocked_by_task_id)` — no self-blocking

An task's `status` can be set to `blocked` when it has unresolved dependencies.

### Wakeup queue

`agent_wakeup_requests` stores all triggers (timer, assignment, mention, reply,
etc.) with deduplication via `idempotency_key` and coalescing via
`coalesced_count`. Multiple wakeups for the same agent merge context snapshots
instead of creating duplicate runs.

Event-based triggers (@-mention, reply, assignment, option chosen, approval
resolved) wake agents immediately — they do not wait for the next scheduled
heartbeat. Scheduled heartbeats are a fallback for idle agents with no pending
events.

`wakeup_source` values:

| Source | Fires when |
| --- | --- |
| `heartbeat` | Scheduled heartbeat tick (fallback for idle agents). Payload: `{ reason: 'scheduled_heartbeat' }`. |
| `timer` | Recovery timer (orphan detector, container restart, retry of a failed run). Payload typically carries `{ reason, ... }` describing which recovery path fired it. |
| `assignment` | Task assigned to the agent (incl. `create_task` tool). |
| `on_demand` | Admin/API explicit wake. Also created synthetically when `runAgent` is invoked without an explicit wakeup (e.g., direct test harness calls), so every run is anchored to a wakeup row. |
| `mention` | A comment contains `@<agent-slug>` referencing this agent. |
| `automation` | Server-side automation rule. |
| `option_chosen` | Board user resolved an options comment. |
| `comment` | Opt-in wake of the task assignee from a plain Board comment (`wake_assignee=true`). |
| `reply` | An agent whose run was mention-triggered posts a comment in the triggering ticket. The original mentioner (when an agent) is woken so it can pick up the response. Gated by `teams.settings.wake_mentioner_on_reply` (default `true`). Payload: `{ source, task_id, comment_id, triggering_comment_id, responder_member_id }`. Idempotency key: `reply:<triggering_comment_id>:<reply_comment_id>`. |

### Team settings (`teams.settings` JSONB)

Per-team toggles stored in the `teams.settings` JSONB column. Patched
via `PATCH /api/teams/:id` (shallow merge — missing keys preserve existing
values).

| Key | Default | Effect |
| --- | --- | --- |
| `wake_mentioner_on_reply` | `true` | When true, an agent's reply to a mention-triggered comment wakes the original mentioner. When false, the mentioner picks up replies on its next heartbeat — useful when one comment @-mentions several agents and the mentioner prefers to batch their responses. |

### Reasoning effort

Each agent run picks a reasoning effort level from the `agent_effort` enum
(`minimal | low | medium | high | max`). The effective level is resolved at
activation time with this precedence:

1. An explicit `effort` value on the triggering wakeup payload — set by a
   human who posted a comment or by an MCP caller that wants to bump up
   reasoning for a specific run.
2. The agent's `member_agents.default_effort` column (copied from
   `agent_types.default_effort` at team creation time).
3. The global `DEFAULT_EFFORT` fallback (`medium`).

Planning-heavy roles (Captain, Architect) default to `max` so their plans go
through ultrathink; implementers default to `medium`. Each runtime translates
the resolved level to its native knob:

- `claude_code` → appends `think` / `think hard` / `ultrathink` to the task prompt.
- `codex` → passes `-c model_reasoning_effort=<level>` (with `max` mapped to `high`).
- `gemini` → sets `GEMINI_REASONING_EFFORT` in the container env.

The resolved level is also exposed to the container as `HEZO_AGENT_EFFORT`
so agent-side tooling can read it.

### Session compaction

`agent_task_sessions` stores per-task session state (keyed by agent member_id +
task_key). Each heartbeat spawns a fresh subprocess — handoff markdown from the
previous session is injected as initial context. Compaction policies auto-rotate
sessions when token/run/age thresholds are exceeded, generating handoff markdown
for continuity.

### Heartbeat runs

`heartbeat_runs` stores one row per agent execution with full traceability.
Each row captures:

- **Trigger**: `wakeup_id` references the `agent_wakeup_requests` row that
  caused the run to start. Every run produced by the production paths (job
  manager wakeup processing, scheduled heartbeats) is anchored to a wakeup
  row, so "why did this run start?" is always answerable by joining
  `heartbeat_runs` → `agent_wakeup_requests` and reading `source` + `payload`.
  This is what powers the "Triggered by" line on the run-detail page.
- **Timing**: `started_at` (`NOT NULL DEFAULT now()`), `finished_at`, `status`
  (`queued` → `running` → `succeeded` / `failed` / `cancelled` / `timed_out`),
  `exit_code`.
- **Invocation**: `invocation_command` is the exact CLI that was passed to
  `docker exec` (with the agent JWT redacted to `Bearer ***`). `working_dir` is
  the container path the exec was rooted at (normally the designated repo's
  per-task worktree, e.g. `/worktrees/<task-identifier>/<repo-name>`).
- **Logs**: `log_text` holds interleaved stdout and stderr captured from the
  streaming Docker exec, capped at 1 MB (with a `...[truncated — log capped at
  N bytes]` marker when exceeded). Stderr lines are prefixed `[stderr] ` so
  consumers can tint them without needing a second column. The same stream is
  broadcast live over the `project-runs:<projectId>` WebSocket room as each
  chunk arrives, so a run's detail page and the associated task page can
  render output in real time.
- **Usage**: `input_tokens`, `output_tokens`, `cost_cents`.
- **Retry tracking**: `retry_of_run_id`, `process_loss_retry_count`,
  `process_pid` — the orphan detector uses these to recover runs whose process
  disappeared.

### Workspaces, repos, and worktrees

Each project has a single container and a per-project directory on disk that
is bind-mounted into the container:

- `<dataDir>/teams/<team-slug>/projects/<project-slug>/workspace/` ↔
  `/workspace/` in the container. For every repo linked to the project,
  `ensureProjectRepos` populates a subdirectory `<workspace>/<repo-name>/`
  (the repo name is the segment after the owner in `repo_identifier`).
  The repo-add route (`POST /repos`), container provision, and the agent
  runner all call this helper, so the set of on-disk clones stays in sync
  with the `repos` rows for the project.
- `<dataDir>/.../worktrees/` ↔ `/worktrees/` in the container. For each task
  an agent works on, the runner creates `git worktree` directories under
  `/worktrees/<task-identifier>/<repo-name>/` on the branch
  `hezo/<task-identifier>`. Worktrees persist across runs on the same task
  so iterative work survives between invocations, and are torn down when the
  task transitions to a terminal status (`done`, `cancelled`, etc.) or its
  repo is detached.
- The agent's working directory resolves to the designated repo's worktree
  when repos are present, otherwise falls back to `/workspace` with a warning
  so that projects without a designated repo still run.

### Document revisions

`document_revisions` stores version history for every row in `documents`
regardless of type. Each edit captures the prior content, change summary,
and author. Restore (board-only) snapshots the current content as a new
revision before reverting the parent row, so nothing is lost.

### Auth and roles

Hezo uses custom auth. All users authenticate via GitHub or GitLab OAuth
(email/password deferred to post-MVP). Sessions are stateless JWTs signed
with the master key — no sessions table.

The `users` table stores global identity (display_name, avatar_url).
`user_auth_methods` stores OAuth provider links (provider, provider_user_id).

`member_users` links users to teams with two roles: `board` (full authority)
and `member` (scoped authority). Members have a `role_title` (arbitrary, e.g.
"Frontend Developer"), `permissions_text` (free-text description of what they
can do, injected into agent prompts), and optional `project_ids` (JSONB array
restricting which projects they can access). Board members always have full access.
A user can belong to multiple teams — each team membership is a separate
`members` + `member_users` row pair.

Permission enforcement is two-layered: the API layer enforces structural
boundaries (project scope, board-only endpoints), while agents interpret
`permissions_text` to respect behavioral boundaries (e.g. "cannot modify
PRDs — escalate to Captain").

`invites` carries the intended role, title, permissions, and project scope.
These fields are copied to `member_users` when accepted.

Board member conflicts are resolved first-come-first-served — the first board
member to approve or deny a request locks the decision.

### File attachments

`assets` stores uploaded file metadata (content type, byte size, SHA-256 hash,
original filename), scoped to a `(team_id, project_id)`. Filenames are unique per
project — `UNIQUE (project_id, original_filename)` — so `assets/<filename>`
references resolve to exactly one asset; uploads auto-suffix on collision.
`comment_attachments` links assets to task comments. The same project-scoped rows
back the per-project **Assets library** (view-only files: mockups, wireframes,
PDFs — everything that isn't a markdown project doc). Bytes live on the local
filesystem at `data/teams/{team_id}/projects/{project_id}/assets/{asset_id}` and
are served over time-limited HMAC-signed URLs (S3 support planned for V2).

### Plugins

`plugins` stores installed plugin metadata (manifest JSON, status, config).
`plugin_state` provides scoped key-value persistence (plugin_id + team_id +
namespace + key). `plugin_jobs` declares cron schedules for plugin-registered
jobs.

### Project-level budget

`projects.daily_/weekly_/monthly_budget_cents` cap aggregate spend across all the
project's agents (0 = unlimited). Enforcement sums `cost_entries` for the project
over each UTC window; a run is blocked when the project (or the individual agent) is
over any window. There is **no team-level budget** — Hezo is project-centric.

### Messaging integrations (optional)

`notification_preferences` stores per-user notification routing (keyed by
`users.id`, not team-scoped members). Each row represents a channel
(web, telegram, slack) with a JSONB array of subscribed event types and an
enabled flag. Unique on `(user_id, channel)`.

`slack_connections` stores per-team Slack app configuration. The bot token
is stored encrypted in the `secrets` table (referenced via `bot_token_secret_id`).
A single Slack app per team — agents post with distinct display names and
avatars using `chat.postMessage` overrides.

Telegram is configured per-user via `notification_preferences.telegram_chat_id`.
A single Telegram bot serves the entire Hezo instance. Both Telegram and Slack
function as full platform interfaces (not just notifications) — users can create
tasks, approve requests, and interact with agents through either channel.

### Hezo Connect OAuth link validity

OAuth authorization links generated by the Hezo Connect flow are valid for
24 hours. After expiry, the user must re-initiate the connection from the
Hezo UI. This limits the window for link interception or replay.
