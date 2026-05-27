# Agent Guidelines

## Commands

- `bun run test` — server unit/integration (vitest) + web component tier (vitest) + e2e (Playwright), in that order
- `bun run test --skip-e2e` — drop Playwright; runs server + web vitest only (~30s)
- `bun run test --e2e` — Playwright only
- `bun run test --pattern <substring>` — filter by file-path substring (works across all tiers; combine with `--e2e` to narrow e2e)
- `bun run test --package <server|web>` — restrict vitest run to one package
- `bun run test --concurrency <n>` — override worker count (default 10)
- `bun run test --bail` — stop on first failure
- `bun run build` / `check` / `check:fix` / `typecheck` / `dev`

`scripts/test.ts` is a commander CLI — it rejects unknown flags and `--` passthrough. To narrow by test name, use `test.only` / `describe.only` and revert before commit. Never call `npx playwright` or `npx vitest` directly (vitest's global `expect` clashes with Playwright outside the runner).

### Running one file or one test

- One vitest file: `cd packages/<pkg> && bunx vitest run <path>` (e.g. `cd packages/web && bunx vitest run test/task-comments.test.tsx`). Same flags as `bun run test`.
- Filter by test name: `bunx vitest run <path> -t '<substring>'`.
- Watch mode while iterating: drop `run` (`bunx vitest <path>`).
- One Playwright spec: `bunx playwright test test/e2e/<spec>.spec.ts` from the root.
- Headed Playwright for debugging: `bunx playwright test --headed --debug test/e2e/<spec>.spec.ts`.

### Diagnosing failures fast

- **vitest (server or web):** the failing assertion and its file:line print in the run summary. To re-run just the file with stack traces: `cd packages/<pkg> && bunx vitest run <path>`. Logs are inline.
- **vitest writing a single line that doesn't tell you why** (timeouts, weird async): add `--reporter=verbose`; for a single test, prepend `console.log` and re-run with the test name filter.
- **Playwright:** the trace zip lands under `playwright-report/` and `test-results/` on a failed CI run (`playwright.config.ts` is set to `retain-on-failure`). Download the `playwright-report` artifact from the GitHub Actions run, then `bunx playwright show-report playwright-report/` locally.
- **CI showing which test failed across thousands of log lines:** `gh run view --job=<job-id> --log 2>&1 | grep -E "✘|FAIL"`.

## Layout

- `agents/<template>/*.md` — single source of truth for agent system prompts. Each team template (e.g. `software-development/`, `blank/`) owns its own role docs. The seed in `packages/server/src/db/seed.ts` reads these at startup. Edit them directly. Hezo-specific tooling/file-paths/conventions belong here in AGENTS.md, not in role docs.
- `.dev/` — specs, schema, API, implementation plans. Keep in sync with code: describe what the system **does**, not what changed. No backwards-compat concerns pre-v1.

## Database migrations

Pre-v1: modify `packages/server/migrations/001_initial_schema.sql` in place and reset. Do not create new migration files.

## Testing

All changes ship with tests that exercise functionality (not "code runs without throwing"). Prefer integration over heavily-mocked unit tests. Three tiers:

| Tier | Where | Run cost | What it tests | When to use |
|---|---|---|---|---|
| Server unit/integration | `packages/server/src/test/**/*.test.ts` | ~ms each | API handlers, DB queries, services, MCP tools, agent run plumbing. Each test boots a fresh PGlite + Hono app via `createTestContext()`. | Everything backend. |
| Web component | `packages/web/test/**/*.test.tsx` | ~100-700ms each | React tree rendered in happy-dom against an **in-process** Hono + PGlite backend via `renderApp()` in `packages/web/test/helpers/render.tsx`. Asserts on DOM, forms, React Query refetches, navigation, mention rendering. Stubs WebSocket (`reconnecting-websocket`'s constructor checks) and `IntersectionObserver`. | Anything render-driven that doesn't depend on a real browser layout engine or WebSocket stream. ~80% of what used to be e2e. |
| Playwright e2e | `test/e2e/**/*.spec.ts` | ~10-30s each | Real Chromium. Mobile viewport (responsive checks at 375px), drag-drop file events, `boundingBox()` / sticky positioning, Virtuoso virtualization windows + scroll, scroll-to-bottom buttons, real `clientHeight`/`scrollHeight` comparisons, real WebSocket-streamed logs, the master-key gate flow before any token is set. | The thin slice that genuinely needs the browser. Default: write a component test instead. |

### Server unit/integration rules

- Each test file is fully isolated via `createTestContext()` / `destroyTestContext()` (`packages/server/src/test/helpers/context.ts`) — fresh PGlite + Hono app + HTTP server on port 0.
- Use `ctx.app` / `ctx.baseUrl` / `ctx.port` — never a shared singleton, never hardcoded ports.
- No mutable state shared between files.
- Always `destroyTestContext()` in `afterAll` (resource leak otherwise).
- Pure logic tests (crypto, parsing) can call functions directly.
- GitHub OAuth/repo/SSH-key tests use the local simulator at `packages/server/src/test/helpers/github-sim.ts` — set `GITHUB_API_BASE_URL` and `GITHUB_OAUTH_BASE_URL` before the test context boots.

### Web component rules

- Read `packages/web/test/helpers/render.tsx` and `helpers/seed.ts` before writing a new spec — the harness API is `renderApp({initialPath, seed?})` returning `{ ctx, router, container, user, findByText, getByRole, ... }`. `getTestContext()` reaches the in-process app/db mid-test.
- Use `seedWorkspace()` / `seedProject(ws, { name })` / `seedTask(ws, project, { title })` / `seedComment(ws, task, body)` for setup; they drive the real API.
- Navigate via `router.navigate({ to: '/teams/$teamId/tasks', params: { teamId: ws.team.slug } })` — memory history, no real URL.
- Each test gets a fresh PGlite + Hono in `beforeEach`. The harness clears the singleton react-query cache between tests, but cross-spec state still leaks via module-level singletons (`api`, the queryClient), so keep `beforeEach` setup contained.
- Dialogs / Radix popovers render into a portal on `document.body`. Query selectors against `document.body` (not `container`) when the element is inside a Radix `Portal`.
- Auto-wait via Testing Library's `findBy*` / `waitFor`. Don't use `expect(...).toBeDisabled()` (jest-dom matchers aren't loaded) — read `disabled` directly off the element.

### When to write Playwright vs component

Default to a component test. Reach for Playwright only when one of these is true:

- The test calls `page.setViewportSize` to a non-default width (mobile-only behavior).
- The test dispatches drag-drop / `DataTransfer` events.
- The test reads `scrollTop`, `scrollHeight`, `boundingBox()`, or asserts on Virtuoso's mounted-row window.
- The test asserts on real CSS computed layout (`getComputedStyle`, `clientHeight` vs `scrollHeight`).
- The test depends on a real WebSocket stream (agent run logs).
- The test exercises the master-key gate or onboarding flow before any auth token exists.

Each Playwright spec we still keep has a one-line comment at the top explaining which of these it needs.

Root `playwright.config.ts` auto-starts server (:3101) and web (:5174). Use `authenticate(page)` to bypass the master-key gate when not testing auth itself. The `sharedWorkspace` fixture in `test/e2e/fixtures.ts` provisions a Startup-templated team once per worker; tests create their own per-test project under it via `createProjectAndClearPlanning`. Captain's coherence-review run is suppressed by `HEZO_E2E_SKIP_COHERENCE_REVIEW=1` in the test server env — without it, team setup blocks for ~30-60s.

### No spurious `[error]`/`[warn]` in unit-test output

A green test run should have a quiet log. If a test produces `[error]` or `[warn]` lines that are not the test itself asserting on an error path, fix the source — don't leave it as background noise. The two patterns that bite:

- **Fire-and-forget background work must be tracked.** Any `xxx(...).catch((e) => log.error(...))` left orphaned at a route or service boundary races test teardown — the DB closes under it and you get `PGlite is closing/closed` errors. Wrap every such call in `trackBackground(...)` from `packages/server/src/lib/background.ts`. `safeClose` (used by `destroyTestContext` and every test's `afterAll`) drains the tracker before closing the DB. The `.catch(...)` stays inside the wrapper so a rejection still becomes a settled promise.
- **Inline docker mocks must extend `createStubDocker()`.** Tests that build an ad-hoc `mockDocker` with only the methods they care about will trigger `TypeError: docker.containerLogs is not a function` (or similar) when production code that runs as a side-effect calls a method the stub omitted. Always go through `createStubDocker({ ... })` (exported from `packages/server/src/test/helpers/app.ts`) and pass the overrides as the argument — never hand-roll a partial object. The same rule applies for any other interface: start from a complete stub.

When the global `app.onError` handler logs a `Route error on ...` line for an expected-failure test, the route is using a 500 where a 4xx would be honest. Catch known constraint codes locally (see `isFkViolation` in `packages/server/src/lib/sql.ts`) and return a `4xx` with `err(c, ...)` instead of letting the error propagate.

### Server side effects — await vs `trackBackground`

If a side effect produces state that the immediate response or the next refetch from the same client must reflect, **`await`** it inside the handler. `trackBackground(...)` is for work whose completion is decoupled from the current request — agent wakeups, container spin-up, summary/context fan-outs, audit logs.

Concretely, on `PATCH /tasks` the system comments that record the change (`recordStatusChange`, `recordTitleChange`, `recordAssigneeChange` from `packages/server/src/services/task-events.ts`) MUST be awaited, because the client's onSettled invalidation triggers an immediate comments refetch that has to see the row. `recordTaskLinks` lands on a *different* task and stays fire-and-forget — the source response doesn't carry it. `createWakeup` / `wakeAgentIfAssigned` stay fire-and-forget — the agent's run is inherently async.

Wrap the awaited call in `try/catch` and `log.error(...)` to keep the "log and continue" semantics — a failed side effect should not 500 the request.

### E2E flake patterns

The remaining Playwright suite is small but still subject to a 1 Hz agent wakeup cron and a dev-mode Vite. When a spec flakes:

- **Scope every response matcher to the test's own IDs.** Use `taskMatcher` / `teamMatcher` / `agentMatcher` from `test/e2e/helpers.ts`. A bare `/api/teams/[^/]+/tasks/[^/]+/` regex can match Captain's background planning-task PATCH and satisfy the matcher before your mutation has even left the browser. For tasks, `taskId` is the lowercase identifier, not the UUID.
- **For "click save → assert UI updated", use `saveAndWaitForRefetch(page, locator, { mutation, refetch })`.** Mutation landing ≠ UI rendering — React Query has to invalidate, refetch, and re-render before the new text is in the DOM.
- **Scroll Virtuoso before asserting on a bottom-of-list item.** Virtuoso only mounts the viewport range. Scroll the container first: `await page.locator('main').first().evaluate((el) => el.scrollTo({ top: el.scrollHeight }))`.
- **Sequence `page.request` after in-flight UI mutations.** `page.request.<method>` uses a separate APIRequestContext from the page's fetch; the two can land in either order. `await page.waitForResponse(...)` the UI mutation before firing the API mutation.
- **Don't raise timeouts to mask a race.** A bumped timeout signals "this is genuinely slow" to the next reader; it's almost always a missing matcher scope or a missing `await`.

## Type safety

No `any` in source code. Use specific types, `unknown`, `Record<string, unknown>`, or generics. If a library lacks types, install them (`@types/*`) — don't fall back to `any` or `declare const` hacks. `any` is acceptable only in test files for unpredictable JSON.

## Build artifacts

Never commit `.js`/`.d.ts`/`.js.map`/`.d.ts.map` alongside source. Compiled output lives in `dist/`. If generated files appear under `packages/*/src/`, delete them.

## Conventions

- `commander` for all CLI argument parsing — never parse `process.argv` manually.
- Use shared constants/enums from `@hezo/shared` (`packages/shared/src/types/common.ts`) — no raw status/type strings. Add new enum values to the shared package first.
- `bunx`, not `npx`.

### Web frontend mutations

Three strategies, picked by mutation shape. Default to optimistic unless the mutation falls into the response-driven or invalidate carve-outs below.

- **Optimistic + rollback** — default for field edits, toggles, choose-option, reactions. Use `useOptimisticMutation` (`packages/web/src/hooks/use-optimistic-mutation.ts`). The cache updates synchronously; on server error the previous state is restored and `toast.error(...)` fires. `invalidateOnSettled` is for sibling queries (list views) that need to re-flow after the change lands. Pass `mergeResponse` to reconcile server-computed fields (timestamps, status set by server-side automations).
- **Response-driven** — creates, multi-resource responses, and fields where the server runs validation/automations whose outcome the UI should not preempt (e.g. task `status` — closing a task runs `assertChildrenAllClosed`/`assertNoOutstandingActivity` and triggers automations the UI can't predict). Standard `useMutation` with `onSuccess: (data) => queryClient.setQueryData(...)` seeded from the response.
- **Invalidate + refetch** — validation-heavy or long-running: AI provider verify, container lifecycle, anything where the server result depends on async work. Default `useMutation` + `invalidateQueries` in `onSuccess`.

Security-sensitive mutations (`useFulfillCredential`) MUST stay response-driven — never optimistically appear fulfilled.

Errors-only toast: `toast.error(...)` from `packages/web/src/hooks/use-toast.ts` fires automatically on `useOptimisticMutation` rollback. Successes are not toasted — the UI change itself is the confirmation. For inline form errors (validation the user should fix in place), keep the inline pattern in addition to the toast.

## Slugs vs UUIDs

Browser URLs use slugs (e.g. `/teams/test/projects/operations`). Internal IDs (DB keys, WebSocket rooms, server broadcasts) use UUIDs.

- Route params are slugs. TanStack Query keys must use the route-param slug (not a resolved UUID), so WebSocket-driven `invalidateQueries` matches.
- When a component renders inside a route, pass the **route-param value** (`teamId` / `taskId` from `Route.useParams()`) to any child component or hook whose query key includes it — not `data?.id` from a resolved query (`<CommentReactions taskId={task?.id} />` is the antipattern). Mismatched keys cause optimistic mutations to write to a different cache entry than the query reads from, so the chip/row never appears even though the server processed the mutation correctly.
- WebSocket rooms use UUIDs (`team:${uuid}`). `useWebSocket` takes both: UUID for subscription, slug for query invalidation.
- Server broadcasts use UUIDs.

Mixing the two — UUID in a query key, or slug in a room name — silently breaks realtime updates.

## UX

**All UI must be mobile-first and use a responsive layout.** No exceptions. Build the mobile layout first, then enhance for larger screens with `sm:`/`md:`/`lg:` — never the reverse. Desktop-only or fixed-width components are not acceptable.

Three breakpoints:

- **Mobile** (<768px): single-column, hamburger drawer, stacked fields, near full-screen dialogs, 16px padding.
- **Tablet** (768–1023px): team rail visible (60px), text sidebar hidden, 2-column form grids at `sm:`, centered modals, 24px padding.
- **Desktop** (1024px+): full rail + sidebar (260px), all table columns, 2–3 column grids, 32px padding.

Base Tailwind targets mobile; use `sm:`/`md:`/`lg:` to enhance. Every UI change must work at all three breakpoints, and every e2e test for a UI change must verify the mobile layout.

## Database transactions

Wrap any multi-write sequence that must succeed/fail together in `BEGIN`/`COMMIT`. Prefer transactions over `SELECT … FOR UPDATE` for read-modify-write flows.

## Security

Never expose raw secrets, private keys, or signing keys via endpoints or logs. Use asymmetric crypto for cross-service verification, encrypt sensitive data at rest, and use `timingSafeEqual` for all hash/token/signature comparisons (never `===`).

### Credentials

Agents reference secrets by **placeholder**, never by literal value. The pattern is `__HEZO_SECRET_<NAME>__` in any header or URL the agent emits; the egress proxy substitutes the real value at request time. Background and full lifecycle: `.dev/credentials.md`. Egress proxy details: `.dev/egress.md`.

When you wire a new agent integration that needs a credential:

- Don't put the real value in the agent's container env. Put the placeholder there. The real value lives in the `secrets` table with `allowed_hosts` constraining which upstream hosts the substitution may fire for.
- If the agent needs to obtain a raw secret at runtime (API key, webhook secret, …), it calls `request_credential` (MCP tool) and the human pastes the value via the task thread.
- For GitHub repo access, the human connects a GitHub OAuth account once via device flow on the team Connections page; subsequent repos pick that connection. The OAuth token is used for REST API calls only (listing orgs/repos, creating repos). Repo clone/fetch/push runs over **SSH** (`git@github.com:owner/repo.git`) authenticated by the team Ed25519 key — the same key used for commit signing. On first OAuth connect the public key is auto-registered on the connecting user's GitHub account as both a *signing* key (commits land as Verified) and an *authentication* key (so SSH git ops work). Both host-side and in-container git ops go through the existing `SshAgentServer` — host via its Unix socket directly, container via the per-run socat bridge. Full design: `.dev/oauth.md`. ssh-agent details: `.dev/ssh-signing.md`.
- For SaaS MCPs requiring OAuth (DatoCMS, Linear, …), the operator starts the auth-code flow from the MCP-connection form. The resulting `oauth_connection_id` is linked to the `mcp_connections` row; the injector emits a placeholder Authorization header and the egress proxy substitutes at request time.

The egress audit log records substitution events by **secret name** only, never the value. No-op requests (no placeholder anywhere) are not audited.

### Route authorization

Every route enforces authorization — never trust URL params alone.

- Routes with `:teamId` verify the authenticated user has access per request (board users can be in multiple teams; agent / API-key auth carries `teamId` and must match the route param).
- Nested resources (`:taskId`, `:secretId`, `:commentId`, …) verify the resource belongs to the parent `:teamId` via WHERE/JOIN before any read or write.
- Global endpoints (no `:teamId` in path) still verify the authenticated user has access to the resource's team.
- WebSocket subscriptions verify team membership matches the room.
- MCP tool handlers enforce the same authorization as their REST equivalents — pass caller identity in and validate team access.

## Implementation phases

When you complete a phase, mark it done with a completion date at the top of the phase section in `.dev/implementation-phases.md`. Keep the phase content intact. Every phase that adds backend functionality ships with UI for manual browser testing.

## Pre-v1 notes

- No backwards-compatibility concerns. Change things cleanly.
- No rate limiting yet.
