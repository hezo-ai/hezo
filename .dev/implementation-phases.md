# Implementation Phases

> Hezo is a large system. This document breaks implementation into ordered phases,
> each delivering a working, testable increment. Later phases build on earlier ones.
> Each phase has a "How to test" section describing concrete validation steps.
>
> **Testing is mandatory in every phase.** Unit tests (Vitest), integration tests
> (Vitest + PGlite template database pattern), and E2E tests (Playwright for UI,
> Vitest for API) are built alongside the features they test.

---

## Phase 0: Hezo Connect (Self-Hosted, GitHub Only)

**Goal:** A standalone OAuth relay that can handle GitHub OAuth flows. First thing built, independently testable, no dependency on the main Hezo app. Lives in `packages/connect`.

**What's included:**
- Standalone Bun/Hono HTTP server (port 4100 by default)
- 3 endpoints:
  - `GET /health` — returns `{ "ok": true }`
  - `GET /auth/github/start?callback=...&state=...` — redirects to GitHub OAuth consent screen with signed state
  - `GET /auth/github/callback` — exchanges auth code for token, redirects back to caller with token in query params
- HMAC-SHA256 state parameter signing for CSRF prevention
- In-memory nonce map for in-flight OAuth flows (no database)
- Token delivery via browser redirect (not server-to-server POST)
- Environment config: `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `STATE_SIGNING_KEY`

**How to test:**
- `curl localhost:4100/health` returns 200
- Open `localhost:4100/auth/github/start?callback=http://localhost:3000/test&state=...` in browser — redirects to GitHub consent
- After authorizing, browser redirects back to callback URL with `access_token` and `state` params
- Invalid/tampered state params are rejected
- Unit tests for state signing and nonce management

**Depends on:** Nothing

---

## Phase 1: Foundation

**Goal:** A running Hono server with an embedded database, migration system, master key, and CLI argument parsing. No business logic yet. Lives in `packages/server` with shared types in `packages/shared`.

**What's included:**
- Hono server (TypeScript)
- PGlite with NodeFS filesystem persistence at `~/.hezo/pgdata`
- Migration runner: loads SQL from bundled archive (via `@hiddentao/zip-json`), tracks in `_migrations` table, runs on startup
- `001_initial_schema.sql` applied on first run
- Build step: compress `migrations/*.sql` into `migrations-bundle.json` via `zip()`, embed in binary
- Master key lifecycle: terminal prompt on first run (generate or enter key), terminal prompt on subsequent runs (enter key or generate new + fresh start), `--master-key` CLI override
- CLI parsing: `--data-dir`, `--master-key`, `--port`, `--connect-url`, `--connect-api-key`, `--reset`
- `--reset` flag: wipe database and start fresh (with confirmation prompt)
- Sensible defaults: port 3100, connect-url `http://localhost:4100`, data-dir `~/.hezo/`
- `GET /health` endpoint
- Test infrastructure: Vitest config, template database pattern, port allocation utility

**How to test:**
- `hezo --port 3100` starts server, prompts to generate or enter master key on first run
- `hezo --master-key <key> --port 3100` verifies key and starts
- Wrong master key prompts with recovery options (re-enter or generate new + fresh start)
- `curl localhost:3100/health` returns 200
- PGlite data persists at `~/.hezo/pgdata` between restarts
- `hezo --reset` wipes database and starts fresh after confirmation
- Migration table shows `001_initial_schema.sql` as applied

**Depends on:** Nothing

---

## Phase 2: Core CRUD

**Goal:** Full REST API for all core entities. No Docker, no agents running, no OAuth — all testable with curl.

**What's included:**
- Company types CRUD (create, list, get, update, delete)
  - Built-in "Software Development" type seeded on first run
- Company CRUD (create from company type, update, delete, list)
  - Company email field
  - Issue prefix and auto-derived identifiers
- Agent CRUD (create/hire, update, pause, resume, terminate, list)
  - Agents auto-created from company type on company creation
  - Custom role creation with arbitrary titles/prompts
  - Org chart with `reports_to` hierarchy
- Project CRUD (create, update, delete, list)
- Issue CRUD (create, update, delete, list, status transitions)
  - Atomic issue numbering (`next_issue_number()`)
  - Linear-style identifiers (ACME-42)
  - Issue work ownership fields
  - Sub-issues and `blocked_by`
