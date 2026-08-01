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
| Database | Behind the `Db` interface (`src/db/database.ts`): **PGlite** (embedded Postgres, in-process, persisted to `~/.hezo/pgdata`) by default, or **external Postgres 14+** via `--database-url`/`HEZO_DATABASE_URL` (node-postgres pool) |
| Frontend | React 19 + TanStack Router + TanStack Query, Tailwind + Radix UI; bundled into the binary |
| Realtime | WebSocket row-change events → client invalidates React Query keys |
| Agent interface | MCP (Streamable HTTP) at `POST /mcp` via `@modelcontextprotocol/sdk` |
| Crypto | AES-256-GCM at rest; master key held in memory only |
| Containers | Docker Engine API or a managed sandbox service, behind one `ContainerEngine` seam — a pool per project, one run per container, started on demand and retired after a fixed 2-minute idle window |

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
- **`agents/`** holds role prose by team (`software-development/`, `blank/`), the two
  instance roles (`_instance/ceo.md`, `_instance/coach.md`), and reusable `_partials/`.
  The build bakes only `blank/` + `_instance/` into `agents-bundle.json` (the DB seed reads
  them at startup); marketplace team dirs (those with a `team.json`) are compiled into
  committed `marketplace/teams/*.json` and **excluded from the binary** (see § Team
  marketplace). See `AGENTS.md` › Layout for which layer (`SHARED_INSTRUCTIONS`, a
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
container config, dev ports, the designated repo, `is_internal` (only HQ), and a nullable
`archived_at` soft-delete stamp (NULL = active). Archiving a project (superuser-only
`POST /projects/:id/archive`, from the settings page) sets `archived_at`, stops the
container, and cancels in-flight runs; the `GET /projects` index filters to active by
default (`?filter=active|archived|all`, mirroring the docs/assets soft-delete), so an
archived project drops out of the left rail while keeping its tasks/history. Unarchiving
(`POST /projects/:id/unarchive`) clears the stamp and restores rail visibility.

**Rail order.** `projects.display_order` (INTEGER NOT NULL) is the operator's own ordering
of the project rail, ascending — 1 is the topmost avatar. Every project listing sorts
`display_order ASC, created_at DESC`; the tiebreak preserves the newest-first behaviour the
rail had before the column existed (migration 042 backfilled positions in exactly that
order, so upgrading is a visual no-op). `project-create.ts` inserts at
`MIN(display_order) - 1` so a new project still lands on top without renumbering anything;
values drift negative and self-heal, because a reorder renumbers the whole visible list
back to 1..N. Reordering is `PUT /project-display-order` with the full ordered id list —
a *collection*-level route (it spans projects across many teams, so it takes
`requireSuperuser` rather than `requireProjectAccessMiddleware`, and lives outside the
`/projects/…` tree because Hono's `/projects/:projectId/*` pattern also matches
`/projects/<word>`). It renumbers in one `unnest … WITH ORDINALITY` statement, rejects
archived/internal/unknown ids with a 400, and signals `broadcastProjectsChanged` on the
global `projects:global` room (no row data — the index is authorized per caller) so every
open shell re-orders live. The MCP `list_projects` tool is deliberately unaffected and
keeps its alphabetical `ORDER BY p.name`.

**Repos.** `repos` stores a GitHub `owner/repo` identifier; the segment after the owner
is the display label, worktree directory name, and `@mention` handle. The **first** repo
linked to a project becomes its immutable `designated_repo_id` (`ON DELETE RESTRICT` +
a 409 `DESIGNATED_REPO_IMMUTABLE` guard). Adding a repo is **asynchronous**: `POST
/repos` validates GitHub-side access (or creates the repo upstream), inserts the row
with `setup_status = 'pending'` and its `can_push` verdict, and returns immediately; the slow half — container up,
in-container clone, first-repo designation + approval finalize — runs in a tracked
background task (`services/repo-provisioning.ts`) and settles the row to
`ready`/`failed` (`setup_error` records why), broadcast to the team room as a `repos`
UPDATE. Failures never delete the row: designation is still deferred until a checkout
exists (the gate never half-opens), and POSTing the same repo again reclaims a
`failed` row back to `pending` and re-runs setup (a live `pending` duplicate 409s
`REPO_SETUP_IN_PROGRESS`; a `ready` duplicate 409s `REPO_NAME_TAKEN`). Rows still
`pending` at boot were lost with the previous process — `JobManager.reconcileOnStartup`
parks them `failed` so they surface as retryable instead of spinning forever.

**Push access (`repos.can_push`).** A 200 from `GET /repos/:owner/:repo` proves only
*read* — a read-only collaborator gets one, and so does anyone on a public repo — so
`validateRepoAccess` (`services/github.ts`) also reads `permissions.push` off that same
response and `repos.can_push` records it (`true`/`false`/`NULL` = unknown, never assumed
true). `refreshRepoPushAccess` (`services/repo-push-access.ts`) re-checks it wherever the
server already holds the connection token — `performRepoSetup` (link, retry, reclone) and
the admin `git-state` panel — so an access change made on GitHub after linking is picked
up. Only a definitive answer overwrites the stored one (`permissions.push` on a 200, or a
hard 403/404); a locked vault, a network failure, or a 5xx leaves it untouched rather than
demoting a writable repo to read-only. `can_push === false` never blocks the link (a
read-only reference repo is legitimate) — it surfaces as a "No write access" badge in the
Git settings page and as a per-repo read-only note in the agent's Repository prompt block
(`buildRepositoryBlock`). Nothing about a run is per-repo scoped — one account-level SSH
key and one account-wide OAuth token serve every linked repo — so this column is the only
place a genuine per-repo write restriction is represented.

**Tasks & threads.** `tasks` are Linear-style tickets with a frozen `identifier`
(`<task_prefix>-<n>`, e.g. `IN-42`), a required `assignee_id → members.id`, `rules`, and
an agent-maintained `progress_summary`. Numbering is atomic via `project_task_counters`.
`task_dependencies` is the many-to-many blocking graph (`UNIQUE`, no self-blocks).
`task_comments` is **polymorphic** over a `content_type` enum + `content` JSONB — `text`,
`system` (timeline entries like `status_change`/`title_change`/`description_change`/`task_link`),
`run` (auto-written on run completion), `preview`, `action`,
`connect_required`, `credential_request`. Each comment carries a `public_id` slug for
`#comment-<id>` deep-links. A `task_link` entry records **where** in the source task the
mention was written: `source_kind` (`description` | `comment`) plus, for a comment,
`source_comment_public_id` - the anchor the renderer links to, so following a link lands on
the sentence that created the relationship rather than only on its task. Rows written before
the origin was tracked carry neither field and render as description-sourced ones do. The
dedupe stays keyed on `source_task_id` alone, so a target records one entry per related task
(first mention wins) regardless of origin. A human-authored comment keeps `author_member_id` null by
convention but records **which** human in `author_user_id` (nullable FK to `users`), so the
author's uploaded avatar (`user_icons`) resolves alongside their comments; the comments feed
returns a signed `author_icon_url` per row (a human's `user_icons` image, or an agent's
`agent_icons` image via `author_member_id`, else null → initials). `comment_reactions` holds
emoji reactions, keyed by a non-null `member_id` (unlike a comment's nullable
`author_member_id`, which lets an admin author as a null-member "Admin"). Because a reaction needs a real member, a human acting in
a team they can access but aren't a member of resolves to their **HQ (default-team)**
membership (`resolveReactorMemberId`) — the same cross-team identity HQ agents use to act in
other teams' projects — so a superuser can react anywhere, not only in HQ or teams they created.
Title and description edits are recorded on the thread from **both** update paths
(`recordTitleChange` / `recordDescriptionChange` in `services/task-events.ts`), so an agent's
edit leaves the same entry a human's does. A `description_change` payload carries a capped
preview of each end plus the full lengths, never the bodies: the comments skeleton route and
the MCP `list_comments` tool both return a system comment's `content` whole, so a stored body
would ride into every comment fetch and every agent prompt for the life of the task. The
matching `task.updated` audit event omits both ends for the same reason.
Marking a task `done` is gated in both update paths (REST PATCH and MCP `update_task`,
shared helpers in `lib/task-relationships.ts`): every sub-task terminal, no outstanding
pinged-agent activity by others (active runs, pending mention/comment/reply wakeups), and —
for **agent callers only** — no active `@admin` mention on the task lacking a later human
`text` comment (an unanswered ask holds the task in a non-terminal status until a human
replies on the task or closes it themselves; reading the mention does not count).
`cancelled` is deliberately ungated.

**Task hierarchy is mutable.** `tasks.parent_task_id` is a nullable self-FK
(`ON DELETE SET NULL`, `idx_tasks_parent`) and can be changed after creation through the
same two update paths (REST PATCH and MCP `update_task`) that own every other field: a
value nests, an explicit `null` (or `''` over MCP) promotes to top level, an absent key
leaves it alone. Both surfaces call one shared guard, `resolveParentAssignment` in
`lib/task-relationships.ts`, which resolves the identifier-or-UUID and then rejects a
self-parent, a parent inside the moving task's own sub-tree (the only parent-cycle guard
in the system — `wouldCreateCycle` covers the *dependency* graph only), a parent in a
different project, a move that would breach the depth cap, and nesting an **open** task
under a terminal parent (which would break the invariant `assertChildrenAllClosed`
protects, leaving live work invisible under a reviewed, closed parent).
The depth rule is `depth(newParent) + 1 + height(movingSubtree) <= MAX_SUB_TASK_DEPTH`,
measured in one round trip by `measureParentPlacement` — two recursive CTEs walking up from
the proposed parent and down from the mover, each `team_id`-filtered (because `resolveTaskId`
passes any well-formed UUID through unvalidated) and depth-capped. `assertChildDepthAllowed`
is now a thin caller of that rule with `movingHeight` 0, which is exactly the create-path
behaviour it had before. A successful move records a `parent_change` system comment
(`recordParentChange`) and, when the mover was the former parent's last open sub-task, fires
that parent's `children_closed` wakeup via `wakeTaskIfChildrenClosed` — the same gate a close
would have cleared. The terminal-parent rule is deliberately **not** applied on the create
path, where filing a follow-up sub-task under a closed parent remains legal.

**Goals.** `goals` are per-project objectives the Captain tracks (`project_id NOT NULL`;
the `is_internal` HQ project has none, enforced in the service). Each carries a SMART
`title`/`description`, a `target_date`, a `check_frequency` enum (`daily`/`weekly`/`monthly`,
default daily), an admin-set `archived_at` (NULL = active; there is **no** achieved status),
and the Captain-maintained snapshot — `progress_percent` (0–100), a `goal_health` enum
(`pending`/`on_track`/`at_risk`/`off_track`), a `status_blurb`, and `last_checked_at`. The
Captain refreshes these on its heartbeat via a **progress-update run** (below). A goal is
**due** (`getDueGoals`) when its cadence has elapsed since `last_checked_at` (or it was never
checked), or on every heartbeat once its `target_date` has passed *while progress is below
100%* — at 100% the deadline override relaxes back to the cadence, and re-arms if progress
later regresses. Hitting 100% never retires a goal from checking: progress can drop back
below 100 and goals can be never-ending (measured continuously), so an active goal stays on
its cadence forever — only archiving stops checks. `goal_run_updates`
is the per-run progress history (one row per goal touched by a run, snapshotting
percent/health/blurb) — the source of each goal's progress chart and the project-wide progress-update
list on the Progress page. `tasks.goal_id` optionally links a ticket to the goal it advances
(traceability only; it does **not** gate or alter how the task runs), and `tasks.created_by_run_id`
/ `task_comments.created_by_run_id` attribute a ticket or comment to the run that produced it.
Together these back the goal detail page's per-goal **run activity** feed (`listGoalRunActivity`):
the progress-update runs that estimated *that* goal, created tickets linked to it, or commented on its
linked tickets. During a progress-update run the Captain may comment on an in-flight ticket instead of
filing a new one, and it can never re-open a terminal ticket (blocked in both the REST and MCP
update paths — only the admin can). A separate Captain-maintained **project progress summary**
(`projects.progress_summary` + `progress_summary_updated_at`, set via the `update_project_progress`
MCP tool) is the markdown blurb shown at the top of the Progress page.

**Secrets, OAuth, connectors.** `secrets` stores AES-256-GCM ciphertext gated by
`allowed_hosts` (§ 7). `oauth_connections` records connected GitHub/SaaS accounts; their
tokens *ride the `secrets` table* (no token column). `mcp_connections` is the catalog of
connectors — SaaS/local MCP servers injected into runs, plus direct-REST `api`
connectors that carry no MCP server (§ 9). `secrets` is **instance-global**
(`secrets.name` globally unique). `oauth_connections` and `mcp_connections` are
**scoped by project** via a nullable `project_id` (FK → `projects`, `ON DELETE CASCADE`):
a non-NULL value makes the row private to that project (so two projects can connect
*separate* GitHub/SaaS accounts), while `project_id NULL` is the global "all projects"
scope (the instance-admin surface and pre-existing rows). Uniqueness is per-scope via
partial indexes — `(provider, provider_account_id)` / `(name)` where `project_id IS NULL`,
and `(project_id, …)` where non-NULL. A run resolves the connectors/identity for **its
task's project**: the project's own rows plus global ones, a project row shadowing a global
of the same name. `team_ssh_keys` is separate — one Ed25519 key **per team**
(`UNIQUE(team_id)`, and therefore per project given the 1:1), encrypted on the team row,
never in the vault (§ 8).

**Runs, wakeups, sessions.** `agent_wakeup_requests` is the trigger queue, with
idempotency keys and `coalesced_count` merging (§ 5). `heartbeat_runs` is one row per
execution (status, timing, tokens, cost, captured logs, `wakeup_id` provenance, the
success-gate flags `produced_output`/`reported_no_work`). A `kind` enum distinguishes a
normal `task` run from a `progress_update` run (the Captain's task-less goal assessment —
`task_id IS NULL`); progress-update runs reuse the full run lifecycle but skip the task comment,
status flip, and code worktree. They fire on the Captain's heartbeat when goals are due
(`JobManager.tryDispatchProgressUpdate` → `getDueGoals`), and can also be triggered on demand from
the Goals page's **Run now** button (`POST /projects/:projectId/goals/run-now` →
`JobManager.dispatchProgressUpdateNow`, which resolves the project's Captain and reuses the same
due-goal logic). If **Run now** hits a *transient* conflict — the Captain is already running, the
instance is at its active-container limit, or a launch race — the run is
**queued** rather than erroring: a task-less `agent_wakeup_requests` row tagged
`payload.trigger='progress_update_now'` (deduped per Captain by `createProgressUpdateWakeup`, so
"Run now" is idempotent) that the 5s dispatcher retries until the Captain frees up. This trigger tag
also makes such a wakeup guard against fall-through: when it is finally dispatched, `activateAgent`
runs *only* the progress update — it never lets the Captain pick up ordinary task work — and completes
the wakeup as a no-op if nothing is due by then. A queued run is listed/cancelled through
`GET`/`POST /projects/:projectId/goals/queued-run[/:wakeupId/cancel]` (scheduled heartbeat checks
carry no trigger tag, so they are never surfaced or cancellable here). The isolation is
two-way: `createProgressUpdateWakeup` never coalesces onto a heartbeat wakeup, and
`createWakeup`'s generic coalescing skips marker-carrying (`payload.trigger`) rows — so a
scheduled heartbeat firing while a manual run is queued gets its own row instead of
claiming (and then mis-dispatching) the queued manual run. Token usage is flushed to the
row *during* the run (alongside the log), so a run the server kills mid-flight still
reports the tokens/cost it burned instead of `0`; `usage_partial` flags such a snapshot
until a clean completion supersedes it. `agent_task_sessions` persists
per-task session state for compaction across heartbeats. `chat_sessions` /
`chat_conversations` / `chat_messages` back the live realtime chat (today the CEO
chat) — generically named so the schema is first-class for a chat with any agent:
a conversation carries `member_id` (the agent) + `team_id` + `project_id`, a session
the same, and a message an `author_member_id` (the responding agent). `chat_message_attachments`
links files sent through the chatbox to their message (stored in the HQ asset library
under `uploads/chat/`), and `chat_memories` holds each chat-enabled agent's
automatically-maintained long-term memory (§ 4).

**Multi-thread conversations, one home surface per thread.** The CEO chat is
**multi-threaded**, and every thread has exactly **one home surface**: a web thread, a
Telegram DM, a topic in the operator's designated Topics supergroup, a Slack DM, a Slack
channel, a Discord DM, a Discord channel — each is its own `chat_conversations` row.
There is **no mirroring**: nothing started on one surface ever creates or posts into a
thread on another. The conversation row's `channel` + `external_thread_id` **is the
inbound routing key** — `findConversationByOrigin(channel, externalThreadId)` resolves an
open conversation or a new one is created (so closing a thread from the web and DMing
again starts a fresh thread; there is no bindings table). **The web view is the hub**:
`listConversations` returns **all** kinds with their `channel` + `kind`, so the chatbox
lists every thread from every surface, badged by origin — assistant threads fully
interactive, coworker threads read-only (`POST /api/chat/messages` 409s on them).
Delivery is **reply-where-asked**: `finalize` delivers a completed reply to the **turn's
origin surface** (`ConversationContext.channel`, captured per turn) — a web-composed turn
into a Telegram-DM thread answers on web only, a Telegram message answers in Telegram —
via the manager's `ChannelHooks.deliver` → the registry adapter. Close parity is scoped
to the origin surface only: `closeConversation` calls the adapter's optional
`closeThread` for its own external thread (e.g. archiving the designated supergroup's
topic), and the platform→app direction runs via `parseClose` →
`closeConversationByExternalThread`. The warm container (`chat_sessions`) stays a
**single shared lease** per CEO member — a thread is only message-grouping + rolling
window + memory scope, and each turn is a stateless one-shot `docker exec` reading a
per-turn prompt file, so N threads run as N independent execs into the one container.

**A session survives its container being suspended.** Because it holds no long-lived
process — each turn is its own exec and continuity lives in `chat_conversations` /
`chat_messages` — a container that stops with its filesystem intact takes nothing the
session needs. `checkHealth` therefore separates two events it used to conflate. A
**different** container (id changed, or the project has none) means the filesystem is
gone, so the session is torn down as before. The **same** container, stopped, is a
suspend: `ChatSessionStatus.Suspended` parks the row, the host-side allocations are
released, and the next turn resumes into it via `resumeSession` rather than starting
over, keeping the session id that anchors its messages. This is what makes a managed
backend usable at all — it suspends sandboxes on its own idle timer, so tearing down
would end the operator's session every quiet period.

