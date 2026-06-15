# Hezo — Full Product Specification

> Codename: Hezo. Open-source team orchestration platform.
> Version: MVP spec v2.0
> Date: March 2026

---

## 1. Product overview

Hezo is a self-hosted web application that orchestrates teams of AI agents to run autonomous teams. Each agent plays a defined role (Captain, Product Lead, Architect, Engineer, etc.) and operates as a subprocess inside the project's Docker container (one container per project). Human users — **board members** — sit at the top as the board of directors, approving decisions, managing budgets, and steering strategy. Multiple board members can collaborate on the same team.

One Hezo instance supports multiple teams with full data isolation. The primary interaction surface is an task tracker — agents receive work via tickets, report progress via threaded conversations, and present options and previews to the board for review.

Hezo ships as a single executable binary. No external database required. No cloud account required.

### What Hezo is

- An org chart and governance layer for AI agents
- An task tracker where agents do work and report back
- A cost control system with per-agent and per-team budgets
- A multi-team runtime with full data isolation
- An observability platform with full tool-call tracing

### What Hezo is not

- Not a chatbot — agents have jobs, not chat windows
- Not an agent framework — it orchestrates agents, doesn't build them
- Not a workflow builder — no drag-and-drop pipelines
- Not a prompt manager — agents bring their own models and runtimes

---

## 2. Tech stack

| Component | Technology | Notes |
|-----------|-----------|-------|
| Server | Hono (TypeScript) | Lightweight HTTP framework |
| Binary | `bun build --compile` | Single executable, cross-platform |
| Database | PGlite with NodeFS + pgvector | Filesystem-persisted embedded Postgres at `~/.hezo/pgdata`, vector search via pgvector extension |
| Persistence path | `~/.hezo/` by default | Overridable via `--data-dir` CLI arg |
| Live queries | PGlite `live.query()` / `live.changes()` | Real-time UI updates without polling |
| Migrations | Custom SQL runner | Numbered SQL files, bundled into binary via `@hiddentao/zip-json`, runs on startup |
| Encryption | AES-256-GCM | Master key held in memory only |
| Project containers | Docker Engine API | One container per project (all repos checked out inside) |
| Frontend | React (bundled into binary) | Served by the same Hono process, bundled via `bun build --compile` |
| Frontend state | TanStack Query | React Query for server state caching, WebSocket-triggered invalidation |
| Real-time | WebSocket (row-change events) | Server pushes RowChange events. Client invalidates relevant TanStack Query cache keys, triggering refetch. |
| AI agent interface | MCP (Streamable HTTP) | `@modelcontextprotocol/sdk` at `/mcp` endpoint |
| Skill file | Served at `GET /skill.md` | Teaches external AI agents how to interact with Hezo |
| REST API | JSON over HTTP | Board + agent endpoints at `/api` |
| OAuth gateway | Hezo Connect (self-hosted or connect.hezo.ai) | Handles OAuth flows for GitHub, Gmail, Stripe, etc. |
| Auth | Custom (OAuth + JWT) | GitHub/GitLab OAuth, stateless JWTs signed with master key (email/password deferred) |
| Integrations | 9 platforms via OAuth | GitHub, Gmail, GitLab, Stripe, PostHog, Railway, Vercel, DigitalOcean, X |
| Plugin runtime | Worker threads + dynamic import | TypeScript plugins with capability-gated APIs. Registry out of scope for MVP — local-only. |

### Monorepo structure

Hezo is a monorepo using Bun workspaces and Turborepo for build orchestration:

```
packages/
├── connect/       # Hezo Connect OAuth gateway (standalone Bun/Hono server)
├── server/        # Main Hezo server (Hono + PGlite)
├── web/           # React frontend
└── shared/        # Shared types, utilities, validation schemas
```

- **`packages/connect`** — Hezo Connect OAuth gateway. Runs as a standalone process on port 4100. No dependency on the main server.
- **`packages/server`** — Main Hezo app. Imports from `shared`. Embeds `web` at build time. Builds into a single self-contained binary via `bun build --compile` — the binary includes the server, the React frontend, PGlite, bundled SQL migrations (via `@hiddentao/zip-json`), and all dependencies.
- **`packages/web`** — React frontend. Bundled into the server binary via `bun build --compile`.
- **`packages/shared`** — Shared TypeScript types, Zod validation schemas, constants, and utilities used by both `connect` and `server`. Reduces duplication between packages.

### Master key lifecycle

The master key is a **12-word BIP39 phrase held by the operator**. It never reaches the server. From its seed the client (browser, or the CLI boot path) derives two independent keys via HKDF-SHA256 with distinct salts:

- **Ed25519 auth keypair** (`hezo-auth-key-v1`) — the private key exists only client-side, re-derived from the typed phrase at each login, never persisted. The public key is enrolled at setup, stored plaintext in `system_meta.auth_public_key`, and verifies every login/unlock signature.
- **Unlock key** (`hezo-unlock-key-v1`, 32 bytes) — the input to all server-side key derivations: the canary, the at-rest secrets-encryption key, and the JWT signing key. The server holds it in memory only — never on disk. It transits exactly twice in a server's life-per-boot: at setup and at unlock-after-restart, always inside an Ed25519-signed payload (the server must hold symmetric key material at runtime because it decrypts secrets with no client in the loop — egress substitution, ssh-agent signing, provider keys).

Routine logins transmit **zero key material**: the client signs a single-use server nonce (`POST /auth/challenge` → `POST /auth/verify`) and gets a JWT.

**First startup** (no canary in `system_meta`, state `unset`):
1. If `--master-key <phrase>` / `HEZO_MASTER_KEY` is provided → the CLI derives both keys, enrolls the public key + canary (equivalent to web setup), and unlocks.
2. Otherwise the web UI shows the **setup wizard's master-key step**: it generates a 12-word phrase client-side, the operator saves it, and submit runs `POST /auth/setup` (public key + unlock key + self-certifying signature, persisted in one transaction).

**Subsequent startup** (canary exists):
1. With `--master-key <phrase>` → derived unlock key decrypts the canary → unlocked (the enrolled public key is backfilled if missing; the phrase is the root of trust). A wrong phrase leaves the server **locked**.
2. Without it → server starts **locked**. The web UI gate prompts for the phrase; the client signs the challenge *and* includes the unlock key (`POST /auth/verify` with `unlock_key`).

**Key principles:** the phrase/seed never transits; enrollment is explicit (`unlock()` never implicitly trusts-on-first-use — only `setup`/the CLI boot path enroll); `--master-key` accepts only a valid mnemonic (a raw derived key could never enroll the public key, which would leave an unlocked server nobody can log into — boot fails fast instead).

**On unlock:** `MasterKeyManager` fires registered `onUnlock` callbacks when the state transitions to `unlocked`. The server registers a callback at startup that starts the `JobManager` (agent wakeups, heartbeats, container sync, orphan detection). This means background processing begins as soon as the server is unlocked, regardless of whether the key was provided via CLI or web UI.

**Recovery options** (locked, phrase rejected):
- **Re-enter the correct phrase.** Try again.
- **Reset and start fresh.** Wipe the database (`--reset`), run setup with a new phrase. All existing instance data (secrets, teams, agents) is lost.

**Threat notes:** a captured setup/unlock request could be replayed against a *different, freshly-reset* instance to enroll the same key there — the same exposure class as any first-boot credential; TLS is the transit defense. Login signatures are bound to single-use nonces (consumed before verification, so a failed attempt burns the challenge) and to domain-separated message tags, so they cannot be replayed or cross-purposed.

### CLI interface and default configuration

```
hezo                          # Start server with sensible defaults
hezo --data-dir /path/to/dir  # Custom persistence directory (default: ~/.hezo/)
hezo --master-key <phrase>    # The 12-word master key phrase (setup/unlock)
hezo --port 3100              # Custom port (default: 3100)
hezo --connect-url <url>      # Hezo Connect URL (default: http://localhost:4100)
hezo --connect-api-key <key>  # API key for centrally hosted Connect
hezo --reset                  # Wipe existing database and start fresh
```

**Sensible defaults for zero-config local development:**

| Setting | Default | Notes |
|---------|---------|-------|
| Server port | `3100` | Main Hezo app |
| Connect URL | `http://localhost:4100` | Matches local Hezo Connect default port |
| Data directory | `~/.hezo/` | PGlite database, team data, assets |
| Master key | *(set via web UI)* | Generated or entered in browser on first login. CLI `--master-key` for unlocking only. |

Running `hezo` with zero arguments works for local development when Hezo Connect is running on its default port (4100). No configuration file needed for the common case.

### Database and persistence

Hezo uses **PGlite** — an embedded Postgres that runs in-process — with filesystem persistence via **NodeFS**. No external database server is needed.

```typescript
import { PGlite } from "@electric-sql/pglite"
import { live } from "@electric-sql/pglite/live"
import { NodeFS } from "@electric-sql/pglite"

const db = new PGlite({
  fs: new NodeFS(dataDir),  // defaults to ~/.hezo/pgdata
  extensions: { live },
})
```

**Server-side live queries** detect changes for syncing to the frontend:

- `live.changes(sql, params, key, callback)` — emits granular insert/update/delete deltas keyed by a primary key column. Used server-side to detect row changes.

**Frontend sync:** The browser uses **TanStack DB** for client-side querying over a locally synced dataset. The server pushes **row-level diffs** (inserts, updates, deletes) over WebSocket. The client applies diffs to TanStack DB, which re-renders React components reactively. This approach gives the frontend a local query engine without needing PGlite in the browser.

**WebSocket** carries both row-level diffs for data sync and system events (agent subprocess lifecycle, container status, notifications).

**Future sync:** Electric-SQL sync (`@electric-sql/pglite-sync`) can enable multi-instance scenarios (e.g. read replicas, multi-device access). Not required for Phase 1.

### Migration system

Hezo uses a custom forward-only migration system with numbered SQL files. Migrations are bundled into the compiled binary and run automatically on every server startup, enabling safe upgrades without data loss.

**Migration files** are stored as `migrations/NNN_description.sql` in the source tree:
```
migrations/
├── 001_initial_schema.sql     # The full initial schema
├── 002_add_agent_model.sql    # Example: new column
├── 003_add_mcp_tools.sql      # Example: new table
└── ...
```

**Bundling into the binary:** `scripts/bundle-migrations.ts` writes all `migrations/*.sql` files into a plain `{ filename: sql }` JSON map (`migrations-bundle.json`). `db/migrate.ts` pulls it in with a *literal* dynamic `import('./migrations-bundle.json')` — Bun embeds statically-analyzable imports into the compiled binary's virtual FS, so the SQL travels through the module graph and is run straight from memory (a runtime `readFile` of a sibling path is *not* embedded — it resolves to `/$bunfs/...` and ENOENTs). In dev the bundle doesn't exist; the import rejects and the runner falls back to reading the `migrations/` directory. See `.dev/upgrades.md` for the full binary-embedding story (frontend, agent roles, PGlite runtime, version).

**Build process:**
1. `bundle-migrations.ts` writes `migrations-bundle.json` (`{ filename: sql }`)
2. The compiled binary embeds it via the literal dynamic import in `db/migrate.ts`
3. At startup the map is loaded from memory and the migration runner processes it

**Tracking table** (`_migrations`) records which migrations have been applied:
```sql
CREATE TABLE IF NOT EXISTS _migrations (
    id          SERIAL PRIMARY KEY,
    filename    TEXT NOT NULL UNIQUE,
    applied_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    checksum    TEXT NOT NULL  -- SHA-256 of file contents
);
```

**Startup behavior:**
1. Ensure `_migrations` table exists (create if not)
2. Load migration SQL from the bundled map (in memory)
3. Compute the pending set (files not recorded in `_migrations`)
4. **Pre-migration backup:** if there are pending migrations *and* the instance already has applied migrations (a real upgrade, not a fresh DB), snapshot `pgdata` with PGlite `dumpDataDir('gzip')` to `<dataDir>/backups/` (last 5 kept) before applying anything. If the backup fails, abort.
5. For each unapplied migration: run inside a transaction, record in `_migrations` with checksum
6. Checksum verification: if a previously-applied migration file has changed, log a warning (indicates the migration was modified after being applied — this should not happen)

**Recovery from a bad migration (manual downgrade):** `hezo restore <backup.tar.gz>` wipes `pgdata` and reloads the pre-migration snapshot via PGlite `loadDataDir`; the operator then runs the previous Hezo version. Full lifecycle: `.dev/upgrades.md`.

**`--reset` flag:** When provided, the server wipes the existing database directory and starts fresh before running migrations. This is useful during local development. The user is warned and must confirm (unless also providing `--master-key`, which implies non-interactive mode).

**Design decisions:**
- **Forward-only** — no rollback migrations. For an embedded database, the simplest recovery is restoring from a backup or using `--reset`. Add new migrations to fix tasks.
- **Atomic per file** — each migration runs in its own transaction. If a migration fails, only that migration is rolled back, and startup halts with an error.
- **Idempotent startup** — safe to restart at any time; already-applied migrations are skipped.
- **Bundled, not on disk** — migrations are embedded in the binary, not read from the filesystem at runtime. This keeps the binary fully portable.

### MCP endpoint

Hezo exposes an **MCP (Model Context Protocol)** endpoint so external AI agents can discover and use Hezo's capabilities programmatically — without needing to know the REST API.

**Transport:** Streamable HTTP at `POST /mcp` (single endpoint, bidirectional via optional SSE streaming). Uses `@modelcontextprotocol/sdk` with the `McpServer` class.

**Architecture:**
```
┌─────────────────────────────────────────┐
│       Hono Server (port 3100)           │
├──────────────────┬──────────────────────┤
│  REST API        │  MCP Endpoint        │
│  /api/*          │  /mcp                │
│  (Board + Agent) │  (Streamable HTTP)   │
├──────────────────┴──────────────────────┤
│         Shared Business Logic           │
└─────────────────────────────────────────┘
```

MCP tools mirror the REST API surface. Both call the same underlying business logic layer. The MCP endpoint coexists with the REST API on the same Hono server and port.

**Authentication:** Same as REST — user JWT, API key (`Authorization: Bearer hezo_<key>`), or agent JWT.

**Exposed MCP tools:**

| Tool | Description |
|------|-------------|
| `list_teams` | List all teams the caller has access to |
| `create_team` | Create a new team |
| `list_tasks` | List tasks with filtering (project, status, assignee) |
| `create_task` | Create a new task in a project |
| `update_task` | Update task status, assignee, priority, etc. |
| `list_agents` | List agents in a team |
| `hire_agent` | Create a new agent from a role template or custom config |
| `post_comment` | Post a comment on an task |
| `list_comments` | List comments on an task |
| `approve_request` | Approve a pending approval |
| `deny_request` | Deny a pending approval |
| `list_approvals` | List pending approvals |
| `get_cost_summary` | Get cost breakdown by agent, project, or time period |
| `list_projects` | List projects in a team |
| `list_secrets` | List secret names (not values) in a team |

Additional tools are registered dynamically when plugins are activated.

### Skill file

Hezo serves a **skill file** that teaches external AI agents (like Claude Code) how to interact with the system. This is the primary onboarding mechanism for AI-to-AI integration.

**Served at:** `GET /skill.md` — returns a Markdown document describing Hezo's capabilities, available MCP tools, common workflows, and authentication instructions.

**Also committed to the repo** at `SKILL.md` in the project root so that coding agents working within a Hezo-managed repo automatically discover it.

