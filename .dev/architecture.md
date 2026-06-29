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
| Database | **PGlite** (embedded Postgres, in-process), persisted to `~/.hezo/pgdata` |
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
`system` (timeline entries like `status_change`/`task_link`), `run` (auto-written
on run completion), `preview`, `action`,
`connect_required`, `credential_request`. Each comment carries a `public_id` slug for
`#comment-<id>` deep-links. `comment_reactions` holds emoji reactions.

**Goals.** `goals` are per-project objectives the Captain tracks (`project_id NOT NULL`;
the `is_internal` HQ project has none, enforced in the service). Each carries a SMART
`title`/`description`, a `target_date`, a `check_frequency` enum (`daily`/`weekly`/`monthly`,
default daily), an admin-set `archived_at` (NULL = active; there is **no** achieved status),
and the Captain-maintained snapshot — `progress_percent` (0–100), a `goal_health` enum
(`pending`/`on_track`/`at_risk`/`off_track`), a `status_blurb`, and `last_checked_at`. The
Captain refreshes these on its heartbeat via a **goal-check run** (below). `goal_run_updates`
is the per-run progress history (one row per goal touched by a run, snapshotting
percent/health/blurb) — the source of each goal's progress chart and the project-wide goal-check
list on the Progress page. `tasks.goal_id` optionally links a ticket to the goal it advances
(traceability only; it does **not** gate or alter how the task runs), and `tasks.created_by_run_id`
/ `task_comments.created_by_run_id` attribute a ticket or comment to the run that produced it.
Together these back the goal detail page's per-goal **run activity** feed (`listGoalRunActivity`):
the goal-check runs that estimated *that* goal, created tickets linked to it, or commented on its
linked tickets. During a goal-check run the Captain may comment on an in-flight ticket instead of
filing a new one, and it can never re-open a terminal ticket (blocked in both the REST and MCP
update paths — only the admin can). A separate Captain-maintained **project progress summary**
(`projects.progress_summary` + `progress_summary_updated_at`, set via the `update_project_progress`
MCP tool) is the markdown blurb shown at the top of the Progress page.

**Secrets, OAuth, MCP connectors.** `secrets` stores AES-256-GCM ciphertext gated by
`allowed_hosts` (§ 7). `oauth_connections` records connected GitHub/SaaS accounts; their
tokens *ride the `secrets` table* (no token column). `mcp_connections` is the catalog of
SaaS/local MCP servers injected into runs (§ 9). All three are **instance-global** — a
single shared catalog keyed by a globally-unique name (`secrets.name` /
`mcp_connections.name` / `oauth_connections (provider, provider_account_id)`), with no
`team_id` column, so every team's runs see the same set. `team_ssh_keys` is the exception
— one Ed25519 key **per team** (`UNIQUE(team_id)`, and therefore per project given the
1:1), encrypted on the team row, never in the vault (§ 8).

**Runs, wakeups, sessions.** `agent_wakeup_requests` is the trigger queue, with
idempotency keys and `coalesced_count` merging (§ 5). `heartbeat_runs` is one row per
execution (status, timing, tokens, cost, captured logs, `wakeup_id` provenance, the
success-gate flags `produced_output`/`reported_no_work`). A `kind` enum distinguishes a
normal `task` run from a `goal_check` run (the Captain's task-less goal assessment —
`task_id IS NULL`); goal-check runs reuse the full run lifecycle but skip the task comment,
status flip, and code worktree. Token usage is flushed to the
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
instance/team reference store (manifest-injected into runs, full-text-searchable) with
`skill_revisions` history. `assets` + `task_attachments`/`comment_attachments` handle
uploaded files (bytes on local disk, served over HMAC-signed URLs); agents can also author
text-based assets directly (`write_project_asset` — HTML, SVG, plain text, and markdown such
as a blog post), and the web app renders markdown assets with a rich preview plus a
view-source toggle. `project_icons`
(1:1 with `projects`, `ON DELETE CASCADE`) holds an optional per-project icon image —
unlike assets the **bytes live in the DB** (a `BYTEA` column) in a dedicated table so the
hot `projects.*` list query never pulls the blob; it is rendered in the project rail and
served from a public HMAC-signed read route (`GET /api/projects/:projectId/icon`, the `sig`
query param is the credential since an `<img>` carries no bearer token). The serialized
project carries a freshly-signed `icon_url` (null when unset); the client normalizes any
picked image to a square PNG ≤512×512 before upload (`PUT`/`DELETE` on the same path).

