# Hezo Architecture

The single design reference for Hezo. It describes what the system **does** and how
the pieces fit together — verified against the code in this repo, not a wish-list.

It deliberately **summarizes** rather than reproduces: there is no endpoint-by-endpoint
REST reference and no column-by-column schema here. For the authoritative shapes, read
the code (`packages/shared/src/types/common.ts` for every enum, the route modules under
`packages/server/src/routes/`, the migrations under `packages/server/migrations/`).

- Contributor setup (prerequisites, dev server, test commands) lives in
  [`../.github/CONTRIBUTING.md`](../.github/CONTRIBUTING.md).
- Agent-authoring conventions, testing tiers, and the rules every change must follow
  live in [`../AGENTS.md`](../AGENTS.md). This document gives the *architectural* view;
  `AGENTS.md` gives the *rules*. Where they overlap, `AGENTS.md` is authoritative for
  "how to write code here" and this doc cross-references it instead of duplicating.

When the code changes, change this doc to match — describe the current state, never a
changelog.

---

## 1. System overview & product model

Hezo is a **self-hosted web application that orchestrates teams of AI agents**. Each
agent plays a defined role (Captain, Engineer, Architect, …) and runs as a headless CLI
process inside the project's Docker container. Humans sit on top as **board members**,
steering strategy, approving decisions, and managing budgets. The primary surface is a
**task tracker**: agents receive work as tickets, report progress in threaded comments,
and surface options/previews/approvals to the board.

Hezo ships as a **single self-contained binary** — no external database, no cloud
account. One instance hosts multiple teams with full data isolation.

**What Hezo is:** an org-chart and governance layer for agents; a task tracker where
agents do the work; a cost-control system with per-agent and per-project budgets; an
observability layer with full tool-call tracing.

