# Data Model — Design Decisions

## Tables and functions

| Table | Purpose | Key relationships |
|-------|---------|-------------------|
| `system_meta` | Key-value config store. Holds master key canary. | Standalone. |
| `users` | Global human identity. Display name, avatar. One per human across all companies. | Standalone (identity). |
| `user_auth_methods` | OAuth login methods (GitHub, GitLab). Links provider identity to user. | belongs to user |
| `members` | Base table for all company participants (agents and users). Has `member_type` enum discriminator. Shared UUID used by child tables. | belongs to company |
| `member_agents` | Agent-specific extension. System prompt, runtime type, budget, heartbeat, org chart. References agent_type_id for provenance. | extends member (PK = member.id), optionally references agent_type |
| `member_users` | User-in-company extension. Role (board/member), role_title, permissions_text, project_ids. Links to global user. | extends member (PK = member.id), references user |
| `agent_types` | First-class agent type catalog. Each type defines a role template: name, slug, system prompt template, default runtime config, budget. Built-in types ship with Hezo; custom types can be user-created; remote types can be loaded from hezo connect. | Referenced by company_type_agent_types, member_agents. |
| `company_types` | Company blueprints (team type recipes). Groups of agent types plus default KB docs, preferences, MCP servers. | Referenced by company_team_types. |
| `company_type_agent_types` | Join table linking company types to agent types. Stores org chart hierarchy (reports_to_slug) and per-company-type config overrides (runtime type, heartbeat, budget). | belongs to company_type + agent_type |
| `companies` | Top-level tenant. Has `issue_prefix`, `mcp_servers` (JSONB), `mpp_config` (JSONB), `settings` (JSONB), company-level budget. | Parent of everything. |
| `company_team_types` | Many-to-many join table linking companies to the team types they were created from. | belongs to company + company_type |
| `invites` | Pending invitations. Carries role, title, permissions, project scope. | belongs to company |
| `api_keys` | Company-scoped keys for external orchestrators. Stored bcrypt-hashed. | belongs to company |
| `projects` | Group of related work under a company. Has Docker container config, dev ports, designated repo. `is_internal` flag marks auto-created projects (e.g. Operations) that cannot be deleted. | belongs to company |
| `repos` | Git repo (GitHub only). Stores `org/repo` identifier. Short name for @-mentions. | belongs to project |
| `issues` | Ticket. Must have a project. Linear-style `identifier` (e.g. `ACME-42`). Assignee references `members.id`. Has `rules` (approach instructions) and `progress_summary` (agent-maintained status). | belongs to company + project, assigned to member |
| `issue_dependencies` | Many-to-many blocking relationships between issues. | links issue ↔ issue |
| `issue_comments` | Thread entries. Polymorphic via `content_type` + `content` JSONB. | belongs to issue |
| `issue_attachments` | Links uploaded files to issues. | links asset ↔ issue |
| `tool_calls` | Trace log entries. Linked to a comment (the agent message that triggered them). | belongs to comment + member_agent |
| `secrets` | Encrypted key/value. Scoped to company or company+project. | belongs to company, optionally project |
| `secret_grants` | Which agent has access to which secret. Revocable. | links secret ↔ member_agent |
| `approvals` | Pending board decisions. Polymorphic payload. | belongs to company, requested by member_agent |
| `cost_entries` | Immutable spend records per agent per issue. | belongs to company + member_agent, optionally issue/project |
| `audit_log` | Append-only. Never updated or deleted. | belongs to company |
| `kb_docs` | Knowledge base documents. Markdown, company-scoped, slug-addressable. AGENTS.md is a special KB doc written to disk. | belongs to company |
| `kb_doc_revisions` | Version history for KB documents. | belongs to kb_doc |
| `live_chats` | Persistent live chat per issue. One ongoing conversation. | belongs to issue |
| `live_chat_messages` | Individual messages in a live chat. Author, content, metadata. | belongs to live_chat |
| `connected_platforms` | OAuth connections to external services. Tokens stored in secrets. | belongs to company |
| `company_ssh_keys` | Generated SSH key pairs per company. Private key stored encrypted in secrets vault. Registered on GitHub via OAuth API. | belongs to company |
| `execution_locks` | Issue work ownership tracking. One agent works on an issue at a time. | belongs to issue + member_agent |
| `system_prompt_revisions` | History of agent system prompt changes. Tracks old/new prompt, change summary, author. Linked to approval if change required approval. | belongs to member_agent + company |
| `agent_wakeup_requests` | Wakeup queue with coalescing and idempotency. | belongs to member_agent + company |
| `heartbeat_runs` | One row per agent execution. Status, timing, usage, logs. | belongs to member_agent + company |
| `agent_task_sessions` | Per-task session persistence for session compaction. | belongs to member_agent, keyed by task |
| `assets` | Uploaded files. Provider, object key, content type, SHA-256 hash. | belongs to company |
| `plugins` | Installed plugins. Manifest, status, config. | belongs to company |
| `plugin_state` | Scoped key-value store for plugin data. | belongs to plugin + company |
| `plugin_jobs` | Cron job declarations for plugins. | belongs to plugin |
| `company_preferences` | Company-level preference doc. Agents observe and record board working style preferences. | belongs to company |
| `company_preference_revisions` | Version history for company preferences. | belongs to company_preference |
| `instance_user_roles` | Instance-level admin roles for users. First user gets instance_admin. | belongs to user |
| `company_issue_counters` | Helper for atomic issue numbering. | belongs to company |
| `notification_preferences` | Per-user notification routing (web/telegram/slack). Event types, enabled flag. | belongs to user |
| `slack_connections` | Per-company Slack app config. Bot token encrypted in secrets. | belongs to company |