**Governance & misc.** `approvals` (polymorphic board decisions), `audit_log`
(append-only, project + instance scopes — `project_id` set scopes a row to one project,
NULL marks an instance-level action; never updated/deleted by the app),
`api_keys` (instance-scoped MCP credential, sha256-hashed `hezo_` prefix, `status`
pending/approved — admin-minted keys are born approved, self-registered ones await admin
approval), `invites`, `admin_mentions` (board inbox),
`instance_user_roles`, `notification_preferences`. `plugins`/`plugin_state`/`plugin_jobs`
are scaffolding for a future plugin runtime — present but not yet exercised.

**Actor attribution (human vs API key).** Every recorded admin action carries who took it so
the UI can flag human vs automated. `audit_actor_type` is `admin | agent | system | api_key`;
alongside the existing `actor_member_id` / `author_member_id` foreign keys, `audit_log`,
`task_comments`, and `document_revisions` each carry a parallel nullable `actor_api_key_id` /
`author_api_key_id` FK (at most one of the two is set per row). `resolveActor` maps an
`ApiKey` principal to the `api_key` actor type + id, threaded through task events, the audit
observer, and the document service. The web surfaces (task activity feed, audit-log table,
document revision history) render a small badge via the shared `ActorBadge` — a person icon
for a human admin, a bot icon for an API key (tooltip naming it). Roster agents and `system`
actors are not badged; inline `@admin` mentions in comment bodies are rendered plainly (not an
action).

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
  CEO-actioned. **Hiring** has two entry points, both ending as a pending `hire` approval
  the admin approves (and may modify first via `PATCH /approvals/:id`, which reuses the
  hire form pre-filled from the proposal): the admin's hire form
  (`POST /projects/:projectId/agents/onboard`, which also opens a CEO-assigned onboarding
  ticket), or a Captain/CEO filing one directly with the `create_hire_proposal` MCP
  tool — the Captain for its own team, the CEO for any team (it passes `project`,
  including HQ). The Captain refines an admin-started draft
  with `update_hire_proposal`; both tools share the validation/insert helpers in
  `services/hire-proposal.ts`. A hire captures **`reports_to`** (the manager's slug,
  validated against the team) so the materialized agent gets its structural reporting
  line — without it an agent has no manager and the assignment-hierarchy guard
  (`assertSubordinateAssignee`) blocks delegation to/from it. Approval materialises the
  agent via the hire approval handler (resolving the manager slug → member id). An
  existing agent's manager is set/changed with the **`set_agent_reports_to`** MCP tool
  (Captain or HQ coordinator; rejects self-reports and cycles) — the structural analogue
  of the descriptive `team_context` blob. Each proposal is also mirrored as a `hire_proposal` action comment on the
  linked ticket (`services/hire-proposal-comment.ts`), which flips to hired/denied on
  resolution and re-wakes the requester; the approval no longer auto-closes the ticket —
  the requester (the CEO) closes it once setup is complete. Retiring/reinstating an agent is the `set_agent_status` MCP tool (gated to
  the team's Captain or an HQ coordinator), which runs the same `setAgentAdminStatus`
  service as the REST disable/enable routes — it can't disable a Captain or an instance
  agent. On a new team the CEO's initial coherence/setup pass **blocks** the Captain's
  planning task. It **auto-runs** on the direct (form) creation path; on the CEO-assisted
  path the CEO authors the concrete setup plan into it and then starts it with
  `start_team_setup` (see Creation flows).
- **Coach** — reviews completed tickets across **every** project to improve agent system
  prompts; woken on any task completion.

The **HQ container** is warmed as early as possible after boot: once the master key is
unlocked (provisioning needs secrets/egress), `JobManager.ensureHqContainerRunning` runs
after the container-restart reconcile pass and brings HQ up via
`ensureProjectContainerRunning` (no-op if already running, start-in-place if stopped,
provision if missing) — fire-and-forget so a slow image pull doesn't delay startup. This is
unconditional because the standard restart pass deliberately leaves `stopped` projects
alone, whereas HQ — home of the always-on CEO/Coach — should run whenever the instance does.
The live CEO chat (`ceo-session-manager.ts`) also provisions it on demand as a fallback. Turns
are **serialized** (a `turnLock` chain) so concurrent sends can't each spawn a turn — a newer
message interrupts the in-flight reply (kept as `interrupted`) and only the latest streams. No
turn survives a process restart, so `reconcileOnStartup` clears orphaned non-terminal
`ceo_messages` (deletes empty `streaming`/`pending` placeholders, marks partial ones
`interrupted`) — an abandoned turn never lingers as a stuck "thinking" bubble.

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
coherence/setup task (it takes the first identifier) ahead of the Captain's planning task
(blocked on coherence), wakes the Captain, and provisions the container. Whether that
coherence task **auto-runs** is the one behavioural difference between the two paths
(`suppressCoherenceAutoStart`): the direct path assigns it to the CEO and wakes them
immediately; the CEO-assisted path leaves it **unassigned and un-woken**.
1. **Direct** — `POST /api/projects`: runs `createProjectWithTeam` in one step. No
   approval gate. The coherence/setup task **auto-runs** (assigned to the CEO and woken).
2. **CEO-assisted** — `POST /api/project-intakes`: opens a CEO-run intake conversation
   ticket in HQ (label `project-intake`) recording the form data and the admin's chosen
   team type as the CEO's **baseline suggestion**. **Nothing is created up front — no
   team, no project, no approval.** The CEO scopes the work with the admin; when the
   admin approves in the thread (a plain reply — there is no inbox button), the CEO calls
   the `create_project` MCP tool, which runs the same `createProjectWithTeam` and closes
   the intake ticket. On this path the coherence/setup task does **not** auto-run: it is
   created unassigned, `create_project` returns its `coherence_task_identifier`, and the
   CEO authors the concrete setup (the specific hires, prompt rewrites, reporting
   structure agreed in intake) into it with `update_task`, then calls the
   **`start_team_setup`** MCP tool to assign it to itself and begin the run. There is no
   longer a `project_creation` approval row (the enum value is retained for historical
   rows only).

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
`mention`, `reply`, `comment` (opt-in assignee wake), `credential_provided` (a human
supplied a requested credential), `on_demand`, `automation`.
Event-based triggers wake agents immediately; scheduled heartbeats are the idle-agent
fallback. A scheduled heartbeat that fires but finds no actionable task is a no-op that
still **advances `last_heartbeat_at`** (the same field a completed run stamps), so the
scheduler throttles the next tick a full interval out instead of re-selecting the agent
every cron tick — a `NULL` `last_heartbeat_at` is perpetually "due". Duplicate wakeups for
the same agent dedupe via `idempotency_key` and **coalesce** (`coalesced_count`), merging
context instead of spawning redundant runs. The agents API derives (does not store) each
agent's `next_heartbeat_at` as `last_heartbeat_at + max(heartbeat_interval_min, floor)` —
null when the agent is off the schedule (disabled or budget-paused) — sharing the floor
constant with the scheduler (`services/heartbeat-schedule.ts`) so the web UI's live
countdown matches the enforced cadence. Alongside it the API derives `has_actionable_work`
(mirrors the scheduler's task selection: a non-terminal, unblocked assigned task); when
false the next heartbeat would no-op, so the UI shows a dash rather than a countdown.

**Dispatch.** `JobManager` runs a ~1 Hz cron that also does container sync, container
health, and orphan recovery. Per project-concurrency-limited, it: loads queued wakeups →
runs the **pre-run budget gate** (`activateAgent`; over-budget skips the run with no
`heartbeat_runs` row and pauses the agent) → claims the wakeup → invokes the runner →
absorbs sibling queued wakeups for the same task → marks the run terminal → reconciles
task blockers (waking dependents when the last blocker clears) → fires task automations.
Instance agents (CEO/Coach) select work across *all* teams here.

**Run.** `agent-runner.ts` builds the run context (provider/runtime resolution, MCP
descriptors, egress proxy, ssh-agent socket, container env), starts a `heartbeat_runs`
row, and drives a streaming `docker exec` of the runtime CLI. Before that exec it
**live-verifies the container against Docker** (`syncContainerStatus`) instead of trusting
the cached `container_status`: a container pruned externally or lost to a Docker restart is
reconciled (status flipped, `container_id` nulled, project update broadcast) and the run
fails fast with a clear message rather than tripping over a raw 404 mid-exec. It captures
interleaved stdout/stderr into `log_text` (capped at 1 MB, `[stderr]`-prefixed) and
broadcasts the same stream live over the `project-runs:<projectId>` WebSocket room.

**System prompt composition.** The agent's stored template (its `agent_system_prompt`
document, loaded from its **home** team) is resolved per run by
`services/template-resolver.ts`: `{{…}}` placeholders are substituted with live DB values
(`{{team_name}}`, `{{reports_to}}` — wired to the instance CEO for a Captain via
`linkTeamCaptainToInstanceCeo` — `{{skills_context}}`, `{{project_docs_context}}`,
`{{team_preferences_context}}`, `{{team_description}}`, `{{team_context}}`,
`{{current_date}}`, and the CEO-only `{{projects_context}}`), then the resolver appends the
Run Context / Repository / Project State / Teammates blocks and `SHARED_INSTRUCTIONS`.
Every surface that authors or edits a prompt — the hire proposal create/edit
(`prepareHireProposal`, `PATCH /approvals`), direct agent create + `PATCH /agents`, and the
`create_hire_proposal` / `update_agent_system_prompt` MCP tools — validates a supplied,
non-empty prompt against `REQUIRED_SYSTEM_PROMPT_VARS` (`@hezo/shared` —
`{{team_name}}`, `{{reports_to}}`, `{{skills_context}}`, `{{project_docs_context}}`,
`{{team_preferences_context}}`) and rejects it (4xx / tool error) when one is missing, so an
edited prompt can never silently drop the agent's identity or live context. The instance
singletons (CEO/Coach) are exempt — they have no in-team manager. `{{team_context}}` is
**not** required because the resolver auto-appends that block on every run regardless.

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

**Container run-user & host-file ownership.** The agent base image (`node:24-slim`) sets no
`USER`, so the container runs as **root**; Hezo deprivileges individual `docker exec`s — the
agent CLI and every git op — to a non-root **run-user** (the stock image's `node`, which has
passwordless sudo, so this is for file-ownership hygiene, not a security boundary) so files
those execs create in the bind-mounted workspace stay non-root-owned. The run-user is
**detected, not assumed** (`resolveContainerRunUser`, `services/container-user.ts`): it prefers
a `node` user and falls back to the container's default user (root, for a custom
`docker_base_image` with no `node`), cached per container, and is used for the `--user` of every
exec and the socat socket owner. Because the server writes the per-run runtime config dir +
credentials and creates the workspace/worktree dirs on the host (as root in production), Hezo
gives the run-user ownership of every bind-mounted path those deprivileged execs must read or
write — the per-run config dir, `/workspace`, `/worktrees`, `/workspace/.previews`, `/run/hezo`
— via an **in-container `chown` run as root** (`chownToRunUser`). Doing the chown inside the
container needs no host privilege, so it works identically on a root server, a non-root
`User=hezo` server, and macOS (where Docker Desktop's bind-mount uid-remapping otherwise hides
the mismatch — the reason this class of bug only surfaced on a native-Linux production host). It
is a no-op when the run-user is root. The chown fixes *ownership* of the leaf, but the run-user
must also *traverse* the shared intermediate dirs (`.hezo/subscription/<provider>/`) that the
chown never touches. Those are created world-traversable (`0o711`) via `mkdirTraversable`
(`services/runtime-home.ts`), which `chmod`s each component **after** `mkdir` rather than relying
on `mkdirSync`'s `mode` — that mode is masked by the **process umask**, so a hardened host (umask
`0o027`/`0o077` under systemd `UMask=`) would silently strip the other-execute bit and the agent
CLI would die with `EACCES` opening its `settings.json` (again only on native-Linux production).

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

