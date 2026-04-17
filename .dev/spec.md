# Hezo — Full Product Specification

> Codename: Hezo. Open-source company orchestration platform.
> Version: MVP spec v2.0
> Date: March 2026

---

## 1. Product overview

Hezo is a self-hosted web application that orchestrates teams of AI agents to run autonomous companies. Each agent plays a defined role (CEO, Product Lead, Architect, Engineer, etc.) and operates as a subprocess inside the project's Docker container (one container per project). Human users — **board members** — sit at the top as the board of directors, approving decisions, managing budgets, and steering strategy. Multiple board members can collaborate on the same company.

One Hezo instance supports multiple companies with full data isolation. The primary interaction surface is an issue tracker — agents receive work via tickets, report progress via threaded conversations, and present options and previews to the board for review.

Hezo ships as a single executable binary. No external database required. No cloud account required.

### What Hezo is

- An org chart and governance layer for AI agents
- An issue tracker where agents do work and report back
- A cost control system with per-agent and per-company budgets
- A multi-company runtime with full data isolation
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

The master key is held in memory only — never written to disk. It encrypts all secrets, agent JWTs, and the canary value stored in `system_meta`.

**First startup** (no canary in `system_meta`):
1. If `--master-key <key>` provided on CLI → use that key, store canary (`encrypt("CANARY", master_key)`), proceed.
2. If no CLI key → server starts but master key is "unset". The web UI shows a **master key gate modal** on the first authenticated user's first visit:
   - **Option A: Generate a new key.** Server generates a random 256-bit key, displays it once in the UI, and warns the user to save it — it will not be shown again.
   - **Option B: Enter an existing key.** User provides a key they already have (e.g., restoring from backup).
3. Store canary and proceed.

**Subsequent startup** (canary exists in `system_meta`):
1. If `--master-key <key>` provided on CLI → attempt to decrypt canary.
   - **Success** → unlock, proceed normally.
   - **Failure** → server starts but in locked state. Web UI shows "incorrect master key" with option to re-enter.
2. If no CLI key → server starts in locked state. Web UI prompts user to enter master key.
   - **Success** → unlock, proceed normally.
   - **Failure** → prompt again or offer recovery.

**Key principle:** CLI `--master-key` is for **unlocking** (verifying the canary) on startup. The web UI is for **setting/managing** the key. The CLI never sets a new key interactively.

**On unlock:** `MasterKeyManager` fires registered `onUnlock` callbacks when the state transitions to `unlocked`. The server registers a callback at startup that starts the `JobManager` (agent wakeups, heartbeats, container sync, orphan detection). This means background processing begins as soon as the server is unlocked, regardless of whether the key was provided via CLI or web UI.

**Recovery options** (after failed canary decryption, via web UI):
- **Re-enter a different master key.** Try again with the correct key.
- **Generate a new master key and start fresh.** Warn that all existing instance data (secrets, companies, agents) will be lost. If confirmed, wipe the database, store a new canary, and proceed with a clean instance.

### CLI interface and default configuration