- Comment CRUD (create, list) with all content types (text, options, preview, trace, system)
- Secrets vault (create, list, revoke — encrypted with master key)
- Secret grants (create, revoke)
- Approvals (create, approve, deny, list)
- Cost entries (create, list, budget queries)
  - `debit_agent_budget()` atomic function
- API keys (create, list, revoke)
- Board API authentication: `local_trusted` mode (localhost only)

**How to test:**
- Create a company type, then create a company from it — 9 agents auto-created
- Full CRUD cycle for every entity via curl
- Issue status state machine enforced (invalid transitions rejected)
- Issue identifiers auto-generated correctly (ACME-1, ACME-2, ...)
- Budget debit works atomically
- Secret values encrypted in DB, decrypted on read
- Comprehensive Vitest suite covering all endpoints

**Depends on:** Phase 1

---

## Phase 3: GitHub Integration

**Goal:** Connect Phase 0 (Hezo Connect) to the main app. OAuth callback, token storage, repo validation.

**What's included:**
- `POST /connections/github/start` — generates auth URL via Hezo Connect
- `GET /oauth/callback` — receives token, encrypts, stores in `connected_platforms`
- Repo CRUD with GitHub access validation (API check with OAuth token before saving)
- Repo cloning via HTTPS + OAuth token
- Company-level `.claude/` folder setup and symlinks
- Board inbox `oauth_request` items when GitHub not connected
- Connected platforms management (connect, disconnect)

**How to test:**
- Start Hezo Connect (Phase 0) on port 4100 and main app on port 3100
- Connect a GitHub account via the OAuth flow
- Add a repo — system validates access via GitHub API
- Invalid repo URL or no access returns clear error
- Repo is cloned to correct filesystem path
- Token is encrypted in secrets table

**Depends on:** Phase 0, Phase 2

---

## Phase 4: Agent Execution

**Goal:** Agents can actually run. Docker containers per project, subprocesses, heartbeats, worktrees, budget enforcement.

**What's included:**
- Project Docker container lifecycle (provision, start, stop, rebuild via Docker Engine API)
  - One container per project (all repos checked out inside)
  - Dev port forwarding for preview access
- Agent subprocess management (`claude_code` adapter: subprocess in project container via `docker exec`)
- Git worktrees for parallel agent work
- Heartbeat engine: wakeup queue, coalescing, timer ticks
- Issue work ownership (claim on start, release on complete/reassign/pause)
- Orphan detection and auto-retry
- Per-agent and per-company budget enforcement with atomic debit
- Cost tracking (per agent, per issue, per project)
- Tool call tracing
- Host filesystem layout (`~/.hezo/companies/{id}/projects/{id}/...`)
- Agent JWT authentication for Agent API

**How to test:**
- Create a project — Docker container provisioned automatically
- Assign an issue to an agent — agent subprocess starts in project container
- Multiple agents work on different issues simultaneously (separate worktrees)
- Budget exceeded pauses agent with system comment
- Container crash detected and reported
- Orphaned work re-queued after failure
- Dev port forwarding accessible from host browser

**Depends on:** Phase 3

---

## Phase 5: Knowledge + Observability

**Goal:** KB, preferences, project docs, audit log, live queries, WebSocket events, live chat, previews.

**What's included:**
- Knowledge base CRUD (documents, revisions, agent proposals, approval flow)
- Company preferences (document, revisions, agent-driven updates)
- Project-level shared documents (tech spec, implementation plan, research, UI decisions, marketing plan)
- Audit log (append-only, never updated/deleted)
- PGlite live queries for frontend data reactivity (`live.query()`, `live.changes()`)
- WebSocket real-time events (agent lifecycle, container status, live chat)
- Persistent live chat (per-issue, @-mention agents)
- HTML previews (agent writes to workspace volume, served via proxy)
- Structured options (clickable choice cards)

**How to test:**
- Create KB doc, agent proposes edit, board approves — revision history correct
- Audit log entries created for all significant actions
- Tool calls visible in issue thread
- WebSocket events fire on agent status changes
- Live chat session persists across page reloads
- Preview URL serves agent-generated HTML
- Live query updates frontend without page refresh

**Depends on:** Phase 4

---

## Phase 6: MCP + Skill File

**Goal:** External AI agents can interact with Hezo via MCP or by reading the skill file.

