# Data Model — Design Decisions

## Tables and functions

| Table | Purpose | Key relationships |
|-------|---------|-------------------|
| `system_meta` | Key-value config store. Holds master key canary. | Standalone. |
| `users` | Global human identity. Display name, avatar. One per human across all companies. | Standalone (identity). |
| `user_auth_methods` | OAuth login methods (GitHub, GitLab). Links provider identity to user. | belongs to user |
| `members` | Base table for all company participants (agents and users). Has `member_type` enum discriminator. Shared UUID used by child tables. | belongs to company |
| `member_agents` | Agent-specific extension. System prompt, runtime type, `default_effort` (reasoning level applied to runs), budget, heartbeat, org chart, `summary` (auto-generated agent description, ≤5 lines), `touches_code` (capability flag used by the job manager to gate runs on designated-repo setup). `model_override_provider` + `model_override_model` let a single agent target a specific provider/model; when set they take precedence over the instance-default provider and the provider config's `default_model` (both must be set together — enforced by `model_override_requires_provider` CHECK). References agent_type_id for provenance. | extends member (PK = member.id), optionally references agent_type |
| `member_users` | User-in-company extension. Role (board/member), role_title, permissions_text, project_ids. Links to global user. | extends member (PK = member.id), references user |
| `agent_types` | First-class agent type catalog. Each type defines a role template: name, slug, system prompt template, default runtime config, budget, `default_summary` (pre-generated description loaded from `packages/server/src/db/agent-summaries.json`), `touches_code` (default capability flag — seeded true for builder roles, copied onto `member_agents` at hire time). Built-in types ship with Hezo; custom types can be user-created; remote types can be loaded from hezo connect. | Referenced by company_type_agent_types, member_agents. |
| `company_types` | Company blueprints (team type recipes). Groups of agent types plus default KB docs, preferences, MCP servers, `default_team_summary` (pre-generated team collaboration description). | Referenced by company_team_types. |
| `company_type_agent_types` | Join table linking company types to agent types. Stores org chart hierarchy (reports_to_slug) and per-company-type config overrides (runtime type, heartbeat, budget). | belongs to company_type + agent_type |
| `companies` | Top-level tenant. Has `mcp_servers` (JSONB), `mpp_config` (JSONB), `settings` (JSONB), company-level budget, `team_summary` (auto-generated team collaboration description, ≤20 lines). | Parent of everything. |
| `company_team_types` | Many-to-many join table linking companies to the team types they were created from. | belongs to company + company_type |
| `invites` | Pending invitations. Carries role, title, permissions, project scope. | belongs to company |
| `api_keys` | Company-scoped keys for external orchestrators. Stored bcrypt-hashed. | belongs to company |
| `projects` | Group of related work under a company. Has `issue_prefix` (2–4 uppercase chars used for issue identifiers), Docker container config, dev ports, designated repo. `is_internal` flag marks auto-created projects (e.g. Operations) that cannot be deleted. | belongs to company |
| `repos` | Git repo (GitHub only). Stores `org/repo` identifier. Short name for @-mentions. | belongs to project |
| `issues` | Ticket. Must have a project. Linear-style `identifier` (e.g. `OP-42`) built from the project's `issue_prefix` + per-project number. Assignee references `members.id`. Has `rules` (approach instructions) and `progress_summary` (agent-maintained status). | belongs to company + project, assigned to member |
| `issue_dependencies` | Many-to-many blocking relationships between issues. | links issue ↔ issue |
| `issue_comments` | Thread entries. Polymorphic via `content_type` + `content` JSONB. Includes execution-type comments auto-created when agent runs complete. | belongs to issue |
| `issue_attachments` | Links uploaded files to issues. | links asset ↔ issue |
| `tool_calls` | Trace log entries. Linked to a comment (the agent message that triggered them). | belongs to comment + member_agent |
| `secrets` | Encrypted key/value. Scoped to company or company+project. | belongs to company, optionally project |
| `secret_grants` | Which agent has access to which secret. Revocable. | links secret ↔ member_agent |
| `approvals` | Pending board decisions. Polymorphic payload. | belongs to company, requested by member_agent |
| `cost_entries` | Immutable spend records per agent per issue. | belongs to company + member_agent, optionally issue/project |
| `audit_log` | Append-only. Never updated or deleted. | belongs to company |
| `documents` | Unified Markdown document store keyed by `type` (`project_doc` / `kb_doc` / `company_preferences` / `agent_system_prompt`). Project docs scope by `(project_id, slug)`; KB docs by `(company_id, slug)`; preferences by `(company_id)` (one per company); agent system prompts by `(member_agent_id)` (one per agent). Embeddings live on this table for KB and project docs. | belongs to company, optionally project or member_agent |
| `document_revisions` | Snapshot of prior content created on every change. `change_summary` captures intent; `Restored to revision N` is set automatically by the rollback path. Shared by all document types — agent system prompt history lives here too. | belongs to document |
| `connected_platforms` | OAuth connections to external services. Tokens stored in secrets. | belongs to company |
| `company_ssh_keys` | Generated SSH key pairs per company. Private key stored encrypted in secrets vault. Registered on GitHub via OAuth API. | belongs to company |
| `execution_locks` | Issue work ownership tracking. Read/write locks — multiple readers (reviewers) or one exclusive writer. | belongs to issue + member_agent |
| `skills` | Reusable instruction documents (DB-backed). Tags, content, source URL, creator tracking, embeddings. | belongs to company |
| `skill_revisions` | Version history for skills. | belongs to skill |
| `agent_wakeup_requests` | Wakeup queue with coalescing and idempotency. Every run row points back to the wakeup that triggered it via `heartbeat_runs.wakeup_id`. | belongs to member_agent + company |
| `heartbeat_runs` | One row per agent execution. Status, timing, usage, logs. Links to the issue being worked on via `issue_id`, and to the wakeup that triggered the run via `wakeup_id`. | belongs to member_agent + company, optionally issue, optionally wakeup |
| `agent_task_sessions` | Per-task session persistence for session compaction. | belongs to member_agent, keyed by task |
| `assets` | Uploaded files. Provider, object key, content type, SHA-256 hash. | belongs to company |
| `plugins` | Installed plugins. Manifest, status, config. | belongs to company |
| `plugin_state` | Scoped key-value store for plugin data. | belongs to plugin + company |
| `plugin_jobs` | Cron job declarations for plugins. | belongs to plugin |
| `instance_user_roles` | Instance-level admin roles for users. First user gets instance_admin. | belongs to user |
| `project_issue_counters` | Helper for atomic issue numbering per project. | belongs to project |
| `notification_preferences` | Per-user notification routing (web/telegram/slack). Event types, enabled flag. | belongs to user |
| `slack_connections` | Per-company Slack app config. Bot token encrypted in secrets. | belongs to company |
| `ai_provider_configs` | Instance-level AI provider credentials shared across every company in the Hezo instance. Each row inlines the encrypted credential (`encrypted_credential`). Auth method distinguishes API key vs subscription credential blob. A partial unique index on `is_default` enforces one default per provider; `(provider, label)` is unique so multiple rows per provider coexist — typically one `api_key` and one `subscription` — and `getProviderCredential` / `resolveRuntimeForIssue` pick the `is_default` row at runtime. `default_model` (nullable) holds the CLI `--model` value applied to every run that uses this config when the agent has no explicit override. Agent runner decrypts at execution time and either injects as env var (api keys) or materialises to a per-run mount inside the container (subscriptions). | instance-scoped |