**Content includes:**
- Overview of what Hezo is and how it works
- Available MCP tools with parameter descriptions
- Common workflows: create an task, assign to an agent, monitor progress, approve requests
- REST API endpoint summary (as a fallback for agents that don't support MCP)
- Authentication instructions (API key setup)
- Examples of typical interactions

**Dynamically generated:** The skill file is generated at startup from the registered MCP tool definitions, ensuring it is always up-to-date with the current tool surface. Changes to MCP tools automatically update the skill file.

### Skills (DB-backed)

Skills are reusable instruction documents stored in the `skills` table (team-scoped) — the team's single reference store. A **manifest** (name + slug + one-line description per active skill) is injected into every agent's system prompt via the `{{skills_context}}` template variable; agents load full bodies on demand.

Skills have: name, slug, description, content (markdown), tags (JSONB array), source URL (optional, for skills downloaded from GitHub), content hash, creator tracking, and revision history (`skill_revisions` table).

**Creation paths:**
- Board downloads from URL via Settings UI
- Agent proposes via `propose_skill` MCP tool (creates approval)
- Agent creates directly via `create_skill` MCP tool

**Agent access:** `list_skills` (returns the manifest), `get_skill` (full body, on demand), `create_skill` (direct), and `propose_skill` (board approval via `skill_proposal`). The manifest is injected into prompts at activation time.

### Semantic search (pgvector + local embeddings)

Hezo includes built-in semantic search powered by pgvector (enabled in PGlite) and a local embedding model (`BAAI/bge-small-en-v1.5`, 33M params, ~50MB RAM). The model downloads on first use and runs in-process — no API key, no cost, fully offline after first download.

**Searchable content:** tasks, skills, and project docs all have `embedding vector(384)` columns. A background job generates embeddings for new content every 30 seconds.

**Agent access:** `semantic_search` MCP tool searches across all content types by natural language query, returning ranked results with relevance scores. Scope can be limited to specific content types.

**REST endpoint:** `GET /teams/:teamId/search?q=...&scope=...` for the UI.

---

## 3. Multi-team management

- One Hezo instance supports unlimited teams
- Full data isolation between teams (every entity is team-scoped)
- Home screen shows a card grid of all teams
- Each team card displays: name, description snippet, agent count, open task count, budget burn bar
- Click a team card to enter its workspace

### API access for external orchestrators

Hezo can be controlled programmatically by external AI agents (OpenClaw, custom scripts, orchestration layers) via API keys.

**Auth modes for the Board API:**
- **User JWT** — stateless JWT issued after OAuth login. Required for all human users. The `hezo_` prefix on API keys distinguishes them from user/agent JWTs.
- **API key (remote)** — for OpenClaw, AI orchestrators, scripts. Header: `Authorization: Bearer hezo_<key>`.

API keys are team-scoped. A key grants full board-level access to that team: create/manage tasks, hire agents, approve requests, manage secrets — everything the board UI can do. Keys are stored hashed (bcrypt), shown once at creation, never again. Managed in team settings (generate, revoke, view last-used).

This means an OpenClaw instance or any AI agent with an API key can fully orchestrate a Hezo team: create tasks, assign work, approve hires, review agent output, and steer strategy — all via REST.

### Team types

A **team type** (also called a template or recipe) defines the blueprint for a new team. A team type is a grouping of **agent types** plus default KB docs, preferences, and MCP servers.

**Agent types** are first-class entities stored in the `agent_types` table. Each agent type defines:
- **Name and slug** — e.g., "Captain" / `captain`
- **Role description** — what this agent type does
- **System prompt template** — with `{{placeholder}}` variables resolved at runtime
- **Default config** — runtime type, default reasoning effort, heartbeat interval, monthly budget
- **Source** — `builtin` (shipped with Hezo), `custom` (user-created), or `remote` (loaded from hezo connect marketplace)

A **team type** (stored as `team_templates`) specifies:
- **Name** — e.g., "Software Development", "Research Lab", "Marketing Agency"
- **Description** — what this type of team does
- **Agent types** — which agent types to include, their org chart hierarchy (reports_to), and optional config overrides (via the `team_template_agent_types` join table)
- **Default skills** — starter skills-database content (coding standards, guidelines, etc.)
- **Default preferences** — initial team preferences
- **Default MCP servers** — team-level MCP server configuration

A team is created from a single **template** (`template_id`). The selected template determines the starting agent roster, skills database, and preferences.

The current 11-agent team (Captain, Product Lead, Architect, Engineer, QA Engineer, UI Designer, DevOps Engineer, Marketing Lead, Researcher, Security Engineer, Coach) is the built-in **"Software Development"** team type. It ships with Hezo and is pre-selected by default in the UI. Users are not limited to the agent types that come with their template — they can add other agent types later.

**Creating agent types:**
- 11 built-in agent types ship with Hezo
- Users can create custom agent types via the API
- Future: agent types can be loaded from hezo connect (remote marketplace)

**Creating team types:**
- Users can create new team types from scratch (select agent types, define KB docs and preferences)
- Users can save an existing team as a new team type (snapshots current agents, KB, and preferences)
- Team types are stored locally in the Hezo instance

**Future:** Agent types and team types will be distributable as recipes from the Hezo Connect platform, enabling the community to create and sell blueprints for different kinds of AI teams.

### Team onboarding flow

When a new team is created, the user selects a **team type** (see above). The system then clones from that type and automatically:

1. **Creates the full 11-agent team** defined by the selected template. For the built-in "Software Development" type, this includes (see `agents/` for full specs):
   - Captain (reports to board)
   - Product Lead (reports to Captain)
   - Architect (reports to Captain)
   - Engineer (reports to Architect)
   - QA Engineer (reports to Architect)
   - UI Designer (reports to Architect)
   - DevOps Engineer (reports to Architect) — **starts in `idle` status**
   - Security Engineer (reports to Architect)
   - Marketing Lead (reports to Captain)
   - Researcher (reports to Captain)
   - Coach (reports to no one) — reviews completed tickets to extract lessons and improve agent system prompts
2. **Prompts the creator to connect platforms** via OAuth (see Hezo Connect, section 5b):
   - GitHub (required for repo access)
   - Gmail (recommended for agent email)
   - Others optional: Stripe, PostHog, Railway, Vercel, DigitalOcean, X, GitLab
3. **Generates an SSH key pair** for the team and registers it on the connected GitHub account via OAuth API
4. **Creates a "Setup" project** with an onboarding task assigned to the Captain: *"Set up repository access — configure deploy keys for connected GitHub account."*
5. **Creates the `~/.hezo/teams/{slug}/` folder structure** on the host machine with AGENTS.md in the project root
6. **Provisions the project's Docker container** when the first project is created (not at team creation)

All agent system prompts are pre-filled from templates and editable. The user can delete, modify, or add agents after creation. Connected platforms can be added or removed at any time in team settings.

**Note:** The DevOps Engineer is part of the core 11-agent team but starts in `idle` status. It does not auto-activate at team creation. The DevOps Engineer activates when the board is ready for staging/production deployment — the board changes its status to `active` when needed.

**First-run flow:** Hezo Connect must be running. The first user logs in via GitHub or GitLab OAuth → master key gate modal in the UI → forced team creation. No admin-without-team state.

### Connected platforms (via Hezo Connect)

Instead of manually managing API keys and OAuth tokens, Hezo uses a centralized OAuth gateway called **Hezo Connect** (see section 5b for full architecture). Each team connects to third-party platforms via OAuth. All agents in the team share these connections.

**Supported platforms (MVP):**

| Platform | What agents use it for |
|----------|----------------------|
| GitHub | Repo access, PR management, Actions, task sync |
| Gmail | Send/receive email, sign up for services, notifications |
| GitLab | Repo access, CI/CD |
| Stripe | Payment processing, billing, MPP |
| PostHog | Product analytics, feature flags, session replay |
| Railway | Staging/production deployment |
| Vercel | Frontend deployment, edge functions |
| DigitalOcean | Infrastructure provisioning |
| X (Twitter) | Social media posting, monitoring |

Each connected platform auto-registers as a **team-level MCP server** so agents can discover and use the tools immediately. Tokens are stored encrypted in the local secrets vault. Refresh is handled automatically by the Hezo app.

### Team creation and team types

A team is created from a single **template** (`template_id`). The selected template determines the starting agent roster, skills database, and preferences. Agents are provisioned by querying the `team_template_agent_types` join table for the selected template and creating instances from each referenced agent type. Each created agent stores an `agent_type_id` for provenance tracking. After creation, the team is fully independent of its source template — changes to the team do not affect the template, and vice versa.

Users can also **save an existing team as a new team type**. This snapshots:

- **Agent type references** — which agent types to include, their org chart hierarchy, and any config overrides
- **Skills database** — all skills (coding standards, guidelines, etc.)
- **Team preferences** — board working style preferences
- **MCP server config** — team-level MCP servers
- **MPP config** — wallet config structure (not actual wallet keys)
- **Filesystem artifacts** — AGENTS.md and other project root files (stored as JSONB blobs)

Saving as a type does **not** include: projects, repos, tasks, secrets, connected platforms, cost history, audit log, API keys, or SSH keys. The resulting type captures institutional knowledge and team structure only.

---

## 4. Org structure and roles

- Each team auto-creates a full agent team on setup (see onboarding flow above)
- Agents are organized in a hierarchy with reporting lines
- Board members (human users) sit above the entire hierarchy
- Org chart is viewable as a read-only tree (MVP)

### Agent properties

| Field | Description |
|-------|-------------|
| Title | Role name (e.g. "Frontend Engineer") |
| Slug | Auto-derived from title (lowercased, hyphenated). Used for @-mentions. Unique per team. |
| Role description | Short description of responsibilities |
| System prompt | Full prompt with variable templating (see below) |
| Reports to | Parent agent in org chart |
| Runtime type | `claude_code`, `codex`, `gemini`, `opencode`, `kimi` |
| Heartbeat interval | How often the agent wakes up (default: 60 min) |
| Monthly budget | Hard spending limit in cents |
| MCP servers | Agent-level MCP server list (merged with team-level at runtime) |
| Runtime status | `active` (currently executing), `idle` (not running) — set by system |
| Admin status | `enabled`, `disabled`, `terminated` — set by user |

### System prompt templating

The system prompt editor supports variables that are resolved at runtime:

| Variable | Resolves to |
|----------|------------|
| `{{team_name}}` | Team name |
| `{{team_description}}` | Team description |
| `{{reports_to}}` | Title of the agent's manager |
| `{{project_context}}` | Current project goal + recent task summaries |
| `{{skills_context}}` | The team's skills manifest (name + slug + one-line description for each active skill); agents load full bodies on demand via `get_skill(slug)` |
| `{{team_preferences_context}}` | Team preferences document — board working style preferences observed by agents |
| `{{project_docs_context}}` | All project documents for the current task's project (tech spec, implementation plan, research, UI decisions, marketing plan) |
| `{{agent_role}}` | The agent's own title |
| `{{requester_context}}` | When processing a human request: the requester's role (board/member), title, and permissions_text. Agents use this to decide whether to accept direction or escalate. |
| `{{current_date}}` | ISO date at time of resolution |

On agent creation, the UI provides a monospace editor with a toolbar for inserting variables, loading role templates, and Markdown preview support.

### Hire workflow (Captain-mediated)

New agents are not created by the board directly. When a board member submits the hire form (`POST /api/teams/:teamId/agents/onboard`), the server:

1. Validates the proposed title, slug uniqueness, and effort value.
2. Inserts an `approvals` row of type `hire` whose payload holds the full draft spec (`title`, `slug`, `role_description`, `system_prompt`, `default_effort`, `heartbeat_interval_min`, `monthly_budget_cents`, `touches_code`).
3. Opens an task in the Internal project, assigned to the Captain, titled `Onboard new agent: {title}`, labelled `onboarding,hire`, with the approval ID and the current draft in the body.
4. Wakes the Captain to process the ticket. **No `member_agents` row is created yet.**

The Captain picks up the ticket and refines the draft via the `update_hire_proposal(approval_id, ...)` MCP tool — Captain-only. Other agents (including the Architect) are rejected with `Only the Captain can revise hire proposals`. Revisions mutate the approval payload in place and do not reset the `status`. The Captain @-mentions the board via `create_comment` when the draft is ready for review.

The board reviews the draft in the approvals inbox and either approves or denies the pending `hire` approval.

- **Approved** → the `applyApprovalSideEffect` hook in `packages/server/src/routes/approvals.ts` inserts the `members` and `member_agents` rows from the latest payload, marks the agent as `enabled`, transitions the onboarding task to `done`, and broadcasts both row changes so the UI and org chart update live. Agent and team description refresh tasks are enqueued.
- **Denied** → no agent is created; the Captain is expected to close the onboarding task as `cancelled` with a brief note.

Bootstrap exception: if the team has no enabled Captain or no Internal project (e.g., the Captain itself is being hired first), the endpoint falls back to creating the agent directly as `enabled` without an approval or ticket. This is the only way to create an agent without the Captain-mediated flow and is intended solely for early setup.

### Built-in role templates

Hezo ships with 11 built-in agent types that form the default team for the "Software Development" team type. Full specifications for each role are in `agents/{slug}.md`. Role-specific instructions are embedded directly in the system prompt template — no separate skill files. Users can customize every field. All agent types are starting points, not fixed — agents can be added, removed, or reconfigured per-team.

Users can also create **entirely new custom agent types** with arbitrary titles, descriptions, system prompts, runtime types, and reporting lines. For example, a user could create a "Data Scientist", "Security Auditor", or "Legal Researcher" agent type — any role needed. Custom agent types are first-class citizens — agents created from them appear in the org chart, receive tasks, participate in delegation, and have their own budgets just like built-in types.

Agents can request updates to their own system prompts via `PATCH /agent-api/self/system-prompt`, subject to board approval. This allows agents to evolve their behavior when directed by a human member.

### Role-doc partials

Role docs for different team templates frequently share boilerplate — the same "no designated repo means no run" rule appears in every code-touching role, the same hire workflow belongs on every Captain prompt regardless of template. To avoid drift we resolve **section-level partials** at bundle time.

- Partials live under `agents/_partials/**/*.md`. They are plain Markdown with no frontmatter and are not seeded as role docs themselves.
- A role doc pulls one in with a **whole-line** directive: `{{> partials/<name>}}` (leading whitespace tolerated; anything else on the line makes it literal text). The name mirrors the path under `_partials/` without the `.md` suffix.
- Resolution runs in `scripts/bundle-agents.ts` before the bundle is zipped into `packages/server/src/db/agents-bundle.json`, and in the filesystem fallback (`loadAgentRoles` in `packages/server/src/db/agent-roles.ts`) used by tests and dev mode. The DB still stores fully expanded prompts; nothing reads partials at runtime.
- Partials may include other partials; cycles and unknown refs hard-fail the bundler. Runtime variable substitutions (`{{team_name}}`, `{{skills_context}}`, …) are untouched — those happen later in `template-resolver.ts` per-run.

Scope note: partials are strictly an **authoring-time convenience inside the Hezo repo**. Bundle-time resolution means the on-disk contract with the seed system is unchanged (flat Markdown). Future downloadable team bundles from a marketplace are expected to ship pre-expanded prompts; we do not plan to treat platform partials as a live dependency of third-party bundles, because that would force a compat contract across Hezo versions that we are not ready to make.

Current partials:

| Partial | Used by |
|---------|---------|
| `captain/always-max-effort` | `blank/captain.md`, `software-development/captain.md` |
| `captain/hire-workflow` | `blank/captain.md`, `software-development/captain.md` |
| `common/no-designated-repo` | all `touches_code: true` roles in `software-development/` |

### Agent and team auto-descriptions

Every agent carries a short summary (≤5 lines) describing its role and capabilities, plus a per-agent team-relationships blob (≤30 lines, second-person, injected into the agent's system prompt at run start). Every team carries a team summary (≤20 lines) describing how the agents collaborate. Built-in agent types ship with pre-baked defaults from `packages/server/src/db/agent-summaries.json`, copied to each agent and team during provisioning. At runtime the system enqueues a single `team-coherence-review` task in Internal on every roster/prompt/summary change; the Captain audits the org chart and rewrites all three artefact types via the `set_agent_summary`, `set_agent_team_context`, and `set_team_summary` MCP tools in one pass.

### Ticket workflow

Every feature ticket follows this flow:

```
1. Researcher → conducts research (competitive analysis, technical feasibility, market research)
2. Product Lead → writes PRD (stored as project doc, doc_type: prd), iterates with board via ticket comments until requirements are finalised
3. Architect → writes technical specification → board approves
4. UI Designer → creates design mockups → board approves (for UI-related tickets; skipped for non-UI work)
5. Engineer → implements, writes tests, updates docs. Can consult Architect during implementation.
6. UI Designer → reviews frontend implementation against design specs (for UI-related tickets)
7. QA Engineer → reviews and approves (final gate) OR sends back to Engineer
```

The research and product requirements phases happen in a dedicated task before implementation begins. The Researcher produces a research document (stored as a project doc), the Product Lead then uses it to write the PRD. The board engages in back-and-forth with the Product Lead via ticket comments until the product requirements are finalised and approved. Only then does the Architect proceed with the technical specification.

The board must approve the technical specification before implementation begins. For UI-related tickets, the board must also approve the UI Designer's mockups.

No ticket is considered complete until the QA Engineer has approved it. The QA Engineer verifies all tests pass (including Playwright E2E tests for UI), coverage meets targets, and the implementation matches both the Product Lead's acceptance criteria and the UI Designer's design specs.

Feature work uses a **single ticket** for both design and implementation. When a ticket has UI work, the UI Designer creates preview mockups first. Previews appear in the board inbox for approval — board can approve directly or delegate approval to the Product Lead. Only after design approval does the Engineer begin implementation.

**PRD changes require board approval.** The PRD is the source of truth that drives all downstream work. If any agent discovers that requirements need to change during implementation, the Product Lead must update the PRD and get board approval before the change takes effect. This ensures the board always has an accurate picture of what is being built.

**DevOps Engineer** joins the workflow later — when the board is ready for staging or production deployment of the application. DevOps is not involved in the typical feature ticket flow.

**Escalation path:** Engineer ↔ Architect disagreement → Captain mediates → Captain escalates to human board if needed.

### Role summaries

**Captain** — strategic direction, delegation, dispute resolution, escalation to board. Reports to board.

**Product Lead** — owns product requirements. Writes PRDs with acceptance criteria. Posts clarifying ticket comments (and structured-option cards when helpful) to resolve ambiguous requirements with the board. Ensures development aligns with team goals. Reports to Captain.

**Architect** — owns technical vision. Adds technical specs, architecture decisions, and implementation phases to tickets after the Product Lead's PRD. Reviews and approves the Engineer's implementation plans. Has technical authority — decides HOW to build things. Reports to Captain. Direct reports: Engineer, QA Engineer, UI Designer, DevOps Engineer.

**Engineer** — primary implementer. Writes code, tests, and documentation based on the Architect's spec. Can @-mention Product Lead, Architect, or UI Designer in ticket comments during implementation. Reports to Architect.

**QA Engineer** — final approval gate. Reviews every ticket for test coverage (90%+), security, performance, and correctness. Uses Playwright for E2E testing of UI. Sends tickets back to the Engineer if tasks are found. Proactively audits the codebase on regular heartbeats. Reports to Architect.

**UI Designer** — owns the visual and interaction layer. Creates HTML preview mockups before implementation. Provides component specs to the Engineer. Reviews the Engineer's frontend implementation for visual accuracy and accessibility. Reports to Architect.

**DevOps Engineer** — owns infrastructure and deployment. Manages staging/production environments, CI/CD pipelines, database migrations. Not part of the typical feature ticket flow — joins when board is ready for deployment. Reports to Architect.

**Marketing Lead** — owns marketing strategy and content. Writes blog posts, social media, changelogs, marketing copy (replaces the need for a separate Content Writer). Reports to Captain.

**Researcher** — conducts competitive analysis, technical research, and feasibility studies. First step in the ticket workflow — produces research that informs the Product Lead's PRD. Works with Captain, Architect, UI Designer, and Marketing Lead. Does NOT communicate directly with the Engineer. Reports to Captain.

**Security Engineer** — owns security posture. Reviews code for vulnerabilities, validates auth flows, audits dependencies, and ensures security best practices. Reports to Architect.

**Coach** — reviews completed tickets to extract lessons learned and improves other agents' system prompts. The Coach is the only agent permitted to write system prompts (via the `update_agent_system_prompt` MCP tool); changes apply immediately and every write snapshots a revision into `document_revisions` so the board can roll back from the agent settings page. Reports to no one (independent role).

### AGENTS.md — two tiers

**Team-level AGENTS.md** holds team-wide rules and conventions, editable via the Hezo UI. Injected into agent context at runtime via `{{team_agents_md}}`.

**Project-level AGENTS.md** lives at the root of each project's designated repo. This is the primary mechanism for enforcing project-specific engineering standards. Any coding agent (Claude Code, Codex, Gemini) automatically reads it from the repo root — no runtime-specific configuration needed.

Each repo in a project has its own `AGENTS.md` at its root. The designated repo's AGENTS.md is the primary source. Non-designated repos' AGENTS.md files defer to the designated repo's AGENTS.md and reference the project's documents (stored in the DB, surfaced to agents via the `{{project_docs_context}}` template variable). A `CLAUDE.md` at the repo root points to AGENTS.md (`@AGENTS.md`).

### Designated repo and project documents

Project documents are stored in the database (`project_docs` table), not the filesystem. Every project can have docs regardless of whether it has a repo. Common documents:
- `spec.md` — tech spec
- `prd.md` — product requirements (board approval required for agent changes)
- `implementation-phases.md` — ordered implementation plan
- `research.md` — research findings
- `ui-design-decisions.md` — design rationale
- Other ad-hoc documents

Agents read/write project docs via MCP tools (`list_project_docs`, `read_project_doc`, `write_project_doc`). Project docs are **markdown-only**; non-markdown files (mockups, wireframes, images, PDFs) live in the project **Assets** library and are listed via `list_project_assets` and referenced as `assets/<filename>`. PRD changes by agents require board approval; all other docs are updated freely. Project docs support semantic search via pgvector embeddings.

`AGENTS.md` is the exception — it stays as a git-tracked file at the repo root of the designated repo, since it needs to be discoverable by coding agents working in the repo.

Role-specific instructions are embedded directly in each agent's system prompt template — no separate skill files.

---

## 5a. Engineering rules and testing philosophy

These rules are embedded in the engineer agent's system prompt and in the team AGENTS.md. They apply to **any agent that modifies the codebase** — not just the engineer role.

### Mandatory practices for all code-modifying agents

1. **Tests are mandatory.** Every code change must include or update automated tests. No exceptions.
2. **Documentation is mandatory.** Every code change must update relevant documentation (README, inline docs, API docs, architecture docs). If no docs exist for the area being changed, create them.
3. **Target test coverage: 90%+ minimum, 100% when achievable.** Coverage is tracked and reported.

### Subagent parallelization rules

Agents must use subagents (Claude Code subagents, Codex parallel tasks) aggressively:

- **Codebase research and analysis** — always parallelize. Spawn subagents to read different modules/packages simultaneously, then synthesize findings.
- **Test execution** — always run in parallel (see testing rules below).
- **Diagnosing test failures** — run failing tests in parallel with isolated debugging subagents.
- **Multi-file changes** — when a change touches multiple independent files, use subagents to edit in parallel.

### Testing rules

Tests must be designed for **parallel execution** from day one. The default concurrency limit is 10 tests at a time.

**Port allocation:** Any test that needs a server, endpoint, or service instance must allocate a unique port to avoid conflicts with other tests running in parallel. The test harness provides a `getTestPort()` utility that allocates from a pool (e.g. 10000–60000) and guarantees no collisions.

**Database isolation via template databases:** Tests that need a database must NOT seed from scratch every time. Instead:
1. A **template database** is seeded once (with migrations + seed data) at the start of the test suite
2. Each individual test (or test file) **clones the template database** using Postgres `CREATE DATABASE ... TEMPLATE ...`
3. The cloned database is used for the test and dropped afterwards
4. This approach is fast (cloning is near-instant for Postgres) and fully isolated

**Test structure requirements:**
- Each test file must be independently runnable (no cross-file dependencies)
- Tests must clean up after themselves (no leaked state, ports, or processes)
- Flaky tests are treated as bugs and fixed immediately
- Integration tests that hit real services must use per-test port allocation
- Unit tests must be pure and fast (no I/O, no network, no filesystem when possible)

**Test execution flow:**
```
1. Create template database (once per suite)
2. For each test file (10 concurrent):
   a. Clone template database → test_db_{unique_id}
   b. Allocate test port(s) from pool
   c. Start server/service on allocated port (if needed)
   d. Run tests against isolated db + port
   e. Tear down server, drop cloned db, release port
3. Report results + coverage
```

### Git hooks — mandatory quality gates

Repos should commit their own git hooks (e.g., via Husky, lefthook, or `.git/hooks/`). Hezo does not inject hooks — it relies on repo-committed hooks. These are non-negotiable — agents cannot bypass them.

**Pre-commit hook:**
1. Run linter on staged files (language-appropriate: ESLint, Ruff, etc.)
2. If lint fails → commit is blocked. Agent must fix lint tasks first.

**Pre-push hook:**
Agents run tests locally using the project's test runner directly. This includes the full test suite, lint, build, and any other checks defined in the project's configuration. If any check fails, the push is blocked. The agent fixes the task immediately and retries. Only after all local checks pass does the push proceed to GitHub. The remote GitHub Actions still runs as a redundant safety check after push.

These hooks ensure that the `main` branch and all remote branches always have passing tests and clean lint. Broken code never reaches GitHub.

**Lint is mandatory.** Every repo must have a linter configured. If a repo is added without one, the engineer agent's first task is to set one up. The linter config lives in the repo (committed).

### QA agent — continuous code quality assessment

The QA agent is not just for running tests. It performs **regular, proactive audits** of the entire codebase on a scheduled basis (default: every heartbeat). The QA agent assesses:

| Area | What it checks |
|------|---------------|
| **Test coverage** | Runs coverage reports. Flags modules below 90%. Creates tasks for coverage gaps. |
| **Security** | Scans for dependency vulnerabilities, hardcoded secrets, injection risks, auth bypasses. |
| **Performance** | Identifies N+1 queries, unbounded loops, missing indexes, memory leaks, large bundle sizes. |
| **Correctness** | Reviews business logic for edge cases, race conditions, error handling gaps. |
| **Maintainability** | Flags overly complex functions (cyclomatic complexity), dead code, duplicated logic. |
| **Documentation** | Checks that public APIs have docs, README is current, architecture docs match code. |

The QA agent creates tasks for each finding, tagged with severity and category. It also runs the full test suite regularly and creates tasks for any flaky tests.

### Staging and production deployment

Hezo manages a two-environment deployment pipeline: **staging** (automatic) and **production** (manual approval).

#### Staging environment

Configured per project in project settings:

| Component | Configuration |
|-----------|-------------|
| **Hosting** | Railway, DigitalOcean, or Vercel (configurable per project) |
| **Database** | Neon (managed Postgres). One staging database per project. |
| **Deployment trigger** | Automatic on push to `main` branch |
| **Migrations** | Run as part of the GitHub Actions release workflow, before the app starts |

**How staging deploys work:**
1. Agent pushes to `main` (after passing pre-push hooks)
2. GitHub Actions workflow triggers:
   a. Run full test suite (redundant safety check)
   b. Run database migrations against Neon staging database
   c. Build and deploy to staging hosting provider
   d. Run smoke tests against the deployed staging URL
3. Deploy status is reported back to Hezo as a system comment on the relevant task

**Staging config is stored as project-level secrets:**
- `STAGING_DEPLOY_URL` — the staging site URL
- `STAGING_DATABASE_URL` — Neon connection string
- `STAGING_DEPLOY_TOKEN` — hosting provider API token
- `STAGING_DEPLOY_PROVIDER` — `railway`, `digitalocean`, or `vercel`

#### Production deployment

Production deploys are **never automatic**. They always require explicit human approval.

**Flow:**
1. Agent or board member requests a production deploy (creates a `deploy_production` approval)
2. The approval shows: what's changed since last production deploy (commit list), staging test results, staging URL for manual verification
3. Human reviews the staging site and verifies correct functioning
4. Human approves the deploy in the approval inbox
5. GitHub Actions workflow runs: migrations against production database → deploy to production hosting
6. Deploy status reported back to Hezo

**Production config is stored as project-level secrets:**
- `PRODUCTION_DEPLOY_URL`
- `PRODUCTION_DATABASE_URL`
- `PRODUCTION_DEPLOY_TOKEN`
- `PRODUCTION_DEPLOY_PROVIDER`

#### GitHub Actions workflow

Hezo auto-generates a `.github/workflows/deploy.yml` in each repo when staging is first configured. The workflow handles both staging (on push to main) and production (on manual dispatch with approval). Database migrations use the repo's migration tooling (detected automatically or configured in project settings).

### What goes in AGENTS.md (team-level)

The auto-generated AGENTS.md includes:
- All engineering rules above (testing, parallelization, documentation)
- Git hook rules: never bypass pre-commit or pre-push hooks
- Lint rules: all code must pass lint before commit
- Test rules: all tests must pass before push, 90%+ coverage target
- Code style and formatting conventions
- Git branch naming conventions (e.g. `feat/`, `fix/`, `chore/`)
- PR / commit message format
- Architecture overview and module boundaries
- Dependency management rules
- Security practices (no secrets in code, input validation, etc.)
- Staging/production deployment rules
- Documentation requirements: every code change updates docs

This file evolves over time as agents propose updates through the KB approval flow.

### Role-specific instructions (in system prompts)

Role-specific instructions are embedded directly in each agent's system prompt template — not in separate files. Each role's system prompt includes the relevant rules and methodologies:
- **Product Lead:** PRD writing methodology, acceptance criteria standards, requirements gathering via ticket comments and structured-option cards, scope management rules
- **Architect:** Technical spec templates, architecture decision records, implementation phase planning, code review authority
- **Engineer:** Parallelization rules, testing philosophy, template database patterns, port allocation, pre-push verification steps
- **QA Engineer:** Audit checklist (security, performance, correctness, maintainability, coverage), Playwright E2E testing, severity classification, flaky test detection
- **UI Designer:** Component conventions, accessibility guidelines (WCAG 2.1 AA encouraged), design system references, preview mockup standards
- **DevOps Engineer:** Staging/production config, GitHub Actions workflow templates, Neon database management, migration strategies
- **Marketing Lead:** Content writing guidelines, brand voice, social media best practices, release notes templates
- **Researcher:** Research methodology, source evaluation criteria, report templates, competitive analysis frameworks

---

## 5. Agent execution — filesystem and Docker

### Host filesystem layout

All Hezo data lives under `~/.hezo/` on the host machine. The structure mirrors the team → project → repo hierarchy:

```
~/.hezo/
├── pgdata/                              # PGlite database (NodeFS persistence)
├── data/                                # Previews, temp files, assets
│
└── teams/
    ├── acme-corp/                        # Team folder
    │   └── projects/
    │       ├── backend-api/              # Project folder
    │       │   ├── api/                  # Git clone of org/api — DESIGNATED REPO
    │       │   │   ├── AGENTS.md         # Project-level agent rules (repo root)
    │       │   │   └── CLAUDE.md         # @AGENTS.md
    │       │   ├── shared-lib/           # Git clone of org/shared (non-designated)
    │       │   │   ├── AGENTS.md         # Defers to designated repo's AGENTS.md
    │       │   │   └── CLAUDE.md         # @AGENTS.md
    │       │   ├── worktrees/            # Git worktrees for parallel work (project-level)
    │       │   │   ├── api-feat-auth-agent-123/
    │       │   │   └── api-fix-tests-agent-456/
    │       │   └── .previews/            # Agent preview files (per project)
    │       │       └── {agent_id}/
    │       │
    │       └── frontend/                 # Another project
    │           ├── web-app/              # Git clone — DESIGNATED REPO
    │           │   ├── AGENTS.md
    │           │   └── CLAUDE.md
    │           ├── worktrees/
    │           └── .previews/
    │
    └── notegenius/                       # Another team
        └── projects/
```

**Key design decisions:**

`AGENTS.md` lives at the **repo root** of each project's designated repo. Project documents live in the `project_docs` DB table, accessible to agents via MCP tools. This means:
- Each project has its own AGENTS.md with project-specific rules
- Team-level rules are in the KB docs DB table, injected at runtime
- Any coding agent (Claude Code, Codex, Gemini) automatically reads AGENTS.md from the repo root
- Project documents have full revision history in `project_doc_revisions`
- Non-designated repos defer to the designated repo's AGENTS.md and access shared project docs through the same MCP tools

### Git worktrees for parallelism

Repos are cloned once (via SSH) into the project's `workspace/<repo-name>/` directory (the repo name is the segment after the owner in the `org/repo` identifier). When an agent starts a run on an task, the runner lazily creates a **git worktree per (task × repo)** so iterative work across runs on the same task persists and concurrent tasks cannot collide.

- Multiple agents working on different tasks use different worktrees — no conflicts.
- Repeated runs on the same task reuse the existing worktree, pulling latest changes via `git fetch` + fast-forward merge.
- The agent's working directory is the **designated repo's worktree**; other repos sit alongside and the agent can `cd` into them.

Worktree layout: `~/.hezo/teams/{team}/projects/{project}/worktrees/{task-identifier}/{repo-name}/`
Branch name: `hezo/{task-identifier}`

Worktrees are created on first run of an task and removed when the task transitions to a terminal status (done/cancelled) or its repo is detached.

### Docker container configuration

Each project gets its own Docker container. All repositories linked to the project are checked out inside the container under `/workspace/`. Agents working on tasks in that project run as **subprocesses** inside the project's container, making them easy to kill and restart independently.

If a team has 3 projects, 3 containers run. If a project has multiple repos, they all live inside the single project container.

| Aspect | Configuration |
|--------|-------------|
| Base image | Configurable per project (default: `hezo/agent-base:latest`, built from `docker/Dockerfile.agent-base` with `claude`, `codex`, `gemini`, `opencode`, and `kimi` CLIs pre-installed) |
| Project mount | Host `~/.hezo/teams/{team}/projects/{project}/` → Container `/workspace/` (rw) |
| Worktrees mount | Host `~/.hezo/teams/{team}/projects/{project}/worktrees/` → Container `/worktrees/` (rw) |
| SSH keys | Project's Ed25519 key served via the per-run `SshAgentServer` over `SSH_AUTH_SOCK`; the private key (encrypted on the project's backing team row) is never written to disk. |
| Git config | Identity (name, email, signing key) injected via `GIT_CONFIG_*` env entries — no `.gitconfig` file. |
| SSH agent | Per-run agent socket bridged into the container via socat; serves both commit signing and `git@github.com:` auth. |
| AGENTS.md | Per-repo at repo root. Designated repo's AGENTS.md is the primary source. Non-designated repos reference it. |
| Project docs | In `project_docs` table, accessed by agents via MCP tools (`list_project_docs`, `read_project_doc`, `write_project_doc`) |
| Secrets | Injected as environment variables per subprocess (never container-wide, never written to disk) |
| Connected platforms | All OAuth tokens from all connected platforms injected per subprocess for all agents. Platform MCP servers available. |
| Previews | Written to `/workspace/.previews/{agent_id}/` — visible on host via the shared volume |
| Dev ports | Forwarded from container to host for dev preview (e.g., container:3000 → host:13000). Auto-allocated from pool. |
| Network | `host.docker.internal:3100` for Agent API access |
| Isolation | All agents working on the same project share the container. Different projects have separate containers. |

### Dev preview

Project containers support **port forwarding** so users can interact with the running dev version of a project in a browser. When an agent runs a dev server inside the container (e.g., `npm run dev` on port 3000), the port is forwarded to the host.

- Port mapping is stored per project as JSONB: `[{"container": 3000, "host": 13000}]`
- Hezo auto-allocates host ports from a pool (10000–19999) to avoid conflicts between projects
- The project detail UI shows a "Dev Preview" link when active ports are detected
- Hezo proxies these ports through its own server (`GET /dev/{project_id}/`) for a consistent URL

### SSH and Git authentication

Hezo generates one Ed25519 key per project and registers its public key on the connected GitHub account via the OAuth API — as both a signing key (commits land Verified) and an authentication key (SSH git transport). The private key is stored encrypted on the project's backing team row (`team_ssh_keys`); agents never see it and it is never written to disk.

At runtime, both git authentication and commit signing go through a per-run `SshAgentServer` reachable via `SSH_AUTH_SOCK`:

1. The server holds the project's key and answers ssh-agent-protocol requests over a host Unix socket (host-side ops) and a loopback TCP listener bridged into the container by socat (in-container ops)
2. `GIT_SSH_COMMAND` points SSH at that agent (`IdentityAgent=$SSH_AUTH_SOCK`); `git@github.com:` clone/fetch/push authenticate through it
3. Commit signing uses `ssh-keygen -Y sign` against the same agent; git identity (name, email, signing key) is injected via `GIT_CONFIG_*` env entries, so the container needs no `.gitconfig`
4. The GitHub OAuth token is used for GitHub API calls (repo validation, PRs, Actions) — never for git transport, which is always SSH

See `.dev/ssh-signing.md` for the full design.

### Container lifecycle

| Event | What happens |
|-------|-------------|
| Project created | Container provisioned from the project's configured base image. All linked repos cloned inside via SSH. |
| Agent heartbeat (for project task) | Subprocess spawned inside the project's container with the agent's environment. |
| Agent disabled | Subprocess killed (if running). Container unaffected. |
| Agent terminated | Subprocess killed. Container unaffected. Agent record kept for audit. |
| Container rebuilt | All agent subprocesses killed, container destroyed, new one provisioned. |
| Project deleted | Container destroyed. All associated worktrees cleaned up. |
| Team deleted | All project containers destroyed. |
| Server startup / every 5s | Container status sync — DB state reconciled with Docker. Stale "running" status corrected to "stopped" or "error". Changes broadcast via WebSocket. |
| Task assigned | No-op until the first run. Worktrees are created lazily when an agent starts executing against the task. |
| Task first run | Runner creates `/worktrees/{task-identifier}/{repo-name}/` on branch `hezo/{task-identifier}` for every linked repo, then runs the agent with the designated repo's worktree as its working directory. |
| Task closed | Per-task worktree directory `/worktrees/{task-identifier}/` is removed (all per-repo worktrees under it). |

### Agent subprocess model

Each heartbeat spawns a **fresh subprocess** inside the project's container via `docker exec`. The Hezo orchestrator spawns each agent process with:

- The agent's specific environment variables (secrets, all platform OAuth tokens, agent JWT)
- The correct working directory (the agent's assigned worktree or project folder)
- The agent's runtime command (e.g., `claude-code`, `codex`, `gemini`)
- Handoff markdown from the previous session as initial context (for session continuity)

All template variables (`{{skills_context}}`, `{{project_docs_context}}`, `{{team_preferences_context}}`, etc.) are pre-resolved by the orchestrator before spawning. The skills manifest and all project docs are included for MVP.

Agents can be killed and restarted independently without affecting the container or other agents. When budget is exceeded, the subprocess is terminated immediately. If a project container leaves the `running` state — whether through removal (`error`) or stop (`stopped`) — the container-sync loop synchronously fails every in-flight heartbeat run for that project's tasks with an `error` of `container_error` or `container_stopped` respectively, resets the affected agents' `runtime_status` to `idle`, releases their execution locks, and broadcasts the row changes. When the container is later rebuilt or re-provisioned, runs that died with `container_error` are auto-re-queued via fresh wakeups; runs that died with `container_stopped` are intentionally left alone (the user paused work; they restart it manually).

### Subagents (built-in parallelism)

Agents can use their runtime's native parallelism to speed up work — Claude Code's subagents, Codex's parallel tasks, etc. These are **not** new Hezo agents. They are ephemeral child processes inside the agent's subprocess.

Rules:
- Subagents share the parent's budget and secret grants
- Their tool calls are reported under the parent agent's comment
- No approval needed — the parent already has permission
- Hezo does not manage subagent lifecycle — that's the runtime's job
- Subagent costs are debited against the parent agent's budget

### MCP servers (Model Context Protocol)

Agents can connect to MCP servers for tool discovery and external service access. MCP servers are configured at two levels:

**Team-level** — shared by all agents. Configured in team settings. Good for shared infrastructure: team Slack, team database, shared SaaS tools.

**Agent-level** — specific to one agent. Configured in agent settings. Good for role-specific tools: a dev engineer's database access, a Marketing Lead's analytics platform.

At runtime, team-level and agent-level servers are merged. Agent-level takes precedence on name conflicts. The merged list is injected into the agent's subprocess as MCP configuration for the runtime (Claude Code, Codex, etc.) to discover and use.

MCP server config per entry: `{ "name": "...", "url": "...", "description": "..." }`. Stored as JSONB arrays on both `teams` and `agents`.

### MPP (Machine Payments Protocol)

Agents can pay for third-party APIs autonomously using the Stripe/Tempo Machine Payments Protocol. When an agent hits an HTTP 402 response from an MPP-compatible service, it can authorize payment and receive the resource in one round-trip.

**Team-level config:**
- MPP wallet address (Tempo or Stripe)
- Wallet private key stored in the secrets vault (referenced by name, never exposed)
- Default currency (USD, EUR, USDC, etc.)
- Enabled/disabled toggle

**How it works at runtime:**
1. The project container has `mppx` CLI pre-installed
2. Wallet credentials are injected as environment variables (same mechanism as secrets)
3. Agent calls a paid API → gets 402 → `mppx` handles payment flow automatically
4. Payment amount is reported as a tool call cost and debited against the agent's budget
5. If budget would be exceeded, payment is blocked and a budget-exceeded notification is sent to the board inbox

**MPP Payment Directory** — agents can discover 100+ MPP-compatible services (model providers, search APIs, data services, compute platforms) without manual signup or API keys.

MPP costs appear in the same cost tracking dashboard as all other agent spend — per agent, per task, per project.

---

## 5b. Hezo Connect — OAuth gateway

> Full specification: `connect-spec.md`

Hezo Connect is a standalone backend service that handles OAuth flows on behalf of local Hezo instances. It eliminates the need for each user to register OAuth apps with every provider. Two deployment modes: **self-hosted** (open source, free) or **centrally hosted** (connect.hezo.ai, managed by Hezo project, with billing and API keys).

### Architecture

Two components work together:

**Hezo Connect (self-hosted or connect.hezo.ai)**
- Standalone service that holds registered OAuth apps for each supported provider
- Handles the OAuth dance: redirects, consent screens, callbacks, token exchange
- Delivers tokens to the local Hezo instance via browser redirect (not server-to-server POST)
- Does NOT store tokens long-term — it is a transient relay
- Open-source — users who want full self-hosting can deploy their own instance and register their own OAuth apps
- The Hezo project runs the canonical instance so most users don't need to do anything
- In self-hosted mode: stateless, no database, no API keys — just OAuth app credentials (signing key auto-generated, exposed via public endpoint)

**Hezo app (local)**
- Initiates OAuth flows by redirecting to Hezo Connect
- Receives tokens via browser redirect to the callback URL
- Verifies state signature, encrypts and stores tokens in the local secrets vault
- Handles token refresh locally using refresh tokens
- Exposes connected platforms as team-level MCP servers
- Manages connection lifecycle: connect, disconnect, health check, refresh

### OAuth flow

```
1. User clicks "Connect GitHub" in Hezo UI
2. Hezo app redirects to: localhost:4100/auth/github/start
     ?callback=http://localhost:3100/oauth/callback
     &state={signed_payload_with_team_id}
3. Hezo Connect redirects user to GitHub OAuth consent screen
4. User authorizes
5. GitHub redirects to localhost:4100/auth/github/callback
6. Hezo Connect exchanges auth code for access token
7. Hezo Connect redirects browser to the Hezo app callback with tokens:
     http://localhost:3100/oauth/callback?platform=github&access_token=...&state=...
8. Hezo app verifies state, encrypts token, stores in secrets vault as:
     GITHUB_ACCESS_TOKEN
9. Hezo Connect purges tokens from memory
10. Browser redirects to Hezo UI showing "GitHub connected"
```

Token delivery uses a browser redirect rather than a server-to-server POST. This
avoids Hezo Connect needing to make outbound HTTP calls to the local Hezo app.

### Hezo Connect OAuth link validity

When agents need access to external resources (GitHub repos, Vercel, Railway, etc.), Hezo Connect generates an OAuth authorization link. The link request appears as a comment in the ticket AND in the board inbox. OAuth links are valid for **24 hours** to give board members time to see the notification and authorize.

### Token lifecycle

- **Access tokens** expire (typically 1 hour). The Hezo app refreshes them automatically using the stored refresh token.
- **Refresh tokens** are long-lived. If a refresh fails (user revoked access, token expired), the connection status is set to `expired` and the board is notified to re-authorize.
- **Token refresh is local** — no round-trip to Hezo Connect needed. Only the initial OAuth flow uses Hezo Connect.

### Connection management

Each connection is stored in a `connected_platforms` table:

| Field | Description |
|-------|-------------|
| `team_id` | Which team owns this connection |
| `platform` | `github`, `gmail`, `gitlab`, `stripe`, `posthog`, `railway`, `vercel`, `digitalocean`, `x` |
| `status` | `active`, `expired`, `disconnected` |
| `access_token_secret_id` | FK to secrets table (encrypted access token) |
| `refresh_token_secret_id` | FK to secrets table (encrypted refresh token) |
| `scopes` | OAuth scopes granted |
| `metadata` | Platform-specific data (e.g. GitHub username, Gmail address) |
| `token_expires_at` | When the current access token expires |
| `connected_at` | When the connection was established |

When a platform is connected, it is automatically registered as a team-level MCP server entry. Agents can then use the platform's tools via MCP tool calls without knowing anything about OAuth.

### Self-hosting Hezo Connect

For users who want zero dependency on the canonical instance:
1. Deploy the open-source Hezo Connect server
2. Register OAuth apps with each provider (Google, GitHub, etc.)
3. Configure the Hezo app to point to the self-hosted instance: `--connect-url https://my-connect.example.com`

### Supported platforms (MVP)

| Platform | OAuth type | Scopes | MCP tools exposed |
|----------|-----------|--------|-------------------|
| GitHub | OAuth 2.0 | `repo`, `workflow`, `read:org` | Repo CRUD, PR management, Actions, tasks |
| Gmail | OAuth 2.0 | `gmail.send`, `gmail.readonly` | Send/receive email, search, labels |
| GitLab | OAuth 2.0 | `api`, `read_repository` | Repo access, CI/CD pipelines |
| Stripe | OAuth 2.0 (Connect) | `read_write` | Payments, subscriptions, invoices |
| PostHog | OAuth 2.0 | `read` | Analytics queries, feature flags |
| Railway | OAuth 2.0 | `project:read`, `project:write` | Deploy, environment management |
| Vercel | OAuth 2.0 | `read`, `write` | Deployments, domains, env vars |
| DigitalOcean | OAuth 2.0 | `read`, `write` | Droplets, databases, apps |
| X (Twitter) | OAuth 2.0 | `tweet.read`, `tweet.write`, `users.read` | Post tweets, read timeline, DMs |

---

## 6. Repo management

### Supported hosts

GitHub only (MVP). Repos are stored as `org/repo` identifiers (e.g. `acme-corp/frontend`). Validated at the app layer via GitHub API. GitLab support available via OAuth connection for future use.

### Repo access — OAuth for API, SSH for git

Git operations (clone, push, pull) use **SSH** with the project's Ed25519 key. The GitHub **OAuth token** is used for API calls (repo validation, PRs, Actions, tasks).

```
git clone git@github.com:org/repo.git
```

Hezo generates one Ed25519 key per project, stores the private key encrypted on the project's backing team row (`team_ssh_keys`), and registers the public key on the connected GitHub account via the OAuth API. When a new repo is added, the system tests access using the OAuth token (GitHub API) before saving. If access fails, the board is told which GitHub account needs access.

**Prerequisites:**
- The project must have a GitHub OAuth account connected
- The connected GitHub account must have access to the repo
- The project's SSH key is auto-registered on the GitHub account

### Repos belong to projects

- A project can reference multiple repos
- Each repo is labelled by its own name — the segment after the owner in the `org/repo` identifier (e.g. `frontend`, `api`, `infra`)
- Repo names are used for @-mentioning in task comments: `@frontend`, `@api`
- Repo-name uniqueness is enforced within a project, even across owners (DB unique index on `split_part(repo_identifier, '/', 2)`), because the name is also the workspace directory

### What happens when a repo is linked

When a repo is added to a project via the API:

1. **GitHub connection check** — the system checks whether the team has an active GitHub OAuth connection (`connected_platforms` table). If not:
   - The request fails with `GITHUB_NOT_CONNECTED`
   - A board inbox item of type `oauth_request` is created automatically, prompting the board to connect GitHub via Hezo Connect
   - The inbox item includes an actionable link to start the OAuth flow
2. **Repo access validation** — using the connected GitHub OAuth token, the system calls the GitHub API (`GET /repos/{owner}/{repo}`) to verify the authorized GitHub user has access. If access fails (403/404):
   - The request fails with `REPO_ACCESS_FAILED`
   - The error message includes the GitHub username from `connected_platforms.metadata` so the board knows which account needs access: *"Cannot access this repo — the GitHub user '{username}' needs to be added to {owner}/{repo}"*
3. The repo is cloned (via SSH using the project's generated key) into `~/.hezo/teams/{team}/projects/{project}/{repo-name}/`
4. A symlink is created: `{repo-name}/AGENTS.md → ../../../AGENTS.md` (pointing to team-level AGENTS.md)
5. Git SSH command is configured to use the project's SSH key for all operations
6. The repo is now available to any agent working on tasks in this project

### Agent access to repos

Agents don't configure repos directly. They get access to repos through whichever project their assigned tasks belong to. When an agent starts work on an task, a git worktree is created from the relevant repo clone so the agent can work on its own branch without interfering with other agents.

### Designated repo setup (board-driven)

A project starts with no repo. The first time an agent whose `member_agents.touches_code = true` is activated on an task, the runtime pauses the run and surfaces a board-facing action. The `touches_code` flag is seeded from `agent_types.touches_code` at hire time (builtin coder roles — engineer, architect, qa-engineer, devops-engineer, security-engineer, ui-designer — ship with it set), copied onto `member_agents` so per-agent overrides are possible, and editable from the agent creation and settings forms for any custom or onboarded agent:

1. The job manager upserts a single pending `oauth_request` approval per `(team, project)` with `payload.reason = 'designated_repo'`. Concurrent runs on different tasks of the same project share this one approval (partial unique index).
2. An `action` comment with `content.kind = 'setup_repo'` is posted on the triggering task. Each task gets its own comment so the blocker is visible in-thread, but all comments point at the same approval.
3. The agent's wakeup is marked `Deferred`.

Clicking the comment (or opening the approval from the inbox) launches the repo-setup wizard:

- **Step 1 (skipped if already connected):** "Connect GitHub" redirects through Hezo Connect. On callback, the server auto-generates an Ed25519 SSH key for the team, uploads the public key to GitHub via `POST /user/keys`, and stores the encrypted private key in the secrets vault. This step is idempotent — re-clicking after GitHub is already connected skips the regenerate/upload.
- **Step 2:** Pick an org (the authenticated user's personal namespace plus every org they belong to) and choose between **Create new** (default — name + private/public toggle) or **Select existing** (typeahead across accessible repos in that owner).

Submitting the wizard calls `POST /repos` which, in one transaction:

1. Locks the project row (`FOR UPDATE`).
2. Creates the repo on GitHub (if `mode=create`) or validates access (if `mode=link`).
3. Inserts the `repos` row.
4. If the project has no designated repo yet, sets `designated_repo_id = new.id`.
5. Sweeps every pending `action` setup-repo comment for this project, stamps each with `chosen_option = { status: 'complete', result: {...} }`, and appends a `system` confirmation comment per affected task.
6. Resolves the pending approval.

Post-commit the server clones the repo into the host workspace (`ensureProjectRepos`), then brings up the project container if it isn't already (`provisionContainer`) so `/workspace/{repo-name}/` is live inside the container. Only then are the deferred wakeups re-enqueued as fresh `Automation` wakeups, so agents never wake up against an empty workspace.

### Designated repo is immutable

Once set, `designated_repo_id` cannot be changed and the designated repo cannot be deleted. The FK is `ON DELETE RESTRICT` at the schema level and `DELETE /repos/:id` returns 409 `DESIGNATED_REPO_IMMUTABLE` for the designated repo. Non-designated repos can be added and removed freely from project settings.

---

## 7. Goal and project hierarchy

Context flows down the hierarchy, with each task tracing its lineage to the team's objectives:

```
Team Description
  └── Project (description / objectives)
        └── Task / Task
```

Every task carries context tracing back to the team description. Agents always know *what* to do and *why*. The context chain is visible in the task detail sidebar.

### Projects

- Group related work under a team
- Have a name and a goal statement
- Own repos (see section 6)
- Own project-scoped secrets

#### Captain-led project intake

User-facing projects are not created directly. Submitting the Create Project form
opens a pending `project_creation` approval and a `project-intake` ticket in the
team's Internal project assigned to the Captain (mirroring first-run onboarding's
flow, which uses a `team_template` approval). The Captain Q&As with the board on
the intake ticket, checks the team has the right specialists for the proposed work
(opening hire approvals through the existing hire flow when gaps exist), refines
the proposal via `update_project_creation_proposal`, and asks the board to approve
in the inbox. The board's approval is what actually creates the project + planning
task and closes the intake ticket. Skipping the intake Q&A is supported via a
"Skip questions" button on the intake ticket — same UX as onboarding.

---

## 8. Task / ticket system

GitHub-style task tracker. Tasks are the primary interaction surface for the entire system.

### Task properties

| Field | Required | Description |
|-------|----------|-------------|
| Title | Yes | Short description |
| Description | No | Detailed markdown body |
| Project | **Yes (enforced)** | Every task must belong to a project |
| Assignee | No | Agent or board member assigned to work on it (polymorphic: `assignee_type` + `assignee_id`) |
| Status | Yes | `backlog`, `in_progress`, `review`, `blocked`, `done`, `closed`, `cancelled` |
| Priority | Yes | `urgent`, `high`, `medium`, `low` |
| Labels | No | Free-form tags (JSONB array) |
| Parent task | No | For sub-tasks / delegation |
| Number | Auto | Per-project auto-incrementing (atomic) |
| Identifier | Auto | Linear-style: `{project.task_prefix}-{number}` (e.g. `IN-42`). Unique per team. |
| Blocked by | No | References to other tasks blocking this one (many-to-many via `task_dependencies` table) |
| Progress summary | No | Concise markdown summary of requirements, what's done, and what's next. Updated by agents when they start/finish work on the task. Collapsed by default in UI. |
| Progress summary updated at | Auto | Timestamp of last progress summary update |
| Progress summary updated by | Auto | Member (agent) who last updated the progress summary |

### Task status state machine

Not all status transitions are valid. The allowed transitions are:

```
backlog → in_progress, cancelled
in_progress → review, blocked, cancelled
review → in_progress, done, cancelled
blocked → in_progress, cancelled
done → closed, in_progress (reopen)
closed → backlog (reopen)
cancelled → backlog (reopen)
```

The system enforces these transitions. Invalid transitions return an error.

**Auto-promotion on run start.** When an agent's heartbeat run starts on an task assigned to that agent, the system promotes `backlog → in_progress` atomically as part of the run-creation transaction (see `createHeartbeatRun` in `services/agent-runner.ts`). The transition is gated on `assignee_id === agent.id` and `status === backlog` — mention-triage runs by non-assignees do not flip the column, and deliberate states (`review`, `blocked`) are never overwritten by run start. The change is broadcast on the `tasks` row channel so kanban surfaces update in real time.

**Inviolable closure rules.** Two server-enforced guards block the `→ done` and `→ closed` transitions when the ticket is not actually finished:

- **Sub-tasks must be closed first.** A ticket with sub-tasks cannot move to `done` or `closed` while any sub-task is in any state other than `closed`. Sub-tasks only reach `closed` after the Coach completes its post-mortem (see `services/job-manager.ts` — Coach success on an `task_done` wakeup transitions the child `done → closed`). The guard is applied in the task PATCH route, in the `update_task` MCP tool, and as defense-in-depth in the Coach auto-close path itself. See `assertChildrenAllClosed` in `lib/task-relationships.ts`.
- **No outstanding pinged-agent activity.** A ticket cannot move to `done` while another agent (i.e. not the caller) has a `heartbeat_runs` row for it in `queued` / `running`, or while any `mention` / `comment` / `reply`-source `agent_wakeup_requests` referencing the ticket is `queued` / `claimed` / `deferred`. The caller's own runs/wakeups are excluded (an agent finishing its own ticket from inside its own run is fine), and `assignment` / `timer` / `automation` wakeups are excluded (those aren't pings). The guard is applied to `→ done` only; see `assertNoOutstandingActivity` in `lib/task-relationships.ts`.

Both guards return a 400 from the REST route and an `error` field from the MCP tool, with a message naming the blocking child or agent so the caller knows what to wait on.

### Task list view

- Every task row shows its **project tag** prominently (color-coded) and its **identifier**
- Filterable by: project, assignee, status, priority, labels
- Searchable by title and description
- Sortable by created date, updated date, priority
- Paginated (default 50 per page)

### Task detail view

The primary work surface. Contains two tabs:

**Header (always visible):**
- Title, description, metadata (project tag, identifier, status, priority, assignee)
- Quick action buttons: reassign, change status, escalate, pause agent
- Goal chain sidebar (team description → project → task)
- Cost for this task
- Process status of the assigned agent

**Comments:**
- Threaded conversation between board and agents — the single conversation surface on each ticket
- Collapsible trace logs per agent message (tool calls, decisions)
- **Progress summary** — appears after the latest comment, collapsed by default. Shows the current state of work: requirements, what's done, what's next. Updated by agents when they start/finish work. Expandable to view full markdown content. When an agent operates on an task, a `trace`-type comment is posted capturing the agent run (progress summary changes, link to run output, sub-operations).

### Threaded conversation

Comments in the thread can be:

| Type | Author | Description |
|------|--------|-------------|
| `text` | Board or agent | Regular message |
| `options` | Agent | Clickable choice cards (see section 10) |
| `preview` | Agent | Link to rendered HTML file (see section 10) |
| `trace` | Agent | Collapsible tool-call log |
| `system` | System | Auto-generated (e.g. "Agent disabled — budget limit") |

### Delegation

Agents can delegate work to direct reports or peers (agents at the same level in the org chart). Delegation allows both downward and lateral assignment.

The choice between sub-task and top-level ticket is governed by the **deliverable-feed test**: a sub-task is for work whose output feeds into the parent ticket's deliverable (the parent isn't done until the sub-task is). Independent work — including the canonical case of a Captain drafting a plan and creating tickets for direct reports — is opened as **top-level**, not as a sub-task of the planning ticket. Each delegated ticket is the report's own first-class work, owned end-to-end by them.

Use a sub-task when the new work is a parallelisable slice of the parent's deliverable, a prerequisite blocking the parent, or a sub-task whose output rolls up into the parent. Sub-tasks inherit the parent's project. Use a top-level ticket when the new work has its own lifecycle, lives in a different domain or project, or is a delegated deliverable owned by another agent.

The hierarchy is capped at depth 2 — top-level tickets can have sub-tasks, and each sub-task can have its own sub-tasks, but no further. The server enforces this on `POST .../sub-tasks` and on MCP `create_task` calls that set `parent_task_id`.

**Planning tickets are never parents.** Tickets labeled `planning` (Captain-owned plan-drafting tickets — the auto-created "Draft execution plan for …" ticket on project creation) are by convention never used as `parent_task_id`. Milestone / report tickets spawned from a draft execution plan are top-level — each is the assignee's own first-class deliverable, not a slice of the plan. This convention is enforced in the agent prompts (`agents/_partials/common/planning-ticket-children.md`, `mention-handoff.md`, `subtask-preference.md`, `software-development/captain.md`) and in the body of the auto-created planning ticket itself (`project-create.ts`). The closure rules above make the consequence concrete: nesting a report's ticket under a planning ticket would freeze the planning ticket's lifecycle to every report's work.

### Agent-to-agent communication

All inter-agent communication happens through @-mentions in task comments — same as GitHub. No side channels, no direct messaging, no hidden state. Everything is on the record and fully traceable.

An agent can `@architect` or `@engineer` in a comment. The mentioned agent wakes immediately (see §Event-based triggers). The slug for @-mentions is derived from the agent title (lowercased, spaces → hyphens). Slugs are unique within a team.

Every agent's resolved system prompt is auto-appended with a **Teammates** block listing each enabled peer in the team in `@<slug> — Title` form, sourced from `member_agents` filtered by `admin_status = 'enabled'` and excluding the running agent itself. This is the authoritative slug list at compose time — agents read it inline rather than calling `list_agents` on every reference. The block sits between the Project State block and the shared working guidelines.

Repo names can also be @-mentioned: `@frontend`, `@api` — these reference the repo, not an agent.

**Handoff contract.** When an agent is woken by a mention, its run opens on the triggering ticket for *triage only* — not as new assigned work. The agent's task prompt is prepended with a Mention Handoff block showing the mentioner, the full comment, and the agent's own open tickets. The expected behaviour is:

- If one of the agent's open tickets already covers the topic of the mention, the agent updates that ticket's description, rules, or progress_summary to reflect what was communicated and references the triggering ticket so the handoff is traceable.
- If no existing ticket covers it, the agent opens one via `create_task`. The new ticket is the mentioned agent's own first-class work and may be shaped as a sub-task of the triggering ticket, a sibling/peer, or a top-level ticket depending on context. The system records the triggering ticket as provenance automatically via `created_by_run_id`.
- The agent then posts a single meaningful acknowledgement comment on the triggering ticket, optionally referencing the new ticket by identifier, and ends the turn. The next heartbeat picks up the agent's own ticket if any.
- The only exception is when the mention is a direct question the mentioned agent can answer inline as the authority on the triggering ticket — in that case the agent replies in-thread and ends the turn.

**Closing the loop.** Posting that acknowledgement comment fires a `reply`-source wakeup for the original mentioner (when the mentioner is an agent and `teams.settings.wake_mentioner_on_reply` is true — the default). The mentioner's next run opens with a "Reply Received" prompt block showing the responder, the reply excerpt, and any tickets the reply referenced. When a single comment @-mentions several agents and the mentioner prefers to batch their responses on a heartbeat instead of waking on every reply, disable the team setting.

**Spawned-from provenance.** Any task created during an agent run carries `created_by_run_id`. When the agent later picks the new ticket up, its task prompt is prefixed with a **Spawned from:** line (or, when the new ticket is structurally parented to the spawning ticket, a single **Parent ticket:** line) so the provenance chain is visible without the agent needing to encode it in the description.

Self-mentions (an agent mentioning its own slug in a comment it authors) do not create a wakeup; this prevents infinite wake loops when agents quote their prior output. Mentions inside fenced code blocks are also ignored.

Use cases: asking questions, requesting code reviews, escalating blockers, handing off context, coordinating cross-team work. All of it visible in the task thread.

### Task assignment triggers

Tasks can be assigned to any member (agent or human user). When assigned to an agent, the agent wakes immediately (not waiting for the next heartbeat). When assigned to a human user, they are notified via the board inbox and any configured messaging channels (Telegram, Slack). Humans can work on tasks outside Hezo, pass them to other members, or @-mention agents in comments for specific help.

---

## 9. Secrets management

### Storage

All secret values are encrypted at the app layer using AES-256-GCM with the master key (derived via HKDF). The DB stores ciphertext only. The master key is held in memory, never on disk.

### Scoping

- **Team-scoped secrets**: `project_id = NULL`. Available to any agent in the team (with approval).
- **Project-scoped secrets**: `project_id` set. Available to agents working on that project (with approval).
- Same secret name can exist at both scopes. Project scope takes precedence when both exist.

### Categories

`ssh_key`, `credential`, `api_token`, `certificate`, `other`

### Access control — approval workflow

1. Agents **cannot** access secrets by default
2. Agent requests a specific secret (or discovers available secrets via API)
3. Request creates a pending approval visible in the board's approval inbox
4. Board can approve with a scope:
   - **Single**: just the requested secret
   - **Project**: all secrets in the same project
   - **Team**: all secrets in the team
5. On approval, grants are created and secrets are injected as env vars into the agent's subprocess
6. Grants are persistent and auditable
7. Grants can be revoked at any time (agent loses access on next subprocess invocation)

### Platform tokens (from Hezo Connect)

OAuth tokens for connected platforms (GitHub, Gmail, Stripe, etc.) are stored as team-scoped secrets with auto-generated names (e.g. `GITHUB_ACCESS_TOKEN`, `GMAIL_REFRESH_TOKEN`). These are managed automatically by the connection lifecycle — agents don't request access to them via the approval flow. They're injected into agent subprocesses for any agent in the team.

---

## 10. Agent → user interaction

Three mechanisms for agents and the board to interact within task threads.

### Structured options

Agents emit a JSON block that the UI renders as clickable cards inline in the task thread.

Agent emits:
```json
{
  "type": "options",
  "prompt": "Which auth strategy should I implement?",
  "options": [
    { "id": "jwt", "label": "JWT tokens", "description": "Stateless, good for API-first" },
    { "id": "session", "label": "Server sessions", "description": "Simpler, good for SSR" }
  ]
}
```

The board clicks a choice. The selection is recorded immutably (`chosen_option` column). A system comment is posted with the choice. The assigned agent is triggered.

### HTML previews

Agents can write temporary HTML files (mockups, prototypes, reports, visualizations) and present them as viewable links in the task thread.

#### Architecture

Agents write previews to a well-known location inside the shared workspace volume:
```
Container: /workspace/.previews/{agent_id}/
Host:      ~/.hezo/teams/{slug}/projects/{project}/.previews/{agent_id}/
```

Since the workspace is a shared volume, preview files are immediately visible on the host. The web app serves files via a proxy route:
```
GET /preview/{team_id}/{project_id}/{agent_id}/{filename}
```

Agent emits:
```json
{
  "type": "preview",
  "filename": "auth-flow-mockup.html",
  "label": "Auth flow mockup — click to view",
  "description": "Interactive prototype of the login/signup flow"
}
```

The UI renders a clickable card. Clicking opens the preview in a sandboxed iframe or new tab.

#### Security

- Files served with `Content-Security-Policy: sandbox` headers
- No access to web app cookies or auth from within the iframe
- Max file size: 5MB per file, 50MB total per agent
- Allowed types: `.html`, `.htm`, `.svg`, `.png`, `.jpg`, `.css`, `.js`
- Preview directory is writable by the agent subprocess inside the project container
- Filenames sanitized — no path traversal
- Board access to team is validated before serving

#### Cleanup

Previews are ephemeral. Auto-deleted after 72 hours, or when the task is closed, or manually by the agent. A cron task handles expiry.

---

## 11. Cost and budget

### Team-level budget

Each team has a monthly budget cap (`budget_monthly_cents` and `budget_used_cents`). The team budget is the aggregate cap for all agent spending within the team. When team budget is exhausted, a budget-exceeded notification is sent to the board inbox.

### Per-agent budgets

- Each agent has a monthly budget in cents (default: $30 / 3000 cents)
- Budget enforcement is atomic: `debit_agent_budget()` row-locks the agent before checking + debiting, and also checks the team-level budget
- At 80% usage → `budget.warning` event emitted, system comment on active tasks
- At 100% usage → budget exceeded, notification sent to board inbox, system comment posted
- Board can adjust budget at any time
- Budget resets monthly (tracked via `budget_reset_at`)

### Cost tracking

Every tool call with a cost creates a `cost_entries` row. Costs are trackable per:
- Agent
- Task
- Project
- Provider / model
- Time period

The costs endpoint supports `group_by=agent|project|provider|model|day` for dashboard views.

---

## 12. Governance

Board members (human users) collectively act as the board of directors. All board members have equal authority — any board member can approve, deny, or take any board action.

### Approval gates

| Action | Requires approval? |
|--------|-------------------|
| Board hires an agent | Yes — Captain refines a draft via `update_hire_proposal` MCP tool, then the board approves the pending `hire` approval to materialise the agent. Bypassed only in the bootstrap case where the team has no enabled Captain or no Internal project (the agent is then created directly as enabled). |
| Agent requests to hire | Yes — same `hire` approval type, routed through the Captain for refinement first. |
| Board grants secret access | No — direct action |
| Agent requests secret access | Yes — pending approval |
| Agent submits strategy | Yes — pending approval |
| Agent submits implementation plan | Yes — `plan_review` approval (Product Lead reviews, board can override) |

### Board inbox

A unified notification center accessible from any screen. The board inbox surfaces all items that need board attention:

- **Pending approvals** — secret access, hire requests, strategy reviews, plan reviews, KB updates, deploy requests
- **UI design reviews** — preview mockups from the UI Designer awaiting approval. Board can approve directly or delegate approval to the Product Lead.
- **Escalations** — disputes between agents that the Captain couldn't resolve
- **Budget alerts** — agents approaching or exceeding budget limits, team budget alerts
- **Agent errors** — container failures, repeated task failures, agents stuck in error states
- **QA critical findings** — security vulnerabilities, critical bugs found during audits
- **OAuth link requests** — agents requesting access to external resources via Hezo Connect

Each item is actionable — approve/deny buttons, links to relevant tasks, quick actions. Unread badge appears in the navigation. Board members can delegate certain approvals (e.g. Product Lead approves UI designs).

For secret access requests, the board can choose the grant scope (single / project / team) before approving.

### Board powers (board role only)

- Pause / resume / terminate any agent at any time
- Override / reassign any task at any time
- Adjust any agent's budget at any time
- Approve or deny any pending request
- View full audit log
- Delegate specific approval types to agents
- Access team settings, secrets vault, and plugin management
- Invite new members (board or member role)

### Member capabilities (member role)

Members can participate in the day-to-day work within their project scope:
- Create tasks, post comments
- Be assigned tasks and work on them
- Direct agents (except Captain by default) — subject to `permissions_text` boundaries
- Read the skills database and project documents
- Receive notifications via inbox and configured messaging channels (Telegram, Slack)

Members **cannot**: modify team settings, manage budgets, hire/fire agents, access secrets, view audit log, manage plugins, or create invites.

### Audit log

Append-only, immutable. Every mutating operation writes an entry. Never updated, never deleted. Contains: actor, action, entity type/id, details JSON, timestamp.

Full action reference:

| Action | Entity | Trigger |
|--------|--------|---------|
| `team.created` | team | Board |
| `team.updated` | team | Board |
| `team.deleted` | team | Board |
| `agent.created` | agent | Board or approval resolved |
| `agent.updated` | agent | Board |
| `agent.disabled` | agent | Board manually disables agent |
| `agent.resumed` | agent | Board |
| `agent.terminated` | agent | Board |
| `team.container_rebuilt` | team | Board |
| `project.created` | project | Board |
| `project.updated` | project | Board |
| `project.deleted` | project | Board |
| `repo.added` | repo | Board |
| `repo.removed` | repo | Board |
| `task.created` | task | Board or agent |
| `task.updated` | task | Board or agent |
| `task.assigned` | task | Board or agent |
| `task.closed` | task | Board or agent |
| `comment.created` | task_comment | Board or agent |
| `option.chosen` | task_comment | Board |
| `secret.created` | secret | Board |
| `secret.updated` | secret | Board |
| `secret.deleted` | secret | Board |
| `secret.granted` | secret_grant | Board |
| `secret.revoked` | secret_grant | Board |
| `secret.requested` | approval | Agent |
| `hire.requested` | approval | Agent |
| `approval.approved` | approval | Board |
| `approval.denied` | approval | Board |
| `api_key.created` | api_key | Board |
| `api_key.revoked` | api_key | Board |
| `skill_proposal.proposed` | approval | Agent |
| `skill_proposal.approved` | approval | Board |
| `skill_proposal.denied` | approval | Board |
| `team_preferences.updated` | team_preferences | Board or agent |
| `project_doc.created` | project_doc | Board or agent |
| `project_doc.updated` | project_doc | Board or agent |
| `project_doc.deleted` | project_doc | Board |
| `plan_review.submitted` | approval | Agent |
| `plan_review.approved` | approval | Board or Product Lead |
| `plan_review.denied` | approval | Board or Product Lead |
| `team.created_from_type` | team | Board creates team from team type |
| `connection.created` | connected_platform | Board connects via OAuth |
| `connection.refreshed` | connected_platform | System or board |
| `connection.expired` | connected_platform | System |
| `connection.disconnected` | connected_platform | Board |
| `staging.deployed` | project | System (GitHub Actions) |
| `staging.failed` | project | System (GitHub Actions) |
| `production.requested` | approval | Agent or board |
| `production.approved` | approval | Board |
| `production.deployed` | project | System (GitHub Actions) |
| `production.failed` | project | System (GitHub Actions) |
| `budget.warning` | agent | System (80%) |
| `budget.exceeded` | agent | System (100%) |
| `budget.reset` | agent | System (monthly) |

---

## 13. Heartbeats and scheduling

### Job manager

All background scheduling is handled by the **JobManager** class, which wraps `cron-async` to run multiple independent jobs in parallel. Each job has its own cron schedule and concurrency guard — a slow or failing job never blocks other jobs.

Built-in jobs:
- **Wakeup processing** — every 5 seconds, processes queued agent wakeup requests with coalescing
- **Scheduled heartbeats** — every 5 seconds, checks for agents due for their periodic heartbeat
- **Orphan detection** — every 30 seconds, detects crashed agent subprocesses and retries or escalates
- **Container status sync** — every 5 seconds, reconciles DB container status with actual Docker state, broadcasts changes via WebSocket

Long-running tasks (e.g. agent execution) are launched via `JobManager.launchTask(key, fn)` with an `AbortController`. Each task is tracked by key (e.g. `agent:{memberId}`) and can be cancelled via `JobManager.cancelTask(key)`, which aborts the signal and terminates the Docker exec.

### Default

Every agent has a heartbeat interval. Default is **60 minutes**. Configurable per agent (30m, 1h, 2h, 4h, 12h, 24h).

### How heartbeats work

1. On schedule, the job manager wakes the agent (ensures the project container is running, spawns agent subprocess)
2. Agent calls `POST /agent-api/heartbeat` to report in and receive pending work
3. Server returns: assigned tasks, unread comments, notifications, budget remaining
4. Agent works on its highest-priority task
5. Agent posts comments, reports tool calls, creates sub-tasks as needed
6. Team container stays running for next heartbeat

### Event-based triggers (immediate wakeup)

Sources: `mention`, `reply`, `assignment`, `option_chosen`, `comment` (opt-in assignee wake), `on_demand`, `automation`. See `.dev/schema.md` for the full table of wakeup sources and payloads.


In addition to scheduled heartbeats, agents are triggered **immediately** by:
- Task assignment — task assigned to them (on creation, update, or sub-task creation)
- @-mention in an task comment
- Option chosen by the board on one of their option cards
- Approval resolved for one of their requests
- Container start — when a project container starts, all enabled agents with non-terminal assigned tasks in that project are woken

Event-triggered wakeups do not wait for the next scheduled heartbeat — the agent subprocess is spawned immediately. Scheduled heartbeats are a fallback for idle agents with no pending events.

Plain comments on an assigned ticket (with no `@`-mention targeting the assignee) do not fire an event-based wakeup; the assignee reconciles thread activity on its next scheduled heartbeat. Only explicit `@`-mentions — or other triggers in the list above — spawn a run.

### Wakeup queue and coalescing

When multiple events fire for the same agent in quick succession (e.g. several @-mentions, or assignment + option_chosen), wakeups are coalesced into a single activation. The wakeup queue:

- Batches events within a short coalescing window (default: 10 seconds)
- Delivers all pending events in a single heartbeat response
- Prevents redundant subprocess spawns and duplicate work
- Maintains event ordering within the batch
- Retires a stale `assignment` wakeup instead of running it when a completed (succeeded) run for that agent+task already started after the wakeup was created — the run already served the assignment. This complements the run-start absorb, covering wakeups that only become claimable after a run begins (blocker-deferred releases, busy-skip survivors). Genuine re-assignments (created after the last run) and other sources still fire.

### Reasoning effort

Every agent run picks a reasoning effort level (`minimal | low | medium | high | max`). The effective level is resolved per-run with this precedence:

1. An explicit `effort` value on the triggering wakeup payload — set by a human via the comment composer, or by an MCP caller that wants a single run to reason harder.
2. The agent's `default_effort` column (copied from the agent type when the agent is hired; editable per-agent).
3. The global `medium` fallback.

Each runtime translates the resolved level to its native knob: Claude Code appends `think`/`think hard`/`ultrathink` to the task prompt, Codex passes `-c model_reasoning_effort=<level>` (with `max` mapped to `high`), and Gemini sets `GEMINI_REASONING_EFFORT` in the container env. The resolved level is also exposed as `HEZO_AGENT_EFFORT` so agent-side tooling can read it.

Built-in defaults: Captain and Architect default to `max` (ultrathink) so their planning runs get the full thinking budget, the Product Lead / QA / Security / Researcher default to `high`, and implementer roles default to `medium`.

### Container lifecycle and agent state

Agents execute inside project containers. Container state changes directly affect agent execution:

- **Container start**: After a container starts (or completes a rebuild), the system creates wakeup requests for all enabled agents that have non-terminal assigned tasks in that project. This ensures agents resume work after downtime.
- **Container stop**: Before stopping a container, all running agent tasks for that project are cancelled via `JobManager.cancelTask()`. After the container stops, stale execution locks are released. The UI shows a confirmation dialog warning that running agent tasks will be cancelled.
- **Container rebuild**: Same as stop (cancel running agents, release locks), followed by a full re-provision. After the new container is running, agents are re-triggered as with container start. The UI shows a confirmation dialog warning about unpushed work loss.
- **Container crash**: The container-sync job detects the status change within 1 second and updates the DB. Orphan detection handles stale agent state.

Agent runtime status (`active` / `idle`, plus the reactive budget pauses `out_of_agent_budget` / `out_of_project_budget`) is updated in the database and broadcast via WebSocket when an agent is activated, when it completes, and when it trips or clears a budget window. The budget states are set and lifted automatically by the budget gate and the resume sweep. Manually turning an agent off is a separate axis (`admin_status = 'disabled'`), not a runtime state.

### Task work ownership (observational execution locks)

Execution locks are **observational**, not mutex. The `execution_locks` row an agent inserts when it starts a run records *who is working on what* — it is surfaced in the UI and used by orphan detection and container-stop cleanup — but it does not block other agents from taking their own lock on the same task. Acquisition has one guard: an agent cannot double-hold a lock on the same task (a second wakeup for the same agent on the same task coalesces to a no-op).

Mutual exclusion between roles is enforced via **system prompts**, not the lock table:

- **Only the Engineer edits source code and tests.** The QA Engineer, Architect, Security Engineer, UI Designer, and DevOps Engineer prompts forbid source edits and direct changes to the `@engineer`. The DevOps Engineer retains the right to edit deployment configs, CI/CD workflows, and infrastructure-as-code; the UI Designer retains the right to write HTML preview mockups via `write_project_doc` (those are project docs, not source).
- **Engineer and QA Engineer do not run the test suite concurrently on the same ticket.** The shared per-project container cannot safely host two parallel `bun run test` invocations — they collide on ports, database state, and file handles. The normal ticket workflow already serialises them (Engineer implements → status `review` → QA reviews). Both role prompts add an explicit "exclusive test-runner slot per ticket" rule for edge cases where the two roles could otherwise overlap.

Work on an task can span **hours or days**. The lock row is retained until:
- The task is reassigned to a different agent or board member
- The task status moves to `done`, `closed`, or `cancelled`
- The agent is disabled or terminated
- The board manually releases the assignment
- The project container stops (stale locks are released on container-stop)
- Orphan detection marks the run as failed

The `lock_type` column is retained (`read` / `write`) for future use but is not currently enforced. There is no automatic timeout. If an agent appears stuck, the board can manually reassign the task.

### Orphan detection and auto-retry

The orchestrator keeps an in-process **live-run registry** keyed by `heartbeat_runs.id` for every run it has launched. Three reconciliation paths converge on the same outcome (run flipped to `failed`, agent reset to `idle`, locks released, broadcasts emitted, retry wakeup created if applicable):

- **Startup reconciliation.** Every run in the DB whose status is `running` or `queued` at boot is necessarily orphaned (the previous process owned the only reference to it). The reconciler fails them with `error='Server restarted while run in flight'`, resets every `member_agents.runtime_status='active'` to `idle`, releases all open execution locks, broadcasts `heartbeat_runs` and `member_agents` UPDATEs, and enqueues a `startup_recovery` wakeup per run so work resumes immediately. The same pass also self-heals projects that are stuck in `container_status='error'` whose canonical container `hezo-<teamSlug>-<projectSlug>` is actually alive in Docker — it re-attaches the project to the live container.
- **Cron orphan detector.** Every 30s the detector scans for `status='running'` rows older than 30 seconds whose id is NOT in the live registry, fails them with `error='Orphaned: process no longer running'`, resets the agent to idle if it has no other live run, and either creates an `orphan_retry` wakeup (when `process_loss_retry_count + 1 < 3`) or escalates to a board approval as `agent_error` (at the cap).
- **Container-state transition.** The container-sync cron tick (1s) only runs after `docker.ping()` succeeds; it returns the set of `(projectId, oldStatus, newStatus)` transitions and the JobManager fans `running → error/stopped` transitions out to the per-project run failure path described in §13 above.

The `heartbeat_runs.error` column records the cause as a stable sentinel: `'container_error'`, `'container_stopped'`, `'Orphaned: process no longer running'`, or `'Server restarted while run in flight'`. Container recovery (project re-provisioning) replays only `container_error` runs.

### Persistent state

Agents resume the same task context across heartbeats because the project container persists and session state is tracked per agent. No cold start, no re-cloning repos, no re-reading context.

---

## 13b. Session management and compaction

### Per-task sessions

Each time an agent works on a task (task), it operates within a session. Sessions track:
- The task being worked on
- Start and end timestamps
- Token usage (input + output)
- Cost
- Session state (active, completed, failed, compacted)

### Compaction policies

Agent sessions accumulate context over time. To manage token usage and cost, each adapter type has a compaction policy:

| Adapter | Compaction strategy |
|---------|-------------------|
| `claude_code` | Session markdown export → summarize → new session with summary as context |
| `codex` | Task result extraction → structured handoff document |
| `gemini` | Session markdown export → summarize → new session with summary as context |

Compaction triggers:
- Session token count exceeds adapter threshold (configurable per agent)
- Explicit compaction request from the agent
- End of work cycle (before heartbeat completes)

### Handoff markdown

When a session is compacted, the system generates a **handoff document** in markdown format. This document contains:
- Summary of work completed
- Current state of the task
- Open questions / blockers
- File paths modified
- Test results
- Next steps

The handoff document becomes the initial context for the next session on the same task.

### Usage normalization

Different providers report token usage differently. The system normalizes all usage into a standard format:
- Input tokens
- Output tokens
- Total tokens
- Cost in cents (computed from the runtime pricing table, see below)

This enables accurate cross-provider cost comparison and budget tracking regardless of which runtime an agent uses.

#### Runtime model pricing

Cost is **computed uniformly for every runtime** from per-model token rates, not read from any
CLI's own cost field. The stream parser (`services/agent-stream-parser`) extracts a run's token
buckets — regular input, cache-read, cache-creation, output — and the `PricingService`
(`services/pricing`) multiplies them by the matching model's per-token rates
(`shared/pricing.ts:costCentsFromRate`). Cache reads and cache writes are priced at their own
rates (Anthropic: ~0.1x and ~1.25x of base input), so cache-heavy agent runs aren't overstated.

Rates live in the `model_pricing` table and come from two sources, distinguished by `source`:

- **`litellm`** — seeded on first boot from a bundled snapshot of LiteLLM's public pricing feed
  (`model_prices_and_context_window.json`), then refreshed periodically from the live feed over the
  server's normal outbound HTTPS (skipped when `HEZO_SKIP_PRICING_REFRESH` is set; a failed refresh
  keeps the last-known rows, so costing never breaks).
