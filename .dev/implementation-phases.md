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

**Status:** Done (2025-03)

**Goal:** A standalone OAuth relay that can handle GitHub OAuth flows. First thing built, independently testable, no dependency on the main Hezo app. Lives in `packages/connect`.

**What's included:**
- Standalone Bun/Hono HTTP server (port 4100 by default)
- 3 endpoints:
  - `GET /health` — returns `{ "ok": true }`
  - `GET /auth/github/start?callback=...&state=...` — redirects to GitHub OAuth consent screen with signed state
  - `GET /auth/github/callback` — exchanges auth code for token, redirects back to caller with token in query params
- Ed25519 state parameter signing for CSRF prevention
- In-memory nonce map for in-flight OAuth flows (no database)
- Token delivery via browser redirect (not server-to-server POST)
- Environment config: `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `STATE_PRIVATE_KEY`

**How to test:**
- `curl localhost:4100/health` returns 200
- Open `localhost:4100/auth/github/start?callback=http://localhost:3000/test&state=...` in browser — redirects to GitHub consent
- After authorizing, browser redirects back to callback URL with `access_token` and `state` params
- Invalid/tampered state params are rejected
- Unit tests for state signing and nonce management

**Depends on:** Nothing

---

## Phase 1: Foundation

**Status:** Done (2025-03)

**Goal:** A running Hono server with an embedded database, migration system, master key, and CLI argument parsing. No business logic yet. Lives in `packages/server` with shared types in `packages/shared`.

**What's included:**
- Hono server (TypeScript)
- PGlite with NodeFS filesystem persistence at `~/.hezo/pgdata`
- Migration runner: loads SQL from bundled archive (via `@hiddentao/zip-json`), tracks in `_migrations` table, runs on startup
- `001_initial_schema.sql` applied on first run
- Build step: compress `migrations/*.sql` into `migrations-bundle.json` via `zip()`, embed in binary
- Master key lifecycle: set via web UI on first login. CLI `--master-key` arg for unlocking only (not setting).
- CLI parsing: `--data-dir`, `--master-key`, `--port`, `--connect-url`, `--connect-api-key`, `--reset`
- `--reset` flag: wipe database and start fresh
- Sensible defaults: port 3100, connect-url `http://localhost:4100`, data-dir `~/.hezo/`
- `GET /health` endpoint
- Test infrastructure: Vitest config, template database pattern, port allocation utility

**How to test:**
- `hezo --port 3100` starts server, master key set via web UI on first login
- `hezo --master-key <key> --port 3100` unlocks and starts
- Wrong master key rejected with error
- `curl localhost:3100/health` returns 200
- PGlite data persists at `~/.hezo/pgdata` between restarts
- `hezo --reset` wipes database and starts fresh
- Migration table shows `001_initial_schema.sql` as applied

**Depends on:** Nothing

---

## Phase 2: Core CRUD

**Status:** Done (2026-04)

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
- Board API authentication: stateless JWT (always authenticated, no local_trusted mode)

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

**Status:** Done (2026-04)

**Goal:** Connect Phase 0 (Hezo Connect) to the main app. OAuth callback, token storage, repo validation.

**What's included:**
- `POST /connections/github/start` — generates auth URL via Hezo Connect
- `GET /oauth/callback` — receives token, encrypts, stores in `connected_platforms`
- Repo CRUD with GitHub access validation (API check with OAuth token before saving)
- Repo cloning via SSH with company-generated SSH key pair (registered on GitHub via OAuth API)
- Company-level folder setup with AGENTS.md in project root
- Board inbox `oauth_request` items when GitHub not connected
- Connected platforms management (connect, disconnect)

**How to test:**
- Start Hezo Connect (Phase 0) on port 4100 and main app on port 3100
- Connect a GitHub account via the OAuth flow
- Add a repo — system validates access via GitHub API
- Invalid repo URL or no access returns clear error
- Repo is cloned via SSH to correct filesystem path
- Token is encrypted in secrets table