**Providers → runtimes.** `AiProvider` has **eight** values — `anthropic`, `openai`,
`google`, `deepseek`, `z_ai`, `openrouter`, `kimi`, `x_ai` — and `AgentRuntime` has **six** —
`claude_code`, `codex`, `gemini`, `opencode`, `kimi`, `grok`. The mapping is data-driven in
`packages/shared/src/types/common.ts` (`PROVIDER_RUNTIME_ADAPTERS`, `PROVIDER_TO_RUNTIME`,
`PROVIDERS_BY_RUNTIME`): Anthropic + DeepSeek + Z.ai → `claude_code` (DeepSeek/Z.ai inject
`ANTHROPIC_BASE_URL` + model defaults to point Claude Code at their Anthropic-compatible
gateway), OpenAI → `codex`, Google → `gemini`, OpenRouter → `opencode`, Kimi → `kimi`,
xAI → `grok` (the `grok` CLI talks to xAI natively via `XAI_API_KEY`; OpenAI-compatible,
its Anthropic-compat endpoint is deprecated).

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

**Per-runtime wiring** lives in the MCP injectors (`services/mcp-injectors/`, six
adapters in `index.ts`: ClaudeCode, Codex, Gemini, OpenCode, Kimi, Grok). Each builds the
CLI invocation (headless prefix, prompt delivery, stream/auto-approve args), injects MCP
servers, and wires the stop-hook. OpenCode, Kimi, and Grok take the prompt as a CLI
**argument** (`HEZO_PROMPT_MODE=arg`, `RUNTIME_PROMPT_DELIVERY`); the rest read it on stdin.
The Grok adapter writes `~/.grok/config.toml` (Codex-shaped `[mcp_servers.*]` + a
`[[hooks.Stop]]` command hook); shared TOML rendering lives in `mcp-injectors/toml.ts`.

