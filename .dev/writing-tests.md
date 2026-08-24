# Writing tests

The contributor guide for the test estate: which tier a test belongs in, the harness each
tier gives you, and the traps in each. The rules that bind before you start - every change
ships with tests that exercise functionality, prefer integration over heavily-mocked units,
default to the cheapest tier that can observe the thing, a green run has a quiet log - are
in `AGENTS.md`; this is the how.

## The five tiers

All changes ship with tests exercising functionality, not "code runs without throwing". Prefer integration over heavily-mocked unit tests. Five tiers:

| Tier | Where | Cost | What it tests | When to use |
|---|---|---|---|---|
| Server unit/integration | `packages/server/test/**/*.test.ts` | ~ms | API handlers, DB queries, services, MCP tools, agent run plumbing. Fresh PGlite + Hono app via `createTestContext()`. | Everything backend. |
| Web component | `packages/web/test/**/*.test.{ts,tsx}` | ~100-700ms | React tree in happy-dom against an in-process Hono + PGlite backend via `renderApp()`. DOM, forms, React Query refetches, navigation, mention rendering. Stubs WebSocket and `IntersectionObserver`. | Anything render-driven not needing a real layout engine or WebSocket stream. ~80% of what would otherwise be a browser test. |
| Shared pure-logic | `packages/shared/test/**/*.test.ts` | ~ms | Pure functions in `@hezo/shared` — crypto/auth, mnemonic, mention parsing, budget/pricing math, task-progress, type guards. | The shared package's logic. |
| Playwright browser | `test/browser/**/*.spec.ts` | ~10-30s | Real Chromium. | The thin slice that genuinely needs a browser (see the decision tree). |
| Bun-native runtime | `packages/server/test/bun/**/*.bun.test.ts` | ~ms | Code diverging between Node and Bun, on the production Bun runtime. Today: egress proxy TLS MITM + streaming, docker exec/log frame transport + process sweep, node-postgres driver, S3 asset client, updater / shutdown-deadline / unlock-handoff. | Anything relying on runtime-specific `node:` behaviour (TLS, `net`, `crypto`, `child_process`). |

### Server unit/integration rules

- Each file is isolated via `createTestContext()` / `destroyTestContext()` (`test/helpers/context.ts`) — fresh PGlite + Hono app + HTTP server on port 0. Always `destroyTestContext()` in `afterAll`.
- Use `ctx.app` / `ctx.baseUrl` / `ctx.port` — never a shared singleton, never a hardcoded port. No mutable state shared between files.
- Pure logic tests can call functions directly.
- GitHub OAuth/repo/SSH-key tests use `test/helpers/github-sim.ts` — set `GITHUB_API_BASE_URL` and `GITHUB_OAUTH_BASE_URL` before the context boots.
- `HEZO_SKIP_DOCKER=1` swaps in the in-process fake (`services/fake-docker.ts`). **Test/CI-only — never expose it to users.** The supported backends are the real ones (a local Docker-compatible runtime, or a managed sandbox service), so the fake must not appear in CLI/preflight output, `docs/`, README or `--help`; `docker-preflight.test.ts` guards this. Code comments and `.dev/` may reference it.

### Test-setup performance

`createTestApp()` runs in nearly every backend/component `beforeEach`; its two dominant costs are optimized centrally — don't reintroduce them per test.

- **Migration snapshot.** `createTestDbWithMigrations()` (`test/helpers/db.ts`) migrates from scratch only on the first call per worker, then snapshots the datadir and restores every later DB from it. Migration-preservation tests use their own `runMigrations` path and are unaffected.
- **Test-only KDF cost.** `HEZO_TEST_SCRYPT_LOG_N` lowers scrypt N to `2**<log-n>` (set to `1` in `scripts/test.ts` and all three vitest configs). Read in `passwordScryptParams()` (`packages/shared/src/crypto/auth.ts`), honoured only under `NODE_ENV=test` and clamped to lower-only. A crypto test needing real cost asserts relative properties (determinism, salt/case sensitivity), never a vector pinned to N=2¹⁵.

### Bun-native runtime rules

