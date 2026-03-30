# Hezo — Full Product Specification

> Codename: Hezo. Open-source company orchestration platform.
> Version: MVP spec v2.0
> Date: March 2026

---

## 1. Product overview

Hezo is a self-hosted web application that orchestrates teams of AI agents to run autonomous companies. Each agent plays a defined role (CEO, Product Lead, Architect, Engineer, etc.) and operates inside an isolated Docker container. Human users — **board members** — sit at the top as the board of directors, approving decisions, managing budgets, and steering strategy. Multiple board members can collaborate on the same company.

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
| Base framework | QuickDapp | Single executable binary output |
| Database | PGlite (in-memory Postgres) | Persisted to file on disk |
| Persistence path | `~/.hezo/` by default | Overridable via `--data-dir` CLI arg |
| Migrations | QuickDapp migration runner | Runs on every server startup |
| Encryption | AES-256-GCM | Master key held in memory only |
| Agent containers | Docker Engine API | One container per agent |
| Frontend | React (bundled into binary) | Served by the same process |
| Real-time | WebSocket | Board UI subscribes to company events |
| OAuth gateway | Hezo Connect (self-hosted or connect.hezo.ai) | Handles OAuth flows for GitHub, Gmail, Stripe, etc. |
| Auth | Better Auth | Email/password login, session cookies, multi-user |
| Integrations | 9 platforms via OAuth | GitHub, Gmail, GitLab, Stripe, PostHog, Railway, Vercel, DigitalOcean, X |
| Plugin runtime | Worker threads + dynamic import | TypeScript plugins with capability-gated APIs |
| Plugin registry | plugins.hezo.ai | Centralized discovery, ratings, versioning |

### Master key lifecycle

1. **First startup** (empty DB): server generates a random 256-bit key, displays it in the terminal, asks the user to save it carefully.
2. Server stores a canary value in `system_meta` table: `encrypt("CANARY", master_key)`.
3. Key is held in memory only — never written to disk.
4. **Subsequent startups** (DB has data): server prompts for the key via stdin or `--master-key <key>` CLI arg.
5. Server attempts to decrypt the canary. Wrong key → server refuses to start.

### CLI interface

```
hezo                          # Start server, prompt for master key if DB exists
hezo --data-dir /path/to/dir  # Custom persistence directory
hezo --master-key <key>       # Supply master key as argument
hezo --port 3100              # Custom port (default 3100)
```

---

## 3. Multi-company management

- One Hezo instance supports unlimited companies
- Full data isolation between companies (every entity is company-scoped)
- Home screen shows a card grid of all companies
- Each company card displays: name, mission snippet, agent count, open issue count, budget burn bar
- Click a company card to enter its workspace

### API access for external orchestrators

Hezo can be controlled programmatically by external AI agents (OpenClaw, custom scripts, orchestration layers) via API keys.

**Two auth modes for the Board API:**
- **No key (localhost)** — unauthenticated requests from `localhost`/`127.0.0.1` are allowed. Default for local usage.
- **API key (remote)** — for OpenClaw, AI orchestrators, scripts. Header: `Authorization: Bearer hezo_<key>`. The `hezo_` prefix distinguishes board keys from agent JWTs.

API keys are company-scoped. A key grants full board-level access to that company: create/manage issues, hire agents, approve requests, manage secrets — everything the board UI can do. Keys are stored hashed (bcrypt), shown once at creation, never again. Managed in company settings (generate, revoke, view last-used).

This means an OpenClaw instance or any AI agent with an API key can fully orchestrate a Hezo company: create issues, assign work, approve hires, review agent output, and steer strategy — all via REST.

### Company onboarding flow

When a new company is created, the system automatically:

1. **Creates a full agent team** using the built-in role templates (see `agents/` for full specs):
   - CEO (reports to board)
   - Product Lead (reports to CEO)
   - Architect (reports to CEO)
   - Engineer (reports to Architect)
   - QA Engineer (reports to Architect)
   - UI Designer (reports to Architect)
   - DevOps Engineer (reports to Architect)
   - Marketing Lead (reports to CEO)
   - Researcher (reports to CEO)
2. **Prompts the owner to connect platforms** via OAuth (see Hezo Connect, section 5b):
   - GitHub (required for repo access)
   - Gmail (recommended for agent email)
   - Others optional: Stripe, PostHog, Railway, Vercel, DigitalOcean, X, GitLab
3. **Creates a "Setup" project** with an onboarding issue assigned to the CEO: *"Set up repository access — configure deploy keys for connected GitHub account."*
4. **Provisions Docker containers** for all agents
5. **Creates the `.hezo/{company}/` folder structure** on the host machine

All agent system prompts are pre-filled from templates and editable. The user can delete, modify, or add agents after creation. Connected platforms can be added or removed at any time in company settings.

**Note:** The DevOps Engineer is part of the core team but starts in `idle` status. It does not auto-activate at company creation. The DevOps Engineer activates when the board is ready for staging/production deployment — the board changes its status to `active` when needed.

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

### Company cloning

When creating a new company, the user can choose to **clone from an existing company**. Cloning copies:

- **Knowledge base** — all documents (coding standards, guidelines, etc.)
- **Agent configurations** — titles, role descriptions, system prompts, org chart hierarchy, runtime types, heartbeat intervals, budget allocations
- **MCP server config** — company-level MCP servers
- **MPP config** — wallet config structure (not the actual wallet keys — those must be set up fresh)

Cloning does **not** copy: projects, repos, issues, secrets, connected platforms, cost history, audit log, or API keys. The cloned company starts with a clean operational slate but inherits all the institutional knowledge and team structure. Platform connections must be set up fresh for each company.

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
| Runtime type | `claude_code`, `codex`, `gemini`, `bash`, `http` |
| Heartbeat interval | How often the agent wakes up (default: 60 min) |
| Monthly budget | Hard spending limit in cents |
| Docker base image | Base image for the agent's container |
| MCP servers | Agent-level MCP server list (merged with company-level at runtime) |
| Status | `active`, `idle`, `paused`, `terminated` |

### System prompt templating

The system prompt editor supports variables that are resolved at runtime:

| Variable | Resolves to |
|----------|------------|
| `{{company_name}}` | Company name |
| `{{company_mission}}` | Company mission statement |
| `{{reports_to}}` | Title of the agent's manager |
| `{{project_context}}` | Current project goal + recent issue summaries |
| `{{kb_context}}` | Relevant knowledge base documents (auto-selected based on current task) |
| `{{agent_role}}` | The agent's own title |
| `{{current_date}}` | ISO date at time of resolution |

On agent creation, the UI provides a monospace editor with a toolbar for inserting variables, loading role templates, and Markdown preview support.

### Built-in role templates

Hezo ships with 9 built-in role templates that form the default team. Full specifications for each role are in `agents/{slug}.md`. Users can customize every field. All roles are starting points, not fixed — agents can be added, removed, or reconfigured.

### Ticket workflow

Every feature ticket follows this flow:

```
1. Product Lead → writes product requirements (PRD, acceptance criteria)
2. Architect → adds technical spec, architecture decisions, implementation phases
3. UI Designer → provides design specs / mockups (for UI-related tickets)
4. Engineer → implements, writes tests, updates docs
5. UI Designer → reviews frontend implementation against design specs
6. QA Engineer → reviews and approves (final gate) OR sends back to Engineer
```

No ticket is considered complete until the QA Engineer has approved it. The QA Engineer verifies all tests pass (including Playwright E2E tests for UI), coverage meets targets, and the implementation matches both the Product Lead's acceptance criteria and the UI Designer's design specs.

Feature work uses a **single ticket** for both design and implementation. When a ticket has UI work, the UI Designer creates preview mockups first. Previews appear in the board inbox for approval — board can approve directly or delegate approval to the Product Lead. Only after design approval does the Engineer begin implementation.

**DevOps Engineer** joins the workflow later — when the board is ready for staging or production deployment of the application. DevOps is not involved in the typical feature ticket flow.

**Escalation path:** Engineer ↔ Architect disagreement → CEO mediates → CEO escalates to human board if needed.

### Role summaries

**CEO** — strategic direction, delegation, dispute resolution, escalation to board. Reports to board.

**Product Lead** — owns product requirements. Writes PRDs with acceptance criteria. Opens live chats with the board to clarify ambiguous requirements. Ensures development aligns with company mission. Reports to CEO.

**Architect** — owns technical vision. Adds technical specs, architecture decisions, and implementation phases to tickets after the Product Lead's PRD. Reviews and approves the Engineer's implementation plans. Has technical authority — decides HOW to build things. Reports to CEO. Direct reports: Engineer, QA Engineer, UI Designer, DevOps Engineer.

**Engineer** — primary implementer. Writes code, tests, and documentation based on the Architect's spec. Can live-chat with Product Lead, Architect, or UI Designer during implementation. Reports to Architect.

**QA Engineer** — final approval gate. Reviews every ticket for test coverage (90%+), security, performance, and correctness. Uses Playwright for E2E testing of UI. Sends tickets back to the Engineer if issues are found. Proactively audits the codebase on regular heartbeats. Reports to Architect.

**UI Designer** — owns the visual and interaction layer. Creates HTML preview mockups before implementation. Provides component specs to the Engineer. Reviews the Engineer's frontend implementation for visual accuracy and accessibility. Reports to Architect.

**DevOps Engineer** — owns infrastructure and deployment. Manages staging/production environments, CI/CD pipelines, database migrations. Not part of the typical feature ticket flow — joins when board is ready for deployment. Reports to Architect.

**Marketing Lead** — owns marketing strategy and content. Writes blog posts, social media, changelogs, marketing copy (replaces the need for a separate Content Writer). Reports to CEO.

**Researcher** — conducts competitive analysis, technical research, and feasibility studies. Works with CEO, Architect, UI Designer, and Marketing Lead. Does NOT communicate directly with the Engineer. Reports to CEO.

### CLAUDE.md and company-wide agent rules

The company-level `.claude/CLAUDE.md` file contains rules and conventions that apply to **all agents** in the company. This file is auto-generated during company creation and can be edited by the board or updated by agents (via KB update approval flow).

The CLAUDE.md is the primary mechanism for enforcing engineering standards. It is symlinked into every repo, so every Claude Code session in the company reads it automatically.