Resume is not a no-op, which is why the host-side half of `startSession` is extracted as
`allocateHostSide`: the ssh agent socket and egress proxy allocation live on the Hezo
side, are released at suspend, and come back on **different ports**, so the exec command
and env have to be rebuilt around them (two copies of that sequence is what the
second-call-site rule exists to prevent — a drifted copy would mean a resumed chat
silently losing commit signing or secret substitution). `suspended` counts as **live**
everywhere it matters: the singleton index is stated as "not terminal" so a parked
session still blocks a second one, and a process restart reclaims it as crashed like any
other live row. It is deliberately **not** accepted by `authMiddleware` — a parked
session has no host-side half, so no exec of it can legitimately be calling. In the
container pool the chat's container is pinned (`reserved_for_chat`), which suspend keeps
and teardown releases: chat is exempt from the container cap, and the pin is the other
half of that, since a task run taking the container out from under a live session is the
same interruption by a different route.
Long-term memory (`chat_memories`) stays **per-agent** (shared across a member's
assistant threads); compaction serialises at the member level so concurrent threads never
clobber the shared memory row. External channels (Telegram, Slack, Discord) are built on
a **channel-adapter registry** (`services/chat-channels/`): a `ChatChannelAdapter` owns
everything platform-specific (inbound parse, outbound deliver, optional thread close,
transport lifecycle, group-mode capabilities), and the manager/routes resolve a channel
only through the registry — a new app is one adapter file. Inbound arrives two ways: a
**webhook** channel (Telegram) at the generic public route `POST
/webhooks/chat/:channel/:secret` (mounted before bearer auth; per-channel shared-secret,
constant-time compared), which dispatches `parseGroupMention` → `parseInbound` →
`parseClose` → `observeMessage` in that order; a **socket-transport** adapter (Slack
Socket Mode, the Discord gateway) has no webhook — its transport pushes parsed events
through the `InboundEventSink` wired at startup (`buildInboundEventSink` → the same
ingest functions the webhook route calls). DMs flow through `ingestInboundEvent`, which
enforces the **identity allowlist** (`chat_identity_links` maps `(channel,
external_user_id)` → a Hezo user; unlinked senders are ignored/prompted to link) before
routing to `ChatSessionManager.sendTurn`. Per-channel bot config lives in
`chat_channel_configs` (fully generic — the bot token is a `secrets`-vault reference, all
channel-specific settings in `metadata` jsonb; a channel needing a **second** secret
stores its vault name in metadata, e.g. Slack's `app_token_secret` → `SLACK_APP_TOKEN`).
**Bot tokens are decrypted in-process by trusted server code and outbound bot API calls
go direct** (`api.telegram.org`, `slack.com`, `discord.com`, …), NOT through the agent
egress proxy — the `__HEZO_SECRET__`/proxy mechanism is for agent *runs*, whose threat
model differs from the server authenticating its own calls.

**Group/coworker mode (`kind = 'coworker'`).** Every chat app can support two integration
modes, discriminated by `chat_conversations.kind`: **assistant** (DM mode — allowlist-gated,
fully interactive from the web) and **coworker** — the CEO invited into an external group
channel (a Slack channel, a Telegram group, a Discord channel) as a teammate. A
group-capable adapter implements the optional capability trio `parseGroupMention` /
`supportsGroupMode` / `fetchThreadContext` (history access is **mandatory** for group mode
— a coworker without channel context is pointless), and mentions flow through a **second
ingest path**, `ingestGroupMentionEvent` (`chat-channels/ingest-group.ts`) — never through
`ingestInboundEvent`. Coworker semantics, all keyed off `kind` in `ChatSessionManager`:
**channel invite is the authorization** (no identity-link gate; a link only enriches
attribution); the thread is **read-only in the web view** (listed under "Team channels",
composer disabled, REST 409 — the write surface is the platform itself, where the
ephemeral channel context lives); concurrent turns **queue instead of interrupting** (two
mentions = two answers; an aborted partial would post nothing to the platform); prompts
swap in a group-chat guide, label transcript lines with the platform sender
(`chat_messages.author_label`), omit the operator's long-term memory, and carry the
adapter-fetched platform history plus any reply-quote as an **ephemeral `injectedContext`
prompt section** (fetched history first, inline quote last) that is never persisted as a
message; and coworker threads **never compact or auto-title** (a bounded replay window
caps the prompt instead — compaction would fold group chatter into the operator's shared
memory). Per-adapter history strategy and transport: **Slack** (`chat-channels/slack.ts` +
`slack-socket.ts`) fetches `conversations.history`/`replies` on demand and runs both modes
over **Socket Mode** — a zero-dependency WHATWG-WebSocket client (`apps.connections.open`
mints single-use tickets; envelopes are acked before dispatch; Slack-initiated
`disconnect` refreshes reconnect with backoff; a rejected app token stops the client);
Slack **load-balances events across an app's open Socket Mode connections**, so no
cross-instance ownership lease is needed. **Telegram** (`chat-channels/telegram.ts`) has
**no history API**, so context comes from **passive accumulation**: the webhook route
hands unclaimed group messages to `observeMessage` → `chat_observed_messages`, a bounded
rolling buffer (~200/chat, deduped on message id, pruned per chat, topic-scoped reads),
and `fetchThreadContext` reads it back — requires BotFather privacy mode off; mention =
`@botusername` or a reply to the bot; `parseInbound` accepts only private DMs and the
designated Topics supergroup, so team-group chatter can never leak into the DM path.
**Discord** (`chat-channels/discord.ts` + `discord-gateway.ts`) fetches `GET
/channels/{id}/messages` on demand and connects over the **Discord gateway** — a
zero-dependency client speaking HELLO/IDENTIFY/RESUME with sequence-tracked heartbeats
and the `MESSAGE_CONTENT` intent. The gateway is **true fanout** (every open connection
receives every event, unlike Slack's load-balancing), so the adapter holds a
**single-instance ownership lease** (`metadata.gateway_owner` `{id, ts}`, 90s TTL,
renewed from the heartbeat timer, compare-and-swap on the config row) and stands the
client down if another holder takes it — the guard against double-answering when two
server instances share a database. Discord threads carry their own `channel_id`, so they
become separate conversations with no extra handling.

**Costs & budgets.** `cost_entries` is the immutable per-run spend ledger, attributed to
the AI provider config that produced it — **never** team-scoped. `model_pricing` holds
per-model token rates from a single source: the pricepertoken.com MCP catalog
(`get_all_models` over raw JSON-RPC), fetched at boot and daily by the job manager and
upserted as `source='pricepertoken'`; a migration bakes a catalog snapshot into the
table so a fresh instance prices runs before its first fetch, and `source='manual'`
operator overrides win at lookup. The catalog carries no cache rates, so cache
reads/writes bill at the full input rate — recorded costs are a conservative upper
bound (a manual override can set cache rates for exact billing). Budgets are **windowed and computed on
demand**: limits live as `daily_/weekly_/monthly_budget_cents` on `member_agents` and
`projects` (0 = unlimited; there is **no team budget**), and spend is summed from
`cost_entries` over rolling UTC windows — no counter, no reset event (§ 5). A run killed
mid-flight never reaches the run-completion cost record, so `reconcileOnStartup` charges
its surviving partial `cost_cents` on reboot (shared `recordRunCostAndEnforce`) — an
interrupted run still counts against budgets.

**Docs, skills, assets.** `documents` is one table backing three Markdown kinds by
`type` (`project_doc`, `team_preferences`, `agent_system_prompt`), each with partial
unique scoping and full revision history in `document_revisions`. Project docs additionally
carry a `description` (a short overall "what this is" summary, one or two sentences, migration 037) surfaced in the Documents
list/header, in `list_project_docs` / `read_project_doc`, and — in place of the long-unused
`title` column — in the `{{project_docs_context}}` run manifest; agents set it via
`write_project_doc`, admins via the doc PUT, both threaded through `upsertDocument` with a
`COALESCE` so an omitted value leaves the existing description untouched (a description-only
edit records no revision). `read_project_doc` returns the body in UTF-8 byte windows
sized under the MCP result cap (an `offset`/`max_bytes` request plus a `next_offset`
cursor and `total_bytes`/`returned_bytes`/`truncated` flags), so an agent pages a doc of
any size instead of hitting `result_too_large`; the window end is snapped to a codepoint
boundary so a multi-byte character is never split. The `team_preferences`
document is the project's **Custom Prompt** — a per-team instruction block injected verbatim
into every in-project agent's prompt via `{{team_preferences_context}}`; it is edited from the
web **Settings → Custom Prompt** page (`PATCH /api/projects/:projectId/custom-prompt`) and, for
agents, via the `get_project_custom_prompt` / `update_project_custom_prompt` MCP tools (the write
tool gated to the CEO, Coach, or the project's Captain). The REST path and the MCP tool names are
kept in parallel (`custom-prompt` ↔ `..._project_custom_prompt`) per the naming-parity rule in
AGENTS.md; only the underlying `DocumentType.TeamPreferences` and `{{team_preferences_context}}`
keep their historical names.
`review_comments` (renamed from `document_review_comments` in migration 025) holds the
admin's review feedback on **exactly one target per row** — a project doc (`document_id`)
or an asset (`asset_id`), enforced by CHECK. Doc rows keep their original shape: each
anchors a `comment` to an exact `quote` + `occurrence` (nth match) over the document's
rendered text stream, plus the `doc_updated_at` it was authored against (creates carry
the client's `updated_at` and 409 on mismatch). Asset rows carry `asset_sha256` (the
content hash at authoring time — the asset-side stale token) and follow a per-type anchor
rule (`isTextReviewableAssetMime` in `@hezo/shared`): **text assets** (markdown,
`text/plain`) anchor with `quote`/`occurrence` exactly like docs; **every other type**
(images, SVG, HTML, PDF, audio, …) takes un-anchored whole-asset comments (`quote` NULL).
Region (rect) anchors for visual types are deliberately future work: the sketch is
normalized `[0,1]` rect columns on `review_comments` plus a pointer-capture drawing
overlay, with the caveat that HTML assets render in a sandboxed opaque-origin iframe the
parent can't read scroll/height from, so HTML rects would need a fixed design-frame
render (e.g. 1280×2560). Review comments are **version-scoped**: any content-changing
doc write — admin PUT, agent `write_project_doc`, or a revision restore — deletes all of
that doc's comments inside the same transaction (`services/documents.ts`), and any
`write_project_asset` overwrite deletes the asset's comments inside the upsert's
transaction (`upsertProjectAsset` in `lib/asset-name.ts` — mandatory there, since the
overwrite swaps the asset row's **id** and would otherwise trip the FK; hard deletes
cascade via `ON DELETE CASCADE`). So anchors can never go stale; a no-op doc save keeps
them, while an asset overwrite always wipes (the id swaps even for identical bytes).
Agents read them via `read_project_doc` / `read_project_asset` (returned alongside the
content); admin CRUD is REST-only (`services/review-comments.ts`), docs addressed by
filename (`/docs/:filename/review-comments`), assets by **asset UUID**
(`/assets/:assetId/review-comments` — asset paths contain `/`, and the id doubles as a
stale token; archived assets 403 mutations while GET stays readable). Broadcasts keep
per-target WS family names (`document_review_comments` / `asset_review_comments`) so
each side prefix-invalidates only its own query keys. The web renders doc highlights as
`<mark>` marks with margin icons on the three doc view surfaces (preview route,
task-sidebar panel, Documents tab view mode) via a rehype plugin
(`packages/web/src/lib/rehype-review-highlights.ts`); the shared interaction core
(selection pill, hover-line ghost, margin icons, editor) is extracted into
`ReviewSurface` (`packages/web/src/components/document-review/review-surface.tsx`), which
the asset viewer reuses for text assets (markdown through the same rehype plugin, plain
text through `PlainTextWithHighlights`). Those same three surfaces each carry
`DocumentDownloadMenu` (`packages/web/src/components/document-download-menu.tsx`) — a
client-side save of the already-loaded content as Markdown (verbatim) or plain text
(`markdownToPlainText`), no server round-trip; the two preview surfaces render it in the
compact `variant="icon"` form that matches their icon-only header clusters. Each project-doc revision carries a
**changelog** (`change_summary`): the web PUT forwards `change_summary` and the MCP
`write_project_doc` tool takes an optional `changelog`, both stored on the revision recorded for
the *prior* content; `restoreRevision` writes `Restored content from revision N`. The single-doc
GET returns `created_at` + a resolved `last_updated_by_name`/`last_updated_by_type`, feeding a
structured **metadata banner** on the Documents page (created/updated + last editor — no
more run-on metadata paragraph; a conservative display-only strip hides any legacy leading metadata
block from the rendered body). Project docs are **archivable**
(the soft delete — `archived_at`/`archived_by_member_id`, `setDocumentArchived`, which
records no revision and leaves `last_updated_by_member_id` untouched; see the assets paragraph below for the full archival contract shared by
docs and assets, incl. the Active/Archived/All web filter and the MCP `filter` key). A **revision-history dialog** shows each version's changelog
rendered like a task comment; `buildDocVersionHistory`
(`packages/web/src/lib/doc-version-history.ts`) pairs each version's content with the changelog
that *produced* it (a one-step shift, since revisions snapshot prior content), so the current
head's changelog is the newest revision's `change_summary`. Selecting an older revision renders it
read-only with the review layer suppressed — review comments exist only for the latest content —
under a "viewing revision N" banner. Restore stays admin-only (agents 403 on the REST route; no
MCP restore tool). `skills` is the reusable-know-how reference store
(manifest-injected into runs, full-text-searchable) with `skill_revisions` history. One skill
is **virtual**: the read-only `connector-recipes` skill is rendered from the bundled connector
registry, not a DB row, and its slug is reserved on every mutation surface (§ 9). Each skill is
**scoped** by a nullable `skills.project_id` (mirrors `mcp_connections`, migration 024): **NULL =
global** (shared with every project), a **non-NULL project id = private to that project**. Slug
uniqueness is partitioned into two partial unique indexes (`(slug) WHERE project_id IS NULL` +
`(project_id, slug) WHERE project_id IS NOT NULL`), so the same slug can exist once globally and
once per project, and a project skill **shadows** a global one of the same slug within that project.
Run-time reads (the `{{skills_context}}` manifest, `list_skills`/`get_skill`, full-text search,
mention resolution) return the run's project skills plus globals, de-duped so the project's copy
wins. Skills authored during a run (`create_skill`/`fetch_skill_file`/`propose_skill`) carry a
`scope` the agent chooses (`global`|`project`), defaulting to **project**. Hezo also ships a
**default global-skills library**: the top-level `skills/` dir (one `<slug>.md` per skill, flat;
`ATTRIBUTION.md` documents upstream licenses and is excluded) is bundled into the binary as
`skills-bundle.json` (`build:skills`, same embed pattern as agents/docs). A **fresh instance**
installs the whole catalog automatically: `installDefaultSkillsIfFreshInstance` runs at startup
just before `seedDefaultTeam` and installs when HQ (`DEFAULT_TEAM_ID`) doesn't exist yet (i.e.
first boot), a no-op on every later boot. An **existing instance upgrading is NOT auto-seeded** —
15 global skills must not materialize unasked — so the admin installs them from `/settings/skills`:
`GET /api/skills/defaults` returns the **missing** defaults and, when non-empty, the page shows an
**Add default skills** button that opens a confirmation listing them;
`POST /api/skills/defaults/install` (optional `slugs[]` for the confirmed subset) inserts them.
(The startup path is the only auto-install trigger; test harnesses call `seedDefaultTeam` directly
and never install defaults, keeping fixtures clean.) "Missing" (`listMissingDefaultSkills`, `db/default-skills.ts`) =
a bundled default whose slug is not currently a global skill **and** carries no per-slug
`system_meta` marker (`default_skill_shipped_hash:<slug>`, set to the content sha256 on install).
The marker means "handled here", so a default the operator installed and later deleted is never
re-offered, and a user-authored skill already occupying the slug is never clobbered
(`INSERT … ON CONFLICT (slug) WHERE project_id IS NULL DO NOTHING`). Installed rows are ordinary
editable skills (`readonly: false`, `created_by_member_id` null) — unlike the virtual
`connector-recipes`. The admin manages the
whole catalog and re-scopes rows at `/settings/skills` (id-addressed `/api/skills` routes); a
per-project page (`/projects/:projectId/skills`, any project member) lists that project's skills
plus globals and edits/removes only the project's own. `assets` + `task_attachments`/`comment_attachments` handle
uploaded files (blobs in the configured **asset store** keyed by `projectId/assetId` — see
§ Asset storage below — served over HMAC-signed URLs with
`nosniff` and a basename-only download filename); agents can also author assets
directly with `write_project_asset` — text formats (HTML, SVG, plain text/scripts, and markdown
such as a blog post; script extensions like `.sh`/`.py`/`.js` store as inert `text/plain`) with
the default `utf8` encoding, and **binary** formats (any type a human can upload: PNG/JPEG/GIF/WebP,
PDF, media, and archives — zip/tar/gzip/7z/rar) by passing `encoding: 'base64'` with the file's bytes
base64-encoded in `content`. The
allowlist is the shared attachment allowlist (`isAllowedAttachmentMime`), a non-text type without
base64 is rejected, and the 10 MB cap applies to the decoded bytes. **Archives are opaque**: nothing
server-side ever unpacks one, so there is no decompression surface — an agent that needs the contents
downloads the blob through its signed URL and unpacks it inside its own container (`unzip`, `tar` and
`7z` are pre-baked in the agent image; `.rar` needs a runtime install). Two shared rules follow from
that opacity: an archive extension is **authoritative** over the uploader-declared content type
(`ATTACHMENT_EXTENSION_AUTHORITATIVE_MIME` in `resolveAttachmentContentType` — browsers spell one
archive format several ways, e.g. a `.zip` arrives as `application/x-zip-compressed` on Windows
Chrome/Edge, so deferring to the extension is both more robust and strictly narrower than honoring
the declaration), and an archive is never served inline (`isArchiveAssetMime` is the second reason
`assetContentDisposition` returns `attachment`, alongside the script-bearing
`ASSET_INLINE_UNSAFE_MIME`). The web's
**asset viewer** (`/projects/:slug/assets/view?file=<path>`, route file
`assets_.view.tsx`) is the canonical in-app link target for an asset — grid cards, asset
mentions (`assetPath` in `@hezo/shared`), comment-attachment thumbs, and chat attachment
chips all navigate there; raw view stays reachable via its "Open raw" toolbar button, and a
"Download" toolbar button saves any asset to disk — it links the signed serve URL with
`&download=1`, which makes `GET /api/assets/:id` send `Content-Disposition: attachment`
(via `assetContentDisposition(contentType, forceDownload)`) regardless of the asset's default
inline/attachment disposition. It
is a split-pane page (`ResizableSplit`): the left pane renders the content per type
(markdown with a rich preview + view-source toggle, plain text in a highlighted `<pre>`,
images/SVG via `<img>`, HTML in the sandboxed iframe, everything else a metadata card)
and the thin right pane lists the asset's review comments (see `review_comments` above) —
a resizable sticky column at `lg+`, a chevron-toggled slide-in drawer below (the task
page's side-panel pattern). **Folders are implicit
path prefixes** inside `assets.original_filename` (up to 2 levels, e.g. `launch/hero.png`) —
no folder table, `UNIQUE(project_id, original_filename)` keys the full path, and blobs never
move on a rename. Task-thread attachment uploads (`POST …/tasks/:taskId/assets`) auto-file
under `uploads/<task-identifier>` (`taskUploadsFolder` in `@hezo/shared`: the task identifier
e.g. `IN-42` sanitized to one segment, so the folder stays stable across renames), while direct
library uploads land in the folder the uploader chose. Reorganization: `move_project_asset`/`copy_project_asset` (MCP) and
`PATCH /api/projects/:id/assets/:assetId` (the web Move dialog, human-only) reorganize
metadata only, erroring on destination collision. **Archival is the agent-facing soft
delete** (docs and assets both carry `archived_at` + `archived_by_member_id`, migration
016): agents call `archive_project_doc`/`archive_project_asset` (reversible via the
`unarchive_*` twins, idempotent, no approval), humans archive via
`PATCH …/docs/:filename { archived }` / `PATCH …/assets/:assetId { archived }`. An archived
row keeps its slug/path reserved (uploads colliding with it auto-suffix) and existing
references keep resolving (mentions/resolve, signed asset serving), but every *discovery*
surface is active-only: the web pages default to an Active filter (Active/Archived/All is
client-side; the REST lists return `archived_at` for all rows), the MCP doc/asset list+read
tools take a `filter` key defaulting to `'active'` (`'archived'`/`'all'` opt in), full-text
search, doc autocomplete, and the `{{project_docs_context}}` run manifest all exclude
archived rows, and archived docs are read-only (writes/status/revision-restore return 409 /
tool errors until restored). **Hard deletion is human/admin-only** (agents get 403 on both
DELETE routes; in the UI Delete only appears on archived items — a deliberate two-step).
The legacy `request_asset_deletion` tool is gone, but its resolve endpoint
(`POST …/comments/:commentId/resolve-asset-deletion`, agents 403) and comment renderer
remain so pending `asset_deletion_request` cards from older instances stay resolvable —
approve deletes rows + blobs server-side, deny keeps everything, both wake the requester
(`asset_deletion_resolved`). `asset.created`, `asset.archived`, `asset.deletion_requested`,
and `asset.deleted` domain events feed the audit log (doc archival rides
`document.updated`); asset row-changes broadcast on the team room so the Assets page
live-refreshes. `project_icons`
(1:1 with `projects`, `ON DELETE CASCADE`) holds an optional per-project icon image —
unlike assets the **bytes live in the DB** (a `BYTEA` column) in a dedicated table so the
hot `projects.*` list query never pulls the blob; it is rendered on every surface that draws
a project avatar — the project rail (including the pinned HQ entry, which falls back to a
building glyph when HQ has no icon) and the home dashboard's Active cards and Other rows — and
served from a public HMAC-signed read route (`GET /api/projects/:projectId/icon`, the `sig`
query param is the credential since an `<img>` carries no bearer token). The serialized
project carries a freshly-signed `icon_url` (null when unset); the client normalizes any
picked image to a square PNG ≤512×512 before upload (`PUT`/`DELETE` on the same path).
`agent_icons` (1:1 with `member_agents`) and `user_icons` (1:1 with `users`, today just the
admin) reuse the same mechanism for agent avatars and the admin's own avatar — a dedicated
`BYTEA` table, a freshly-signed `icon_url` threaded onto the serialized agent/user row, and
a public HMAC-signed read route (`GET /api/agents/:agentId/icon`, `GET /api/users/:userId/icon`).
The signing/verification is generalized in `lib/entity-icon-urls.ts` (a `basePath` +
per-entity `keyPurpose`), which also owns `signAuthorIconUrl` — the shared resolver every
*feed* uses to turn a row's author/requester into a signed avatar URL (user icon when the
actor is human, else the agent icon; best-effort, so a signing failure yields null and the
row degrades to initials rather than failing the request). The comments feed
(`routes/comments.ts`), the admin-mentions inbox (`routes/inbox.ts` → `author_icon_url`) and
the approvals listing (`routes/approvals.ts` → `requested_by_slug` + `requested_by_icon_url`)
all go through it. The client control is `components/icon-upload-section.tsx`; agent
icons are edited on the agent Settings page (project-access-gated, like other agent config),
user icons on the global Settings → Users page (superuser-gated). No MCP tool — icon upload
is a human-only UI action (as for `project_icons`). The **CEO and Coach** — the HQ singletons that are identical across every
project — ship a **built-in default avatar** (a committed image under
`packages/web/public/avatars/`, bundled into the web app); the client resolves an agent's
effective avatar as `uploaded icon_url ?? defaultAvatarForSlug(slug) ?? initials`
(`web/src/lib/default-avatars.ts`), so a user upload always overrides the built-in default and
per-project roles (e.g. the Captain) get no shared default — they show initials until an avatar
is uploaded. Every agent-avatar surface (org chart, agent header, budget rows, agent-authored
comments, and the admin inbox — both the home "Needs you" rows and the full inbox's mention /
approval cards) applies this resolution.

**Governance & misc.** `approvals` (polymorphic board decisions), `audit_log`
(append-only, project + instance scopes — `project_id` set scopes a row to one project,
NULL marks an instance-level action; never updated/deleted by the app),
`api_keys` (instance-scoped MCP credential, sha256-hashed `hezo_` prefix, `status`
pending/approved — admin-minted keys are born approved, self-registered ones await admin
approval), `invites`, `admin_mentions` (board inbox — one row per recipient for each
active `@admin` text comment; recipients are the task team's `role='admin'` member_users
plus **all superusers** — CEO-created teams have no human members, so the superuser leg is
what guarantees delivery — author excluded, deduped by `(comment_id, user_id)`; `read_at`
marks an item read, set by the inbox card, a mark-all, or when the recipient scrolls the
comment into view in its task thread),
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
  of the descriptive `team_context` blob. Three roles have **structurally-fixed reporting
  lines that cannot be changed** (`hasFixedReportsTo` / `FIXED_REPORTS_TO_SLUGS` in
  `@hezo/shared`): the Captain always reports to the CEO, and the CEO and Coach report to
  the admin (no agent). The lock is enforced on every write path — the REST
  `PATCH /projects/:projectId/agents/:agentId` handler and the `set_agent_reports_to`
  tool both reject a re-point of these roles, and the settings UI disables the field. Each proposal is also mirrored as a `hire_proposal` action comment on the
  linked ticket (`services/hire-proposal-comment.ts`), which flips to hired/denied on
  resolution and re-wakes the requester; the approval no longer auto-closes the ticket —
  the requester (the CEO) closes it once setup is complete. Retiring/reinstating an agent runs through the `setAgentAdminStatus`
  service, shared by the `set_agent_status` MCP tool (gated to the team's Captain or an HQ
  coordinator) and the REST disable/enable routes (admin web UI). The **instance singletons
  (CEO/Coach) cannot be disabled through any path** — the MCP tool rejects it and the REST
  `POST .../agents/:agentId/disable` route returns `403` for their slugs (`INSTANCE_AGENT_SLUGS`),
  since the whole instance depends on them for cross-project coordination and review. A
  team's Captain is likewise protected from agent-initiated disabling, but an admin may
  still retire one from the web UI. On a new team the CEO's initial coherence/setup pass **blocks** the Captain's
  planning task. It **auto-runs** on the direct (form) creation path; on the CEO-assisted
  path the CEO authors the concrete setup plan into it and then starts it with
  `start_team_setup` (see Creation flows). That initial pass (reasons `initial`/`template_applied`)
  is the CEO's; **reactive** coherence reviews thereafter — triggered by a prompt, Custom Prompt,
  role, `reports_to`, hire, or enable/disable change on the established team — are enqueued to that
  team's own **Captain** (`enqueueTeamCoherenceReviewTask` picks the assignee by reason, falling
  back to the CEO for HQ, which has no Captain). Coalescing and the change-summary section are unchanged.
- **Coach** — reviews completed tickets across **every** project to improve agent system
  prompts; woken on any task completion.

The **HQ container** is warmed as early as possible after boot: once the master key is
unlocked (provisioning needs secrets/egress), `JobManager.ensureHqContainerRunning` runs
after the container-restart reconcile pass and brings HQ up via
`ensureProjectContainerRunning` (no-op if already running, start-in-place if stopped,
provision if missing) — fire-and-forget so a slow image pull doesn't delay startup. This is
unconditional because the standard restart pass deliberately leaves `stopped` projects
alone, whereas HQ — home of the always-on CEO/Coach — should run whenever the instance does.
The live CEO chat (`chat-session-manager.ts`) also provisions it on demand as a fallback. Turns
are **serialized** (a `turnLock` chain) so concurrent sends can't each spawn a turn — a newer
message interrupts the in-flight reply (kept as `interrupted`) and only the latest streams. No
turn survives a process restart, so `reconcileOnStartup` clears orphaned non-terminal
`chat_messages` (deletes empty `streaming`/`pending` placeholders, marks partial ones
`interrupted`) — an abandoned turn never lingers as a stuck "thinking" bubble.

**Chatbox message queue (client-side) + the batched turn it flushes.** The composer stays usable
while a reply streams. Enter (or a tap of the send button) **queues** into a per-thread list held
in `useChat` — client state only, never a `chat_messages` row, so a reload drops it; that is the
deliberate trade against a `queued` status + migration. A queued message renders as a dashed
bubble at the tail of the thread and can be removed until dispatch. When the thread goes idle
(reply complete, failed, *or* interrupted, so nothing is stranded by a bad turn) the whole queue
flushes as **one** `POST /api/chat/messages` carrying an ordered `messages: [{text,
attachment_ids}]` batch. `sendTurn`'s `messages` param inserts each as its own complete user row
(own bubble, own attachments, all broadcast) and then runs a **single** assistant turn, whose
prompt therefore sees every queued message — N separate turns would yield N replies, the first
answering stale context. The route (`parseMessageBatch`) accepts the single-message shape too, so
external channel ingest is unchanged; `MAX_BATCH_MESSAGES` caps a batch at 20. **Interrupting is
the deliberate path**: holding the send button past `LONG_PRESS_MS` (`use-long-press.ts`), or
⌘/Ctrl+Enter, posts immediately, and the existing interrupt above does the rest server-side. It is
only offered while a reply is actually running (`streaming && !sending`) — during the pre-flight
window there is no turn to abort, so the control queues and says so.

**Automatic, agent-driven chat memory.** Each turn's prompt carries the agent's **long-term
memory** (`chat_memories`, one markdown row per member, no revision history) plus the full
**active window** — the non-compacted `chat_messages`, which *is* the short-term memory. The
window is bounded by a byte cap (`max_chat_history_size`, default 40 KB, in `system_meta`,
operator-set under Settings → Chatbox). When a reply settles and the window exceeds the cap,
`runCompaction` runs a **headless exec** (no `chat_message`, no broadcast) that hands the agent
its current memory plus the whole window and asks it to fold the durable points into memory via
the `update_chat_memory` MCP tool — the agent does the summarization, there is **no server-side
LLM call**. Eviction is gated on the agent actually advancing its memory: only then does the
server mark all but the latest few messages (`CHAT_WINDOW_RETAIN_MESSAGES`) `compacted_at`,
resetting the window to a short tail (a no-op or aborted run loses nothing). Compaction runs in
the background and is preempted by a new user turn (it shares the per-session prompt file), so the
chat is never blocked. The `GET /api/chat/conversation` chatbox view and each turn's transcript
filter `compacted_at IS NULL`, so scrolling up tops out at the window boundary. On a successful
compaction the server broadcasts `ChatCompacted` on the `chat:global` room; every open chatbox
refetches and drops the evicted messages live, rendering a "chat compacted" marker (driven by the
response's `compacted_count`) where the oldest messages were. The store generalizes to any
chat-enabled agent; the operator can review and edit it on the agent's **Chat history** tab
(`GET/PUT /api/projects/:projectId/agents/:agentId/chat-memory`).

**Automatic thread titling.** A web thread is created **untitled** (`chat_conversations.title`
NULL — there is no hardcoded "Main" default) and rendered as a "New thread" placeholder. On an
untitled thread, `runTitleGeneration` is kicked off **as soon as the first operator message lands,
in parallel with the reply** (not chained after it), so the label flips from "New thread" while the
CEO is still typing. It runs a **headless exec** (like compaction — no `chat_message`, no reply
broadcast) that hands the agent the active window and **captures a short title from its stdout**
(`buildTitlePrompt` → `sanitizeChatTitle`); the agent does the naming, there is **no server-side
LLM call**. It titles from the operator's first message alone — it doesn't wait for a settled
assistant reply — off its **own prompt file** (the `title` slot in `turnPrompt`) so it never
contends with the reply's exec. It persists idempotently (`UPDATE … SET title WHERE title IS NULL`,
so a manual/already-set title is never clobbered) and broadcasts `ChatConversationUpdated` on the
`chat:global` room, so every open thread switcher/sidebar refetches and updates its label live. One
title run is in flight per thread at a time (`ConversationRuntime.titling`); a new turn or a close
preempts it (`titlingAbort`) and — while still untitled — the next turn re-kicks it. Its exec's
tokens are not separately priced (matching compaction).

HQ also exposes the standard **assets library** — the one internal-project surface that
isn't hidden in the UI (Budget/Settings still are). Files the CEO produces for the operator
in the live chat (a quick mockup, demo, or export) are saved via `write_project_asset` and
linked back as `assets/<filename>`, so they are durable and openable over a signed URL rather
than stranded as loose files in the container's `/workspace`. The CEO scopes such a
deliverable (and any `write_project_doc` markdown) to **the project the work belongs to**,
falling back to HQ only for work tied to no project; its long-term chat memory also keeps a
rough running summary of those off-project conversations, since they live nowhere else once the
chat window scrolls.

**Project teams** are provisioned either from a DB team-type template (default **Blank** =
Captain only) or directly from a **marketplace team** (`software-development` = Captain + 9
worker roles). Templates/marketplace teams never include the CEO/Coach. Roster prose lives
in `agents/<template>/`, the instance roles in `agents/_instance/`, shared snippets in
`agents/_partials/`; the default specialist rosters ship from the **marketplace** (below),
not the binary.

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
from it, so cloning a team also seeds a reusable type. HQ is rejected as a source. `POST
/api/projects` also accepts a **`marketplace_slug`** (mutually exclusive with the other
two): the fetched marketplace def provisions the roster directly (see below). The CEO's
`create_project` tool is wired with `ContainerDeps` (threaded through
`initMcpServer`/`registerTools`) so a project it creates gets its container provisioned.

### Team marketplace

The default team templates ship from a **marketplace** — a `marketplace/` folder committed
to this repo — rather than being baked into the binary, so a running instance picks up
improved default teams from GitHub **without a binary upgrade**. Each team is one
self-contained, committed JSON (`marketplace/teams/<slug>.json`): team metadata + `version`
(unsigned int) + `changelog` + the full roster, where each role carries its partial-resolved
`system_prompt` (with `{{…}}` intact, no `SHARED_INSTRUCTIONS`), plus a top-level `captain`
override. `marketplace/index.json` is the catalog listing.

- **Authoring → build.** Prompt bodies stay authored as `agents/<team>/*.md`; the structured
  roster + team metadata live in a hand-authored `agents/<team>/team.json` manifest.
  `build:marketplace` (`scripts/build-marketplace-teams.ts`, run by `bun run dev` and by
  authors) resolves partials, validates required prompt vars, computes a content hash over the
  meaningful content (excluding version/changelog/keywords), **auto-increments `version`** on a
  hash change, and writes the committed JSONs. `build:teams` bundles them into the gitignored,
  embedded `teams-bundle.json`. Pure logic in `services/marketplace-build.ts`; guarded by
  `marketplace-build.test.ts` (determinism + a stale-source drift check).
- **Discovery keywords.** Each team carries a `keywords` list — the words and short phrases
  someone would type when they want that team ("website", "saas", "todo list") — authored in
  `team.json`, normalized by the build (`normalizeKeywords`, lowercased + de-duplicated,
  bounded by `MAX_TEAM_KEYWORDS`/`MAX_TEAM_KEYWORD_LENGTH`), and carried through to both the
  team def and `index.json`. They exist so the New Project picker's recall is a property of
  the **team's data**, not of the matcher: a team can be made findable for a new phrasing by
  editing its manifest, and a team published from outside this repo ships its own vocabulary.
  Hezo generates the list at bundle time for a publisher (today: hand-authored for the three
  default teams). Keywords are **excluded from the content hash** — the team's `version` drives
  the reconcile that re-runs hiring against every project already on that team, and retuning
  search terms must not trigger that. Instances always fetch the live catalog, so improved
  keywords take effect on the next fetch regardless of version.
- **Ranking (client-side).** There is no server suggestion endpoint. The New Project dialog
  ranks the catalog it already has (`packages/web/src/lib/team-suggestions.ts`) against the
  typed name + description: both sides are normalized to stemmed terms by
  `@hezo/shared`'s `extractTerms`/`stemTerm` (whole-word, never substring — so "app" matches
  "App Team" and not the "approval" in another team's blurb), and each distinct query term
  scores the **best** field it lands in — keywords 4, name 3, description 2, summary 1. The
  normalizer lives in `@hezo/shared` because both sides need it: the web ranker on the query
  side, the server on the authoring side when it generates a published team's keywords.
- **Runtime load.** `services/marketplace.ts` resolves the catalog from, in order: the repo
  folder in dev (`HEZO_MARKETPLACE_DIR`, or the source-tree `marketplace/`), GitHub raw on
  `main` (cached ~1h; the untrusted boundary — every def is zod-validated with a
  `schema_version` guard), then the embedded bundle (offline fallback). Served read-only at
  `GET /api/marketplace/teams[/:slug]`.
- **Provisioning (no persisted rows).** Marketplace teams are **never** stored as
  `team_templates`/`agent_types` rows — only Blank stays seeded. `applyMarketplaceTeamToTeam`
  (`team-template-apply.ts`) provisions the Captain via the builtin path (with the def's
  override) and the rest of the roster as **inline agents** (`member_agents.agent_type_id`
  null, like hires) via the shared `insertRosterAgents` core, storing each prompt as an
  `agent_system_prompt` document. A marketplace team ships **only** its roster + prompts — no
  skills, MCP servers, or MPP config (those are configured per project, not bundled with the
  team). A marketplace team is one
  selectable source in the standard create-project dialog (alongside Blank, custom saved types,
  and copy-an-existing-team); the marketplace "Launch new project" action opens that same dialog
  preselected. Both create paths carry the choice: **direct** (`POST /api/projects
  {marketplace_slug}`) and **CEO-assisted intake** (`POST /api/project-intakes {marketplace_slug}`
  → recorded as the CEO's baseline → the CEO's `create_project` tool takes a `marketplace_slug`).
  The "copy an existing team" snapshot path (`snapshotTeamAsTemplate`) materializes custom
  `agent_types` for those inline roles so cloning still works.
- **Add to an existing project (CEO-driven).** `POST /api/projects/:projectId/marketplace-team`
  kicks off one CEO task that calls the **`apply_marketplace_team`** MCP tool (direct add, no
  approval — the admin already opted in) and reconciles the merged roster. When the project was
  created from the same team, the CEO recognizes it as a **version update**: `refresh_existing`
  refreshes the existing roles' prose + prompts in place (via `get_marketplace_team` + selective
  `update_agent_system_prompt` where roles carry local customizations) instead of adding
  duplicates. Because instances always fetch the live catalog, a new team `version` reaches them
  automatically.