```
hezo                          # Start server with sensible defaults
hezo --data-dir /path/to/dir  # Custom persistence directory (default: ~/.hezo/)
hezo --master-key <key>       # Supply master key (skip terminal prompt)
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
| Data directory | `~/.hezo/` | PGlite database, company data, assets |
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

**WebSocket** carries both row-level diffs for data sync and system events (agent subprocess lifecycle, container status, live chat messages, notifications).

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

**Bundling into the binary:** Migration SQL files are compressed into a JSON archive at build time using `@hiddentao/zip-json` and embedded into the compiled binary. At startup, the server loads the compressed migrations from memory — no filesystem access needed for migration files. This ensures the binary is fully self-contained.

**Build process:**
1. `zip()` compresses all `migrations/*.sql` files into a JSON object (base64-encoded gzip with metadata)
2. The compressed archive is written to `migrations-bundle.json` and imported by the binary entry point
3. At startup, `unzip()` extracts the SQL content in memory and the migration runner processes it

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
2. Load migration SQL from the bundled archive (in memory)
3. Skip files already recorded in `_migrations`
4. For each unapplied migration: run inside a transaction, record in `_migrations` with checksum
5. Checksum verification: if a previously-applied migration file has changed, log a warning (indicates the migration was modified after being applied — this should not happen)

**`--reset` flag:** When provided, the server wipes the existing database directory and starts fresh before running migrations. This is useful during local development. The user is warned and must confirm (unless also providing `--master-key`, which implies non-interactive mode).

**Design decisions:**
- **Forward-only** — no rollback migrations. For an embedded database, the simplest recovery is restoring from a backup or using `--reset`. Add new migrations to fix issues.
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
| `list_companies` | List all companies the caller has access to |
| `create_company` | Create a new company |
| `list_issues` | List issues with filtering (project, status, assignee) |
| `create_issue` | Create a new issue in a project |
| `update_issue` | Update issue status, assignee, priority, etc. |
| `list_agents` | List agents in a company |
| `hire_agent` | Create a new agent from a role template or custom config |
| `post_comment` | Post a comment on an issue |
| `list_comments` | List comments on an issue |
| `approve_request` | Approve a pending approval |
| `deny_request` | Deny a pending approval |
| `list_approvals` | List pending approvals |
| `search_kb` | Search knowledge base documents |
| `update_kb_doc` | Create or update a KB document |
| `get_cost_summary` | Get cost breakdown by agent, project, or time period |
| `list_projects` | List projects in a company |
| `list_secrets` | List secret names (not values) in a company |

Additional tools are registered dynamically when plugins are activated.

### Skill file

Hezo serves a **skill file** that teaches external AI agents (like Claude Code) how to interact with the system. This is the primary onboarding mechanism for AI-to-AI integration.

**Served at:** `GET /skill.md` — returns a Markdown document describing Hezo's capabilities, available MCP tools, common workflows, and authentication instructions.

**Also committed to the repo** at `SKILL.md` in the project root so that coding agents working within a Hezo-managed repo automatically discover it.

**Content includes:**
- Overview of what Hezo is and how it works
- Available MCP tools with parameter descriptions
- Common workflows: create an issue, assign to an agent, monitor progress, approve requests
- REST API endpoint summary (as a fallback for agents that don't support MCP)
- Authentication instructions (API key setup)
- Examples of typical interactions

**Dynamically generated:** The skill file is generated at startup from the registered MCP tool definitions, ensuring it is always up-to-date with the current tool surface. Changes to MCP tools automatically update the skill file.

### Skills (DB-backed)

Skills are reusable instruction documents stored in the `skills` table (company-scoped). They are injected into every agent's system prompt via the `{{skills_context}}` template variable.

Skills have: name, slug, description, content (markdown), tags (JSONB array), source URL (optional, for skills downloaded from GitHub), content hash, creator tracking, and revision history (`skill_revisions` table).

**Creation paths:**
- Board downloads from URL via Settings UI
- Agent proposes via `propose_skill` MCP tool (creates approval)
- Agent creates directly via `create_skill` MCP tool

**Agent access:** `list_skills`, `get_skill`, `create_skill` MCP tools. Skills are also injected into prompts at activation time.

### Semantic search (pgvector + local embeddings)

Hezo includes built-in semantic search powered by pgvector (enabled in PGlite) and a local embedding model (`BAAI/bge-small-en-v1.5`, 33M params, ~50MB RAM). The model downloads on first use and runs in-process — no API key, no cost, fully offline after first download.

**Searchable content:** KB docs, issues, skills, and project docs all have `embedding vector(384)` columns. A background job generates embeddings for new content every 30 seconds.

**Agent access:** `semantic_search` MCP tool searches across all content types by natural language query, returning ranked results with relevance scores. Scope can be limited to specific content types.

**REST endpoint:** `GET /companies/:companyId/search?q=...&scope=...` for the UI.

---

## 3. Multi-company management

- One Hezo instance supports unlimited companies
- Full data isolation between companies (every entity is company-scoped)
- Home screen shows a card grid of all companies
- Each company card displays: name, description snippet, agent count, open issue count, budget burn bar
- Click a company card to enter its workspace

### API access for external orchestrators

Hezo can be controlled programmatically by external AI agents (OpenClaw, custom scripts, orchestration layers) via API keys.

**Auth modes for the Board API:**
- **User JWT** — stateless JWT issued after OAuth login. Required for all human users. The `hezo_` prefix on API keys distinguishes them from user/agent JWTs.
- **API key (remote)** — for OpenClaw, AI orchestrators, scripts. Header: `Authorization: Bearer hezo_<key>`.

API keys are company-scoped. A key grants full board-level access to that company: create/manage issues, hire agents, approve requests, manage secrets — everything the board UI can do. Keys are stored hashed (bcrypt), shown once at creation, never again. Managed in company settings (generate, revoke, view last-used).

This means an OpenClaw instance or any AI agent with an API key can fully orchestrate a Hezo company: create issues, assign work, approve hires, review agent output, and steer strategy — all via REST.

### Company types

A **company type** (also called a template or recipe) defines the blueprint for a new company. A company type is a grouping of **agent types** plus default KB docs, preferences, and MCP servers.

**Agent types** are first-class entities stored in the `agent_types` table. Each agent type defines:
- **Name and slug** — e.g., "CEO" / `ceo`
- **Role description** — what this agent type does
- **System prompt template** — with `{{placeholder}}` variables resolved at runtime
- **Default config** — runtime type, default reasoning effort, heartbeat interval, monthly budget
- **Source** — `builtin` (shipped with Hezo), `custom` (user-created), or `remote` (loaded from hezo connect marketplace)

A **team type** (stored as `company_types`) specifies:
- **Name** — e.g., "Software Development", "Research Lab", "Marketing Agency"
- **Description** — what this type of team does
- **Agent types** — which agent types to include, their org chart hierarchy (reports_to), and optional config overrides (via the `company_type_agent_types` join table)
- **Default KB documents** — starter knowledge base content (coding standards, guidelines, etc.)
- **Default preferences** — initial company preferences
- **Default MCP servers** — company-level MCP server configuration

A company is created from a single **template** (`template_id`). The selected template determines the starting agent roster, knowledge base, and preferences.

The current 11-agent team (CEO, Product Lead, Architect, Engineer, QA Engineer, UI Designer, DevOps Engineer, Marketing Lead, Researcher, Security Engineer, Coach) is the built-in **"Software Development"** team type. It ships with Hezo and is pre-selected by default in the UI. Users are not limited to the agent types that come with their template — they can add other agent types later.

**Creating agent types:**
- 11 built-in agent types ship with Hezo
- Users can create custom agent types via the API
- Future: agent types can be loaded from hezo connect (remote marketplace)

**Creating company types:**
- Users can create new company types from scratch (select agent types, define KB docs and preferences)
- Users can save an existing company as a new company type (snapshots current agents, KB, and preferences)
- Company types are stored locally in the Hezo instance

**Future:** Agent types and company types will be distributable as recipes from the Hezo Connect platform, enabling the community to create and sell blueprints for different kinds of AI companies.

### Company onboarding flow

When a new company is created, the user selects a **company type** (see above). The system then clones from that type and automatically:

1. **Creates the full 11-agent team** defined by the selected template. For the built-in "Software Development" type, this includes (see `agents/` for full specs):
   - CEO (reports to board)
   - Product Lead (reports to CEO)
   - Architect (reports to CEO)
   - Engineer (reports to Architect)
   - QA Engineer (reports to Architect)
   - UI Designer (reports to Architect)
   - DevOps Engineer (reports to Architect) — **starts in `idle` status**
   - Security Engineer (reports to Architect)
   - Marketing Lead (reports to CEO)
   - Researcher (reports to CEO)
   - Coach (reports to no one) — reviews completed tickets to extract lessons and improve agent system prompts
2. **Prompts the creator to connect platforms** via OAuth (see Hezo Connect, section 5b):
   - GitHub (required for repo access)
   - Gmail (recommended for agent email)
   - Others optional: Stripe, PostHog, Railway, Vercel, DigitalOcean, X, GitLab
3. **Generates an SSH key pair** for the company and registers it on the connected GitHub account via OAuth API
4. **Creates a "Setup" project** with an onboarding issue assigned to the CEO: *"Set up repository access — configure deploy keys for connected GitHub account."*
5. **Creates the `~/.hezo/companies/{slug}/` folder structure** on the host machine with AGENTS.md in the project root
6. **Provisions the project's Docker container** when the first project is created (not at company creation)

All agent system prompts are pre-filled from templates and editable. The user can delete, modify, or add agents after creation. Connected platforms can be added or removed at any time in company settings.

**Note:** The DevOps Engineer is part of the core 11-agent team but starts in `idle` status. It does not auto-activate at company creation. The DevOps Engineer activates when the board is ready for staging/production deployment — the board changes its status to `active` when needed.

**First-run flow:** Hezo Connect must be running. The first user logs in via GitHub or GitLab OAuth → master key gate modal in the UI → forced company creation. No admin-without-company state.

### Connected platforms (via Hezo Connect)

Instead of manually managing API keys and OAuth tokens, Hezo uses a centralized OAuth gateway called **Hezo Connect** (see section 5b for full architecture). Each company connects to third-party platforms via OAuth. All agents in the company share these connections.

**Supported platforms (MVP):**

| Platform | What agents use it for |
|----------|----------------------|
| GitHub | Repo access, PR management, Actions, issue sync |
| Gmail | Send/receive email, sign up for services, notifications |
| GitLab | Repo access, CI/CD |
| Stripe | Payment processing, billing, MPP |
| PostHog | Product analytics, feature flags, session replay |
| Railway | Staging/production deployment |
| Vercel | Frontend deployment, edge functions |
| DigitalOcean | Infrastructure provisioning |
| X (Twitter) | Social media posting, monitoring |

Each connected platform auto-registers as a **company-level MCP server** so agents can discover and use the tools immediately. Tokens are stored encrypted in the local secrets vault. Refresh is handled automatically by the Hezo app.

### Company creation and team types

A company is created from a single **template** (`template_id`). The selected template determines the starting agent roster, knowledge base, and preferences. Agents are provisioned by querying the `company_type_agent_types` join table for the selected template and creating instances from each referenced agent type. Each created agent stores an `agent_type_id` for provenance tracking. After creation, the company is fully independent of its source template — changes to the company do not affect the template, and vice versa.

Users can also **save an existing company as a new company type**. This snapshots:

- **Agent type references** — which agent types to include, their org chart hierarchy, and any config overrides
- **Knowledge base** — all documents (coding standards, guidelines, etc.)
- **Company preferences** — board working style preferences
- **MCP server config** — company-level MCP servers
- **MPP config** — wallet config structure (not actual wallet keys)
- **Filesystem artifacts** — AGENTS.md and other project root files (stored as JSONB blobs)

Saving as a type does **not** include: projects, repos, issues, secrets, connected platforms, cost history, audit log, API keys, or SSH keys. The resulting type captures institutional knowledge and team structure only.

---

## 4. Org structure and roles

- Each company auto-creates a full agent team on setup (see onboarding flow above)
- Agents are organized in a hierarchy with reporting lines
- Board members (human users) sit above the entire hierarchy
- Org chart is viewable as a read-only tree (MVP)

### Agent properties

| Field | Description |
|-------|-------------|
| Title | Role name (e.g. "Frontend Engineer") |
| Slug | Auto-derived from title (lowercased, hyphenated). Used for @-mentions. Unique per company. |
| Role description | Short description of responsibilities |
| System prompt | Full prompt with variable templating (see below) |
| Reports to | Parent agent in org chart |
| Runtime type | `claude_code`, `codex`, `gemini` |
| Heartbeat interval | How often the agent wakes up (default: 60 min) |
| Monthly budget | Hard spending limit in cents |
| MCP servers | Agent-level MCP server list (merged with company-level at runtime) |
| Runtime status | `active` (currently executing), `idle` (not running) — set by system |
| Admin status | `enabled`, `disabled`, `terminated` — set by user |

### System prompt templating

The system prompt editor supports variables that are resolved at runtime:

| Variable | Resolves to |
|----------|------------|
| `{{company_name}}` | Company name |
| `{{company_description}}` | Company description |
| `{{reports_to}}` | Title of the agent's manager |
| `{{project_context}}` | Current project goal + recent issue summaries |
| `{{kb_context}}` | Relevant knowledge base documents (auto-selected based on current task) |
| `{{company_preferences_context}}` | Company preferences document — board working style preferences observed by agents |
| `{{project_docs_context}}` | All project documents for the current issue's project (tech spec, implementation plan, research, UI decisions, marketing plan) |
| `{{agent_role}}` | The agent's own title |
| `{{requester_context}}` | When processing a human request: the requester's role (board/member), title, and permissions_text. Agents use this to decide whether to accept direction or escalate. |
| `{{current_date}}` | ISO date at time of resolution |

On agent creation, the UI provides a monospace editor with a toolbar for inserting variables, loading role templates, and Markdown preview support.

### Built-in role templates

Hezo ships with 11 built-in agent types that form the default team for the "Software Development" company type. Full specifications for each role are in `agents/{slug}.md`. Role-specific instructions are embedded directly in the system prompt template — no separate skill files. Users can customize every field. All agent types are starting points, not fixed — agents can be added, removed, or reconfigured per-company.

Users can also create **entirely new custom agent types** with arbitrary titles, descriptions, system prompts, runtime types, and reporting lines. For example, a user could create a "Data Scientist", "Security Auditor", or "Legal Researcher" agent type — any role needed. Custom agent types are first-class citizens — agents created from them appear in the org chart, receive issues, participate in delegation, and have their own budgets just like built-in types.

Agents can request updates to their own system prompts via `PATCH /agent-api/self/system-prompt`, subject to board approval. This allows agents to evolve their behavior when directed by a human member.

### Agent and team auto-descriptions

Every agent carries a short summary (≤5 lines) describing its role and capabilities. Every company carries a team summary (≤20 lines) describing how the agents collaborate. Built-in agent types ship with pre-baked defaults from `packages/server/src/db/agent-summaries.json`, copied to each agent and company during provisioning. At runtime the CEO can regenerate descriptions via `description-update` issues in Operations, calling the `set_agent_summary` and `set_team_summary` MCP tools.

### Ticket workflow

Every feature ticket follows this flow:

```
1. Researcher → conducts research (competitive analysis, technical feasibility, market research)
2. Product Lead → writes PRD (stored as project doc, doc_type: prd), iterates with board via live chat until requirements are finalised
3. Architect → writes technical specification → board approves
4. UI Designer → creates design mockups → board approves (for UI-related tickets; skipped for non-UI work)
5. Engineer → implements, writes tests, updates docs. Can consult Architect during implementation.
6. UI Designer → reviews frontend implementation against design specs (for UI-related tickets)
7. QA Engineer → reviews and approves (final gate) OR sends back to Engineer
```

The research and product requirements phases happen in a dedicated issue before implementation begins. The Researcher produces a research document (stored as a project doc), the Product Lead then uses it to write the PRD. The board engages in back-and-forth with the Product Lead via live chat and comments until the product requirements are finalised and approved. Only then does the Architect proceed with the technical specification.

The board must approve the technical specification before implementation begins. For UI-related tickets, the board must also approve the UI Designer's mockups.

No ticket is considered complete until the QA Engineer has approved it. The QA Engineer verifies all tests pass (including Playwright E2E tests for UI), coverage meets targets, and the implementation matches both the Product Lead's acceptance criteria and the UI Designer's design specs.

Feature work uses a **single ticket** for both design and implementation. When a ticket has UI work, the UI Designer creates preview mockups first. Previews appear in the board inbox for approval — board can approve directly or delegate approval to the Product Lead. Only after design approval does the Engineer begin implementation.

**PRD changes require board approval.** The PRD is the source of truth that drives all downstream work. If any agent discovers that requirements need to change during implementation, the Product Lead must update the PRD and get board approval before the change takes effect. This ensures the board always has an accurate picture of what is being built.

**DevOps Engineer** joins the workflow later — when the board is ready for staging or production deployment of the application. DevOps is not involved in the typical feature ticket flow.

**Escalation path:** Engineer ↔ Architect disagreement → CEO mediates → CEO escalates to human board if needed.

### Role summaries

**CEO** — strategic direction, delegation, dispute resolution, escalation to board. Reports to board.

**Product Lead** — owns product requirements. Writes PRDs with acceptance criteria. Opens live chats with the board to clarify ambiguous requirements. Ensures development aligns with company goals. Reports to CEO.

**Architect** — owns technical vision. Adds technical specs, architecture decisions, and implementation phases to tickets after the Product Lead's PRD. Reviews and approves the Engineer's implementation plans. Has technical authority — decides HOW to build things. Reports to CEO. Direct reports: Engineer, QA Engineer, UI Designer, DevOps Engineer.

**Engineer** — primary implementer. Writes code, tests, and documentation based on the Architect's spec. Can live-chat with Product Lead, Architect, or UI Designer during implementation. Reports to Architect.

**QA Engineer** — final approval gate. Reviews every ticket for test coverage (90%+), security, performance, and correctness. Uses Playwright for E2E testing of UI. Sends tickets back to the Engineer if issues are found. Proactively audits the codebase on regular heartbeats. Reports to Architect.

**UI Designer** — owns the visual and interaction layer. Creates HTML preview mockups before implementation. Provides component specs to the Engineer. Reviews the Engineer's frontend implementation for visual accuracy and accessibility. Reports to Architect.

**DevOps Engineer** — owns infrastructure and deployment. Manages staging/production environments, CI/CD pipelines, database migrations. Not part of the typical feature ticket flow — joins when board is ready for deployment. Reports to Architect.

**Marketing Lead** — owns marketing strategy and content. Writes blog posts, social media, changelogs, marketing copy (replaces the need for a separate Content Writer). Reports to CEO.

**Researcher** — conducts competitive analysis, technical research, and feasibility studies. First step in the ticket workflow — produces research that informs the Product Lead's PRD. Works with CEO, Architect, UI Designer, and Marketing Lead. Does NOT communicate directly with the Engineer. Reports to CEO.

**Security Engineer** — owns security posture. Reviews code for vulnerabilities, validates auth flows, audits dependencies, and ensures security best practices. Reports to Architect.

**Coach** — reviews completed tickets to extract lessons learned and proposes system prompt improvements for other agents. The Coach helps the team continuously improve by identifying patterns in what worked well and what didn't. Reports to no one (independent role). The `companies.settings.coach_auto_apply` field (default false) controls whether Coach-suggested system prompt improvements are auto-applied without board approval.

### AGENTS.md — two tiers

**Company-level AGENTS.md** is a KB doc stored in the `kb_docs` table. It contains company-wide rules and conventions. Editable via the Hezo UI. Injected into agent context at runtime via `{{kb_context}}` or `{{company_agents_md}}`. It is NOT written to disk or symlinked — it lives purely in the DB.

**Project-level AGENTS.md** lives at the root of each project's designated repo. This is the primary mechanism for enforcing project-specific engineering standards. Any coding agent (Claude Code, Codex, Gemini) automatically reads it from the repo root — no runtime-specific configuration needed.

Each repo in a project has its own `AGENTS.md` at its root. The designated repo's AGENTS.md is the primary source. Non-designated repos' AGENTS.md files reference the designated repo's `.dev/` docs. A `CLAUDE.md` at the repo root points to AGENTS.md (`@AGENTS.md`).

### Designated repo and project documents

Project documents are stored in the database (`project_docs` table), not the filesystem. Every project can have docs regardless of whether it has a repo. Common documents:
- `spec.md` — tech spec
- `prd.md` — product requirements (board approval required for agent changes)
- `implementation-phases.md` — ordered implementation plan
- `research.md` — research findings
- `ui-design-decisions.md` — design rationale
- Other ad-hoc documents

Agents read/write project docs via MCP tools (`list_project_docs`, `read_project_doc`, `write_project_doc`). PRD changes by agents require board approval; all other docs are updated freely. Project docs support semantic search via pgvector embeddings.

`AGENTS.md` is the exception — it stays as a git-tracked file at the repo root of the designated repo, since it needs to be discoverable by coding agents working in the repo.

Role-specific instructions are embedded directly in each agent's system prompt template — no separate skill files.

---

## 5a. Engineering rules and testing philosophy

These rules are embedded in the engineer agent's system prompt and in the company AGENTS.md. They apply to **any agent that modifies the codebase** — not just the engineer role.

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
2. If lint fails → commit is blocked. Agent must fix lint issues first.

**Pre-push hook:**
Agents run tests locally using the project's test runner directly. This includes the full test suite, lint, build, and any other checks defined in the project's configuration. If any check fails, the push is blocked. The agent fixes the issue immediately and retries. Only after all local checks pass does the push proceed to GitHub. The remote GitHub Actions still runs as a redundant safety check after push.

These hooks ensure that the `main` branch and all remote branches always have passing tests and clean lint. Broken code never reaches GitHub.

**Lint is mandatory.** Every repo must have a linter configured. If a repo is added without one, the engineer agent's first task is to set one up. The linter config lives in the repo (committed).

### QA agent — continuous code quality assessment

The QA agent is not just for running tests. It performs **regular, proactive audits** of the entire codebase on a scheduled basis (default: every heartbeat). The QA agent assesses:

| Area | What it checks |
|------|---------------|
| **Test coverage** | Runs coverage reports. Flags modules below 90%. Creates issues for coverage gaps. |
| **Security** | Scans for dependency vulnerabilities, hardcoded secrets, injection risks, auth bypasses. |
| **Performance** | Identifies N+1 queries, unbounded loops, missing indexes, memory leaks, large bundle sizes. |
| **Correctness** | Reviews business logic for edge cases, race conditions, error handling gaps. |
| **Maintainability** | Flags overly complex functions (cyclomatic complexity), dead code, duplicated logic. |
| **Documentation** | Checks that public APIs have docs, README is current, architecture docs match code. |

The QA agent creates issues for each finding, tagged with severity and category. It also runs the full test suite regularly and creates issues for any flaky tests.

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
3. Deploy status is reported back to Hezo as a system comment on the relevant issue

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

### What goes in AGENTS.md (company-level)

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
- **Product Lead:** PRD writing methodology, acceptance criteria standards, requirements gathering via live chat, scope management rules
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

All Hezo data lives under `~/.hezo/` on the host machine. The structure mirrors the company → project → repo hierarchy:

```
~/.hezo/
├── pgdata/                              # PGlite database (NodeFS persistence)
├── data/                                # Previews, temp files, assets
│
└── companies/
    ├── acme-corp/                        # Company folder
    │   └── projects/
    │       ├── backend-api/              # Project folder
    │       │   ├── api/                  # Git clone of org/api — DESIGNATED REPO
    │       │   │   ├── AGENTS.md         # Project-level agent rules (repo root)
    │       │   │   ├── CLAUDE.md         # @AGENTS.md
    │       │   │   └── .dev/             # Project documents
    │       │   │       ├── spec.md
    │       │   │       ├── prd.md
    │       │   │       └── implementation-phases.md
    │       │   ├── shared-lib/           # Git clone of org/shared (non-designated)
    │       │   │   ├── AGENTS.md         # References designated repo's .dev/ docs
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
    │           │   ├── CLAUDE.md
    │           │   └── .dev/
    │           ├── worktrees/
    │           └── .previews/
    │
    └── notegenius/                       # Another company
        └── projects/
```

**Key design decisions:**

`AGENTS.md` lives at the **repo root** of each project's designated repo. Project documents live in `.dev/` inside the designated repo. This means:
- Each project has its own AGENTS.md with project-specific rules
- Company-level rules are in the KB docs DB table, injected at runtime
- Any coding agent (Claude Code, Codex, Gemini) automatically reads AGENTS.md from the repo root
- Project documents are tracked by git with full revision history
- Non-designated repos reference the designated repo's `.dev/` docs via their own AGENTS.md

### Git worktrees for parallelism

Repos are cloned once (via SSH) into the project's `workspace/<repo-short-name>/` directory. When an agent starts a run on an issue, the runner lazily creates a **git worktree per (issue × repo)** so iterative work across runs on the same issue persists and concurrent issues cannot collide.

- Multiple agents working on different issues use different worktrees — no conflicts.
- Repeated runs on the same issue reuse the existing worktree, pulling latest changes via `git fetch` + fast-forward merge.
- The agent's working directory is the **designated repo's worktree**; other repos sit alongside and the agent can `cd` into them.

Worktree layout: `~/.hezo/companies/{company}/projects/{project}/worktrees/{issue-identifier}/{repo-short-name}/`
Branch name: `hezo/{issue-identifier}`

Worktrees are created on first run of an issue and removed when the issue transitions to a terminal status (done/cancelled) or its repo is detached.

### Docker container configuration

Each project gets its own Docker container. All repositories linked to the project are checked out inside the container under `/workspace/`. Agents working on issues in that project run as **subprocesses** inside the project's container, making them easy to kill and restart independently.

If a company has 3 projects, 3 containers run. If a project has multiple repos, they all live inside the single project container.

| Aspect | Configuration |
|--------|-------------|
| Base image | Configurable per project (default: `hezo/agent-base:latest`, built from `docker/Dockerfile.agent-base` with `claude`, `codex`, `gemini`, and `kimi` CLIs pre-installed) |
| Project mount | Host `~/.hezo/companies/{company}/projects/{project}/` → Container `/workspace/` (rw) |
| Worktrees mount | Host `~/.hezo/companies/{company}/projects/{project}/worktrees/` → Container `/worktrees/` (rw) |
| SSH keys | Company-generated SSH key injected per subprocess (from secrets vault). Host `~/.ssh/` also mounted (ro) for fallback. |
| Git config | Host `~/.gitconfig` → Container `/root/.gitconfig` (ro) |
| SSH agent | Host `$SSH_AUTH_SOCK` → Container `/tmp/ssh-agent.sock` (if available) |
| AGENTS.md | Per-repo at repo root. Designated repo's AGENTS.md is the primary source. Non-designated repos reference it. |
| Project docs | In designated repo's `.dev/` folder, accessible at `/workspace/{repo-short-name}/.dev/` |
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

Hezo generates an SSH key pair per company and registers it on the connected GitHub account via the OAuth API (`POST /user/keys`). The private key is stored encrypted in the secrets vault.

At runtime, the company's SSH private key is injected into agent subprocesses for git operations:

1. Company SSH key is written to a temporary file inside the container and configured via `GIT_SSH_COMMAND`
2. Host `~/.ssh/` is also mounted read-only as a fallback (known_hosts, SSH config)
3. Host `~/.gitconfig` is mounted so git identity (name, email) is consistent
4. If the host has an SSH agent running (`SSH_AUTH_SOCK`), the socket is forwarded into the container
5. Git clone/push/pull use SSH with the company-generated key
6. GitHub OAuth token is used for GitHub API calls (repo validation, PRs, Actions) — not for git operations

### Container lifecycle

| Event | What happens |
|-------|-------------|
| Project created | Container provisioned from the project's configured base image. All linked repos cloned inside via SSH. |
| Agent heartbeat (for project issue) | Subprocess spawned inside the project's container with the agent's environment. |
| Agent disabled | Subprocess killed (if running). Container unaffected. |
| Agent terminated | Subprocess killed. Container unaffected. Agent record kept for audit. |
| Container rebuilt | All agent subprocesses killed, container destroyed, new one provisioned. |
| Project deleted | Container destroyed. All associated worktrees cleaned up. |
| Company deleted | All project containers destroyed. |
| Server startup / every 5s | Container status sync — DB state reconciled with Docker. Stale "running" status corrected to "stopped" or "error". Changes broadcast via WebSocket. |
| Issue assigned | No-op until the first run. Worktrees are created lazily when an agent starts executing against the issue. |
| Issue first run | Runner creates `/worktrees/{issue-identifier}/{repo-short-name}/` on branch `hezo/{issue-identifier}` for every linked repo, then runs the agent with the designated repo's worktree as its working directory. |
| Issue closed | Per-issue worktree directory `/worktrees/{issue-identifier}/` is removed (all per-repo worktrees under it). |

### Agent subprocess model

Each heartbeat spawns a **fresh subprocess** inside the project's container via `docker exec`. The Hezo orchestrator spawns each agent process with:

- The agent's specific environment variables (secrets, all platform OAuth tokens, agent JWT)
- The correct working directory (the agent's assigned worktree or project folder)
- The agent's runtime command (e.g., `claude-code`, `codex`, `gemini`)
- Handoff markdown from the previous session as initial context (for session continuity)

All template variables (`{{kb_context}}`, `{{project_docs_context}}`, `{{company_preferences_context}}`, etc.) are pre-resolved by the orchestrator before spawning. All KB docs and project docs are included for MVP.

Agents can be killed and restarted independently without affecting the container or other agents. When budget is exceeded, the subprocess is terminated immediately. If a project container crashes, all running agent subprocesses for that project are lost — orphan detection handles this by marking all active heartbeat runs as failed and re-queuing them.

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

**Company-level** — shared by all agents. Configured in company settings. Good for shared infrastructure: team Slack, company database, shared SaaS tools.

**Agent-level** — specific to one agent. Configured in agent settings. Good for role-specific tools: a dev engineer's database access, a Marketing Lead's analytics platform.

At runtime, company-level and agent-level servers are merged. Agent-level takes precedence on name conflicts. The merged list is injected into the agent's subprocess as MCP configuration for the runtime (Claude Code, Codex, etc.) to discover and use.

MCP server config per entry: `{ "name": "...", "url": "...", "description": "..." }`. Stored as JSONB arrays on both `companies` and `agents`.

### MPP (Machine Payments Protocol)

Agents can pay for third-party APIs autonomously using the Stripe/Tempo Machine Payments Protocol. When an agent hits an HTTP 402 response from an MPP-compatible service, it can authorize payment and receive the resource in one round-trip.

**Company-level config:**
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

MPP costs appear in the same cost tracking dashboard as all other agent spend — per agent, per issue, per project.

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
- Exposes connected platforms as company-level MCP servers
- Manages connection lifecycle: connect, disconnect, health check, refresh

### OAuth flow

```
1. User clicks "Connect GitHub" in Hezo UI
2. Hezo app redirects to: localhost:4100/auth/github/start
     ?callback=http://localhost:3100/oauth/callback
     &state={signed_payload_with_company_id}
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
| `company_id` | Which company owns this connection |
| `platform` | `github`, `gmail`, `gitlab`, `stripe`, `posthog`, `railway`, `vercel`, `digitalocean`, `x` |
| `status` | `active`, `expired`, `disconnected` |
| `access_token_secret_id` | FK to secrets table (encrypted access token) |
| `refresh_token_secret_id` | FK to secrets table (encrypted refresh token) |
| `scopes` | OAuth scopes granted |
| `metadata` | Platform-specific data (e.g. GitHub username, Gmail address) |
| `token_expires_at` | When the current access token expires |
| `connected_at` | When the connection was established |

When a platform is connected, it is automatically registered as a company-level MCP server entry. Agents can then use the platform's tools via MCP tool calls without knowing anything about OAuth.

### Self-hosting Hezo Connect

For users who want zero dependency on the canonical instance:
1. Deploy the open-source Hezo Connect server
2. Register OAuth apps with each provider (Google, GitHub, etc.)
3. Configure the Hezo app to point to the self-hosted instance: `--connect-url https://my-connect.example.com`

### Supported platforms (MVP)

| Platform | OAuth type | Scopes | MCP tools exposed |
|----------|-----------|--------|-------------------|
| GitHub | OAuth 2.0 | `repo`, `workflow`, `read:org` | Repo CRUD, PR management, Actions, issues |
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

Git operations (clone, push, pull) use **SSH** with a company-generated SSH key pair. The GitHub **OAuth token** is used for API calls (repo validation, PRs, Actions, issues).

```
git clone git@github.com:org/repo.git
```

Hezo generates an SSH key pair per company, stores the private key encrypted in the secrets vault, and registers the public key on the connected GitHub account via the OAuth API (`POST /user/keys`). When a new repo is added, the system tests access using the OAuth token (GitHub API) before saving. If access fails, the board is told which GitHub account needs access.

**Prerequisites:**
- The company must have GitHub connected via Hezo Connect
- The connected GitHub account must have access to the repo
- The company SSH key is auto-registered on the GitHub account

### Repos belong to projects

- A project can reference multiple repos
- Each repo within a project has a unique short name (e.g. `frontend`, `api`, `infra`)
- Short names are user-defined at add time
- Short names are used for @-mentioning in issue comments: `@frontend`, `@api`
- Uniqueness is enforced within a project (DB unique constraint)

### What happens when a repo is linked

When a repo is added to a project via the API:

1. **GitHub connection check** — the system checks whether the company has an active GitHub OAuth connection (`connected_platforms` table). If not:
   - The request fails with `GITHUB_NOT_CONNECTED`
   - A board inbox item of type `oauth_request` is created automatically, prompting the board to connect GitHub via Hezo Connect
   - The inbox item includes an actionable link to start the OAuth flow
2. **Repo access validation** — using the company's GitHub OAuth token, the system calls the GitHub API (`GET /repos/{owner}/{repo}`) to verify the authorized GitHub user has access. If access fails (403/404):
   - The request fails with `REPO_ACCESS_FAILED`
   - The error message includes the GitHub username from `connected_platforms.metadata` so the board knows which account needs access: *"Cannot access this repo — the GitHub user '{username}' needs to be added to {owner}/{repo}"*
3. The repo is cloned (via SSH using the company's generated key) into `~/.hezo/companies/{company}/projects/{project}/{short_name}/`
4. A symlink is created: `{short_name}/AGENTS.md → ../../../AGENTS.md` (pointing to company-level AGENTS.md)
5. Git SSH command is configured to use the company's SSH key for all operations
6. The repo is now available to any agent working on issues in this project

### Agent access to repos

Agents don't configure repos directly. They get access to repos through whichever project their assigned issues belong to. When an agent starts work on an issue, a git worktree is created from the relevant repo clone so the agent can work on its own branch without interfering with other agents.

---

## 7. Goal and project hierarchy

Four-level hierarchy with full goal ancestry:

```
Company Description
  └── Project Goal
        └── Agent Goal (implicit from assigned issues)
              └── Task / Issue
```

Every issue carries context tracing back to the company description. Agents always know *what* to do and *why*. The goal chain is visible in the issue detail sidebar.

### Projects

- Group related work under a company
- Have a name and a goal statement
- Own repos (see section 6)
- Own project-scoped secrets

---

## 8. Issue / ticket system

GitHub-style issue tracker. Issues are the primary interaction surface for the entire system.

### Issue properties

| Field | Required | Description |
|-------|----------|-------------|
| Title | Yes | Short description |
| Description | No | Detailed markdown body |
| Project | **Yes (enforced)** | Every issue must belong to a project |
| Assignee | No | Agent or board member assigned to work on it (polymorphic: `assignee_type` + `assignee_id`) |
| Status | Yes | `backlog`, `open`, `in_progress`, `review`, `blocked`, `done`, `closed`, `cancelled` |
| Priority | Yes | `urgent`, `high`, `medium`, `low` |
| Labels | No | Free-form tags (JSONB array) |
| Parent issue | No | For sub-issues / delegation |
| Number | Auto | Per-company auto-incrementing (atomic) |
| Identifier | Auto | Linear-style: `{prefix}-{number}` (e.g. `ACME-42`). Globally unique. |
| Blocked by | No | References to other issues blocking this one (many-to-many via `issue_dependencies` table) |
| Progress summary | No | Concise markdown summary of requirements, what's done, and what's next. Updated by agents when they start/finish work on the issue. Collapsed by default in UI. |
| Progress summary updated at | Auto | Timestamp of last progress summary update |
| Progress summary updated by | Auto | Member (agent) who last updated the progress summary |

### Issue status state machine

Not all status transitions are valid. The allowed transitions are:

```
backlog → open
open → in_progress, cancelled
in_progress → review, blocked, cancelled
review → in_progress, done, cancelled
blocked → in_progress, cancelled
done → closed, in_progress (reopen)
closed → open (reopen)
cancelled → open (reopen)
```

The system enforces these transitions. Invalid transitions return an error.

### Issue list view

- Every issue row shows its **project tag** prominently (color-coded) and its **identifier**
- Filterable by: project, assignee, status, priority, labels
- Searchable by title and description
- Sortable by created date, updated date, priority
- Paginated (default 50 per page)

### Issue detail view

The primary work surface. Contains two tabs:

**Header (always visible):**
- Title, description, metadata (project tag, identifier, status, priority, assignee)
- Quick action buttons: reassign, change status, escalate, pause agent
- Goal chain sidebar (company description → project → task)
- Cost for this issue
- Process status of the assigned agent

**Comments tab (default):**
- Threaded conversation between board and agents
- Collapsible trace logs per agent message (tool calls, decisions)
- **Progress summary** — appears after the latest comment, collapsed by default. Shows the current state of work: requirements, what's done, what's next. Updated by agents when they start/finish work. Expandable to view full markdown content. When an agent operates on an issue, a `trace`-type comment is posted capturing the agent run (progress summary changes, link to run output, sub-operations).

**Live Chat tab:**
- List of all live chat sessions for this issue
- Each session shows: participants, start time, duration, message count, summary
- Click a session to expand the full transcript inline
- "Start live chat" button to open a new session

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

Agents can create sub-issues and assign them to their direct reports or peers (agents at the same level in the org chart). Delegation allows both downward and lateral assignment. Sub-issues inherit the parent's project.

### Agent-to-agent communication

All inter-agent communication happens through @-mentions in issue comments — same as GitHub. No side channels, no direct messaging, no hidden state. Everything is on the record and fully traceable.

An agent can `@architect` or `@engineer` in a comment. The mentioned agent receives a notification on its next heartbeat. The slug for @-mentions is derived from the agent title (lowercased, spaces → hyphens). Slugs are unique within a company.

Repo short names can also be @-mentioned: `@frontend`, `@api` — these reference the repo, not an agent.

Use cases: asking questions, requesting code reviews, escalating blockers, handing off context, coordinating cross-team work. All of it visible in the issue thread.

### Issue assignment triggers

Issues can be assigned to any member (agent or human user). When assigned to an agent, the agent wakes immediately (not waiting for the next heartbeat). When assigned to a human user, they are notified via the board inbox and any configured messaging channels (Telegram, Slack). Humans can work on issues outside Hezo, pass them to other members, or @-mention agents in comments for specific help.

---

## 9. Secrets management

### Storage

All secret values are encrypted at the app layer using AES-256-GCM with the master key (derived via HKDF). The DB stores ciphertext only. The master key is held in memory, never on disk.

### Scoping

- **Company-scoped secrets**: `project_id = NULL`. Available to any agent in the company (with approval).
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
   - **Company**: all secrets in the company
5. On approval, grants are created and secrets are injected as env vars into the agent's subprocess
6. Grants are persistent and auditable
7. Grants can be revoked at any time (agent loses access on next subprocess invocation)

### Platform tokens (from Hezo Connect)

OAuth tokens for connected platforms (GitHub, Gmail, Stripe, etc.) are stored as company-scoped secrets with auto-generated names (e.g. `GITHUB_ACCESS_TOKEN`, `GMAIL_REFRESH_TOKEN`). These are managed automatically by the connection lifecycle — agents don't request access to them via the approval flow. They're injected into agent subprocesses for any agent in the company.

---

## 10. Agent → user interaction

Three mechanisms for agents and the board to interact within issue threads.

### Live chat mode

Every issue has a **persistent live chat** in its Live Chat tab. This is a single, ongoing group conversation — not a series of separate sessions. The assigned agent is always a participant. Board members can @-mention any other agent in the company to pull them into the conversation.

**How it works:**
1. Board member opens the Live Chat tab on any issue
2. The chat is always there — persistent, auto-created with the issue, no "start session" step needed
3. The assigned agent is always a participant and responds in real time (no heartbeat delay)
4. Board member can @-mention any other agent (e.g. `@architect`, `@qa-engineer`) to bring them into the conversation. The mentioned agent receives the message and responds in real time.
5. Multiple agents can be active in the same chat simultaneously
6. The full transcript is always visible, scrollable, and searchable

**@-mentioning agents in live chat:**
- `@architect` — pulls the Architect into the conversation
- `@qa-engineer` — pulls the QA Engineer in
- Any agent slug works — same @-mention system as issue comments
- The mentioned agent wakes up immediately (not on next heartbeat) and joins the chat
- An agent stays in the chat until the conversation moves on — no explicit "leave"

**Q&A pattern:** Agents should use live chat for structured Q&A with the board — asking clarifying questions with multiple-choice options when requirements are ambiguous. After the Q&A is resolved, the agent posts a summary of the outcomes as a comment on the issue for the permanent record.

**Storage:**
- Full transcript stored as JSONB array of `{ "author": "board:alice|agent:architect", "text": "...", "timestamp": "..." }` in a `live_chats` table
- One chat per issue (persistent, auto-created)
- The assigned agent's member ID is always linked

**Constraints:**
- An agent can only be active in one live chat at a time (if @-mentioned in a second issue's chat while already in one, the second request queues until the first conversation pauses)
- Live chat costs count against each participating agent's budget
- Tool calls during live chat are captured in the transcript

### Structured options

Agents emit a JSON block that the UI renders as clickable cards inline in the issue thread.

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

Agents can write temporary HTML files (mockups, prototypes, reports, visualizations) and present them as viewable links in the issue thread.

#### Architecture

Agents write previews to a well-known location inside the shared workspace volume:
```
Container: /workspace/.previews/{agent_id}/
Host:      ~/.hezo/companies/{slug}/projects/{project}/.previews/{agent_id}/
```

Since the workspace is a shared volume, preview files are immediately visible on the host. The web app serves files via a proxy route:
```
GET /preview/{company_id}/{project_id}/{agent_id}/{filename}
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
- Board access to company is validated before serving

#### Cleanup

Previews are ephemeral. Auto-deleted after 72 hours, or when the issue is closed, or manually by the agent. A cron task handles expiry.

---

## 11. Cost and budget

### Company-level budget

Each company has a monthly budget cap (`budget_monthly_cents` and `budget_used_cents`). The company budget is the aggregate cap for all agent spending within the company. When company budget is exhausted, a budget-exceeded notification is sent to the board inbox.

### Per-agent budgets

- Each agent has a monthly budget in cents (default: $30 / 3000 cents)
- Budget enforcement is atomic: `debit_agent_budget()` row-locks the agent before checking + debiting, and also checks the company-level budget
- At 80% usage → `budget.warning` event emitted, system comment on active issues
- At 100% usage → budget exceeded, notification sent to board inbox, system comment posted
- Board can adjust budget at any time
- Budget resets monthly (tracked via `budget_reset_at`)

### Cost tracking

Every tool call with a cost creates a `cost_entries` row. Costs are trackable per:
- Agent
- Issue
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
| Board hires an agent | No — direct action |
| Agent requests to hire | Yes — pending approval |
| Board grants secret access | No — direct action |
| Agent requests secret access | Yes — pending approval |
| Agent submits strategy | Yes — pending approval |
| Agent submits implementation plan | Yes — `plan_review` approval (Product Lead reviews, board can override) |

### Board inbox

A unified notification center accessible from any screen. The board inbox surfaces all items that need board attention:

- **Pending approvals** — secret access, hire requests, strategy reviews, plan reviews, KB updates, deploy requests
- **UI design reviews** — preview mockups from the UI Designer awaiting approval. Board can approve directly or delegate approval to the Product Lead.
- **Escalations** — disputes between agents that the CEO couldn't resolve
- **Budget alerts** — agents approaching or exceeding budget limits, company budget alerts
- **Agent errors** — container failures, repeated task failures, agents stuck in error states
- **QA critical findings** — security vulnerabilities, critical bugs found during audits
- **OAuth link requests** — agents requesting access to external resources via Hezo Connect

Each item is actionable — approve/deny buttons, links to relevant issues, quick actions. Unread badge appears in the navigation. Board members can delegate certain approvals (e.g. Product Lead approves UI designs).

For secret access requests, the board can choose the grant scope (single / project / company) before approving.

### Board powers (board role only)

- Pause / resume / terminate any agent at any time
- Override / reassign any issue at any time
- Adjust any agent's budget at any time
- Approve or deny any pending request
- View full audit log
- Delegate specific approval types to agents
- Access company settings, secrets vault, and plugin management
- Invite new members (board or member role)

### Member capabilities (member role)

Members can participate in the day-to-day work within their project scope:
- Create issues, post comments, participate in live chat
- Be assigned issues and work on them
- Direct agents (except CEO by default) — subject to `permissions_text` boundaries
- Read knowledge base and project documents
- Receive notifications via inbox and configured messaging channels (Telegram, Slack)

Members **cannot**: modify company settings, manage budgets, hire/fire agents, access secrets, view audit log, manage plugins, or create invites.

### Audit log

Append-only, immutable. Every mutating operation writes an entry. Never updated, never deleted. Contains: actor, action, entity type/id, details JSON, timestamp.

Full action reference:

| Action | Entity | Trigger |
|--------|--------|---------|
| `company.created` | company | Board |
| `company.updated` | company | Board |
| `company.deleted` | company | Board |
| `agent.created` | agent | Board or approval resolved |
| `agent.updated` | agent | Board |
| `agent.disabled` | agent | Board manually disables agent |
| `agent.resumed` | agent | Board |
| `agent.terminated` | agent | Board |
| `company.container_rebuilt` | company | Board |
| `project.created` | project | Board |
| `project.updated` | project | Board |
| `project.deleted` | project | Board |
| `repo.added` | repo | Board |
| `repo.removed` | repo | Board |
| `issue.created` | issue | Board or agent |
| `issue.updated` | issue | Board or agent |
| `issue.assigned` | issue | Board or agent |
| `issue.closed` | issue | Board or agent |
| `comment.created` | issue_comment | Board or agent |
| `option.chosen` | issue_comment | Board |
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
| `kb_doc.created` | kb_doc | Board or agent (via approval) |
| `kb_doc.updated` | kb_doc | Board or agent (via approval) |
| `kb_doc.deleted` | kb_doc | Board |
| `kb_update.proposed` | approval | Agent |
| `kb_update.approved` | approval | Board |
| `kb_update.denied` | approval | Board |
| `company_preferences.updated` | company_preferences | Board or agent |
| `project_doc.created` | project_doc | Board or agent |
| `project_doc.updated` | project_doc | Board or agent |
| `project_doc.deleted` | project_doc | Board |
| `plan_review.submitted` | approval | Agent |
| `plan_review.approved` | approval | Board or Product Lead |
| `plan_review.denied` | approval | Board or Product Lead |
| `live_chat.started` | live_chat_session | Board |
| `live_chat.ended` | live_chat_session | Board or agent |
| `company.created_from_type` | company | Board creates company from company type |
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
3. Server returns: assigned issues, unread comments, notifications, budget remaining
4. Agent works on its highest-priority issue
5. Agent posts comments, reports tool calls, creates sub-issues as needed
6. Company container stays running for next heartbeat

### Event-based triggers (immediate wakeup)

In addition to scheduled heartbeats, agents are triggered **immediately** by:
- Task assignment — issue assigned to them (on creation, update, or sub-issue creation)
- @-mention in an issue comment or live chat
- Option chosen by the board on one of their option cards
- Approval resolved for one of their requests
- Container start — when a project container starts, all enabled agents with non-terminal assigned issues in that project are woken

Event-triggered wakeups do not wait for the next scheduled heartbeat — the agent subprocess is spawned immediately. Scheduled heartbeats are a fallback for idle agents with no pending events.

### Wakeup queue and coalescing

When multiple events fire for the same agent in quick succession (e.g. several @-mentions, assignment + comment), wakeups are coalesced into a single activation. The wakeup queue:

- Batches events within a short coalescing window (default: 10 seconds)
- Delivers all pending events in a single heartbeat response
- Prevents redundant subprocess spawns and duplicate work
- Maintains event ordering within the batch

### Reasoning effort

Every agent run picks a reasoning effort level (`minimal | low | medium | high | max`). The effective level is resolved per-run with this precedence:

1. An explicit `effort` value on the triggering wakeup payload — set by a human via the comment composer, or by an MCP caller that wants a single run to reason harder.
2. The agent's `default_effort` column (copied from the agent type when the agent is hired; editable per-agent).
3. The global `medium` fallback.

Each runtime translates the resolved level to its native knob: Claude Code appends `think`/`think hard`/`ultrathink` to the task prompt, Codex passes `-c model_reasoning_effort=<level>` (with `max` mapped to `high`), Gemini sets `GEMINI_REASONING_EFFORT` in the container env, and Kimi falls back to a prompt-only directive. The resolved level is also exposed as `HEZO_AGENT_EFFORT` so agent-side tooling can read it.

Built-in defaults: CEO and Architect default to `max` (ultrathink) so their planning runs get the full thinking budget, the Product Lead / QA / Security / Researcher default to `high`, and implementer roles default to `medium`.

### Container lifecycle and agent state

Agents execute inside project containers. Container state changes directly affect agent execution:

- **Container start**: After a container starts (or completes a rebuild), the system creates wakeup requests for all enabled agents that have non-terminal assigned issues in that project. This ensures agents resume work after downtime.
- **Container stop**: Before stopping a container, all running agent tasks for that project are cancelled via `JobManager.cancelTask()`. After the container stops, stale execution locks are released. The UI shows a confirmation dialog warning that running agent tasks will be cancelled.
- **Container rebuild**: Same as stop (cancel running agents, release locks), followed by a full re-provision. After the new container is running, agents are re-triggered as with container start. The UI shows a confirmation dialog warning about unpushed work loss.
- **Container crash**: The container-sync job detects the status change within 1 second and updates the DB. Orphan detection handles stale agent state.

Agent runtime status (`active` / `idle` / `paused`) is updated in the database and broadcast via WebSocket when an agent is activated and when it completes.

### Issue work ownership (read/write locks)

Execution locks support two modes: **write locks** (exclusive) and **read locks** (shared).

- **Write lock**: Only one agent at a time. Used by agents doing implementation work (Engineer, Architect, etc.). Prevents conflicting codebase changes.
- **Read lock**: Multiple agents simultaneously. Used by agents doing review work (QA Engineer, Security Engineer, Coach). Multiple reviewers can review the same issue in parallel, but a write lock blocks all read locks and vice versa.

Lock type is determined automatically: Coach (issue_done trigger), QA Engineer, and Security Engineer get read locks; all others get write locks. The REST API also accepts an explicit `lock_type` parameter.

Work on an issue can span **hours or days** — this is not a short-lived database lock. The agent retains ownership until:
- The issue is reassigned to a different agent or board member
- The issue status moves to `done`, `closed`, or `cancelled`
- The agent is disabled or terminated
- The board manually releases the assignment

There is no automatic timeout. If an agent appears stuck, the board can manually reassign the issue.

### Orphan detection and auto-retry

The system monitors for orphaned work — agents that started working on an issue but whose subprocess died:

- If an agent's subprocess crashes while an issue is owned, the ownership is preserved but the issue is flagged for attention in the board inbox
- If a subprocess crashes or the project container crashes mid-work, the system detects the failure and re-queues the issue for the agent's next heartbeat
- Repeated failures (3+ consecutive) escalate to the board inbox as an agent error
- The system tracks consecutive failure counts per agent per issue

### Persistent state

Agents resume the same task context across heartbeats because the project container persists and session state is tracked per agent. No cold start, no re-cloning repos, no re-reading context.

---

## 13b. Session management and compaction

### Per-task sessions

Each time an agent works on a task (issue), it operates within a session. Sessions track:
- The issue being worked on
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
- Cost in cents (using provider-specific pricing tables)

This enables accurate cross-provider cost comparison and budget tracking regardless of which runtime an agent uses.

---

## 14. Observability

### Per-ticket tool-call tracing

Every agent message in an issue thread can have associated tool calls. These are rendered as a collapsible trace log showing:
- Tool name (e.g. `bash`, `read_file`, `write_file`)
- Input (command, file path, etc.)
- Output (stdout, result)
- Status (running, success, error)
- Duration (ms)
- Cost (cents)

### Cost dashboard

Accessible from company settings. Shows cost breakdown by agent, project, provider, model, and time period. Budget bars with color coding (green → yellow → red as usage increases). Company-level budget overview at the top.

### Audit log viewer

Paginated, filterable by entity type, action, actor, and date range. Read-only.

---

## 15. Company knowledge base (DB-stored, company-level)

Each company has a knowledge base — a collection of Markdown documents stored in the `kb_docs` table that define company-wide standards across all projects. These include company-level AGENTS.md. They are living documents that agents reference and update as the company evolves.

Note: project-level documents (tech spec, PRD, implementation plan) are stored in the designated repo's `.dev/` folder, not in the KB. See section 17.

### Purpose

The knowledge base holds company-wide standards and practices:
- Coding standards and conventions
- UX design guidelines
- Architecture decision records
- Company ethos and communication style
- Testing and QA processes
- Deployment and DevOps procedures
- Onboarding guides for new agents
- Company-level AGENTS.md (rules for all agents across all projects)

### How it works

Knowledge base documents are stored in the `kb_docs` table, scoped to a company. Every agent in the company can read them. The knowledge base content is injected into agent context at runtime via the `{{kb_context}}` template variable. Company-level AGENTS.md is injected via `{{company_agents_md}}`.

### Agent-driven updates

Agents can propose updates to knowledge base documents as they work. For example, if a dev agent establishes a new pattern during implementation, it can propose adding that pattern to the coding standards doc.

**Update flow:**
1. Agent proposes a change (new doc or edit to existing doc) via the Agent API
2. The proposal creates a pending `kb_update` approval with a diff view
3. Board reviews the diff in the approval inbox and approves or denies
4. On approval, the document is updated and all agents see the new version on their next context fetch

This means the knowledge base stays current without the board having to manually maintain it — agents surface improvements, board approves them.

### Document revisions

Every change to a knowledge base document creates a revision in the `kb_doc_revisions` table. Revisions track:
- The full content at that point in time
- Who made the change (board member or agent via approval)
- Timestamp
- Optional change summary

The UI shows version history for each document with the ability to view diffs between any two revisions and revert to a previous version.

### Knowledge base in the UI

Accessible from the company workspace as a new **Knowledge base** tab. Shows a list of documents with title, last updated, last updated by (agent). Click to view/edit. Board can also create and edit docs directly. Version history accessible from the document view.

---

## 16. Company preferences

Each company has a single preferences document that captures the board's working style — how they prefer things to be done across code architecture, design, research, and team collaboration.

### Purpose

Company preferences record observed patterns in board feedback so agents can proactively align with the board's style without requiring repeated corrections. This is company-level (not per-member) — even with multiple board members, the company has one unified set of preferences.

Example preference categories:
- **Code architecture** — preferred patterns, frameworks, monolith vs microservices, language style
- **Design** — aesthetic preferences, UI complexity, animation usage, color schemes
- **Research** — preferred depth, source types, presentation format
- **Team working** — communication style, planning depth, iteration speed, approval thoroughness

### How it works

The company preferences document is a Markdown file stored in the `company_preferences` table (one row per company). All agents can read it via the `{{company_preferences_context}}` template variable injected into their system prompts.

### Agent-driven updates

Agents update the preferences document directly (no approval required) as they observe patterns in board feedback. For example, if the board consistently prefers functional programming patterns over class-based ones, an agent records this preference with evidence (e.g. "Board preferred functional approach in issue ACME-42").

Every update creates a revision in `company_preference_revisions` for auditability. The board can review history and revert.

### Board-driven updates

Board members can also edit the preferences document directly via the UI, to explicitly set preferences rather than waiting for agents to observe them.

### Company preferences in the UI

Accessible from the company workspace **Settings tab** as a "Preferences" subsection. Shows the current document with a Markdown editor. Revision history accessible from the document view.

---

## 17. Project-level shared documents (file-based, in designated repo)

Each project has a set of living documents stored as files in the designated repo's `.dev/` folder. These are tracked by git, giving full revision history for free. They are the authoritative source of truth for the project's current state.

### Document types

| File | Created by | Purpose |
|------|-----------|---------|
| `prd.md` | Product Lead | Product requirements — user stories, acceptance criteria, scope. **Agent changes require board approval.** |
| `spec.md` | Architect | Technical specification — architecture, data model, API changes |
| `implementation-phases.md` | Architect | Ordered implementation phases with dependencies and acceptance criteria |
| `research.md` | Researcher | Research findings — competitive analysis, feasibility studies |
| `ui-design-decisions.md` | UI Designer | Design rationale, component decisions, interaction patterns |
| `marketing-plan.md` | Marketing Lead | Positioning, messaging, channels, timeline |
| Other `.md` files | Any agent | Ad-hoc project documents |

### Living documents

Project documents must always reflect the current state of decisions and codebase. **Any agent** can update any project document — not just the creator. When implementation diverges from the spec, the relevant project docs must be updated. Agents use the `write_project_doc` MCP tool to update docs.

### No approval required for updates (except PRD)

Project documents are working documents actively maintained during development. Agents read/write them directly as files. Revision history comes from git. The board can view history via `git log` in the UI.

### PRD changes require board approval

When an agent tries to update `prd.md` via the API, the system creates a pending approval instead of writing directly. Board approves → file is written. Board members can edit `prd.md` directly without approval.

### How it works

Documents are stored in the `project_docs` table. Agents access them via MCP tools (`list_project_docs`, `read_project_doc`, `write_project_doc`). Documents are also injected into agent prompts via the `{{project_docs_context}}` template variable at activation time. Semantic search via pgvector embeddings is supported.

### Project documents in the UI

Accessible from the project detail view as a **Documents tab**. The UI uses the project docs API (`GET/PUT/DELETE /projects/:id/docs/:filename`) to browse and edit documents.

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
| `events` | Subscribe to Hezo events (issue created, agent heartbeat, etc.) |
| `tools` | Register new tools that agents can use |
| `http` | Make outbound HTTP requests (with allowlisted domains) |
| `secrets` | Read company secrets (with per-secret approval) |
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
    ctx.events.on("issue.created", async (event) => {
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

### Company members

Users are linked to companies through the `members` + `member_users` tables with one of two roles:

| Role | Authority |
|------|-----------|
| **Board** | Full authority. Can direct all agents including CEO. Access all projects, settings, budgets, audit log. Hire/fire agents. Approve all requests. Invite new members. |
| **Member** | Scoped authority. Can create issues, post comments, participate in live chat, be assigned issues. Can direct agents (except CEO by default). Cannot modify company settings, budgets, secrets, or agent configurations. Can be restricted to specific projects. |

Both roles sign in via GitHub or GitLab OAuth. All board members have **equal authority** — any board member can take any board action. Board member conflicts are resolved first-come-first-served (first to approve/deny locks the decision). A user can belong to multiple companies with different roles in each.

The first user to sign in becomes the instance admin. They must create their first company immediately (no admin-without-company state).

#### Member configuration

When a member is added, the inviting board member specifies:
- **Role title** — an arbitrary title (e.g. "Frontend Developer", "Product Manager", "Intern"). Displayed in the UI and visible to agents.
- **Permissions text** — a free-text description of what the member can and cannot do. This text is injected into agent system prompts via `{{requester_context}}` so agents respect the member's authority boundaries.
- **Project scope** — optionally restrict the member to specific projects. If set, the member can only see and interact with those projects. If unset, the member can access all projects.

**Permission enforcement** operates at two layers:
1. **API layer (structural):** Hard boundaries enforced by the server. Board-only operations (settings, budgets, agents, secrets, audit log) are blocked for members. Project scope restrictions are enforced on all queries.
2. **Agent layer (behavioral):** The `permissions_text` is injected into agent context when the member interacts with an agent. Agents interpret the text to decide whether to accept direction, escalate to the CEO, or refuse. This allows nuanced, role-specific boundaries without rigid permission matrices.

**Example permissions_text values:**
- *"Frontend developer. Can direct Engineer and QA Engineer on frontend tasks. Cannot modify architecture decisions or PRDs — escalate to Architect or CEO."*
- *"Project manager for the mobile app. Full authority over issues in the Mobile project. Can direct all agents on mobile-related work."*
- *"Intern. Can comment on issues but cannot create or assign them. Read-only access to knowledge base."*

### Invites

Board members can invite others to join a company:
1. Board member creates an invite specifying: email, role (board/member), and for members: role title, permissions text, and optionally project scope
2. System sends an invitation email **from the company email address** (see company onboarding, section 3) containing a unique invite link
3. Invite is valid for **7 days**
4. Recipient clicks the link and signs in via GitHub or GitLab OAuth
5. After authenticating, the recipient is added to the company with the specified role and permissions
6. Expired invites must be re-created

If the company has no email address configured, invites are still generated but must be shared manually (the invite link is displayed in the UI for copying). Only board members can create invites.

### Instance admin

The first user to create an account is the instance admin. The instance admin can:
- Access all companies (regardless of membership)
- Manage the Hezo instance settings
- View system-wide audit log

### Messaging integrations (optional)

Board members can optionally interact with Hezo through Slack and/or Telegram in addition to the web UI and MCP endpoint. Both integrations are fully optional.

#### Telegram bot

Per-user setup in account settings. A single Telegram bot serves the entire Hezo instance. Users link their Telegram account by providing a chat ID after starting a conversation with the bot.

**Capabilities:**
- Receive notifications for board inbox items (approvals, escalations, budget alerts, agent errors, QA findings, OAuth requests, design reviews)
- Approve or deny requests via inline keyboards
- Create issues, post comments, and interact with agents via bot commands (`/issues`, `/approve`, `/comment`, etc.)
- Agent messages indicate which agent is speaking

**Technical:** Webhook-based via Telegram Bot API (`POST /webhooks/telegram`). Each notification includes a deep link back to the relevant item in the Hezo UI.

#### Slack integration

Per-company setup in company settings. A single Slack app is installed per company workspace. Each role agent posts messages with a distinct display name and avatar using `chat.postMessage` `username` and `icon_url` overrides, so agents appear as separate identities in Slack.

**Capabilities:**
- Board members receive notifications in a designated channel
- Approve or deny requests via Slack interactive messages
- Create issues, post comments, and @-mention agents in channels
- Each agent's messages appear under its own name and avatar

**Technical:** Events received via Slack Events API webhook (`POST /webhooks/slack`). Bot token stored encrypted in secrets vault. Configured in company settings.

#### Notification preferences

Per-user settings controlling which events trigger notifications and through which channel. Configured in account settings.

- **Channels:** Web inbox (always on), Telegram (optional), Slack (optional)
- **Event types:** approvals, escalations, budget_alerts, agent_errors, qa_findings, oauth_requests, design_reviews
- **Defaults:** Web inbox only. Telegram and Slack channels are disabled until the user links their account and enables them.

---

## 16c. File attachments

### Overview

Issues and comments can have file attachments. Files are stored locally on the host filesystem.

### Assets table

The `assets` table stores metadata for uploaded files:
- `id` — UUID
- `company_id` — company scope
- `filename` — original filename (sanitized)
- `content_type` — MIME type
- `size_bytes` — file size
- `storage_path` — path on host filesystem
- `uploaded_by_type` — `board` or `agent`
- `uploaded_by_id` — user or agent ID
- `created_at` — upload timestamp

### Issue attachments

The `issue_attachments` join table links assets to issues:
- `issue_id` — the issue
- `asset_id` — the file
- `comment_id` — optional, if attached to a specific comment

### Storage

MVP uses local filesystem storage:
```
~/.hezo/data/assets/{company_id}/{asset_id}/{filename}
```

Files are served via:
```
GET /api/companies/:id/assets/:asset_id
```

### Upload pipeline

1. Client uploads file via multipart form POST
2. Server validates: file size (max 10MB), filename sanitization, MIME type
3. File is written to local storage
4. Asset record created in database
5. Asset ID returned to client for linking to issues/comments

### Constraints

- Maximum file size: 10MB per file
- Filename sanitized — no path traversal, special characters stripped
- Files are company-scoped — access validated against company membership
- Deleting an issue does not delete attachments (they may be referenced elsewhere)
- Orphaned assets can be cleaned up via a maintenance task

---

## 19. UX design

### Design principles

1. **Dashboard-first** — land on a clear overview, not a wall of config
2. **Progressive disclosure** — simple defaults, power controls available but not in your face
3. **Issue-centric** — issues are the primary interaction surface, not agent config
4. **Inline approvals** — secret requests, hire approvals surface as actionable cards in a unified inbox
5. **Minimal chrome** — flat, clean, generous whitespace

### Board inbox model

The board inbox is the primary notification center. It surfaces everything that needs board attention in one place:

| Item type | Source | Actions |
|-----------|--------|---------|
| Pending approvals | Secret access, hire, strategy, plan review, KB update, deploy | Approve / Deny |
| UI design reviews | UI Designer submits preview mockups | Approve / Deny / Delegate to Product Lead |
| Escalations | CEO escalates unresolved disputes | Review issue, make decision |
| Budget alerts | System detects 80%+ usage or company budget approaching limit | Adjust budget, acknowledge |
| Agent errors | Container crash, repeated failures, stuck agents | Restart, investigate, terminate |
| QA critical findings | QA agent finds security or critical issues | Review, prioritize |
| OAuth link requests | Agent needs external resource access | Authorize (click OAuth link) |

Each item is actionable with inline buttons. Items are marked read/unread. Unread count badge appears in the main navigation. Board members can delegate certain approval types (e.g. Product Lead approves UI designs).

### Single-ticket workflow with UI design

For tickets with UI work, the flow within a single ticket is:

1. Researcher conducts research → findings stored as project doc
2. Product Lead writes PRD based on research → iterates with board via live chat until requirements finalised
3. Architect adds technical spec → board approves the spec
4. UI Designer creates HTML preview mockups → preview appears in board inbox → board approves
5. Engineer implements based on approved spec + design
6. UI Designer reviews implementation against design specs
7. QA Engineer reviews and approves → ticket status: `done`

All of this happens within one ticket. The Comments tab shows the conversation flow. The Live Chat tab shows any real-time sessions that occurred during the process. Project documents (tech spec, implementation plan, research, UI decisions) are accessible from the project's Documents tab and are kept up-to-date by all agents as work progresses.

### Screen inventory

| # | Screen | Purpose |
|---|--------|---------|
| 1 | **Home — Company list** | Card grid of all companies. Stats + budget bar per card. "New company" (select company type). Board inbox badge. |
| 2 | **Company workspace — Issues tab** | Default view. Filterable issue list. Every row shows identifier, project tag, assignee, status, priority. |
| 3 | **Issue detail** | Primary work surface. Two tabs: Comments (threaded conversation, traces, goal chain sidebar, quick actions) and Live Chat (session list, inline transcripts). |
| 4 | **Live chat panel** | Side panel or modal. Real-time back-and-forth with assigned agent. On close, session appears in Live Chat tab. |
| 5 | **Company workspace — Agents tab** | Card grid of agents. Runtime, heartbeat, process status, budget bar per card. |
| 6 | **New agent / edit agent** | Form with system prompt editor (monospace, variable chips, role templates), reporting line, budget. |
| 7 | **Board inbox** | Drawer accessible from any screen. Pending approvals, design reviews, escalations, budget alerts, agent errors, QA findings, OAuth requests. One-click actionable. Unread badge. |
| 8 | **Company workspace — Org chart tab** | Read-only tree with status indicators. Click node to inspect agent. |
| 9 | **Company workspace — Projects tab** | List of projects with goal, repo count, issue count. Click to see filtered issue list + repo management. Project detail includes a Documents tab showing project-level shared documents (tech spec, implementation plan, research, UI decisions, marketing plan). |
| 10 | **Company workspace — Knowledge base tab** | List of .md docs with title, last updated, updated by. Click to view/edit. Version history. Board can create docs directly. |
| 11 | **Company workspace — Settings tab** | Board-only. Company description editor, connected platforms (OAuth), secrets vault, MCP servers, MPP config, budget overview, company preferences, plugin management, Slack integration, member management. |
| 12 | **Account settings** | All roles. Profile, Telegram bot setup, notification preferences. |

### Navigation structure

The UI uses a three-column layout: a narrow company icon rail on the far left, a side menu for the selected company, and the main content area.

**Company Rail** (60px icon sidebar, always visible):
- Home icon at top → company list page
- Company avatars (click to select)
- "+" button to create new company (from company template)
- Bottom section: theme switcher, inbox badge

**Side Menu** (200px, visible when a company is selected):
- Inbox (pending approvals — full page)
- Issues (company-level)
- Projects
- Agents
- Org chart
- Knowledge base
- Settings

**Project view** uses tabs (Issues, Agents, Container, Settings) instead of a sidebar. Selecting a project adds its slug to the URL.

```
Company Rail → Company List (home)
                └── Create Company (select company template)

Company Rail → Company workspace (side menu)
        ├── Inbox (pending approvals)
        ├── Issues
        │     └── Issue detail
        │           ├── Comments tab (default)
        │           └── Live Chat tab
        ├── Projects
        │     └── Project detail (tabs)
        │           ├── Issues tab (filtered)
        │           ├── Agents tab
        │           ├── Container tab
        │           └── Settings tab
        ├── Agents
        │     └── Agent detail / edit
        │     └── Hire agent (creates onboarding issue for CEO)
        ├── Org chart
        ├── Knowledge base
        │     └── Document view / edit / version history
        └── Settings
              ├── General
              ├── Connected platforms (OAuth)
              ├── Secrets vault
              ├── API keys
              ├── MCP servers
              ├── Budget overview
              ├── Company preferences
              ├── Skill file
              └── Audit log
```

### Company creation and templates

When creating a company, the user selects one or more company templates (default: "Software Development"). A template includes a team of agents with defined roles and reporting hierarchy, plus optional KB docs and preferences.

Every company gets an auto-created **Operations** project (`is_internal = true`) for administrative issues like agent onboarding. Internal projects are visible but not deletable.

### Agent onboarding

Hiring a new agent creates the agent in disabled state and opens an onboarding issue in the Operations project, assigned to the CEO agent. The CEO reviews the new hire against the existing team, discusses reporting structure and responsibilities with the board member via issue comments, and enables the agent once onboarding is complete. If no CEO agent exists, the agent is created directly in enabled state.

---

## 20. Data model

### Tables

See `schema.md` for the full table reference and design decisions. Key tables:

| Table | Purpose |
|-------|---------|
| `system_meta` | Key-value store for system config (master key canary) |
| `users` | Global human identity (display_name, avatar_url). No email. |
| `user_auth_methods` | OAuth login methods (GitHub, GitLab). Links provider to user. |
| `members` | Base table for all company participants. Has `member_type` enum ('agent'/'user'). |
| `member_agents` | Agent-specific extension (system_prompt, runtime, budget, heartbeat, org chart). |
| `member_users` | User-in-company extension (role, role_title, permissions_text, project_ids). |
| `agent_types` | First-class agent type catalog with role templates, system prompts, and default configs. Sources: builtin, custom, remote. |
| `company_types` | Team type blueprints (recipes). Groups of agent types plus default KB docs, preferences. |
| `company_type_agent_types` | Join table linking team types to agent types with org chart and config overrides. |
| `company_team_types` | Many-to-many join table linking companies to the team types they were created from. |
| `companies` | Top-level tenant. Has `mcp_servers` (JSONB), `mpp_config` (JSONB), `settings` (JSONB), budget. |
| `invites` | Pending invitations to join a company (7-day expiry) |
| `api_keys` | Company-scoped API keys for external orchestrators. Stored hashed. |
| `company_ssh_keys` | Generated SSH key pairs per company. Registered on GitHub via OAuth API. |
| `projects` | Groups of work under a company. Each gets its own Docker container. |
| `repos` | Git repos (GitHub only). Stores `org/repo` identifier. Short name for @-mentions. |
| `issues` | Tickets. Must have a project. Assignee references `members.id`. |
| `issue_dependencies` | Many-to-many blocking relationships between issues. |
| `issue_comments` | Thread entries. Polymorphic via `content_type` + `content` JSONB. |
| `execution_locks` | Issue work ownership tracking — read/write locks. Multiple readers (reviewers) or one exclusive writer. |
| `secrets` | Encrypted key-value. Scoped to company or company+project. |
| `secret_grants` | Links secrets to agents. Revocable. |
| `approvals` | Pending board decisions. Polymorphic payload. |
| `cost_entries` | Immutable spend records. Includes `provider` and `model` fields. |
| `audit_log` | Append-only. Never updated or deleted. |
| `kb_docs` | Knowledge base documents. AGENTS.md is a special KB doc written to disk. |
| `live_chats` | Persistent live chat per issue. One ongoing conversation. |
| `project_docs` | Project documentation (PRD, spec, implementation plan, etc.) — DB-backed, company-scoped, with embeddings. |
| `skills` | Reusable instruction documents — DB-backed, company-scoped, with tags, revisions, and embeddings. |
| `skill_revisions` | Version history for skills. |
| `connected_platforms` | OAuth connections to external services. Tokens stored in secrets. |
| `plugins` | Installed plugins. Config, capabilities, status. Local-only for MVP. |
| `notification_preferences` | Per-user notification routing. |
| `slack_connections` | Per-company Slack app config. |

### Enums

```
member_type:          agent, user
agent_runtime:        claude_code, codex, gemini
agent_runtime_status: active, idle
agent_admin_status:   enabled, disabled, terminated
member_role:          board, member
container_status:     creating, running, stopped, error    (tracks project container status)
issue_status:         backlog, open, in_progress, review, blocked, done, closed, cancelled
issue_priority:       urgent, high, medium, low
comment_author_type:  board, agent, system
comment_content_type: text, options, preview, trace, system
tool_call_status:     running, success, error
secret_category:      ssh_key, credential, api_token, certificate, other
grant_scope:          single, project, company
approval_type:        secret_access, hire, strategy, plan_review, kb_update, deploy_production
approval_status:      pending, approved, denied
audit_actor_type:     board, agent, system
repo_host_type:       github
platform_type:        github, gmail, gitlab, stripe, posthog, railway, vercel, digitalocean, x
connection_status:    active, expired, disconnected
project_doc_type:     (removed — project docs are files in .dev/)
auth_provider:        github, gitlab
```

### Atomic functions

**`next_issue_number(company_id)`** — Upsert + returning for gap-free per-company issue numbering.

**`debit_agent_budget(agent_id, amount_cents)`** — SELECT FOR UPDATE to row-lock, check agent budget AND company budget, debit both. Returns FALSE if either budget is exceeded.

### Key constraints

- `agents(company_id, slug)` UNIQUE: slugs unique within company (for unambiguous @-mentions)
- `repos.url` CHECK: must match `github.com`
- `repos(project_id, short_name)` UNIQUE: short names unique within project
- `issues(company_id, number)` UNIQUE: issue numbers unique within company
- `issues(company_id, identifier)` UNIQUE: identifiers unique within company
- `issues.project_id` NOT NULL: every issue must belong to a project
- `secrets(company_id, project_id, name)` UNIQUE: secret names unique within scope
- `secret_grants(secret_id, agent_id)` UNIQUE: no duplicate active grants
- `company_memberships(user_id, company_id)` UNIQUE: no duplicate memberships
- `invites.token` UNIQUE: invite tokens globally unique
- `invites.expires_at` CHECK: must be in the future at creation

### Encryption

All secret values encrypted with AES-256-GCM. Key derived from master key via HKDF with per-secret salt. DB stores: `{iv}:{ciphertext}:{auth_tag}` as a single text field.

---

## 21. API design

The full API reference is maintained separately. See `api.md` for the complete endpoint reference including request/response shapes.

### Authentication

Three token types:
- **User JWT** — stateless JWT signed with master key. Set after GitHub/GitLab OAuth login. Contains `user_id`, `member_id`, `company_id`. Always required for human users.
- **API key (remote orchestrators)** — `Authorization: Bearer hezo_<key>`. Company-scoped, full board access. For OpenClaw, scripts, AI agents controlling Hezo remotely.
- **Agent JWT** — `Authorization: Bearer <jwt>`. Signed with master key. Minted per run; claims are `member_id` (= agent_id), `company_id`, `run_id`, with a four-hour `exp`. On every request the server looks up the `heartbeat_runs` row matching `run_id` and rejects unless its status is `running`, so tokens become invalid the moment the run finalizes.

### API surfaces

| Surface | Description |
|---------|-------------|
| Board API | Full CRUD for companies, agents, projects, repos, issues, secrets, approvals, KB, connections, plugins, users, etc. |
| Agent API | Heartbeat, context, comments, tool calls, delegation, secret requests, KB proposals, deploy requests. |
| MCP Endpoint | Streamable HTTP at `/mcp`. Mirrors Board API as MCP tools for external AI agents. |
| Skill File | `GET /skill.md`. Dynamically generated documentation for AI agent onboarding. |
| WebSocket | Row-level diffs for TanStack DB sync + system events (agent lifecycle, container status, live chat). |

---

## 22. Deferred to V2

| Feature | Notes |
|---------|-------|
| 1Password integration | Replace local encrypted secrets with 1Password Connect Server |
| Agent type & company type marketplace | Community marketplace on hezo connect for creating, sharing, and selling agent types and company types |
| Config versioning with rollback | Revisioned config changes, safe rollback |
| Visual drag-to-reorganize org chart | Interactive reordering of reporting lines |
| Mobile-optimized UX | Responsive but not phone-first in MVP |
| ClipMart / marketplace | Browse and download pre-built company templates |
| External integrations | Asana, Trello, Linear, etc. |
| Bring-your-own-ticket-system | Sync with external issue trackers |

---

## Appendix A: Separate reference files

The following specification details are maintained in separate files:

- **`schema.md`** — Data model design decisions, rationale for table structures (including members base table, custom auth, SSH keys, execution locks, issue dependencies)
- **`api.md`** — Complete API reference with all endpoints, request/response shapes, query parameters, and WebSocket event types
- **`connect-spec.md`** — Hezo Connect OAuth gateway specification (self-hosted and centrally hosted modes)
- **`implementation-phases.md`** — 12 implementation phases from Phase 0 (Hezo Connect) through Phase 11 (Deploy + Messaging)
- **`agents/`** — Full role specifications for each of the 9 built-in agent roles (`ceo.md`, `product-lead.md`, `architect.md`, `engineer.md`, `qa-engineer.md`, `ui-designer.md`, `devops-engineer.md`, `marketing-lead.md`, `researcher.md`)

## Appendix B: Endpoint count

| Surface | Count |
|---------|-------|
| Board API (REST + WS) | See `api.md` for current count |
| Agent API (REST) | See `api.md` for current count |