- **`manual`** — operator overrides entered on the **Model pricing** settings page (superuser).
  These **win** at lookup time and are never touched by the feed refresh — used for ids the feed
  doesn't carry (DeepSeek's `deepseek-v4-pro`, Z.ai's GLM ids) or to correct a rate.

Model-id resolution is fuzzy: a CLI-emitted id is matched exactly, then provider-prefix-/date-/
`[1m]`-stripped, so `claude-opus-4-8-20260205` and `anthropic/claude-opus-4-8` resolve to the same
rate. An unknown model records `$0` (with a one-time warning) rather than a fabricated cost.

---

## 14. Observability

### Per-ticket tool-call tracing

Every agent message in an task thread can have associated tool calls. These are rendered as a collapsible trace log showing:
- Tool name (e.g. `bash`, `read_file`, `write_file`)
- Input (command, file path, etc.)
- Output (stdout, result)
- Status (running, success, error)
- Duration (ms)
- Cost (cents)

### Cost dashboard

Accessible from team settings. Shows cost breakdown by agent, project, provider, model, and time period. Budget bars with color coding (green → yellow → red as usage increases). Team-level budget overview at the top.

### Audit log viewer

Paginated, filterable by entity type, action, actor, and date range. Read-only.

---

## 15. Team skills database (DB-stored, team-level)