- **Adding only SOME of the roster.** The same route takes an optional `roles: string[]`. Omitted →
  the whole-team path above. Present → each slug is resolved against `teamDef.roster` (404 on the
  first unknown; an explicit `[]` is a 400, never "all"), and resolving against `roster` is also what
  rejects `captain` and the other `RESERVED_ROSTER_SLUGS` — the Captain lives in the separate
  `captain` override and every project already has one. It enqueues `enqueueAddMarketplaceRolesTask`
  (`marketplace-add-team.ts`, label `add-marketplace-roles`; both enqueues share `enqueueCeoTask`),
  whose body has the CEO call the **`apply_marketplace_agent`** MCP tool once per role →
  `applyMarketplaceRoleToTeam` (`team-template-apply.ts`). Two deliberate differences from the
  whole-team provisioning path: the def's **Captain override is never applied** (borrowing worker
  roles must not rewrite the target team's Captain), and the reporting line **falls back to the
  Captain** when the role's own manager is absent — `insertRosterAgents` otherwise leaves
  `reports_to` null, which a subset add hits constantly (the App Team `engineer` reports to
  `architect`). The tool returns `reports_to_fell_back` so the CEO re-points it. The task body is the
  substance: these prompts/`team_context` were authored for a roster that is not coming with them and
  @-mention agents that may not exist in the target, so reconciliation is mandatory, and the CEO is
  explicitly licensed to stop and `@admin` when a role does not clearly belong (an allowed stop — the
  reply re-wakes it), adding the clear roles and asking about the rest.
- **Marketplace as a hiring source.** `list_marketplace_teams` (catalog discovery, CEO or Captain)
  plus the relaxed `get_marketplace_team` let a hiring conversation reach for a proven, fully-written
  role instead of authoring one from scratch. Guidance lives in `agents/_partials/captain/hire-workflow.md`
  (a partial, since only the seeded Captain/CEO file hires — runtime hires never do) and
  `agents/_instance/ceo.md` § Roster changes. Both `apply_marketplace_*` tools are in
  `MCP_WRITE_TOOLS`, so a run that only provisions is not recorded as a no-op.
- **Export a live team as a bundle.** `GET /api/projects/:projectId/team-bundle`
  (`services/team-bundle-export.ts`, `exportTeamBundle`) serializes a project's current team
  into a self-contained `MarketplaceTeamDef` — the inverse of `applyMarketplaceTeamToTeam`. It
  reads the team's `member_agents` + their `agent_system_prompt` documents, emits the Captain as
  the top-level `captain` override and the rest as `roster` (reserved slugs / cross-team instance
  agents excluded; each `reports_to` mapped back to the Captain, a roster slug, or null), derives
  discovery `keywords` from the team's text (`generateTeamKeywords` in `@hezo/shared` — readable
  words, not stems, since only the built-in teams carry a hand-authored list), and stamps
  `version: 1` + a fresh `content_hash` (via `computeContentHash`, reused from the build). It
  ships **only** roster + prompts — never skills, MCP servers, secrets, or project config. The
  Team page's **Export team** button (beside Hire agent) fetches it and downloads the JSON
  client-side; a user submits that file to the Hezo authors on GitHub, whose `build:marketplace`
  re-derives the hash/version/validation when it lands in the repo. Read-only, project-access
  gated. (Parallels a future `get_team_bundle` MCP tool if one is added.)
- **Shipped teams.** Three: **App Team** (`software-development`, the full app-building roster),
  **Social Media Marketing** (`influencer` — brand-strategist, trend-researcher, content-writer,
  media-producer, content-editor, distribution-manager), and **Investment Portfolio**
  (`investment` — market-researcher, equity-analyst, catalyst-monitor, risk-verifier,
  report-writer). Slugs are stable ids and keep their historical names. The
  Social-Media-Marketing/Investment-Portfolio Captains run a structured onboarding
  Q&A on their planning task and **suggest goals** (below); the Social Media Marketing team
  gates outbound content on admin approval (prompt-level, toggled via team preferences), and
  the Investment Portfolio team maintains a living per-stock document (with revision history)
  monitored ~daily.

**Goal suggestions.** The Captain/CEO can propose goals the admin approves, reusing the
approvals machinery. `suggest_goal` (MCP, Captain/CEO-only) files a pending `goal_suggestion`
approval (`approval_type` enum extended by `038_goal_suggestion_approval.sql`) plus a
`goal_suggestion` action comment on the task; approving it runs `goalSuggestionHandler`
(`approval-handlers/goal-suggestion.ts`), which creates the real `goals` row via `createGoal`
and flips the comment. Pending suggestions surface on the task thread and the project Goals page
(`GET /projects/:projectId/goals/suggestions`), each with inline Approve/Deny.

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

### The container-engine seam

Everything that touches a container goes through **`ContainerEngine`**
(`services/sandbox/types.ts`) — the exact set of operations Hezo needs from whatever runs
its agent containers. `DockerClient` (`services/docker.ts`) implements it against the local
daemon; `DaytonaEngine` (`services/sandbox/daytona/`) implements it against a third-party
sandbox service. No caller above the seam knows which is in use.

Three shared pieces sit alongside it so the two implementations cannot drift:

- **`sandbox/endpoints.ts`** — `RunEndpoints` states the container-to-host addresses (MCP,
  assets, egress proxy, ssh-agent) once. They previously rode seven separate hardcoded
  `host.docker.internal` literals, so they broke together and could only be changed together.