## Key design decisions

### Members base table (unified identity)

Both agents and human users participate in companies as "members." The `members`
table is the base identity table for all company participants:

- `members(id UUID PK, company_id FK, member_type ENUM('agent','user'), display_name TEXT, created_at)`
- `member_agents(id PK/FK → members.id, system_prompt, default_effort, ...)` — agent-specific fields
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
- `system` → `{ "text": "...", "kind"?: "status_change" | "issue_link" | <other>, ... }`. Auto-generated timeline entries. The renderer shows `text`; `kind` plus per-kind fields let the server dedup and tooling filter without re-parsing prose.
  - `status_change`: `{ "kind": "status_change", "from": "<old>", "to": "<new>", "actor_id": "<member_uuid|null>", "text": "<actor> changed status from <old> to <new>" }` — written for every issue status transition.
  - `issue_link`: `{ "kind": "issue_link", "source_issue_id": "<uuid>", "source_identifier": "<e.g. OP-42>", "actor_id": "<member_uuid|null>", "text": "Linked from <source_identifier> by <actor>" }` — written on the **target** issue the first time a given source issue mentions it; subsequent mentions from the same source are deduped via the `source_issue_id` JSONB key.
- `execution` → `{ "heartbeat_run_id", "agent_id", "agent_title", "status", "exit_code", "duration_ms", "stdout_preview" }` (auto-created on agent run completion)
- `action` → `{ "kind": "setup_repo", "approval_id": "..." }` — surfaces a board-required action inline on the ticket. Resolves by setting `chosen_option` to `{ status: 'complete', result: {...} }`. Currently only `setup_repo` is defined, used by the designated-repo gate.