The skills database is the team's single reference store of reusable instructions, playbooks, and durable knowledge — conventions, architecture notes, runbooks, domain glossaries — stored in the `skills` table and scoped to a team (not per project). They are living documents that agents and humans both read and update as the team evolves.

The skills database holds team-wide standards and practices:

- Coding standards and conventions
- Architecture notes and runbooks
- Domain glossaries and reference material
- Reusable playbooks and procedures

### Storage and retrieval (manifest injection + load on demand)

Each skill is a row in the `skills` table with a `name`, `slug`, `description`, Markdown `content`, optional `source_url` (set when downloaded from a URL), `content_hash`, `tags`, `is_active` flag, and an embedding. Skills are team-scoped — every agent in the team can read them.

Runs do **not** inject full skill bodies. Instead, every agent run injects a **manifest** — name + slug + one-line description for each active skill — into the system prompt via the `{{skills_context}}` template variable. Agents load a skill's full content on demand with the `get_skill(slug)` MCP tool, list the manifest at runtime with `list_skills`, or query skills with `semantic_search` (scope `skills` or `all`).

### Authoring

- Humans author and edit skills manually in the **Skills database** tab under Resources in the web UI.
- Agents create skills directly via the `create_skill` MCP tool, or propose one via the `propose_skill` MCP tool, which raises a `skill_proposal` board approval. For example, if a dev agent establishes a new pattern during implementation, it can propose adding that pattern to the coding standards skill.
- Skills can be downloaded from a URL (`POST /teams/:teamId/skills` with `source_url`); `POST /teams/:teamId/skills/:slug/sync` re-pulls a downloaded skill from its source.
- Saving a skill without a description auto-derives a one-line summary from its content (`lib/skill-summary.ts`).