- **`sandbox/files.ts`** — `SandboxFiles` is the async, relative-path-only interface every
  run-artifact read *and write* goes through: the prompt file, the per-run runtime home
  (`settings.json`, subscription credentials), the tunnel config, and the read-backs (the
  runtimes' off-stream usage files, push errors, rotated subscription auth). Paths that
  would escape the run root are rejected, and the walk never follows symlinks. `removeDir`
  is part of it because the per-run home holds the provider credential, so removing it is a
  scrub rather than tidying.

  It is reached as **`ContainerEngine.files(containerId, containerRoot)`**, rooted on the
  *container* path - identical on both backends by rule; only how it is reached differs.
  Nothing above the seam may touch `node:fs` for a run artefact: a host-only file path is
  one that works everywhere except production on a managed backend.

  `readBytes`/`writeBytes` are the raw-byte pair, added for the recovery bundle (§ Agent
  runtime, Recovery bundles) - a git bundle is binary, and a UTF-8 `read` silently replaces
  every invalid sequence, so a bundle moved through the text pair would arrive corrupted and
  only fail later at `git fetch`. Both backends already moved bytes underneath; the decode
  was applied at the very edge. `size` exists so a caller can decide whether it is willing
  to buffer a file *before* `readBytes` buffers it - asking by reading and measuring
  afterwards is the check happening after the damage.
  - **Daytona** implements it over the toolbox file API. Every endpoint was measured
    against the live service and several do not behave as the spec reads: `files/folder`
    answers **201**; `files/find` matches file **content** rather than names, so
    `findByName` walks the directory listing instead of using an endpoint that looks right
    and silently finds nothing; and a `DELETE` of a **non-empty directory** is refused with
    a 400 unless `recursive=true` is passed, deleting nothing. That last one is why
    `removeDir` passes the flag and treats a path still present afterwards as an error
    rather than a shrug: its caller is the per-run scrub of the runtime home, so a delete
    that quietly did nothing left the provider credential on the provider's disk for the
    rest of the container's life. `exists` and `size` go through `files/info`, which
    answers for a directory as well as a file - built on a download, a directory was a 400
    rather than a "yes". An upload lands `0644` owned by root whatever the caller
    asked, so the mode contract (`0600` on a credential, `0711` on the directories above it
    so the deprivileged run user can traverse without listing) is re-applied explicitly.
  - **Docker** implements it over the daemon's `PUT`/`GET /containers/{id}/archive`
    endpoints, **not** the bind mount - a host fast path would be exercised by every local
    test while the real path shipped unexercised, and it would break a daemon reached over
    TCP or running rootless in its own namespace. That needs tar, owned outright in
    `sandbox/tar.ts` rather than pulled in, since one regular file per call is a 512-byte
    header plus padding. Two facts there are only findable against a real daemon, which is
    why `test/bun/sandbox-files-docker.bun.test.ts` exists: the checksum field is **six**
    octal digits, a NUL and a space (the seven-digit shape every other numeric field uses
    puts the NUL over the last digit), and the JSON request helper silently
    `JSON.stringify`d the archive until `requestBinary` was split out.
  - **The fake engine models the bind mount** rather than an in-memory store, resolving a
    container path to the project's real workspace. That is what a local daemon actually
    does, so a test that stages through the seam still reads the bytes off disk.
- **`sandbox/handle.ts`** — `SandboxHandle.exec()` collapses the
  `execCreate`/`execStart`/`execInspect` triad into one call returning the exit code with
  the output, and expresses privilege as **`elevated: boolean`** rather than a username.
  A username is an instruction only Docker can follow: third-party providers set a user at
  sandbox creation and ignore a per-exec one, and their *default* identity differs, so each
  backend renders the intent its own way. Docker maps `elevated` onto `User: root` vs the
  detected run user; Daytona already execs as root, so it renders the unelevated case as
  `runuser -u <user> --` — deprivileging, the inverse render.
- **`sandbox/proc-scripts.ts`** — the `/proc` scan and kill scripts, plus the `df` disk
  measurement behind `ContainerEngine.diskUsedBytes`. They are plain POSIX shell and nothing
  in them is runtime-specific, only the transport that carries them, so both engines run the
  identical script rather than each reimplementing the scan. Every value interpolated into
  one is validated first (`ENV_MARKER_VALUE_RE` for markers, a path character class for
  `df`), which is what makes the unquoted interpolation safe.

  Disk is measured with `df` rather than `du`: the question is how close a container is to
  filling up, which `df` answers from the superblock in constant time, where `du` would walk
  every `node_modules` in every worktree - exactly the trees that make the number
  interesting. It runs once per run, **after** the worktree GC, so the figure reflects disk
  that is actually unavailable rather than what a reclaim was about to free, and it lands in
  `container_pool_members.disk_used_bytes`. `null` (an unreadable measurement) leaves the
  previous figure alone; reporting an unmeasurable container as empty would defeat the
  pool's recycle rung, which had no input at all before this and so could never fire.

**The Daytona adapter** is three files and absorbs four API differences entirely within
itself: create also *starts* the sandbox (so `startContainer` is a no-op on one already
running); there is no per-exec user; there is no image store, because a custom image
arrives as **Dockerfile text** Daytona builds and caches by a hash of that text (which is
why the image reference must be **digest-pinned** — a tag-pinned `FROM` is byte-identical
forever, so the cache never invalidates and the sandbox serves a stale toolchain
indefinitely); and stdout and stderr arrive **merged**, with the response's `stdout`/
`stderr` fields always null. The stream split is load-bearing upstream — the agent
stream-json parser routes on it, and a git exec parses stdout for shas while git writes
progress to stderr — so the adapter recovers it by redirecting stderr to a per-exec file
and draining it with a bounded `tail -c`. On the streaming path that means stderr arrives
as one chunk at the end rather than interleaved: the honest cost of a provider that merges
the two.

Per-sandbox memory comes from Daytona's OTEL metrics endpoint as a windowed query rather
than a live gauge; an absent or empty series reports as **null**, which the caller already
treats as "no reading this tick" (reporting zero would read as a sandbox using no memory
and defeat cap enforcement). There is no container log stream, and nothing useful in one:
PID 1 is `sleep infinity`, so the content the UI shows is provisioning and lifecycle output
Hezo produces itself.

**Volumes are an object store, not a filesystem** - re-measured against the live API with a
volume-scoped key (`GET`/`POST /volumes` both 200, so the scopes are not the blocker they
were once assumed to be), mounting one at `/mnt/vault` on a running sandbox:

| Operation | Result |
|---|---|
| `mount` type | `mountpoint-s3 … type fuse (rw,nosuid,nodev,noatime,default_permissions,allow_other)` |
| create a new file, read it back | ✅ |
| copy a finished file in (the bundle transport) | ✅ |
| `mkdir` / `rmdir` | ✅ |
| append to or modify an existing file | ❌ `Operation not permitted` |
| `rename` | ❌ `Function not implemented` |
| `chmod` | ❌ `Operation not permitted` - every file stays `0666` owned by `nobody` |
| `git init --bare` | ❌ `could not write config file …: Function not implemented` |

Two things about *how* this was measured are worth keeping, because both produced a wrong
answer first. **Exit codes lie on this mount**: a first pass chaining `cmd && echo ok`
reported append, rename, chmod and `git init --bare` as all succeeding, and every one of
them is false - the failures only appear when the data is read back. Assert on read-back,
never on the exit status. And **writes are not always immediately visible**: a file written
and `cat`ed in the same breath can read as absent, which made an early probe look like
`mkdir` did not persist when it does.

This is what makes the whole-file bundle the only workable shape on a volume, and why the
recovery vault does not use one (§ Agent runtime, Recovery bundles).

**Digest resolution** (`sandbox/image-ref.ts`) is the generic OCI registry manifest lookup
that makes the pin possible: a HEAD on the manifest, exchanging a `WWW-Authenticate: Bearer`
challenge for an anonymous pull token when the registry asks for one, reading the digest off
the `Docker-Content-Digest` header. It caches with a TTL and a cap, and **falls back to the
tag** rather than failing when the registry cannot be reached - an offline instance, a
private registry, or a locally-built tag that exists in no registry at all would otherwise
be unable to start a container over a cache-freshness concern. The fallback logs what it
costs, because the failure it re-admits is otherwise invisible.

**The tunnel is the only way a container reaches Hezo**, on every backend, with no gate and
no second path. `RunEndpoints` always names container loopback, where the in-container
client listens; `host.docker.internal` survives only for an operator-configured local model
provider, which is a host address the *agent* dials rather than a route back into Hezo. An
earlier draft shipped this behind `HEZO_TUNNEL=1`, off by default, so Docker kept its
existing direct path — that was removed: a gate that leaves the new mechanism off means the
old path is still the real one, and the shape local dev and CI exercise is then not the
shape production runs (§ *One mechanism, no silent fallbacks* in AGENTS.md). The CEO chat
takes the tunnel too.

**The Docker hijack is spoken over a raw socket, not `http.request`'s `'upgrade'`.** The
hijacked exec socket was the one piece written from Docker's API documentation rather than
from something observed, and running it against a live daemon showed it could not have
worked in production at all. `'upgrade'` is the documented event and is correct on Node;
**Bun never emits it** for Docker's hijack. Bun emits `'response'` with status **101**,
routes the framed exec bytes onto the response stream, and ignores writes to `res.socket`,
so stdin never reaches the exec - both measured. Since Bun is the production runtime, every
attach rejected with "attach failed (101)", 101 being the success status. A hijack is just
"send a request, then own the socket", so `hijackExec` now speaks the request over a plain
`node:net` socket: one code path, identical on both runtimes, accepting 200 as well as 101
(some daemon versions answer that for a non-TTY attach). The socket is handed back
**paused** so bytes arriving alongside the headers can be `unshift`ed without loss, which
makes the explicit `resume()` in `openExecChannel` load-bearing rather than tidy - a `data`
listener does not auto-resume an explicitly-paused stream, and without it the channel
connects, the client binds its listeners, and no frame is ever delivered.
`test/bun/sandbox-tunnel-docker.bun.test.ts` runs the real client in the real image over a
real hijacked exec and asserts a request made *inside* the container reaches a host server,
which is the claim no pipe-based or fake-engine test can make.

**The byte channel a tunnel would ride on differs per backend - measured.** The plan for
reaching Hezo from a remote container (one exec with stdin attached, carrying a multiplexed
tunnel) assumed every backend has Docker's `AttachStdin`. Daytona does not: its exec ignores
an `input`/`stdin`/`stdinData` field entirely, and a command that reads stdin sees immediate
EOF. What it has instead is a **PTY session over WebSocket** -
`POST /process/pty {id}` then `wss://…/process/pty/{id}/connect` with the bearer token -
verified end to end as a real bidirectional byte channel (writes reach the shell, output
comes back). Two things follow: the channel opens with a
`{"status":"connected","type":"control"}` JSON frame that is not shell output, and it is a
**PTY**, so line discipline is active (echo on, `\n` to `\r\n`, bracketed-paste sequences)
and it must be put in raw mode before any framed protocol rides on it. The consequence for
the seam is that the *transport* is per-backend while the framing and multiplexing above it
stay shared - "one transport for both backends" holds for the protocol, not for the channel
underneath it. Raw mode is enough for the bytes themselves: measured, all 256 byte values
survive a 64 KiB payload intact, NUL and XON/XOFF included, so nothing has to be escaped.

**The channel is not clean from byte zero, so the framing layer syncs.** Raw mode stops the
PTY *mangling* bytes but not the shell *writing* them: it still echoes the command typed
into it and prints a prompt, and 97 bytes of
`stty raw -echo\r\n\e[?2004l\r\e[?2004hroot@…:/workspace# ` arrive ahead of the first frame.
Parsed as frames those are fatal rather than untidy - "raw " read as a length field gives
1918990112, past the cap, and the mux tears the tunnel down before it carries anything. So
the client emits a NUL-delimited `TUNNEL_PREAMBLE` before its first frame and the decoder
discards everything up to it. That lives in the shared protocol rather than in the Daytona
adapter deliberately: any provider offering only a PTY has the same prologue, and a channel
that *is* clean (Docker's hijack) simply syncs on the first bytes it sends. Daytona also
`exec`s the client so the shell is replaced and cannot print between frames; the preamble
covers only the prologue. Because the client writes it after binding its listeners it
doubles as the **readiness signal** (the provisioning git ops previously started as soon as
the exec channel opened, before anything was listening), and it carries a version so an
older in-container client is refused by name instead of surfacing as an unknown frame type.

**Both directions fail closed and stay bounded.** A throw anywhere in the mux's frame
dispatch - not just in the decode - tears the tunnel down, because the alternative is worse
than closing: the dispatch runs on a promise queue, so an escaping rejection silently stops
all further reads and leaves a tunnel that is wedged rather than closed. Flow control is a
credit window in both directions; a stream starts at zero credit and the peer's opening
`WINDOW` is authoritative, since seeding a default *and* accepting the grant counts one
allowance twice and ignores a host configured with a different window.

**Network isolation is the provider's, not ours - measured.** Daytona interposes an Envoy
proxy in front of all sandbox egress: a raw TCP connect to `169.254.169.254`, to an RFC1918
address, and to a public address all succeed and all answer `server: envoy`, so there is no
cloud metadata service behind link-local to reach and no other tenant behind the private
ranges. Hezo therefore sets **no** `networkAllowList`. It could not express one in any case:
the field is capped at **10 networks**, while "the public internet minus the private ranges"
is 51 CIDRs, so an attempt to send it fails the create outright - which would have broken
every remote run rather than hardening it. What protects a secret remains that the secret
only ever exists on the Hezo side.

**Capacity is a memory budget, and it reserves for the chat container up front.**
`max_container_memory_gb` bounds the total memory *task run* containers may hold at once,
summed from what each one actually asked for (`projects.memory_limit_gib`, else the
instance default). It replaced a container **count** (migration 050): a count bounds memory
only while every container is the same size, and the per-project override exists precisely
so they are not - one project raising its cap to 4 GB took one "slot" but twice the memory
of the 2 GB containers the host was sized for. There is deliberately no derived container
count anywhere, not even for display: how many fit depends on the mix of their sizes.

The CEO chat's container is **exempt** from the budget, because a queued task run is
invisible and harmless while a queued chat turn is a person watching a spinner. On a host
backend the machine still has to fit it, so `computeDefaultMaxContainerMemoryGb` subtracts
`HOST_RESERVED_MEMORY_GB` (1) plus one container's worth for the chat. Reserving up front
rather than subtracting when a session opens keeps task-run capacity a **stable** number -
opening the chat never silently slows the fleet. The exemption is enforced on **both** sides:
the budget reserves for it, and `getActiveContainers` excludes a `reserved_for_chat` member
from `usedMemoryGb` (on both arms of its UNION - the pool member and the `projects` row are
two records of one container). Charging it in both places reserved the same memory twice,
so an instance sized for three containers dispatched two whenever the chat was open.

**The budget derives from host memory only where the containers are the host's to feed.**
`ContainerEngine.containerHostMemory()` answers with the memory its containers are drawn
from, or `null` when they are not drawn from this machine at all; `DockerClient` returns the
host's RAM + swap and `DaytonaEngine` returns `null`, and the budget then falls back to
`DEFAULT_MAX_CONTAINER_MEMORY_GB` (6). Deriving a managed fleet from `os.totalmem()` sizes it
by the wrong computer, and wrongly in both directions - a 2 GB VPS computes a budget that fits
no container and never dispatches, a 128 GB workstation authorises 127 GB of the provider's
hardware. It is deliberately a **resource** on the seam rather than a provider name: the
capacity model needs exactly one fact ("is this RAM mine to spend"), and asking it that way
keeps every provider conditional on the adapter's side of the interface. `GET
/api/instance-settings` reports `host_total_ram_bytes`/`host_total_swap_bytes` as `null` on
such a backend, so the settings page renders what the budget was actually computed from
rather than an arithmetic that had no part in it.

The trade-off a budget accepts is that a large container waits for enough budget rather
than for any free slot, so smaller runs can overtake it. That is a delay and not
starvation, because `projectMemoryFitsBudget` refuses a per-container cap larger than the
whole budget where it is *set* - both on `PATCH /api/projects/:id` and on the instance
default - rather than letting such a run queue forever with nothing naming the cause.

The budget is total **virtual** memory: swap counts at full weight, which is deliberate for
the local backend. An agent container is idle between execs, so its cold pages really can
live on disk, and a host with swap configured genuinely fits more containers than its RAM
alone - the reference host below fits nothing but the reserves without its swap. (A managed
backend does no memory arithmetic at all; its cap is a spend guard.) This lowers the
computed default on small hosts: the documented 1.92 GiB + 6 GiB reference host goes from 4
to 2, and that drop is entirely the two reserves - the host itself, and the chat container
the old formula pretended did not exist - not a discount on its swap. Instances that have
explicitly set the value keep it; only the computed default moves.

**The orphan sweep** (`sandbox/orphan-reaper.ts`, run every 10 minutes by `JobManager`)
destroys containers this instance created that Hezo no longer references anywhere. Boot
fails every in-flight run and never reattaches, so a crash, a hard kill or a lost provider
response strands containers with no owner - harmless on local Docker, but billed for as long
as nobody looks on a managed backend, which fails as a cost rather than as an error and so
needs a sweep rather than an alert. Every container Hezo creates carries a `hezo.instance`
label naming the instance, and the sweep queries on it: several Hezo instances can share one
provider account, so a broader query would destroy another instance's live sandboxes. The
pass is bounded and states what it deferred, since a silently-truncated sweep reads as
"everything was cleaned up" when it was not.

The live set (`listReferencedContainerIds`) is the union of **both** representations of a
container - the project row and the pool member - across **every** pool state. A pooled
project owns several containers at once while `projects.container_id` names only the most
recently provisioned or resumed one, so a set built from projects alone reads a busy run's
container, an idle member a task has affinity with, the chat's container and a member pinned
for unpushed commits as unreferenced. `suspended` matters most: that is the state a container
the pool means to resume sits in, and destroying one loses its filesystem.

A container is destroyed only on its **second consecutive sighting**. Provisioning has a
window where a container exists on the engine and is recorded nowhere yet - `createContainer`
has returned an id and the pool row is written only after it starts - and one caught there is
indistinguishable from an orphan. No ordering of the two reads closes that window, and no
engine exposes a creation time to age it out with, so the sweep carries its suspicions to the
next tick instead: whatever was mid-provision has since been recorded, while a real orphan is
still there. The cost is one extra billing period, against the alternative of destroying a
container that is running someone's work; the number held back for confirmation is logged so
the delay is visible.

Work reaches an agent through the **wakeup → job-manager → agent-runner** pipeline.

**Wakeups.** Every trigger is an `agent_wakeup_requests` row. Sources: `heartbeat`
(scheduled fallback tick), `timer` (recovery: orphan detector, retry), `assignment`,
`mention`, `reply`, `comment` (a system-posted comment wake; user comments wake agents
only by actively `@`-mentioning them, never implicitly), `credential_provided` (a human
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
health, and orphan recovery. Container sync separates its two costs: liveness
(`inspectContainer`) runs every pass, while the working-set **memory sample**
(`containerStats`, the expensive call, and issued with `one-shot=true` so the daemon
answers from its current sample instead of waiting for the next collector tick) runs on a
~15s per-project interval — a container's memory does not move meaningfully inside a
second, and the serial per-project fan-out shared a socket with the live exec streams.
Projects are swept with bounded concurrency, and the status write is conditional
(`IS DISTINCT FROM`), so an unchanged project costs no row rewrite. `guarded()` still
drops a tick whose predecessor is in flight, but now **says so** (rate-limited): a
silently-skipped tick is stale state with no signal. Per project-concurrency-limited, it:
loads queued wakeups →
runs the **pre-run budget gate** (`activateAgent`; over-budget skips the run with no
`heartbeat_runs` row and pauses the agent) → claims the wakeup → invokes the runner →
absorbs sibling queued wakeups for the same task → marks the run terminal → reconciles
task blockers (waking dependents when the last blocker clears) → fires task automations.
Instance agents (CEO/Coach) select work across *all* teams here.

**Stranded-run recovery.** A `heartbeat_runs` row is inserted `queued` and only flips to
`running` (stamping `started_at`) once a credential is resolved and the credential lock
held, so both states can strand — and while either persists the run counts as *active*,
which blocks reassignment on its task and reads as live agent activity in the UI. The ~30 s
orphan pass (`services/orphan-detector.ts`) therefore reaps both, each aged against the only
clock it has: a `running` row against `started_at` (30 s safety window), a `queued` row
against `created_at` (the 120 s grace window, which spans the whole not-yet-started phase).
Both arms are guarded by the in-process live-run registry — the run id is registered the
moment the row is inserted, so a run whose host-side driver still owns it (waiting on the
credential lock, say) is skipped and only a row whose driver has vanished is failed. The two
kinds are distinguished only by their recorded `error` (`Orphaned: run never started` vs
`Orphaned: process no longer running`); the retry/approval escalation is shared.
`healStaleRunState` is the inverse pass and deliberately counts `queued` as active, so it
repairs the *surroundings* (execution locks, agent `runtime_status`, claimed wakeups) but
never the run row itself.

**Run.** `agent-runner.ts` builds the run context (provider/runtime resolution, MCP
descriptors, egress proxy, ssh-agent socket, container env), starts a `heartbeat_runs`
row, and drives a streaming `docker exec` of the runtime CLI. The long-lived Docker streams
— the exec attach and the container log follow — run over `node:http` against the Docker
unix socket rather than Bun's `fetch`: Bun's fetch enforces a hardcoded ~5-minute idle
timeout (oven-sh/bun#5930) that severed any run whose CLI stayed quiet that long (e.g.
inside a long tool call), failing it with "The operation timed out."; one-shot daemon calls
stay on fetch. Before that exec it
**live-verifies the container against Docker** (`syncContainerStatus`) instead of trusting
the cached `container_status`: a container pruned externally or lost to a Docker restart is
reconciled (status flipped, `container_id` nulled, project update broadcast) and the run
fails fast with a clear message rather than tripping over a raw 404 mid-exec. It captures
interleaved stdout/stderr (recorded in full, `[stderr]`-prefixed, with a 10 MB
runaway-output backstop) into **append-only log chunks**. The exec transport itself
**retains nothing**: `execStart` with an `onChunk` callback forwards each frame and returns
an empty `ExecResult`, because a run's raw stream-json output (every tool result in full)
is strictly larger than the capped rendered log and was, held alongside it, the largest
single consumer of server memory. Anything derived from the raw stream is computed
incrementally in the callback. Framing for both the exec stream and the container-log
follower is decoded by the shared `DockerFrameDecoder` (`services/docker-frames.ts`),
which reads at an offset rather than reallocating the pending buffer per socket read, and
decodes per stream with `TextDecoder({stream:true})` so a codepoint straddling a frame
boundary is not corrupted. Persistence is via the debounced flusher
(`services/log-stream-broker.ts`) persists only the text appended since the last successful
flush as an INSERT into `heartbeat_run_log_chunks` (`db/run-log-chunks.ts`), serialized
per stream so overlapping flushes can never duplicate a delta, with the running token/cost
snapshot updated on `heartbeat_runs` in **the same statement** — a data-modifying CTE, not
a transaction: both drivers serialize every transaction block process-wide, so at ten
concurrent runs the old three-statement block put ~20 globally-serialized transactions a
second in front of every user request, and a single statement is already atomic, which is
all the exactly-once delta contract needs. Readers concatenate the
chunks (`string_agg` ordered by `seq`) back into the API's `log_text` field — but only
where the whole log is actually wanted. The paginated runs list ships `log_length` instead
(`per_page` reaches 200, so a page carrying full logs could materialize gigabytes), and
every caller that wants an excerpt — `get_run_log`, a task's latest-run view, the orphan
detector's failure tail — uses `readRunLogTail`, which walks back from the newest chunk
until the budget is covered rather than aggregating the whole log and slicing it. INSERT-only
writes replaced the old whole-blob `UPDATE heartbeat_runs.log_text` pattern, whose per-flush
dead TOAST copies were the dominant source of database bloat. The delta itself is read by
character **offset** (`CappedLogBuffer.sliceFrom`), never by building the whole log and
slicing it: the buffer grows toward its 10 MB cap and the flusher runs twice a second per
run, so materializing it per flush was O(total) work on a fixed cadence — the in-memory
twin of the write amplification the chunk table fixed.

The same stream broadcasts live over the `project-runs:<projectId>` WebSocket room from the
in-memory buffer, **coalesced**: consecutive lines on one stream accumulate for ~100ms (or
until a burst ceiling) and go out as a single frame whose text is newline-joined. The client
already splits an incoming payload on `\n`, so this needs no protocol change; only
same-stream lines merge, so stdout/stderr ordering is preserved. A newly-subscribing client
is replayed a **line-aligned tail** of the buffer rather than the whole thing (`replay` runs
for every live stream in the room, so a project with ten concurrent runs would otherwise push
ten full logs into one socket on tab open); the pending batch is drained first, since the
snapshot replaces the client's buffer and a line arriving after it would render twice. The
full log stays available from the REST run endpoint, which is what the run view seeds from.
Sockets carry a `backpressureLimit` with `closeOnBackpressureLimit`, so a client that falls
irrecoverably behind is dropped and recovers through the existing reconnect-and-resubscribe
path instead of growing an unbounded send queue.

**System prompt composition.** The agent's stored template (its `agent_system_prompt`
document, loaded from its **home** team) is resolved per run by
`services/template-resolver.ts`: `{{…}}` placeholders are substituted with live DB values
(`{{team_name}}`, `{{reports_to}}` — wired to the instance CEO for a Captain via
`linkTeamCaptainToInstanceCeo` — `{{skills_context}}`, `{{project_docs_context}}`,
`{{team_preferences_context}}`, `{{team_description}}`, `{{team_context}}`,
`{{current_date}}`, and the CEO-only `{{projects_context}}`), then the resolver appends the
Run Context / Repository / Project State / Teammates blocks and `SHARED_INSTRUCTIONS`.
The **Repository** block names the designated repo *and every other linked repo*, giving each
additional one its on-disk worktree path (`/worktrees/<task>/<repo>`, a sibling of the working
directory), and directs agents to read connected repos from disk (`ls`/`Read`/`grep`) rather
than fetch their files through the `github` MCP `get_file_contents` API — which is slower, costs
tokens per file, and returns GitHub's default branch instead of the ref checked out for the run.
Every surface that authors or edits a prompt — the hire proposal create/edit
(`prepareHireProposal`, `PATCH /approvals`), direct agent create + `PATCH /agents`, and the
`create_hire_proposal` / `update_agent_system_prompt` MCP tools — validates a supplied,
non-empty prompt against `REQUIRED_SYSTEM_PROMPT_VARS` (`@hezo/shared` —
`{{team_name}}`, `{{reports_to}}`, `{{skills_context}}`, `{{project_docs_context}}`,
`{{team_preferences_context}}`) and rejects it (4xx / tool error) when one is missing, so an
edited prompt can never silently drop the agent's identity or live context. The instance
singletons (CEO/Coach) are exempt — they have no in-team manager. `{{team_context}}` is
**not** required because the resolver auto-appends that block on every run regardless.

**Who may edit prompts & the Custom Prompt.** `update_agent_system_prompt` (editing an existing
agent's stored prompt) is authorized for the **Coach**, the team's **Captain**, and the **CEO**: the
CEO and Coach are recognized from any scope (including their cross-team chat/HQ session) via
`isHqInstanceAgent`, and the Captain via `canCoordinateTeam` — the same set that may write the project
Custom Prompt with `update_project_custom_prompt`. `update_agent_system_prompts` (plural) applies
several prompt edits in one call for the same callers. **Coherence review on change.** Any edit that
reaches agents' prompts — an agent system prompt (MCP singular/batch or the REST `PATCH /agents`) or
the project Custom Prompt (MCP or REST) — files a team-coherence review via
`enqueueTeamCoherenceReviewTask`, passing a `changeSummary` that is recorded on the ticket under a
"Changes that triggered this review" section (accumulated across coalesced changes), so the reviewer
knows what changed and why the review was triggered — regardless of who made the change (agent or
admin).

**Run logs to MCP.** A run's log (concatenated from its chunks, still a `log_text` string on the
wire) is readable through the read-only `list_task_runs` (per-task run metadata) and `get_run_log`
(one run's log tail, capped by `excerpt_chars`) MCP tools, team-scoped
like any other resource. The Coach's post-task review prompt (`buildCoachReviewPrompt`) injects a
compact **Agent Runs** summary alongside the comment history and directs the Coach to pull a specific
run's log when the comments don't explain a struggle.

**Task prompt.** After the system prompt, `buildTaskPrompt` (`agent-runner.ts`) appends the
run's task block: the current task's identifier/title/priority/status, plus its `rules`,
`description`, and `progress_summary`. The block also carries the ticket's **lineage** in both
directions: upward from `loadSpawnedFromTask` (a `**Parent ticket:**` line, and a
`**Spawned from:**` provenance line when a run on a different ticket created this one), and
downward from `loadOpenSubTasks` — an `**Open sub-tasks**` list naming each non-terminal child
with its assignee and status. The downward half exists so a manager can see what it has already
delegated: `SHARED_INSTRUCTIONS` tells it to route fresh feedback to an in-flight sub-task
rather than absorbing the deliverable, and without the list that rule depends on the agent
remembering its own earlier fan-out. It also injects the **latest 3 comments** inline (the
comment that woke the run tagged) as a head-start — small enough to carry on every run, while
the `SHARED_INSTRUCTIONS` "read the thread before you act" rule still directs the agent to
`list_comments` for the full thread before acting, since instructions posted after a task is
created routinely change it. A comment-sourced wakeup additionally renders a handoff that
quotes the triggering comment verbatim: `## Mention Handoff` (`mention`), `## Reply Received`
(`reply`), or `## New Comment on Your Task` (the opt-in assignee `comment` wake, previously the
one comment source that surfaced no reference to what triggered it). The Coach's `task_done`
review is the one path that instead embeds the **full** comment history (both share
`loadCommentHistory`/`renderCommentHistory`).

**Containers & worktrees.** One container per project, **run on demand**: the container is
not required to be up between runs. `runAgent` establishes it at the start of every run via
`ensureProjectContainerRunning` (running → reuse; stopped → start in place; missing/stale row →
provision), chat sessions do the same, and the `container-idle-stop` cron (1/min) retires any pool
idle past `CONTAINER_IDLE_TIMEOUT_MIN` (`@hezo/shared`, **2 minutes**) — so a quiet instance
runs zero containers. That window is a **constant, not a setting** (migration 050 drops the
old `container_idle_timeout_min` key): its only job is coalescing a burst — covering the gap
between one run finishing and the next starting in the same project, which is a comment
insert, a wakeup fire, the 1 Hz dispatch cron and a container acquire, so seconds to about a
minute. One minute can suspend a container mid-wakeup-chain; longer buys little, since
resuming a suspended container costs about a second. The old `0` = always-on escape hatch is
gone with it — a container that never stops bills forever on a managed backend, and the dev
server it kept alive belongs in something with its own lifecycle. "Idle" means:
no active (queued/running) run, no run finished inside the window, no queued wakeup that could
dispatch (capacity-skipped wakeups deliberately don't pin containers), and no chat session with
recent `last_activity_at` or an in-flight turn; `projects.container_last_started_at` floors the
check so a fresh start always gets one full window. Every lifecycle *decision* — ensure-running
and the cron's check-then-stop (which re-verifies the predicate plus the scheduler's in-memory
run/pending refcounts under the lock) — serializes per project through
`withContainerLifecycleLock` (`services/containers.ts`), so a start and a stop can never
interleave: worst case is a wasted stop/start cycle, never a failed run. Concurrency is bounded
by one **global container memory budget** (`max_container_memory_gb` in `system_meta`; when unset,
the default is computed from host memory as
`(RAM + swap) - HOST_RESERVED_MEMORY_GB - default_ram_cap_per_container_gb` —
the 1GiB reserve keeps the OS, Hezo's own process and the embedded database off the containers'
budget, since none of them live inside one, and the second subtraction holds back the chat's
container): dispatch passes a run whose project has a container free to take it (no new
container needed) and queues one whose next container would not fit the budget
(`WakeupSkipReason.InstanceAtCapacity`, retried by the 5s dispatcher; an in-memory
`pendingContainerStarts` refcount covers the window before the DB row reads Running). Dispatch
drains FIFO by `created_at` with no per-project fair-share — a deep backlog in one project
consumes freed slots first; that scheduler is the hook if this ever needs fairness. The chat
path is *not* gated: its container is exempt from the budget rather than charged against it
(reserved up front instead), and starting a chat is never refused — busy agents must not lock the operator out of the control surface. Both
knobs (memory budget, per-container RAM cap) live on the global Settings → Concurrency
page (`GET/PATCH /api/instance-settings`; `PATCH {max_container_memory_gb: null}` resets to the
computed default). The project's
`<dataDir>/teams/<teamId>/projects/<projectId>/workspace/` (id-keyed, never slugs) bind-mounts
to `/workspace`, with one subdirectory per linked repo. For each task the runner creates a `git worktree` at
`/worktrees/<task-identifier>/<repo-name>` on branch `hezo/<task-identifier>`, persisted
across runs and torn down when the task reaches a terminal status (`done`/`cancelled`). That
teardown (`removeTaskWorktrees`, a host-side `rmSync`) fires from `triggerStatusAutomations`,
so it runs for **both** close paths — a human close via `PATCH /tasks` and an agent close via
the MCP `update_task` tool — leaving no orphaned worktrees behind either way. Committed work
survives on the pushed `hezo/<task-identifier>` branch ref; the harmless dangling git metadata
is swept lazily on the next run's worktree prep or by the manual "Prune worktrees" admin action.
The working dir resolves to the designated repo's worktree (falling back to `/workspace`).

Because Docker Desktop bind-mount propagation can lag right after a container reprovision (a
path the host just `mkdirSync`'d briefly stats as missing inside the container), the runner
hardens worktree prep against a transient `ENOENT`: it (i) confirms the `/worktrees/<task>`
root is visible in-container with a bounded `mkdir -p && test -d` readiness check
(`ensureContainerDirReady`, `services/container-user.ts`) before building any worktree, and
(ii) retries `git worktree add` a few times when it fails with a transient mount-propagation
signature — "could not open … for writing: No such file or directory"
(`ensureTaskWorktreeWithRetry` + `isTransientMountError`, `git.ts`); genuine git failures
(`not a git repository`, merge/auth errors, the `not cloned` marker) fall through and fail
fast. Relatedly, the startup stale-mount repair (`repairStaleContainerMounts`, which rebuilds a
container whose bind mounts went stale across a server restart) probes **both** `/workspace`
reachability and `/worktrees` writability (a create+remove probe) in `verifyContainerWorkspace`,
so a stale `/worktrees` is caught too — without this, a run could dispatch into a container whose
`/worktrees` mount was not yet usable and fail worktree prep on the first attempt.

**All git runs in the container — the host runs none.** Hezo's only prerequisite is Docker;
there is no host `git`. Every repo/worktree operation (clone, fetch, `worktree add`, …) runs
via `docker exec` in the project container (which ships Debian's packaged git), driven from TypeScript on
the server through a `GitExecutor` seam (`services/git-executor.ts`): `ContainerGitExecutor`
in production, `HostGitExecutor` (host `execFile`) in unit tests. `git.ts` functions take the
executor plus a `{ containerPath, files }` pair per location: git commands use the container
path, and every file question - is this cloned, seed a README, install the post-commit hook,
read the push-error log, discard a stale worktree - goes through the `SandboxFiles` rooted
there. The `files` handle comes from `GitExecutor.files()`, because "run git in this
container" and "read that container's files" are one question and two separately-threaded
handles could address different containers.

That pair used to be `{ hostPath, containerPath }`, with `node:fs` checks against the
bind-mounted host path. It answered correctly only while the container was local: on a
managed backend the clone lives in the sandbox and the host path names an empty directory,
so repo-linked runs failed with `repo is not cloned` for a repo that was cloned, and repo
sync's clone-vs-adopt decision flipped depending on which pool rung a run landed on. `git.ts`
imports no `node:fs` at all now, which is what stops the assumption returning. The one
deliberate exception is `removeRepoFromWorkspace`/`removeTaskWorktrees`, which still reclaim
host disk only - that leaves a managed backend's copy in place, which costs disk rather than
correctness, and the disk-ceiling rung already recycles a container that fills up.
SSH-transport ops (clone /
fetch) are wrapped with the per-run SSH bridge (`hezo-run-with-bridge`) so `git@github.com:`
authenticates through the host ssh-agent; the container's baked-in `/etc/ssh/ssh_known_hosts`
verifies the host key. Cloning outside a run (container provision, repo link) uses a
short-lived `withProvisionBridge`. **Git-over-SSH fails fast.** Every git exec sets a
`GIT_SSH_COMMAND` carrying `ConnectTimeout` + `ServerAliveInterval`/`ServerAliveCountMax` +
`BatchMode`, so a stalled or black-holed `git@github.com` connection dies in ~45s rather than
hanging on OS TCP defaults; each exec also carries a per-op timeout (fetch 60s, clone 120s)
and, for prep, the run's own abort signal — both abort the `docker exec` stream, so a hung
transport can no longer block the run (or the per-project git lock) until it is killed by
hand. The abort actually tears the exec down because the streaming Docker transport removes
its abort handler on the *response* stream's end, never on the `ClientRequest`'s `close`
(which Bun emits prematurely, mid-body) — otherwise the timeout would fire against a handler
that had already been detached.

**Container hardening.** Each project container is created with a hardened `HostConfig`
(`provisionContainer`): a cgroup memory cap (`Memory`=`MemorySwap`= the effective RAM cap +
512 MiB headroom, so no swap escape valve — the per-project `memory_limit_gib` override when
set, else the instance-wide `default_ram_cap_per_container_gb`, default 2 GB) as a hard
backstop *behind*
the sync-loop stats poller that stays the graceful early-stop at the configured ceiling;
`PidsLimit` (4096) as a fork-bomb guard; `Init: true` so a real init reaps zombies under the
`sleep infinity` PID 1; and `CapDrop: ['ALL']` with a minimal add-back
(`CHOWN`, `DAC_OVERRIDE`, `FOWNER`, `SETUID`, `SETGID`, `KILL`, `AUDIT_WRITE`, plus the
conditional `NET_ADMIN` for MTU pinning). Two hardenings are **deliberately omitted**:
`no-new-privileges` (would break the run-user's passwordless-sudo setuid path that runtime
`apt`/`npx` installs depend on) and `userns-remap` (daemon-global — it would remap every other
container on the host and break the bind-mount ownership model below). The kernel remains the
isolation boundary within a host; the tenant boundary for untrusted multi-tenant is the VM
(see the hosted architecture), not the container.

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

**Removing the data directory (macOS deny-delete ACL).** The `.previews` bind mount targets
`/workspace/.previews` — a path *inside* the `/workspace` bind — so Docker Desktop on macOS has
to materialize a mountpoint directory (`<project>/workspace/.previews`) inside the shared
workspace folder and tags it with a `deny delete` ACL that a plain `rm -rf ~/.hezo` cannot
override (it fails with a bare "Permission denied", leaving the whole tree undeletable). Hezo's
own teardown paths already strip these — `forceRmRecursive` (`services/workspace.ts`) retries
after `chmod -RN` on darwin — but a user deleting the data directory by hand has no such relief,
so the **`hezo uninstall`** subcommand (`runUninstall`, `cli.ts`) is the supported removal path:
it refuses while a live server holds the instance lock, requires an explicit `--yes`, best-effort
stops+removes every `hezo.team`-labelled container (their ids live in the DB it is about to
delete), then `forceRmRecursive`s the data dir and the per-run socket dir.

Repo sync (`ensureProjectRepos`, `services/repo-sync.ts`) does **not trust a bare `.git`
marker** in a repo's reserved workspace directory: an agent may have run `git init` there
before the repo was connected, leaving a repo with no origin (every fetch then silently
no-ops and worktree prep dies on an unborn HEAD) or with origin pointed at the wrong repo.
The sync reads `origin` (`getOriginRemote`, `git.ts`) and **self-heals** a positively-wrong
state — adopting the directory in place (`connectExistingRepo`) when origin is missing,
repointing origin (`remote set-url`) when it addresses a different repo/host
(`remoteUrlMatchesRepo` accepts the SSH form Hezo writes plus hand-configured `ssh://`/
`https://` forms). Healing never discards local files or commits, and an **indeterminate**
answer (exec transport failure, stubbed executor) never triggers a repair — only git's own
"No such remote" / "not a git repository" do. Relatedly, the per-run fetch names `origin`
explicitly (`git fetch --prune origin`, not `--all`, which exits 0 having fetched nothing
when no remote is configured). A connected remote that has **no commits at all** is **seeded
at the start of its worktree prep, before that fetch** (`seedInitialCommitIfEmpty`, `git.ts`):
when `git ls-remote origin` shows no refs, Hezo writes a minimal `README.md` (`# <repo>`),
commits it on `main`, and pushes — so a freshly-created empty repo becomes usable on its first
run instead of dead-ending. A pre-populated directory (adopted in place) is preserved: the
README is only written when absent and `git add -A` folds any existing files into the same
initial commit. The seed commit is intentionally **unsigned** (`-c commit.gpgsign=false`) —
SSH signing runs against a live `SSH_AUTH_SOCK`, absent for this bare local `git commit`, while
the push still runs bridged (`needsSsh`) so it authenticates as the project; it is idempotent
(a no-op once the remote has any commit). Should a commit still not exist afterward (the seed
push failed, e.g. connectivity), a worktree add that can resolve neither `origin/<default>` nor
a born HEAD fails with an actionable "clone has no commits" error instead of git's opaque
`failed to resolve HEAD as a valid ref`.

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

**Commit durability (auto-push).** The per-task worktree is ephemeral — the run's hard time
limit (`run_timeout_min`) aborts and discards it, so a commit that only lives in the worktree
would be lost. To make committed work durable, worktree prep installs a `post-commit` hook into
each clone's shared hooks dir (`ensurePushHook`, `services/git.ts` → `<clone>/.git/hooks/post-commit`),
so **every commit the agent makes is pushed to `origin` immediately**. The hook is best-effort and
non-fatal (git ignores `post-commit`'s exit status): it pushes `HEAD` to the same-named remote
branch (`hezo/<task>` is single-writer, so always a fast-forward), with `--no-verify` (a durability
checkpoint, not a reviewed push — it skips any pre-push test/lint hook so a WIP commit whose tests
are still red still reaches the remote), and only when a live `SSH_AUTH_SOCK` exists — true for the
agent's own bridged commits, false for the bare prep-time catch-up merge, so that merge commit is
skipped rather than attempting an unauthenticated push. A repo-less workspace, an empty remote, or a
clone whose `core.hooksPath` is redirected (e.g. husky) simply doesn't fire it.

Non-fatal is **not** silent. The hook previously discarded the push to `/dev/null`, so a denied
push (no write access on that repo, a protected branch) produced output identical to a clean one
and the run reported success while its commits never left the container. A failed push now reports
twice: one line plus the git error on the commit's own stderr, where the agent sees it
immediately, and the full error appended to `<git-common-dir>/hezo-push-errors.log`
(`PUSH_ERROR_LOG_NAME`). Worktree prep clears that log per repo (`clearPushErrors`) so it is
scoped to the run, and the runner reads it back at run completion (`readPushErrors`) and emits it
into the run log for every prepared clone. The hook still `exit 0`s unconditionally — reporting a
failure never fails the commit. *Uncommitted*
changes are still not covered — the agent commits to preserve, and the role prompts frame frequent
committing (not a manual end-of-run push) as the durability action.

**Stranded commits (ref comparison, not the error log).** Reporting a failed push into the run log
is not the same as noticing that work is about to be left behind, and the two questions have
different answers: the error log is append-only within a run and cleared at prep, so a push that
failed at commit 3 and succeeded at commit 5 leaves a non-empty log with **nothing** actually
unpushed. At run completion the runner therefore asks the authoritative question directly —
`findUnpushedWork` / `countUnpushedCommits` (`services/git.ts`) run
`git rev-list --count refs/heads/hezo/<task> --not --remotes=origin` in each prepared clone, which
counts commits reachable from the task branch but from no `origin` tracking ref. `git push` updates
those tracking refs on success and prep fetches before the agent starts, so this is a **local**
read: no network call, and it is correct for all four shapes (current, behind, merged to the default
branch under another name, never pushed). What counts as durable is the `DURABLE_REMOTES` parameter
rather than a hardcoded remote at each call site.

A positive finding does three things: the run fails, the commits are copied out to the bundle
vault, and the container is pinned for as long as it still holds the only copy.

The run is **not** a success — it records
`error = "run ended with committed work that reached no remote …"` even when it exited 0 and
produced output, precedent being `BackgroundTerminationDetector`'s clean-exit failure.

**Recovery bundles (the durability backstop).** `vaultUnpushedWork` (`services/agent-runner.ts`)
packs each stranded clone's undelivered commits and copies them onto the Hezo instance, so a later
run on a *different* container can pick the work up. Three modules split the job so neither half
knows the other's business: `createRecoveryBundle` / `fetchRecoveryBundle` /
`fastForwardFromRecovery` (`services/git.ts`) are the git operations, `bundle-vault.ts` is the
store, and `sandbox/recovery.ts` is the seam between them.

- **A bundle, not a mirror remote.** A managed backend's shared store is an object store
  (`mountpoint-s3`), and a bundle is one finished file — which is the only shape such a store
  supports. Re-measured against a live Daytona volume (see the table below): `git init --bare`
  fails on it outright, so a mirror remote is not an option there at all.
- **Built on local disk, moved as a finished file.** `git bundle create` seeks while writing and
  dies (`pack-objects died`) against anything that is not a real filesystem, so it writes to
  `<clone>/.git/hezo-recovery.bundle` — local disk, already owned by the run user — and the bytes
  are then copied out through `SandboxFiles`, which is the seam that already exists for
  container-writes-host-reads and is implemented on every backend. The vault is therefore
  **backend-agnostic**: no volume mount and nothing per-adapter to keep in step, and the copy lands
  under `<dataDir>/git-recovery/<projectId>/`, where the operator's backups already are.
- **Why the instance's disk and not a provider volume.** The original design put the shared store
  on a Daytona volume plus a Docker bind mount. Measured against the live API with a
  volume-scoped key, that would be **the same bundle design and strictly worse**, so it was not
  built:
  - A volume holds whole files only, so it could not hold a bare repo or a live working tree. A
    volume-backed store would therefore also be a bundle store — no architectural gain over the
    seam that already exists.
  - **`chmod` is not implemented**, so every file on the mount is `0666` owned by `nobody`. The
    vault writes bundles `0600`; on a volume that guarantee is unavailable, and a bundle is the
    user's source code readable by every container that mounts it.
  - Only containers can read a volume. Hezo itself cannot, so the run-end copy-out would need a
    container alive to perform it, and the recovery copy would sit outside whatever backs up the
    instance.
  - It needs per-provider volume provisioning plus a Docker bind-mount equivalent: two
    implementations of one thing, against zero today.
- **A delta, not a copy of the history.** `--not --remotes=origin` packs only what no durable remote
  has, recording the remote tips as prerequisites — kilobytes for an ordinary task. A clone with no
  remote to exclude against produces a bundle of the whole branch, which is what
  `MAX_RECOVERY_BUNDLE_BYTES` (64 MiB, checked via `SandboxFiles.size` *before* the read buffers it)
  refuses rather than moving.
- **Restored in run prep, strictly after the origin fetch** (`restoreRecoveryBundle`), because the
  delta's prerequisites are the remote tips. Refs land under `refs/remotes/hezo-recovery/*` — so the
  commits are *present* and nothing can be lost by destroying the source container — and
  `fastForwardFromRecovery` then brings them onto the task branch, fast-forward only.
- **`RECOVERY_REMOTE` is deliberately not in `DURABLE_REMOTES`.** A recovered ref means Hezo holds a
  copy, not that the user's git host does.

**The pin and the run failure are decided by different things**, which is the point of the vault.
`setPoolMemberUnpushedFlag` (`services/sandbox/pool-db.ts`) sets
`container_pool_members.has_unpushed_commits`, which `planIdleShutdown` excludes from both suspend
and destroy — but it is now set from whether the copy-out **failed**, not from whether the work
reached `origin`. A vaulted run releases its container (the work exists in two places) and still
fails (it never reached the remote); a run whose bundle could not be built, was oversized, or could
not be moved keeps the pin, failing closed. The scan still distinguishes "no unpushed work" from
"could not tell": a git failure or a missing clone yields `null`, which neither fails the run nor
releases a pin an earlier run set — clearing a pin on an unanswerable check would destroy exactly
the container the pin exists to protect.

The vault's invalidation rule is success: a stored bundle is dropped once a later run finds that
branch carries no unpushed commits, i.e. the work reached `origin` after all. That is the only
condition under which it discards anything, and it is why container teardown deliberately does
**not** clear it — teardown wipes the local clones, so from that point the bundle may be the only
copy. Only deleting the project (`DELETE /api/projects/:projectId` → `removeProject`) clears it.

None of this changes anything while a project has one container: the next run hits the same `.git`
and the ref is still there. It matters once a project has several — run 1 commits into container A,
its push is denied, run 2 lands on container B and fetches from a remote that never received the
commit, and A is destroyed when it goes idle. Nothing fails at pool size 1, which is why
`git-recovery-bundle.test.ts` **destroys the source clone** between saving and restoring rather than
re-running against the same one.

**Admin git-state & recovery (superuser).** Because a clone's live state lives only in the
container, the project Git settings page exposes a per-repo, **superuser-only** panel to inspect
and repair it. `GET /api/projects/:projectId/repos/:repoId/git-state` reads it — the clone's
default branch, HEAD, dirty flag, and ahead/behind vs. the last-fetched `origin/<default>` (all
computed locally, no network fetch), plus the active `/worktrees/<task>/<repo>` worktrees joined
to their tasks and the project's active (queued/running) agent-run count (`active_runs`, from
`getProjectConcurrency`) so the panel can disable the reset controls proactively instead of only
failing them server-side — and returns `{ container_running: false }` when the container is stopped
rather than auto-starting one, since a passive inspect must not trigger a provision. It also
re-checks and returns `can_push` (`refreshRepoPushAccess`), computed **before** the
container-gated branch so it is reported either way — the check needs GitHub, not a container,
and the panel is where an operator notices write access changed upstream. `POST .../reset`
runs one of three recovery actions: `discard_local` (`git reset --hard` + `clean -fd` — no `-x`,
so gitignored build artifacts survive — after a best-effort fetch; the escape hatch for the
"local changes would be overwritten" fast-forward failure that otherwise silently stalls sync),
`prune_worktrees` (force-removes the on-disk worktrees of closed/terminal and orphaned tasks —
`removeWorktreesWhere`, keeping open tasks' worktrees — then `git worktree prune` to clear
dangling metadata; the branch refs survive), and `reclone` (wipe the clone via
`removeRepoFromWorkspace` then re-run `performRepoSetup`, reusing its
`pending`→`ready`/`failed` lifecycle). Reset is
**blocked (409) while any agent run is active on the project** (`getProjectConcurrency`) — it
mutates the shared `.git` a live worktree prep also touches, and reclone deletes worktrees a run
may hold — and `discard_local`/`prune_worktrees` additionally require a running container. Every
read and reset runs under the same per-project git lock (`withProjectGitLock`, extracted to
`lib/git-lock.ts`) as run-time worktree prep, so they never interleave on the shared `.git`.

**Aborting actually kills the process.** Docker exposes no API to signal an exec'd process, and
disconnecting from the exec attach stream (what aborting the run's signal does) leaves the agent
CLI **running** inside the container — it would keep burning tokens and writing to the workspace
even though the run reads as cancelled. So on any abort where the container is still alive (a user
terminate, a timeout — *not* `container_*`, where the process died with the container), the runner
hard-kills the run's whole process tree: `DockerClient.killRunProcesses` execs a `/proc` scan (as
root, so it can signal the deprivileged run-user) that `kill -9`s every process whose environment
carries the run's `HEZO_HEARTBEAT_RUN_ID` marker (children inherit it). Best-effort and bounded by
its own short timeout, so a kill failure never masks the run result or blocks finalization. This is
what makes a terminate immediate — in-progress work is lost, as the confirmation dialog promises.

**Process-tree lifecycle & dangling-process cleanup.** The abort-kill above is one instance of a
system-wide invariant: **every abandonable exec carries a scope marker in its env, and every
abandonment path reaps by that marker**, because a docker-exec'd process the server merely stops
attending to would otherwise run in the (deliberately warm-surviving) project container forever.
`HEZO_HEARTBEAT_RUN_ID=<scopeId>` is the universal marker — the heartbeat run id on the agent CLI
exec and run-time git prep (`ContainerGitExecutor.forPrep` takes a required `scopeId`), the
`provision-<hex>` id `withProvisionBridge` mints for provisioning/repo-link/reset git ops, a
`gitop-<hex>` tag for bridge-less route git ops, an `mcp-install-<hex>` tag on the local-MCP
`npm install` exec, and the chat `sessionId` on CEO chat execs. Kills are generalized as
`DockerClient.killProcessesByEnvMarker` (marker-value validated against a shell-safe character
class before interpolation; `killRunProcesses` is its run-id specialization). The reap points:

- **Per-op timeout / run abort** (`ContainerGitExecutor.exec`): on the timeout or run-signal
  branch the executor fires a tracked, best-effort marker kill for its scope — a generic docker
  transport error skips it (container likely gone). The MCP installer does the same when its
  install timeout fires.
- **Chat interrupt/preempt**: every chat exec (turn, compaction, titling) additionally carries a
  per-exec `HEZO_EXEC_SCOPE_ID=<uuid>` and an abort reaps by **that**, never the session id —
  a session's execs run concurrently across conversations, so a session-wide kill would murder a
  sibling conversation's live turn. Session-wide reaping by `sessionId` happens only at session
  teardown (manager stop/restart/health teardown), when everything has already been aborted.
- **Clean shutdown** (`shutdownRuntime`): before `jobManager.shutdown()` aborts the runs, an
  awaited `JobManager.killLiveRunProcesses()` reaps every live run's tree (per-kill bounded,
  whole pass raced against its own timer) — the runner's own abort-kill would race
  `process.exit`. Chat teardown then reaps its session trees.
- **Orphan tick**: when the ~30 s orphan detector marks a stranded run failed — a `running` one
  whose process vanished, or a `queued` one whose driver died before it ever started — it also
  fires `killRunProcesses` against the task's project container (task-less runs skipped — the boot
  sweep is their backstop). The kill is a no-op for a run that never started, and harmless.
- **Boot sweep** (crash backstop): `reconcileOnStartup`'s fourth container pass
  (`sweepDanglingContainerProcesses`) scans each running container's `/proc`
  (`DockerClient.listHezoProcesses` — emits only pids carrying a marker, an
  `SSH_AUTH_SOCK=/run/hezo/…` env, or a bridge/socat cmdline) and applies the pure policy in
  `services/process-sweeper.ts` (`decideSweepKills`): bridge infrastructure
  (`hezo-run-with-bridge`/`hezo-ssh-bridge`/socat on `/run/hezo/`) always dies; a marker-carrying
  process dies unless its id is a **succeeded** `heartbeat_runs` row — so a background process a
  successful run intentionally left (e.g. a dev server on the project's dev port) survives a
  restart, while failed/cancelled-run trees, previous-lifetime chat sessions, and
  provision/gitop/mcp-install ops (never succeeded-run rows) die; a marker-less process dies only
  when bridge-socket-scoped (legacy trees from versions predating the marker). PID 1 and anything
  younger than 120 s (`SWEEP_MIN_AGE_SECS` — routes are live during reconcile, so a just-started
  op's marker isn't in the DB yet) are never touched. Kills go through `DockerClient.killPids`
  (validated pid list). The pass runs after the stranded-run repair (which flips previous-lifetime
  `running` rows to `failed`), is per-container best-effort, and skips cleanly when Docker is
  unreachable.

Independently, `hezo-run-with-bridge` itself is hardened (see § SSH signing & git): the exit trap
kills socat's whole process group, and bounded git ops carry an in-container
`HEZO_EXEC_DEADLINE_SECS` self-deadline so the tree dies on its own even if the server process is
gone mid-op.

**Timeout handling (graceful cut).** The `run_timeout_min` timer aborts the run's signal with a
tagged `'run_timeout'` reason (`JobManager.launchTask`), so the runner finalizes it as `timed_out`
— distinct from a bare abort (user cancel / shutdown → `cancelled`) and container death
(`container_*` → `failed`); `runAgent`'s `abortedRunStatus` maps the reason. On a `timed_out` run
`onAgentComplete` **auto-queues a same-task continuation wakeup** (`queueTimeoutContinuation` →
`createWakeup(Timer, {reason:'timeout_continuation'})`) so the agent resumes the task on the next
wakeup pass — committed work is already pushed, so nothing is lost — and it **skips the failure
ping + next-task chain** that a real failure gets. A loop cap (`MAX_CONSECUTIVE_TIMEOUT_CONTINUATIONS`)
stops re-queuing once the task times out that many times in a row (a non-timeout run resets the
streak), so a task that never fits its run window can't loop forever.

**Success gate.** A clean exit (`exit_code = 0`) only counts as `succeeded` if the run
**produced output** — `produced_output` is set by any write tool (and a post-run worktree
diff), or the agent explicitly calls `report_no_work`. A clean exit with neither is a
silent no-op, marked `failed`. One further demotion overrides even a run that *did* write:
if the CLI force-terminated still-running background work (Claude Code's headless
`--print` mode prints "Background tasks still running after Ns; terminating" and kills a
`run_in_background` job or a `Workflow` fan-out that never synthesized), the run
**abandoned unfinished work** and is marked `failed` regardless of earlier output
(`services/background-termination.ts` scans the CLI's own diagnostic output — stderr and
non-JSON stdout lines — so an agent that merely echoes the phrase can't trip it). The scan
is **incremental**, fed from the same per-chunk callback the log pipeline uses: the exec
transport retains no output at all (see below), so the verdict is accumulated as the run
streams rather than computed from a kept transcript. This is
a backstop to `CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS=0` (which lifts the wait ceiling) for
CLI versions that ignore the override. The completeness **stop-hook** (§ 6) is a separate
gate that blocks the agent from ending its turn with unfinished work.

**Sessions & recovery.** `agent_task_sessions` persists per-task session state; each
heartbeat spawns a fresh subprocess and injects handoff markdown from the prior session,
with compaction policies rotating on token/run/age thresholds. The orphan detector uses
`heartbeat_runs.process_pid`/`retry_of_run_id`/`process_loss_retry_count` to recover runs
whose process disappeared. A ~30 s sweep (`processBudgetResumes`) lifts budget-paused
agents back to `idle` once a window rolls over or a limit is raised.

---

## 6. AI providers, runtimes & the completeness stop-hook

**Providers → runtimes.** `AiProvider` has **eleven** values — `anthropic`, `openai`,
`google`, `deepseek`, `z_ai`, `openrouter`, `kimi`, `kimi_code`, `x_ai`, `ollama`, `lmstudio` — and
`AgentRuntime` has **six** — `claude_code`, `codex`, `gemini`, `opencode`, `grok`, `kimi`. The mapping
is data-driven in
`packages/shared/src/types/common.ts` (`PROVIDER_RUNTIME_ADAPTERS`, `PROVIDER_TO_RUNTIME`,
`PROVIDERS_BY_RUNTIME`): Anthropic + DeepSeek + Z.ai + Kimi → `claude_code` (DeepSeek/Z.ai/Kimi
inject `ANTHROPIC_BASE_URL` + model defaults to point Claude Code at their Anthropic-compatible
gateway — Kimi at `api.moonshot.ai/anthropic`, model `kimi-k2.7-code`), OpenAI → `codex`,
Google → `gemini`, OpenRouter → `opencode`, xAI → `grok` (its own first-party Grok Build CLI,
`XAI_API_KEY` direct to `api.x.ai`, model `grok-4.5`), Kimi Code → `kimi` (Moonshot's own CLI,
see below), Ollama + LM Studio → `claude_code` (local runners, see below).

**Moonshot's models are reachable two ways, and both are supported.** `kimi` drives
Claude Code against Moonshot's Anthropic-compatible gateway (above); `kimi_code` drives
Moonshot's first-party **Kimi Code CLI** (`kimi`, npm `@moonshot-ai/kimi-code`) on the
`kimi` runtime. They are siblings — same account, same API key, same models, different
harness — so an operator may configure either or both and choose per agent
(`member_agents.model_override_provider`) or per task (`tasks.runtime_type`). The
`AgentRuntime.Kimi` value reuses the `kimi` label that has existed in the `agent_runtime`
enum since `001_initial_schema.sql`: it was the original standalone Kimi runtime, retired by
migration `010` when Kimi moved onto Claude Code, and Postgres cannot drop enum labels — so
the new runtime needed no enum change (only the `kimi_code` provider did, in `048`).

Three things make this runtime unlike the Claude-Code-driven providers:

- **Credential delivery is env-only via the `KIMI_MODEL_*` family.** Kimi Code deliberately
  does not read provider API keys from the shell environment; they are expected to live in
  `config.toml`. The documented exception is that family, which *is* shell-read and registers
  a temporary in-memory provider for the launch. Hezo uses it so the key stays in env and is
  never written to a file the agent can read. `KIMI_MODEL_NAME` is what activates the family,
  so it is always set and `buildProviderEnv` overrides it with the run's selected model.
  `KIMI_MODEL_CAPABILITIES` must include `image_in`, or the CLI's `downgradeUnsupportedMedia`
  step silently replaces every image part with a placeholder string — which would break
  `read_project_asset`, the only path by which an agent ever receives an image.
- **`KIMI_CODE_HOME` is a real variable the CLI consumes**, unlike the Hezo-internal markers
  the Claude Code entries use in `SUBSCRIPTION_LAYOUTS`. It relocates the entire data root
  (config, `mcp.json`, credentials, per-session logs) to the per-run directory. That is the
  only isolation mechanism available — there is no `--mcp-config`-style flag — and it is also
  what makes the session-log reads below possible.
- **No token usage on stdout.** Like Grok, the `stream-json` stream carries none, so cost is
  recovered post-run by `extractKimiUsageFromSessionLog` from the per-session `wire.jsonl`
  under that home, then priced from `model_pricing` like every other runtime. The runner's
  `recoverOffStreamRunUsage` dispatches both file-based recoveries and scrubs the file
  afterwards (each can carry the provider credential).

**Local providers carry their endpoint on the credential, not in `staticEnv`.** Ollama and
LM Studio serve Anthropic's Messages API natively, so they reuse the Claude Code runtime
with no shim — but their endpoint is the operator's own machine and therefore cannot live in
a compile-time constant. The URL is stored per-config in `ai_provider_configs.metadata ->
'base_url'` (no new column), surfaces on `AiProviderCredential.baseUrl`
(`readConfigBaseUrl` in `services/ai-provider-keys.ts`), and is consumed in three places:
`buildProviderEnv` stamps it as `ANTHROPIC_BASE_URL` (and blanks `ANTHROPIC_API_KEY`, since
Claude Code would otherwise prefer an inherited key over `ANTHROPIC_AUTH_TOKEN`);
`providerDirectUpstreamHosts(provider, baseUrl)` adds its host to NO_PROXY so local traffic
skips the MITM proxy; and the ai-providers routes build `<baseUrl>/v1/models` for both key
verification and the live model list (`resolveCatalogEndpoint`, branching on
`AI_PROVIDER_INFO[p].local`). `encrypted_credential` is NOT NULL, so a config with no
operator-supplied token stores the runner's sentinel (`ollama` / `lmstudio`) instead.
`claudeCodeProviderUsesCustomEndpoint` returns true for them, so the Stop-hook judge and the
Claude Code subagent default track the run's selected model — the only workable choice, since
the models an operator has pulled are unknowable here. With no `model_pricing` rows, local
runs price at `$0`, which for local inference is correct rather than the usual fail-low.

**Provider config.** `ai_provider_configs` is instance-level (shared across teams), one
row per `(provider, label)`, each inlining an encrypted credential. `auth_method`
distinguishes an **API key** (injected as env at run start) from a **subscription** blob
(materialized to a per-run mount in the container). Subscription auth is supported by
Anthropic, OpenAI, and Google (xAI is API-key only). A config's `status` is `verified` (the healthy default —
the add flow live-verifies the key, and the Verify action persists the result, restoring
`verified` on a key that had gone `invalid`), `invalid` (a verify was rejected), or
`revoked` (a retired provider). Exactly **one** config instance-wide carries the
`is_default` flag — a single global default enforced by a partial-unique index
(`ai_provider_configs_single_default`); the first config added to the instance auto-takes
it, and `setDefaultAiProvider` moves it atomically. `resolveRuntimeForTask` filters by
`status = 'verified'` and `PROVIDERS_BY_RUNTIME[runtime]`, then orders
`is_default DESC, created_at ASC`, so the global default wins whenever it's a candidate
for the chosen runtime, else the oldest verified config; an agent's `model_override_*`
(or the config's `default_model`) sets the CLI `--model`.

**Live model listing.** Every UI surface that picks a specific model — the provider
`default_model` selector and the per-agent model override — populates its options from
`GET /api/ai-providers/:configId/models`, which decrypts the stored key and fetches the
provider's live catalog (`AI_PROVIDER_INFO[provider].verifyEndpoint`, the same URL the add
flow verifies against, normalized by `parseProviderModels` in `@hezo/shared`). No model list
is hardcoded. The call is server-initiated and goes **direct** (not through the agent egress
proxy). Subscription-auth configs short-circuit with `SUBSCRIPTION_UNSUPPORTED` (their blob is
not an API key the catalog endpoint accepts), and the pickers degrade to the CLI's default
model; the pricing-override model-id field stays free-text but offers the aggregated live
catalog as autocomplete suggestions.

**Reasoning effort.** Each run resolves an `agent_effort` level
(`minimal|low|medium|high|max`) from the wakeup payload → `member_agents.default_effort` →
global `medium`. Each runtime maps it natively: `claude_code` appends
`think`/`think hard`/`ultrathink`; `codex` passes `-c model_reasoning_effort=`; `gemini`
sets `GEMINI_REASONING_EFFORT`; `kimi` sets `KIMI_MODEL_THINKING_EFFORT` (it has no
`minimal`, which maps to `low`); `opencode`/`grok` steer effort through the portable prompt
directive. It's also exposed as `HEZO_AGENT_EFFORT`.

**Per-runtime wiring** lives in the MCP injectors (`services/mcp-injectors/`, six
adapters in `index.ts`: ClaudeCode, Codex, Gemini, OpenCode, Grok, Kimi). Each builds the
CLI invocation (headless prefix, prompt delivery, stream/auto-approve args), injects MCP
servers, and wires the stop-hook. OpenCode, Grok and Kimi Code take the prompt as a CLI
**argument** (`HEZO_PROMPT_MODE=arg`, `RUNTIME_PROMPT_DELIVERY`); the rest read it on stdin.
Grok writes its MCP servers into a per-run `config.toml` (`$GROK_HOME`, relocated via
`SUBSCRIPTION_LAYOUTS`) with inline bearer headers, plus `[cli] auto_update=false`; shared
TOML rendering for the Codex config lives in `mcp-injectors/toml.ts`. Kimi Code splits its
configuration in two — MCP servers in `mcp.json`, the `[[hooks]]` Stop entry and
`[permission.rules]` in `config.toml`, both under `$KIMI_CODE_HOME` — and is the only adapter
whose per-server tool filter maps one-to-one onto the descriptor (`enabledTools` /
`disabledTools` are native keys). Its bearer travels by env-var name
(`bearerTokenEnvVar`), so `bearerTokenStorage` is `'env-var'` and `validateInjection`
enforces that no token reaches a file. Kimi Code's `[[hooks]]` entries accept **exactly four
keys** (`event`, `matcher`, `command`, `timeout`) and the CLI refuses to load a config
carrying any other, which would break every run on that runtime rather than just the hook.
**Grok and Kimi Code report no token usage on their streams** — for Grok the runner points at
a per-run `--debug-file` and parses the `process_conversation_turn` tracing spans
(`extractGrokUsageFromDebugLog`); for Kimi Code it reads the per-session `wire.jsonl` under
the run home (`extractKimiUsageFromSessionLog`, counting turn-scoped records and never
summing cumulative session totals). `recoverOffStreamRunUsage` dispatches both and scrubs the
file afterwards — Grok's holds the `XAI_API_KEY`, and a wire log plausibly captures the
Moonshot bearer.

**Runtime timeout hardening.** Each CLI ships default timeouts that would cut off Hezo's
legitimately long agent/background work; every runtime is relaxed at its own config surface
(no exact cross-runtime env analog exists for Claude Code's `CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS=0`).
**Claude Code** lifts the headless background-wait ceiling via that env var (in
`CLAUDE_CODE_QUIET_ENV`). **Codex** (`config.toml`) sets top-level
`background_terminal_max_timeout = 3600000` (its direct analog; default 5 min — Codex has no
`0`-means-infinite sentinel, so a large finite value is used) and per-`[mcp_servers.*]`
`tool_timeout_sec`/`startup_timeout_sec`; its built-in `openai` provider's per-stream knobs
(`stream_idle_timeout_ms`) are **not** tunable while going direct (config/`-c` overrides of a
built-in provider are silently ignored by Codex's vacant-only merge) and only drive a
reconnect/retry, not a kill, so they're left at default. **Gemini** (`settings.json`) sets
`tools.shell.inactivityTimeout = 0` (disables the 5-min kill of a silent shell command) and a
per-MCP-server `timeout`. **OpenCode** (`opencode.json`) raises the per-MCP-server `timeout`
from its 5 s (!) default to 10 min; its bash tool has a non-configurable 10-min hard cap.
**Grok** (`config.toml`) raises `[toolset.bash].timeout_secs` and per-`[mcp_servers.*]`
`startup_timeout_sec` (its bash already auto-backgrounds on timeout rather than killing).
**Kimi Code** (`mcp.json`) raises per-server `startupTimeoutMs`/`toolTimeoutMs` from its 30 s /
60 s defaults; these are set per-server rather than through the global
`KIMI_MCP_*_TIMEOUT_MS` env vars so one slow connector can't be masked by a blanket override.
All values live as named constants in each `mcp-injectors/*.ts` adapter.

**Completeness stop-hook.** Every run is gated by a judge that fires when the agent tries
to end its turn and **blocks** it (keeping the same headless exec alive) when it's bailing
on failing tests, calling problems "out of scope", deferring without filing a sub-task,
abandoning a plan it announced in the thread without revising it there, ending the run
with a handoff only in its final message (which is delivered to no one) instead of a posted
comment — an active @-mention or baton-passing address, or a **stative "awaiting <named
approver> sign-off" recap** that names who signs off next but posts no active mention (the
recap blocks whether the ticket is left non-terminal or marked terminal; rule 11's
own-review close-gate reaches only the terminal case) — or marking a ticket done on the
strength of its own review while an approval the thread established as required — the admin's
final approval or a named approver's sign-off — was never granted (an inherited
approval-chain requirement, distinct from an unanswered question the agent itself posted; a
rework/detour does not discharge it). It **allows** the stop when the agent is legitimately parked on
input it can't obtain itself — an `@admin` comment awaiting a reply, a `request_credential`,
or a filed hire proposal / opened approval pending an admin decision — with the task left
non-terminal; the admin's reply or resolution auto-wakes the agent (a hire resolution queues
a `hire-resolved:<id>` wakeup for the requester), so it need not spin re-reporting no work.
The rule body (`STOP_HOOK_RULES` in `stop-hook-prompt.ts`) is identical across runtimes;
each provider has a judge-model constant (Anthropic `claude-sonnet-4-6` / DeepSeek
`deepseek-v4-pro` / Z.ai `GLM-4.7` / Kimi `kimi-k2.7-code` / OpenAI `gpt-4o-mini` /
Google `gemini-1.5-flash`). For the third-party Anthropic-compatible Claude Code providers
(DeepSeek/Z.ai/Kimi) the judge — and the Claude Code subagent default
(`CLAUDE_CODE_SUBAGENT_MODEL`) — instead track the run's live-selected model
(`judgeModelForProvider` / `claudeCodeProviderUsesCustomEndpoint`), falling back to the constant
only when the run pins none, so a provider model upgrade (e.g. Kimi `kimi-k2.7-code` → `k3`)
needs no code change; Anthropic keeps its stable, cheaper Sonnet constant. Wiring differs by
runtime's native hook: Claude Code uses a `type: "prompt"` `Stop` hook (makes the judge call
itself, resolving the model via `judgeModelForProvider` over `CLAUDE_CODE_JUDGE_MODEL_BY_PROVIDER`);
Codex/Gemini/Kimi Code use command scripts (`buildJudgeScriptForRuntime` over `JUDGE_SPECS`) that
call the provider API. Every runtime's judge short-circuits on `stop_hook_active` — allow
the stop once the turn has already been continued once — so a persistent verdict can't loop
the same headless exec: the Codex/Gemini scripts guard it in code, and the Claude Code prompt
hook now instructs the judge to do the same.

**Kimi Code needs two substitutes to run the same judge.** Its `Stop` hook *is* blockable
(one of only three such events), but its stdin payload carries only `hook_event_name`,
`session_id` and `cwd` — neither the agent's final message nor `stop_hook_active`. So its
`JUDGE_SPECS` entry sets `sessionLogLookup` (read the last assistant message from the run's own
`wire.jsonl` under `$KIMI_CODE_HOME` — the same file the usage scrape parses) and
`loopGuardFile` (a `.hezo-stop-blocked` marker in that home, written before emitting a block
and checked on entry, standing in for the absent flag so the one-block ceiling is real rather
than nominal). Both are opt-in fields that stay unset for every other runtime. A block is
signalled on all three channels Kimi documents — exit code 2 (its "intentional block"; any
other non-zero is treated as a broken script and fails open), the reason on stderr, and the
decision JSON on stdout — so the verdict survives whichever channel the installed version
honours. For Claude Code the `$ARGUMENTS` placeholder is
the raw Stop-hook input JSON, which carries both `stop_hook_active` and the agent's final
message in `last_assistant_message`; the prompt points the judge explicitly at that field so a
weaker judge model (e.g. DeepSeek judging itself) evaluates the message — the text rule 10
turns on — rather than the surrounding metadata. **OpenCode and Grok are the exceptions — no
judge** (OpenCode's plugin API can't block-and-continue headless; Grok's hooks advertise
`blockingEvents: ["pre_tool_use"]` only, so its `Stop` hook is passive and can't keep the loop
alive), so both run fail-open. File-mount subscription runtimes fail open (no API key in
env); Anthropic subscription still fires via `CLAUDE_CODE_OAUTH_TOKEN`. Full per-runtime
detail is in `AGENTS.md` › AI runtime hooks.

**Handoff-delivery net.** The stop-hook judge is best-effort — an LLM, model-dependent, and it
blocks at most once per run (the `stop_hook_active` ceiling) — so a stranded handoff is *also*
caught **deterministically** at run completion, independent of any judge. In `agent-runner.ts`,
when a run exits cleanly, the runner reads the run's final assistant message from the stream
parser (`getFinalAssistantMessage()`). Three stranded forms are handled, differently:
(1) an **active `@`-mention** (`extractMentionSlugs`) the run never posted as a comment is
delivered verbatim via `postAgentComment` — the same insert + broadcast + `fireCommentWakeups`
path `create_comment` uses — so it fans out to the admin inbox / agent wakeup instead of
vanishing (the agent wrote an explicit, unambiguous wake; delivering it is safe). This flips an
otherwise no-op run to a success and is why the one-block judge ceiling is acceptable.
(2) an **unlinked bold/leading-line address that reads like an ask** (`**slug** — … when you
resume …`, the name after a short routing label like `Next step: slug — …`, or an
action-assignment heading/label line like `## Required actions for slug` — where the phrase on
the line is itself the ask signal, since the imperative list below it carries none — or a **name
bound directly to a sign-off/approval gate mid-sentence** (`awaiting slug sign-off`, `needs
slug's approval`, `slug to sign off` — the completion-report handoff that names who signs off
next but sits inside the sentence rather than opening a line, so the address-position forms miss
it; the binding is itself the ask signal) via
`detectUnlinkedTeammateAsks`, gated on directed-ask intent — an explicit request signal such as a
second-person pronoun, `please` or a `?`, or a baton-passing status line, which is what catches a
report whose closing handoff block is present but passive throughout. The baton-passing set covers
both the phrasings that name the recipient ("ready for review", "all yours", "handing this back",
"passing this to …", "take it from here") and the ones that name only the gate being waited on
("awaiting review", "for review", "pending approval", "sign-off needed") — the latter is the same
handoff with its `ready` opener dropped, and it carries no pronoun, no imperative and no `?` at
all; a bold name written for mere emphasis is never touched) is the wakes-no-one
trap — but the net does **not** rewrite the
agent's words or auto-deliver it (guessing intent to force a wake overreaches). `create_comment`
already warns the agent interactively when it posts such a comment; the final-message path skips
that check, so the runner surfaces the **same warning in the run log** and leaves the handoff
undelivered.
(3) a **plain direct answer** (no mention, no ask) to a human who addressed this agent by
**replying to** or **@-mentioning** it — the "give me the link" case, where the human asked and
expects the answer in the thread but the agent left it only in its final message. When the run
was woken by a `WakeupSource.Reply`/`Mention` whose waking comment was authored by a human/admin
(author not in `member_agents`, so agent-to-agent chatter is excluded) and the run posted no
comment of its own on the task, the final message is delivered verbatim as a reply threaded under
the waking comment (`postAgentComment` with `parentCommentId`), flipping the no-op run to success.
Runs on **every** runtime including OpenCode (which has no judge at all).

**Comment-write mention advisories.** Upstream of the net, `create_comment` / `update_comment`
run a set of best-effort, non-blocking checks over the posted markdown and return their findings
to the agent in a `warning` field on the already-persisted result. They **never rewrite the
comment** — the agent fixes it in place with `update_comment`. The checks (all in
`lib/mentions.ts`, scoped by `resolveWarnableSlugs` = the task team's roster + HQ + `@admin`,
minus the author): `detectUnlinkedTeammateReferences` (a teammate addressed by bold/bare name,
which notifies nobody), `detectPassiveTeammateAsks` (a `@@slug` address that should have been
active), and `detectNarratedActiveMentions` — the inverse failure, where an **active** `@slug` is
used to *describe a mention living in another comment* ("the @admin mention in TASK-7#comment-9")
and so fires a real wake here instead of pointing there. The offered fix for that one is
**backticks**, not the passive form: `@@admin` renders as the bare word `admin` and loses the
token being quoted, while `` `@admin` `` keeps the literal text inert. Because the sibling
backticked-entity check would otherwise tell the author to un-backtick exactly that token,
`detectQuotedMentionTokens` subtracts backticked-and-narrated slugs from its candidates, so the
two advisories can never contradict each other.

`detectPassiveTeammateAsks` gates its two addressing forms differently, because they differ in
how ambiguous they are. A **leading-line** `@@slug — …` (including one behind a routing label,
`Next step: @@slug — …`) is flagged **unconditionally, with no ask gate**: opening a line with a
teammate reference and a separator is the *address* shape, and the address shape is reserved for
active mentions — a reference you only mean to make belongs inside a sentence. This is what
catches `@@admin — release is done.`, which is asking the admin to register the fact but carries
no pronoun, no `please` and no `?`, so no ask gate could see it. An **emphasised** `**@@slug**`
stays gated on `readsAsAsk` over its own paragraph(s), since bold marks attribution and headings
as much as address. `SHARED_INSTRUCTIONS` teaches the matching rules: an active mention's shape
is a line opening `@<slug> - ` then the ask, several recipients get one such line each, and a
line never opens with `@@<slug> - `.

---

## 7. Credentials, egress & secrets

The core invariant: **an agent references a secret by placeholder, never by value.**
Wherever it would write a secret it writes `__HEZO_SECRET_<NAME>__` (grammar in
`lib/credential-placeholder.ts`, shared by the proxy, `request_credential`, and the admin
secrets route so a creatable name is exactly a substitutable name). The threat model
assumes the agent itself may misbehave; the egress proxy is the choke point.

**Secrets.** `secrets` rows are AES-256-GCM ciphertext plus `allowed_hosts` (e.g.
`['api.stripe.com']`, `*.googleapis.com` wildcards) or the `allow_all_hosts` escape hatch.
They are **instance-global** — `name` is globally unique and the egress proxy resolves the
placeholder by name with no project context — bounded per-secret by `allowed_hosts`. The
master key (§ 10) decrypts at request time.

The decrypted vault is **cached in server memory** rather than re-read and re-decrypted per
request. `loadAllSecrets` runs for every proxied request carrying a placeholder — every MCP
call an agent makes — and cost two queries plus an AES-256-GCM decrypt of the whole vault
each time, on the one serialized database handle. Invalidation has three layers on purpose:
every path that writes `secrets` calls `invalidateSecretsVault()`; the cache is dropped
whenever the master key changes state, so decrypted material never outlives its unlock; and
a short TTL means a write path that forgets the first degrades to seconds of staleness
rather than a permanent stale read. Concurrent misses share one load. The values live only
in server memory on the proxy path, exactly as they did transiently before — nothing here
is reachable from an agent run, so the red line is untouched.

Connectors, by contrast, are project-scoped
(`mcp_connections.project_id`, NULL = global); a credential does **not** follow its
connector's scope (moving a connector between scopes leaves its credential untouched).
Instead the credential *name* carries the project signal (see the API-key row below), so a
global credential list stays legible.

**Connector ↔ credential relationships.** The admin credentials list (`GET /api/credentials`)
returns, per credential, the `connectors` that use it (matched via `api_key_secret_id` or the
connector's OAuth access token); the connector lists return the reverse `credentials` array.
The web surfaces render each as an indented, deep-linked sub-list under the other (credentials
page ↔ `/settings/connectors`, connector pages ↔ `/settings/credentials`, both via a
`?focus=<id>#<id>` anchor). A credential in use by ≥1 connector cannot be deleted — `DELETE
/api/secrets/:id` returns `409 IN_USE` and the UI disables the revoke control with a tooltip;
remove the connector(s) first.

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
certs and is bind-mounted into every container's trust store, installed there by
`update-ca-certificates` at provision and additionally handed to Node via
`NODE_EXTRA_CA_CERTS`.

**`CURL_CA_BUNDLE` and `GIT_SSL_CAINFO` are deliberately not set**, for the same reason
`SSL_CERT_FILE` is not: they **replace** the trust bundle rather than adding to it.
That is harmless only while every TLS peer is the MITM proxy. Under the tunnel's split
routing, where an agent reaches ordinary public hosts directly, curl or git talking to one
would check a real public certificate against a bundle holding only the Hezo CA and fail.
The system trust store carries the CA for them instead, so both kinds of certificate
verify.
Unlike the CA cert (deliberately world-readable so any in-container uid can read it), the
per-run runtime config and subscription-credential files the server writes into the
`/workspace` bind mount stay `0o600`/`0o700` and are instead **chowned to the container
run-user** (see § Containers & worktrees) so the deprivileged agent CLI can read them
without exposing secrets to other host users.
Per run, the agent's container gets `HTTP(S)_PROXY=http://run:<token>@127.0.0.1:<tunnelPort>`
with `NO_PROXY` carving out loopback (where the Hezo MCP endpoint and signed asset URLs also
arrive) and the LLM provider host (LLM traffic goes direct — credentials are env-injected, and
MITM breaks some Anthropic-compatible APIs). The front proxy and the ssh-agent TCP bridge bind
`127.0.0.1` and **only** `127.0.0.1`: the sole thing that dials either is the host-side end of
that run's tunnel, running in this process. A container reaches them on its own loopback
through the tunnel, never by routing to the host, so there is no bind interface to choose and
no firewall rule to open (§ Container tunnel).

**Per-run caller auth.** Because the proxy binds an address any co-resident host process
shares, each run's proxy also mints a
16-byte token (mirroring the ssh-agent bridge) and requires it as `Proxy-Authorization: Basic
run:<token>` on every plain request and CONNECT — verified constant-time (`timingSafeEqual`),
missing/wrong ⇒ **407**, and stripped before the upstream re-request. The token rides the
`HTTP(S)_PROXY` URL userinfo, so each runtime's standard proxy handling sends it with no
per-runtime change. This closes the gap where any process reaching the proxy port could drive
substitution for another run; it does not weaken the red line — an unauthenticated caller only
ever ships the *unsubstituted* placeholder, which fails upstream, never a real secret. Auth is
on by default and can be disabled with `--no-egress-proxy-auth` / `HEZO_EGRESS_PROXY_AUTH=0`
for a runtime whose HTTP client can't carry proxy credentials.

**Egress MTU.** Containers reach the internet through the host's default-route interface via
NAT but otherwise inherit Docker's 1500-byte bridge MTU. On a host whose egress is a VPN/mesh
tunnel (WireGuard, NordVPN, Tailscale — commonly 1420) a full-size packet then black-holes at
the tunnel: the TLS/SSH handshake (small packets) completes, but a bulk transfer — a
`git fetch` pack — stalls mid-stream. Provisioning detects the egress-interface MTU
(`detectHostEgressMtu`, via `ip route get` so a policy-routed VPN table is honoured, not just
`/proc/net/route`) and, when it is below 1500, pins the container link MTU to it — adding
`CAP_NET_ADMIN` and running `ip link set dev eth0 mtu <n>` right after start (the base image
ships `iproute2`; `/sys` is read-only in a container so netlink, not a `/sys` write, is
required). Normal (≥1500) hosts are untouched — no capability, no MTU change.

**No connectivity preflight, and no run-time connectivity gate.** Both existed to cover one
failure: a container that could not reach the host's egress proxy, which on native-Linux
Docker meant a silently-dropped bridge→host path. There is no such path any more - the proxy
is on Hezo's own loopback and the container reaches it through the tunnel - so the ~490-line
probe, its auto-rebind of the bind host, and the run/chat abort gate it fed were all deleted
along with `--container-bind-host`. A tunnel that cannot be established fails the run
directly, with the error from the exec channel.

**Per-run ssh-agent** (`services/ssh-agent/`). `SshAgentServer.allocateRunSocket` exposes
the key over two listeners: a **host Unix socket** and a **loopback TCP** listener
(in-container access, since Docker Desktop on macOS won't forward `AF_UNIX` bind-mounts).
The TCP listener binds `127.0.0.1` only; the container reaches it on its own loopback through
the run's tunnel, so git-over-SSH works identically on Docker Desktop, native-Linux Docker and
a managed sandbox with no host route at all.
TCP connections must prefix a 16-byte per-run token (timing-safe compared). The protocol
answers `MSG_REQUEST_IDENTITIES` (advertises the public key) and `MSG_SIGN_REQUEST` (signs
with the lazily-decrypted private key). Because **all git now runs in-container** (§ Agent
runtime), every git transport — including repo prep (clone/fetch) — reaches the key through
the TCP listener via the bridge; nothing on the host runs git.

**Per-run socat bridge.** The agent base image ships `hezo-run-with-bridge` (the runner's
`argv[0]`): it spawns a `socat UNIX-LISTEN…EXEC:hezo-ssh-bridge` (under `setsid` where
available, so the exit trap can `kill -- -<pgid>` the whole socat process group — socat's
`fork` spawns a bridge child per connection, and killing only the listener would leave a
blocked child behind) that forwards each in-container connection (prefixing the token) to
the host TCP listener, then runs the wrapped command. When the server sets
`HEZO_EXEC_DEADLINE_SECS` (bounded git ops — `ContainerGitExecutor` sets it to the per-op
timeout plus slack for bridge-wrapped ops), the wrapper runs the command under `timeout`,
so the tree self-destructs even if the server process died mid-op; the env is ignored by
older images and absent for the agent CLI run, keeping every old/new image × server
combination compatible. The container sees a normal `SSH_AUTH_SOCK` Unix socket and is
unaware of the relay. The same socket serves both commit signing and `git@github.com:`
clone/fetch/push — including the per-commit auto-push fired by the durability `post-commit`
hook (§ Agent runtime, Commit durability), which is why that hook keys off a live
`SSH_AUTH_SOCK`.
Repo/worktree prep wraps individual git commands with the same `hezo-run-with-bridge` runner;
cloning outside a run (provision, repo link) allocates a short-lived bridge via
`withProvisionBridge`, whose per-op `provision-<hex>` id doubles as the exec scope marker
(§ Agent execution, Process-tree lifecycle).

**Verified-on-GitHub bootstrap.** On every successful GitHub OAuth connect the project's
public key is auto-registered on the connecting user's account as **both** a signing key
(`POST /user/ssh_signing_keys` — drives `Verified` badges) and an authentication key
(`POST /user/keys` — so SSH git works). Registration is idempotent (GitHub 422 "already
in use" → no-op). Commit *authorship* comes from the project's own GitHub connection (its
`project_id`-scoped `oauth_connections` row, or a global one as fallback); *signing* uses
the project's (team's) own key.

---

## 9. OAuth, GitHub & connectors

Every third-party connection is a **connector** (an `mcp_connections` row — the name is
historical; kinds are `saas` = hosted HTTP MCP server, `local` = stdio MCP in the
container, `api` = a direct REST API with no MCP server at all). There is **no central
relay** — each Hezo instance is its own OAuth client and callbacks land on its own URL.
Token acquisition is chosen per provider by what the provider's Authorization Server
actually supports; once a token exists, both strategies finalize through one shared path.

| Strategy | Mechanism | Selected when | Used by |
|---|---|---|---|
| **DCR auth-code + PKCE** | PRM discovery (RFC 9728) → Dynamic Client Registration (RFC 7591) → redirect popup → `/api/oauth/mcp-callback`. Zero config — the AS mints a `client_id`. | the AS advertises a `registration_endpoint` | DatoCMS, Linear, Notion, Vercel, … |
| **Device flow (RFC 8628)** | `connectors/:id/device/start` → user types a code → `…/device/poll`. Needs a pre-registered public `client_id`; no redirect, no secret. | the capability registry declares a `deviceAuth` descriptor | **GitHub** |
| **Generic OAuth broker (device flow)** | `connectors/:id/oauth-device/start` → user types a code → `…/oauth-device/poll`. The operator brings the `client_id` (+ optional `client_secret`) and either picks a bundled `oauthProviders` descriptor or supplies the endpoints directly; `resolveBrokerDescriptor` (`services/oauth/broker.ts`) merges the two. When the start body omits `provider_id`, the route falls back to the connector's persisted **`config.oauth_provider_id`** — an agent can pre-select the provider at `register_connector` time (`kind:'api'` + `oauth_provider_id`, validated against the bundled `oauthProviders`; merged into `config` **after** `validateApiConnectorConfig`, which strips unknown keys). The completion UI then locks the provider (no picker) and the human pastes only a client id. Runs on an **`api`** connector, so no browser callback is needed on any instance URL. The durable refresh token + host-only client secret stay host-side; only the short-lived access token is surfaced (via the connector's `api_auth` placeholder), kept fresh by the generic host-side refresh. The same completion panel renders both **inline in the `connect_required` task comment** and **expanded in the Connectors-page row** (`ConnectorOAuthBrokerForm` / `ConnectorCompletion`, web). | an OAuth-backed REST API with no hosted MCP (BYO client) | **Google/YouTube user-scoped writes** (read-only public YouTube data instead uses a pasted API key on a `kind='api'` connector — the row below), any device-flow OAuth API |
| **API key** | human pastes a key on the connect_required card or the Connectors page → `POST /api/projects/:projectId/connectors/:id/api-key` encrypts it into the vault (`allowed_hosts` = the MCP host) and links it via `mcp_connections.api_key_secret_id`. The generated secret name is `MCP_<CONNECTOR>_<PROJFRAG>` for a project-scoped connector (`PROJFRAG` = first 5 hex of the project UUID, uppercased) and `MCP_<CONNECTOR>` for a global one, so two same-type connectors in different projects get distinctly-named credentials. | the MCP server exposes no OAuth (no PRM) and authenticates with a bearer/API key | **Typefully**, header-auth MCPs |
| **Paste / `request_credential`** | raw key pasted into the vault, referenced by placeholder from a tool call | an agent needs an arbitrary secret (not a whole connector) | `request_credential` |

GitHub uses the device flow because its AS advertises no `registration_endpoint` (DCR
impossible) and a redirect flow would need a per-host registered callback. The selection
is data-driven via `packages/shared/src/types/connector-capabilities.ts`; generic OAuth
machinery is in `services/oauth/*`, GitHub REST helpers in `services/github.ts`.

**Storage.** `oauth_connections` is **project-scoped** via `project_id` (non-NULL = private
to that project so two projects hold separate accounts; NULL = the global "all projects"
scope), keyed per-scope on `(project_id, provider, provider_account_id)`. Tokens have no
column of their own — they ride the `secrets` table under name pattern
`OAUTH_<PROVIDER>_<8 hex>` (`_REFRESH` suffix for refresh tokens, `_CLIENT_SECRET` for a
broker client secret), `allowed_hosts` auto-locked to the provider's hosts. So OAuth tokens
flow through the same egress placeholder path as any secret; agents emit
`Authorization: Bearer __HEZO_SECRET_OAUTH_GITHUB_AB12CD34__`. A broker connection's OAuth
**client secret** is the exception: it is stored with **empty `allowed_hosts`** (`allow_all_hosts=false`),
referenced from `oauth_connections.client_secret_secret_id`, so it is **never**
egress-substitutable and never surfaced to a run — it is host-only refresh material.
`refreshExpiringTokens` (called by the egress substitution path on every outbound request)
refreshes tokens within 60 s of expiry, coalescing concurrent refreshes per connection. A
single **generic** refresh fn is registered at startup (`registerGenericOAuthRefresh`) and
handles any connection carrying `token_url` + `client_id` in its metadata (decrypting the
host-only client secret when present), so refresh is now **real** for broker connections
rather than the historically GitHub-inert no-op; a provider-specific fn still wins over the
generic one where registered. Every flow that mints a connection therefore has to persist
**both** `token_url` and `client_id` on its metadata — the auth-code and MCP DCR callbacks
included, not just the device-flow broker. Omitting `client_id` makes the generic fn throw
before any network call, and because a failed refresh is swallowed and never advances
`expires_at`, the connection silently keeps serving its original access token until the
upstream 401s. A failed refresh now backs off per connection (30 s doubling to a 15 min
ceiling, cleared on success) so a structurally broken connection can't re-attempt on every
proxied request, and records the reason on the backing connector's `mcp_connections.auth_error`
(cleared on the next success) so it surfaces on the Connectors page rather than only in the
log. Deleting a project (or its team) purges the project's
connections and their token secrets (access, refresh, and client secret) before the cascade,
so no encrypted token orphans in the vault.

**Agent connector flow.** An agent calls `register_connector` with an MCP URL (DCR is
attempted) or a `provider_id` for a device-flow provider — or, for an OAuth-backed REST
API, with `kind:'api'` + `base_url`/`allowed_hosts` and an `oauth_provider_id` to
pre-select the device-flow broker provider. The tool creates a pending `mcp_connections`
row and posts a `connect_required` comment; a human completes the connection from the
task chat or the Connectors page, and a `credential_provided` wakeup resumes the agent
(scoped to the requesting task's own team, resolved from the task row — the connect can
be completed from any surface). The Connectors-page row also surfaces the originating
task (`created_by_task_identifier` + title, joined into the project connectors list) as a
link back to it.

**Admin connector flow.** The global Settings → Connectors page lists **every project's**
connectors plus global ones (each row carries its `project_id` + project name), with a
**scope-filter dropdown** — `(All projects)` / a specific project — that filters the view
and sets the create scope. The superuser adds a connector in the selected scope
(`POST /api/connectors` with an optional `project_id`; upsert-by-`(project_id, name)`;
re-adding a name in the same scope replaces `config` and clears `auth_error`). The page then
auto-probes the new connector via
`POST /api/connectors/:id/auth-start` (superuser-gated) — the same PRM → DCR walk as
the project-scoped auth-start; the only difference is team context (the state
envelope carries `teamId: null`, and the callback skips the team-room broadcasts and
per-team provider hooks; the settings page refetches off the popup's
`hezo-oauth-success` postMessage instead). **Both** surfaces pass `missingPrmMeansNoOAuth`,
so an MCP server that advertises **no** PRM resolves to `{ auth_url: null }` without marking
the row failed (`PrmUnavailableError` → `no_oauth`) — missing PRM is the normal shape for
public / header-authenticated MCPs (`__HEZO_SECRET_*__` placeholders), which either surface
can add. When OAuth *is* advertised, the UI opens the authorize popup automatically on add,
and every non-active SaaS row keeps a **Connect**/Retry button.

**User-added connectors (project page).** The per-project Connectors page has the same
**Add** affordance (name + MCP URL → `POST /api/projects/:projectId/connectors`,
implicitly this-project-scoped), then auto-probes via the project auth-start exactly as the
admin page does, so an operator can register either an OAuth or a header-authenticated MCP
without an agent having asked for one first.

**Revoked → reconnect restores in place.** Revoking clears the token/API-key secret and
stamps `revoked_at` but keeps the row. Pressing **Connect** or **API key** on a revoked
connector does **not** error — `startConnectorAuthCode` (OAuth) and the api-key route both
call `restoreRevokedConnector` (equivalently, `markApiKeyActive` clears `revoked_at`),
which nulls the revocation and every auth artifact (`oauth_connection_id`,
`api_key_secret_id`, `activated_at`, `auth_error`) while preserving `config` — including any
cached DCR client registration, so the reconnect reuses it. This is the same in-place
restore `createOrFetchConnector` performs for a re-requested agent connector.

**Instance-address change self-heals.** A DCR client is bound at the Authorization Server to
the exact `redirect_uri` it registered, so the cached `config.dcr` also records the callback
URL it was minted against (`redirect_uri`). `startConnectorAuthCode` reuses the cached client
**only** while that stored URL equals the current request's callback origin
(`${requestOrigin(c)}/api/oauth/mcp-callback`); if the instance's public origin has changed
since — a new hostname, an `http`↔`https` flip from the reverse proxy in front of it, or a
first registration done from a different address — it re-runs discovery + DCR to mint a fresh
client bound to the current origin and overwrites the cache. Without this, the stale client
sends the AS a redirect_uri it never registered and the authorize is rejected with
"redirect_uri does not match any of the OAuth 2.0 Client's pre-registered redirect urls"
(observed against Higgsfield, whose `mcp.higgsfield.ai` broker forwards the DCR client_id and
redirect_uri straight through to upstream Clerk). Registrations cached before the
`redirect_uri` field existed carry none, so they miss the reuse check and re-register on the
next connect — an address change no longer needs delete-and-recreate.

**Run exclusion.** `loadConnectorsForRun(db, projectId)` returns the run's project's own
connectors plus global ones (a project connector shadows a global of the same name). It
skips revoked rows, plus SaaS rows that are known to want auth but haven't completed it —
no `oauth_connection_id` **and** no `api_key_secret_id`, and any of: agent-requested
(`created_by_task_id`), discovery persisted `config.dcr`, or an attempt recorded
`auth_error`. Injecting those would just 401 on every run. A connector that finished either
handshake (an OAuth connection or a pasted API key) is always included, as are operator rows
that never attempted auth (public / header-authenticated MCPs).

**MCP connections** (`mcp_connections`, see § 3 scoping). `kind='saas'` carries
`{ url, headers, apiKey? }`. Connector auth is **always emitted as a `__HEZO_SECRET_*__`
placeholder, never a materialized token** (the § 7 red line): the descriptor loader resolves
the secret *name* only — for OAuth-backed rows (`oauth_connection_id`) it emits
`Authorization: Bearer __HEZO_SECRET_OAUTH_…__`; for API-key rows (`api_key_secret_id`) it
emits the placeholder in the header/scheme named by `config.apiKey` (default
`Authorization` / `Bearer `). No decryption happens at build time, so descriptors build even
while the master key is locked; the egress proxy substitutes at request time, scoped by the
secret's `allowed_hosts`. `kind='local'` carries a stdio `{ command, args, env }` (the
on-demand installer is a deferred phase); local servers authenticate via credential
placeholders in their `env` (e.g. an npm MCP that reads an API key from the environment, or
a username/password login that fetches a token), never OAuth. Because connections are
project-scoped (§ 3), each project supplies its own env credential for the same tool under a
per-project-unique vault secret name — an agent registers the tool with `add_connector`
(placeholder in `config.env`) and provides the value via `request_credential`, so two
projects' credentials for one service never collide in the instance-global vault. The
connectors UI treats a non-revoked, non-failed local row as **connected the
moment it exists** (`statusOf`/`connectorStatus` short-circuit `kind='local'` to `active`)
rather than showing it a meaningless "Pending connect" OAuth affordance.

