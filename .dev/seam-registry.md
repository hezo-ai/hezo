# Seam registry

The full list of seams. `AGENTS.md` carries the rule - extend the seam, never add a
parallel one - plus an excerpt of the seams most often reinvented. This is the lookup.

**Add a row when you add a seam.** A helper whose home is named inline somewhere else,
rather than here, is how a codebase ends up with two of everything.

| Need | Home |
|---|---|
| Guidance reaching every agent, now and future | `SHARED_INSTRUCTIONS` (`services/template-resolver.ts`) |
| Guidance for a subset of seeded roles | `agents/_partials/<group>/` |
| Validating an authored prompt | `checkPromptStyle` (`@hezo/shared`), plus `services/prompt-style-guard.ts` for the duplicates-`SHARED_INSTRUCTIONS` half |
| How a CLI receives the prompt, and where its system half goes | `RUNTIME_PROMPT_DELIVERY` / `RUNTIME_SYSTEM_PROMPT_FILE` (`@hezo/shared`) |
| A container backend | `ContainerEngine` (`services/sandbox/types.ts`), always reached via `SandboxBackendHolder.engine` |
| "Does this backend class need X?" | `SANDBOX_BACKEND_KIND` (`@hezo/shared`) |
| An in-container script or its parser | `services/sandbox/proc-scripts.ts` - never an adapter |
| What a container was provisioned with | `container_pool_members` (`memory_bytes`, `disk_ceiling_bytes`) - never re-read from the setting |
| "How long was this container up, and what did it cost?" | `container_uptime_entries`, written only by `services/sandbox/uptime-ledger.ts` from inside `pool-db.ts`'s own state writes; read through `services/container-hours.ts`, never with a second copy of the clipping SQL |
| A chat platform | `ChatChannelAdapter` (`services/chat-channels/`) |
| A host-side call to a repo's git host, with that repo's own credential | `resolveRepoGitHub` (`services/repo-github.ts`) - returns a verdict, never an upstream body |
| "Did this execution strand a handoff?" | `detectNoWakeExits` (`services/comment-wakeups.ts`) |
| "Who did this run notify without writing a comment?" | `created_by_run_id` on `agent_wakeup_requests` |
| Which rows of a task thread a reader wants | `packages/shared/src/task-thread.ts`, SQL via `lib/comment-filters.ts` |
| "May an uncredentialed hosted MCP reach a run?" | `probed_at IS NOT NULL AND probe_error IS NULL`, written only by `discoverConnectorMethods` (`services/connectors/method-discovery.ts`) and read through `SAAS_CREDENTIALED_SQL` (`services/connectors/connections.ts`) |
| "Is this hosted MCP answering right now?", asked by a human or an agent | `discoverConnectorMethods` + `describeProbeVerdict` (`services/connectors/method-discovery.ts`), reached through `POST .../connectors/:id/test` on both scopes. The `test_connector` MCP tool is a **second, divergent probe**: a raw `GET` that writes `auth_error` but never `probed_at`/`probe_error`, so its verdict never reaches the card, the banner or the run gate. Fold it into this seam rather than copying it |
| Which hosted connector a run's egress request is aimed at, and its allowlist | `loadMcpHostBindings` / `connectorForPath` (`services/connectors/connections.ts`) - the proxy inspects bodies only where `restriction` is set |
| "A hosted connector refused a run's request - what do the run and the operator hear?" | `RunProxyScope.onConnectorRejection` (`services/egress/proxy.ts`) fires it; `reportConnectorRunRejection` (`services/connectors/run-rejection.ts`) turns it into the two sentences and the re-probe, the caller supplying only where they go - never a direct write to `auth_error` / `probe_error` |
| "Is this run failure worth another attempt?" | `classifyRunFailure` (`services/run-failure-classification.ts`) for a thrown failure, `classifyRuntimeError` (`services/agent-stream-parser.ts`) for one a runtime reported on its stream - both return `RunFailureClass`, unrecognised is permanent, and no `TRANSIENT_ERROR_NAMES` row may name a backend |
| Waking the assignee after an assignment write | `wakeAgentIfAssigned` (`services/wakeup.ts`) |
| What happens to the work a finished run was woken for | `settleWakeupForRun` (`services/wakeup.ts`) - it reports `handback_failed`, so no caller may assume the work is queued |
| "Is this cancelled run still owed, and can a human act on it?" | `heartbeat_runs.cancel_reason` read through `RUN_CANCEL_BEHAVIOUR` (`@hezo/shared`) - never the `error` prose |
| "May this caller move this task's assignee?" | `assertNoBlockingRun` (`lib/reassign-guard.ts`) - not the one-run-per-task check, which is `isTaskBusyInDb` (`services/run-concurrency.ts`) |
| Serialising async work per key, with or without a bound | `lib/keyed-lock.ts` - `withKeyedLock` for a scope, `acquireKeyedLock` when the wait needs a `signal`/`timeoutMs`. Each family owns its own `KeyedLockRegistry`; never a second mutex |
| "Who holds this rotating credential, and how do I name them?" | `credentialLockHolder` / `describeCredentialHolder` / `credentialWaitNotice` (`services/agent-runner.ts`) - a `CredentialLockHolder` record, rendered as a run link (`formatRunLink`, `@hezo/shared`) that `RunLinkedText` (web) turns into the link; never a bare label |
| Text the server writes that names a run (a log line, a chat notice) | `formatRunLink` / `splitRunLinks` (`@hezo/shared`) on the way out, `RunLinkedText` (`packages/web/src/components/`) on the way in |
| "Did this release stop reading something an instance still sets?" | `REMOVED_ENV_VARS` / `detectRemovedEnvVars` (`config/removed-env.ts`) |
| Fire-and-forget work | `trackBackground()` (`lib/background.ts`) |
| Paging (lists and large content) | `mcp/paging.ts` |
| Shared enums, constants, validation run on both sides | `@hezo/shared` (`types/common.ts`) |
| A resolved operator setting (from the config file or a flag) | `runtimeConfig()` (`config/runtime.ts`) - never a bare `process.env` read, and never into a module-level `const` |
| "Did the deployer fix this setting, rather than the operator?" | `pinnedSetting` / `isPinned` (`lib/system-meta.ts`), which every pinnable getter routes through - never a direct `runtimeConfig().policy` read at a call site, and never a branch on `managedBy` |
| An instance setting | `routes/instance-settings.ts` + the `system-meta` helpers |
| Date formatting | `packages/web/src/lib/format-date.ts` |
| Duration formatting (a settled figure, not a live tick) | `formatDuration` (`packages/web/src/lib/format-duration.ts`) |
| A per-bucket stacked chart, and its axis/tooltip formatting | `StackedSeriesChart` + `chart-format.ts` (`packages/web/src/components/charts/`) |
| A dropdown panel's vertical side + height clamp | `usePanelPlacement` (`hooks/use-panel-placement.ts`), pure math in `lib/panel-placement.ts` |
| Open/close motion for a right-hand side panel | `--panel-motion` + `.panel-enter` / `.panel-exit` (`packages/web/src/index.css`), reached through `packages/web/src/lib/panel-motion.ts`. A panel that mounts when it opens takes the animations; one that is always mounted and only slides takes `PANEL_MOTION_TRANSITION`. `ResizableSplit` arms its grid-track transition on the panel appearing or disappearing and disarms it after - never leave it on, or every divider drag and Arrow-key step lags by the full beat |
| A breadcrumb row - one line, scrolling sideways rather than wrapping or truncating | `BreadcrumbRow` (`components/ui/breadcrumb.tsx`) - `Breadcrumb` renders through it; a caller with its own links takes the row, never a second `<nav>` |
| A device sign-in (copy a one-time code, enter it on a provider's page) | `DeviceCodeSteps` (`components/ui/device-code-steps.tsx`) - callers supply transport only |
| An optimistic mutation | `useOptimisticMutation` (`hooks/use-optimistic-mutation.ts`) |
| A server test context | `createTestContext()` (`test/helpers/context.ts`) |
| A migration test | `createDataPreservationHarness()` (`test/helpers/migrate.ts`) |
| A component test | `renderApp()` + `seed*()` (`packages/web/test/helpers/`) |
| A complete test double | `createStubDocker()` (`test/helpers/app.ts`) - never a hand-rolled partial |
| Seeding container uptime a calendar-window reader will bill | `seedUptimeStretch()` / `seedMonthToDateSeconds()` (`test/helpers/uptime.ts`) - web tests reach them through `@hezo/server/test/helpers/uptime` |
| A CLI runtime's own quirk (env, flags, model-id form, usage recovery, run-end behaviour) | that runtime's `services/runtime-adapters/<runtime>.ts`, its section in `agent-stream-parser.ts`, or its `RUNTIME_*` row (`@hezo/shared`) |
| An AI provider's own quirk (endpoint, credential env, subscription blob, judge model) | that provider's `PROVIDER_RUNTIME_ADAPTERS` entry (`@hezo/shared`), or its row in the per-provider table that owns the behaviour |