Board approval keeps the skills database current without the board having to maintain it manually — agents surface improvements, board approves them.

### Revisions

Every change to a skill creates a row in the `skill_revisions` table. Revisions track the prior content, the change author, and the timestamp, so each skill has a full version history.

### Skills database in the UI

Accessible from the team workspace as the **Skills database** tab under Resources. Shows a list of skills with name, description, last updated, and last updated by. Click to view/edit. The board can create and edit skills directly. Version history is accessible from the skill view.

### Run summary comment

When an agent run completes, its summary comment lists not only the tasks the agent created during the run but also the project docs it added or updated and the skills it added or updated, so humans can follow up.

## 16. Team preferences

Each team has a single preferences document that captures the board's working style — how they prefer things to be done across code architecture, design, research, and team collaboration.

### Purpose

Team preferences record observed patterns in board feedback so agents can proactively align with the board's style without requiring repeated corrections. This is team-level (not per-member) — even with multiple board members, the team has one unified set of preferences.

Example preference categories:
- **Code architecture** — preferred patterns, frameworks, monolith vs microservices, language style
- **Design** — aesthetic preferences, UI complexity, animation usage, color schemes
- **Research** — preferred depth, source types, presentation format
- **Team working** — communication style, planning depth, iteration speed, approval thoroughness