## Key design decisions

### Members base table (unified identity)

Both agents and human users participate in companies as "members." The `members`
table is the base identity table for all company participants:

- `members(id UUID PK, company_id FK, member_type ENUM('agent','user'), display_name TEXT, created_at)`
- `member_agents(id PK/FK → members.id, system_prompt, runtime_type, ...)` — agent-specific fields
- `member_users(id PK/FK → members.id, user_id FK → users.id, role, role_title, permissions_text, project_ids)` — user-in-company fields

`members.id` is the shared UUID — it IS the agent or user-in-company ID. No
separate FK needed. All references to assignees, authors, and actors point to
`members.id` with a single FK.

The global `users` table stores cross-company identity (display_name, avatar_url).
`user_auth_methods` stores OAuth providers (GitHub, GitLab). No email field on
users — email may be added as an auth type later.

### Custom authentication

Hezo uses custom auth (no third-party auth library). OAuth only for MVP:

- `users` — global identity, one per human
- `user_auth_methods(id, user_id FK, provider ENUM, provider_user_id, created_at)` — OAuth links
- Sessions are stateless JWTs signed with the master key. No sessions table.
- JWT contains: `{ user_id, member_id, company_id, iat, exp }`
- Always authenticated — no unauthenticated "local_trusted" mode

First-run flow: Hezo Connect must be running → user logs in via OAuth → master
key set in web UI → forced company creation.

### Polymorphic JSONB columns

`issue_comments.content`, `approvals.payload`, and `audit_log.details` use JSONB
rather than separate tables per type. This keeps the schema flat and avoids
join-heavy queries for the most common operation (rendering an issue thread).

The `content_type` enum discriminates the shape:
- `text` → `{ "text": "..." }`
- `options` → `{ "prompt": "...", "options": [{ "id", "label", "description" }] }`
- `preview` → `{ "filename": "...", "label": "...", "description": "..." }`
- `trace` → `{ "summary": "4 tool calls" }` (detail lives in `tool_calls` table)
- `system` → `{ "text": "Agent disabled — budget limit reached" }`

Live chat is displayed in a separate tab on the issue detail view,
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

Platform OAuth tokens (GitHub, Gmail, Stripe, etc.) are stored as company-scoped
secrets, managed automatically by the Hezo Connect OAuth flow. Each connected
platform has its access and refresh tokens stored as separate secrets, referenced
by ID from the `connected_platforms` table.

Company-wide secrets have `project_id = NULL`. Project-scoped secrets have both
`company_id` and `project_id` set. The unique constraint `(company_id, project_id, name)`
allows the same secret name at different scopes (e.g. a company-level secret
and a project-level secret with the same name — project scope takes precedence).

### Repo storage and validation

The `repos.repo_identifier` column stores the `org/repo` format (e.g.
`acme-corp/frontend`). The full SSH URL (`git@github.com:org/repo.git`) is
constructed at clone time. No URL CHECK constraint — validation is at the app
layer.