**What Hezo is not:** a chatbot (agents have jobs, not chat windows), an agent framework
(it orchestrates agents, it doesn't build them), a workflow builder, or a prompt
manager (agents bring their own models and runtimes).

---

## 2. Tech stack & monorepo layout

| Layer | Choice |
|---|---|
| Server | Hono (TypeScript) on the **Bun** runtime |
| Binary | `bun build --compile` → one cross-platform executable |
| Database | **PGlite** (embedded Postgres, in-process) + **pgvector**, persisted to `~/.hezo/pgdata` |
| Frontend | React 19 + TanStack Router + TanStack Query, Tailwind + Radix UI; bundled into the binary |
| Realtime | WebSocket row-change events → client invalidates React Query keys |
| Agent interface | MCP (Streamable HTTP) at `POST /mcp` via `@modelcontextprotocol/sdk` |
| Crypto | AES-256-GCM at rest; master key held in memory only |
| Containers | Docker Engine API, one container per project |

**Monorepo** — Bun workspaces + Turborepo. **Three** packages plus a root `agents/`
tree:

```
packages/
├── server/   # Hono + PGlite + MCP backend; compiles to the binary (embeds web)
├── web/      # React frontend, bundled into the server binary at build time
└── shared/   # Shared enums, types, crypto, pricing, mention parsing (@hezo/shared)
agents/       # Agent system-prompt markdown — the source of truth for seeded roles
```

- **`packages/shared`** (`@hezo/shared`) is the home of every cross-cutting enum and
  type (`src/types/common.ts`), the provider→runtime maps, BIP39/HKDF crypto helpers,
  budget/pricing math, and mention parsing. Add new status/type values here first —
  no raw status strings in `server`/`web` (see `AGENTS.md` › Conventions).
- **`packages/server`** imports from `shared` and embeds `web` at build time.
- **`agents/`** holds role prose by team template (`software-development/`, `blank/`),
  the two instance roles (`_instance/ceo.md`, `_instance/coach.md`), and reusable
  `_partials/`. The build bakes these into `agents-bundle.json`; the DB seed reads them
  at startup. See `AGENTS.md` › Layout for which layer (`SHARED_INSTRUCTIONS`, a
  `_partial`, or a role `.md`) new guidance belongs in.

---

## 3. Data model (distilled)

PGlite holds ~50 tables. They group by domain; the load-bearing **design decisions**
matter more than the column lists.

**Identity & membership.** A unified **`members`** base table is the single identity for
every team participant, discriminated by `member_type` (`agent` | `user`). `members.id`
*is* the agent/user-in-team id — every assignee/author/actor FK points at it, no
secondary keys. Two extension tables hang off it: `member_agents` (system prompt,
runtime/effort, budgets, heartbeat, org chart, `touches_code`, optional
`model_override_*`) and `member_users` (role, `role_title`, `permissions_text`,
`project_ids`). Global human identity lives in `users` + `user_auth_methods` (OAuth
login links — no password, no email column).

**Teams, templates, projects.** `teams` is the tenant; a **project owns exactly one
team** (`projects.team_id → teams.id`, `UNIQUE` — the 1:1 invariant in § 4). `agent_types`
is a first-class catalog of role templates (built-in + custom); `team_templates` +
`team_template_agent_types` define team "recipes" (which roles, the org chart via
`reports_to_slug`, per-template config overrides). `projects` carries `task_prefix`,
container config, dev ports, the designated repo, and `is_internal` (only HQ).

**Repos.** `repos` stores a GitHub `owner/repo` identifier; the segment after the owner
is the display label, worktree directory name, and `@mention` handle. The **first** repo
linked to a project becomes its immutable `designated_repo_id` (`ON DELETE RESTRICT` +
a 409 `DESIGNATED_REPO_IMMUTABLE` guard).

**Tasks & threads.** `tasks` are Linear-style tickets with a frozen `identifier`
(`<task_prefix>-<n>`, e.g. `IN-42`), a required `assignee_id → members.id`, `rules`, and
an agent-maintained `progress_summary`. Numbering is atomic via `project_task_counters`.
`task_dependencies` is the many-to-many blocking graph (`UNIQUE`, no self-blocks).
`task_comments` is **polymorphic** over a `content_type` enum + `content` JSONB — `text`,
`system` (timeline entries like `status_change`/`task_link`), `execution` (auto-written
on run completion), `preview`, `action`,
`connect_required`, `credential_request`. Each comment carries a `public_id` slug for
`#comment-<id>` deep-links and a `vector(384)` embedding (text comments only) for
semantic search. `comment_reactions` holds emoji reactions.

**Secrets, OAuth, MCP connectors.** `secrets` stores AES-256-GCM ciphertext gated by
`allowed_hosts` (§ 7). `oauth_connections` records connected GitHub/SaaS accounts; their
tokens *ride the `secrets` table* (no token column). `mcp_connections` is the catalog of
SaaS/local MCP servers injected into runs (§ 9). All three use the same
**nullable-`team_id` + partial-unique-index** pattern: `team_id NULL` = an instance-level
row shared across teams; the run-time loader resolves the most specific scope on a name
clash (**project > team > instance**). `team_ssh_keys` is the exception — one Ed25519 key
**per project**, encrypted on the backing team row, never in the vault (§ 8).

**Runs, wakeups, sessions.** `agent_wakeup_requests` is the trigger queue, with
idempotency keys and `coalesced_count` merging (§ 5). `heartbeat_runs` is one row per
execution (status, timing, tokens, cost, captured logs, `wakeup_id` provenance, the
success-gate flags `produced_output`/`reported_no_work`). Token usage is flushed to the
row *during* the run (alongside the log), so a run the server kills mid-flight still
reports the tokens/cost it burned instead of `0`; `usage_partial` flags such a snapshot
until a clean completion supersedes it. `agent_task_sessions` persists
per-task session state for compaction across heartbeats. `ceo_sessions` /
`ceo_conversations` / `ceo_messages` back the live CEO chat (§ 4).

**Costs & budgets.** `cost_entries` is the immutable per-run spend ledger, attributed to
the AI provider config that produced it — **never** team-scoped. `model_pricing` holds
per-model token rates (a bundled LiteLLM snapshot refreshed from the public feed, with
`source='manual'` operator overrides winning). Budgets are **windowed and computed on
demand**: limits live as `daily_/weekly_/monthly_budget_cents` on `member_agents` and
`projects` (0 = unlimited; there is **no team budget**), and spend is summed from
`cost_entries` over rolling UTC windows — no counter, no reset event (§ 5). A run killed
mid-flight never reaches the run-completion cost record, so `reconcileOnStartup` charges
its surviving partial `cost_cents` on reboot (shared `recordRunCostAndEnforce`) — an
interrupted run still counts against budgets.

**Docs, skills, assets.** `documents` is one table backing three Markdown kinds by
`type` (`project_doc`, `team_preferences`, `agent_system_prompt`), each with partial
unique scoping and full revision history in `document_revisions`. `skills` is the
instance/team reference store (manifest-injected into runs, semantic-searchable) with
`skill_revisions` history. `assets` + `task_attachments`/`comment_attachments` handle
uploaded files (bytes on local disk, served over HMAC-signed URLs).

**Governance & misc.** `approvals` (polymorphic board decisions), `audit_log`
(append-only, project + instance scopes — `project_id` set scopes a row to one project,
NULL marks an instance-level action; never updated/deleted by the app),
`api_keys` (bcrypt-hashed, `hezo_` prefix), `connected_agents` (external MCP clients —
self-registered, admin-approved, `hezoc_` prefix), `invites`, `admin_mentions` (board inbox),
`instance_user_roles`, `notification_preferences`. `plugins`/`plugin_state`/`plugin_jobs`
are scaffolding for a future plugin runtime — present but not yet exercised.

**Actor attribution (human vs connected agent).** Every recorded admin action carries who
took it so the UI can flag human vs automated. `audit_actor_type` is
`admin | agent | system | connected_agent`; alongside the existing `actor_member_id` /
`author_member_id` foreign keys, `audit_log`, `task_comments`, and `document_revisions` each
carry a parallel nullable `actor_connected_agent_id` / `author_connected_agent_id` FK (at
most one of the two is set per row). `resolveActor` maps a `ConnectedAgent` principal to the
`connected_agent` actor type + id, threaded through task events, the audit observer, and the
document service. The web surfaces (task activity feed, audit-log table, document revision
history) render a small badge via the shared `ActorBadge` — a person icon for a human admin,
a bot icon for a connected agent (tooltip naming it). Roster agents and `system` actors are
not badged; inline `@admin` mentions in comment bodies are rendered plainly (not an action).

> The migrations are the source of truth for the live schema. Tables an older draft of
> the docs mentioned — `connected_platforms`, `secret_grants`, `slack_connections` — do
> **not** exist; OAuth is `oauth_connections`, and secret access is gated by
> `allowed_hosts`, not per-agent grants.

---

## 4. Project / team / agent model

Hezo is **project-centric**: a project is the primary unit and **owns exactly one team**
(its agent roster). The relationship is **1:1**, enforced by `UNIQUE(projects.team_id)` —
a team backs exactly one project. Conceptually "teams belong to projects." Everything is
addressed by **project slug** (`/api/projects/:projectId/...`); a team is reached *through*
its project. There is no team-addressed API for project work, and no per-team "internal"
project.

**HQ — the one cross-project team.** A single instance-level team, **HQ** (slug
`default`), owns the only `is_internal` project. It hosts two instance-level singletons:

- **CEO** — runs all coordination. **Project intake** and first-run **onboarding**
  (pre-project) live in HQ. Per-team **setup/coherence review**, **hiring**, and
  **retiring** concern a specific project-team and live in *that team's own project*,
  CEO-actioned. Retiring/reinstating an agent is the `set_agent_status` MCP tool (gated to
  the team's Captain or an HQ coordinator), which runs the same `setAgentAdminStatus`
  service as the REST disable/enable routes — it can't disable a Captain or an instance
  agent. On a new team the CEO's initial coherence pass runs first and **blocks** the
  Captain's planning task.
- **Coach** — reviews completed tickets across **every** project to improve agent system
  prompts; woken on any task completion.

HQ also exposes the standard **assets library** — the one internal-project surface that
isn't hidden in the UI (Budget/Settings still are). Files the CEO produces for the operator
in the live chat (a quick mockup, demo, or export) are saved via `write_project_asset` and
linked back as `assets/<filename>`, so they are durable and openable over a signed URL rather
than stranded as loose files in the container's `/workspace`. The CEO scopes such a
deliverable (and any `write_project_doc` markdown) to **the project the work belongs to**,
falling back to HQ only for work tied to no project; HQ's chat memory (`chat-memory.md`) also
carries a rough running summary of those off-project conversations, since they live nowhere
else once the chat window scrolls.

**Project teams** are provisioned from a team-type template (default **Blank** = Captain
only; `software-development` = Captain + 9 worker roles). Templates never include the
CEO/Coach. The roster prose lives in `agents/<template>/`, the instance roles in
`agents/_instance/`, and shared snippets in `agents/_partials/`.

**Cross-team execution (the run-team split).** CEO/Coach are HQ members but act inside
other teams' projects. A run is scoped to the **task's project team** ("run team") — JWT,
`HEZO_TEAM_ID`, MCP, skills, git identity, container — while the agent's **system prompt**
loads from its **home** team (HQ). For an ordinary agent the two coincide. Auth needs no
membership check: the agent JWT is validated against the `heartbeat_runs` row
`(run_id, member_id, team_id)`, so an HQ member legitimately operates run-team-scoped.

**Creation flows (two, both superuser).** Both share one service —
`createProjectWithTeam` in `services/project-create.ts` — which resolves the team-type
template, stands up the team + roster, creates the project, seeds the initial CEO
coherence task (it takes the first identifier) ahead of the Captain's planning task
(blocked on coherence), wakes the Captain, and provisions the container.
1. **Direct** — `POST /api/projects`: runs `createProjectWithTeam` in one step. No
   approval gate.
2. **CEO-assisted** — `POST /api/project-intakes`: opens a CEO-run intake conversation
   ticket in HQ (label `project-intake`) recording the form data and the admin's chosen
   team type as the CEO's **baseline suggestion**. **Nothing is created up front — no
   team, no project, no approval.** The CEO scopes the work with the admin; when the
   admin approves in the thread (a plain reply — there is no inbox button), the CEO calls
   the `create_project` MCP tool, which runs the same `createProjectWithTeam` and closes
   the intake ticket. There is no longer a `project_creation` approval row (the enum value
   is retained for historical rows only).

Both accept a `source_team_id` (mutually exclusive with `template_id`): the chosen team
is snapshotted into a fresh, permanent team-type template and the new team provisioned
from it, so cloning a team also seeds a reusable type. HQ is rejected as a source. The
CEO's `create_project` tool is wired with `ContainerDeps` (threaded through
`initMcpServer`/`registerTools`) so a project it creates gets its container provisioned.

Key source: `services/teams.ts` (`seedDefaultTeam`), `team-template-apply.ts`
(`ensureInstanceCeo`/`ensureInstanceCoach`), `services/internal-intake.ts` (coordination
context), `services/agent-runner.ts` + `services/job-manager.ts` (the run-team split and
instance-agent task selection).

---

## 5. Agent execution & run lifecycle

**Startup Docker gate.** Every run executes in a per-project Docker container, so Docker
is a hard prerequisite. Before `startup()` boots the server, `index.ts` runs a preflight
(`services/docker-preflight.ts`): it pings the daemon and, on failure, checks for a
`docker` binary on PATH to tell *not installed* from *installed-but-stopped*, prints the
matching guidance (install link / start command), and **exits non-zero**. `HEZO_SKIP_DOCKER`
(the same flag that swaps in the in-process fake docker for dev/tests) bypasses the gate.

Work reaches an agent through the **wakeup → job-manager → agent-runner** pipeline.

**Wakeups.** Every trigger is an `agent_wakeup_requests` row. Sources: `heartbeat`
(scheduled fallback tick), `timer` (recovery: orphan detector, retry), `assignment`,
`mention`, `reply`, `comment` (opt-in assignee wake), `on_demand`, `automation`.
Event-based triggers wake agents immediately; scheduled heartbeats are the idle-agent
fallback. Duplicate wakeups for the same agent dedupe via `idempotency_key` and **coalesce**
(`coalesced_count`), merging context instead of spawning redundant runs. The agents API
derives (does not store) each agent's `next_heartbeat_at` as
`last_heartbeat_at + max(heartbeat_interval_min, floor)` — null when the agent is off the
schedule (disabled or budget-paused) — sharing the floor constant with the scheduler
(`services/heartbeat-schedule.ts`) so the web UI's live countdown matches the enforced cadence.

**Dispatch.** `JobManager` runs a ~1 Hz cron that also does container sync, container
health, and orphan recovery. Per project-concurrency-limited, it: loads queued wakeups →
runs the **pre-run budget gate** (`activateAgent`; over-budget skips the run with no
`heartbeat_runs` row and pauses the agent) → claims the wakeup → invokes the runner →
absorbs sibling queued wakeups for the same task → marks the run terminal → reconciles
task blockers (waking dependents when the last blocker clears) → fires task automations.
Instance agents (CEO/Coach) select work across *all* teams here.

**Run.** `agent-runner.ts` builds the run context (provider/runtime resolution, MCP
descriptors, egress proxy, ssh-agent socket, container env), starts a `heartbeat_runs`
row, and drives a streaming `docker exec` of the runtime CLI. It captures interleaved
stdout/stderr into `log_text` (capped at 1 MB, `[stderr]`-prefixed) and broadcasts the
same stream live over the `project-runs:<projectId>` WebSocket room.

**Containers & worktrees.** One container per project; the project's
`<dataDir>/teams/<slug>/projects/<slug>/workspace/` bind-mounts to `/workspace`, with one
subdirectory per linked repo. For each task the runner creates a `git worktree` at
`/worktrees/<task-identifier>/<repo-name>` on branch `hezo/<task-identifier>`, persisted
across runs and torn down on terminal status. The working dir resolves to the designated
repo's worktree (falling back to `/workspace`).

**All git runs in the container — the host runs none.** Hezo's only prerequisite is Docker;
there is no host `git`. Every repo/worktree operation (clone, fetch, `worktree add`, …) runs
via `docker exec` in the project container (which ships git 2.51), driven from TypeScript on
the server through a `GitExecutor` seam (`services/git-executor.ts`): `ContainerGitExecutor`
in production, `HostGitExecutor` (host `execFile`) in unit tests. `git.ts` functions take the
executor plus a `{ hostPath, containerPath }` pair per location — `node:fs` checks use the
host (bind-mounted) path; git commands use the container path. SSH-transport ops (clone /
fetch) are wrapped with the per-run SSH bridge (`hezo-run-with-bridge`) so `git@github.com:`
authenticates through the host ssh-agent; the container's baked-in `/etc/ssh/ssh_known_hosts`
verifies the host key. Cloning outside a run (container provision, repo link) uses a
short-lived `withProvisionBridge`.

Before building a worktree the runner fetches each clone, then **fast-forwards the clone's
local default branch** (the "main codebase") to `origin/<default>` (resolved via `origin/HEAD`
→ fallback `main`/`master`) — a clean fast-forward when it's checked out, else an `update-ref`,
since the clone never holds local commits on its default. A brand-new `hezo/<task>` branch is
created **off `origin/<default>`**, so every task starts from current trunk rather than the
clone's drifted/detached HEAD. A **resumed** worktree is then **caught up to `origin/<default>`
automatically** (`mergeDefaultIntoWorktree`): a fast-forward when the branch carries no commits
of its own, otherwise a signed merge commit (the prep executor is given the team's git identity
via `forPrep`'s `extraEnv` for this). The catch-up is conflict-safe — a worktree with
uncommitted changes is skipped, and a conflicting merge is **aborted** (`git merge --abort`),
leaving the branch exactly as the agent left it; both cases emit a `[system]` warning and never
fail the run. Only that residual conflict/dirty case is the **agent's** job to reconcile (`git
merge <default>`; the role prompts cover it). The catch-up runs before the run's pre-commit head
is captured, so a pure catch-up with no agent work is not mistaken for produced output.

**Success gate.** A clean exit (`exit_code = 0`) only counts as `succeeded` if the run
**produced output** — `produced_output` is set by any write tool (and a post-run worktree
diff), or the agent explicitly calls `report_no_work`. A clean exit with neither is a
silent no-op, marked `failed`. The completeness **stop-hook** (§ 6) is a separate gate
that blocks the agent from ending its turn with unfinished work.

**Sessions & recovery.** `agent_task_sessions` persists per-task session state; each
heartbeat spawns a fresh subprocess and injects handoff markdown from the prior session,
with compaction policies rotating on token/run/age thresholds. The orphan detector uses
`heartbeat_runs.process_pid`/`retry_of_run_id`/`process_loss_retry_count` to recover runs
whose process disappeared. A ~30 s sweep (`processBudgetResumes`) lifts budget-paused
agents back to `idle` once a window rolls over or a limit is raised.

---

## 6. AI providers, runtimes & the completeness stop-hook

**Providers → runtimes.** `AiProvider` has **seven** values — `anthropic`, `openai`,
`google`, `deepseek`, `z_ai`, `openrouter`, `kimi` — and `AgentRuntime` has **five** —
`claude_code`, `codex`, `gemini`, `opencode`, `kimi`. The mapping is data-driven in
`packages/shared/src/types/common.ts` (`PROVIDER_RUNTIME_ADAPTERS`, `PROVIDER_TO_RUNTIME`,
`PROVIDERS_BY_RUNTIME`): Anthropic + DeepSeek + Z.ai → `claude_code` (DeepSeek/Z.ai inject
`ANTHROPIC_BASE_URL` + model defaults to point Claude Code at their Anthropic-compatible
gateway), OpenAI → `codex`, Google → `gemini`, OpenRouter → `opencode`, Kimi → `kimi`.

**Provider config.** `ai_provider_configs` is instance-level (shared across teams), one
row per `(provider, label)`, each inlining an encrypted credential. `auth_method`
distinguishes an **API key** (injected as env at run start) from a **subscription** blob
(materialized to a per-run mount in the container). Subscription auth is supported by
Anthropic, OpenAI, Google, and Kimi. `resolveRuntimeForTask` filters by
`PROVIDERS_BY_RUNTIME[runtime]`, then orders `is_default DESC, created_at ASC`; an
agent's `model_override_*` (or the config's `default_model`) sets the CLI `--model`.

**Reasoning effort.** Each run resolves an `agent_effort` level
(`minimal|low|medium|high|max`) from the wakeup payload → `member_agents.default_effort` →
global `medium`. Each runtime maps it natively: `claude_code` appends
`think`/`think hard`/`ultrathink`; `codex` passes `-c model_reasoning_effort=`; `gemini`
sets `GEMINI_REASONING_EFFORT`. It's also exposed as `HEZO_AGENT_EFFORT`.

**Per-runtime wiring** lives in the MCP injectors (`services/mcp-injectors/`, five
adapters in `index.ts`: ClaudeCode, Codex, Gemini, OpenCode, Kimi). Each builds the CLI
invocation (headless prefix, prompt delivery, stream/auto-approve args), injects MCP
servers, and wires the stop-hook. OpenCode and Kimi take the prompt as a CLI **argument**
(`HEZO_PROMPT_MODE=arg`, `RUNTIME_PROMPT_DELIVERY`); the rest read it on stdin.

**Completeness stop-hook.** Every run is gated by a judge that fires when the agent tries
to end its turn and **blocks** it (keeping the same headless exec alive) when it's bailing
on failing tests, calling problems "out of scope", or deferring without filing a sub-task.
The rule body (`STOP_HOOK_RULES` in `stop-hook-prompt.ts`) is identical across runtimes;
judge models are hardcoded per provider (Sonnet / gpt-4o-mini / gemini-1.5-flash /
`kimi-for-coding`). Wiring differs by runtime's native hook: Claude Code uses a
`type: "prompt"` `Stop` hook (makes the judge call itself); Codex/Gemini/Kimi use command
scripts (`buildCodexJudgeScript`/`buildGeminiJudgeScript`/`buildKimiJudgeScript`) that
call the provider API. **OpenCode is the sole exception — no judge** (its plugin API can't
block-and-continue headless). File-mount subscription runtimes fail open (no API key in
env); Anthropic subscription still fires via `CLAUDE_CODE_OAUTH_TOKEN`. Full per-runtime
detail is in `AGENTS.md` › AI runtime hooks.

---

## 7. Credentials, egress & secrets

The core invariant: **an agent references a secret by placeholder, never by value.**
Wherever it would write a secret it writes `__HEZO_SECRET_<NAME>__` (grammar in
`lib/credential-placeholder.ts`, shared by the proxy, `request_credential`, and the admin
secrets route so a creatable name is exactly a substitutable name). The threat model
assumes the agent itself may misbehave; the egress proxy is the choke point.

**Secrets.** `secrets` rows are AES-256-GCM ciphertext plus `allowed_hosts` (e.g.
`['api.stripe.com']`, `*.googleapis.com` wildcards) or the `allow_all_hosts` escape hatch.
They are **instance-global** by default (`team_id NULL`), bounded per-secret by
`allowed_hosts`; project/team-scoped rows are possible and win on name dedup
(project > team > instance). The master key (§ 10) decrypts at request time.

**Acquisition.** An agent calls the `request_credential` MCP tool (`name`, `kind`,
`allowed_hosts`, human `instructions`, `confirmation_text`). `CredentialKind` =
`api_key | ssh_private_key | github_pat | oauth_token | webhook_secret | other`;
HTTP-auth kinds **must** pass `allowed_hosts` or the tool rejects the request. This posts
a `credential_request` comment with a paste form; on submit the server encrypts + stores
the secret and fires a `credential_provided` wakeup so the agent retries.

**Egress proxy** (`services/egress/`). A per-run HTTPS **MITM** proxy is the only path to
substitution — there is **no fall-through**; if it can't bind, the run aborts
(`EgressProxyUnavailableError`). On first boot Hezo generates a per-instance RSA CA
(`<dataDir>/ca/`, cert world-readable, key host-owner-only) that both signs per-host leaf
certs and is bind-mounted into every container's trust store
(`update-ca-certificates`, `NODE_EXTRA_CA_CERTS`, `CURL_CA_BUNDLE`, `GIT_SSL_CAINFO`).
Per run, the agent's container gets `HTTP(S)_PROXY=http://host.docker.internal:<port>`
with `NO_PROXY` carving out the Hezo backend and the LLM provider host (LLM traffic goes
direct — credentials are env-injected, and MITM breaks some Anthropic-compatible APIs).

For each request the proxy terminates TLS, matches placeholders **in the URL and headers
only** (bodies are forwarded byte-for-byte — body substitution is intentionally absent),
loads the named secret, verifies the host against `allowed_hosts`, substitutes, and
forwards. Failures are explicit and audited: `unknown_secret` (400),
`secret_not_allowed_for_host` (403), `secrets_unavailable` (503, master key locked).

**Audit.** Every substitution attempt writes one `audit_log` row
(`entity_type='egress_request'`) recording run id, host, method, path, status, count, and
the secret **names** used — never the values. The row is project-scoped: `project_id` is
resolved from the run's team (teams are 1:1 with projects), so it surfaces on the project
Activity page's "Outbound traffic" tab. Pure pass-through requests (no placeholder
anywhere) are not audited.

**Bun & topology notes.** The proxy runs on Bun, whose TLS stack forces a
**one-listening-`https.Server`-per-host** topology bridged from the CONNECT socket over an
**explicitly-allocated** loopback port (never read back from `server.address()`, which
collapses under Bun). Long-lived streams (SSE, Streamable-HTTP MCP) are tracked and
severed on run teardown. These divergences are why the egress proxy has a Bun-native test
tier. Full rationale: `AGENTS.md` › Bun-native runtime rules.

---

## 8. SSH signing & git

Each project has **one Ed25519 key** used for git commit signing and SSH git transport.
The encrypted private key lives on the project's backing team row (`team_ssh_keys`,
`team_id` UNIQUE — one team backs one project), **not** in the secrets vault. Agents never
see it.