**Completeness stop-hook.** Every run is gated by a judge that fires when the agent tries
to end its turn and **blocks** it (keeping the same headless exec alive) when it's bailing
on failing tests, calling problems "out of scope", or deferring without filing a sub-task.
The rule body (`STOP_HOOK_RULES` in `stop-hook-prompt.ts`) is identical across runtimes;
judge models are hardcoded per provider (Anthropic `claude-sonnet-4-6` / DeepSeek
`deepseek-v4-pro` / Z.ai `GLM-4.7` / OpenAI `gpt-4o-mini` / Google `gemini-1.5-flash` /
Kimi `kimi-for-coding` / xAI `grok-4-fast`). Wiring differs by runtime's native hook:
Claude Code uses a `type: "prompt"` `Stop` hook (makes the judge call itself);
Codex/Gemini/Kimi/Grok use command scripts (`buildCodexJudgeScript`/`buildGeminiJudgeScript`/
`buildKimiJudgeScript`/`buildGrokJudgeScript`) that call the provider API — Grok's calls
xAI's OpenAI-compatible Chat Completions at `api.x.ai`. **OpenCode is the sole exception — no judge** (its plugin API can't
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
Unlike the CA cert (deliberately world-readable so any in-container uid can read it), the
per-run runtime config and subscription-credential files the server writes into the
`/workspace` bind mount stay `0o600`/`0o700` and are instead **chowned to the container
run-user** (see § Containers & worktrees) so the deprivileged agent CLI can read them
without exposing secrets to other host users.
Per run, the agent's container gets `HTTP(S)_PROXY=http://host.docker.internal:<port>`
with `NO_PROXY` carving out the Hezo backend and the LLM provider host (LLM traffic goes
direct — credentials are env-injected, and MITM breaks some Anthropic-compatible APIs).
The front proxy binds `127.0.0.1` by default — reachable from containers via
`host.docker.internal` on Docker Desktop, but **not** on native-Linux Docker, where that
name maps to the bridge gateway IP. The bind interface for both the egress proxy and the
ssh-agent TCP bridge is read **per-run** from a shared mutable holder (`EffectiveBindHost`),
seeded from `HEZO_CONTAINER_BIND_HOST` / `--container-bind-host` (default `127.0.0.1`).