**GitHub's row is roster-aware.** GitHub is not an `mcp_connections` row until someone
connects it (`POST …/connectors/ensure` materializes it), so the project Connectors page
renders it from the OAuth connection alone. Whether it reads as a *setup step* is derived
from the roster: the project payload carries `code_agent_count` (roster agents with
`member_agents.touches_code`, alongside `repo_count`), and a project with no code-touching
agent, no repo, and no GitHub connection renders the row **last** with a neutral `Optional`
badge instead of the amber "Pending connect". This is the UI counterpart of the repo-setup
gate in `job-manager.ts`, which likewise fires only for a `touches_code` agent — a roster
like the shipped `investment`/`influencer` marketplace teams (entirely non-code) will never
request a repo, so offering GitHub as pending work would invite the operator to finish
something that is never needed. Any of the three signals promotes the row back.

`kind='api'` is a **direct-REST connector with no MCP server** — for backends that expose a
plain HTTP API rather than MCP (e.g. Google's APIs). Its `config` carries
`{ base_url, allowed_hosts, auth: { placement: 'header'|'query', name, scheme? }, docs_url? }`
and it links a pasted credential via `api_key_secret_id` (the same vault link as an
api-key saas row; the `/api-key` route scopes the secret's `allowed_hosts` to the config's
hosts / `base_url` host). An `api` connector has **no MCP descriptor** — `loadConnectorDescriptors`
skips it — and is instead surfaced to the agent through `list_connectors`, which emits an
`api_auth = { base_url, placeholder, allowed_hosts, placement, name, docs_url }` block (the
`placeholder` is null until a credential is attached). The agent puts the `__HEZO_SECRET_*__`
placeholder in the named header/query and calls `base_url` directly; the egress proxy
substitutes the real key at request time, scoped to `allowed_hosts` — the same red-line-safe
path as any other placeholder, with the secret never entering the run. This is the most
red-line-native transport: a credential only ever appears as a placeholder in a header/URL.

**Connector registry & the virtual `connector-recipes` skill.** A curated, bundled
registry (`services/connector-registry.json`, zod-validated in `connector-registry.ts`)
holds connection **patterns** (hosted-MCP-first, direct-api, static-credential,
oauth-hostside, …), per-service **recipes** (~48 documentation-verified providers, each
with transport `mcp`|`api`, endpoint, credential kind(s) + `allowed_hosts`, docs URL),
and the **`oauthProviders`** descriptors the generic OAuth broker's
`resolveBrokerDescriptor` resolves (google-youtube, github). All consumers go through the
single accessor `resolveConnectorRegistry()` — the seam a future fetched-registry
override slots in behind. `buildConnectorRecipesSkill()` renders the registry into the
**virtual, read-only `connector-recipes` skill**: a reserved slug that is *not* a DB row,
surfaced at every skill surface — the `{{skills_context}}` run manifest,
`get_skill('connector-recipes')`, and a read-only entry in `GET /skills` /
`/skills/:id` (the web skills page shows it with a Built-in badge, no edit/delete).
`create_skill` / `propose_skill` / `POST /skills` reject the slug, PATCH/DELETE reject it,
and it auto-updates with the binary (nothing to seed or migrate). `SHARED_INSTRUCTIONS`
steers every agent to consult it before wiring an external service (prefer hosted MCP,
then a direct `api` connector; never a browser/localhost-OAuth or token-file-on-disk
integration) and — once a connection works — to persist how to drive the service as a
skill via `create_skill` (same-slug+scope upsert keeps it a living document), scoped to
match the connector's reach, checking skills.sh / vendor skill files for an existing
public skill first.

**Connector auth must traverse the egress proxy.** Because connector auth is a placeholder,
each coding CLI's MCP-startup HTTP MUST go through the per-run proxy or the placeholder ships
unsubstituted and 401s (a fail-closed usability miss, never a leak — § 7). All five runtimes
do: Claude Code & Gemini install their own global undici proxy dispatcher from `HTTPS_PROXY`
(and trust `NODE_EXTRA_CA_CERTS`); OpenCode runs on bundled **Bun**, whose `fetch` reads the
proxy env natively (single-cert `NODE_EXTRA_CA_CERTS` trusted); Codex and Grok are **Rust**
binaries that honor the proxy env by default and trust the egress CA via the system store that
the container's start-up `update-ca-certificates` populates (Grok's own Hezo MCP call is plain
HTTP to `host.docker.internal`, so it needs no CA trust regardless). The runner also sets
`NODE_USE_ENV_PROXY=1` as a Node safety net for any spawned Node process without its own
dispatcher.
At run build, `loadConnectorDescriptors` merges connectors after the built-in `hezo`
MCP, and each of the five runtime adapters translates the descriptors into the spawn
artifacts its CLI expects (Claude Code `--mcp-config`, Codex `config.toml`, Gemini
`.gemini/settings.json`, etc.).

