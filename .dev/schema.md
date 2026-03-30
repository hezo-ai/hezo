# Data Model — Design Decisions

## 30 tables, 3 functions

| Table | Purpose | Key relationships |
|-------|---------|-------------------|
| `system_meta` | Key-value config store. Holds master key canary. | Standalone. |
| `users` | Board members (Better Auth managed). Email, password hash, name. | Standalone (auth). |
| `sessions` | Better Auth session tokens. | belongs to user |
| `companies` | Top-level tenant. Has `issue_prefix`, `mcp_servers` (JSONB), `mpp_config` (JSONB), company-level budget. | Parent of everything. |
| `company_memberships` | Links users to companies. Roles: `owner`, `member`. | links user ↔ company |
| `invites` | Pending invitations for new board members. | belongs to company |
| `api_keys` | Company-scoped keys for external orchestrators. Stored bcrypt-hashed. | belongs to company |
| `agents` | A role in the org chart. Self-referential `reports_to`. Has `slug` for @-mentions, `mcp_servers` (JSONB). | belongs to company |
| `projects` | Group of related work under a company. | belongs to company |
| `repos` | Git repo (GitHub only). Short name for @-mentions. | belongs to project |
| `issues` | Ticket. Must have a project. Linear-style `identifier` (e.g. `ACME-42`). Execution lock fields. | belongs to company + project, assigned to agent |
| `issue_comments` | Thread entries. Polymorphic via `content_type` + `content` JSONB. | belongs to issue |
| `issue_attachments` | Links uploaded files to issues. | links asset ↔ issue |
| `tool_calls` | Trace log entries. Linked to a comment (the agent message that triggered them). | belongs to comment + agent |
| `secrets` | Encrypted key/value. Scoped to company or company+project. | belongs to company, optionally project |
| `secret_grants` | Which agent has access to which secret. Revocable. | links secret ↔ agent |
| `approvals` | Pending board decisions. Polymorphic payload. | belongs to company, requested by agent |
| `cost_entries` | Immutable spend records per agent per issue. | belongs to company + agent, optionally issue/project |
| `audit_log` | Append-only. Never updated or deleted. | belongs to company |
| `kb_docs` | Knowledge base documents. Markdown, company-scoped, slug-addressable. | belongs to company |
| `kb_doc_revisions` | Version history for KB documents. | belongs to kb_doc |
| `live_chat_sessions` | Real-time chat transcripts. Linked to issue + agent. | belongs to issue + agent |
| `connected_platforms` | OAuth connections to external services. Tokens stored in secrets. | belongs to company |
| `agent_wakeup_requests` | Wakeup queue with coalescing and idempotency. | belongs to agent + company |
| `heartbeat_runs` | One row per agent execution. Status, timing, usage, logs. | belongs to agent + company |
| `agent_task_sessions` | Per-task session persistence for session compaction. | belongs to agent, keyed by task |
| `assets` | Uploaded files. Provider, object key, content type, SHA-256 hash. | belongs to company |
| `plugins` | Installed plugins. Manifest, status, config. | belongs to company |
| `plugin_state` | Scoped key-value store for plugin data. | belongs to plugin + company |
| `plugin_jobs` | Cron job declarations for plugins. | belongs to plugin |
| `instance_user_roles` | Server-level admin roles. | belongs to user |
| `company_issue_counters` | Helper for atomic issue numbering. | belongs to company |

## Key design decisions

### Polymorphic JSONB columns

`issue_comments.content`, `approvals.payload`, and `audit_log.details` use JSONB
rather than separate tables per type. This keeps the schema flat and avoids
join-heavy queries for the most common operation (rendering an issue thread).

The `content_type` enum discriminates the shape:
- `text` → `{ "text": "..." }`
- `options` → `{ "prompt": "...", "options": [{ "id", "label", "description" }] }`
- `preview` → `{ "filename": "...", "label": "...", "description": "..." }`
- `trace` → `{ "summary": "4 tool calls" }` (detail lives in `tool_calls` table)
- `system` → `{ "text": "Agent paused — budget limit reached" }`