Additionally, each agent role has a dedicated **skill file** at `.claude/skills/{role-slug}/SKILL.md` which contains role-specific rules and best practices.

---

## 5a. Engineering rules and testing philosophy

These rules are embedded in the engineer agent's skill file and in the company CLAUDE.md. They apply to **any agent that modifies the codebase** — not just the engineer role.

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

Every repo managed by Hezo has git hooks installed automatically via the `.claude/hooks/` directory. These are non-negotiable — agents cannot bypass them.

**Pre-commit hook:**
1. Run linter on staged files (language-appropriate: ESLint, Ruff, etc.)
2. If lint fails → commit is blocked. Agent must fix lint issues first.

**Pre-push hook:**
Agents run tests locally using the project's test runner directly. This includes the full test suite, lint, build, and any other checks defined in the project's configuration. If any check fails, the push is blocked. The agent fixes the issue immediately and retries. Only after all local checks pass does the push proceed to GitHub. The remote GitHub Actions still runs as a redundant safety check after push.

These hooks ensure that the `main` branch and all remote branches always have passing tests and clean lint. Broken code never reaches GitHub.

**Lint is mandatory.** Every repo must have a linter configured. If a repo is added without one, the engineer agent's first task is to set one up. The linter config lives in the repo (committed), not in `.claude/`.

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

### What goes in CLAUDE.md (company-level)

The auto-generated CLAUDE.md includes:
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

### What goes in skill files (per-role)

Each role's `.claude/skills/{role}/SKILL.md` contains role-specific instructions:
- **Product Lead:** PRD writing methodology, acceptance criteria standards, requirements gathering via live chat, scope management rules
- **Architect:** Technical spec templates, architecture decision records, implementation phase planning, code review authority
- **Engineer:** Parallelization rules, testing philosophy, template database patterns, port allocation, pre-push verification steps
- **QA Engineer:** Audit checklist (security, performance, correctness, maintainability, coverage), Playwright E2E testing, severity classification, flaky test detection
- **UI Designer:** Component conventions, accessibility requirements (WCAG 2.1 AA), design system references, preview mockup standards
- **DevOps Engineer:** Staging/production config, GitHub Actions workflow templates, Neon database management, migration strategies
- **Marketing Lead:** Content writing guidelines, brand voice, social media best practices, release notes templates
- **Researcher:** Research methodology, source evaluation criteria, report templates, competitive analysis frameworks

---

## 5. Agent execution — filesystem and Docker

### Host filesystem layout

All Hezo data lives under `~/.hezo/` on the host machine. The structure mirrors the company → project → repo hierarchy:

```
~/.hezo/
├── hezo.db                              # PGlite database file
├── data/                                # Previews, temp files
│   └── previews/{company_id}/{agent_id}/
│
└── companies/
    ├── acme-corp/                        # Company folder
    │   ├── .claude/                      # Shared Claude Code settings
    │   │   ├── CLAUDE.md                 # Company-wide rules and conventions
    │   │   ├── settings.json             # Claude Code configuration
    │   │   ├── hooks/                    # Pre/post command hooks
    │   │   └── skills/                   # Company-wide skill files
    │   │
    │   ├── projects/
    │   │   ├── backend-api/              # Project folder
    │   │   │   ├── api/                  # Git clone of github.com/org/api
    │   │   │   │   └── .claude → ../../.claude  # Symlink to company .claude
    │   │   │   └── shared-lib/           # Git clone of github.com/org/shared
    │   │   │       └── .claude → ../../.claude  # Symlink to company .claude
    │   │   │
    │   │   └── frontend/                 # Another project
    │   │       ├── web-app/              # Git clone
    │   │       │   └── .claude → ../../.claude
    │   │       └── design-system/        # Git clone
    │   │           └── .claude → ../../.claude
    │   │
    │   └── worktrees/                    # Git worktrees for parallel work
    │       ├── api-feat-auth-agent-123/  # Worktree: repo=api, branch=feat/auth, agent=123
    │       └── api-fix-tests-agent-456/
    │
    └── notegenius/                       # Another company
        ├── .claude/
        ├── projects/
        └── worktrees/
```

**Key design decisions:**

The `.claude/` folder lives at the **company level** and is **symlinked** into every repo clone within that company's projects. This means:
- Claude Code settings, hooks, plugins, and the `CLAUDE.md` rules file are shared across all projects and repos within a company
- These settings are NOT committed to the source code repositories — they're Hezo-managed
- Different companies can have completely different Claude Code configurations
- Updating company-level `.claude/` instantly propagates to all repos

### Git worktrees for parallelism

Repos are cloned once (bare or standard clone in the project folder). When an agent needs to work on a repo, a **git worktree** is created in the company's `worktrees/` folder. This enables:

- Multiple agents working on the same repo simultaneously (different branches)
- The same agent working on multiple branches in parallel via subagents
- No conflicts between concurrent operations on the same repository

Worktree naming convention: `{repo-short-name}-{branch-slug}-agent-{agent-id}`

Worktrees are created on demand when an agent starts work on an issue, and cleaned up when the issue is closed or the agent is reassigned.

### Docker container configuration

Each agent gets its own isolated Docker container. The container mounts the **project folder** from the host as a shared volume.