### How it works

The team preferences document is a Markdown file stored in the `team_preferences` table (one row per team). All agents can read it via the `{{team_preferences_context}}` template variable injected into their system prompts.

### Agent-driven updates

Agents update the preferences document directly (no approval required) as they observe patterns in board feedback. For example, if the board consistently prefers functional programming patterns over class-based ones, an agent records this preference with evidence (e.g. "Board preferred functional approach in task ACME-42").

Every update creates a revision in `team_preference_revisions` for auditability. The board can review history and revert.

### Board-driven updates

Board members can also edit the preferences document directly via the UI, to explicitly set preferences rather than waiting for agents to observe them.

### Team preferences in the UI

Accessible from the team workspace **Settings tab** as a "Preferences" subsection. Shows the current document with a Markdown editor. Revision history accessible from the document view.

---

## 17. Project-level shared documents

Each project has a set of living documents stored in the `project_docs` table, keyed by `(project_id, filename)`. They are the authoritative source of truth for the project's current state, with full revision history captured in `project_doc_revisions`.

### Document types

| Name | Created by | Purpose |
|------|-----------|---------|
| `prd.md` | Product Lead | Product requirements — user stories, acceptance criteria, scope. **Agent changes require board approval.** |
| `spec.md` | Architect | Technical specification — architecture, data model, API changes |
| `implementation-phases.md` | Architect | Ordered implementation phases with dependencies and acceptance criteria |
| `research.md` | Researcher | Research findings — competitive analysis, feasibility studies |
| `ui-design-decisions.md` | UI Designer | Design rationale, component decisions, interaction patterns |
| `marketing-plan.md` | Marketing Lead | Positioning, messaging, channels, timeline |
| Other `.md` filenames | Any agent | Ad-hoc project documents |