### Atomic budget enforcement

`debit_agent_budget()` uses `SELECT ... FOR UPDATE` to row-lock the agent before
checking + debiting. This prevents two concurrent heartbeats from overspending.
Returns FALSE if the debit would exceed the budget — the caller should then
pause the agent and emit a system comment.

### Atomic issue numbering

`next_project_issue_number()` uses upsert + returning to atomically assign
per-project issue numbers. No gaps under normal operation.

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
`member_agents.touches_code = true` is activated on an issue whose project
still has `designated_repo_id IS NULL`, the job manager:

1. Upserts a single pending `oauth_request` approval per `(company_id,
   project_id)` with `payload.reason = 'designated_repo'`. A partial unique
   index `idx_one_pending_repo_setup` dedupes concurrent runs.
2. Inserts a comment of type `action` on the triggering issue with content
   `{ kind: 'setup_repo', approval_id }`.
3. Marks the wakeup `Deferred` with `payload.reason = 'awaiting_repo_setup'`.

When the board drives the wizard to completion (via `POST /repos`):

- The repo insert atomically sets `designated_repo_id` under a `FOR UPDATE`
  lock on the project row.
- Every pending `action` comment attached to this approval gets its
  `chosen_option` set to `{ status: 'complete', result: {...} }`, and a
  `system` comment is appended per affected issue.