**Depends on:** Phase 0, Phase 2

---

## Phase 3.5: UI Foundation + Core Screens

**Status:** Done (2026-04)

**Goal:** A working React frontend for manual browser testing of everything built in Phases 0–3. Uses TanStack Query over REST — no WebSocket or TanStack DB yet.

**What's included:**

Scaffolding:
- `packages/web`: React 19, Vite, TypeScript, TanStack Router (file-based), TanStack Query, Tailwind CSS 4, Radix UI primitives
- Dev proxy: Vite proxies `/api/*` to `http://localhost:3100`
- Shared types imported from `packages/shared`
- Design tokens: color palette, spacing scale, typography
- Base layout: sidebar navigation + main content area
- `bun run dev` starts both server and web in parallel via Turbo

Screens:
- Master key gate — modal when `/api/status` returns `masterKeyState: "unset"` or `"locked"`. Generate new key or enter existing key.
- Company list — card grid, create from company type
- Company workspace — tab layout: Issues, Agents, Projects, Org Chart, KB, Settings
- Issue list — filterable/sortable table with identifier, project, assignee, status, priority
- Issue detail — comments thread, status transitions, assignee/priority/project editing, sub-issues, blocked-by
- Agent list — cards with title, runtime, status, budget usage
- Agent detail / edit / hire — form with title, system prompt, reports_to, runtime, budget; pause/resume/terminate actions
- Org chart — tree visualization from `reports_to` hierarchy with status indicators
- Project list + detail — repos list, filtered issues, add project/repo forms
- GitHub connection — Settings section showing connected platforms, "Connect GitHub" button triggering OAuth flow
- KB docs — list, view with markdown rendering, create/edit
- Settings — secrets vault (list/create/revoke), API keys (list/create/revoke), budget overview, company preferences, project docs, connected platforms
- Board inbox — drawer accessible from any screen (nav badge), pending approvals with approve/deny actions
- Playwright setup with basic smoke tests (master key flow, create company, create issue)

**How to test:**
- `bun run dev` starts server (3100) and Vite (5173)
- Open browser to `localhost:5173` — master key gate appears on first visit
- Create a company from a company type — agents auto-created, visible in Agents tab
- Full CRUD cycle for issues, projects, agents, KB docs, secrets, API keys from the browser
- Connect GitHub via OAuth flow in Settings
- Board inbox shows pending approvals with working approve/deny
- Org chart renders correct hierarchy
- Playwright smoke tests pass

**Depends on:** Phase 3

---

## Phase 4: Agent Execution

**Status:** Done (2026-04)

**Goal:** Agents can actually run. Docker containers per project, subprocesses, heartbeats, worktrees, budget enforcement.

**What's included:**

Backend:
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

UI:
- Agent status indicators (polling via TanStack Query refetch intervals)
- Container status indicators on project cards
- Issue work ownership display — which agent is working, progress indicator
- Cost tracking views — per-agent spend, per-issue spend, per-project spend
- Budget enforcement UI — visual warnings at 80%+ usage, budget adjustment controls
- "Open Preview" link on project detail for dev port forwarding

**How to test:**
- Create a project — Docker container provisioned automatically
- Assign an issue to an agent — agent subprocess starts in project container
- Agent status changes visible in browser (Agents tab, issue detail)
- Multiple agents work on different issues simultaneously (separate worktrees)
- Budget exceeded pauses agent with system comment — warning visible in UI
- Container status visible on project cards in browser
- Cost entries appear as agent works (via polling)
- Container crash detected and reported
- Orphaned work re-queued after failure
- "Open Preview" link opens running project in new tab

**Depends on:** Phase 3.5

---

## Phase 5: Knowledge + Observability

**Status:** Done (2026-04)

**Goal:** KB revisions, audit log, live queries, WebSocket events, live chat, previews. Migrate frontend from polling to real-time.

**What's included:**