**What's included:**
- MCP endpoint (Streamable HTTP at `POST /mcp`)
  - All Board API operations exposed as MCP tools
  - Authentication via API key or local trusted
- Skill file at `GET /skill.md`
  - Dynamically generated from registered MCP tool definitions
  - Also committed to repo at `.claude/skills/hezo/SKILL.md`

**How to test:**
- Connect an MCP client to `localhost:3100/mcp` — tools listed and callable
- Create an issue via MCP `create_issue` tool call — verified in DB
- `curl localhost:3100/skill.md` returns valid Markdown listing all current tools
- API key auth required for MCP when in `authenticated` mode

**Depends on:** Phase 5

---

## Phase 7: React Frontend

**Goal:** All UI screens, bundled into the binary via `bun build --compile`.

**What's included:**
- Company list + creation (select company type)
- Company workspace: Issues, Agents, Projects, Org Chart, KB, Settings tabs
- Issue detail (Comments tab + Live Chat tab)
- Agent detail + hire form (including custom role creation)
- Approval inbox + board inbox
- Secrets vault UI
- Cost dashboard
- Audit log viewer
- Settings page (connected platforms, company email, MCP servers, preferences)
- Project detail with Documents tab and Dev Preview link
- PGlite React hooks (`useLiveQuery`, `useLiveIncrementalQuery`) for real-time data
- Master key status indicator (shows locked/unlocked state in UI header)
- `bun build --compile` producing single self-contained binary
- Playwright E2E tests covering all major UI flows

**How to test:**
- Build binary, run it, open browser — all screens render
- Create/edit/delete operations work from UI
- Live data updates without page refresh (live queries)
- Board inbox shows pending approvals with one-click actions
- Org chart displays correct hierarchy
- Dev preview link opens running project in new tab
- Playwright tests pass

**Depends on:** Phase 6

---

## Phase 8: Multi-User Auth + Roles

**Goal:** Better Auth with OAuth login, board/member roles with permissions, company email invites, session compaction.

**What's included:**
- Better Auth integration:
  - GitHub OAuth login (via Hezo Connect)
  - GitLab OAuth login (via Hezo Connect)
  - Session cookies
  - (Email/password deferred to post-MVP)
- `authenticated` deployment mode
- OAuth login page (GitHub + GitLab buttons)
- Company memberships with two roles:
  - `board` — full authority
  - `member` — scoped authority with `role_title`, `permissions_text`, `project_ids`
- Permission enforcement:
  - API layer: board-only endpoints blocked for members, project scope enforced
  - Agent layer: `{{requester_context}}` injected into agent prompts with member's permissions_text
- Invite system:
  - Email invites sent from company email address
  - Invite specifies role, title, permissions, project scope
  - Invite link with unique token, 7-day expiry
  - Recipient authenticates via GitHub or GitLab OAuth
  - Role and permissions copied to membership on accept
- Instance admin (first user to sign in)
- Account settings page
- Session compaction:
  - `agent_task_sessions` table
  - Per-adapter compaction policies
  - Handoff markdown generation
- File attachments (upload, download, issue linking, local storage)

**How to test:**
- Create account via GitHub OAuth, log in, access company as board member
- Create account via GitLab OAuth, log in, access company
- Invite a board member — joins with full access
- Invite a member with role_title + permissions_text + project_ids — joins with scoped access
- Member can create issue in allowed project
- Member cannot access restricted project (403)
- Member cannot access company settings or agent management (403)
- Agent respects member's permissions_text (e.g. refuses to change PRD when permissions say not to)
- Member cannot create invites (403)
- Unauthorized access rejected in authenticated mode
- Session compaction triggers after token threshold

**Depends on:** Phase 7

---

## Phase 9: Adapters + Plugins

**Goal:** Non-Claude-Code agent runtimes and the plugin system.

**What's included:**
- Gemini adapter (subprocess, Gemini CLI)
- Codex adapter
- `bash` adapter refinements
- `http` adapter refinements
- Plugin system:
  - Worker thread isolation
  - Capability-gated APIs (state, events, tools, http, secrets, cron)
  - Plugin lifecycle (install, enable, disable, uninstall)
  - Crash recovery with exponential backoff
  - `@hezo/plugin-sdk` package
  - Local plugin loading (filesystem path)
  - Plugin management UI
- Plugin registry (plugins.hezo.ai):
  - Browse, search, ratings, version management
  - Self-hosted registry support (`--plugin-registry-url`)