**Method access (per-connector allowlist).** A hosted MCP server ships its read and write
tools in one connection, so a connector carries an allowlist of the methods agents may
call. It lives on the `mcp_connections` row itself — `enabled_methods` (jsonb array),
`discovered_methods` (the cached catalog), `methods_listed_at`, `requested_access`
(`connector_access` enum), `access_applied_at` (migration `044`). **`enabled_methods` NULL
means no allowlist — every method enabled**, deliberately *not* the same as an array naming
every currently-known method, so a server that grows a tool doesn't silently grant it.
These are columns rather than `config` keys because `config` is replaced wholesale by the
reconfigure routes (`POST /connectors`, `add_connector`) — an operator changing a URL would
otherwise wipe the allowlist, a security control quietly switching itself off. They also
survive `restoreRevokedConnector`, so a revoke/reconnect keeps the restriction.

`classifyMcpMethod` (`@hezo/shared`, `mcp/method-access.ts`) decides read vs write: the
spec's `annotations.readOnlyHint` wins when the server sets it (`inferred: false`),
otherwise a leading-word heuristic. An unrecognised name classifies as **write**, so the
heuristic can never widen access by accident. `summarizeMethodAccess` is the single source
for every count the card, the dialog, and `list_connectors` show, so they can't disagree.