The app layer performs a two-step validation before inserting:

1. **GitHub connection check** — verifies the company has an active GitHub OAuth
   connection in `connected_platforms`. If not, the request fails with
   `GITHUB_NOT_CONNECTED` and a board inbox item of type `oauth_request` is
   created to prompt the user to connect GitHub via Hezo Connect.
2. **Repo access check** — calls the GitHub API (`GET /repos/{owner}/{repo}`)
   using the OAuth token. If the connected GitHub user doesn't have access
   (403/404), the request fails with `REPO_ACCESS_FAILED` and includes the
   GitHub username so the board knows which account needs to be added.

Short names are unique within a project and used for @-mentions in issue
comments (`@frontend`, `@api`).

### SSH keys per company

Hezo generates an SSH key pair per company for git operations. The private key
is stored encrypted in the secrets vault. The public key is registered on the
connected GitHub account via the OAuth API (`POST /user/keys`).

The `company_ssh_keys` table tracks: `company_id`, `public_key`, `fingerprint`,
`private_key_secret_id` (FK to secrets), `github_key_id` (for cleanup on
disconnect), `created_at`.

Git clone/push/pull uses SSH with the company's generated key. GitHub OAuth
token is used for API calls (repo validation, PRs, Actions).

### Audit log immutability

The `audit_log` table has no `updated_at`. The app layer must never issue
UPDATE or DELETE on this table. A future migration can add a Postgres rule to
hard-block these operations:

```sql
CREATE RULE no_update_audit AS ON UPDATE TO audit_log DO INSTEAD NOTHING;
CREATE RULE no_delete_audit AS ON DELETE TO audit_log DO INSTEAD NOTHING;
```

### Budget resets

`member_agents.budget_reset_at` tracks when the budget was last zeroed. A scheduled
job (or heartbeat check) compares this to the current month boundary and resets
`budget_used_cents = 0` when a new month starts.

When budget is exceeded mid-execution, the agent's subprocess is terminated
immediately. A system comment is posted on the active issue. The board can
adjust the budget and resume the agent at any time.

### Preview files (not in DB)

HTML previews are ephemeral filesystem artifacts, not DB records. The agent writes
to `/workspace/.previews/{agent_id}/` inside the project container, which is
visible on the host via the shared workspace volume at:
```
~/.hezo/companies/{slug}/projects/{project}/.previews/{agent_id}/
```
The web app serves these via `/preview/{company_id}/{project_id}/{agent_id}/{filename}`.
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
(enforced via `members.company_id` + `member_agents.slug` unique index) to
ensure unambiguous @-mentions.

All inter-agent communication happens via @-mentions in issue comments — no
side channels, no direct messaging. The server parses `@<slug>` from comment
text and creates notifications for mentioned agents. Repo short names can also
be @-referenced (`@frontend`, `@api`).

### Subagents

Agents can spawn subagents using their runtime's native parallelism (Claude
Code subagents, Codex parallel tasks). These are ephemeral child processes
inside the parent's subprocess — not Hezo agents. They share the parent's budget
and secrets. Tool calls are reported under the parent. Hezo does not manage
their lifecycle.

### MCP servers

Both `companies.mcp_servers` and `member_agents.mcp_servers` are JSONB arrays
storing manually configured MCP server entries:
`[{ "name": "...", "url": "...", "description": "..." }]`.

At runtime, the effective MCP server list is computed by merging:
1. Manually configured company-level servers (`companies.mcp_servers`)
2. Manually configured agent-level servers (`member_agents.mcp_servers`)
3. Active connected platforms (auto-derived from `connected_platforms` table)

Agent-level takes precedence on name conflicts with company-level. Connected
platform servers are added automatically — they are NOT written to the JSONB
columns. The merged list is injected into the agent's subprocess runtime
configuration.

### Company Settings

`companies.settings` is a JSONB object for company-level configuration:
```json
{
  "coach_auto_apply": false
}
```

- `coach_auto_apply` — when true, Coach-suggested system prompt improvements are auto-applied without board approval. Default false.

Settings are merged on PATCH (`settings = settings || $1::jsonb`), so partial updates preserve existing keys.

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
the project container gets `mppx` CLI and wallet credentials are injected into agent subprocesses. Every MPP
payment is reported as a tool call cost and debited against the agent's budget
via the same `debit_agent_budget()` atomic function.