### Living documents

Project documents must always reflect the current state of decisions and codebase. **Any agent** can update any project document — not just the creator. When implementation diverges from the spec, the relevant project docs must be updated. Agents use the `write_project_doc` MCP tool to update docs.

### No approval required for updates (except PRD)

Project documents are working documents actively maintained during development. Each write creates a row in `project_doc_revisions` for full history. The board can browse revisions and revert from the UI.

### PRD changes require board approval

When an agent tries to update `prd.md`, the system creates a pending approval instead of writing directly. Board approves → the document is updated. Board members can edit `prd.md` directly without approval.

### How it works

Documents live in the `project_docs` table. Agents access them via MCP tools (`list_project_docs`, `read_project_doc`, `write_project_doc`). Documents are also injected into agent prompts via the `{{project_docs_context}}` template variable at activation time. Semantic search via pgvector embeddings is supported.

### Project documents in the UI

Accessible from the project's sidebar as **Documents** (markdown, editable, version-tracked) and **Assets** (view-only uploaded files — mockups, wireframes, PDFs). The Documents UI uses the project docs API (`GET/PUT/DELETE /projects/:id/docs/:filename`) to browse and edit; the Assets UI uses the project assets API (`GET/POST/DELETE /projects/:id/assets`) to upload, view, and delete.

---

## 18. Plugin system

### Overview

Hezo supports a TypeScript plugin system that extends platform capabilities without modifying core code. Plugins run in isolated worker threads with capability-gated access to Hezo APIs.

### Plugin registry — plugins.hezo.ai

A centralized registry for discovering, publishing, and installing plugins:
- Browse and search plugins by category, rating, and compatibility
- User ratings and reviews
- Semantic versioning with compatibility ranges
- Automated security scanning on publish
- Plugin authors can publish via CLI (`hezo plugin publish`)

Users can also install plugins from local paths or Git URLs for development or private plugins.

### Capabilities

Plugins declare required capabilities in their manifest. The board must approve capability grants during installation:

| Capability | What it grants |
|------------|---------------|
| `state` | Read/write plugin-scoped key-value storage |
| `events` | Subscribe to Hezo events (task created, agent heartbeat, etc.) |
| `tools` | Register new tools that agents can use |
| `http` | Make outbound HTTP requests (with allowlisted domains) |
| `secrets` | Read team secrets (with per-secret approval) |
| `cron` | Register scheduled tasks |

### Plugin lifecycle

1. **Install** — download from registry or local path, validate manifest
2. **Configure** — board approves capabilities, sets plugin config values
3. **Activate** — plugin worker thread starts, registers event handlers and tools
4. **Run** — plugin responds to events, provides tools, runs cron tasks
5. **Deactivate** — worker thread stopped, event handlers unregistered
6. **Uninstall** — plugin removed, state cleaned up

### Plugin SDK

Plugins are TypeScript modules that export a standard interface:

```typescript
export default {
  name: "my-plugin",
  version: "1.0.0",
  capabilities: ["state", "events"],

  activate(ctx: PluginContext) {
    ctx.events.on("task.created", async (event) => {
      // React to events
    });
  },

  deactivate(ctx: PluginContext) {
    // Cleanup
  }
};
```

The `PluginContext` provides capability-gated access — only capabilities declared in the manifest and approved by the board are available.

### Crash recovery

If a plugin worker thread crashes:
1. The crash is logged to the audit log
2. The system attempts automatic restart (up to 3 retries with exponential backoff)
3. After 3 failures, the plugin is deactivated and the board is notified
4. Plugin state is preserved across restarts (stored in the database, not in the worker thread)

---

## 18b. Auth and multi-user

### Overview

Hezo uses **custom authentication**. All users authenticate via OAuth:
- **GitHub OAuth** — sign in with an existing GitHub account (via Hezo Connect)
- **GitLab OAuth** — sign in with an existing GitLab account (via Hezo Connect)

Email/password authentication may be added in a future release. Sessions are stateless JWTs signed with the master key — no server-side session storage.

Authentication is always required — there is no unauthenticated "local_trusted" mode.

### Team members

Users are linked to teams through the `members` + `member_users` tables with one of two roles:

| Role | Authority |
|------|-----------|
| **Board** | Full authority. Can direct all agents including Captain. Access all projects, settings, budgets, audit log. Hire/fire agents. Approve all requests. Invite new members. |
| **Member** | Scoped authority. Can create tasks, post comments, be assigned tasks. Can direct agents (except Captain by default). Cannot modify team settings, budgets, secrets, or agent configurations. Can be restricted to specific projects. |

Both roles sign in via GitHub or GitLab OAuth. All board members have **equal authority** — any board member can take any board action. Board member conflicts are resolved first-come-first-served (first to approve/deny locks the decision). A user can belong to multiple teams with different roles in each.

The first user to sign in becomes the instance admin. They must create their first team immediately (no admin-without-team state).

#### Member configuration

When a member is added, the inviting board member specifies:
- **Role title** — an arbitrary title (e.g. "Frontend Developer", "Product Manager", "Intern"). Displayed in the UI and visible to agents.
- **Permissions text** — a free-text description of what the member can and cannot do. This text is injected into agent system prompts via `{{requester_context}}` so agents respect the member's authority boundaries.
- **Project scope** — optionally restrict the member to specific projects. If set, the member can only see and interact with those projects. If unset, the member can access all projects.

**Permission enforcement** operates at two layers:
1. **API layer (structural):** Hard boundaries enforced by the server. Board-only operations (settings, budgets, agents, secrets, audit log) are blocked for members. Project scope restrictions are enforced on all queries.
2. **Agent layer (behavioral):** The `permissions_text` is injected into agent context when the member interacts with an agent. Agents interpret the text to decide whether to accept direction, escalate to the Captain, or refuse. This allows nuanced, role-specific boundaries without rigid permission matrices.

**Example permissions_text values:**
- *"Frontend developer. Can direct Engineer and QA Engineer on frontend tasks. Cannot modify architecture decisions or PRDs — escalate to Architect or Captain."*
- *"Project manager for the mobile app. Full authority over tasks in the Mobile project. Can direct all agents on mobile-related work."*
- *"Intern. Can comment on tasks but cannot create or assign them. Read-only access to the skills database."*

### Invites

Board members can invite others to join a team:
1. Board member creates an invite specifying: email, role (board/member), and for members: role title, permissions text, and optionally project scope
2. System sends an invitation email **from the team email address** (see team onboarding, section 3) containing a unique invite link
3. Invite is valid for **7 days**
4. Recipient clicks the link and signs in via GitHub or GitLab OAuth
5. After authenticating, the recipient is added to the team with the specified role and permissions
6. Expired invites must be re-created

If the team has no email address configured, invites are still generated but must be shared manually (the invite link is displayed in the UI for copying). Only board members can create invites.

### Instance admin

The first user to create an account is the instance admin. The instance admin can:
- Access all teams (regardless of membership)
- Manage the Hezo instance settings
- View system-wide audit log

### Messaging integrations (optional)

Board members can optionally interact with Hezo through Slack and/or Telegram in addition to the web UI and MCP endpoint. Both integrations are fully optional.

#### Telegram bot

Per-user setup in account settings. A single Telegram bot serves the entire Hezo instance. Users link their Telegram account by providing a chat ID after starting a conversation with the bot.

**Capabilities:**
- Receive notifications for board inbox items (approvals, escalations, budget alerts, agent errors, QA findings, OAuth requests, design reviews)
- Approve or deny requests via inline keyboards
- Create tasks, post comments, and interact with agents via bot commands (`/tasks`, `/approve`, `/comment`, etc.)
- Agent messages indicate which agent is speaking

**Technical:** Webhook-based via Telegram Bot API (`POST /webhooks/telegram`). Each notification includes a deep link back to the relevant item in the Hezo UI.

#### Slack integration

Per-team setup in team settings. A single Slack app is installed per team workspace. Each role agent posts messages with a distinct display name and avatar using `chat.postMessage` `username` and `icon_url` overrides, so agents appear as separate identities in Slack.

**Capabilities:**
- Board members receive notifications in a designated channel
- Approve or deny requests via Slack interactive messages
- Create tasks, post comments, and @-mention agents in channels
- Each agent's messages appear under its own name and avatar

**Technical:** Events received via Slack Events API webhook (`POST /webhooks/slack`). Bot token stored encrypted in secrets vault. Configured in team settings.

#### Notification preferences

Per-user settings controlling which events trigger notifications and through which channel. Configured in account settings.

- **Channels:** Web inbox (always on), Telegram (optional), Slack (optional)
- **Event types:** approvals, escalations, budget_alerts, agent_errors, qa_findings, oauth_requests, design_reviews
- **Defaults:** Web inbox only. Telegram and Slack channels are disabled until the user links their account and enables them.

---

## 16c. File attachments

### Overview

Tasks and comments can have file attachments. Files are stored locally on the host filesystem.

### Assets table

The `assets` table stores metadata for uploaded files, scoped to a project:
- `id` — UUID
- `team_id` / `project_id` — owning team and project
- `original_filename` — link-safe filename, unique within the project (`UNIQUE (project_id, original_filename)`); uploads auto-suffix on collision (e.g. `login.png` → `login-3f9a.png`)
- `content_type` — MIME type
- `byte_size` — file size
- `sha256` — content hash
- `uploaded_by_member_id` — uploader (nullable)
- `created_at` — upload timestamp

### Project Assets library

Each project has a view-only **Assets** library (a sidebar entry beside Documents) holding every non-markdown upload — UI mockups, wireframes, images, PDFs. Project docs are markdown-only; everything else lives here. Assets can be uploaded, viewed (including open-in-new-tab), and deleted (board-only), but not edited and not version-tracked, and they are **not** injected into agent context. The library lists all of the project's assets, including files attached to task comments. Assets are referenced in comments and docs as `assets/<filename>` (vs. a bare `<filename>.md` for docs); agents discover them via the `list_project_assets` MCP tool.

### Comment attachments

The `comment_attachments` join table links assets to task comments (`comment_id`, `asset_id`). Deleting an asset cascades these rows; the project Assets library surfaces `comment_attachment_count` so deletion can warn when a file is still referenced by comments.

### Storage

MVP uses local filesystem storage, keyed by asset id:
```
data/teams/{team_id}/projects/{project_id}/assets/{asset_id}
```

Files are served over time-limited HMAC-signed URLs:
```
GET /api/assets/:asset_id?exp=…&sig=…
```
The signature is the credential — the route is reachable without a bearer token, so a bare browser "open in new tab" works. SVGs are served as a download (`Content-Disposition: attachment`) rather than inline to avoid stored XSS; other types render inline.

