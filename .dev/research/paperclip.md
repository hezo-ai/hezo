# Paperclip — Complete Technical Specification

> Reverse-engineered specification of Paperclip v0.3.1, an open-source multi-tenant orchestration platform for AI agent teams.

---

## Table of Contents

1. [Overview & Philosophy](#1-overview--philosophy)
2. [Architecture & Tech Stack](#2-architecture--tech-stack)
3. [Monorepo Structure](#3-monorepo-structure)
4. [Database Schema](#4-database-schema)
5. [API Layer](#5-api-layer)
6. [Authentication & Authorization](#6-authentication--authorization)
7. [Agent System](#7-agent-system)
8. [Heartbeat Engine](#8-heartbeat-engine)
9. [Adapter System](#9-adapter-system)
10. [Session Management & Compaction](#10-session-management--compaction)
11. [Workspace System](#11-workspace-system)
12. [Issue Lifecycle](#12-issue-lifecycle)
13. [Plugin System](#13-plugin-system)
14. [Skills System](#14-skills-system)
15. [Budget & Cost Tracking](#15-budget--cost-tracking)
16. [Real-Time Events](#16-real-time-events)
17. [Security](#17-security)
18. [Storage & File Management](#18-storage--file-management)
19. [Frontend Architecture](#19-frontend-architecture)
20. [CLI Tool](#20-cli-tool)
21. [Deployment & Infrastructure](#21-deployment--infrastructure)
22. [Testing](#22-testing)
23. [Key Constants & Limits](#23-key-constants--limits)

---

## 1. Overview & Philosophy

Paperclip is an **orchestration platform for AI agent teams**. It lets humans ("board users") organize AI agents into companies, assign them tasks via issues, and monitor their autonomous execution. Think of it as a project management tool (Linear/Jira) where the workers are LLM-powered agents.

**Core concepts:**
- **Companies** — organizational containers for agents, projects, and issues
- **Agents** — AI workers powered by LLM adapters (Claude, Codex, Cursor, Gemini, etc.)
- **Issues** — units of work assigned to agents (with full lifecycle: backlog → done)
- **Heartbeats** — discrete execution windows where agents wake up and do work
- **Board users** — humans who oversee agents via the web UI or CLI

**Key design decisions:**
- Agents don't run continuously — they execute in **discrete heartbeat windows**
- Work is coordinated through an **issue-based system** with atomic checkout
- Agent execution is **adapter-based** — same orchestration layer, many LLM runtimes
- **Multi-tenant by default** — companies provide full data isolation
- **Plugin-extensible** via out-of-process workers with capability-gated APIs

---

## 2. Architecture & Tech Stack

| Layer | Technology |
|-------|-----------|
| **Backend** | Node.js 20+, Express 5.1.0, TypeScript 5.7 |
| **Database** | PostgreSQL 17 (embedded in dev via `embedded-postgres`) |
| **ORM** | Drizzle ORM 0.38.4 |
| **Frontend** | React 19, Vite 6.1, Tailwind CSS 4.0, React Router 7.1 |
| **UI Components** | Radix UI primitives with Tailwind styling |
| **State Management** | TanStack React Query 5.90 (server state) |
| **Auth** | Better Auth 1.4.18 (sessions) + custom JWT (agents) |
| **Real-time** | Native WebSocket (`ws` library) |
| **CLI** | Commander.js with `@clack/prompts` |
| **Validation** | Zod (shared schemas) + AJV (JSON Schema for plugins) |
| **Logging** | Pino 9.6 with pino-http |
| **Build** | pnpm workspaces, esbuild (CLI), Vite (UI) |
| **CI/CD** | GitHub Actions |
| **Containerization** | Docker multi-stage builds |

**No external queue system** — job scheduling is in-process. No Redis, no BullMQ. No external search engine — database-level filtering only. No email system. No payment processor — cost tracking only.

---

## 3. Monorepo Structure

```
paperclip/
├── cli/                          # CLI tool (paperclipai npm package)
│   └── src/commands/             # Commander.js subcommands
├── server/                       # Express API server
│   └── src/
│       ├── adapters/             # LLM adapter implementations (10 adapters)
│       ├── auth/                 # Better Auth setup
│       ├── middleware/           # Express middleware (6 files)
│       ├── realtime/             # WebSocket live events
│       ├── routes/               # REST API routes (25+ handlers)
│       ├── secrets/              # Secret provider implementations
│       ├── services/             # Business logic (40+ services)
│       └── storage/              # File storage providers (local, S3)
├── ui/                           # React frontend
│   └── src/
│       ├── adapters/             # Adapter UI components
│       ├── api/                  # API client modules
│       ├── components/           # UI components (Radix-based primitives + domain)
│       ├── context/              # React contexts (theme, company, live updates, etc.)
│       ├── pages/                # Page components (30+)
│       └── plugins/              # Plugin UI integration
├── packages/
│   ├── shared/                   # Zod schemas + shared types
│   ├── db/                       # Drizzle ORM schema + migrations
│   ├── adapter-utils/            # Shared adapter helpers + types
│   ├── adapters/                 # 7 adapter packages (claude, codex, cursor, gemini, opencode, pi, openclaw)
│   └── plugins/                  # Plugin SDK + examples
├── docker/                       # Docker configurations
├── tests/                        # E2E tests (Playwright)
├── scripts/                      # Build/release automation
└── doc/                          # Internal documentation
```

**Package inventory:**

| Package | Name | Purpose |
|---------|------|---------|
| `cli/` | `paperclipai` | CLI binary (npm-published) |
| `server/` | `@paperclipai/server` | API server + embedded DB |
| `ui/` | `@paperclipai/ui` | React frontend (static assets) |
| `packages/db` | `@paperclipai/db` | Drizzle schema, migrations |
| `packages/shared` | `@paperclipai/shared` | Zod types, shared constants |
| `packages/adapter-utils` | `@paperclipai/adapter-utils` | Adapter interface types, session compaction |
| `packages/plugins/sdk` | `@paperclipai/plugin-sdk` | Plugin worker API |
| `packages/adapters/*` | `@paperclipai/adapter-*` | Per-adapter UI/CLI/server modules |

---

## 4. Database Schema

PostgreSQL with Drizzle ORM. ~59 tables organized into domains.

### 4.1 Core Entities

**companies**
| Column | Type | Notes |
|--------|------|-------|
| id | UUID PK | |
| name | text NOT NULL | |
| description | text | |
| status | text | `active`, `archezod`, `paused` |
| pauseReason | text | `manual`, `budget`, `system` |
| issuePrefix | text UNIQUE | Auto-derived from name (e.g., "PAP") |
| issueCounter | integer | Auto-incrementing issue numbers |
| budgetMonthlyCents | integer | Monthly budget cap |
| spentMonthlyCents | integer | Hydrated from cost_events |
| requireBoardApprovalForNewAgents | boolean | Default: true |
| brandColor | text | |
| createdAt, updatedAt | timestamptz | |

**agents**
| Column | Type | Notes |
|--------|------|-------|
| id | UUID PK | |
| companyId | UUID FK→companies | |
| name | text NOT NULL | |
| role | text | `ceo`, `general`, etc. |
| title | text | |
| icon | text | |
| status | text | `idle`, `active`, `paused`, `pending_approval`, `terminated` |
| reportsTo | UUID FK→agents | Self-referential hierarchy |
| adapterType | text | `claude_local`, `codex_local`, `cursor`, `gemini_local`, `opencode_local`, `pi_local`, `process`, `http`, `openclaw_gateway`, `hermes_local` |
| adapterConfig | jsonb | Adapter-specific config (cwd, timeout, env, etc.) |
| runtimeConfig | jsonb | Heartbeat policy, session compaction overrides |
| budgetMonthlyCents | integer | Per-agent budget |
| spentMonthlyCents | integer | Current month spend |
| pauseReason | text | `manual`, `budget`, `system` |
| permissions | jsonb | `{ canCreateAgents: boolean }` |
| lastHeartbeatAt | timestamptz | |
| metadata | jsonb | |
| Indexes | | (companyId, status), (companyId, reportsTo) |

**issues**
| Column | Type | Notes |
|--------|------|-------|
| id | UUID PK | |
| companyId | UUID FK→companies | |
| projectId | UUID FK→projects | |
| parentId | UUID FK→issues | Sub-task hierarchy |
| title | text NOT NULL | |
| description | text | |
| status | text | `backlog`, `todo`, `in_progress`, `in_review`, `blocked`, `done`, `cancelled` |
| priority | text | `low`, `medium`, `high`, `critical` |
| assigneeAgentId | UUID FK→agents | |
| assigneeUserId | text | |
| checkoutRunId | UUID FK→heartbeat_runs | Legacy checkout tracking |
| executionRunId | UUID FK→heartbeat_runs | Current execution lock |
| executionAgentNameKey | text | Agent holding execution lock |
| executionLockedAt | timestamptz | When lock was acquired |
| issueNumber | integer | Per-company auto-increment |
| identifier | text UNIQUE | Format: `{prefix}-{number}` (e.g., "PAP-42") |
| originKind | text | `manual`, `routine_execution`, etc. |
| assigneeAdapterOverrides | jsonb | Per-issue adapter config overrides |
| executionWorkspaceId | UUID FK→execution_workspaces | |
| executionWorkspaceSettings | jsonb | Per-issue workspace strategy |
| requestDepth | integer | Sub-issue nesting depth |
| Indexes | | 8 composite indexes for common query patterns |

### 4.2 Agent Execution

**heartbeat_runs** — One row per agent execution
| Column | Type | Notes |
|--------|------|-------|
| id | UUID PK | |
| companyId, agentId | UUID FKs | |
| invocationSource | text | `timer`, `assignment`, `on_demand`, `automation` |
| triggerDetail | text | `manual`, `ping`, `callback`, `system` |
| status | text | `queued`, `running`, `succeeded`, `failed`, `cancelled`, `timed_out` |
| startedAt, finishedAt | timestamptz | |
| exitCode | integer | Process exit code |
| signal | text | e.g., `SIGTERM` |
| error, errorCode | text | |
| usageJson | jsonb | Token counts, costs, session metadata |
| resultJson | jsonb | Adapter-specific results |
| sessionIdBefore, sessionIdAfter | text | Session tracking |
| logStore, logRef | text | External log storage reference |
| logBytes | bigint | Log size |
| logSha256 | text | Log integrity hash |
| stdoutExcerpt, stderrExcerpt | text | Last 8KB of output |
| processPid | integer | OS process ID |
| contextSnapshot | jsonb | Full context at execution time |
| retryOfRunId | UUID FK→heartbeat_runs | Auto-retry tracking |
| processLossRetryCount | integer | Retry counter for lost processes |

**agent_runtime_state** — Persistent agent state across runs
| Column | Type | Notes |
|--------|------|-------|
| agentId | UUID PK FK→agents | |
| sessionId | text | Current active session |
| totalInputTokens | bigint | Lifetime token usage |
| totalOutputTokens | bigint | |
| totalCostCents | bigint | Lifetime cost |
| lastRunId | UUID | |
| lastRunStatus, lastError | text | |
| stateJson | jsonb | Arbitrary persistent state |

**agent_task_sessions** — Per-task session persistence
| Column | Type | Notes |
|--------|------|-------|
| companyId, agentId, adapterType, taskKey | composite unique | |
| sessionParamsJson | jsonb | Serialized session state |
| sessionDisplayId | text | Human-readable session ID |
| lastRunId | UUID | |
| lastError | text | |

**agent_wakeup_requests** — Wakeup queue
| Column | Type | Notes |
|--------|------|-------|
| id | UUID PK | |
| agentId, companyId | UUIDs | |
| source | text | `timer`, `assignment`, `on_demand`, `automation` |
| status | text | `queued`, `claimed`, `completed`, `failed`, `skipped`, `coalesced`, `deferred_issue_execution`, `cancelled` |
| idempotencyKey | text | Dedup key |
| coalescedCount | integer | Merged wakeup counter |
| payload | jsonb | Wakeup context (issueId, commentId, etc.) |

### 4.3 Projects & Workspaces

**projects** — project containers with optional workspace policies
- id, companyId, name, description, status, leadAgentId, targetDate, executionWorkspacePolicy (jsonb), archezodAt

**project_workspaces** — managed code repositories per project
- id, companyId, projectId, name, sourceType (`local_path`, `git_repo`, `remote`), cwd, repoUrl, repoRef, setupCommand, cleanupCommand, isPrimary

**execution_workspaces** — isolated execution environments per issue
- id, companyId, projectId, sourceIssueId, mode (`shared_workspace`, `isolated_workspace`, `operator_branch`, `adapter_managed`), strategyType (`git_worktree`, `project_primary`), cwd, branchName, providerType (`local_fs`, `ec2`, `k8s`), status, lastUsedAt

### 4.4 Finance & Budgets

**cost_events** — per-LLM-call cost tracking
- id, companyId, agentId, heartbeatRunId, provider, biller, billingType, model, inputTokens, outputTokens, cachedInputTokens, costCents, occurredAt
- Indexes on (companyId, occurredAt), (companyId, agentId, occurredAt), (companyId, provider, occurredAt)

**budget_policies** — budget enforcement rules
- scopeType (`company`, `agent`, `project`), windowKind (`calendar_month_utc`, `lifetime`), amount, warnPercent, thresholdType (`warning`, `hard_stop`)

**budget_incidents** — budget violation records

### 4.5 Authentication & Access Control

**user, session, account, verification** — Better Auth tables (standard schema)

**company_memberships** — multi-tenant access
- companyId, principalType (`user`, `agent`), principalId, status, membershipRole
- Unique: (companyId, principalType, principalId)

**principal_permission_grants** — RBAC
- companyId, principalType, principalId, permissionKey (`agents:create`, `tasks:assign`, etc.)

**instance_user_roles** — instance-level admin
- userId, role (`instance_admin`)

**agent_api_keys** — agent authentication tokens
- agentId, keyHash (SHA-256), revokedAt

**board_api_keys** — board user API keys

**cli_auth_challenges** — CLI login flow challenges

### 4.6 Documents & Assets

**documents** — rich documents (markdown)
- title, format, latestBody, latestRevisionId, latestRevisionNumber

**document_revisions** — version history with changeSummary

**assets** — uploaded files
- provider, objectKey, contentType, byteSize, sha256, originalFilename

**issue_attachments** — join table linking assets to issues

**issue_documents** — join table linking documents to issues with key-based access

### 4.7 Plugins

**plugins** — plugin registry (id, pluginKey, manifestJson, status, config)

**plugin_state** — scoped key-value store with 5-part composite key (pluginId, scopeKind, scopeId, namespace, stateKey)

**plugin_jobs** — cron job declarations (pluginId, jobKey, schedule, status, nextRunAt)

**plugin_entities** — plugin-managed entities

**plugin_webhooks** — webhook handler registration

**plugin_logs** — execution logs

**plugin_company_settings** — per-company plugin configuration

### 4.8 Other Tables

- **routines, routine_triggers, routine_runs** — scheduled recurring tasks
- **goals, project_goals** — OKR-style goal hierarchy
- **approvals, approval_comments, issue_approvals** — approval workflows
- **activity_log** — audit trail (actor, action, entity, details)
- **company_secrets, company_secret_versions** — encrypted secrets
- **company_skills** — skill registry per company
- **company_logos** — branding assets
- **issue_work_products** — external artifacts (GitHub PRs, Linear issues)
- **workspace_operations** — workspace operation history
- **workspace_runtime_services** — runtime service endpoints
- **instance_settings** — deployment configuration
- **invites, join_requests** — user onboarding
- **labels, issue_labels** — issue categorization
- **issue_read_states, issue_inbox_archezos** — notification tracking
- **finance_events** — financial adjustments

---

## 5. API Layer

Express 5.1 REST API with JSON request/response. Base path: `/api`.

### 5.1 Middleware Stack (execution order)

1. `express.json({ limit: "10mb" })` — with raw body capture for webhooks
2. `httpLogger` — Pino HTTP logging (custom log levels: 500+→error, 400+→warn)
3. `privateHostnameGuard()` — blocks unauthorized hostnames in private mode
4. `actorMiddleware()` — extracts user/agent identity from session, JWT, or API key
5. Better Auth handler — `GET /api/auth/get-session`, auth routes
6. LLM routes — adapter documentation endpoints
7. `boardMutationGuard()` — CSRF: validates origin/referer on mutations
8. **API Router** — domain-specific route handlers
9. `errorHandler` — global error handler with HttpError distinction
10. Static UI serving — Vite dev server or static build

### 5.2 Route Inventory

| Domain | Base Path | Key Endpoints |
|--------|-----------|--------------|
| Health | `/api/health` | GET — server status, deployment mode |
| Companies | `/api/companies` | CRUD, export/import, stats |
| Agents | `/api/agents` | CRUD, keys, instructions, org chart, config revisions, test-adapter-environment |
| Projects | `/api/projects` | CRUD, workspace policy |
| Issues | `/api/issues` | CRUD, checkout, comments, attachments, documents, work products, approvals |
| Approvals | `/api/approvals` | List, approve, reject with decision notes |
| Routines | `/api/routines` | CRUD, triggers, manual execution |
| Goals | `/api/goals` | CRUD, hierarchy |
| Skills | `/api/skills` | Sync, project scan |
| Costs | `/api/costs` | Event creation, summary, breakdown by agent/provider/biller/model |
| Activity | `/api/activity` | Audit log query |
| Dashboard | `/api/dashboard` | Aggregate metrics |
| Secrets | `/api/secrets` | CRUD, rotation |
| Plugins | `/api/plugins` | Install, enable, disable, unload, config, UI slots |
| LLMs | `/api/llms` | Adapter documentation, model lists, agent icons |
| Access | `/api/access` | Invites, join requests, membership, permissions |
| Instance Settings | `/api/instance-settings` | Deployment config |
| Execution Workspaces | `/api/execution-workspaces` | Workspace management, cleanup |
| Assets | `/api/assets` | File upload, download |
| Sidebar Badges | `/api/sidebar-badges` | UI notification counts |

### 5.3 Request/Response Patterns

```
POST /api/companies/:companyId/issues
Authorization: Bearer <token>
Content-Type: application/json
X-Paperclip-Run-Id: <run-uuid>    # Optional: links to heartbeat run

{ "title": "...", "assigneeAgentId": "...", "status": "backlog", "priority": "high" }

→ 201 Created
{ "id": "uuid", "identifier": "PAP-42", "companyId": "...", ... }
```

Errors follow: `{ "error": "message", "details": "..." }` with appropriate HTTP status codes.

**Validation**: All request bodies validated via Zod schemas from `@paperclipai/shared`.

---

## 6. Authentication & Authorization

### 6.1 Authentication Methods

**Board Users (UI users):**
- **Better Auth sessions** — email/password login, session cookies
- **Board API keys** — `Authorization: Bearer <key>`, SHA-256 hash stored in DB
- **Local trusted mode** — implicit `local-board` user, no auth required

**Agents:**
- **JWT tokens** — signed with `PAPERCLIP_AGENT_JWT_SECRET`, passed via Bearer header
- **Agent API keys** — SHA-256 hashed, stored in `agent_api_keys`

**CLI:**
- **Auth challenge flow** — CLI requests challenge → user approves in UI → CLI exchanges for session

### 6.2 Actor Resolution

The `actorMiddleware` resolves every request to an actor type:

```typescript
type Actor =
  | { type: "board"; userId: string; isBoardKey: boolean }
  | { type: "agent"; agentId: string; companyId: string; runId?: string }
  | { type: "none" }
```

Resolution order:
1. Check `Authorization: Bearer <token>` header
2. Try agent JWT verification → agent actor
3. Try agent API key hash lookup → agent actor
4. Try board API key hash lookup → board actor
5. Try Better Auth session → board actor
6. In `local_trusted` mode → implicit board actor
7. Otherwise → none actor

### 6.3 Authorization Model

**Company access**: `assertCompanyAccess(req, companyId)` — verifies actor is a member of the company (agents can only access their own company).

**Permission grants**: RBAC via `principal_permission_grants` table:
- `(principalType, principalId, companyId, permissionKey)`
- Permission keys: `agents:create`, `tasks:assign`, `agents:hire`, `agents:pause`, etc.

**Instance admin**: `instance_user_roles.role = 'instance_admin'` bypasses company access checks.

**CEO agents**: automatically get elevated permissions within their company.

### 6.4 Deployment Modes

| Mode | Auth Required | Use Case |
|------|--------------|----------|
| `local_trusted` | No | Development, single-user |
| `authenticated` + `private` | Yes | Private network deployment |
| `authenticated` + `public` | Yes | Public internet (HTTPS enforced) |

---

## 7. Agent System

### 7.1 Agent Lifecycle

```
create → pending_approval → idle ↔ running → error
                              ↕
                           paused
                              ↓
                         terminated (irreversible)
```

- **pending_approval**: Requires board approval if `requireBoardApprovalForNewAgents` is set
- **idle**: Ready for work, waiting for wakeup
- **running**: Currently executing a heartbeat
- **paused**: Manually or budget-paused (with pauseReason)
- **error**: Last run failed
- **terminated**: Permanently stopped, cannot be resumed

### 7.2 Agent Configuration

**adapterConfig** (varies by adapter type):
```json
{
  "cwd": "/path/to/workspace",
  "timeoutSec": 300,
  "graceSec": 15,
  "env": { "CUSTOM_VAR": "value" },
  "args": ["--flag"],
  "promptTemplate": "You are an agent...",
  "model": "claude-sonnet-4-20250514"
}
```

**runtimeConfig** (heartbeat policy):
```json
{
  "heartbeat": {
    "enabled": true,
    "intervalSec": 60,
    "wakeOnAssignment": true,
    "wakeOnOnDemand": true,
    "wakeOnAutomation": true
  },
  "sessionCompaction": {
    "enabled": true,
    "maxSessionRuns": 200,
    "maxRawInputTokens": 2000000,
    "maxSessionAgeHours": 72
  }
}
```

### 7.3 Agent Hierarchy

Agents have a `reportsTo` self-referential FK, creating a management hierarchy. The system supports:
- Org chart visualization
- Chain of command queries (`getChainOfCommand`)
- CEO role at the top of the hierarchy

### 7.4 Agent Instructions

Instructions are delivered to agents via a **bundle system**:

- **Managed mode**: Files stored at `~/.paperclip/companies/{companyId}/agents/{agentId}/instructions/`
- **External mode**: User-configured absolute path
- **Entry file**: `AGENTS.md` (default)
- Recursive file discovery with exclusions (`.git`, `node_modules`, etc.)
- Legacy support for `promptTemplate` and `bootstrapPromptTemplate` in adapterConfig

### 7.5 Config Revisions

Every agent config change is tracked in `agent_config_revisions`:
- Before/after snapshots
- Changed keys list
- Source: `patch`, `rollback`, `import`
- Supports rollback to any previous revision

---

## 8. Heartbeat Engine

The heartbeat system is the **core orchestration engine**. Located in `server/src/services/heartbeat.ts` (~3000 lines).

### 8.1 Execution Model

Agents don't run continuously. They execute in **discrete heartbeat windows**:

1. **Wakeup request** enters the queue (timer, assignment, on-demand, or automation)
2. Request is validated (agent state, budget, policy)
3. Run record created with status `queued`
4. Run is claimed and promoted to `running`
5. Workspace is resolved and provisioned
6. Adapter executes (spawns process, makes HTTP call, etc.)
7. Results are recorded, session state persisted
8. Run finalized as `succeeded`, `failed`, or `timed_out`

### 8.2 Concurrency Control

- **Per-agent lock**: `startLocksByAgent` Map serializes start operations
- **Default concurrency**: 1 run per agent (`HEARTBEAT_MAX_CONCURRENT_RUNS_DEFAULT = 1`)
- **Maximum**: 10 concurrent runs per agent (`HEARTBEAT_MAX_CONCURRENT_RUNS_MAX = 10`)
- **Active tracking**: `activeRunExecutions` Set prevents duplicate starts
- **Process tracking**: `runningProcesses` Map holds live child process handles

### 8.3 Issue Execution Locking

When an agent is woken for an issue, the system prevents multiple agents from working on the same issue simultaneously:

1. `SELECT ... FROM issues WHERE id = ? FOR UPDATE` (row-level lock)
2. Check if `issue.executionRunId` is active:
   - **Same agent**: Merge contexts (coalesce) — prevents duplicate notifications
   - **Different agent**: Defer with status `deferred_issue_execution`
   - **No active run**: Create new run, set `issue.executionRunId`
3. On run completion: `releaseIssueExecutionAndPromote()` clears the lock and promotes deferred wakeups

### 8.4 Wakeup Sources

| Source | Trigger | When |
|--------|---------|------|
| `timer` | Scheduled interval | Agent's `intervalSec` elapsed since last heartbeat |
| `assignment` | Issue assigned | Agent assigned to issue, `wakeOnAssignment` is true |
| `on_demand` | Manual trigger | User clicks "wake" in UI, CLI `heartbeat-run` command |
| `automation` | System event | @-mention in comment, plugin trigger |

Wakeups are **coalesced** — multiple wakeups for the same run are merged by updating the context snapshot rather than creating duplicate runs.

### 8.5 Run Execution Pipeline (detailed)

**Phase 1: Claim & Validation**
- Atomically transition `queued → running`
- Validate agent still exists and is invokable
- Check budget block

**Phase 2: Context Resolution**
- Parse `contextSnapshot` from wakeup request
- Derive `taskKey` from issueId or explicit taskKey
- Fetch issue context if issueId provided
- Apply assignee adapter overrides from issue

**Phase 3: Session Resolution**
- Look up previous task session from `agent_task_sessions`
- Determine if session should be reset (`forceFreshSession`, `issue_assigned` wake reason)
- Recover previous session params or start fresh

**Phase 4: Workspace Realization**
- Resolve workspace source (project primary → task session → agent home)
- Apply execution workspace policy (project-level or issue-level)
- If `git_worktree` strategy: create isolated git worktree with rendered branch name
- Persist execution workspace record in DB

**Phase 5: Session Compaction Decision**
- Evaluate compaction policy (adapter-specific or user override)
- Check thresholds: maxSessionRuns, maxRawInputTokens, maxSessionAgeHours
- If threshold exceeded: set `rotate: true`, generate handoff markdown

**Phase 6: Log Stream Setup**
- Initialize run log store handle
- Wire up `onLog` callback for stdout/stderr capture
- Sanitize output (redact `PAPERCLIP_*` tokens)
- Cap excerpts at 8KB

**Phase 7: Runtime Service Provisioning**
- Spawn services from `config.workspaceRuntime.services`
- Allocate ports, track process lifecycle
- Reuse existing services by `reuseKey`
- Post workspace-ready comment to issue

**Phase 8: Adapter Execution**
- Get adapter from registry
- Create JWT auth token if supported
- Call `adapter.execute(context)` — this runs the LLM process
- Receive `AdapterExecutionResult`

**Phase 9: Post-Execution**
- Resolve next session state (serialize via codec or clear)
- Normalize usage (compute delta for resumed sessions)
- Determine final status: `succeeded` (exit 0), `failed` (non-zero), `timed_out`
- Persist: run status, usage, logs, session state
- Update agent runtime state (cumulative tokens/cost)
- Upsert or clear task session
- Release issue execution lock, promote deferred wakeups
- Finalize agent status (`idle` or `error`)

### 8.6 Orphan Detection & Retry

`reapOrphanedRuns()` runs periodically to detect stuck processes:

1. Find runs with status `running` but no in-memory process handle
2. Check PID liveness via `process.kill(pid, 0)`:
   - `EPERM` = alive but detached → mark as `process_detached`
   - `ESRCH` = dead → proceed to retry
3. Auto-retry: if `processLossRetryCount < 1`, enqueue a retry run
4. Otherwise: mark as `failed`

### 8.7 Timer Tick

`tickTimers()` runs periodically (configurable interval):
1. Fetch all non-paused/terminated agents
2. For each: check if `intervalSec` elapsed since `lastHeartbeatAt`
3. If elapsed: enqueue wakeup with source `timer`
4. Returns telemetry: `{ checked, enqueued, skipped }`

---

## 9. Adapter System

Adapters are the bridge between Paperclip's orchestration and actual LLM execution.

### 9.1 Adapter Interface

```typescript
interface AdapterExecutionContext {
  runId: string;
  agent: { id, companyId, name, adapterType, adapterConfig };
  runtime: { sessionId, sessionParams, sessionDisplayId, taskKey };
  config: ResolvedAdapterConfig;  // With secrets resolved
  context: { paperclipWorkspace, paperclipRuntimeServices, ... };
  onLog: (stream: "stdout"|"stderr", chunk: string) => Promise<void>;
  onMeta?: (meta: AdapterInvocationMeta) => Promise<void>;
  onSpawn?: (meta: { pid, startedAt }) => Promise<void>;
  authToken?: string;  // JWT for agent self-auth
}

interface AdapterExecutionResult {
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  errorMessage?: string;
  errorCode?: string;
  usage?: { inputTokens, outputTokens, cachedInputTokens };
  sessionParams?: Record<string, unknown>;
  sessionDisplayId?: string;
  costUsd?: number;
  billingType?: string;
  resultJson?: Record<string, unknown>;
  clearSession?: boolean;
}
```

### 9.2 Registered Adapters (10 total)

| Adapter | Type | Execution Model |
|---------|------|----------------|
| `claude_local` | Subprocess | Claude Code CLI |
| `codex_local` | Subprocess | OpenAI Codex CLI |
| `cursor` | Subprocess | Cursor IDE CLI |
| `gemini_local` | Subprocess | Gemini CLI |
| `opencode_local` | Subprocess | OpenCode CLI |
| `pi_local` | Subprocess | Pi CLI |
| `hermes_local` | Subprocess | Hermes external adapter |
| `openclaw_gateway` | WebSocket | OpenClaw gateway |
| `process` | Subprocess | Generic shell command |
| `http` | HTTP | External HTTP endpoint |

### 9.3 Process Adapter (Generic)

The `process` adapter is the foundation for most adapters:

1. Resolves command, args, cwd, env from config
2. Calls `onMeta()` with command details (env redacted for logs)
3. Spawns child process via `runChildProcess()`
4. Streams stdout/stderr via `onLog()` callbacks
5. Handles timeout: sends SIGTERM, waits `graceSec` (default 15s), then SIGKILL
6. Returns exit code, signal, timeout flag, stdout/stderr in resultJson

**Environment injection**: Each adapter receives Paperclip-specific env vars:
```
PAPERCLIP_AGENT_ID, PAPERCLIP_COMPANY_ID, PAPERCLIP_RUN_ID
PAPERCLIP_WORKSPACE_CWD, PAPERCLIP_WORKSPACE_BRANCH
PAPERCLIP_ISSUE_ID, PAPERCLIP_ISSUE_IDENTIFIER, PAPERCLIP_ISSUE_TITLE
PAPERCLIP_PROJECT_ID, PAPERCLIP_API_URL, PAPERCLIP_AUTH_TOKEN
```

### 9.4 Session Codec

Each sessioned adapter implements `AdapterSessionCodec`:
```typescript
interface AdapterSessionCodec {
  deserialize(raw: unknown): Record<string, unknown> | null;
  serialize(params: Record<string, unknown> | null): Record<string, unknown> | null;
  getDisplayId?(params: Record<string, unknown> | null): string | null;
}
```

Sessioned adapters: `claude_local`, `codex_local`, `cursor`, `gemini_local`, `opencode_local`, `pi_local`.

### 9.5 HTTP Adapter

For integrating external agent services:
- Config: `url` (required), `method` (default POST), `headers`, `payloadTemplate` (with `{{variable}}` substitution), `timeoutSec`
- Sends HTTP request, returns response as result

---

## 10. Session Management & Compaction

### 10.1 Session Persistence

Sessions are persisted **per task key** in `agent_task_sessions`:
- Task key derived from: issueId, explicit taskKey, or taskId
- Same task key → same session → agent can resume work across heartbeats
- Session params stored as JSON (adapter-specific format)

### 10.2 Session Compaction

Prevents unbounded context growth for adapters that don't manage their own context:

**Policy configuration:**
```typescript
interface SessionCompactionPolicy {
  enabled: boolean;
  maxSessionRuns: number;       // 0 = unlimited
  maxRawInputTokens: number;    // 0 = unlimited
  maxSessionAgeHours: number;   // 0 = unlimited
}
```

**Default policies by adapter:**

| Adapter | Policy | Rationale |
|---------|--------|-----------|
| `claude_local`, `codex_local` | All thresholds = 0 | Native context management confirmed |
| `cursor`, `gemini_local`, `opencode_local`, `pi_local` | 200 runs / 2M tokens / 72h | Default rotation thresholds |
| Others | Disabled | Unknown capabilities |

**Rotation algorithm:**
1. Fetch last N runs for current session
2. Check each threshold
3. If any exceeded: `rotate: true`, generate handoff markdown, clear session ID
4. Agent starts fresh session with handoff context

### 10.3 Usage Normalization

For resumed sessions, raw token counts are cumulative. Paperclip computes deltas:
```
delta = (current >= previous) ? (current - previous) : current
```
This prevents double-counting when sessions span multiple heartbeats.

---

## 11. Workspace System

### 11.1 Workspace Hierarchy

```
Project → Project Workspace (git repo) → Execution Workspace (per-issue isolation)
```

- **Project Workspace**: the source code repository (local path, git repo, or remote)
- **Execution Workspace**: an isolated working copy for a specific issue/task

### 11.2 Execution Workspace Modes

| Mode | Description |
|------|-------------|
| `shared_workspace` | Uses project's primary workspace directly |
| `isolated_workspace` | Creates git worktree per issue |
| `operator_branch` | Operator-managed branch strategy |
| `adapter_managed` | Adapter controls its own workspace |
| `agent_default` | Falls back to agent's configured cwd |

### 11.3 Git Worktree Strategy

When `workspaceStrategy.type === "git_worktree"`:

1. Resolve repo root: `git rev-parse --show-toplevel`
2. Render branch name from template: `{{issue.identifier}}-{{slug}}` (sanitized, max 120 chars)
3. Create worktree: `git worktree add -b {branchName} {worktreePath} {baseRef}`
4. Run provisioning command if configured
5. Execute `provisionCommand` with workspace env vars

**Cleanup** on workspace close:
1. Execute teardown commands
2. `git worktree remove --force {path}`
3. `git branch -d {branchName}`

### 11.4 Runtime Services

Services can be provisioned within workspaces (e.g., dev servers, databases):

- **Lifecycle**: `shared` (reused across runs, 30min idle timeout) or `ephemeral` (per-run)
- **Port allocation**: `net.createServer(0)` for free port discovery
- **Process management**: Spawn, track PID, stream logs
- **Reuse**: Services with same `reuseKey` are shared across runs
- **Env sanitization**: `PAPERCLIP_*` and `DATABASE_URL` stripped from service env

---

## 12. Issue Lifecycle

### 12.1 Status State Machine

```
backlog → todo → in_progress → in_review → done
                      ↕              ↕
                   blocked        cancelled
```

### 12.2 Assignment & Checkout

1. Issue assigned to agent via `assigneeAgentId`
2. If `wakeOnAssignment` is true, wakeup request enqueued
3. Heartbeat picks up the wakeup, acquires execution lock
4. Agent works on the issue during heartbeat window
5. On completion, execution lock is released

### 12.3 Issue Features

- **Sub-tasks**: `parentId` self-referential FK, `requestDepth` tracks nesting
- **Comments**: thread-based with @-mention detection
- **Attachments**: file uploads via multer (max size enforced)
- **Documents**: key-based document storage (e.g., "plan", "progress") with revision tracking
- **Work Products**: external artifacts (GitHub PRs, Linear issues) tracked per issue
- **Labels**: company-scoped labels with color
- **Approvals**: approval gates that can block issue progress
- **Read states**: per-user read tracking for inbox functionality
- **Auto-numbering**: `{issuePrefix}-{issueCounter}` format (e.g., "PAP-42")

---

## 13. Plugin System

A complete **out-of-process plugin architecture** with capability-gated APIs.

### 13.1 Architecture

```
                    ┌─────────────────┐
                    │  Plugin Loader   │
                    └────────┬────────┘
                             │ loads
              ┌──────────────┼──────────────┐
              ▼              ▼              ▼
     ┌────────────┐  ┌────────────┐  ┌────────────┐
     │  Worker 1   │  │  Worker 2   │  │  Worker N   │
     │ (process)   │  │ (process)   │  │ (process)   │
     └──────┬─────┘  └──────┬─────┘  └──────┬─────┘
            │ JSON-RPC (stdio)│               │
     ┌──────┴────────────────┴───────────────┴──────┐
     │              Plugin Worker Manager            │
     │  ┌──────────┐ ┌──────────┐ ┌────────────┐   │
     │  │Tool Reg. │ │Event Bus │ │Job Sched.  │   │
     │  └──────────┘ └──────────┘ └────────────┘   │
     └──────────────────────────────────────────────┘
```

- One child process per plugin (isolation)
- Communication: JSON-RPC 2.0 over stdin/stdout
- Crash recovery: exponential backoff, max 10 consecutive crashes
- Graceful shutdown: 10s drain → SIGTERM → 5s → SIGKILL

### 13.2 Plugin Capabilities

Plugins declare capabilities in their manifest. The host gates API access accordingly:

| Capability | APIs Exposed |
|-----------|-------------|
| `state.read`, `state.write` | Key-value state persistence |
| `events.subscribe`, `events.emit` | Event bus subscription/emission |
| `jobs` | Cron job scheduling |
| `tools` | Tool registration for agents |
| `http` | SSRF-protected outbound HTTP |
| `entities` | Entity CRUD |
| `secrets` | Secret value access |
| `streams` | SSE streaming |
| Various data | Read-only access to companies, agents, issues, projects, goals |

### 13.3 Tool System

Plugins expose tools to agents:

```typescript
interface RegisteredTool {
  pluginId: string;           // e.g., "acme.linear"
  namespacedName: string;     // "acme.linear:search-issues"
  displayName: string;
  description: string;
  parametersSchema: JSONSchema;
}
```

**Flow**: manifest declares tools → registry indexes by namespace → agents query available tools → agent invokes tool → dispatcher routes to worker via RPC.

**Dual indexing**: `byNamespace` Map (O(1) lookup) + `byPlugin` Map (bulk operations).

### 13.4 Event Bus

In-process typed event bus supporting:
- **Domain events**: `issue.created`, `issue.updated`, `agent.created`, etc.
- **Plugin events**: `plugin.{pluginId}.{eventName}`
- **Pattern matching**: exact match or wildcard suffix (`plugin.acme.*`)
- **Filtering**: by companyId, projectId, agentId
- **Error isolation**: one bad handler doesn't crash others

### 13.5 Job Scheduler

Tick-based cron scheduler (default 30-second intervals):
- Max concurrent jobs: 10
- Job timeout: 5 minutes
- Overlap prevention (skips if same job is running)
- Built-in lightweight cron parser (no external dependency)
- Job runs tracked: `queued → running → succeeded/failed`

### 13.6 Plugin SDK

```typescript
import { definePlugin, runWorker } from "@paperclipai/plugin-sdk";

const plugin = definePlugin({
  async setup(ctx: PluginContext) {
    ctx.events.on("issue.created", async (event) => { /* ... */ });
    ctx.jobs.register("sync", async (job) => { /* ... */ });
  }
});

runWorker(plugin, import.meta.url);
```

Full `PluginContext` provides: config, data, state, events, jobs, entities, http, secrets, activity, projects, companies, issues, agents, goals, streams, tools, logger.

---

## 14. Skills System

Skills are reusable instruction packages that augment agent capabilities.

### 14.1 Skill Sources

| Source | Discovery |
|--------|----------|
| `github` | GitHub repository (owner/repo/path) |
| `npm` | npm package |
| `local_path` | Local filesystem directory |
| `url` | Remote HTTP URL |
| `skills_sh` | Skills.sh service |

### 14.2 Skill Metadata

- **Trust levels**: `trusted`, `verified`, `untrusted`
- **Compatibility**: `compatible`, `deprecated`, `experimental`
- **Canonical key**: e.g., `paperclipai/paperclip/skill-name` or `owner/repo/skill-name`

### 14.3 Project Scan

`projectScan()` discovers skills in local project directories by scanning:
- `skills/`, `skills/.curated`
- `.claude/skills`, `.agents/skills`
- Detects `skill.md` manifests

---

## 15. Budget & Cost Tracking

### 15.1 Cost Event Flow

```
Adapter execution completes → usage reported → cost event created
→ agent.spentMonthlyCents updated → company.spentMonthlyCents updated
→ budget policies evaluated → pause scope if threshold exceeded
```

### 15.2 Budget Policies

```typescript
{
  scopeType: "company" | "agent" | "project",
  windowKind: "calendar_month_utc" | "lifetime",
  metric: "billed_cents",
  amount: number,        // Budget limit in cents
  warnPercent: number,   // Warning at this % (e.g., 80)
  thresholdType: "warning" | "hard_stop"
}
```

**Status calculation:**
- `ok`: usage < warnPercent
- `warning`: usage ≥ warnPercent && < 100%
- `hard_stop`: usage ≥ 100% → scope paused, incident created

### 15.3 Budget Enforcement

On `hard_stop`:
1. Pause the scope (agent/project/company) with `pauseReason: "budget"`
2. Create budget incident record
3. Optionally route to approval workflow
4. Scope stays paused until approval or manual resume

### 15.4 Cost Analytics

Multiple aggregation views:
- **By agent**: total cost, tokens, metered vs subscription
- **By provider**: cost per provider/model
- **By biller**: cost per billing service
- **Rolling windows**: 5-hour, 24-hour, 7-day
- **By agent+model**: finest granularity breakdown

---

## 16. Real-Time Events

### 16.1 WebSocket

- **Endpoint**: `/api/companies/:companyId/events/ws`
- **Auth**: Bearer token (agent) or session cookie (board user)
- **Keepalive**: ping/pong every 30 seconds
- **Scope**: company-level subscriptions

### 16.2 Event Types

- Agent status changes
- Heartbeat run updates (started, log chunk, completed)
- Issue updates (created, updated, status changed)
- Activity log events
- Cost tracking events

### 16.3 Frontend Integration

`LiveUpdatesProvider` React context:
- Manages WebSocket lifecycle (connect, reconnect)
- Invalidates React Query cache on events (automatic UI refresh)
- Toast notifications with cooldown (10s window, max 3/window)
- Reconnect suppression (2s debounce)

### 16.4 Plugin Streams

Separate SSE stream bus for plugins:
- Composite key: `${pluginId}:${channel}:${companyId}`
- Pub/sub with auto-cleanup on empty subscriber sets

---

## 17. Security

### 17.1 CSRF Protection

`boardMutationGuard` middleware:
- Validates `Origin` and `Referer` headers for non-safe methods (POST, PATCH, DELETE)
- Trusts localhost and `Host` header-derived origins
- Bypasses for board API keys and local trusted mode

### 17.2 Hostname Validation

`privateHostnameGuard` middleware (private deployment mode):
- Enforces allowed hostname whitelist
- Blocks requests from unauthorized hostnames
- Normalizes IPv6 loopback detection
- Supports `X-Forwarded-Host` header

### 17.3 SSRF Protection

Plugin HTTP fetch validates outbound URLs:
1. Parse URL syntax
2. Enforce protocol whitelist (`http:`, `https:` only)
3. DNS resolution with 5s timeout
4. Block all private IP ranges (RFC 1918, loopback, link-local, IPv4-mapped IPv6)
5. **DNS rebinding prevention**: pin resolved IP into request, include original hostname in Host header

### 17.4 Secrets Management

- **Encrypted storage**: AES encryption with versioning
- **Provider abstraction**: `local_encrypted`, external KMS stubs
- **Secret rotation**: version tracking per secret
- **Agent isolation**: agents access secrets via references, never raw values
- **Environment sanitization**: `sanitizeRuntimeServiceBaseEnv()` strips `PAPERCLIP_*` and `DATABASE_URL`

### 17.5 Input Validation

- All API inputs validated via Zod schemas
- SVG uploads sanitized with DOMPurify
- File upload size limits enforced
- Path traversal prevention: `normalizeRelativeFilePath()` blocks `../`

### 17.6 Storage Isolation

- Company prefix enforcement in object keys: `${companyId}/...`
- Path traversal blocking in storage operations
- Content-type validation on uploads

### 17.7 Agent JWT

- Short-lived tokens signed with `PAPERCLIP_AGENT_JWT_SECRET`
- Contains: agentId, companyId, adapterType, runId
- Used for agent self-authentication back to Paperclip API

---

## 18. Storage & File Management

### 18.1 Storage Providers

| Provider | Use Case |
|----------|----------|
| `local_disk` | Development (files on host filesystem) |
| `s3` | Production (AWS S3 or S3-compatible like MinIO) |

### 18.2 File Organization

Path format: `{companyId}/{namespace}/{year}/{month}/{day}/{uuid}-{sanitizedFilename}`

Namespaces: `issue-attachments`, `documents`, `company-logos`, etc.

### 18.3 Upload Pipeline

1. Multer receives file in memory
2. Content-type validated against allow-list
3. SVG content sanitized with DOMPurify
4. SHA-256 hash computed
5. Stored via provider with generated object key
6. Asset record created in DB

### 18.4 Log Storage

Heartbeat run logs stored externally:
- `logStore`: provider identifier
- `logRef`: object key/path
- `logBytes`, `logSha256`: integrity verification
- `logCompressed`: compression flag
- Async flushing for performance

---

## 19. Frontend Architecture

### 19.1 Technology

React 19 + Vite 6.1 + Tailwind CSS 4.0 + React Router 7.1

### 19.2 State Management

- **Server state**: TanStack React Query (caching, refetching, optimistic updates)
- **App state**: React Context API for cross-cutting concerns:
  - `CompanyContext` — selected company
  - `ThemeContext` — dark/light mode
  - `LiveUpdatesProvider` — WebSocket + cache invalidation
  - `DialogContext` — modal management
  - `ToastContext` — notification system
  - `SidebarContext` — navigation state
  - `PanelContext` — right sidebar panels
  - `BreadcrumbContext` — navigation breadcrumbs

### 19.3 Pages (30+)

Dashboard, Companies, CompanySettings, Agents, AgentDetail, Projects, ProjectDetail, Issues (list/kanban), IssueDetail, Routines, RoutineDetail, Goals, Approvals, Costs, Activity, OrgChart, PluginManager, InstanceSettings, Auth, Inbox, Skills

### 19.4 Component Architecture

- `/components/ui/` — Radix-based primitives (button, card, dialog, select, etc.)
- `/components/` — domain components (AgentProperties, IssueDocumentsSection, etc.)
- `/adapters/` — per-adapter configuration UI
- `/plugins/` — plugin UI slots and launchers

### 19.5 Routing

```
/ (CloudAccessGate → OnboardingWizard)
  /dashboard
  /agents (/all, /active, /paused, /error)
    /:agentId
    /new
  /projects/:projectId
  /issues/:issueId
  /approvals
  /goals
  /routines
  /costs
  /activity
  /org (org chart)
  /skills
  /settings
  /plugins
  /auth
```

### 19.6 Key Libraries

- `lucide-react` — icons
- `react-markdown` + `remark-gfm` — markdown rendering
- `mermaid` — diagram support
- `lexical` / `@mdxeditor/editor` — rich text editing
- `cmdk` — command palette
- `@dnd-kit` — drag-and-drop (kanban boards)

---

## 20. CLI Tool

**Package**: `paperclipai` (npm-published)
**Framework**: Commander.js with `@clack/prompts` for interactive UI
**Build**: esbuild bundled to single executable

### 20.1 Commands

| Command | Purpose |
|---------|---------|
| `run` | Start server (onboard → doctor → start) |
| `onboard` | Interactive first-run setup wizard |
| `doctor` | Diagnostic checks with auto-repair |
| `configure` | Update config sections (llm, database, logging) |
| `env` | Print deployment environment variables |
| `db:backup` | Create database backup |
| `heartbeat-run` | Manually trigger agent wakeup |
| `agent list` | List agents in company |
| `agent hire` | Onboard new agent |
| `issue create` | Create issue programmatically |
| `issue checkout` | Claim issue for agent |
| `company list` | List companies |
| `approval list` | List pending approvals |
| `activity log` | View activity log |
| `dashboard summary` | Show dashboard metrics |
| `plugin list/install/uninstall` | Plugin management |
| `worktree init/env/list` | Multi-instance worktree management |
| `auth bootstrap-ceo` | Generate first admin invite |
| `allowed-hostname` | Add private hostname whitelist entry |
| `context show` | Display loaded context |

### 20.2 Configuration

- Default config: `~/.paperclip/instances/default/config.json`
- Zod-validated JSON config file
- CLI global options: `-c/--config`, `-d/--data-dir`
- Environment override via `.env` files

---

## 21. Deployment & Infrastructure

### 21.1 Docker

Multi-stage build:
1. **deps**: Copy all manifests, `pnpm install --frozen-lockfile`
2. **build**: TypeScript compilation
3. **production**: Node.js slim, non-root user, pre-installed CLIs (claude-code, codex, opencode-ai)

```
ENV PORT=3100
ENV HOST=0.0.0.0
ENV PAPERCLIP_DEPLOYMENT_MODE=authenticated
ENV PAPERCLIP_DEPLOYMENT_EXPOSURE=private
VOLUME /paperclip
USER node
```

### 21.2 Docker Compose

- PostgreSQL 17 Alpine with health checks
- Server depends on DB health
- Volume persistence for `/paperclip`

### 21.3 Environment Variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `DATABASE_URL` | (embedded) | PostgreSQL connection string |
| `PAPERCLIP_HOME` | `~/.paperclip` | Instance data directory |
| `PAPERCLIP_INSTANCE_ID` | `default` | Instance identifier |
| `PAPERCLIP_DEPLOYMENT_MODE` | `local_trusted` | Auth mode |
| `PAPERCLIP_DEPLOYMENT_EXPOSURE` | `private` | Network exposure |
| `PORT` | `3100` | Server port |
| `HOST` | `localhost` | Bind address |
| `BETTER_AUTH_SECRET` | (required in auth mode) | Session signing key |
| `PAPERCLIP_AGENT_JWT_SECRET` | (auto-generated) | Agent JWT signing |
| `PAPERCLIP_PUBLIC_URL` | (derived) | Public URL for auth redirects |
| `PAPERCLIP_SECRETS_PROVIDER` | `local_encrypted` | Secret backend |
| `SERVE_UI` | `true` | Serve embedded UI |
| `PAPERCLIP_LOG_DIR` | `~/.paperclip/logs/` | Log directory |

### 21.4 CI/CD Pipelines

| Workflow | Purpose |
|----------|---------|
| `pr.yml` | TypeScript check, unit tests, build, E2E, canary dry-run |
| `release.yml` | Version bump, changelog, npm publish, GitHub release |
| `docker.yml` | Multi-platform Docker build (amd64/arm64) to ghcr.io |
| `e2e.yml` | Playwright E2E tests |
| `release-smoke.yml` | Post-release smoke tests |
| `refresh-lockfile.yml` | Automated lockfile updates |

**Lockfile policy**: PRs cannot commit lockfile changes. CI validates and regenerates on master.

---

## 22. Testing

### 22.1 Frameworks

- **Unit/Integration**: Vitest (97 test files in `server/src/__tests__/`)
- **E2E**: Playwright (chromium headless)

### 22.2 Test Patterns

- Service tests: `*-service.test.ts`
- Route tests: `*-routes.test.ts`
- Adapter tests: `*-adapter*.test.ts`
- Middleware tests: `*-guard.test.ts`
- Integration: embedded PostgreSQL, Supertest for HTTP

### 22.3 E2E

- Playwright with auto-generated Paperclip config
- Runs against localhost:3100
- Failure artifacts uploaded to CI

---

## 23. Key Constants & Limits

| Constant | Value | Purpose |
|----------|-------|---------|
| `HEARTBEAT_MAX_CONCURRENT_RUNS_DEFAULT` | 1 | Default concurrent runs per agent |
| `HEARTBEAT_MAX_CONCURRENT_RUNS_MAX` | 10 | Maximum concurrent runs per agent |
| `MAX_LIVE_LOG_CHUNK_BYTES` | 8,192 | Live log stream chunk size |
| `MAX_EXCERPT_BYTES` | 8,192 | Max stdout/stderr excerpt |
| `MANAGED_WORKSPACE_GIT_CLONE_TIMEOUT_MS` | 600,000 (10m) | Git clone timeout |
| `DEFAULT_RPC_TIMEOUT_MS` | 30,000 | Plugin RPC timeout |
| `SHUTDOWN_DRAIN_MS` | 10,000 | Plugin graceful drain |
| `SIGTERM_GRACE_MS` | 5,000 | Plugin SIGTERM grace |
| `MAX_CONSECUTIVE_CRASHES` | 10 | Plugin crash limit |
| `CRASH_WINDOW_MS` | 600,000 (10m) | Crash counting window |
| `DEFAULT_TICK_INTERVAL_MS` | 30,000 | Job scheduler tick |
| `DEFAULT_JOB_TIMEOUT_MS` | 300,000 (5m) | Job execution timeout |
| `DEFAULT_MAX_CONCURRENT_JOBS` | 10 | Max concurrent plugin jobs |
| `DEFAULT_SESSION_COMPACTION.maxSessionRuns` | 200 | Session rotation threshold |
| `DEFAULT_SESSION_COMPACTION.maxRawInputTokens` | 2,000,000 | Token rotation threshold |
| `DEFAULT_SESSION_COMPACTION.maxSessionAgeHours` | 72 | Age rotation threshold |
| Process graceful shutdown | 15s | SIGTERM grace before SIGKILL |
| Service idle timeout | 30m | Shared service cleanup |
| JSON body limit | 10MB | Express body parser |
| WebSocket keepalive | 30s | Ping/pong interval |
| Invite TTL | 10m | Company invite expiry |
| Toast cooldown | 10s, max 3/window | UI notification throttle |
| WebSocket reconnect suppression | 2s | Debounce reconnection |
| Branch name max length | 120 chars | Git worktree branch |
| DNS lookup timeout | 5s | SSRF protection |
| Cron search window | 4 years | Safety limit for next tick |

---

## Appendix: Key File Paths

| Area | Path |
|------|------|
| Server entry | `server/src/index.ts` |
| Heartbeat engine | `server/src/services/heartbeat.ts` (~3000 lines) |
| Agent service | `server/src/services/agents.ts` |
| Issue service | `server/src/services/issues.ts` |
| Agent instructions | `server/src/services/agent-instructions.ts` |
| Workspace runtime | `server/src/services/workspace-runtime.ts` |
| Adapter registry | `server/src/adapters/registry.ts` |
| Plugin worker manager | `server/src/services/plugin-worker-manager.ts` |
| Plugin loader | `server/src/services/plugin-loader.ts` |
| Plugin host services | `server/src/services/plugin-host-services.ts` |
| Plugin tool registry | `server/src/services/plugin-tool-registry.ts` |
| Plugin event bus | `server/src/services/plugin-event-bus.ts` |
| Plugin job scheduler | `server/src/services/plugin-job-scheduler.ts` |
| Cost service | `server/src/services/costs.ts` |
| Budget service | `server/src/services/budgets.ts` |
| Company skills | `server/src/services/company-skills.ts` |
| Access control | `server/src/services/access.ts` |
| Live events | `server/src/services/live-events.ts` |
| WebSocket server | `server/src/realtime/live-events-ws.ts` |
| Auth middleware | `server/src/middleware/auth.ts` |
| CSRF guard | `server/src/middleware/board-mutation-guard.ts` |
| Hostname guard | `server/src/middleware/private-hostname-guard.ts` |
| Error handler | `server/src/middleware/error-handler.ts` |
| Storage providers | `server/src/storage/` |
| Secret providers | `server/src/secrets/` |
| DB schema | `packages/db/src/schema/` (59 tables) |
| Shared types | `packages/shared/src/types/` |
| Adapter utils | `packages/adapter-utils/src/` |
| Plugin SDK | `packages/plugins/sdk/` |
| Session compaction | `packages/adapter-utils/src/session-compaction.ts` |
| UI entry | `ui/src/main.tsx` |
| UI app | `ui/src/App.tsx` |
| Live updates context | `ui/src/context/LiveUpdatesProvider.tsx` |
| CLI entry | `cli/src/index.ts` |
| Plugin spec | `doc/plugins/PLUGIN_SPEC.md` |
| Agent runs spec | `doc/spec/agent-runs.md` |