**How to test:**
- Create agent with Gemini runtime — executes via Gemini CLI
- Install a test plugin — runs in worker thread, can read/write state
- Plugin crash is recovered with backoff
- Plugin capabilities enforced (unauthorized API access blocked)

**Depends on:** Phase 8

---

## Phase 10: Full Platform Integrations

**Goal:** Extend Hezo Connect beyond GitHub to all supported platforms. Centrally hosted mode.

**What's included:**
- Hezo Connect — centrally hosted mode (connect.hezo.ai):
  - API key system for Hezo instances
  - Account management, usage tracking, billing infrastructure
  - Rate limiting and abuse prevention
- Additional platform OAuth: Gmail, GitLab, Stripe, PostHog, Railway, Vercel, DigitalOcean, X
- Token refresh lifecycle (automatic refresh, expiry detection, board notification)
- Auto-registration of connected platforms as company-level MCP servers
- Agent-initiated OAuth link requests (24-hour validity, board inbox + ticket comment)
- MCP server configuration (company-level + agent-level, merged at runtime)
- Connection lifecycle management (health checks, disconnect, re-authorize)

**How to test:**
- Connect Gmail, Stripe, etc. via OAuth flow
- Token auto-refreshes before expiry
- Expired connection triggers board notification
- Connected platform appears as MCP server for agents

**Depends on:** Phase 9

---

## Phase 11: Deploy + Messaging Integrations

**Goal:** Agents can deploy to staging/production. Slack and Telegram integrations as optional platform interfaces.

**What's included:**
- Staging environment management (auto-deploy on push to main, Neon DB, GitHub Actions)
- Production deployment with `deploy_production` approval gate
- DevOps Engineer activation flow (board sets to active when ready)
- Messaging integrations (all optional):
  - Telegram bot — per-user setup, full platform interface (notifications, approvals, issue creation, agent interaction via commands and inline keyboards)
  - Slack integration — per-company setup, single Slack app with per-agent display names/avatars, interactive messages for approvals, channel-based interaction
  - Notification preferences — per-user, per-channel event type routing
  - `notification_preferences` and `slack_connections` tables
  - Webhook endpoints: `POST /webhooks/slack`, `POST /webhooks/telegram`
- MPP (Machine Payments Protocol): wallet config, `mppx` CLI, autonomous HTTP 402 flow

**How to test:**
- Agent pushes to main — staging auto-deploys
- Production deploy requires board approval — deploy executes after approval
- Link Telegram account — receive notification for pending approval with working deep link
- Approve a request via Telegram inline keyboard — approval reflected in Hezo
- Install Slack app — agent messages appear with distinct names/avatars
- Approve a request via Slack interactive message
- Notification preferences: enable/disable specific event types per channel
- MPP payment flow completes for HTTP 402 responses

**Depends on:** Phase 10

---

## Phase Summary

| Phase | Focus | Key Deliverable |
|-------|-------|----------------|
| 0 | Hezo Connect | Standalone GitHub OAuth relay, independently testable |
| 1 | Foundation | Hono + PGlite + migrations + master key + CLI |
| 2 | Core CRUD | Companies (with types), agents, issues, projects — all via REST |
| 3 | GitHub Integration | OAuth flow, token storage, repo validation and cloning |
| 4 | Agent Execution | Docker per project, subprocesses, heartbeats, worktrees, budgets |
| 5 | Knowledge + Observability | KB, preferences, project docs, audit log, live queries, WebSocket |
| 6 | MCP + Skill File | MCP endpoint at `/mcp`, skill file at `/skill.md` |
| 7 | React Frontend | All UI screens, bundled into single binary |
| 8 | Multi-User Auth + Roles | Better Auth (OAuth), board/member roles, permissions, invites, session compaction |
| 9 | Adapters + Plugins | Gemini/Codex adapters, plugin system |
| 10 | Full Platform Integrations | All OAuth platforms, centrally hosted Connect |
| 11 | Deploy + Messaging | Staging/production pipeline, Slack + Telegram interfaces, notification preferences, MPP |

Each phase produces a testable increment. Phase 0 can be built and verified in isolation. Phases 1–2 give a working API server testable entirely with curl. Phase 4 is where agents first run. Phase 7 adds the visual UI. Phase 8 enables team usage.