A boot-time preflight (`container-connectivity-preflight.ts`) starts a throwaway container,
probes the MCP port and a bind-host listener in the egress range (20000–29999), and resolves
the bridge gateway IP both host-side (`DockerClient.inspectNetwork('bridge')` → `IPAM.Config[]
.Gateway`, no container needed) and in-container (for images that expose it). **Auto-rebind:**
when the bind is loopback-only and a container can't reach it (`bind-loopback`), the proxy +
SSH bridge are rebound to that detected gateway IP and re-probed — so native-Linux works out
of the box without exposing them on all interfaces (the gateway IP is host-local, container-
reachable; binding `0.0.0.0` would expose the proxy and the SSH key bridge on every
interface). An explicit non-loopback `--container-bind-host` is never overridden. The
exploratory loopback probe runs **once** (it's deterministic — loopback is reachable on Docker
Desktop, structurally not on native-Linux) with a short curl timeout, so the whole check is a
couple of container round-trips (~10s), not a retry loop. The preflight
logs the exact firewall / `--container-bind-host` remedy when a path is still blocked; severity
tracks impact: `error` when the MCP server is unreachable (no tools load, runs hang), a
non-fatal `warn` for a residual egress/SSH bind-host degradation. It never gates startup, so
the web UI stays up to act on it.

**Run-time gate.** The captured outcome (held in `ContainerConnectivityStatus`) gates egress at
run time: when egress is required but the proxy is known-unreachable (`bind-loopback` /
`bind-firewalled` / `mcp-unreachable`), an agent run aborts (recorded `Failed`) and a CEO chat
turn fails — both with the same operator guidance — instead of allocating a proxy the container
can't reach and letting the agent fall through to direct egress (which would defeat secret
substitution, `allowed_hosts`, and audit). It **fails open** on `ok`/`skipped`/unknown, with a
single-flight lazy re-probe (5-min staleness) so a firewall fix clears the gate — or a
regression re-closes it — without a restart.