vitest runs under Node, the server runs under Bun, and vitest can't be flipped to Bun (`bunx --bun vitest` breaks module interop) — so runtime-sensitive code gets its own tier.

- Files are `packages/server/test/bun/**/*.bun.test.ts`, import from `bun:test`, run via `bun test test/bun/`, and are excluded from vitest (`exclude: ['test/bun/**']`). `bun run test --package server` runs them after the vitest suite; `--pattern bun` narrows to this tier.
- Reuse the server helpers — `createTestApp`, `loadOrCreateCA`, `mintCertFromCA`, `encrypt` import cleanly under Bun. `bun:test`'s `expect` is close to vitest's but not identical; keep assertions simple.
- Default to a normal vitest test. Reach here only when the assertion depends on `node:` behaviour differing between Node and Bun, where a Node-only test would pass while production breaks.

### Web component rules

- Read `packages/web/test/helpers/render.tsx` and `helpers/seed.ts` first. The API is `renderApp({initialPath, seed?})` returning `{ ctx, router, container, user, findByText, getByRole, ... }`; `getTestContext()` reaches the in-process app/db mid-test.
- Set up with `seedWorkspace()` / `seedProject(ws, { name })` / `seedTask(ws, project, { title })` / `seedComment(ws, task, body)` — they drive the real API.
- Navigate via `router.navigate({ to: '/projects/$projectId/tasks', params: { projectId: ws.internalSlug } })`.
- Each test gets a fresh PGlite + Hono in `beforeEach`, but module-level singletons (`api`, the queryClient) still leak across specs — keep setup contained.
- Radix dialogs/popovers render into a portal — query `document.body`, not `container`.
- Auto-wait with `findBy*` / `waitFor`. jest-dom matchers aren't loaded, so read `disabled` off the element rather than `expect(...).toBeDisabled()`.

### When to write Playwright vs component

**Default is a component test.** Reach for Playwright only when one of these matches:

1. **Real CSS layout** — `clientHeight`, `scrollHeight`, `scrollTop`, `boundingBox()`, `getComputedStyle()`, position changing on scroll, sticky/fixed positioning, line-clamp truncation. happy-dom returns 0/unset.
2. **Viewport-conditional behaviour** — mobile drawer, hamburger menu, responsive grid, tap-target sizes. happy-dom doesn't run media queries against a layout pass.
3. **Native input events the runner can't synthesize** — drag-drop with `DataTransfer`, file input, rich-clipboard paste.
4. **Virtuoso (or any windowed list) mounting the right rows** after a scroll.
5. **A real WebSocket stream from the server** — run logs, realtime broadcast invalidations. The component harness stubs WebSocket.
6. **The master-key gate / instance setup flow before any token is set.** The harness always seeds a key + token.

If none match, write a component test: form submissions, mutations, refetches, navigation, mention rendering, markdown, popovers, dialogs, sidebar/breadcrumb/metadata rendering, link targets, optimistic updates, status badges, error states.

| Change | Tier | Notes |
|---|---|---|
| New task field + form input | Component | `seedTask`, render, `user.type`, assert via `findByText` |
| How a mention renders inline | Component | Seed a comment, render, assert on link href |
| New sidebar nav link | Component | Crib `project-sidebar.test.tsx` / `sidebar-nav-branches.test.tsx` |
| New keyboard shortcut | Component | `user.keyboard('{Control>}{Enter}')` |
| Mobile-only collapsed view | Playwright | `page.setViewportSize({width: 375, height: 800})` |
| Drag-and-drop affordance | Playwright | `dropFile` pattern in `task-comment-attachments.spec.ts` |
| Sticky-header behaviour on scroll | Playwright | `boundingBox()` before + after `el.scrollBy(...)` |

**Every Playwright spec carries a top-of-file comment naming which of 1-6 keeps it there** (or the other genuinely browser-only reason, as `connector-activation.spec.ts` does for its cross-origin redirect chain). Write one for any spec you add. Crib a new component test from `task-create.test.tsx`, `task-comments.test.tsx` or `project-crud.test.tsx`.

### Playwright environment

