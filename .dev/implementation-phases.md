# Implementation Phases

> Hezo is a large system. This document breaks implementation into ordered phases,
> each delivering a working, testable increment. Later phases build on earlier ones.

---

## Phase 1: Core Server + Agent Orchestration

**Goal:** A working Hezo server that can create companies, manage agents, run heartbeats, and execute work via issue tickets. Includes Hezo Connect (self-hosted, GitHub only) so that repos can be validated and cloned via OAuth from the start.

**What's included:**
- Hono server (TypeScript) with PGlite (NodeFS filesystem persistence) and live queries
- `bun build --compile` for single executable binary output (cross-platform)
- Master key lifecycle (generate, store canary, verify on startup)
- Migration system with `_migrations` tracking table, numbered SQL files (`001_initial_schema.sql`)
- Company CRUD (create, update, delete, list, clone)
- Issue prefix + Linear-style identifiers (ACME-42)
- Agent CRUD (hire, update, pause, resume, terminate)
- 9 built-in role templates auto-created on company setup (DevOps starts idle)
- Org chart with reporting lines
- Project + repo management with GitHub OAuth validation (see below)
- Issue CRUD with full status state machine (backlog → open → in_progress → review → blocked → done → closed → cancelled)
- Issue comments (text, options, preview, trace, system)
- Sub-issues and delegation (org-chart enforced)
- @-mentions in comments with agent notifications
- Heartbeat engine: wakeup queue, coalescing, timer ticks
- Issue execution locking (SELECT FOR UPDATE)
- Orphan detection and auto-retry
- Agent runtime: `claude_code` adapter (subprocess in company container)
- Company Docker container lifecycle (provision, start, stop, rebuild) + agent subprocess management
- Git worktrees for parallel work
- Host filesystem layout (~/.hezo/)
- Per-agent and per-company budgets with atomic debit
- Cost tracking (per agent, per issue, per project)
- Audit log (append-only)
- Secrets management (AES-256-GCM encryption, grants, approval flow)
- Approval system (secret_access, hire, strategy, plan_review, kb_update)
- Knowledge base (CRUD, agent proposals, revision history)
- Company preferences (board working style, agent-driven updates, revision history)
- Project-level shared documents (tech spec, implementation plan, research, UI decisions, marketing plan)
- Persistent live chat (per-issue, @-mention agents, WebSocket)
- HTML previews (agent writes to shared workspace volume, served via proxy)
- Structured options (clickable choice cards)
- Tool call tracing
- WebSocket real-time events
- PGlite live queries for frontend real-time data reactivity (`live.query()`, `live.changes()`)
- MCP endpoint (Streamable HTTP at `/mcp`) — exposes Hezo operations as MCP tools for external AI agents
- Skill file served at `GET /skill.md` — teaches AI agents how to interact with Hezo
- Hezo Connect server (self-hosted mode, GitHub only):
  - Standalone Bun/Hono HTTP server running alongside the main Hezo app
  - GitHub OAuth flow: initiation, consent redirect, callback with browser redirect
  - State parameter signing (HMAC-SHA256) for CSRF prevention
  - Token delivery via browser redirect (not server-to-server POST)
  - Stateless — no database, in-memory state map for in-flight OAuth nonces
  - Dev GitHub OAuth app setup
- GitHub OAuth integration in the main Hezo app:
  - `POST /connections/github/start` — generate auth URL with signed state
  - `GET /oauth/callback` — receive tokens via query params, encrypt, store
  - `connected_platforms` record creation
  - Repo access validation: test GitHub API access before saving repo
  - Board inbox `oauth_request` items when GitHub not connected
  - Connected platforms UI in company settings
- React frontend (bundled into binary via `bun build --compile`):
  - Company list + creation
  - Issue list + detail (Comments tab + Live Chat tab)
  - Agent list + detail + hire form
  - Org chart view
  - Project + repo management
  - Approval inbox
  - Board inbox (notifications)
  - Knowledge base viewer/editor
  - Company preferences editor
  - Project documents tab (per-project)
  - Secrets vault
  - Cost dashboard
  - Audit log viewer
  - Settings page (including connected platforms)

**What's NOT included:**
- No centrally hosted Hezo Connect (connect.hezo.ai) — self-hosted only
- No non-GitHub platform connections (Gmail, Stripe, etc. — Phase 4)
- No auto-registration of platforms as MCP servers (Phase 4)
- No token refresh lifecycle (Phase 4)
- No agent-initiated OAuth link requests (Phase 4)
- No multi-user auth (localhost trusted mode only)
- No plugin system
- No Gemini/Codex adapters (Claude Code only)
- No staging/production deployment pipeline
- No file attachments
- No session compaction
- No Telegram notifications
- No MPP payments