For each request the proxy terminates TLS, matches placeholders **in the URL and headers**,
loads the named secret, verifies the host against `allowed_hosts`, substitutes, and
forwards. **Request bodies** are forwarded byte-for-byte by default and never buffered —
except a narrowly-gated path for secrets a human has opted into body substitution
(`secrets.allow_body_substitution`): a `POST`/`PUT`/`PATCH` with an uncompressed
`application/json` body and a fixed `Content-Length` ≤ 8 KB is buffered, has its placeholders
substituted, and is forwarded with a recomputed `Content-Length`. Everything else — larger,
non-JSON, compressed, chunked, or streaming bodies (SSE, Streamable-HTTP MCP) — streams
through untouched, so long-lived connections are never held in memory. Body substitution
still enforces `allowed_hosts`, and a body placeholder for a secret without the opt-in is
rejected, not leaked. This exists for APIs that take credentials in the body, such as a login
POST that returns a token (the agent then uses that token via the `Authorization` header).
Failures are explicit and audited: `unknown_secret` (400), `secret_not_allowed_for_host`
(403), `secret_not_allowed_in_body` (403), `body_too_large` (413), `secrets_unavailable`
(503, master key locked).

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
The TCP listener honours `HEZO_CONTAINER_BIND_HOST` (default `127.0.0.1`), read per-run from
the same `EffectiveBindHost` holder as the egress proxy — so the boot preflight's auto-rebind
to the bridge gateway IP makes git-over-SSH containers reach it on native-Linux Docker without
a manual override.
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

**Three principals.**
- **User JWT** (HS256, secret derived from the unlock key) — `Authorization: Bearer <jwt>`.
- **API key** — `Authorization: Bearer hezo_<key>`, SHA-256-hashed, **instance-scoped**. The
  external on-ramp, confined to the **MCP endpoint (`POST /mcp`) only** — rejected on REST
  and the WebSocket. One `api_keys` table with a `status` (pending/approved) backs **two
  issuance paths**: (a) a human superuser **mints** a key in Global Settings (born
  `approved`, active at once); (b) an external MCP client **self-registers** via the public
  `register` tool / `POST /api/api-keys/register` (born `pending`, **inert until an admin
  approves it** — pending registration + status polling use the public onboarding surface,
  the `/mcp` `register`/`connection_status` tools and `GET /api/api-keys/status`). An
  approved key resolves to an **admin-equivalent, cross-team principal** (every
  project/team), revoked instantly by deleting the row (no token store). It is
  admin-equivalent for data and instance settings but **not** for managing API keys
  themselves — minting, approving, and revoking stay human-superuser-only. Having no home
  project, a key must name the `project` on project-scoped tools.
- **Agent JWT** — minted per run, carrying `{ member_id, team_id, run_id, project_id, cross_project, exp }`. Validated
  on every call against the **`heartbeat_runs` row** (`id=run_id`, member/team match,
  status `running`); when the run finalizes the token is rejected on the next call —
  revocation for free, no token store.