Backend:
- Knowledge base revisions, agent proposals, approval flow
- Company preferences revisions, agent-driven updates
- Project-level shared documents (tech spec, implementation plan, research, UI decisions, marketing plan)
- Audit log (append-only, never updated/deleted)
- PGlite live queries for frontend data reactivity (`live.query()`, `live.changes()`)
- WebSocket real-time events (agent lifecycle, container status, live chat)
- Persistent live chat (per-issue, @-mention agents)
- HTML previews (agent writes to workspace volume, served via proxy)
- Structured options (clickable choice cards)

UI:
- WebSocket connection from browser to server
- TanStack DB migration — replace TanStack Query polling with TanStack DB backed by WebSocket row-level diffs for all entity types
- Live Chat panel on issue detail — real-time agent conversation, session persistence across reloads
- Tool call trace rendering — expandable trace blocks in issue comments
- HTML preview rendering — iframe or proxy route for agent-generated previews
- Audit log viewer in Settings
- KB document revision history view
- Project document revision history view
- Real-time updates across all screens — issue status changes, agent lifecycle events, new comments all update without page refresh

**How to test:**
- Open two browser tabs — change in one reflects instantly in the other (no refresh)
- Create KB doc, agent proposes edit, board approves — revision history visible in browser
- Audit log entries viewable for all significant actions
- Tool call traces render inline in issue comments
- WebSocket events fire on agent status changes — UI updates in real-time
- Live chat session with an agent works in real-time, persists across page reloads
- Preview URL serves agent-generated HTML, accessible from project detail
- Structured options render as clickable choice cards

**Depends on:** Phase 4

---

## Phase 6: MCP + Skill File + Binary Build

**Status:** Done (2026-04)

**Goal:** External AI agents can interact with Hezo via MCP. Single self-contained binary with bundled frontend.

**What's included:**

Backend:
- MCP endpoint (Streamable HTTP at `POST /mcp`)
  - All Board API operations exposed as MCP tools
  - Authentication via user JWT or API key
- Skill file at `GET /skill.md`
  - Dynamically generated from registered MCP tool definitions
  - Also committed to repo at `SKILL.md` in the project root

UI + Build:
- `bun build --compile`: bundle `packages/web` static assets into the server binary
- Hono serves the built frontend at `/` (static file serving from embedded assets)
- MCP server configuration UI in Settings (add/remove/edit company-level MCP servers)
- Skill file preview — link or inline display of `/skill.md`
- Full Playwright E2E suite against the compiled binary

**How to test:**
- Connect an MCP client to `localhost:3100/mcp` — tools listed and callable
- Create an issue via MCP `create_issue` tool call — verified in DB and visible in browser
- `curl localhost:3100/skill.md` returns valid Markdown listing all current tools
- API key or JWT auth required for MCP
- MCP servers configurable from Settings in browser
- Build binary with `bun build --compile`, run it, open browser to `localhost:3100` — all screens render from the single binary
- Playwright E2E tests pass against compiled binary

**Depends on:** Phase 5

---

## Phase 6.5: Auth + Session Compaction

**Status:** Done (2026-04)

**Goal:** Custom auth with OAuth login for human board members. Session compaction for agent task continuity. No member roles, invites, or permissions yet — all authenticated users are board members.

**What's included:**

Backend:
- Custom auth implementation:
  - GitHub OAuth login (via Hezo Connect)
  - GitLab OAuth login (via Hezo Connect)
  - Stateless JWTs signed with master key
  - `member_users` table — all users created as `board` role
- Instance admin (first user to sign in)
- Session compaction:
  - `agent_task_sessions` table
  - Per-adapter compaction policies
  - Handoff markdown generation

UI:
- OAuth login page (GitHub + GitLab buttons)
- Account settings page
- First user flow: OAuth login → master key gate → forced company creation

**How to test:**
- Create account via GitHub OAuth, log in, access company as board member — all in browser
- Create account via GitLab OAuth, log in, access company — all in browser
- First user flow: OAuth login → master key gate → forced company creation — all in browser
- Session compaction triggers after token threshold
- Unauthorized requests rejected with 401