`discoverConnectorMethods` (`services/connectors/method-discovery.ts`) probes a connected
`saas` connector over the MCP SDK's Streamable HTTP transport (SSE fallback) and caches the
catalog. It decrypts the connector's own credential in-process (trusted server code — § 7's
chat-bot-token precedent) and **drops any header still carrying an unsubstituted
placeholder** rather than sending it verbatim. It fires via `trackBackground` from both
activation paths and from the explicit refresh route, so a probe failure can never fail a
connect; a `connect`-triggered failure logs at debug and a `manual` one warns. **It is never
called from `loadConnectorDescriptors`**, which deliberately resolves secret *names* only so
descriptors build while the master key is locked.

Enforcement has two legs, split because the coding CLIs are installed unpinned and their
config keys can drift:

- **Runtime config filtering is the UX leg** — descriptors carry `enabledTools` and
  `disabledTools` (both views, since Claude Code takes a deny list while Gemini/OpenCode
  take allowlists), and each adapter emits its own key: Gemini `includeTools`, OpenCode
  top-level `tools`, Claude Code `permissions.deny`. An agent never sees a tool it cannot
  call. Best-effort and degrades safely: an unrestricted connector emits a byte-identical
  config to before, and Claude Code's deny list is only as complete as the last
  `tools/list`. **Codex and Grok emit no filter** — no per-server tool-filter key could be
  verified, and a guessed TOML key risks the CLI rejecting the whole config and breaking
  every run on that runtime. `RUNTIME_SUPPORTS_MCP_TOOL_FILTER` records which runtimes can
  hide tools.
- **The egress proxy is the enforcement leg** — runtime-independent, and the only thing
  restricting Codex and Grok at all. `allocateRunProxy` resolves the run's restricted
  connectors once into a `host:port → allowlist` map (`loadMcpHostRestrictions`); an
  unrestricted run gets an empty map and takes no new path. In `forward`, a request to a
  mapped host has its body inspected by the pure `shouldBlockMcpRequest`
  (`egress/mcp-method-guard.ts`) and a `tools/call` naming a disabled method is rejected
  `403 mcp_method_not_enabled` before it leaves the host. Only `tools/call` is inspected —
  `initialize`/`tools/list`/notifications pass through, since a listing that still
  advertises a disabled tool is harmless once the call is blocked. A JSON-RPC **batch** is
  rejected whole if any element names a disabled method (the messages share one body).
  **Fails closed** for restricted hosts only: an unparseable body, or one over
  `MAX_MCP_INSPECTION_BYTES` (256 KB), is rejected rather than forwarded uninspected.
  Two details are load-bearing. The inspection cap is **separate from and much larger
  than** `MAX_BODY_SUBSTITUTION_BYTES` (8 KB) — a real `tools/call` carries file contents,
  far past what the credential-in-body substitution path was sized for — and the body is
  **read once**, at whichever cap applies, since both gates want the same bytes and the
  stream can only be consumed once. The inspection gate (`mayCarryJsonRpc`) is deliberately
  *wider* than `isBodySubstitutionEligible`: it accepts a chunked body with no
  `Content-Length` and does not exclude a compressed one, so an uninspectable request
  reaches the guard and is blocked rather than skipped. Both sides of the map normalise
  through `mcpRestrictionKey(hostname, port)` with the scheme default applied — the proxy
  resolves host and port separately, so keying on a raw `URL.host` would silently miss on
  any non-default port, and a lookup that misses means no enforcement at all.

An agent registering a connector can ask for read-only (`register_connector`'s
`access: 'read' | 'write'`, default `write`), which persists `requested_access` and shows on
the `connect_required` card before the human authorizes. Discovery applies it **exactly
once**, guarded on `requested_access = 'read' AND access_applied_at IS NULL AND
enabled_methods IS NULL`: the stamp stops re-application and the null allowlist means an
operator who has already decided is never overwritten. The request narrows only —
`createOrFetchConnector` will upgrade an unrestricted row to `read` but never clears a
stored `read`, and `list_connectors` reports `method_access` so a run learns a missing tool
is withheld rather than absent. There is deliberately **no MCP write tool** for the
allowlist: letting an agent widen its own access would be a privilege escalation, so the
write side is human-only (`GET`/`PATCH`/`POST …/methods{,/refresh}`).

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
+ canary in one transaction (self-certifying signature, `unset` state only). The mnemonic
transmits **zero key material** on routine use: `POST /auth/challenge` issues a single-use
nonce, `POST /auth/verify` verifies the signature over a reconstructed, domain-separated
message (`hezo-auth-v1:login:<nonce>`). After a restart the server starts **locked**; the
first `verify` includes the `unlock_key`. Messages are versioned and domain-separated so
signatures can't be replayed or cross-purposed; on unlock `MasterKeyManager` fires
`onUnlock` callbacks that start the `JobManager`.

**The master key only *unlocks*.** It is not a login. `setup` and `verify` return a
short-lived **password-setup-scoped JWT** (`scope: password_setup`, ~10 min), never a
session — `verifyToken` rejects that scope on every general route. Its sole power is
`POST /auth/password`. So proving master-key ownership unlocks the instance and authorizes
setting a password; a **session** is minted only by the password (below). This is the
recovery path too: "forgot password" re-enters the master key to obtain the scoped token,
then sets a new one.