By surface: **REST** is the human/browser API (user JWT only). **MCP** accepts the **agent
JWT** (internal per-run) and the **API key** (external, instance-scoped). The API key is the
one credential confined to MCP — an external caller can obtain neither a user JWT (needs the
master-key seed) nor an agent JWT (minted only for a server-side run), so an API key is its
only way in. Although an approved key is admin-equivalent, it never reaches REST: the auth
middleware rejects `hezo_` tokens on `/api`, so admin-equivalence applies only to its MCP
surface (and the instance-management MCP tools).

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
`useWebSocket` takes both — mixing them silently breaks realtime updates. Project
**creation** is the exception to the per-team room model: a brand-new project lands in a
team whose `team:<uuid>` room no client has joined yet, so creation also emits a
payload-free `ProjectsChanged` signal on the global `projects:global` room (which every
shell watches). Clients react by refetching the per-caller-authorized project index, so the
left project rail updates live — for the dialog, the CEO's `create_project`, and other
sessions alike — without a row on the shared room leaking a project a user can't see.

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
(`static-bundle.json`, base64), and the PGlite runtime (`postgres.wasm`/`.data`
embedded). The **agent-base Docker build context** (`docker/`) is embedded the same
way (`docker-bundle.json`, base64) so the image can always be built on the host as a
fallback. A release binary **pulls** the published image —
`ghcr.io/hezo-ai/agent-base:latest` (multi-arch amd64/arm64), pushed per release by
`.github/workflows/release-publish.yml` (alongside a `:<version>` tag) to a public GHCR
package — and refreshes it at startup (`refreshPublishedAgentBaseImage`, since Docker
otherwise caches `:latest` by name), so a long-running install picks up a newer release on
restart. That refresh (and the stale-bundled-image prune) runs **in the background**, off
the readiness path: a cold first pull can take minutes, and it must never gate `serverReady`
— the web UI, master-key unlock, and project creation are all usable without it, and
provisioning pulls-then-builds on demand, so a missing/slow refresh self-heals on first use.
It only **builds locally** when the pull fails (offline, package missing, private
fork): at startup it also (synchronously, since it's fast and the local-build fallback needs
it) extracts the embedded context to `<dataDir>/agent-base-context`
and points the resolver (`setDockerBaseDir`) at it, so the fallback build needs no checkout.
`resolveAgentBaseImage` (`image-registry.ts`) maps the stored `hezo/agent-base:latest`
sentinel to `ghcr.io/hezo-ai/agent-base:latest` with `preferPull`, and `ensureImage` does
pull-then-build; custom per-project `docker_base_image` values are pulled as-is. Pulling is
gated on `IS_PACKAGED_BUILD` (set by the compile-time `--define process.env.HEZO_VERSION`),
so in dev (`bun run`) and tests the bundles don't exist, loaders fall back to the filesystem
(docker context → repo's `docker/` dir), and the image is always built from the
working-tree Dockerfile so edits take effect immediately. The version is also surfaced at
`/api/status`.

**Pre-ready serving.** `startup()` is async and the Bun fetch entry (`index.ts`) binds the
port immediately, so requests can arrive before the app exists. Until `serverReady` flips,
the entry delegates to `serveStartupRequest` (`startup-serving.ts`): browser navigations and
static assets are served from the embedded SPA bundle, and `/api/status` answers **200** with
`{ starting: true, phase, message }` read from a boot-progress singleton (`startup-progress.ts`,
advanced through `database → migrations → seed → pricing → workspace`). The web UI
(`useStatus` → `StartingScreen`) renders a loading screen naming the current phase and keeps
polling, flipping to the master-key gate the moment boot finishes — so a browser that connects
mid-boot never sees a raw JSON error. Other API/MCP/WebSocket surfaces still get a JSON **503
STARTING** so machine clients retry; `/health` always answers 200.

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
`release-publish.yml`, which tags, cross-compiles, and publishes a GitHub Release (assets
`hezo-{os}-{arch}[.exe]` + `SHA256SUMS`). The running instance polls
`GET /api/updates/latest` (cached ~1 h, fails soft) and shows a bottom banner.

**Self-update & supervisor.** A compiled binary with auto-update enabled
(`isAutoUpdateEnabled()` — compiled, not `HEZO_DISABLE_AUTO_UPDATE`, not in a container)
runs as a thin **supervisor** (`supervisor.ts`): it spawns the real server as a **worker**
(`Bun.spawn` of `[execPath, ...argv]` with `HEZO_WORKER=1`), forwards `SIGTERM`/`SIGINT`,
and on the worker's exit either propagates the code (normal exit/crash → external restart
policies behave as before) or, on the **restart sentinel** `UPDATE_RESTART_EXIT_CODE` (75),
applies the staged binary and relaunches. The supervisor branch sits in `index.ts` right
after the `restore` subcommand and before preflights, so dev (`bun run`) and `hezo restore`
never supervise. The `updater.ts` service handles the rest. Staging is **proactive**: the
idempotent `ensureUpdateStaged()` downloads the platform asset + `SHA256SUMS`, verifies the
hash, and stages to `<dataDir>/.update/staged[.exe]` (recording lifecycle + an `updatedAt`
timestamp in `state.json`), retrying once on failure. A second failure leaves `state.json` in
`Error`, but that's honored only for a **cooldown** (`STAGE_ERROR_COOLDOWN_MS`) — a later poll
re-attempts so a transient failure self-heals instead of sticking forever; likewise a
`Downloading` state is respected only while **fresh** (`STAGE_DOWNLOAD_STALE_MS`), so a download
abandoned by a worker crash/restart is re-attempted rather than wedging staging permanently. It
runs from `GET /api/updates/status`
(fire-and-forget on every banner poll, gated on `isSupervisedWorker()`) and the daily
`update-check` cron (`HEZO_UPDATE_CHECK_CRON`), so a running instance usually stages a new
release within seconds. `POST /api/updates/download` (superuser) is the same download path on
demand; `POST /api/updates/apply` (superuser) gracefully shuts the worker down (`shutdownRuntime`
in `runtime-control.ts`, also wired to signals) and exits with the sentinel.
`applyStagedUpdate()` does the swap *while the worker is down*: copy
staged → a temp file adjacent to the target (avoids `EXDEV`), then **Unix** atomic `rename`
over the binary, or **Windows** rename-trick (rename the locked `.exe` aside, move the new
one in, verify, roll back on failure; stale `-old-` files swept on next supervisor start).
State survives the restart via the normal recovery path (`reconcileOnStartup`), and the
instance returns **locked** unless `HEZO_MASTER_KEY` is set (the web restart overlay polls
`/api/status` and reloads onto the master-key gate). `GET /api/updates/status` surfaces the
staged-update state plus an `autoUnlock` hint so the UI's confirmation can warn about the
master-key re-unlock. The web banner shows an **"Install & restart"** button only once the
binary is `Staged` (so the restart is instant); while the background download is in flight it
stays hidden. On a download `Error`, a self-applying instance shows a **"Retry download"**
button (which re-triggers `POST /api/updates/download`) with the GitHub release as a secondary
link; an instance that can't self-apply falls back to the **"Download"** release link.