**Depends on:** Phase 6

---

## Phase 6.6: UI Redesign + Agent Onboarding

**Status:** Done (2026-04)

**Goal:** Simplify the UI with a company-first navigation model and add agent onboarding via CEO-managed issues.

**What's included:**

Backend:
- `is_internal` boolean on `projects` table — marks auto-created projects
- Auto-create "Operations" project (`is_internal = true`) on company creation
- Prevent deletion of internal projects
- `POST /companies/:companyId/agents/onboard` endpoint — creates agent in disabled state, opens onboarding issue assigned to CEO

Frontend:
- Company icon rail (left sidebar) with home, company avatars, theme switcher, inbox badge
- Unified side menu: Inbox, Issues, Projects, Agents, Org Chart, Knowledge Base, Settings
- Removed top header with breadcrumbs
- Tab-based project view (Issues, Agents, Container, Settings) replacing project sidebar
- Full-page Inbox route for pending approvals
- Agent hire page calls onboard endpoint, redirects to onboarding issue

**Depends on:** Phase 6.5

---

## Phase 6.7: Job Manager + Audit Log Navigation

**Status:** Done (2026-04)

**Goal:** Replace HeartbeatEngine with a general-purpose job manager using cron-async. Add container status sync. Move audit log to dedicated route.

**What's included:**

Backend:
- JobManager class wrapping `cron-async` for independent parallel job scheduling
- Per-job concurrency guards — slow jobs don't block other jobs
- Cancellable long-running tasks via AbortController (e.g. stop a running agent mid-execution)
- Container status sync every 5 seconds — reconciles DB state with actual Docker container state
- Broadcasts container status changes via WebSocket for real-time UI updates
- AbortSignal threading through Docker exec for agent task cancellation

Frontend:
- Audit log moved from Settings page to dedicated route at `/companies/:companyId/audit-log`
- Audit log added as sidebar nav item in the Resources section

**How to test:**
- Restart server when containers are gone — status updates within 5 seconds
- Audit log accessible from sidebar link, no longer embedded in settings page
- Multiple agents run in parallel across different projects, each cancellable independently
- `bun run test` passes (unit, integration, and e2e)

**Depends on:** Phase 6.6

---

## Phase 7: Multi-User Roles + Invites

**Goal:** Member roles with scoped permissions, company email invites, file attachments. Extends Phase 6.5 auth from board-only to multi-role.

**What's included:**

Backend:
- Member roles via `member_users` table:
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
- File attachments (upload, download, issue linking, local storage)

UI:
- Member management UI in Settings (list members, roles, permissions)
- Invite flow UI (create invite, specify role/permissions/project scope)
- Permission-gated navigation — members see only allowed projects, board-only sections hidden

**How to test:**
- Invite a board member — joins with full access, visible in member management UI
- Invite a member with role_title + permissions_text + project_ids — joins with scoped access
- Member can create issue in allowed project via browser
- Member cannot access restricted project (403) — UI hides restricted content
- Member cannot access company settings or agent management (403)
- Agent respects member's permissions_text (e.g. refuses to change PRD when permissions say not to)
- Member cannot create invites (403)

**Depends on:** Phase 6.5

---

## Phase 8: Adapters + Plugins

**Goal:** Non-Claude-Code agent runtimes and the plugin system.

**What's included:**

Backend:
- Gemini adapter (subprocess, Gemini CLI)
- Codex adapter
- Plugin system:
  - Worker thread isolation
  - Capability-gated APIs (state, events, tools, http, secrets, cron)
  - Plugin lifecycle (install, enable, disable, uninstall)
  - Crash recovery with exponential backoff
  - `@hezo/plugin-sdk` package
  - Local plugin loading (filesystem path or git URL)
- Plugin registry (plugins.hezo.ai) out of scope for MVP — plugins are local-only

UI:
- Plugin management UI in Settings (install, enable, disable, uninstall)
- Runtime type selector when hiring agents (Claude Code, Gemini, Codex)