| Aspect | Configuration |
|--------|-------------|
| Base image | Configurable per agent (default: `node:20-slim`) |
| Mount | Host `~/.hezo/companies/{company}/projects/{project}/` → Container `/workspace/` |
| Worktrees | Host `~/.hezo/companies/{company}/worktrees/` → Container `/worktrees/` |
| `.claude` | Inherited via symlinks in the repo folders |
| Secrets | Injected as environment variables (never written to disk) |
| Connected platforms | OAuth tokens from connected platforms (GitHub, Gmail, etc.) injected. Platform MCP servers available. |
| Previews | `/workspace/.previews/` bind-mounted for HTML preview serving |
| Network | `host.docker.internal:3100` for Agent API access |
| Isolation | Agents cannot see other agents' containers. They can see the same project folder if assigned to the same project. |

### Container lifecycle

| Event | What happens |
|-------|-------------|
| Agent created | Container provisioned from base image. |
| Issue assigned | Worktree created for the repo + branch. Mounted into container. |
| Heartbeat fires | Container is started if stopped. Agent process runs inside it. |
| Heartbeat completes | Container stays running (preserves state for next heartbeat). |
| Agent paused | Container stopped but not removed. |
| Agent resumed | Container restarted. |
| Agent terminated | Container destroyed. Worktrees cleaned up. Agent record kept for audit. |
| Container rebuilt | Old container destroyed, new one provisioned. Agent keeps identity. |
| Issue closed | Worktree cleaned up (merged branch deleted, worktree pruned). |

### Subagents (built-in parallelism)

Agents can use their runtime's native parallelism to speed up work — Claude Code's subagents, Codex's parallel tasks, etc. These are **not** new Hezo agents. They are ephemeral child processes inside the parent agent's container.

Rules:
- Subagents share the parent's budget, container, and secret grants
- Their tool calls are reported under the parent agent's comment
- No approval needed — the parent already has permission
- Hezo does not manage subagent lifecycle — that's the runtime's job
- Subagent costs are debited against the parent agent's budget

### MCP servers (Model Context Protocol)

Agents can connect to MCP servers for tool discovery and external service access. MCP servers are configured at two levels:

**Company-level** — shared by all agents. Configured in company settings. Good for shared infrastructure: team Slack, company database, shared SaaS tools.

**Agent-level** — specific to one agent. Configured in agent settings. Good for role-specific tools: a dev engineer's database access, a Marketing Lead's analytics platform.

At runtime, company-level and agent-level servers are merged. Agent-level takes precedence on name conflicts. The merged list is injected into the agent's container as MCP configuration for the runtime (Claude Code, Codex, etc.) to discover and use.

MCP server config per entry: `{ "name": "...", "url": "...", "description": "..." }`. Stored as JSONB arrays on both `companies` and `agents`.

### MPP (Machine Payments Protocol)

Agents can pay for third-party APIs autonomously using the Stripe/Tempo Machine Payments Protocol. When an agent hits an HTTP 402 response from an MPP-compatible service, it can authorize payment and receive the resource in one round-trip.

**Company-level config:**
- MPP wallet address (Tempo or Stripe)
- Wallet private key stored in the secrets vault (referenced by name, never exposed)
- Default currency (USD, EUR, USDC, etc.)
- Enabled/disabled toggle

**How it works at runtime:**
1. Agent containers have `mppx` CLI pre-installed
2. Wallet credentials are injected as environment variables (same mechanism as secrets)
3. Agent calls a paid API → gets 402 → `mppx` handles payment flow automatically
4. Payment amount is reported as a tool call cost and debited against the agent's budget
5. If budget would be exceeded, payment is blocked and agent is paused

**MPP Payment Directory** — agents can discover 100+ MPP-compatible services (model providers, search APIs, data services, compute platforms) without manual signup or API keys.

MPP costs appear in the same cost tracking dashboard as all other agent spend — per agent, per issue, per project.

---

## 5b. Hezo Connect — OAuth gateway

> Full specification: `connect-spec.md`

Hezo Connect is a standalone backend service that handles OAuth flows on behalf of local Hezo instances. It eliminates the need for each user to register OAuth apps with every provider. Two deployment modes: **self-hosted** (open source, free) or **centrally hosted** (connect.hezo.ai, managed by Hezo project, with billing and API keys).

### Architecture

Two components work together:

**Hezo Connect (remote — e.g. connect.hezo.ai)**
- Hosted service that holds registered OAuth apps for each supported provider
- Handles the OAuth dance: redirects, consent screens, callbacks, token exchange
- Returns tokens to the local Hezo instance, then purges them from memory
- Does NOT store tokens long-term — it is a transient relay
- Open-source — users who want full self-hosting can deploy their own instance and register their own OAuth apps
- The Hezo project runs the canonical instance so most users don't need to do anything

**Hezo app (local)**
- Initiates OAuth flows by redirecting to Hezo Connect
- Receives tokens via callback
- Encrypts and stores tokens in the local secrets vault
- Handles token refresh locally using refresh tokens
- Exposes connected platforms as company-level MCP servers
- Manages connection lifecycle: connect, disconnect, health check, refresh

### OAuth flow