Live chat sessions are displayed in a separate tab on the issue detail view,
not as comments in the thread.

### Atomic budget enforcement

`debit_agent_budget()` uses `SELECT ... FOR UPDATE` to row-lock the agent before
checking + debiting. This prevents two concurrent heartbeats from overspending.
Returns FALSE if the debit would exceed the budget — the caller should then
pause the agent and emit a system comment.

### Atomic issue numbering

`next_issue_number()` uses upsert + returning to atomically assign per-company
issue numbers. No gaps under normal operation.

### Master key lifecycle

On first startup (empty DB), the server generates a 256-bit key, displays it,
and stores `encrypt("CANARY", key)` in `system_meta`. The key is held in
memory only — never on disk. On subsequent startups the server prompts for
the key (or accepts `--master-key` CLI arg), decrypts the canary to verify,
and refuses to start on mismatch.

### Secret encryption

All secret values are encrypted at the app layer using AES-256-GCM with the
`MASTER_KEY` (derived via HKDF). The DB stores ciphertext only.

Platform OAuth tokens (GitHub, Gmail, Stripe, etc.) are stored as company-scoped
secrets, managed automatically by the Hezo Connect OAuth flow. Each connected
platform has its access and refresh tokens stored as separate secrets, referenced
by ID from the `connected_platforms` table.

Company-wide secrets have `project_id = NULL`. Project-scoped secrets have both
`company_id` and `project_id` set. The unique constraint `(company_id, project_id, name)`
allows the same secret name at different scopes (e.g. a company-level secret
and a project-level secret with the same name — project scope takes precedence).

### Repo validation

The `repos.url` CHECK constraint enforces GitHub URLs at the DB level.
The app layer additionally tests repo access using the company's connected
GitHub OAuth token before inserting. Short names are unique within a project
and used for @-mentions in issue comments (`@frontend`, `@api`).

### Audit log immutability

The `audit_log` table has no `updated_at`. The app layer must never issue
UPDATE or DELETE on this table. A future migration can add a Postgres rule to
hard-block these operations:

```sql
CREATE RULE no_update_audit AS ON UPDATE TO audit_log DO INSTEAD NOTHING;
CREATE RULE no_delete_audit AS ON DELETE TO audit_log DO INSTEAD NOTHING;
```

### Budget resets

`agents.budget_reset_at` tracks when the budget was last zeroed. A scheduled
job (or heartbeat check) compares this to the current month boundary and resets
`budget_used_cents = 0` when a new month starts.

### Preview files (not in DB)

HTML previews are ephemeral filesystem artifacts, not DB records. The agent writes
to `/workspace/.previews/` inside its container, which is bind-mounted to:
```
~/.hezo/data/previews/{company_id}/{agent_id}/
```
The web app serves these via `/preview/{company_id}/{agent_id}/{filename}`.
A cron job expires files older than 72 hours. The only DB reference is the
`preview` content_type in `issue_comments` which stores the filename.

### API keys for external orchestrators

The `api_keys` table stores company-scoped API keys for remote access by
OpenClaw, scripts, or other AI agents orchestrating Hezo. Keys are bcrypt-hashed
— the raw key is shown once at creation and never returned again. A `prefix`
column stores the first 8 characters for display ("hezo_a3b8...").
`last_used_at` is updated on each authenticated request.

Keys use the `hezo_` prefix to distinguish them from agent JWTs during auth
middleware parsing.

### Agent slugs and @-mentions

Each agent has a `slug` derived from its title (lowercased, spaces → hyphens).
For example, "Dev Engineer" → `dev-engineer`. Slugs are unique within a company
(`UNIQUE (company_id, slug)`) to ensure unambiguous @-mentions.

All inter-agent communication happens via @-mentions in issue comments — no
side channels, no direct messaging. The server parses `@<slug>` from comment
text and creates notifications for mentioned agents. Repo short names can also
be @-referenced (`@frontend`, `@api`).

### Subagents