- The approval is resolved to `approved`.
- The host workspace clone and container provisioning run post-commit.
- Each deferred wakeup is re-enqueued as a fresh `Automation` wakeup with
  `payload.reason = 'repo_setup_complete'`.

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
  "wake_mentioner_on_reply": true
}
```

- `wake_mentioner_on_reply` — when true, replying to an @-mention on a ticket wakes the original mentioner. Default true.

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
5. Creates `documents` rows of type `kb_doc` from `company_types.kb_docs_config`
6. Creates `documents` row of type `company_preferences` from `company_types.preferences_config`
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

### Agent and team auto-descriptions

Each agent has a `summary` (TEXT, ≤1000 chars) on `member_agents` — a short
auto-generated description of the agent's role and capabilities (≤5 lines).
Each company has a `team_summary` (TEXT, ≤4000 chars) on `companies` — a
description of how the team collaborates (≤20 lines).

**Pre-baked defaults:** Built-in agent types carry a `default_summary` on
`agent_types`, loaded from committed source data at
`packages/server/src/db/agent-summaries.json`. Company types carry a
`default_team_summary` on `company_types`. These defaults are copied to
`member_agents.summary` and `companies.team_summary` during company
provisioning.

**Runtime updates:** The CEO agent can regenerate descriptions at runtime by
processing `description-update` issues (created in the Operations project).
Two MCP tools — `set_agent_summary` and `set_team_summary` — write the new
text directly to the database. Only agents and board members within the
company can set agent summaries; only the CEO agent can set the team summary.

### Agent system prompts

Agent system prompts live as `agent_system_prompt` documents, one per agent,
keyed by `(company_id, member_agent_id)`. Reads go through the unified
`documents` service; history, restore, and WS broadcasts are inherited from
the document revisioning machinery. There is no dedicated agent self-update
endpoint — agents cannot change their own prompts. Only the Coach agent (via
the `update_agent_system_prompt` MCP tool) and the board (via
`PATCH /companies/:companyId/agents/:agentId` with a `system_prompt` field)
can write. Coach writes apply immediately and a revision snapshot is recorded
for undo; the board surface is the revisions panel on the agent settings page.

### Documents

`documents` is a single table that backs four kinds of Markdown content,
distinguished by the `type` column (`project_doc` / `kb_doc` /
`company_preferences` / `agent_system_prompt`). The same write path, revision
capture, restore, embedding, and broadcast logic apply to all of them;
per-type quirks (URL surface, agent approval gates) live in thin route
handlers.

Scoping is enforced by partial unique indexes:

- `project_doc` — unique on `(project_id, slug)`. Slug holds the filename
  (e.g. `spec.md`); `title` is empty (the filename is the display label).
- `kb_doc` — unique on `(company_id, slug)`. Slug is the Markdown filename
  (e.g. `coding-standards.md`); auto-derived as `${toSlug(title)}.md` when
  not provided. `title` carries the human label.
- `company_preferences` — partial unique on `(company_id)` with slug fixed
  to `preferences`. Enforces one row per company.
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
approval instead of writing directly. KB doc updates from agents create a
KbUpdate approval. Preferences updates from agents apply directly. Approval
apply paths flow through the same `upsertDocument` service so revisions are
recorded on materialisation.

The `{{kb_context}}`, `{{company_preferences_context}}`, and
`{{project_docs_context}}` template variables in system prompts pull from
this table filtered by type, so agents see the current document set.

AGENTS.md remains a filesystem file in the repo (git tracks its history) and
is not part of the documents table.

**AGENTS.md** is a special KB doc that contains company-wide engineering rules
and agent conventions. It is stored in the database like any other KB doc but
also written to the project root filesystem (`AGENTS.md`) so that any coding
agent (Claude Code, Codex, Gemini) automatically reads it. On every update to
this KB doc, the file on disk is re-written.

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

Each project has an `issue_prefix` column (2–4 uppercase alphanumeric chars,
e.g. `OP` for "Operations", `WA` for "Web App") auto-derived from the project
name at creation time. Single-word names use the first two characters;
multi-word names use the initials, capped at four characters. Callers may
override via the project-creation `issue_prefix` field. On collision within a
company, a numeric suffix is appended (`OP`, `OP2`, `OP3`). Prefixes are
unique per company, not globally.

Issues have an `identifier` column computed at creation as `{project_prefix}-{number}`
(e.g. `OP-42`), with `number` being the per-project issue counter. Identifiers
are unique per company. The identifier is the primary human-facing reference
for issues — used in UI, API responses, @-mentions (`@OP-42`), and git branch
names. Identifiers are frozen at creation time: renaming a project does not
retroactively change the prefix on existing issues.

### Issue assignees

Issues have a required `assignee_id` FK pointing to `members.id`. Every issue
must have an assignee — the API enforces this on creation and prevents
unsetting it. Both agents and human users (board members and company members)
can be assigned tickets.

When a human is assigned an issue, they can work on it outside Hezo, pass it
to another member (human or agent), or @-mention an agent in a comment to
request specific help. When an agent is assigned, the standard agent execution
flow applies.

### Execution locks (observational)

The `execution_locks` table tracks which agents are currently running against an issue:
- `issue_id` FK
- `member_id` FK → members.id
- `lock_type` TEXT — retained from an earlier read/write design; every active lock is `'read'` under the current model
- `locked_at` timestamp
- `released_at` timestamp (soft delete)

Locks are observational, not exclusive — multiple agents can run against the same issue concurrently, with one active lock row per agent. The only acquisition guard is per-agent-per-issue: a second wakeup for an agent that already holds an active lock on that issue is coalesced (deferred). This lets a comment that @-mentions several agents trigger concurrent runs while still driving the "currently running" display on the issue page.

### Issue dependencies

The `issue_dependencies` join table enables many-to-many blocking:
- `issue_id` FK — the issue that is blocked
- `blocked_by_issue_id` FK — the issue that blocks it
- `UNIQUE(issue_id, blocked_by_issue_id)` — no duplicate dependencies
- `CHECK(issue_id != blocked_by_issue_id)` — no self-blocking

An issue's `status` can be set to `blocked` when it has unresolved dependencies.

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
| `assignment` | Issue assigned to the agent (incl. `create_issue` tool). |
| `on_demand` | Admin/API explicit wake. Also created synthetically when `runAgent` is invoked without an explicit wakeup (e.g., direct test harness calls), so every run is anchored to a wakeup row. |
| `mention` | A comment contains `@<agent-slug>` referencing this agent. |
| `automation` | Server-side automation rule. |
| `option_chosen` | Board user resolved an options comment. |
| `comment` | Opt-in wake of the issue assignee from a plain Board comment (`wake_assignee=true`). |
| `reply` | An agent whose run was mention-triggered posts a comment in the triggering ticket. The original mentioner (when an agent) is woken so it can pick up the response. Gated by `companies.settings.wake_mentioner_on_reply` (default `true`). Payload: `{ source, issue_id, comment_id, triggering_comment_id, responder_member_id }`. Idempotency key: `reply:<triggering_comment_id>:<reply_comment_id>`. |

### Company settings (`companies.settings` JSONB)

Per-company toggles stored in the `companies.settings` JSONB column. Patched
via `PATCH /api/companies/:id` (shallow merge — missing keys preserve existing
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
   `agent_types.default_effort` at company creation time).
3. The global `DEFAULT_EFFORT` fallback (`medium`).

Planning-heavy roles (CEO, Architect) default to `max` so their plans go
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
  per-issue worktree, e.g. `/worktrees/<issue-identifier>/<repo-short-name>`).
- **Logs**: `log_text` holds interleaved stdout and stderr captured from the
  streaming Docker exec, capped at 1 MB (with a `...[truncated — log capped at
  N bytes]` marker when exceeded). Stderr lines are prefixed `[stderr] ` so
  consumers can tint them without needing a second column. The same stream is
  broadcast live over the `project-runs:<projectId>` WebSocket room as each
  chunk arrives, so a run's detail page and the associated issue page can
  render output in real time.
- **Usage**: `input_tokens`, `output_tokens`, `cost_cents`.
- **Retry tracking**: `retry_of_run_id`, `process_loss_retry_count`,
  `process_pid` — the orphan detector uses these to recover runs whose process
  disappeared.

### Workspaces, repos, and worktrees

Each project has a single container and a per-project directory on disk that
is bind-mounted into the container:

- `<dataDir>/companies/<company-slug>/projects/<project-slug>/workspace/` ↔
  `/workspace/` in the container. For every repo linked to the project,
  `ensureProjectRepos` populates a subdirectory `<workspace>/<short-name>/`.
  The repo-add route (`POST /repos`), container provision, and the agent
  runner all call this helper, so the set of on-disk clones stays in sync
  with the `repos` rows for the project.
- `<dataDir>/.../worktrees/` ↔ `/worktrees/` in the container. For each issue
  an agent works on, the runner creates `git worktree` directories under
  `/worktrees/<issue-identifier>/<repo-short-name>/` on the branch
  `hezo/<issue-identifier>`. Worktrees persist across runs on the same issue
  so iterative work survives between invocations, and are torn down when the
  issue transitions to a terminal status (`done`, `cancelled`, etc.) or its
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