```
1. User clicks "Connect Gmail" in Hezo UI
2. Hezo app redirects to: connect.hezo.ai/auth/gmail/start
     ?callback=http://localhost:3100/oauth/callback
     &state={encrypted_company_id}
3. Hezo Connect redirects user to Google OAuth consent screen
4. User authorizes
5. Google redirects to connect.hezo.ai/auth/gmail/callback
6. Hezo Connect exchanges auth code for access + refresh tokens
7. Hezo Connect POSTs tokens to http://localhost:3100/oauth/callback
8. Hezo app encrypts tokens, stores in secrets vault as:
     GMAIL_ACCESS_TOKEN, GMAIL_REFRESH_TOKEN
9. Hezo Connect purges tokens from memory
10. Hezo app auto-registers Gmail as a company-level MCP server
```

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

GitHub only (MVP). URLs are validated against `github.com/*` patterns. Enforced both at the app layer and via a DB CHECK constraint. GitLab support available via OAuth connection for future use.

### Repo access via GitHub OAuth

Repos are accessed using the company's connected GitHub OAuth token (from Hezo Connect). Git operations use HTTPS with the token:

```
git clone https://x-access-token:{github_token}@github.com/org/repo.git
```

No SSH keys needed — the GitHub OAuth connection provides read/write access to all repos the authorized GitHub account can access. When a new repo URL is added to a project, the system tests access using the OAuth token before saving. If access fails, the repo is rejected with a clear error.

**Prerequisite:** The company must have GitHub connected via Hezo Connect before repos can be added.

### Repos belong to projects

- A project can reference multiple repos
- Each repo within a project has a unique short name (e.g. `frontend`, `api`, `infra`)
- Short names are user-defined at add time
- Short names are used for @-mentioning in issue comments: `@frontend`, `@api`
- Uniqueness is enforced within a project (DB unique constraint)

### What happens when a repo is linked

When a repo is added to a project via the API:

1. Read/write access is validated using the company's GitHub OAuth token
2. The repo is cloned (via HTTPS + token) into `~/.hezo/companies/{company}/projects/{project}/{short_name}/`
3. A symlink is created: `{short_name}/.claude → ../../.claude` (pointing to company-level `.claude/`)
4. Git credential helper is configured in the repo to use the OAuth token for all operations
5. The repo is now available to any agent working on issues in this project

### Agent access to repos

Agents don't configure repos directly. They get access to repos through whichever project their assigned issues belong to. When an agent starts work on an issue, a git worktree is created from the relevant repo clone so the agent can work on its own branch without interfering with other agents.

---

## 7. Goal and project hierarchy

Four-level hierarchy with full goal ancestry:

```
Company Mission
  └── Project Goal
        └── Agent Goal (implicit from assigned issues)
              └── Task / Issue
```

Every issue carries context tracing back to the company mission. Agents always know *what* to do and *why*. The goal chain is visible in the issue detail sidebar.

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
| Assignee | No | Agent assigned to work on it |
| Status | Yes | `backlog`, `open`, `in_progress`, `review`, `blocked`, `done`, `closed`, `cancelled` |
| Priority | Yes | `urgent`, `high`, `medium`, `low` |
| Labels | No | Free-form tags (JSONB array) |
| Parent issue | No | For sub-issues / delegation |
| Number | Auto | Per-company auto-incrementing (atomic) |
| Identifier | Auto | Linear-style: `{prefix}-{number}` (e.g. `ACME-42`). Globally unique. |
| Blocked by | No | Reference to another issue blocking this one |

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
- Goal chain sidebar (mission → project → task)
- Cost for this issue
- Container status of the assigned agent

**Comments tab (default):**
- Threaded conversation between board and agents
- Collapsible trace logs per agent message (tool calls, decisions)

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
| `system` | System | Auto-generated (e.g. "Agent paused — budget limit") |

### Delegation

Agents can create sub-issues and assign them to their direct reports. Delegation is org-chart-enforced — an agent can only assign work downward. Sub-issues inherit the parent's project.

### Agent-to-agent communication

All inter-agent communication happens through @-mentions in issue comments — same as GitHub. No side channels, no direct messaging, no hidden state. Everything is on the record and fully traceable.

An agent can `@architect` or `@engineer` in a comment. The mentioned agent receives a notification on its next heartbeat. The slug for @-mentions is derived from the agent title (lowercased, spaces → hyphens). Slugs are unique within a company.

Repo short names can also be @-mentioned: `@frontend`, `@api` — these reference the repo, not an agent.

Use cases: asking questions, requesting code reviews, escalating blockers, handing off context, coordinating cross-team work. All of it visible in the issue thread.

### Issue assignment triggers

When an issue is assigned to an agent (or reassigned), the agent receives an event trigger on its next heartbeat or immediately via notification.

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
5. On approval, grants are created and secrets are injected as env vars into the agent's container
6. Grants are persistent and auditable
7. Grants can be revoked at any time (agent loses access on next container restart)

### Platform tokens (from Hezo Connect)

OAuth tokens for connected platforms (GitHub, Gmail, Stripe, etc.) are stored as company-scoped secrets with auto-generated names (e.g. `GITHUB_ACCESS_TOKEN`, `GMAIL_REFRESH_TOKEN`). These are managed automatically by the connection lifecycle — agents don't request access to them via the approval flow. They're injected into containers for any agent in the company.