**Known limits.** macOS binaries are unsigned (built on Linux; clear quarantine with `xattr -d`);
on Apple Silicon an unsigned replacement may still be Gatekeeper-blocked. Windows self-update
relies on the rename-trick and is not exercised by CI (manual validation). The supervisor keeps
running its own old code until a full process restart — only the worker is refreshed.

**Anonymous usage telemetry.** `services/telemetry.ts` builds a daily aggregate snapshot of the
whole install — counts of teams/projects/agents, tasks by status, tasks completed and agent-run
input/output token sums over the last 24h, and the per-provider run mix — plus the version and
`os`/`arch`. It carries a random per-install id persisted in `system_meta.instance_id`
(generated lazily via `getOrCreateInstanceId`, `ON CONFLICT DO NOTHING` so it is stable). It
deliberately excludes every name, prompt/content field, repo detail, user identity, and any
`cost_cents`/monetary figure. The `JobManager` `telemetry` cron (`HEZO_TELEMETRY_CRON`, default
`0 0 5 * * *`) is registered only when `config.telemetry.enabled` (opt-out — on by default,
disabled by `--disable-telemetry` / `HEZO_TELEMETRY_ENABLED=0`). `reportTelemetry` POSTs the JSON
to `config.telemetry.endpoint` (default `https://hezo.ai/api/telemetry`) with a direct `fetch` +
5s timeout — like the update check, server-originated outbound calls do **not** route through the
agent egress proxy — and fails soft (warn + swallow) so it never disrupts a run. The collector
(a Cloudflare Pages Function backed by D1 in the website repo) stamps the receipt date and
upserts one row per `(instance_id, UTC day)`; aggregates are shown at `hezo.ai/stats`.

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
- **Tasks & collaboration** — `tasks`, `goals` (CRUD + `/goals/runs` + `/goals/:id/history`),
  `comments`, `mentions`, `assets`, `inbox`, `search` (full-text).
- **Money & governance** — `costs` (project-scoped, `group_by=day` for charts),
  `model-pricing`, `approvals`, `audit-log`.
- **Integrations & secrets** — `ai-providers`, `secrets`, `mcp-connections`, `oauth`
  (connectors: ensure / auth-start / device / callbacks), `skills`.
- **Ops** — `health`, `updates`, `preview` (HMAC-signed file URLs), public assets.

One non-REST surface shares the port: the **MCP endpoint** (`POST /mcp`, Streamable
HTTP), whose tools mirror the REST surface and enforce the same authorization. It is the
interface agents drive — tasks, comments, approvals, credentials — and external agents
can drive it too, with an **API key** (minted by an admin, or obtained by
**self-registration** — pending admin approval, then admin-equivalent across every
project/team; § 10). It also exposes `POST /mcp/assets` (multipart) for binary uploads,
since JSON-RPC can't carry a file. **API keys authenticate the MCP surface only**; REST is
the user-JWT (human/browser) surface. `GET /SKILL.md` serves the
manifest that teaches an external agent how to use it — including the connect/register
flow — and `GET /llms.txt` points to it. The matching **human** reference — a full
tool-by-tool page with parameters and return shapes — is generated from the same registry
by `packages/server/scripts/build-mcp-reference.ts` (run under `bun run build:docs`, guarded by
`mcp-reference.test.ts`) and committed as `docs/reference/mcp-api.md`. Authorization for
both the REST and MCP surfaces is § 10.

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
