# Implementation Phases

> Hezo is a large system. This document breaks implementation into ordered phases,
> each delivering a working, testable increment. Later phases build on earlier ones.

---

## Phase 1: Core Server + Agent Orchestration

**Goal:** A working Hezo server that can create companies, manage agents, run heartbeats, and execute work via issue tickets. No OAuth, no Hezo Connect, no deployment pipeline. Agents use manually configured credentials.

**What's included:**
- QuickDapp server with PGlite database
- Master key lifecycle (generate, store canary, verify on startup)
- Schema migration runner (all tables from `schema_migration.sql`)
- Company CRUD (create, update, delete, list, clone)
- Issue prefix + Linear-style identifiers (ACME-42)
- Agent CRUD (hire, update, pause, resume, terminate)
- 9 built-in role templates auto-created on company setup (DevOps starts idle)
- Org chart with reporting lines
- Project + repo management (manual git clone — no OAuth validation yet)
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
- React frontend (bundled into binary):
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
  - Settings page

**What's NOT included:**
- No Hezo Connect / OAuth platform connections
- No multi-user auth (localhost trusted mode only)
- No plugin system
- No Gemini/Codex adapters (Claude Code only)
- No staging/production deployment pipeline
- No file attachments
- No session compaction
- No Telegram notifications
- No MCP server config
- No MPP payments

**Auth:** `local_trusted` mode only — no login required, single user.

**Agent credentials:** Manually configured via secrets vault. Board member adds GitHub tokens, API keys, etc. as secrets and grants them to agents. No OAuth flow.

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

## Phase 4: Hezo Connect + Platform Integrations

**Goal:** Agents can connect to GitHub, Gmail, Stripe, and other platforms via OAuth without manual credential management.

**What's included:**
- Hezo Connect backend (separate open-source service — see `connect-spec.md` for full spec):
  - Self-hosted mode: free, open source, user registers their own OAuth apps
  - Centrally hosted mode (connect.hezo.ai): managed by Hezo project, with billing, API keys, usage limits
  - OAuth app registrations for all supported platforms
  - OAuth dance handling (redirects, consent, callback, token exchange)
  - Token relay to local Hezo instance
  - Token purging after relay (never stored long-term)
- Hezo app integration:
  - OAuth flow initiation (redirect to Hezo Connect)
  - Token receipt and encrypted storage
  - Automatic token refresh (local, no Hezo Connect round-trip)
  - Connection lifecycle (connect, disconnect, health check, refresh)
  - Connected platforms UI in company settings
  - Auto-registration of platforms as MCP servers
  - OAuth link requests in tickets + board inbox (24-hour validity)
- Platform-specific features:
  - GitHub: repo access validation via OAuth token, git credential helper
  - Gmail: agent email send/receive
  - Other platforms: Stripe, PostHog, Railway, Vercel, DigitalOcean, X, GitLab
- MCP server configuration (company-level + agent-level, merged at runtime)

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
| 1 | Core server + agents | Working orchestration platform with Claude Code agents |
| 2 | Auth + sessions | Multi-user, long-running agent support |
| 3 | Adapters + plugins | Gemini support, extensibility |
| 4 | Hezo Connect | OAuth platform integrations |
| 5 | Deploy + notifications | Staging/production pipeline, Telegram |

Each phase produces a usable system. Phase 1 alone is a functional product — a single user can create companies, hire agents, assign work, and watch agents execute via the web UI.