Agents can spawn subagents using their runtime's native parallelism (Claude
Code subagents, Codex parallel tasks). These are ephemeral child processes
inside the parent's container — not Hezo agents. They share the parent's budget,
secrets, and container. Tool calls are reported under the parent. Hezo does not
manage their lifecycle.

### MCP servers

Both `companies.mcp_servers` and `agents.mcp_servers` are JSONB arrays storing
MCP server config: `[{ "name": "...", "url": "...", "description": "..." }]`.

At runtime, company-level and agent-level lists are merged. Agent-level takes
precedence on name conflicts. The merged list is injected into the container's
runtime configuration.

### MPP (Machine Payments Protocol)

`companies.mpp_config` is a JSONB object:
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
agent containers get `mppx` CLI and wallet credentials injected. Every MPP
payment is reported as a tool call cost and debited against the agent's budget
via the same `debit_agent_budget()` atomic function.

### Company onboarding

When a company is created via `POST /companies`, the server automatically:
1. Creates the `~/.hezo/companies/{slug}/` folder structure including `.claude/`
2. Creates a full agent team (CEO, Architect, Engineer, QA, UI Designer, Researcher)
   with pre-filled system prompts from built-in role templates
3. Prompts the owner to connect platforms via OAuth (GitHub required, Gmail recommended)
4. Creates a "Setup" project with an onboarding issue assigned to the CEO
5. Provisions Docker containers for all agents (with `agent-ci` pre-installed)
6. Auto-generates the company CLAUDE.md with default engineering rules

This ensures the user never lands on an empty company.

### Company cloning

`POST /companies` accepts an optional `clone_from_company_id`. When set, the
server copies:
- All `kb_docs` rows (with new company_id, `last_updated_by_agent_id` set to NULL)
- All `agents` rows (new IDs, same titles/prompts/org hierarchy, `budget_used_cents`
  reset to 0, containers provisioned fresh)
- Company-level `mcp_servers` array
- `mpp_config` structure (with `enabled: false` — wallet keys must be set up fresh)

NOT copied: projects, repos, issues, secrets, cost_entries, audit_log, api_keys,
secret_grants, approvals, connected_platforms. Platform connections must be set
up fresh for each company via OAuth.

NOT copied: projects, repos, issues, secrets, cost_entries, audit_log, api_keys,
secret_grants, approvals. The cloned company starts operationally clean.

### Knowledge base

`kb_docs` stores company-wide Markdown documents — coding standards, UX
guidelines, architecture decisions, etc. Each doc has a `slug`
(UNIQUE per company) for referencing.

Agents can read KB docs via the Agent API and propose updates. Proposals
create a `kb_update` approval with a diff view. On approval, the document is
updated and `last_updated_by_agent_id` is set. This keeps the KB current as
agents learn patterns during their work.

The `{{kb_context}}` template variable in system prompts auto-selects relevant
KB docs based on the agent's current task and injects summaries.

### Live chat sessions

`live_chat_sessions` stores transcripts of real-time chat between the board
and an agent about a specific issue. The `transcript` JSONB column holds an
ordered array of messages: `[{ "author": "board|agent", "text": "...",
"timestamp": "..." }]`.

When a session ends, the agent generates a `summary` text. Live chat
sessions are displayed in a dedicated **Live Chat tab** on the issue detail
view — they do not appear as comments in the Comments tab.

Constraints:
- One active session per agent at a time (enforced in app layer)
- Sessions are immutable after `ended_at` is set
- Tool calls during live chat are captured in the transcript as typed entries

### Connected platforms (Hezo Connect)

`connected_platforms` stores OAuth connections to external services. Each company
can have one connection per platform (enforced by `UNIQUE (company_id, platform)`).

The table references the `secrets` table for token storage — `access_token_secret_id`
and `refresh_token_secret_id` point to encrypted secret entries. This means tokens
benefit from the same AES-256-GCM encryption as all other secrets.