---

## 10. Agent → user interaction

Three mechanisms for agents and the board to interact within issue threads.

### Live chat mode

Every issue has a **persistent live chat** in its Live Chat tab. This is a single, ongoing group conversation — not a series of separate sessions. The assigned agent is always a participant. Board members can @-mention any other agent in the company to pull them into the conversation.

**How it works:**
1. Board member opens the Live Chat tab on any issue
2. The chat is always there — persistent, no "start session" step needed
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

**Storage:**
- Full transcript stored as JSONB array of `{ "author": "board|agent_slug", "text": "...", "timestamp": "..." }` in a `live_chat_sessions` table
- One session per issue (persistent, not per-conversation)
- The assigned agent's ID is always linked to the session

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

Each agent container has a preview directory:
```
Container: /workspace/.previews/
Host:      ~/.hezo/data/previews/{company_id}/{agent_id}/
```

The directory is bind-mounted (read-only from the host side). The web app serves files via a proxy route:
```
GET /preview/{company_id}/{agent_id}/{filename}
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
- Preview directory is read-only from host side — only the agent container can write
- Filenames sanitized — no path traversal
- Board access to company is validated before serving

#### Cleanup

Previews are ephemeral. Auto-deleted after 72 hours, or when the issue is closed, or manually by the agent. A cron task handles expiry.

---

## 11. Cost and budget

### Company-level budget

Each company has a monthly budget cap (`budget_monthly_cents` and `budget_used_cents`). The company budget is the aggregate cap for all agent spending within the company. When company budget is exhausted, all agents in the company are paused.

### Per-agent budgets

- Each agent has a monthly budget in cents (default: $30 / 3000 cents)
- Budget enforcement is atomic: `debit_agent_budget()` row-locks the agent before checking + debiting, and also checks the company-level budget
- At 80% usage → `budget.warning` event emitted, system comment on active issues
- At 100% usage → agent auto-paused, `budget.exceeded` event, system comment posted
- Board can override: adjust budget, resume agent at any time
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

### Board powers

- Pause / resume / terminate any agent at any time
- Override / reassign any issue at any time
- Adjust any agent's budget at any time
- Approve or deny any pending request
- View full audit log
- Delegate specific approval types to agents

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
| `agent.paused` | agent | Board or budget exceeded |
| `agent.resumed` | agent | Board |
| `agent.terminated` | agent | Board |
| `agent.container_rebuilt` | agent | Board |
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
| `plan_review.submitted` | approval | Agent |
| `plan_review.approved` | approval | Board or Product Lead |
| `plan_review.denied` | approval | Board or Product Lead |
| `live_chat.started` | live_chat_session | Board |
| `live_chat.ended` | live_chat_session | Board or agent |
| `company.cloned` | company | Board |
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

### Default

Every agent has a heartbeat interval. Default is **60 minutes**. Configurable per agent (30m, 1h, 2h, 4h, 12h, 24h).

### How heartbeats work

1. On schedule, the system wakes the agent (starts container if stopped)
2. Agent calls `POST /agent-api/heartbeat` to report in and receive pending work
3. Server returns: assigned issues, unread comments, notifications, budget remaining
4. Agent works on its highest-priority issue
5. Agent posts comments, reports tool calls, creates sub-issues as needed
6. Container stays running for next heartbeat

### Event-based triggers

In addition to scheduled heartbeats, agents are triggered by:
- Task assignment (issue assigned to them)
- @-mention in an issue comment
- Option chosen by the board on one of their option cards
- Approval resolved for one of their requests

### Wakeup queue and coalescing

When multiple events fire for the same agent in quick succession (e.g. several @-mentions, assignment + comment), wakeups are coalesced into a single activation. The wakeup queue:

- Batches events within a short coalescing window (default: 10 seconds)
- Delivers all pending events in a single heartbeat response
- Prevents redundant container starts and duplicate work
- Maintains event ordering within the batch

### Issue execution locking

When an agent starts working on an issue, it acquires an execution lock. This prevents:
- The same agent from processing the same issue in parallel (e.g. from overlapping heartbeats)
- Race conditions when multiple events trigger wakeups for the same issue
- Duplicate work on the same ticket

Locks are released when the agent completes its current work cycle or on timeout (configurable, default: 30 minutes).

### Orphan detection and auto-retry

The system monitors for orphaned work — agents that started processing an issue but never completed:

- If an agent holds an execution lock past the timeout, the lock is released and the issue is flagged
- If a container crashes mid-work, the system detects the failure and re-queues the issue for the agent's next heartbeat
- Repeated failures (3+ consecutive) escalate to the board inbox as an agent error
- The system tracks consecutive failure counts per agent per issue

### Persistent state

Agents resume the same task context across heartbeats because their Docker container persists. No cold start, no re-cloning repos, no re-reading context.

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
| `bash` | Output truncation after configurable line limit |
| `http` | Response body truncation, header preservation |

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

## 15. Company knowledge base

Each company has a knowledge base — a collection of Markdown documents that define how things are done across all projects. These are living documents that agents reference and update as the company evolves.

### Purpose

The knowledge base holds company-wide standards and practices:
- Coding standards and conventions
- UX design guidelines
- Architecture decision records
- Company ethos and communication style
- Testing and QA processes
- Deployment and DevOps procedures
- Onboarding guides for new agents

### How it works

Knowledge base documents are `.md` files stored in the database, scoped to a company. Every agent in the company can read them. The knowledge base content is injected into agent context via the `{{kb_context}}` template variable (summaries of relevant docs based on the agent's current task).

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

## 16. Plugin system

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

## 16b. Auth and multi-user

### Overview

Hezo uses **Better Auth** for authentication. Board members sign up with email and password, and access is managed through session cookies.

### Deployment modes

| Mode | Description |
|------|-------------|
| `local_trusted` | Default. No login required. All requests from localhost are treated as board. Suitable for single-user local usage. |
| `authenticated` | Email/password login required. Multiple board members supported. Suitable for team usage or remote access. |

The deployment mode is set via CLI flag (`--auth-mode local_trusted` or `--auth-mode authenticated`) or environment variable. Default is `local_trusted`.

### Board members

In `authenticated` mode:
- Board members sign up with email and password
- All board members have **equal authority** — any board member can take any board action
- Board members are associated with companies via memberships
- A board member can belong to multiple companies
- The first user to sign up becomes the instance admin

### Company memberships

Board members are linked to companies through a `company_memberships` table. A membership grants full board access to that company. Memberships can be:
- Created by any existing board member of the company (invite)
- Revoked by any board member of the company

### Invites

Board members can invite others to join a company:
1. Existing board member creates an invite (email + company)
2. System generates an invite link with a unique token
3. Invite is valid for **7 days**
4. Recipient clicks the link, creates an account (or logs in if they already have one), and joins the company
5. Expired invites must be re-created

### Instance admin

The first user to create an account is the instance admin. The instance admin can:
- Access all companies (regardless of membership)
- Manage the Hezo instance settings
- View system-wide audit log

### Telegram notifications

Board members can connect their Telegram account to receive notifications about board inbox items. This is configured per-user in account settings (not company settings) and is separate from any Slack the company may have connected for agents.

Notifications are sent for:
- Pending approvals
- UI design reviews
- Escalations
- Budget alerts
- Agent errors
- QA critical findings
- OAuth link requests

Each notification includes a deep link back to the relevant item in the Hezo UI.

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

## 17. UX design

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

1. Product Lead writes PRD with acceptance criteria → ticket status: `in_progress`
2. Architect adds technical spec → ticket remains `in_progress`
3. UI Designer creates HTML preview mockups → preview appears in board inbox
4. Board (or delegated Product Lead) approves the design
5. Engineer implements based on approved spec + design
6. UI Designer reviews implementation against design specs
7. QA Engineer reviews and approves → ticket status: `done`

All of this happens within one ticket. The Comments tab shows the conversation flow. The Live Chat tab shows any real-time sessions that occurred during the process.

### Screen inventory

| # | Screen | Purpose |
|---|--------|---------|
| 1 | **Home — Company list** | Card grid of all companies. Stats + budget bar per card. "New" or "Clone" company. Board inbox badge. |
| 2 | **Company workspace — Issues tab** | Default view. Filterable issue list. Every row shows identifier, project tag, assignee, status, priority. |
| 3 | **Issue detail** | Primary work surface. Two tabs: Comments (threaded conversation, traces, goal chain sidebar, quick actions) and Live Chat (session list, inline transcripts). |
| 4 | **Live chat panel** | Side panel or modal. Real-time back-and-forth with assigned agent. On close, session appears in Live Chat tab. |
| 5 | **Company workspace — Agents tab** | Card grid of agents. Runtime, heartbeat, container status, budget bar per card. |
| 6 | **New agent / edit agent** | Form with system prompt editor (monospace, variable chips, role templates), Docker config, reporting line, budget. |
| 7 | **Board inbox** | Drawer accessible from any screen. Pending approvals, design reviews, escalations, budget alerts, agent errors, QA findings, OAuth requests. One-click actionable. Unread badge. |
| 8 | **Company workspace — Org chart tab** | Read-only tree with status indicators. Click node to inspect agent. |
| 9 | **Company workspace — Projects tab** | List of projects with goal, repo count, issue count. Click to see filtered issue list + repo management. |
| 10 | **Company workspace — Knowledge base tab** | List of .md docs with title, last updated, updated by. Click to view/edit. Version history. Board can create docs directly. |
| 11 | **Company workspace — Settings tab** | Company mission editor, connected platforms (OAuth), secrets vault, MCP servers, MPP config, budget overview, audit log viewer, plugin management. |
| 12 | **Account settings** | Profile, password, Telegram notification settings. |

### Navigation structure

```
Home (company list — new or clone)
  └── Company workspace
        ├── Issues (default tab)
        │     └── Issue detail
        │           ├── Comments tab (default)
        │           └── Live Chat tab
        │                 └── Live chat panel
        ├── Agents
        │     └── Agent detail / edit
        │     └── New agent (hire)
        ├── Projects
        │     └── Project detail (repos, filtered issues)
        ├── Org chart
        ├── Knowledge base
        │     └── Document view / edit / version history
        └── Settings
              ├── Mission
              ├── Connected platforms (OAuth)
              ├── Secrets vault
              ├── MCP servers
              ├── MPP config
              ├── Budget overview
              ├── Plugins
              └── Audit log