### Company onboarding

When a company is created via `POST /companies`, the server automatically:
1. Creates the `~/.hezo/companies/{slug}/` folder structure
2. Creates the full 11-agent team (CEO, Product Lead, Architect, Engineer, QA Engineer,
   Security Engineer, UI Designer, DevOps Engineer, Marketing Lead, Researcher, Coach)
   with pre-filled system prompts from built-in role templates. DevOps Engineer starts
   in `idle` status.
3. Prompts the owner to connect platforms via OAuth (GitHub required, Gmail recommended)
4. Creates an "Operations" project (`is_internal = true`) with an onboarding issue assigned to the CEO
5. Generates an SSH key pair for the company and registers it on the connected GitHub account
6. Auto-generates the company AGENTS.md KB doc with default engineering rules and writes it to disk
7. Auto-provisions a Docker container for the Operations project in the background

This ensures the user never lands on an empty company.

### Team type provisioning

`POST /companies` accepts an optional `template_id` (a single company type UUID). The server provisions
agents from the selected team type via the `company_type_agent_types` join table:

1. Queries `company_type_agent_types JOIN agent_types` for the selected template, ordered by `sort_order`
2. For each agent type, creates `members` + `member_agents` rows with:
   - `agent_type_id` set to the originating agent type (for provenance tracking)
   - System prompt copied from `agent_types.system_prompt_template`
   - Config overrides applied from the join table (runtime type, heartbeat, budget)
   - `budget_used_cents` reset to 0
4. Second pass resolves `reports_to_slug` → `reports_to` UUID for the org chart
5. Creates `kb_docs` rows from `company_types.kb_docs_config`
6. Creates `company_preferences` row from `company_types.preferences_config`
7. Copies `mcp_servers` array from company type
8. Copies `mpp_config` structure (with `enabled: false` — wallet keys must be set up fresh)
9. Inserts rows into `company_team_types` to record the association

Project containers are provisioned when projects are created (not at company creation).

NOT copied: projects, repos, issues, secrets, cost_entries, audit_log, api_keys,
secret_grants, approvals, connected_platforms, SSH keys. Platform connections
and SSH keys are generated fresh for each company.

### Agent types

Agent types are a first-class entity in the `agent_types` table. Each type
defines a reusable role template with a system prompt template, default config
(runtime type, heartbeat interval, monthly budget), and metadata.

**Sources:**
- `builtin` — shipped with Hezo (11 built-in types: CEO, Product Lead, Architect, Engineer, QA Engineer, Security Engineer, UI Designer, DevOps Engineer, Marketing Lead, Researcher, Coach). Security Engineer reports to Architect. Coach is a standalone role that reviews completed tickets to extract lessons and improve system prompts.
- `custom` — created by users for their specific needs
- `remote` — loaded from hezo connect marketplace (future)

The `source_url` and `source_version` fields support future remote type loading
without schema changes.

Agent types are linked to company types through the `company_type_agent_types`
join table, which stores:
- `reports_to_slug` — org chart hierarchy specific to this company type composition
- Override columns — allow a company type to customize an agent type's defaults
- `sort_order` — ensures parents are created before children during agent provisioning

When agents are created from a company type, `member_agents.agent_type_id`
records which agent type was used. This is for provenance tracking only — the
system prompt is copied at creation time, giving each agent instance its own
mutable copy.

### Agent self-update of system prompts

Agents can read and request updates to their own system prompts via the agent API:
- `GET /agent-api/self/system-prompt` — returns current prompt, agent_type_id, and the type's original template
- `PATCH /agent-api/self/system-prompt` — creates a `system_prompt_update` approval with the new prompt

System prompt updates require board approval. When approved, the approval
resolution handler applies the change by updating `member_agents.system_prompt`.

### System prompt revisions

`system_prompt_revisions` tracks the history of changes to agent system prompts. Each update records the old and new prompt text, a change summary, who authored the change, and optionally which approval authorized it. This enables auditability of prompt evolution and rollback if needed.

### Company preferences

`company_preferences` stores a single Markdown document per company, recording
observed board preferences in areas like code architecture, design approach,
research style, and team working conventions. Preferences are company-level
(not per-member) — even with multiple board members, the company has one unified
set of preferences that represent how the board collectively wants things done.