**Password authentication (no anonymous sessions).** Day-to-day access is a per-admin
**password**, and every session is authenticated — there is **no anonymous access** on
REST or the WebSocket. The password is low-entropy so it is **never sent to the server**:
the browser derives an Ed25519 keypair from `scrypt(password, salt)` and the server stores
only a **verifier** (`users.password_salt` + `users.password_public_key`), never a hash.
Login mirrors the mnemonic's challenge-response: `POST /auth/password-challenge` returns a
nonce + the salt; `POST /auth/password-verify` checks the signature over
`hezo-auth-v1:password-login:<nonce>` and mints a **session JWT**. `POST /auth/password`
(accepting either a session or the password-setup-scoped token) enrolls a new verifier and
returns a fresh session. A **session-authenticated change** while a verifier is already
enrolled must additionally prove the *current* password: the body carries
`current_challenge_id` + `current_signature` — a `password-challenge` nonce signed with the
keypair derived from the current password — verified against the stored verifier before it
is replaced (a stolen session alone can't rotate the password). Setup-scoped bearers
(master-key recovery) and first enrollment are exempt. `password-verify` and the
current-password proof share one in-memory throttle (single admin → global
backoff/lockout), so the change endpoint can't be used to brute-force around the login
lockout. `GET /api/status` exposes `passwordSet`, and the web gate uses a
`GET /api/me` probe to distinguish "unlocked but no session → password login" from a valid
session. **Existing installations** are migrated (013) with the default password `"password"`
so operators can sign in immediately after upgrading, then change it (**Settings → Admin
password** while signed in).

**Three principals.**
- **User JWT** (HS256, secret derived from the unlock key) — `Authorization: Bearer <jwt>`,
  7-day, minted only by password login / set-password.
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

**Row-change → project-slug resolution** (`resolveProjectSlugForChange` in
`hooks/use-websocket.ts`) picks a resolver per table, and getting it wrong silently drops
the event (an unresolved row invalidates nothing):

- **`projects`** resolves by the row's **own `id`** — the row *is* the project, and no
  `projects` row carries a `project_id`. It must not use the generic resolver: that falls
  through to `team_id`, which maps a team-wide row to the team's *non-internal* project and
  so can never resolve **HQ**. Several call sites also broadcast a partial row (`{ id,
  container_status }` from the startup container restart and the self-heal re-attach in
  `job-manager`, plus the progress-summary and designated-repo writes) carrying neither
  `project_id` nor `team_id`; keying on `id` covers those too.
- **`tasks` / `task_comments` / `heartbeat_runs` / `agent_wakeup_requests`** resolve by
  `project_id` **only** — never the `team_id` fallback, which would misattribute one
  project's high-frequency activity to another and storm its caches.
- **Everything else** resolves `project_id` first, then falls back to `team_id`.

**Container-state convergence.** The container status banner
(`components/container-status-banner.tsx`), the CEO chat's HQ gate, and the create-project
gate all derive from one `useContainerHealth(project)` reading `container_status` off the
project index, and provisioning ends with a single `projects` UPDATE broadcast. WebSocket
events have no replay, so the index also **polls every 10s while any container sits in a
transient state** (`creating` / `stopping` — deliberately not the `null` of a torn-down
project, which would poll forever). That bounds the damage of a missed transition to a few
seconds of stale banner instead of "stuck until the operator reloads the page."

**Connection indicator.** `useConnectionMonitor` (`hooks/use-connection-status.ts`) drives a
module-level store from two signals - `navigator.onLine` (catches a dropped network an
already-open half-open socket hasn't noticed) and the socket's own `connected` flag (catches a
server that went away while the route is intact) - gated on "connected at least once" and
debounced ~2s so a mobile radio blip doesn't flash. The store is a module singleton rather than
a context because the writer lives inside `SocketProvider` while the reader, the global
`<Toaster />`, mounts outside the provider and the router in `main.tsx`. The indicator renders
as a persistent, non-auto-dismissing toast ("Connection lost / Reconnecting…" plus **Retry
now**, wired to the socket client's `reconnect()`). It is **user-dismissable** - close button or
right swipe, both through Radix's `onOpenChange` into `dismissConnectionOffline()` - which
hides it for `DISMISS_SNOOZE_MS` (20s) and then re-surfaces it if the socket is still down;
reconnect attempts continue untouched underneath, so the snooze only silences the notice. A heal
discards the snooze, so a fresh drop always surfaces immediately.

**Lazy comments feed.** A task's comment thread can be long, so the feed
(`components/task-detail/comments-section.tsx`, virtualized with react-virtuoso) loads in
two payloads off the one `GET …/tasks/:taskId/comments` route. On mount it fetches a
**skeleton** (`?view=skeleton` → `useCommentSkeletons`): metadata + reactions for every
comment, with text bodies and attachments omitted (a `text_length` hint sizes each row's
placeholder). Non-text comments (system/run/action/…) keep their small `content` and render
straight from the skeleton; inline-event rows (system/run) never need a body. A text row's
**body** (`content` + attachments) loads on demand: an `IntersectionObserver` tracks which
rows are on screen and, once the thread *settles* (a ~170ms scroll pause — a fast fling never
pauses, so it fetches nothing), the visible rows' ids are handed to a batched loader that
coalesces them into one `?ids=a,b,c` request (`ensureCommentBodies` → React-Query-per-id
cache, `useCommentBody`). A `?view=skeleton` list is index-ordered by
`idx_comments_task_created`; the intake chat and API clients still get the eager full payload
(default mode). Deep-link (`#comment-<id>`) targets load their body eagerly so the anchor
lands on stable height. Reactions stay on the skeleton row (one source of truth), so their
optimistic mutation and WS invalidation are unchanged.

**Mutations** (three strategies, by shape — see `AGENTS.md` › Web frontend mutations):
**optimistic + rollback** (default for field edits/toggles/reactions, via
`useOptimisticMutation`), **response-driven** (creates and server-validated fields like
task `status`; security-sensitive mutations like credential fulfillment **must** stay
here), and **invalidate + refetch** (validation-heavy / long-running work). Errors toast
on rollback; successes are confirmed by the UI change itself.

**Locale.** The instance has one display locale - language, date field order, and money
punctuation - chosen on a first-run screen that runs *ahead of master-key generation* and
editable afterwards at Settings › Languages & formats. It is global (no per-user override)
and lives in three `system_meta` keys, so it needed no migration.

Three axes rather than one BCP-47 tag: field order and month language are independent (there
is no `Intl` locale meaning "German month names in ISO order"), so `formatDateIn`
(`@hezo/shared` › `i18n/format.ts`) builds dates field-by-field from a
`Record<DateFormat, Descriptor>` table. Money is presentation-only - runs are always priced
in USD - so `formatMoneyUsd` picks separators via a representative locale with
`currencyDisplay: 'narrowSymbol'` and never converts.

The locale rides on the **public** `/api/status` payload, because every pre-auth screen
renders in it before a credential exists (the boot-time status handler omits it - no DB is
open yet). `I18nProvider` (`lib/i18n`) wraps `ThemeProvider` in `main.tsx`, above both the
router and the `Toaster`; it seeds from a localStorage *render hint* to avoid a first-paint
flash, then adopts the server value - but only once `localeConfigured` is true, since the
pre-choice default would otherwise overwrite `navigator.languages` detection.
`lib/format-date.ts` keeps its exported signatures and reads the active locale from module
state (sound because the locale is global and the provider is its only writer), so its
consumers were untouched. Catalogs are committed JSON per language, statically imported, with
lookup falling back language → English → the key.

Two lookup primitives, both keyed by `MessageKey = keyof typeof en` so a typo is a compile
error. `t()` interpolates `{name}` tokens over `Record<string, string | number>` and returns a
string. `<Trans k vars>` is its node-aware counterpart for a sentence that embeds React nodes -
a `<Link>`, an `<em>` - which `t()` cannot express: it splits the same `{name}` template and
interleaves `ReactNode` vars, so the *whole* sentence stays one catalog entry and each language
places the nodes in its own word order. Splitting such a sentence into per-fragment keys instead
would freeze English word order into every translation. The system-comment timeline entries
(`system-comment.tsx`) are the worked example. Note `TASK_STATUS_LABELS` in `@hezo/shared` is
still English, so a translated status sentence carries English status words until the board's
status vocabulary is localized too.

`PATCH /api/instance-settings/locale` is the single write path. It is listed in
`PUBLIC_PATHS` but self-authenticating: open only while no admin password is enrolled (the
same window `POST /api/auth/setup` is open in), superuser-only after, resolving the bearer
in-route via `requireAdminEquivalentBearer`. The globe button that hosts the editor appears
only on pre-auth surfaces; an unauthorized save there applies to that browser alone rather
than failing.

**Responsive.** Mobile-first is mandatory — build the mobile layout first, enhance with
`sm:`/`md:`/`lg:`. Three breakpoints (mobile <768px, tablet 768–1023px, desktop 1024px+).
Every UI change must work at all three, and its browser test must verify mobile
(`AGENTS.md` › UX).

**PWA / installability.** The SPA ships a web manifest (`packages/web/public/manifest.webmanifest`,
`display: standalone`, brand icons under `public/icons/`) and a deliberately **network-only**
service worker (`public/sw.js`, registered from `main.tsx` via `lib/register-sw.ts`). The worker
caches nothing — its only job is to satisfy the browsers' installability criteria so they offer
"Add to Home Screen"; a caching worker could pin clients to a stale build and fight the
self-update/restart flow. On mobile, `PwaInstallPrompt` (rendered in the shell, gated `lg:hidden`)
surfaces a dismissible bottom card: Chrome/Android replays the captured `beforeinstallprompt` for a
one-tap install (`useInstallPrompt`), while iOS Safari — which has no programmatic prompt — shows
the manual Share → Add to Home Screen steps. Already-installed (standalone) and recently-dismissed
states stay silent. Serving requires `.webmanifest` → `application/manifest+json` in both static MIME
maps (`startup.ts`, `scripts/bundle-static.ts`), and `.png` for the icons themselves.

**Icon variants.** `packages/web/brand/icon-geometry.ts` is the source of truth for every icon
bitmap; `packages/web/scripts/generate-icons.ts` rasterizes it via Playwright's Chromium into
`public/icons/`. Four variants exist because the manifest's three `purpose` values are genuinely
different jobs, and one bitmap cannot serve them:

- `any` (192, 512) — rounded plate, frame at full size. The unmasked face: browser tabs, favicon.
- `maskable` (192, 512) — **full bleed, no self-rounding**, lockup shrunk into Android's safe zone.
  The launcher supplies the only rounded edge, so nothing nests inside its silhouette.
- `monochrome` (512) — the maskable lockup as alpha only, for Android 13+ themed icons. No
  background: the system tints the alpha channel, so a filled plate would tint solid.
- `apple` (180) — full bleed, not self-rounded (iOS applies its own superellipse), fully opaque
  (iOS composites transparency against black).

Each manifest entry carries a **single** `purpose`; a combined `"any maskable"` claims one bitmap
is correct for two jobs and is what produced a clipped, white-banded icon on One UI.

**The safe-zone solve.** Android guarantees only the central 80% circle (radius `0.4 × 514`)
survives every launcher mask. A rounded square's furthest point from centre is its outer corner
arc, `(H - R) × √2 + R`, so tight corners throw the frame's extremes far out along the diagonal —
the brand frame as drawn in `logo.svg` reaches 138% of that budget. Rounding the corners pulls the
extremes in and buys size: `solveFrameSide()` inverts the equation, and at a corner ratio of 0.55
the frame solves to 334 units against 291 at the brand's own 0.115, for the identical budget. The
masked variants therefore keep the frame with softened corners rather than dropping it or shrinking
the whole lockup.

**Generation is author-run.** `bun run build:icons` regenerates and the output is **committed** —
it is deliberately not part of `bun run build` or `bun run dev`, both of which run in every CI job
and on every contributor machine and must not require a browser binary (same posture as
`build:marketplace`). Drift is caught by `packages/web/test/pwa-icons.test.ts`, which decodes the
committed PNGs with a dependency-free reader (`test/helpers/png.ts`, `node:zlib` over IDAT) and
asserts dimensions, edge-to-edge painting, full-bleed opacity, and safe-zone reach. That test
exists because both faults it covers actually shipped: every icon was missing its bottom 87 pixels
(an out-of-band generator screenshotted headless Chromium at a window size whose viewport paints
shorter than the image it writes), and the maskable variant had no safe zone at all.

---

## 12. Build, release, migrations & upgrades

**Author-run generators.** Two build steps are **not** wired into `bun run build` or CI, because
their output is committed and regenerating them requires a tool the ordinary build must not
depend on: `build:marketplace` (recompiles `marketplace/teams/*.json`, also run by `bun run dev`)
and `build:icons` (`packages/web/scripts/generate-icons.ts`, needs a Chromium binary). Both are run
by authors, both commit their output, and both are guarded by a drift test rather than by being
re-run in CI — `marketplace-build.test.ts` and `pwa-icons.test.ts` respectively.

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
`{ starting: true, phase, message, detail }` read from a boot-progress singleton
(`startup-progress.ts`, advanced through `database → migrations → seed → pricing →
workspace`). The web UI (`useStatus` → `StartingScreen`) renders a loading screen naming the
current phase and keeps polling, flipping to the master-key gate the moment boot finishes —
so a browser that connects mid-boot never sees a raw JSON error. Other API/MCP/WebSocket
surfaces still get a JSON **503 STARTING** so machine clients retry; `/health` always answers 200.

`detail` names the **step in flight** within a phase, because a phase alone cannot distinguish
a slow boot from a hung one: the migration runners report the pgdata copy / pre-migration
backup, then each migration as `Applying <file> (n of m)`, and the one-time legacy run-log
VACUUM names itself under the `seed` phase. Two further signals make a **crash loop** legible,
which is otherwise indistinguishable from a boot that never finishes (the process dies, the
restart policy brings it back, and the browser just sees the boot screen again):

- **Fatal-exit breadcrumb** (`startup-failure.ts`). The operator-actionable failures
  (`MigrationFailedError`, `DbNewerThanAppError`, `ExternalDbError`, `AssetStorageError`)
  `process.exit(1)`, so their reason never reaches the browser. Each writes
  `<dataDir>/.last-startup-error.json` on the way out; the **next** boot reads it before
  `startup()` runs and serves it as `last_failure` on `/api/status`, and the boot screen shows
  it. Cleared once a boot reaches `ready`.
- **Restart counter** (client-side, in `StartingScreen`). A boot phase moving *backwards*
  means a fresh process answered the poll. This is the only signal available for a kill the
  process cannot observe — an OOM `SIGKILL` (exit 137) writes no breadcrumb.

**Migrations.** Real, tracked, **append-only** SQL under `packages/server/migrations/`
(`001_initial_schema.sql` is the frozen baseline — never edit a shipped migration; each is
checksummed and applied once). Schema changes add the next `NNN_*.sql`; data transforms
SQL can't express add a **code migration** TS module under `src/db/migrations/code/`
(shared `NNN_` ordering, same per-migration transaction). On startup the runner migrates a
**copy** of the DB (`<dataDir>/.migrate-tmp`) and **atomically swaps** it in on success; on
failure the live `pgdata` is untouched, so downgrading to the previous binary just works. The
renamed-aside originals are kept as `pgdata.superseded.<timestamp>` (the swap auto-retains the
newest 5 — `db/superseded.ts`). A superuser can reclaim them on demand: `GET
/api/database-info/superseded` reports the on-disk size and `POST
/api/database-info/prune-superseded` deletes **all** of them (no rollback retained; the live
`pgdata` is untouched). Both are surfaced in the Database card on the Storage settings
subpage and are embedded-only — external Postgres migrates in place and produces no snapshots.
An **external Postgres** migrates **in place** instead: per-migration transactions under a
session `pg_advisory_lock` (`applyPendingMigrationsExternal`), with the downgrade guard
re-checked under the lock, so concurrent startups can't double-migrate and a failed
migration leaves the committed prefix intact. A database carrying migrations the binary
doesn't recognize makes the server exit and ask the operator to upgrade. Migration
mechanics and the per-migration rules are in `AGENTS.md` › Database migrations.

**Run-log compaction.** Run logs (the append-only `heartbeat_run_log_chunks` table, kept
forever) are the largest thing in a busy instance's DB; compaction is the retention trim
that keeps old runs' logs down to what still matters. A superuser triggers it from the
Database card on the Storage settings subpage: `POST /api/database-info/compact-run-logs
{older_than_days}` writes a `log_compaction:active` marker in `system_meta` (also the "in
progress" flag the panel's button disables on) and kicks the drain. The `log-compaction`
cron (`services/log-compaction.ts`, guarded so a manual kick and the scheduled tick never
overlap) drains the backlog a bounded batch at a time. **Nothing starts a pass on its own** —
the cron is a no-op without the operator's marker, because run logs are the user's history
and an instance may deliberately keep all of it; a test asserts this. Each batch selects ids
and sizes only and reads each run's tail (never the whole log, which reaches the 10 MB cap),
and commits **per run** rather than wrapping the batch in one transaction: every transaction
block serializes process-wide, so a single 50-run transaction stalled every agent and every
request for its duration. Each pass replaces one old, finished,
large-enough run's chunks with a single compacted chunk (a "compacted" notice + the run's
`invocation_command` + the end-of-run summary/`[done]` line) and stamping
`log_compacted_at` (migration `040`, partial index `idx_runs_compaction`; eligibility
filters on the summed `pg_column_size` of the run's chunks). When the backlog drains it
runs `VACUUM (FULL, ANALYZE)` over both run tables on the **embedded** backend — the chunk
table (compaction's DELETEs) and `heartbeat_runs` (the flusher's per-flush usage UPDATEs;
PGlite has no autovacuum daemon — external Postgres is left to autovacuum) — records the
real bytes freed in `log_compaction:last`, and clears the marker.
`GET /api/database-info/run-log-usage` reports live sizes (`pg_database_size`,
`pg_total_relation_size` over both tables — cheap, no detoast) plus the
reclaimable/backlog estimate and status for the panel, embedded-only figures degrading to
null/0 elsewhere. Deploy-time knobs: `HEZO_LOG_COMPACTION_CRON`, `_BATCH`, `_MAX_PER_TICK`,
`_PRESERVED_BYTES`. The trimmed detail is unrecoverable, so the UI confirms first.
Migration `041` (which moved logs from the old `heartbeat_runs.log_text` blob into chunks
and dropped the column) leaves the legacy dead-TOAST graveyard behind — a one-time,
marker-gated `VACUUM (FULL, ANALYZE) heartbeat_runs` at startup
(`runLegacyRunLogVacuumOnce`, embedded only) reclaims it on the first post-upgrade boot.

**Nightly database maintenance** (`services/db-maintenance.ts`, the `db-maintenance` cron,
default 04:30). Two deliberately narrow jobs:

- **`analyzeHotTables`** refreshes planner statistics on the **embedded** backend only.
  PGlite has no autovacuum and therefore no auto-ANALYZE, so as an instance grows the
  planner keeps costing queries against statistics gathered when the tables were small and
  silently stops choosing the indexes added for them — the composite indexes in migration
  `047` would degrade to sequential scans at exactly the size where they matter. It reads
  nothing and deletes nothing. A no-op on external Postgres, where autovacuum already does
  it. The table list is explicit (the hot ones), and a test asserts every name resolves —
  the per-table catch means a typo would otherwise degrade to a warning and that table
  would silently never be analyzed.
- **`sweepTerminalWakeups`** deletes terminal `agent_wakeup_requests` rows older than the
  retention window (7 days), bounded per pass so a backlog drains over several ticks. This
  is the **only** table swept automatically, and it qualifies on a specific test: it is
  internal scheduler bookkeeping with no user-facing surface — nothing renders it, exports
  it, or links to it. Run logs, cost entries and audit history are the user's record and an
  instance may keep all of it; reclaiming those stays an explicit operator action (run-log
  compaction above). `ACTIVE_WAKEUP_STATUSES` / `TERMINAL_WAKEUP_STATUSES` live in
  `@hezo/shared` beside the enum with a test asserting they partition it exactly, so adding
  a status fails the build until someone classifies it — `deferred` is **active** (a
  cleared blocker re-queues it) and must never be swept.

**Storage abstraction & transactions.** All app code takes the `Db` interface
(`query`/`exec`/`transaction`/`acquireSessionLock`/`close`); the drivers live in
`src/db/drivers/` (`PgliteDb`, `PostgresDb`) and are constructed only by
`src/db/open.ts:openDatabase()` at startup. `Db.transaction(cb)` pins the block's
connection in AsyncLocalStorage, so closed-over `db.query` calls inside the block join
the transaction; nested calls join the ambient transaction, and queries from async work
that outlives its block throw. On PGlite this maps to the engine's native exclusive
transaction; on Postgres, blocks additionally serialize in-process to preserve the
read-modify-write semantics the app was written against (plain queries ride the pool
concurrently). The raw connection string never reaches request-reachable state: startup
computes a redacted `StorageInfo` once (`redactDatabaseUrl` in `src/lib/db-info.ts` —
credentials occluded, query params dropped except `sslmode`) and only that is passed to
`buildApp`, surfaced at the superuser-only `GET /api/database-info` for the Settings →
General Database card.

**External TLS (`sslmode`).** node-postgres 8 reads `prefer`/`require`/`verify-ca` as
aliases for `verify-full`, which no other Postgres client does and which pg 9 drops.
Since managed providers (DigitalOcean, RDS, Azure) sign with a private CA, that reading
rejects connection strings `psql` accepts. `normalizePostgresUrl`
(`src/db/postgres-url.ts`) opts the string into pg-connection-string's libpq semantics
(`uselibpqcompat=true`) for exactly the modes the two readings disagree on, leaving
`no-verify` (which would flip back to verifying) and bare `verify-ca` (which would throw)
untouched. It is applied in `PostgresDb.connect` — the single pool construction site, so
it is unbypassable — and an explicit `ssl` option would not work there, since
node-postgres merges the parsed connection string *over* the caller's config. The same
function reports the resulting `PostgresTlsPosture`, which `openDatabase` renders into the
startup line so a `require` connection visibly says "certificate not verified".
Connect failures are classified by `src/db/postgres-connect-errors.ts`: deterministic
causes (rejected certificate, bad credentials, missing database) skip the retry backoff and
carry targeted guidance instead of the generic TLS advice. Delete the normalizer when pg
reaches v9.

**Asset storage.** Asset blobs (task attachments + the project assets library) live behind
the `AssetStore` interface (`src/assets/store.ts`:
`write`/`read`/`delete`/`deleteProjectAssets`/`close`, keyed `projectId/assetId` — teams
are 1:1 with projects so nothing team-scoped appears in a key, and a blob is immutable per
asset id since overwrites mint a new id). Drivers live in `src/assets/drivers/` and are
constructed only by `src/assets/open.ts:openAssetStorage()` at startup: **local** (default;
`<dataDir>/assets/<projectId>/<assetId>`) and **s3** (`--asset-storage-url` /
`HEZO_ASSET_STORAGE_URL`, one `s3://KEY:SECRET@endpoint/bucket[/prefix]?region=…&pathStyle=…&tls=…`
URL) — a thin SigV4 client over `aws4fetch` (`src/assets/s3-client.ts`, exactly
PutObject/GetObject/DeleteObject/ListObjectsV2/DeleteObjects; deliberately S3-compatible-only,
no provider-native drivers) with a ListObjectsV2 preflight + bounded retry at startup and a
typed `AssetStorageError` printed verbatim + exit on failure. In S3 mode the host filesystem
holds no asset bytes at all; both layouts share the same relative `<projectId>/<assetId>`
shape so switching backends is a plain directory↔bucket sync — which `hezo backup` /
`hezo restore` perform built-in (see Backup/restore below), copying blobs through this
interface into and out of a backup bundle. On local-driver open, a
one-time idempotent fs-only relocation (`relocateLegacyAssetBlobs`) renames blobs written by
pre-abstraction versions (`teams/<t>/projects/<p>/assets/<id>`) into the new layout. The raw
URL never reaches request-reachable state (mirrors the DB posture): startup computes a
redacted `AssetStorageInfo` once (`redactAssetStorageUrl` in `src/lib/asset-storage-info.ts`
— credentials occluded, query params dropped except `region`/`pathStyle`/`tls`), surfaced at
the superuser-only `GET /api/asset-storage-info` for the Settings → General Asset-storage
card. **Agents access assets exclusively through the API** — the assets dir is *not*
bind-mounted into containers. Binary contents come back from `read_project_asset` (and
task-thread attachment lines in run prompts / `list_comments`) as absolute signed download
URLs on the `http://host.docker.internal:<serverPort>` origin (the same NO_PROXY'd origin as
the MCP endpoint, so a plain in-container `curl` works), signed with the long agent TTL
(`AGENT_ASSET_URL_TTL_SECONDS`, 24 h; `lib/asset-urls.ts:signAgentAssetUrl`). Raster images
(PNG/JPEG/GIF/WebP) additionally carry pixel `width`/`height`: parsed once at write time by
`readImageDimensions` (`lib/image-dimensions.ts`) into the nullable `assets.width`/`height`
columns (migration `036_asset_dimensions.sql`), backfilled lazily on first `read_project_asset`
for rows written before the feature. At or under `MCP_INLINE_IMAGE_MAX_BYTES` (~4 MB) the image
itself is returned **inline** as an MCP image content block so a vision-capable runtime can review
it (opt out with `include_image: false`; larger images fall back to the URL). The `tool()` wrapper
(`mcp/tools.ts`) normally serialises a handler result to a single text block, but passes a
handler's `{ __mcpContent: [...] }` marker through untouched to carry the image block. Project
deletion sweeps blobs via `deleteProjectAssets` (S3: paginated list + 1000-key batch
deletes, which also collects orphans). The in-process S3 sim
(`test/helpers/s3-sim.ts`) backs the driver-conformance and integration suites; the
`test-s3` CI job runs the env-gated leg against real MinIO.

**Backup/restore.** `hezo backup` captures the whole instance — database **and** asset
blobs — as a **backup bundle** directory: `database.backup.gz` (the portable logical
database backup) + `assets/<projectId>/<assetId>` blob files + a `manifest.json` written
**last** as the completion marker. The database half is the **portable logical backup**
(`src/db/logical-backup.ts`): gzipped JSONL carrying the applied-migration set plus every
row (bytea → base64, generated tsvector columns excluded and recomputed on load). Dump
queries and restore inserts are batched by **bytes** as well as rows
(`dumpPageRows`/`planInsertBatches`): each table's page size derives from its measured
uncompressed row sizes, keeping every protocol message far below the embedded engine's
~16MB per-response ceiling — which a large-log table (`heartbeat_run_log_chunks`, whose
legacy-migrated rows can each carry a whole multi-MB run log) would
otherwise breach in a single flat-size page and hard-crash the WASM instance. The
subcommands' teardown closes are best-effort (`closeQuietly` in `cli.ts`), so closing an
already-crashed engine can never mask the original dump/restore error.

**Both directions are streamed, never buffered** — the format is designed so neither side
ever holds the database in memory:

- **Dump.** `streamLogicalBackupLines` is an async generator yielding one JSONL line at a
  time; `dumpLogicalBackupToFile` pipes it through gzip straight to the destination file, so
  resident memory stays at roughly one page regardless of instance size. Every caller that
  ends up with a file on disk uses it — the `hezo backup` subcommands and the
  external-Postgres **pre-migration backup**. There is no buffer-returning form.
- **Restore.** `restoreLogicalBackupFromFile` decompresses incrementally off disk
  (`linesOfGzipFile`, via `StringDecoder` — gzip chunk boundaries land mid-codepoint and the
  dump carries arbitrary user text) and inserts rows **as they are read**: a batch flushes on
  the row cap, the byte target, or a change of table, all inside the one restore transaction.
  There is deliberately no separate parse phase and no row *total* in the progress output —
  knowing the total up front is only possible by reading everything first, which is the bug.
  `peekLogicalBackupHeaderFromFile` decompresses only as far as the header, which is how the
  restore CLI identifies a backup, and rejects anything else, without touching the body. There is no buffer-taking form.

This matters most on the **startup** path, where the pre-migration backup runs. Collecting
the whole database into a `string[]`, joining it, and gzipping that held three uncompressed
copies at once, which OOM-killed small hosts (exit 137) *mid-upgrade* — and since the kill
lands before the migration is applied, the restart policy replayed the identical kill on
every boot, leaving the instance in an unbreakable loop showing "Running database
migrations…". Restore was worse still (compressed buffer + uncompressed buffer +
uncompressed string + line array + every decoded row before the first INSERT) and is the
**recovery** path, so it has to work on a host that is already short on memory.

The same rule applies to the **updater**: `downloadAndStage` streams the release asset to
`staged.part` while hashing incrementally, and only renames it into the staged path once the
SHA256 matches — so an unverified binary is never stageable and a >100MB asset is never
resident. Asset blobs (`assets/blob-backup.ts`) are bounded by construction instead: each is
capped at `ATTACHMENT_MAX_BYTES` (10MB), rows are enumerated a page at a time, and copies run
with bounded concurrency.
Restore replays the binary's own migrations up to exactly the recorded set, then loads
data in one transaction with FK constraints dropped/re-added around the inserts (insert
order and self-references never matter) and serial sequences resumed; migration-seeded
rows are truncated first so the backup is authoritative. The asset half
(`src/assets/blob-backup.ts`) enumerates the authoritative `assets` table on backup and
the bundle's own `assets/` tree on restore, copying blobs one at a time with bounded
concurrency through the `AssetStore` interface and verifying each restored blob's sha256
against the target row. Because both the DB and asset drivers are backend-agnostic,
`hezo backup` then `hezo restore` moves an instance's database **and** assets between local
and hosted storage in either direction — direction is expressed purely by which of
`--database-url` / `--asset-storage-url` each step sets, and the source is only ever read
(copy-only). `--no-assets` writes the legacy database-only bare `.backup.gz` file (the
artifact internal callers still use), `--no-database` an assets-only bundle, and
`--strict-assets` fails restore on any blob with no verifying row. Restore auto-detects the
input: a directory is a bundle, a file whose header parses is a `.backup.gz`, and anything
else is refused with a message naming the expected format. The physical pgdata tarball
(`db/backup.ts`) is **gone** — it only ever loaded into embedded PGlite, so it was never a
backup that could restore onto both backends; converting one needs a Hezo old enough to read
it, then a fresh `hezo backup`. Restoring a large instance is minutes of work inside two loops (row inserts, blob
copies), so both engines emit `ProgressState` updates through an optional `onProgress`
callback and `runRestore` renders them (`lib/progress.ts`): a phase line per step
(read/wipe/schema/prepare/constraints) and a live counter with percentage and
ETA for the countable ones (rows loaded per table, blobs copied). Rendering
adapts to the stream — one line rewritten in place (`\r` + erase-to-EOL) on a TTY, throttled
appended lines into a pipe or log file — and the engines themselves stay terminal-agnostic.
The CLI identifies a single-file `.backup.gz` from its header alone
(`peekLogicalBackupHeaderFromFile`, which stops at the first newline) and then streams the
body through `restoreLogicalBackupFromFile`, so a multi-GB backup is never decompressed for
the header and again for the load, and never held in memory. External startup migrations write a bare logical `.backup.gz` into `<dataDir>/backups/`
automatically before applying (last 5 kept; a failed backup aborts the migration); the
embedded path keeps its stronger copy-swap instead. The `hezo backup`/`hezo restore`
subcommands resolve the data dir with the same precedence as the server (`HEZO_DATA_DIR` >
`--data-dir` > `~/.hezo`, via `pickDataDir` in `cli.ts`), so a deployment that starts the
server with `HEZO_DATA_DIR` set needs no extra flag; backup also refuses (with an actionable
message) if the target holds no `_migrations` bookkeeping. Embedded is single-process, so
backup/restore against the embedded backend are gated by an **advisory instance lock**
(`db/instance-lock.ts`): the running server writes its OS PID to `<dataDir>/hezo.lock`
(embedded only, removed on graceful exit), and the subcommands refuse while that PID is
*alive* — `process.kill(pid, 0)` is a portable liveness probe across the Linux/macOS/Windows
binaries, and only a definitive `ESRCH` counts as dead, so a stale lock from a crash never
blocks (the next start overwrites it) and a live server is never mistaken for gone. External
Postgres manages its own concurrency and writes no lock.

**Releases & updates.** A PR flow (`.github/workflows/`): `release.yml` computes the next
version from Conventional Commits and opens a `release/<version>` PR. The auto bump
(`scripts/release.ts` → `computeBump`) is derived **purely from commit type** — `feat` →
minor, any other conventional type → patch — and **never returns `major`**: a breaking-change
marker (`feat!:` / `BREAKING CHANGE:`) does not escalate the version (pre-1.0 the API is
explicitly unstable, and major releases are a deliberate human decision, never automated).
Breaking changes are still listed in the changelog's "Breaking Changes" section so a reviewer
can choose to cut a major by hand via the workflow's explicit `release-type: major` dispatch
input. Merging the release PR fires
`release-publish.yml`, which first builds and publishes the agent-base image to GHCR
(`ghcr.io/hezo-ai/agent-base:<version>` + `:latest`) and then — **only once that push
succeeds** — tags the merge commit, cross-compiles, and publishes a GitHub Release (assets
`hezo-{os}-{arch}[.exe]` + `SHA256SUMS`). Gating the Release on the image (the `publish`
job `needs` `publish-agent-image`) means a published version never advertises binaries whose
provisioning pull (`agent-base:<version>`) would 404. A final `publish-cfn-template` job then
re-uploads the AWS CloudFormation deploy template (`deploy/aws/hezo.cfn.yaml`) to the public S3
bucket the README's "Deploy on AWS" Launch Stack button serves, so the hosted copy never drifts
from the repo (it asserts the template is ASCII-only first, and skips when AWS credentials aren't
configured). A last `notify-website` job announces the release to the marketing site:
hezo.ai/docs is rendered by the separate `hezo-ai/website` repo (Gatsby on Cloudflare Pages)
from this repo's `docs/` tree via a `vendor/hezo` git submodule **pinned to the latest release
tag** — the job mints a token via the hezo-release-bot app and sends a `repository_dispatch`
(`hezo-release-published`, `client_payload.tag`) that the website's `update-hezo-submodule.yml`
handles by checking the submodule out at that tag and pushing (Cloudflare redeploys on push).
The website deliberately tracks **releases, not main**, so the public docs always describe the
version users can download; the dispatch must be sent from `release-publish.yml` itself because
the Release is created with the workflow's own `GITHUB_TOKEN`, whose events GitHub suppresses
(a `release: published` trigger elsewhere would never fire). The website workflow also keeps a
manual `workflow_dispatch` (optional `tag` input, defaulting to the latest release) as the
re-pin escape hatch. The running instance polls
`GET /api/updates/latest` (cached ~1 h, fails soft) and shows a bottom banner. The
Settings → General page also renders a **Version** section (current version linked to its
GitHub release, plus a **"Check for new version"** button that calls
`POST /api/updates/check` — any authed user — to force a fresh GitHub check bypassing the
1 h cache, the same upstream check the daily cron runs). When an update is available this
section mirrors the banner's staged-update lifecycle **in place** — driven by
`useUpdateStatus({ poll })`, which auto-refetches `GET /api/updates/status` every few seconds
through the whole pre-terminal lifecycle (`updateStatusPollInterval`: while the server is
`checking`/`downloading`/`applying`, **and** through the initial `idle` snapshot a self-applying
instance returns before staging has started) so the section advances live without a reload, then
stops once the state settles at `staged`/`error` (or there's nothing to stage): a self-applying
instance shows **"Downloading new version…"** while staging, then an **"Install & restart"**
button (same restart confirmation) once `Staged`, or a **"Retry download"** on `Error`; an
instance that can't self-apply falls back to the **"Download"** release link. The top-of-shell
banner polls the same way (`useUpdateStatus({ poll: true })`), so it surfaces "Install & restart"
live on any page the moment the binary is staged — not only after a manual reload.

**Stale-bundle reload prompt.** Independently of the binary self-update, an open tab keeps running
the web bundle it first loaded; after the server moves to a new version (self-update, redeploy),
that tab's JS can be older than the server and mis-render data the newer server pushes — e.g. a new
comment/action `kind` the older bundle doesn't know renders the action-comment renderer's neutral
"needs a newer version — refresh the page" fallback instead of the real card. `useServerVersionChanged`
(`hooks/use-stale-bundle.ts`) watches the `current` field of `GET /api/updates/status` and latches
true once it observes a **different** version than the one first seen this session — a server restart
drops the WebSocket, and the reconnect's blanket `invalidateQueries` (`useInvalidateOnReconnect`)
refetches the status, so the new version is observed right after the update lands. The shell's
`ReloadPromptBanner` (below `UpdateBanner`) then offers a one-click **Refresh** (`location.reload()`).
Tracking a *change* rather than comparing to a build-time constant means it never false-positives in
dev, where a stable server version never changes mid-session.

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
(fire-and-forget on every status poll from the banner or settings section, gated on
`isSupervisedWorker()`) and the daily
`update-check` cron (`HEZO_UPDATE_CHECK_CRON`), so a running instance usually stages a new
release within seconds. `POST /api/updates/download` (superuser) is the same download path on
demand; `POST /api/updates/apply` (superuser) gracefully shuts the worker down and exits with
the sentinel via `exitToApplyUpdate()` (`runtime-control.ts`, which also wires `shutdownRuntime`
to signals). **Auto-install** (`--auto-install-updates` / `HEZO_AUTO_INSTALL_UPDATES`, off by
default) makes the install itself unattended: JobManager registers an `auto-install-update` cron
(`HEZO_AUTO_INSTALL_CRON`, every 5 min; registered only when the flag is set on a supervised
worker) that reads `state.json` — no network — and, when a verified update is `Staged` and no
agent runs are in flight (`runningTasks` empty; busy instances defer to the next tick), calls
the same `exitToApplyUpdate()` path as the operator button.
`applyStagedUpdate()` does the swap *while the worker is down*: copy
staged → a temp file adjacent to the target (avoids `EXDEV`), then **Unix** atomic `rename`
over the binary, or **Windows** rename-trick (rename the locked `.exe` aside, move the new
one in, verify, roll back on failure; stale `-old-` files swept on next supervisor start).
State survives the restart via the normal recovery path (`reconcileOnStartup`), and the
instance returns **unlocked** via the **unlock-key handoff** (`lib/unlock-handoff.ts`): the
worker pushes its in-memory unlock key to the supervisor over the spawn's IPC channel
(`serialization: 'json'` — the wire format must stay stable, since post-update the old
supervisor code talks to the new worker binary) on every `onUnlock`; the supervisor holds it
in memory only (`createSupervisorUnlockKeyStore`) and answers the relaunched worker's request
on a locked boot (`setupWorkerUnlockHandoff`, wired in `index.ts`). The reply still passes the
master-key canary check, so a stale key just leaves the instance locked; the key never touches
disk, argv, or env. Restarts the supervisor doesn't survive (crash, service restart, reboot)
still come up locked — the web restart overlay polls `/api/status` and reloads onto the
master-key gate. `GET /api/updates/status` surfaces the staged-update state plus an
`autoUnlock` hint (startup master key **or** an active handoff channel on a supervised worker)
so the UI's confirmation only warns about re-unlock when re-unlock will actually be needed. The web banner shows an **"Install & restart"** button only once the
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
  `instance-settings` (incl. `PATCH /instance-settings/locale` — self-authenticating: open
  pre-onboarding, superuser after; § 11), `preferences`, `ui-state`.
- **Projects & teams** — `projects` (creation/intake, the 1:1 team reached *through* the
  project — there is no bare `GET /teams`), `team-templates`, `agent-types`, `repos`,
  `project-docs`.
- **Agents & runs** — `agents` (hire/fire/pause/resume, system-prompt revisions),
  `execution-locks`, `queued-wakeups`, `chat` (live realtime chat session — today the CEO).
- **Tasks & collaboration** — `tasks`, `goals` (CRUD + `/goals/runs` + `/goals/:id/history`),
  `comments`, `mentions`, `assets`, `inbox`, `search` (full-text).
- **Money & governance** — `costs` (project-scoped, `group_by=day` for charts),
  `model-pricing`, `approvals`, `audit-log` (**keyset**-paginated, see below).
- **Integrations & secrets** — `ai-providers`, `secrets`, `connectors`, `oauth`
  (connectors: ensure / auth-start — project-scoped and instance-admin
  (`/connectors/:id/auth-start`) / device / callbacks), `skills`.
- **Ops** — `health`, `updates`, `preview` (HMAC-signed file URLs), public assets.

**Request-body ceiling.** `/api/*` carries a global `bodyLimit` at `API_BODY_MAX_BYTES`
(32 MB). Only the handful of upload routes were capped before, so a JSON body had no bound
at all and one request could ask the process to buffer arbitrarily much before a handler
saw it. It is a **backstop, never a policy**, and must stay well clear of every per-route
cap for two reasons a test pins: a route that polices its own size answers a too-large file
with its own specific `4xx`, which an earlier global trip would replace with an opaque
`413`; and the per-route caps measure the *file* while the request carries it in a
multipart envelope, so a ceiling set to exactly `ATTACHMENT_MAX_BYTES` rejects a
legitimately-sized maximum attachment. Reads are unaffected - this bounds request bodies,
not responses. `/mcp` and `/mcp/assets` sit outside `/api`: the agent surface is not capped
here.

**Pagination.** Most list routes are offset-paginated (`page`/`per_page`, `meta.total`)
via `lib/pagination.ts`. The **activity log** is the exception and pages by **keyset**
(`?limit=&cursor=`, `meta.has_more` + `meta.next_cursor`) because `audit_log` only grows
and is never pruned: its global view carries no scope predicate, so producing `total`
meant a full sequential scan of the largest table on the instance for every page load —
to render a number nothing consumed. Offsets also drift, since rows land while someone
reads. The cursor is opaque (`<created_at ISO>|<id>`) and the seek is
`(created_at, id) < ($1, $2)` ordered `created_at DESC, id DESC`, so the order is total
and no row can be skipped or repeated across a page boundary; `has_more` is exact because
the query over-fetches one row rather than counting. Migration `047` adds the two indexes
the seek needs (`audit_log (created_at DESC, id DESC)` and the `project_id`-leading
variant) — the pre-existing indexes stopped at the leading column and left `id` to a sort
step, which a range scan cannot use. Both web views drive it through `useInfiniteQuery`
with a "Load older activity" control; the global view previously fetched a fixed newest-100
slice with no way to reach anything older.

One non-REST surface shares the port: the **MCP endpoint** (`POST /mcp`, Streamable
HTTP), whose tools mirror the REST surface and enforce the same authorization. It is the
interface agents drive — tasks, comments, approvals, credentials — and external agents
can drive it too, with an **API key** (minted by an admin, or obtained by
**self-registration** — pending admin approval, then admin-equivalent across every
project/team; § 10). It also exposes `POST /mcp/assets` (multipart) for binary uploads,
since JSON-RPC can't carry a file — with optional `project`, `path` (the full destination
path, folders + basename, up to 2 levels, preserved verbatim — also honoured from the file
part's `filename=`), `overwrite` (`true` replaces an existing asset at the path in place,
like `write_project_asset`), and the legacy `folder` field (placing the basename in a
library folder; ignored when `path` is given). **API keys authenticate the MCP surface only**; REST is
the user-JWT (human/browser) surface. `GET /SKILL.md` serves the
manifest that teaches an external agent how to use it — including the connect/register
flow — and `GET /llms.txt` points to it. The matching **human** reference — a full
tool-by-tool page with parameters and return shapes — is generated from the same registry
by `packages/server/scripts/build-mcp-reference.ts` (run under `bun run build:docs`, guarded by
`mcp-reference.test.ts`) and committed as `docs/reference/mcp-api.md`. Authorization for
both the REST and MCP surfaces is § 10.

**Transport internals** (`mcp/server.ts`). The endpoint is a plain Hono route, not an SDK
transport binding: it reads the JSON-RPC body itself and short-circuits the cases that must
not reach the tool registry — a notification (no `id`) gets `202` with an empty body, as the
streamable-http contract requires and rmcp clients depend on; `initialize` is answered
directly, since the registry's connection has already negotiated initialization; and an
unapproved caller is served the onboarding tools (`register`, `connection_status`) and
nothing else. Only `tools/list` and `tools/call` from an authenticated principal reach the
registry.

Those two are proxied to the singleton `McpServer` over an **`InMemoryTransport` pair that
is linked once and shared by every request**, with the per-request principal carried into
the tool handlers through an `AsyncLocalStorage` (`authContext`) rather than through the
transport. Sharing the link is load-bearing in both directions:

- An SDK `Protocol` owns exactly one transport, so linking a pair **per request** meant the
  second of any two overlapping requests threw `Already connected to a transport` from a
  floating promise, and its client then waited out the full SDK request timeout (60s) for an
  `initialize` reply no server would ever send. That made the endpoint effectively
  single-flight under concurrency and stalled every agent behind it. One long-lived link
  avoids it outright: the SDK multiplexes concurrent requests over a single transport by
  JSON-RPC id.
- `InMemoryTransport.send` invokes the peer's `onmessage` **synchronously**, on the caller's
  stack, which is what keeps each request's `authContext` store visible to the handler it
  dispatches. Any change that makes delivery asynchronous, or that hoists the auth context
  out of the call stack, breaks per-request authorization on a shared link.

The link is rebuilt on `initMcpServer` (a new server needs a new pair) and a failed link is
not cached, so the next request retries. `mcp-concurrency.test.ts` guards the invariant; it
has to bypass the DB-backed auth lookup, because the test database serialises those queries
and would otherwise prevent requests from ever overlapping.

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