**Per-run ssh-agent** (`services/ssh-agent/`). `SshAgentServer.allocateRunSocket` exposes
the key over two listeners: a **host Unix socket** and a **loopback TCP** listener
(in-container access, since Docker Desktop on macOS won't forward `AF_UNIX` bind-mounts).
TCP connections must prefix a 16-byte per-run token (timing-safe compared). The protocol
answers `MSG_REQUEST_IDENTITIES` (advertises the public key) and `MSG_SIGN_REQUEST` (signs
with the lazily-decrypted private key). Because **all git now runs in-container** (§ Agent
runtime), every git transport — including repo prep (clone/fetch) — reaches the key through
the TCP listener via the bridge; nothing on the host runs git.

**Per-run socat bridge.** The agent base image ships `hezo-run-with-bridge` (the runner's
`argv[0]`): it spawns a `socat UNIX-LISTEN…EXEC:hezo-ssh-bridge` that forwards each
in-container connection (prefixing the token) to the host TCP listener, then execs the
agent CLI. The container sees a normal `SSH_AUTH_SOCK` Unix socket and is unaware of the
relay. The same socket serves both commit signing and `git@github.com:` clone/fetch/push.
Repo/worktree prep wraps individual git commands with the same `hezo-run-with-bridge` runner;
cloning outside a run (provision, repo link) allocates a short-lived bridge via
`withProvisionBridge`.

**Verified-on-GitHub bootstrap.** On every successful GitHub OAuth connect the project's
public key is auto-registered on the connecting user's account as **both** a signing key
(`POST /user/ssh_signing_keys` — drives `Verified` badges) and an authentication key
(`POST /user/keys` — so SSH git works). Registration is idempotent (GitHub 422 "already
in use" → no-op). Commit *authorship* comes from the instance-global GitHub connection;
*signing* uses the project's own key.

---

## 9. OAuth, GitHub & MCP connectors

Every third-party connection is an **MCP connector**. There is **no central relay** — each
Hezo instance is its own OAuth client and callbacks land on its own URL. Token
acquisition is chosen per provider by what the provider's Authorization Server actually
supports; once a token exists, both strategies finalize through one shared path.

| Strategy | Mechanism | Selected when | Used by |
|---|---|---|---|
| **DCR auth-code + PKCE** | PRM discovery (RFC 9728) → Dynamic Client Registration (RFC 7591) → redirect popup → `/api/oauth/mcp-callback`. Zero config — the AS mints a `client_id`. | the AS advertises a `registration_endpoint` | DatoCMS, Linear, Notion, Vercel, … |
| **Device flow (RFC 8628)** | `connectors/:id/device/start` → user types a code → `…/device/poll`. Needs a pre-registered public `client_id`; no redirect, no secret. | the capability registry declares a `deviceAuth` descriptor | **GitHub** |
| **Paste / `request_credential`** | raw key pasted into the vault | provider exposes no OAuth | `paste` fallback |

GitHub uses the device flow because its AS advertises no `registration_endpoint` (DCR
impossible) and a redirect flow would need a per-host registered callback. The selection
is data-driven via `packages/shared/src/types/connector-capabilities.ts`; generic OAuth
machinery is in `services/oauth/*`, GitHub REST helpers in `services/github.ts`.

**Storage.** `oauth_connections` is instance-global (one row per provider + account,
usable by every team's runs). Tokens have no column of their own — they ride the `secrets`
table under name pattern `OAUTH_<PROVIDER>_<8 hex>` (`_REFRESH` suffix for refresh
tokens), `allowed_hosts` auto-locked to the provider's hosts. So OAuth tokens flow through
the same egress placeholder path as any secret; agents emit
`Authorization: Bearer __HEZO_SECRET_OAUTH_GITHUB_AB12CD34__`. `refreshExpiringTokens`
(called by the egress substitution path on every outbound request) refreshes tokens within
60 s of expiry, coalescing concurrent refreshes per connection.

**Agent connector flow.** An agent calls `register_connector` with an MCP URL (DCR is
attempted) or a `provider_id` for a device-flow provider. The tool creates a pending
`mcp_connections` row and posts a `connect_required` comment with a **Connect** button; a
human completes the OAuth dance from the task chat or the Connectors page, and a
`credential_provided` wakeup resumes the agent. Pending/revoked connectors are excluded
from runs by `loadMcpConnectionsForRun`.

**MCP connections** (`mcp_connections`, see § 3 scoping). `kind='saas'` carries
`{ url, headers }` (header values may contain `__HEZO_SECRET_*__`; OAuth-backed rows set
`oauth_connection_id` and the loader emits the `Bearer` placeholder). `kind='local'`
carries a stdio `{ command, args, env }` (the on-demand installer is a deferred phase).
At run build, `loadMcpConnectionDescriptors` merges connectors after the built-in `hezo`
MCP, and each of the five runtime adapters translates the descriptors into the spawn
artifacts its CLI expects (Claude Code `--mcp-config`, Codex `config.toml`, Gemini
`.gemini/settings.json`, etc.).

**Git vs API.** Repo clone/fetch/push does **not** use the OAuth token — that's SSH with
the project key (§ 8). The OAuth token is reserved for GitHub REST (listing/creating
repos, registering keys) and the GitHub MCP tool surface. Full design: this section plus
the route table in `services/oauth/` and `routes/oauth.ts`.

---

## 10. Auth & route authorization

**Master key.** A **12-word BIP39 phrase held by the operator** that never reaches the
server. From its seed the client derives two keys via HKDF-SHA256 (distinct salts): an
**Ed25519 auth keypair** (private key re-derived per login, never persisted; public key
enrolled at setup in `system_meta.auth_public_key`) and a 32-byte **unlock key** (the
input to the server's at-rest derivations — canary, secrets encryption, JWT signing —
held in memory only). The server needs symmetric key material at runtime because it
decrypts secrets with no client in the loop (egress substitution, ssh signing, provider
keys), so the unlock key transits exactly twice per boot — at setup and at
unlock-after-restart — always inside an Ed25519-signed payload.

**Bootstrap (challenge-response).** `POST /auth/setup` enrolls the public key + unlock key
+ canary in one transaction (self-certifying signature, `unset` state only). Routine login
transmits **zero key material**: `POST /auth/challenge` issues a single-use nonce,
`POST /auth/verify` returns a JWT after verifying the signature over a reconstructed,
domain-separated message (`hezo-auth-v1:login:<nonce>`). After a restart the server starts
**locked**; the first `verify` includes the `unlock_key`. Messages are versioned and
domain-separated so signatures can't be replayed or cross-purposed; on unlock
`MasterKeyManager` fires `onUnlock` callbacks that start the `JobManager`.

**Four principals.**
- **User JWT** (HS256, secret derived from the unlock key) — `Authorization: Bearer <jwt>`.
- **API key** — `Authorization: Bearer hezo_<key>`, SHA-256-hashed, team-scoped. The
  external **team-scoped** on-ramp: authenticates the **MCP endpoint (`POST /mcp`) only** —
  rejected on REST and the WebSocket. Humans mint and revoke keys via the REST api-keys
  routes (user JWT). The `hezo_` prefix disambiguates from agent JWTs (and `hezoc_`
  connected-agent tokens).
- **Agent JWT** — minted per run, carrying `{ member_id, team_id, run_id, exp }`. Validated
  on every call against the **`heartbeat_runs` row** (`id=run_id`, member/team match,
  status `running`); when the run finalizes the token is rejected on the next call —
  revocation for free, no token store.
- **Connected-agent token** — `Authorization: Bearer hezoc_<key>`, SHA-256-hashed, issued
  by external-agent **self-registration** and **inert until an admin approves it**. Once
  approved it resolves to an **admin-equivalent, cross-team principal** (every
  project/team), revoked instantly by deleting the `connected_agents` row (no token store).
  It is admin-equivalent for data and instance settings but **not** for managing connected
  agents — that stays human-superuser-only. Pending registration + status polling go
  through the public onboarding surface (REST and the `/mcp` `register`/`connection_status`
  tools).

By surface: **REST** is the human/browser API (user JWT), also reachable by an approved
**connected-agent token** (admin-equivalent). **MCP** additionally accepts the **agent JWT**
(internal per-run) and the **API key** (external, team-scoped). The API key is the one
credential confined to MCP — an external caller can obtain neither a user JWT (needs the
master-key seed) nor an agent JWT (minted only for a server-side run), so a team-scoped API
key (or an admin-approved `hezoc_` token) is its only way in.

**Authorization** (`AGENTS.md` › Route authorization is authoritative). Routes with
`:projectId` resolve the project → its backing team and verify access **per request** in
`requireProjectAccessMiddleware`, exposing `c.var.projectId`/`c.var.teamId`. Nested
resources verify ownership of the parent project via WHERE/JOIN before any read/write.
Global endpoints still check the resource's team. WebSocket subscriptions verify room
membership. MCP tool handlers enforce the same checks as their REST equivalents. Human
team members hold `MembershipRole` `admin` (full authority — the "board") or `member`
(scoped by `project_ids`); the first user is the instance superuser.

---

## 11. Web frontend

React 19 + **TanStack Router** (type-safe route tree under `packages/web/src/routes/`:
`home/`, `projects/$projectId/...`, `settings/`, `preview/`) + **TanStack Query** for
server state. Tailwind + Radix UI primitives (shadcn-style) under `components/ui/`.

**Data flow.** The client fetches through React Query; the server broadcasts row-change
events over WebSocket (UUID-keyed rooms), and the client **invalidates the matching query
keys** to refetch. There is no client-side local query engine. The hard rule (`AGENTS.md`
› Slugs vs UUIDs): **query keys use the route-param slug**, WebSocket rooms use UUIDs, and
`useWebSocket` takes both — mixing them silently breaks realtime updates.

**Mutations** (three strategies, by shape — see `AGENTS.md` › Web frontend mutations):
**optimistic + rollback** (default for field edits/toggles/reactions, via
`useOptimisticMutation`), **response-driven** (creates and server-validated fields like
task `status`; security-sensitive mutations like credential fulfillment **must** stay
here), and **invalidate + refetch** (validation-heavy / long-running work). Errors toast
on rollback; successes are confirmed by the UI change itself.

**Responsive.** Mobile-first is mandatory — build the mobile layout first, enhance with
`sm:`/`md:`/`lg:`. Three breakpoints (mobile <768px, tablet 768–1023px, desktop 1024px+).
Every UI change must work at all three, and its browser test must verify mobile
(`AGENTS.md` › UX).

---

## 12. Build, release, migrations & upgrades

**Single binary.** `bun build --compile` (`scripts/build.ts`) produces one executable per
platform (linux/darwin/windows × x64/arm64) plus a `SHA256SUMS` manifest;
`build:compile` builds just the host for local testing. Because `--compile` only embeds
what's reachable through the **module graph** (not runtime `readFile`/`new URL`), every
asset is pulled in as a static import and served **from memory**: migrations
(`migrations-bundle.json`), agent roles (`agents-bundle.json`), the React frontend
(`static-bundle.json`, base64), and the PGlite runtime (`postgres.wasm`/`.data` embedded;
the lone exception is the ~330 KB pgvector tarball, extracted once to
`<dataDir>/.pglite/`). In dev (`bun run`) the bundles don't exist and every loader falls
back to the filesystem. The version is injected at compile time
(`--define process.env.HEZO_VERSION`) and surfaced at `/api/status`.

**Migrations.** Real, tracked, **append-only** SQL under `packages/server/migrations/`
(`001_initial_schema.sql` is the frozen baseline — never edit a shipped migration; each is
checksummed and applied once). Schema changes add the next `NNN_*.sql`; data transforms
SQL can't express add a **code migration** TS module under `src/db/migrations/code/`
(shared `NNN_` ordering, same per-migration transaction). On startup the runner migrates a
**copy** of the DB (`<dataDir>/.migrate-tmp`) and **atomically swaps** it in on success; on
failure the live `pgdata` is untouched, so downgrading to the previous binary just works.
A data dir carrying migrations the binary doesn't recognize makes the server exit and ask
the operator to upgrade. Migration mechanics and the per-migration rules are in `AGENTS.md`
› Database migrations.

**Backup/restore.** Before applying pending migrations to an already-initialized instance,
the runner snapshots the DB with PGlite `dumpDataDir('gzip')` to `<dataDir>/backups/`
(last 5 kept); a failed backup aborts the migration. Recovery is
`hezo restore <backup.tar.gz>` (wipes `pgdata`, reloads the snapshot, keeps the original
master key) → run the previous binary.

**Releases & updates.** A PR flow (`.github/workflows/`): `release.yml` computes the next
version from Conventional Commits and opens a `release/<version>` PR; merging fires
`release-publish.yml`, which tags, cross-compiles, and publishes a GitHub Release. The
running instance polls `GET /api/updates/latest` (cached ~1 h, fails soft) and shows a
dismissible banner.

**Known limits.** Semantic search is unavailable in the standalone binary (the embedding
model is a native addon marked `--external`; it fails soft — running from source keeps it).
macOS binaries are unsigned (built on Linux; clear quarantine with `xattr -d`).

---

## 13. API surface (summarized)

A JSON-over-HTTP REST API on the same Hono process/port as the MCP and WebSocket
endpoints. Every response is `{ "data": … }` or `{ "error": { code, message } }`;
timestamps ISO 8601, ids UUID, money in cents. This is a **map** of the ~36 route modules
mounted in `startup.ts` — read the modules under `packages/server/src/routes/` for exact
shapes.

- **Auth & identity** — `auth` (challenge-response, § 10), `me`, `api-keys`,
  `instance-settings`, `preferences`, `ui-state`.
- **Projects & teams** — `projects` (creation/intake, the 1:1 team reached *through* the
  project — there is no bare `GET /teams`), `team-templates`, `agent-types`, `repos`,
  `project-docs`.
- **Agents & runs** — `agents` (hire/fire/pause/resume, system-prompt revisions),
  `execution-locks`, `queued-wakeups`, `ceo-chat` (live CEO session).
- **Tasks & collaboration** — `tasks`, `comments`, `mentions`, `assets`, `inbox`,
  `search` (semantic).
- **Money & governance** — `costs` (project-scoped, `group_by=day` for charts),
  `model-pricing`, `approvals`, `audit-log`.
- **Integrations & secrets** — `ai-providers`, `secrets`, `mcp-connections`, `oauth`
  (connectors: ensure / auth-start / device / callbacks), `skills`.
- **Ops** — `health`, `updates`, `preview` (HMAC-signed file URLs), public assets.

One non-REST surface shares the port: the **MCP endpoint** (`POST /mcp`, Streamable
HTTP), whose tools mirror the REST surface and enforce the same authorization. It is the
interface agents drive — tasks, comments, approvals, credentials — and external agents
can drive it too, including **self-registering as a connected agent** (pending admin
approval, then admin-equivalent across every project/team; § 10). It also exposes
`POST /mcp/assets` (multipart) for binary uploads, since JSON-RPC can't carry a file.
**API keys authenticate the MCP surface only**; REST is the user-JWT (human/browser)
surface (connected agents excepted — admin-equivalent on both). `GET /SKILL.md` serves the
manifest that teaches an external agent how to use it — including the connect/register
flow — and `GET /llms.txt` points to it. Authorization for both the REST and MCP surfaces
is § 10.

---

## 14. Testing

Four tiers (full guidance — when to use each, how to run one file, how to diagnose
failures — is in `AGENTS.md` › Testing, which is authoritative):

- **Server unit/integration** (`packages/server/test/**/*.test.ts`, vitest/Node) — API
  handlers, DB queries, services, MCP tools; each test boots a fresh PGlite + Hono app via
  `createTestContext()`. The default home for backend work.
- **Web component** (`packages/web/test/**/*.test.tsx`, vitest/happy-dom) — the React tree
  against an in-process Hono + PGlite backend via `renderApp()`. Covers ~80% of what would
  otherwise be a browser test (forms, mutations, refetches, navigation, rendering).
- **Playwright browser** (`test/browser/**/*.spec.ts`) — the thin slice that genuinely
  needs Chromium: real CSS layout, viewport-conditional behavior, native input events,
  windowed-list virtualization, real WebSocket streams, the master-key gate.
- **Bun-native runtime** (`packages/server/test/bun/**/*.bun.test.ts`, `bun test`) — code
  whose behavior diverges between Node and Bun, exercised on the production Bun runtime.
  Today: the egress proxy's TLS MITM path (§ 7).

All changes ship with tests that exercise functionality, preferring integration over
heavily-mocked unit tests, and a green run keeps a quiet log (no stray `[error]`/`[warn]`).