Root `playwright.config.ts` auto-starts server (:3101) and web (:5174). `bun run test [--browser]` builds the bundle once and serves it via `vite preview` (`HEZO_E2E_PREVIEW=1`); a raw `bunx playwright test` falls back to the Vite dev server, so one-off debugging needs no build. `authenticate(page)` bypasses the master-key gate when not testing auth. The `sharedWorkspace` fixture (`test/browser/fixtures.ts`) provisions one team per worker from the `app-dev` slug, `createTeamLight` uses Blank when worker roles aren't needed, and tests create their own project via `createProjectAndClearPlanning` (`helpers.ts`). `HEZO_E2E_SKIP_COHERENCE_REVIEW=1` suppresses Captain's coherence run.

**Any test that starts the server via the CLI (`src/index.ts`) MUST pass `--no-open`** (or `HEZO_OPEN=0`) so the desktop browser auto-open never fires.

**Keep the e2e server hermetic — every outbound call is a third party voting on your test run.** `HEZO_SKIP_PRICING_REFRESH`, `HEZO_TELEMETRY_ENABLED=0` and `HEZO_SKIP_UPDATE_CHECK=1` are in the webServer env for this. **Gate any new feature that calls out from the server in that env block, in the same change** — and if it can render shell chrome, assume it will re-measure the whole suite's geometry.

### No spurious `[error]`/`[warn]` in test output

A green run should have a quiet log. If a test emits `[error]`/`[warn]` lines that aren't the test asserting on an error path, fix the source.

- **Fire-and-forget background work must be tracked.** Wrap every `xxx(...).catch((e) => log.error(...))` at a route or service boundary in `trackBackground(...)` (`lib/background.ts`); an orphaned one races teardown and produces `PGlite is closing/closed`. `safeClose` drains the tracker before closing the DB. Keep the `.catch(...)` inside the wrapper.
- **Inline docker mocks must extend `createStubDocker()`** (from `test/helpers/app.ts`), passing overrides as the argument — never a hand-rolled partial. Same for any interface: start from a complete stub.

When `app.onError` logs `Route error on ...` for an expected-failure test, the route is using a 500 where a 4xx would be honest. Catch known constraint codes locally (`isFkViolation` in `lib/sql.ts`) and return `err(c, ...)`.

### Server side effects — await vs `trackBackground`

If a side effect produces state the immediate response or the next refetch must reflect, **`await`** it in the handler. `trackBackground(...)` is for work decoupled from the request — agent wakeups, container spin-up, summary/context fan-outs, audit logs.

On `PATCH /tasks`, `recordStatusChange`/`recordTitleChange`/`recordAssigneeChange` (`services/task-events.ts`) MUST be awaited — the client's onSettled invalidation refetches comments immediately. `recordTaskLinks` lands on a different task and stays fire-and-forget. `createWakeup`/`wakeAgentIfAssigned` are the documented exception to the fire-and-forget half: a wakeup created **inside an agent run** is awaited, because that run's own no-wake exit check reads it back before the run ends.

Wrap the awaited call in `try/catch` + `log.error(...)` — a failed side effect must not 500 the request.

### Browser test flake patterns

- **Scope every response matcher to the test's own IDs** with `taskMatcher`/`teamMatcher`/`agentMatcher` (`test/browser/helpers.ts`, keyed by `projectSlug`); a bare regex can match Captain's background planning PATCH. For tasks, `taskId` is the lowercase identifier, not the UUID.
- **For "click save → assert UI updated", use `saveAndWaitForRefetch(page, locator, { mutation, refetch })`** — mutation landing is not UI rendering.
- **Scroll Virtuoso before asserting on a bottom-of-list item:** `await page.locator('main').first().evaluate((el) => el.scrollTo({ top: el.scrollHeight }))`.
- **Sequence `page.request` after in-flight UI mutations** — it uses a separate APIRequestContext, so `await page.waitForResponse(...)` first.
- **Don't raise timeouts to mask a race** — it is almost always a missing matcher scope or a missing `await`.
- **When a geometry assertion fails only on CI, read the page-state dump before theorising.** Every browser failure prints one (`test/browser/diagnostics.ts`): viewport, `<main>`'s box and scroll metrics, siblings stacked above it, fixed/sticky elements, console and failed-request recordings. CI also prints Playwright's `error-context.md`.