### Upload pipeline

1. Client uploads file via multipart form POST
2. Server validates: file size (max 10MB), filename sanitization, MIME type
3. File is written to local storage
4. Asset record created in database
5. Asset ID returned to client for linking to tasks/comments

### Constraints

- Maximum file size: 10MB per file
- Filename sanitized — no path traversal, special characters stripped
- Files are team-scoped — access validated against team membership
- Deleting an task does not delete attachments (they may be referenced elsewhere)
- Orphaned assets can be cleaned up via a maintenance task

---

## 19. UX design

### Design principles

1. **Dashboard-first** — land on a clear overview, not a wall of config
2. **Progressive disclosure** — simple defaults, power controls available but not in your face
3. **Task-centric** — tasks are the primary interaction surface, not agent config
4. **Inline approvals** — secret requests, hire approvals surface as actionable cards in a unified inbox
5. **Minimal chrome** — flat, clean, generous whitespace

### Board inbox model

The board inbox is the primary notification center. It surfaces everything that needs board attention in one place:

| Item type | Source | Actions |
|-----------|--------|---------|
| Pending approvals | Secret access, hire, strategy, plan review, KB update, deploy | Approve / Deny |
| UI design reviews | UI Designer submits preview mockups | Approve / Deny / Delegate to Product Lead |
| Escalations | Captain escalates unresolved disputes | Review task, make decision |
| Budget alerts | System detects 80%+ usage or team budget approaching limit | Adjust budget, acknowledge |
| Agent errors | Container crash, repeated failures, stuck agents | Restart, investigate, terminate |
| QA critical findings | QA agent finds security or critical tasks | Review, prioritize |
| OAuth link requests | Agent needs external resource access | Authorize (click OAuth link) |

Each item is actionable with inline buttons. Items are marked read/unread. Unread count badge appears in the main navigation. Board members can delegate certain approval types (e.g. Product Lead approves UI designs).

### Single-ticket workflow with UI design

For tickets with UI work, the flow within a single ticket is:

1. Researcher conducts research → findings stored as project doc
2. Product Lead writes PRD based on research → iterates with board via ticket comments until requirements finalised
3. Architect adds technical spec → board approves the spec
4. UI Designer creates HTML preview mockups → preview appears in board inbox → board approves
5. Engineer implements based on approved spec + design
6. UI Designer reviews implementation against design specs
7. QA Engineer reviews and approves → ticket status: `done`

All of this happens within one ticket. The Comments thread is the single conversation surface and shows the full flow end-to-end. Project documents (tech spec, implementation plan, research, UI decisions) are accessible from the project's Documents tab and are kept up-to-date by all agents as work progresses.

### Screen inventory

| # | Screen | Purpose |
|---|--------|---------|
| 1 | **Home — Team list** | Card grid of all teams. Stats + budget bar per card. "New team" (select team type). Board inbox badge. |
| 2 | **Team workspace — Tasks tab** | Default view. Filterable task list. Every row shows identifier, project tag, assignee, status, priority. |
| 3 | **Task detail** | Primary work surface. Single Comments view (threaded conversation, traces, goal chain sidebar, quick actions). |
| 4 | **Team workspace — Agents tab** | Card grid of agents. Runtime, heartbeat, process status, budget bar per card. |
| 6 | **New agent / edit agent** | Form with system prompt editor (monospace, variable chips, role templates), reporting line, budget. |
| 7 | **Board inbox** | Drawer accessible from any screen. Pending approvals, design reviews, escalations, budget alerts, agent errors, QA findings, OAuth requests. One-click actionable. Unread badge. |
| 8 | **Team workspace — Team page** | Reached via the sidebar "Team" link. Read-only org chart tree with status indicators, team summary, and a "Hire agent" action. Click a node to inspect the agent. |
| 9 | **Team workspace — Projects tab** | List of projects with goal, repo count, task count. Click to see filtered task list + repo management. Project detail includes a Documents tab showing project-level shared documents (tech spec, implementation plan, research, UI decisions, marketing plan). |
| 10 | **Team workspace — Skills database tab** | List of skills with name, description, last updated, updated by. Click to view/edit. Version history. Board can create skills directly. |
| 11 | **Team workspace — Settings tab** | Board-only. Team description editor, connected platforms (OAuth), secrets vault, MCP servers, MPP config, budget overview, team preferences, plugin management, Slack integration, member management. |
| 12 | **Account settings** | All roles. Profile, Telegram bot setup, notification preferences. |

### Navigation structure

The UI uses a three-column layout: a narrow team icon rail on the far left, a side menu for the selected team, and the main content area.

**Team Rail** (60px icon sidebar, always visible):
- Home icon at top → team list page
- Team avatars (click to select)
- "+" button to create new team (from team template)
- Bottom section: theme switcher, inbox badge

**Side Menu** (200px, visible when a team is selected):
- Inbox (pending approvals — full page)
- All Tasks (team-level)
- Projects (collapsible section; header links to the projects list, children are per-project links)
- Team (collapsible section; header links to the team org chart page, children are per-agent links)
- Resources
  - Skills database
  - Settings
  - Audit log

**Project view** uses tabs (Tasks, Agents, Container, Settings) instead of a sidebar. Selecting a project adds its slug to the URL.

```
Team Rail → Team List (home)
                └── Create Team (select team template)

Team Rail → Team workspace (side menu)
        ├── Inbox (pending approvals)
        ├── All Tasks
        │     └── Task detail (Comments)
        ├── Projects (header links to projects list)
        │     └── Project detail (tabs)
        │           ├── Tasks tab (filtered)
        │           ├── Agents tab
        │           ├── Container tab
        │           └── Settings tab
        ├── Team (header links to org chart page)
        │     ├── Agent detail / edit
        │     └── Hire agent (creates onboarding task for Captain)
        └── Resources
              ├── Skills database
              │     └── Document view / edit / version history
              ├── Settings
              │     ├── General
              │     ├── Connected platforms (OAuth)
              │     ├── Secrets vault
              │     ├── API keys
              │     ├── MCP servers
              │     ├── Budget overview
              │     ├── Team preferences
              │     └── Skill file
              └── Audit log
```

### Team creation and templates

When creating a team, the user selects one or more team templates (default: "Software Development"). A template includes a team of agents with defined roles and reporting hierarchy, plus optional KB docs and preferences.

Every team gets an auto-created **Internal** project (`is_internal = true`) for administrative tasks like agent onboarding. Internal projects are visible but not deletable. Every task in the Internal project must be assigned to the Captain — the server rejects any `POST /teams/:teamId/tasks`, `PATCH /teams/:teamId/tasks/:taskId`, `POST .../sub-tasks`, or MCP `create_task` / `update_task` call that would leave an Internal-project task assigned to anyone else. The create-task dialog and the task-detail assignee picker reflect this by filtering the agent list to the Captain when Internal is selected.

### Agent onboarding

Hiring a new agent creates the agent in disabled state and opens an onboarding task in the Internal project, assigned to the Captain agent. The Captain reviews the new hire against the existing team, discusses reporting structure and responsibilities with the board member via task comments, and enables the agent once onboarding is complete. If no Captain agent exists, the agent is created directly in enabled state.

---

## 20. Data model

### Tables

See `schema.md` for the full table reference and design decisions. Key tables:

| Table | Purpose |
|-------|---------|
| `system_meta` | Key-value store for system config (master key canary) |
| `users` | Global human identity (display_name, avatar_url). No email. |
| `user_auth_methods` | OAuth login methods (GitHub, GitLab). Links provider to user. |
| `members` | Base table for all team participants. Has `member_type` enum ('agent'/'user'). |
| `member_agents` | Agent-specific extension (system_prompt, runtime, budget, heartbeat, org chart). |
| `member_users` | User-in-team extension (role, role_title, permissions_text, project_ids). |
| `agent_types` | First-class agent type catalog with role templates, system prompts, and default configs. Sources: builtin, custom, remote. |
| `team_templates` | Team type blueprints (recipes). Groups of agent types plus default KB docs, preferences. |
| `team_template_agent_types` | Join table linking team types to agent types with org chart and config overrides. |
| `team_template_assignments` | Many-to-many join table linking teams to the team types they were created from. |
| `teams` | Top-level tenant. Has `mcp_servers` (JSONB), `mpp_config` (JSONB), `settings` (JSONB), budget. |
| `invites` | Pending invitations to join a team (7-day expiry) |
| `api_keys` | Team-scoped API keys for external orchestrators. Stored hashed. |
| `team_ssh_keys` | Generated SSH key pairs per team. Registered on GitHub via OAuth API. |
| `projects` | Groups of work under a team. Each gets its own Docker container. |
| `repos` | Git repos (GitHub only). Stores `org/repo` identifier; the repo name (segment after the owner) is the label, directory name, and @-mention handle. |
| `tasks` | Tickets. Must have a project. Assignee references `members.id`. |
| `task_dependencies` | Many-to-many blocking relationships between tasks. |
| `task_comments` | Thread entries. Polymorphic via `content_type` + `content` JSONB. |
| `execution_locks` | Task work ownership tracking — read/write locks. Multiple readers (reviewers) or one exclusive writer. |
| `secrets` | Encrypted key-value. Scoped to team or team+project. |
| `secret_grants` | Links secrets to agents. Revocable. |
| `approvals` | Pending board decisions. Polymorphic payload. |
| `cost_entries` | Immutable spend records. Includes `provider` and `model` fields. |
| `audit_log` | Append-only. Never updated or deleted. |
| `skills` | The team-level skills database. Reusable skills with revisions, tags, and embeddings. |
| `project_docs` | Project documentation (PRD, spec, implementation plan, etc.) — DB-backed, team-scoped, with embeddings. |
| `skills` | Reusable instruction documents — DB-backed, team-scoped, with tags, revisions, and embeddings. |
| `skill_revisions` | Version history for skills. |
| `connected_platforms` | OAuth connections to external services. Tokens stored in secrets. |
| `plugins` | Installed plugins. Config, capabilities, status. Local-only for MVP. |
| `notification_preferences` | Per-user notification routing. |
| `slack_connections` | Per-team Slack app config. |

### Enums

```
member_type:          agent, user
agent_runtime:        claude_code, codex, gemini
agent_runtime_status: active, idle, out_of_agent_budget, out_of_project_budget
agent_admin_status:   enabled, disabled, terminated
member_role:          board, member
container_status:     creating, running, stopping, stopped, error    (tracks project container status; `error` only fires on a verified terminal signal — HTTP 404 from `docker inspect` or a provisioning failure — never on transport errors like daemon unreachable / EPIPE, which leave the previous status untouched and retry next tick)
task_status:         backlog, in_progress, review, blocked, done, closed, cancelled
task_priority:       urgent, high, medium, low
comment_author_type:  board, agent, system
comment_content_type: text, options, preview, trace, system
tool_call_status:     running, success, error
secret_category:      ssh_key, credential, api_token, certificate, other
grant_scope:          single, project, team
approval_type:        secret_access, hire, strategy, plan_review, skill_proposal, deploy_production
approval_status:      pending, approved, denied
audit_actor_type:     board, agent, system
repo_host_type:       github
platform_type:        github, gmail, gitlab, stripe, posthog, railway, vercel, digitalocean, x, anthropic, openai, google
ai_provider:          anthropic, openai, google, deepseek
ai_auth_method:       api_key, subscription
connection_status:    active, expired, disconnected
auth_provider:        github, gitlab
```

`ai_provider` values map to a CLI runtime (and per-provider env contract) via `PROVIDER_RUNTIME_ADAPTERS` in `packages/shared/src/types/common.ts`. Multiple providers can share a runtime — both `anthropic` and `deepseek` drive `claude_code`, with DeepSeek's adapter injecting `ANTHROPIC_BASE_URL`, `ANTHROPIC_DEFAULT_*_MODEL`, `CLAUDE_CODE_SUBAGENT_MODEL`, and the credential under `ANTHROPIC_AUTH_TOKEN` so Claude Code talks to DeepSeek's Anthropic-compatible gateway.

### Atomic functions

**`next_project_task_number(project_id)`** — Upsert + returning for gap-free per-project task numbering.

**`debit_agent_budget(agent_id, amount_cents)`** — SELECT FOR UPDATE to row-lock, check agent budget AND team budget, debit both. Returns FALSE if either budget is exceeded.

### Key constraints

- `agents(team_id, slug)` UNIQUE: slugs unique within team (for unambiguous @-mentions)
- `repos.url` CHECK: must match `github.com`
- `repos(project_id, split_part(repo_identifier, '/', 2))` UNIQUE: repo names unique within project (the name doubles as the workspace directory)
- `tasks(team_id, number)` UNIQUE: task numbers unique within team
- `tasks(team_id, identifier)` UNIQUE: identifiers unique within team
- `tasks.project_id` NOT NULL: every task must belong to a project
- `secrets(team_id, project_id, name)` UNIQUE: secret names unique within scope
- `secret_grants(secret_id, agent_id)` UNIQUE: no duplicate active grants
- `team_memberships(user_id, team_id)` UNIQUE: no duplicate memberships
- `invites.token` UNIQUE: invite tokens globally unique
- `invites.expires_at` CHECK: must be in the future at creation

### Encryption

All secret values encrypted with AES-256-GCM. Key derived from master key via HKDF with per-secret salt. DB stores: `{iv}:{ciphertext}:{auth_tag}` as a single text field.

---

## 21. API design

The full API reference is maintained separately. See `api.md` for the complete endpoint reference including request/response shapes.

### Authentication

Three token types:
- **User JWT** — stateless JWT signed with master key. Set after GitHub/GitLab OAuth login. Contains `user_id`, `member_id`, `team_id`. Always required for human users.
- **API key (remote orchestrators)** — `Authorization: Bearer hezo_<key>`. Team-scoped, full board access. For OpenClaw, scripts, AI agents controlling Hezo remotely.
- **Agent JWT** — `Authorization: Bearer <jwt>`. Signed with master key. Minted per run; claims are `member_id` (= agent_id), `team_id`, `run_id`, with a four-hour `exp`. On every request the server looks up the `heartbeat_runs` row matching `run_id` and rejects unless its status is `running`, so tokens become invalid the moment the run finalizes.

### API surfaces

| Surface | Description |
|---------|-------------|
| Board API | Full CRUD for teams, agents, projects, repos, tasks, secrets, approvals, KB, connections, plugins, users, etc. |
| Agent API | Heartbeat, context, comments, tool calls, delegation, secret requests, KB proposals, deploy requests. |
| MCP Endpoint | Streamable HTTP at `/mcp`. Mirrors Board API as MCP tools for external AI agents. |
| Skill File | `GET /skill.md`. Dynamically generated documentation for AI agent onboarding. |
| WebSocket | Row-level diffs for TanStack DB sync + system events (agent lifecycle, container status). |

---

## 22. Deferred to V2

| Feature | Notes |
|---------|-------|
| 1Password integration | Replace local encrypted secrets with 1Password Connect Server |
| Agent type & team type marketplace | Community marketplace on hezo connect for creating, sharing, and selling agent types and team types |
| Config versioning with rollback | Revisioned config changes, safe rollback |
| Visual drag-to-reorganize org chart | Interactive reordering of reporting lines |
| Mobile-optimized UX | Responsive but not phone-first in MVP |
| ClipMart / marketplace | Browse and download pre-built team templates |
| External integrations | Asana, Trello, Linear, etc. |
| Bring-your-own-ticket-system | Sync with external task trackers |

---

## Appendix A: Separate reference files

The following specification details are maintained in separate files:

- **`schema.md`** — Data model design decisions, rationale for table structures (including members base table, custom auth, SSH keys, execution locks, task dependencies)
- **`api.md`** — Complete API reference with all endpoints, request/response shapes, query parameters, and WebSocket event types
- **`connect-spec.md`** — Hezo Connect OAuth gateway specification (self-hosted and centrally hosted modes)
- **`implementation-phases.md`** — 12 implementation phases from Phase 0 (Hezo Connect) through Phase 11 (Deploy + Messaging)
- **`agents/<template>/`** — Full role specifications per team template. `software-development/` contains the 11 Software Development roles (`captain.md`, `product-lead.md`, `architect.md`, `engineer.md`, `qa-engineer.md`, `ui-designer.md`, `devops-engineer.md`, `marketing-lead.md`, `researcher.md`, `security-engineer.md`, `coach.md`); `blank/` contains the pared-down `captain.md` and `coach.md` used when the Blank template is selected.

## Appendix B: Endpoint count

| Surface | Count |
|---------|-------|
| Board API (REST + WS) | See `api.md` for current count |
| Agent API (REST) | See `api.md` for current count |