Agents update this document directly (no approval required) as they observe
patterns in board feedback. Every change creates a revision in
`company_preference_revisions` for auditability. The board can also edit
directly, review revision history, and revert.

The `UNIQUE (company_id)` constraint ensures one preference document per company.
Content is structured Markdown with sections for different preference categories
(code architecture, design, research, team working, etc.).

The `{{company_preferences_context}}` template variable in system prompts
injects the preference document so agents can align with the board's working
style. The orchestrator pre-resolves all template variables before spawning
the agent subprocess.

### Project documents

Project documents (PRDs, technical specifications, implementation plans, research,
UI design decisions, marketing plans) are stored as files in the `.dev/` folder
of the project's designated repo worktree — not in the database. The API reads
and writes these files directly on the filesystem at
`~/.hezo/companies/{slug}/projects/{project}/{repo}/.dev/`.

A project must have a `designated_repo_id` set for project docs to work. The API
resolves the repo's worktree path and operates on `.dev/*.md` files within it.

PRD updates (`prd.md`) by agents require board approval — the agent's write
creates an approval request instead of writing the file directly.

The `{{project_docs_context}}` template variable in system prompts auto-injects
all project documents for the current issue's project.

### Knowledge base

`kb_docs` stores company-wide Markdown documents — coding standards, UX
guidelines, architecture decisions, etc. Each doc has a `slug`
(UNIQUE per company) for referencing.

Agents can read KB docs via the Agent API and propose updates. Proposals
create a `kb_update` approval with a diff view. On approval, the document is
updated and `last_updated_by_agent_id` is set. This keeps the KB current as
agents learn patterns during their work.

The `{{kb_context}}` template variable in system prompts injects all KB docs.
The orchestrator pre-resolves all template variables and includes everything
for MVP. Optimization with smart selection deferred.

**AGENTS.md** is a special KB doc that contains company-wide engineering rules
and agent conventions. It is stored in the database like any other KB doc but
also written to the project root filesystem (`AGENTS.md`) so that any coding
agent (Claude Code, Codex, Gemini) automatically reads it. On every update to
this KB doc, the file on disk is re-written.

### Live chat (persistent per issue)

`live_chats` stores a single persistent conversation per issue. There are no
discrete "sessions" — each issue has one ongoing live chat from creation.
Messages are stored in the `live_chat_messages` table, each with an author
(`author_member_id` + `author_type`), text content, and optional metadata JSONB.

Live chat is displayed in a dedicated **Live Chat tab** on the issue detail
view — messages do not appear as comments in the Comments tab.

The assigned agent is always a participant. Board members can @-mention any
other agent to pull them into the conversation. Mentioned agents wake
immediately (not on next heartbeat).

Constraints:
- One live chat per issue (auto-created with the issue)
- An agent can only be active in one live chat at a time
- Tool calls during live chat are captured in the transcript
- Agents should post a summary of Q&A outcomes as a comment on the issue for the permanent record

### Connected platforms (Hezo Connect)

`connected_platforms` stores OAuth connections to external services. Each company
can have one connection per platform (enforced by `UNIQUE (company_id, platform)`).

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

**Platform token access:** All agents in a company automatically receive all
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
added to the company's `mcp_servers` list so agents can discover and use the
platform's tools via MCP tool calls.

**Self-hosting:** Users who want full control can deploy their own Hezo Connect
instance, register their own OAuth apps with each provider, and point their
Hezo app to it via `--connect-url`.

### Issue identifiers (Linear-style)

Each company has an `issue_prefix` column (e.g. `ACME`, `NOTE`) auto-derived
from the company name at creation time. On collision, a numeric suffix is
appended (ACME, ACME2, ACME3). The prefix is globally unique across all
companies on the instance. Issues have an `identifier` column computed as
`{prefix}-{number}` (e.g. `ACME-42`). The identifier is the primary
human-facing reference for issues — used in UI, API responses, @-mentions
(`#ACME-42`), and git branch names.

### Issue assignees

Issues have an `assignee_id` FK pointing to `members.id`. Both agents and
human users (board members and company members) can be assigned tickets.

When a human is assigned an issue, they can work on it outside Hezo, pass it
to another member (human or agent), or @-mention an agent in a comment to
request specific help. When an agent is assigned, the standard agent execution
flow applies.

### Execution locks (separate table)