**OAuth flow:**
1. User initiates connection via the Hezo UI
2. Hezo app redirects to Hezo Connect (centralized OAuth gateway at connect.hezo.ai)
3. Hezo Connect handles the OAuth dance with the provider
4. Tokens are returned to the local Hezo app via callback
5. Hezo app encrypts tokens, stores them as secrets, creates the connection record
6. Hezo Connect purges tokens from memory — it never stores them long-term

**Token lifecycle:**
- Access tokens are refreshed automatically by the Hezo app using the stored
  refresh token. No round-trip to Hezo Connect needed for refresh.
- If refresh fails (user revoked access, token expired), `status` is set to
  `expired` and the board is notified to re-authorize.
- The `metadata` JSONB column stores platform-specific data like the GitHub
  username, Gmail address, or Stripe account ID.

**MCP auto-registration:** When a platform is connected, it is automatically
added to the company's `mcp_servers` list so agents can discover and use the
platform's tools via MCP tool calls.

**Self-hosting:** Users who want full control can deploy their own Hezo Connect
instance, register their own OAuth apps with each provider, and point their
Hezo app to it via `--connect-url`.

### Issue identifiers (Linear-style)

Each company has an `issue_prefix` column (e.g. `ACME`, `NOTE`) auto-derived
from the company name at creation time. The prefix is globally unique across
all companies. Issues have an `identifier` column computed as
`{prefix}-{number}` (e.g. `ACME-42`). The identifier is the primary
human-facing reference for issues — used in UI, API responses, @-mentions
(`#ACME-42`), and git branch names.

### Issue execution locking

When an agent starts work on an issue, `execution_run_id` and
`execution_locked_at` are set via `SELECT ... FOR UPDATE`. This prevents two
agents from working on the same issue simultaneously. If a second agent
tries to work on a locked issue, its wakeup is deferred with status
`deferred_issue_execution` and promoted when the lock is released.

### Wakeup queue

`agent_wakeup_requests` stores all triggers (timer, assignment, mention, etc.)
with deduplication via `idempotency_key` and coalescing via `coalesced_count`.
Multiple wakeups for the same agent merge context snapshots instead of creating
duplicate runs.

### Session compaction

`agent_task_sessions` stores per-task session state (keyed by agent_id +
task_key). Sessions persist across heartbeats so agents can resume work.
Compaction policies auto-rotate sessions when token/run/age thresholds are
exceeded, generating handoff markdown for continuity.

### Heartbeat runs

`heartbeat_runs` stores one row per agent execution with full traceability:
invocation source, status, timing, token usage, cost, log references,
and retry tracking for orphan recovery.

### KB document revisions

`kb_doc_revisions` stores version history for knowledge base documents.
Each edit creates a new revision with content snapshot, change summary,
and attribution. Supports diff between versions and revert.

### Multi-user auth

`users` and `sessions` are managed by Better Auth. `company_memberships`
links users to companies with roles (`owner`, `member`). `invites` handles
the invitation flow with email + expiry. Both roles have equal board powers
for MVP — the distinction exists for future permission differentiation.

### File attachments

`assets` stores uploaded file metadata (provider, storage key, content type,
SHA-256 hash). `issue_attachments` links assets to issues. Storage is local
filesystem for MVP (`~/.hezo/data/assets/`), with S3 support planned for V2.

### Plugins

`plugins` stores installed plugin metadata (manifest JSON, status, config).
`plugin_state` provides scoped key-value persistence (plugin_id + company_id +
namespace + key). `plugin_jobs` declares cron schedules for plugin-registered
jobs.

### Company-level budget

`companies.budget_monthly_cents` and `companies.budget_used_cents` provide an
aggregate spending cap across all agents. The `debit_agent_budget()` function
checks both agent-level and company-level budgets atomically.

### Telegram notifications

Per-user Telegram notifications are configured in account settings. Each user
can link a Telegram chat via bot token + chat ID. Notifications are sent for
events the user subscribes to (issue updates, approvals, budget alerts, etc.).

### Hezo Connect OAuth link validity

OAuth authorization links generated by the Hezo Connect flow are valid for
24 hours. After expiry, the user must re-initiate the connection from the
Hezo UI. This limits the window for link interception or replay.