**How to test:**
- Create agent with Gemini runtime via browser — executes via Gemini CLI
- Install a test plugin from Settings UI — runs in worker thread, can read/write state
- Plugin crash is recovered with backoff — status visible in Settings
- Plugin capabilities enforced (unauthorized API access blocked)
- Runtime type selector shows all available adapters when hiring agents in browser

**Depends on:** Phase 7

---

## Phase 9: Full Platform Integrations

**Goal:** Extend Hezo Connect beyond GitHub to all supported platforms. Centrally hosted mode.

**What's included:**

Backend:
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

UI:
- Extended connected platforms UI — all OAuth providers in Settings
- Token refresh status indicators per connection
- MCP server auto-registration display

**How to test:**
- Connect Gmail, Stripe, etc. via OAuth flow in browser
- Token auto-refreshes before expiry — status visible in Settings
- Expired connection triggers board notification — visible in board inbox
- Connected platform appears as MCP server for agents — visible in MCP config UI

**Depends on:** Phase 8

---

## Phase 10: Deploy + Messaging Integrations

**Goal:** Agents can deploy to staging/production. Slack and Telegram integrations as optional platform interfaces.

**What's included:**

Backend:
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

UI:
- Deploy status indicators — staging/production status on project detail
- Staging and production links on project detail
- Notification preferences page — per-user, per-channel event type routing
- Slack connection setup in Settings
- Telegram connection setup in Settings

**How to test:**
- Agent pushes to main — staging auto-deploys, status visible in project detail
- Production deploy requires board approval — approve in browser, deploy executes
- Link Telegram account via Settings — receive notification for pending approval with working deep link
- Approve a request via Telegram inline keyboard — approval reflected in Hezo UI
- Install Slack app via Settings — agent messages appear with distinct names/avatars
- Approve a request via Slack interactive message
- Notification preferences configurable from browser — enable/disable specific event types per channel
- MPP payment flow completes for HTTP 402 responses

**Depends on:** Phase 9

---

## Phase Summary

| Phase | Focus | Key Deliverable |
|-------|-------|----------------|
| 0 | Hezo Connect | Standalone GitHub OAuth relay, independently testable |
| 1 | Foundation | Hono + PGlite + migrations + master key + CLI |
| 2 | Core CRUD | Companies (with types), agents (all 9), issues, projects — all via REST |
| 3 | GitHub Integration | OAuth flow, token storage, repo validation and cloning |
| 3.5 | UI Foundation + Core Screens | React app with all CRUD screens for Phases 0–3 APIs, master key gate, board inbox |
| 4 | Agent Execution + UI | Docker per project, subprocesses, heartbeats, budgets + agent status UI, cost views |
| 5 | Knowledge + Observability + UI | KB revisions, audit log, WebSocket + TanStack DB migration, live chat, real-time updates |
| 6 | MCP + Skill File + Binary Build | MCP endpoint, skill file + `bun build --compile` single binary, Playwright E2E |
| 6.5 | Auth + Session Compaction | Custom OAuth auth (board members only), session compaction + login page, account settings |
| 6.7 | Job Manager + Audit Log Navigation | cron-async job manager, container sync, audit log route |
| 7 | Multi-User Roles + Invites | Member roles, scoped permissions, email invites + member management UI |
| 8 | Adapters + Plugins + UI | Gemini/Codex adapters, plugin system + plugin management UI, runtime selector |
| 9 | Full Platform Integrations + UI | All OAuth platforms, centrally hosted Connect + extended connection UI |
| 10 | Deploy + Messaging + UI | Staging/production pipeline, Slack + Telegram + deploy status, notification preferences |

Each phase produces a testable increment. Phase 0 can be built and verified in isolation. Phases 1–3 give a working API server testable entirely with curl. Phase 3.5 makes everything browser-testable. From Phase 4 onward, every phase includes UI alongside backend so new functionality is always manually testable in the browser.