Board inbox (drawer, accessible from anywhere)
Account settings (accessible from user menu)
```

---

## 18. Data model

### Tables (30+)

| Table | Purpose |
|-------|---------|
| `system_meta` | Key-value store for system config (master key canary) |
| `users` | Board member accounts (email, password hash, admin flag) |
| `companies` | Top-level tenant. Has `mcp_servers` (JSONB), `mpp_config` (JSONB), `budget_monthly_cents`, `budget_used_cents`. |
| `company_memberships` | Links board members to companies |
| `invites` | Pending invitations to join a company (7-day expiry) |
| `api_keys` | Company-scoped API keys for external orchestrators. Stored hashed. |
| `agents` | Roles in the org chart, self-referential `reports_to`. Has `slug` for @-mentions, `mcp_servers` (JSONB). |
| `projects` | Groups of work under a company |
| `repos` | Git repos (GitHub only). Short name for @-mentions. |
| `issues` | Tickets. Must have a project. Per-company auto-incrementing number. Has `identifier`, `blocked_by_issue_id`. |
| `issue_comments` | Thread entries. Polymorphic via `content_type` + `content` JSONB. |
| `issue_attachments` | Links assets to issues (and optionally comments) |
| `tool_calls` | Trace log entries. Linked to a comment. |
| `secrets` | Encrypted key-value. Scoped to company or company+project. |
| `secret_grants` | Links secrets to agents. Revocable. |
| `approvals` | Pending board decisions. Polymorphic payload. |
| `cost_entries` | Immutable spend records. Includes `provider` and `model` fields. |
| `audit_log` | Append-only. Never updated or deleted. |
| `kb_docs` | Knowledge base documents. Markdown, company-scoped, slug-addressable. |
| `kb_doc_revisions` | Version history for KB documents. Full content snapshot per revision. |
| `live_chat_sessions` | Real-time chat transcripts. Linked to issue + agent. |
| `connected_platforms` | OAuth connections to external services (GitHub, Gmail, etc.). Tokens stored in secrets. |
| `company_issue_counters` | Helper for atomic issue numbering. |
| `assets` | Uploaded file metadata (filename, content type, size, storage path). |
| `plugins` | Installed plugins. Config, capabilities, status. |
| `plugin_state` | Key-value storage scoped to a plugin. |
| `agent_sessions` | Per-task session tracking with token usage and compaction state. |
| `wakeup_queue` | Pending agent wakeup events with coalescing. |
| `execution_locks` | Issue execution locks for preventing duplicate work. |

### Enums

```
agent_runtime:        claude_code, codex, gemini, bash, http
agent_status:         active, idle, paused, terminated
container_status:     creating, running, stopped, error
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
deployment_mode:      local_trusted, authenticated
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