The `execution_locks` table tracks issue work ownership:
- `issue_id` FK (unique — at most one lock per issue)
- `agent_member_id` FK → members.id
- `heartbeat_run_id` FK
- `locked_at` timestamp

When an agent begins work on an issue, a row is inserted into `execution_locks`.
This is a work ownership marker, not a short-lived database lock — ownership
persists across heartbeat cycles and may span hours or days. Only one agent
works on a given issue at a time. If a second agent tries to work on an owned
issue, its wakeup is deferred with status `deferred_issue_execution` and
promoted when ownership is released (on completion, reassignment, or agent
pause/termination). Execution locking applies only to agent-assigned issues.

### Issue dependencies

The `issue_dependencies` join table enables many-to-many blocking:
- `issue_id` FK — the issue that is blocked
- `blocked_by_issue_id` FK — the issue that blocks it
- `UNIQUE(issue_id, blocked_by_issue_id)` — no duplicate dependencies
- `CHECK(issue_id != blocked_by_issue_id)` — no self-blocking

An issue's `status` can be set to `blocked` when it has unresolved dependencies.

### Wakeup queue

`agent_wakeup_requests` stores all triggers (timer, assignment, mention, etc.)
with deduplication via `idempotency_key` and coalescing via `coalesced_count`.
Multiple wakeups for the same agent merge context snapshots instead of creating
duplicate runs.

Event-based triggers (@-mention, assignment, option chosen, approval resolved)
wake agents immediately — they do not wait for the next scheduled heartbeat.
Scheduled heartbeats are a fallback for idle agents with no pending events.

### Session compaction

`agent_task_sessions` stores per-task session state (keyed by agent member_id +
task_key). Each heartbeat spawns a fresh subprocess — handoff markdown from the
previous session is injected as initial context. Compaction policies auto-rotate
sessions when token/run/age thresholds are exceeded, generating handoff markdown
for continuity.

### Heartbeat runs

`heartbeat_runs` stores one row per agent execution with full traceability:
invocation source, status, timing, token usage, cost, log references,
and retry tracking for orphan recovery.

### KB document revisions

`kb_doc_revisions` stores version history for knowledge base documents.
Each edit creates a new revision with content snapshot, change summary,
and attribution. Supports diff between versions and revert.

### Auth and roles

Hezo uses custom auth. All users authenticate via GitHub or GitLab OAuth
(email/password deferred to post-MVP). Sessions are stateless JWTs signed
with the master key — no sessions table.

The `users` table stores global identity (display_name, avatar_url).
`user_auth_methods` stores OAuth provider links (provider, provider_user_id).

`member_users` links users to companies with two roles: `board` (full authority)
and `member` (scoped authority). Members have a `role_title` (arbitrary, e.g.
"Frontend Developer"), `permissions_text` (free-text description of what they
can do, injected into agent prompts), and optional `project_ids` (JSONB array
restricting which projects they can access). Board members always have full access.
A user can belong to multiple companies — each company membership is a separate
`members` + `member_users` row pair.

Permission enforcement is two-layered: the API layer enforces structural
boundaries (project scope, board-only endpoints), while agents interpret
`permissions_text` to respect behavioral boundaries (e.g. "cannot modify
PRDs — escalate to CEO").

`invites` carries the intended role, title, permissions, and project scope.
These fields are copied to `member_users` when accepted.

Board member conflicts are resolved first-come-first-served — the first board
member to approve or deny a request locks the decision.

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

### Messaging integrations (optional)

`notification_preferences` stores per-user notification routing (keyed by
`users.id`, not company-scoped members). Each row represents a channel
(web, telegram, slack) with a JSONB array of subscribed event types and an
enabled flag. Unique on `(user_id, channel)`.

`slack_connections` stores per-company Slack app configuration. The bot token
is stored encrypted in the `secrets` table (referenced via `bot_token_secret_id`).
A single Slack app per company — agents post with distinct display names and
avatars using `chat.postMessage` overrides.

Telegram is configured per-user via `notification_preferences.telegram_chat_id`.
A single Telegram bot serves the entire Hezo instance. Both Telegram and Slack
function as full platform interfaces (not just notifications) — users can create
issues, approve requests, and interact with agents through either channel.

### Hezo Connect OAuth link validity

OAuth authorization links generated by the Hezo Connect flow are valid for
24 hours. After expiry, the user must re-initiate the connection from the
Hezo UI. This limits the window for link interception or replay.