**Auth:** `local_trusted` mode only — no login required, single user.

**Agent credentials:** GitHub access is handled via OAuth (Hezo Connect). Other credentials (API keys, etc.) are manually configured via the secrets vault.

**Testing:** Vitest for unit/integration, Playwright for E2E. Template database pattern for test isolation.

---

## Phase 2: Multi-User Auth + Session Compaction

**Goal:** Multiple board members can log in, collaborate on the same company, and agents can work on long-running tasks without context window blowup.

**What's included:**
- Better Auth integration (email/password, sessions)
- Login / register pages
- Company memberships (owner, member)
- Invites (email + code, 7-day expiry)
- `authenticated` deployment mode
- Account settings page
- Session management and compaction:
  - `agent_task_sessions` table
  - Per-adapter compaction policies
  - Handoff markdown generation
  - Usage normalization (delta computation)
- File attachments (upload, download, issue linking, local storage)

**Depends on:** Phase 1

---

## Phase 3: More Adapters + Plugin System

**Goal:** Agents can use Gemini (and other runtimes), and the platform is extensible via plugins.

**What's included:**
- Gemini adapter (subprocess, Gemini CLI)
- `bash` adapter refinements
- `http` adapter refinements
- Plugin system:
  - Worker thread isolation
  - Capability-gated APIs (state, events, tools, http, secrets, cron)
  - Plugin lifecycle (install → enable → running ↔ disabled → uninstall)
  - Crash recovery with exponential backoff
  - `@hezo/plugin-sdk` package
  - Local plugin loading (filesystem path)
  - Plugin management UI (install, configure, enable/disable)
- Plugin registry (plugins.hezo.ai):
  - Browse and search
  - Ratings and reviews
  - Download counts, verified publishers
  - Version management
  - Self-hosted registry support (`--plugin-registry-url`)

**Depends on:** Phase 2

---

## Phase 4: Full Platform Integrations

**Goal:** Extend Hezo Connect beyond GitHub to support all platforms, add centrally hosted mode, and enable MCP auto-registration.

**What's included:**
- Hezo Connect — centrally hosted mode (connect.hezo.ai):
  - API key system for Hezo instances
  - Account management (email/password, dashboard)
  - Usage tracking and billing infrastructure
  - Rate limiting and abuse prevention
- Additional platform OAuth support:
  - Gmail: agent email send/receive
  - GitLab: repo access, CI/CD pipelines
  - Stripe: payments, subscriptions, invoices
  - PostHog: analytics queries, feature flags
  - Railway: deploy, environment management
  - Vercel: deployments, domains, env vars
  - DigitalOcean: droplets, databases, apps
  - X (Twitter): post tweets, read timeline
- Token refresh lifecycle:
  - Automatic access token refresh using stored refresh tokens
  - Expired connection detection and board notification
  - Manual refresh endpoint for intervention
- Auto-registration of connected platforms as company-level MCP servers
- Agent-initiated OAuth link requests (24-hour validity, board inbox + ticket comment)
- MCP server configuration (company-level + agent-level, merged at runtime)
- Connection lifecycle management (health checks, disconnect, re-authorize)

**Depends on:** Phase 3

---

## Phase 5: Deployment Pipeline + Notifications

**Goal:** Agents can deploy to staging/production, and board members get notified via Telegram.

**What's included:**
- Staging environment management:
  - Auto-deploy on push to main
  - Neon database for staging
  - GitHub Actions workflow generation
  - Deploy status reporting back to Hezo
- Production deployment:
  - `deploy_production` approval gate
  - Commit diff + staging verification before approval
  - Deploy execution after board approval
- DevOps Engineer activation flow (board sets to active when ready)
- Telegram notifications:
  - Per-user Telegram bot integration
  - Configurable in account settings
  - Notifications for inbox items (approvals, escalations, budget alerts, etc.)
- MPP (Machine Payments Protocol):
  - Wallet config per company
  - `mppx` CLI in company container
  - Autonomous HTTP 402 payment flow
  - Cost tracking integration

**Depends on:** Phase 4

---

## Phase Summary

| Phase | Focus | Key Deliverable |
|-------|-------|----------------|
| 1 | Core server + agents + GitHub OAuth + MCP | Working orchestration platform with Claude Code agents, GitHub repo validation via Hezo Connect, MCP endpoint, and skill file |
| 2 | Auth + sessions | Multi-user, long-running agent support |
| 3 | Adapters + plugins | Gemini support, extensibility |
| 4 | Full platform integrations | All OAuth platforms, centrally hosted Connect, MCP auto-registration |
| 5 | Deploy + notifications | Staging/production pipeline, Telegram |

Each phase produces a usable system. Phase 1 alone is a functional product — a single user can create companies, hire agents, assign work, and watch agents execute via the web UI.