## 19. API design

The full API reference is maintained separately. See `api.md` for the complete endpoint reference including request/response shapes.

### Authentication

Three token types:
- **No token (localhost)** — unauthenticated requests from localhost allowed. Default for `local_trusted` mode.
- **Session cookie** — for authenticated board members in `authenticated` mode. Managed by Better Auth.
- **API key (remote orchestrators)** — `Authorization: Bearer hezo_<key>`. Company-scoped, full board access. For OpenClaw, scripts, AI agents controlling Hezo remotely.
- **Agent JWT** — `Authorization: Bearer <jwt>`. Signed with master key. Contains `agent_id` + `company_id`.

### API surfaces

| Surface | Description |
|---------|-------------|
| Board API | Full CRUD for companies, agents, projects, repos, issues, secrets, approvals, KB, connections, plugins, users, etc. |
| Agent API | Heartbeat, context, comments, tool calls, delegation, secret requests, KB proposals, deploy requests. |
| WebSocket | Real-time events for board UI. |

---

## 20. Deferred to V2

| Feature | Notes |
|---------|-------|
| 1Password integration | Replace local encrypted secrets with 1Password Connect Server |
| Portable company templates | Export/import full org structures, agent configs, skills |
| Config versioning with rollback | Revisioned config changes, safe rollback |
| Visual drag-to-reorganize org chart | Interactive reordering of reporting lines |
| Mobile-optimized UX | Responsive but not phone-first in MVP |
| ClipMart / marketplace | Browse and download pre-built company templates |
| External integrations | Asana, Trello, Linear, etc. |
| Bring-your-own-ticket-system | Sync with external issue trackers |

---

## Appendix A: Separate reference files

The following specification details are maintained in separate files:

- **`schema.md`** — Data model design decisions, rationale for table structures, indexing strategy, and migration philosophy
- **`api.md`** — Complete API reference with all endpoints, request/response shapes, query parameters, and WebSocket event types
- **`agents/`** — Full role specifications for each of the 9 built-in agent roles (`ceo.md`, `product-lead.md`, `architect.md`, `engineer.md`, `qa-engineer.md`, `ui-designer.md`, `devops-engineer.md`, `marketing-lead.md`, `researcher.md`)

## Appendix B: Endpoint count

| Surface | Count |
|---------|-------|
| Board API (REST + WS) | See `api.md` for current count |
| Agent API (REST) | See `api.md` for current count |
