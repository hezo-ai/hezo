# Agent Guidelines

## Commands

- `bun run test` — server unit/integration (vitest, Node) + server Bun-native tier (`bun test`) + web component tier (vitest) + browser (Playwright), in that order
- `bun run test --skip-browser` — drop Playwright; runs server + web vitest only (~30s)
- `bun run test --browser` — Playwright only
- `bun run test --pattern <substring>` — filter by file-path substring (works across all tiers; combine with `--browser` to narrow browser tests)
- `bun run test --package <server|web>` — restrict vitest run to one package
- `bun run test --concurrency <n>` — override worker count (default 10)
- `bun run test --shard <index>/<count>` — run one vitest shard (e.g. `1/3`); CI fans `test-backend` (2 shards) and `test-integration` (3 shards) across runners this way. The Bun-native tier runs only on shard 1. Composes with `--package`/`--concurrency`.
- `bun run test --bail` — stop on first failure
- `bun run build` / `check` / `check:fix` / `typecheck` / `dev`

`scripts/test.ts` is a commander CLI — it rejects unknown flags and `--` passthrough. To narrow by test name, use `test.only` / `describe.only` and revert before commit. Never call `npx playwright` or `npx vitest` directly (vitest's global `expect` clashes with Playwright outside the runner).

### Running one file or one test

- One vitest file: `cd packages/<pkg> && bunx vitest run <path>` (e.g. `cd packages/web && bunx vitest run test/task-comments.test.tsx`). Same flags as `bun run test`.
- Filter by test name: `bunx vitest run <path> -t '<substring>'`.
- Watch mode while iterating: drop `run` (`bunx vitest <path>`).
- One Bun-native file: `cd packages/server && bun test ./test/bun/<spec>.bun.test.ts` (must run under `bun test`, never vitest).
- One Playwright spec: `bunx playwright test test/browser/<spec>.spec.ts` from the root.
- Headed Playwright for debugging: `bunx playwright test --headed --debug test/browser/<spec>.spec.ts`.

### Diagnosing failures fast

- **vitest (server or web):** the failing assertion and its file:line print in the run summary. To re-run just the file with stack traces: `cd packages/<pkg> && bunx vitest run <path>`. Logs are inline.
- **vitest writing a single line that doesn't tell you why** (timeouts, weird async): add `--reporter=verbose`; for a single test, prepend `console.log` and re-run with the test name filter.
- **Playwright:** the trace zip lands under `playwright-report/` and `test-results/` on a failed CI run (`playwright.config.ts` is set to `retain-on-failure`). Download the `playwright-report` artifact from the GitHub Actions run, then `bunx playwright show-report playwright-report/` locally.
- **CI showing which test failed across thousands of log lines:** `gh run view --job=<job-id> --log 2>&1 | grep -E "✘|FAIL"`.

## Layout

- `agents/<template>/*.md` — single source of truth for agent system prompts. Each team template (e.g. `software-development/`, `blank/`) owns its own role docs. The seed in `packages/server/src/db/seed.ts` reads these at startup. Edit them directly. Hezo-specific tooling/file-paths/conventions belong here in AGENTS.md, not in role docs.
- **Where guidance goes — pick by *reach*.** Agent prompts compose from three layers with different audiences:
  - `SHARED_INSTRUCTIONS` (`packages/server/src/services/template-resolver.ts`) is resolved at **runtime** and appended to **every agent prompt on every run — all agents that exist now and all created in the future**, including agents hired at runtime via the Captain/hire workflow (which never pass through partial resolution). Guidance that must reach *every* agent belongs here — add it here, never by copying a directive into each role doc. It is also appended across **all team types** (software-development, marketing, research, blank, …), so its content must be domain-neutral — no software-specific role slugs or artifacts except as clearly-illustrative, generalized examples.
  - `agents/_partials/*.md` are resolved at **build/load time only** (`resolve-partials.ts`, baked into `agents-bundle.json` by `bun run build:agents`) and so only compose the **built-in agents Hezo seeds** from templates. A partial **does not reach runtime-created agents**. Use one for role-scoped guidance shared by a *subset* of the seeded built-in roles (e.g. code-quality for engineer/qa, repo rules for execution roles, captain-only workflows). Changing a partial requires `bun run build:agents`.
  - `agents/<template>/*.md` — a single seeded role's own prose.
  - Decision rule: must every agent (incl. future runtime hires) have it → `SHARED_INSTRUCTIONS`; shared by a subset of seeded roles → a `_partial`; one role → that role's `.md`.
- `.dev/architecture.md` — the single consolidated architecture reference (data model, agent runtime, AI providers/runtimes, egress/credentials, ssh/git, OAuth/MCP connectors, auth, web frontend, build/release). Keep in sync with code: describe what the system **does**, not what changed. Any change that alters the architecture updates `.dev/architecture.md` in the **same PR**.
- `docs/` — the **user-facing** documentation (sourced from this repo and rendered on the website at `https://hezo.ai/docs`). It gives the high-level view and explains features the way a Hezo *user* needs to understand them, not implementation detail. Keep it current as features change: a change that adds, removes, or alters user-visible behaviour updates the relevant `docs/` page in the **same PR**. `docs/reference/` must stay an **accurate reference** to the CLI and the Hezo MCP server's tools/API: `docs/reference/cli.md` is hand-written (update it when you add, rename, or remove a CLI flag/subcommand), and `docs/reference/mcp-api.md` is **generated** from the live MCP tool registry — never hand-edit it. When you add, rename, remove, or change an MCP tool, **rebuild the docs with `bun run build:docs`** (which runs `build-mcp-reference.ts` to regenerate the page, then re-bundles) and author the tool's return shape / authorization note in `TOOL_DOC_META` (`packages/server/src/mcp/mcp-reference.ts`), so the reference never drifts from the code.
  - **The full `docs/` tree is bundled into the binary and injected into the CEO real-time chat** so the CEO can answer setup/usage questions authoritatively. Each `.md` carries `title`/`order`/`section` frontmatter; `bundle-docs.ts` (run by `build:docs`) writes `packages/server/src/services/docs-bundle.json`, `docs-bundle.ts` organises it (`buildHezoDocsBlock`), and `template-resolver.ts` swaps it in at the `<!-- HEZO_DOCS -->` marker in `agents/_instance/ceo.md` (full docs when `embedDocs` is set — the live chat via `ceo-session-manager.ts`; a one-line `HEZO_DOCS_URL` pointer for headless CEO runs/previews). A `docs/` change therefore reaches the CEO automatically — **keep the marker, never copy doc prose into the role doc**. Adding/removing a docs page or changing its frontmatter must keep the bundle and `docs-bundle.test.ts` green.
- **API/route changes propagate to every agent-facing surface — same PR.** When you add, rename, remove, or change the behaviour, params, or response shape of an MCP tool or REST route, you MUST update *all* of the surfaces that describe it, in the same changeset: (1) the human **docs reference** — `docs/reference/cli.md`, the connection guide `docs/mcp/hezo-mcp-server.md`, and the generated full tool reference `docs/reference/mcp-api.md` (**rebuild it with `bun run build:docs`** whenever you touch an MCP tool; per-tool return/auth notes live in `TOOL_DOC_META` in `packages/server/src/mcp/mcp-reference.ts`, and `packages/server/test/mcp-reference.test.ts` fails if the committed page is stale); (2) the agent-facing **SKILL.md** manifest generator (`packages/server/src/mcp/skill-file.ts`, served at `GET /SKILL.md`) so its tool list and connect/register instructions stay exact; and (3) **`llms.txt`** (`packages/server/src/mcp/llms-txt.ts`, served at `GET /llms.txt`) *if* the change touches anything it surfaces (the MCP endpoint, the SKILL.md pointer, or the docs links). These are generated from code, so update the generator and its test (`packages/server/test/llms-txt.test.ts`), not a static file. Divergence between any of these and the actual API is a bug — agents and humans both rely on them to construct requests and parse responses. **SKILL.md is scoped to the MCP surface** — MCP endpoint/root references, agent-usable routes (`/mcp`, `/mcp/assets`, `/SKILL.md`), and the connect/register flow — plus a **pointer** to the live docs site (`HEZO_DOCS_URL`); it does **not** document the broader REST API (agents use MCP) and does **not** embed the docs themselves (those go to the CEO chat — see the `docs/` bullet above).

## Project / team model (1:1)

Hezo is **project-centric**: a **project** is the primary unit and **owns exactly one team** (its agent roster). The relationship is **1:1** — a team backs exactly one project, enforced by `UNIQUE(projects.team_id)`. In the DB the FK runs `projects.team_id → teams.id`, but conceptually "teams belong to projects." Reach a team *through* its project; all project work is addressed by **project slug** (`/api/projects/:projectId/...`).

There is **no per-team "internal" project.** The only `is_internal` project instance-wide is **HQ** (the default team), the one team with cross-project powers. HQ hosts two instance-level singletons:

- **CEO** — runs all coordination. Project **intake** and first-run **onboarding** (pre-project) live in HQ; per-team **setup/coherence review** and **hiring** live in that team's own project, CEO-actioned. On a new team the CEO's initial coherence pass runs first and **blocks** the Captain's planning task.
- **Coach** — reviews completed tickets across every project.

Project-teams get a **Captain** + the chosen template's worker roles; templates never include the CEO/Coach. **Creating a project** (`POST /api/projects`, superuser) always provisions from a team-type template (default **Blank** = Captain only) and directly creates the team, project, planning task, and the initial CEO coherence task.

**Cross-team execution (run-team split):** CEO/Coach are HQ members but act inside other teams' projects. A run is scoped to the **task's project team** (JWT, `HEZO_TEAM_ID`, MCP, skills, git, container) while the agent's **system prompt** loads from its **home** team (HQ). Instance agents also select tasks across all teams. Auth validates the `heartbeat_runs` row, not team membership, so this is legitimate. See `.dev/architecture.md` (§ Project / team / agent model).

## Database migrations

We ship **real, tracked, append-only, data-preserving migrations** — hardened and safe to deploy to production. Real instances hold real user data, so a migration that drops or corrupts it is a production incident. `packages/server/migrations/001_initial_schema.sql` is the **frozen baseline** — never edit a migration that has shipped (each is checksummed and applied exactly once; editing it only logs a warning and is skipped on existing instances). *(The baseline was collapsed to a single fresh `001` at the v1.0 launch — a one-time reset done while all deployments were reset to fresh databases; from here the append-only rule holds and `001` stays frozen.)*

- **Every new migration MUST preserve existing data.** Additive or reshaping DDL must carry data forward (backfill, re-encode, re-key) — never destroy rows a later version still needs. "No real data to preserve" is no longer true.
- **Every new migration MUST ship a data-preservation test** — one file per migration, `packages/server/test/migrate-<NNN>-<slug>.test.ts`, using `createDataPreservationHarness()` (`packages/server/test/helpers/migrate.ts`). Seed representative rows at the prior schema, apply the migration through the real `runMigrations`, then assert **both** that the pre-existing data survived **and** that the migration's schema/data change took effect. Don't just assert "the migration ran".
- **Schema change** → add a new `NNN_description.sql` (next free number) under `packages/server/migrations/`. Never edit `001` (or any released file) in place.
- **Data transform SQL can't express** (parse/re-encode/re-encrypt with app-side logic) → add a **code migration** TS module under `packages/server/src/db/migrations/code/` and register it in that dir's `index.ts`. SQL and code migrations share one ordered `NNN_` sequence and run in the same per-migration transaction.
- **How they apply:** on startup the runner migrates a *copy* of the database (`<dataDir>/.migrate-tmp`) and atomically swaps it in on success. On failure the live `pgdata` is left untouched, so downgrading to the previous binary just works. A data dir carrying migrations the binary doesn't recognize (a downgrade) makes the server **exit** and ask the operator to upgrade.
- The runner's generic guarantees (transactional BEGIN/COMMIT/ROLLBACK, sorted ordering, apply-once checksum, copy-migrate-swap) are covered by the synthetic `migrate-data-preservation.test.ts`, `migrate-runner.test.ts`, and `migrate-code-steps.test.ts`; the frozen baseline is guarded by `migrate-baseline-schema.test.ts`. Per-migration tests are additive on top.

Data-preservation test starter template:

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDataPreservationHarness, type DataPreservationHarness } from './helpers/migrate';

const TARGET = '017_example.sql'; // the migration under test

describe('017_example migration', () => {
  let h: DataPreservationHarness;
  let seededId: string;

  beforeAll(async () => {
    h = await createDataPreservationHarness();
    await h.applyUpToExclusive(TARGET);          // schema at N-1
    const r = await h.db.query<{ id: string }>(  // seed representative data
      `INSERT INTO teams (name, slug) VALUES ('Acme', 'acme') RETURNING id`,
    );
    seededId = r.rows[0].id;
    await h.applyTarget(TARGET);                  // apply the migration under test
  });
  afterAll(() => h.close());

  it('applies the change', async () => {
    const c = await h.db.query<{ c: number }>(
      `SELECT COUNT(*)::int AS c FROM information_schema.columns
       WHERE table_name = 'teams' AND column_name = 'new_col'`,
    );
    expect(c.rows[0].c).toBe(1);
  });

  it('preserves pre-existing rows', async () => {
    const kept = await h.db.query(`SELECT 1 FROM teams WHERE id = $1`, [seededId]);
    expect(kept.rows.length).toBe(1);
  });
});
```

## Testing

All changes ship with tests that exercise functionality (not "code runs without throwing"). Prefer integration over heavily-mocked unit tests. Four tiers:

| Tier | Where | Run cost | What it tests | When to use |
|---|---|---|---|---|
| Server unit/integration | `packages/server/test/**/*.test.ts` | ~ms each | API handlers, DB queries, services, MCP tools, agent run plumbing. Each test boots a fresh PGlite + Hono app via `createTestContext()`. | Everything backend. |
| Web component | `packages/web/test/**/*.test.tsx` | ~100-700ms each | React tree rendered in happy-dom against an **in-process** Hono + PGlite backend via `renderApp()` in `packages/web/test/helpers/render.tsx`. Asserts on DOM, forms, React Query refetches, navigation, mention rendering. Stubs WebSocket (`reconnecting-websocket`'s constructor checks) and `IntersectionObserver`. | Anything render-driven that doesn't depend on a real browser layout engine or WebSocket stream. ~80% of what would otherwise be a browser test. |
| Playwright browser | `test/browser/**/*.spec.ts` | ~10-30s each | Real Chromium. Mobile viewport (responsive checks at 375px), drag-drop file events, `boundingBox()` / sticky positioning, Virtuoso virtualization windows + scroll, scroll-to-bottom buttons, real `clientHeight`/`scrollHeight` comparisons, real WebSocket-streamed logs, the master-key gate flow before any token is set. | The thin slice that genuinely needs the browser. Default: write a component test instead. |
| Bun-native runtime | `packages/server/test/bun/**/*.bun.test.ts` | ~ms each | Code whose behaviour diverges between Node and Bun, exercised on the **production Bun runtime** via `bun test` (not vitest, which runs under Node). Today: the egress proxy's TLS MITM path. Imports `bun:test`; reuses the server helpers (`createTestApp`, etc.). | Anything that relies on runtime-specific `node:` API behaviour (TLS, `net`, `crypto`, `child_process`) where a Node-only test would give false confidence. |

### Server unit/integration rules

- Each test file is fully isolated via `createTestContext()` / `destroyTestContext()` (`packages/server/test/helpers/context.ts`) — fresh PGlite + Hono app + HTTP server on port 0.
- Use `ctx.app` / `ctx.baseUrl` / `ctx.port` — never a shared singleton, never hardcoded ports.
- No mutable state shared between files.
- Always `destroyTestContext()` in `afterAll` (resource leak otherwise).
- Pure logic tests (crypto, parsing) can call functions directly.
- GitHub OAuth/repo/SSH-key tests use the local simulator at `packages/server/test/helpers/github-sim.ts` — set `GITHUB_API_BASE_URL` and `GITHUB_OAUTH_BASE_URL` before the test context boots.
- `HEZO_SKIP_DOCKER=1` swaps the real `DockerClient` for the in-process fake (`services/fake-docker.ts`) so suites (and the startup Docker preflight) run without a Docker daemon. It is wired into the test harnesses (`packages/web/vitest.config.ts`, the browser specs) and is **test/CI-only**. **Never expose it to users** — Docker is a hard prerequisite, so it must not appear in user-facing output (CLI/preflight messages, `docs/`, README, `--help`) or be documented as a supported way to run Hezo. Referencing it in code comments or `.dev/architecture.md` is fine; surfacing it to operators is not.

### Bun-native runtime rules

The server runs on **Bun** in dev/prod, but vitest runs on **Node** (`bunx vitest` resolves vitest's `#!/usr/bin/env node` shebang, and the forks pool spawns Node workers). So a green vitest run says nothing about runtime-specific `node:` API behaviour under Bun — Bun's `https.Server` has no `addContext` and ignores `SNICallback`, and its TLS verifies the upstream cert against the `Host` header. Vitest can't be flipped to Bun (`bunx --bun vitest` breaks module interop — `import { z } from 'zod'` resolves to `undefined`). So runtime-sensitive code gets a Bun-native tier instead.

- Files are `packages/server/test/bun/**/*.bun.test.ts`, import from `bun:test`, and run via `bun test test/bun/`. `bun run test --package server` runs them automatically after the vitest suite; `--pattern bun` narrows to this tier.
- They are **excluded from vitest** (`vitest.config.ts` `exclude: ['test/bun/**']`) — vitest's `test/**/*.test.ts` glob would otherwise import `bun:test` and fail.
- Reuse the existing server helpers — `createTestApp`, `loadOrCreateCA`, `mintCertFromCA`, `encrypt` all import cleanly under Bun (no vitest coupling). `bun:test`'s `expect` is close to vitest's but not identical; keep assertions simple.
- Default to a normal vitest test. Reach here only when the assertion depends on `node:` runtime behaviour that differs between Node and Bun (TLS, `net`, `crypto`, `child_process`) and a Node-only test would pass while production breaks.

### Web component rules

- Read `packages/web/test/helpers/render.tsx` and `helpers/seed.ts` before writing a new spec — the harness API is `renderApp({initialPath, seed?})` returning `{ ctx, router, container, user, findByText, getByRole, ... }`. `getTestContext()` reaches the in-process app/db mid-test.
- Use `seedWorkspace()` / `seedProject(ws, { name })` / `seedTask(ws, project, { title })` / `seedComment(ws, task, body)` for setup; they drive the real API.
- Navigate via `router.navigate({ to: '/projects/$projectId/tasks', params: { projectId: ws.internalSlug } })` — memory history, no real URL.
- Each test gets a fresh PGlite + Hono in `beforeEach`. The harness clears the singleton react-query cache between tests, but cross-spec state still leaks via module-level singletons (`api`, the queryClient), so keep `beforeEach` setup contained.
- Dialogs / Radix popovers render into a portal on `document.body`. Query selectors against `document.body` (not `container`) when the element is inside a Radix `Portal`.
- Auto-wait via Testing Library's `findBy*` / `waitFor`. Don't use `expect(...).toBeDisabled()` (jest-dom matchers aren't loaded) — read `disabled` directly off the element.

### When to write Playwright vs component (decision tree)

**Default is a component test.** Component tests cost ~500ms each and exercise the same React tree + real backend as Playwright; they just skip Chromium. Before reaching for Playwright, walk this checklist for the behavior you're testing:

1. **Does the assertion depend on real CSS layout?** Anything reading `clientHeight`, `scrollHeight`, `scrollTop`, `boundingBox()`, `getComputedStyle()`, position changing on scroll, sticky/fixed positioning, line-clamp truncation. → **Playwright.** happy-dom returns 0 / unset values for these.

2. **Does the assertion depend on viewport-conditional behavior?** Anything that only renders / behaves differently at a specific viewport size — mobile drawer, hamburger menu, responsive grid switching column count, tap-target sizes. → **Playwright.** happy-dom doesn't run media queries against a real layout pass.

3. **Does the assertion need to fire native input events the test runner can't synthesize?** Drag-drop with `DataTransfer`, file input via OS picker, paste events with rich clipboard content. → **Playwright.**

4. **Does the assertion depend on Virtuoso (or any windowed list) mounting the right rows?** Asserting that a row at index N is in the DOM after a scroll, that virtualization windows shrink under load, that scroll-to-comment via URL hash moves the viewport. → **Playwright.**

5. **Does the assertion depend on a real WebSocket stream from the server?** Agent run logs, realtime broadcast invalidations. The component harness stubs WebSocket to a no-op constructor. → **Playwright.**

6. **Does the assertion depend on the master-key gate / instance setup flow before any token is set?** The harness always seeds a master key + token, so the gate is bypassed. → **Playwright.**

If **none** of 1–6 match, write a component test. That covers the long tail: form submissions, mutations, react-query refetches, navigation, mention rendering, markdown, popover/dropdown behavior, dialogs, sidebar / breadcrumb / metadata rendering, link targets, dropdown options, optimistic updates, status badges, error states.

**Concrete examples for common change types:**

| Change | Tier | Notes |
|---|---|---|
| Add a new task field + form input | Component | `seedTask`, render task page, `user.type` into the input, assert via `findByText` |
| Change how a mention renders inline | Component | Seed a comment with the mention text, render, assert on link href |
| Add a new sidebar nav link | Component | Crib from `packages/web/test/sidebar.test.tsx` |
| Add a new keyboard shortcut | Component | `user.keyboard('{Control>}{Enter}')` against the focused input |
| New mobile-only collapsed view | Playwright | `page.setViewportSize({width: 375, height: 800})` then assert |
| New drag-and-drop affordance | Playwright | Use the existing `dropFile` helper pattern in `task-comment-attachments.spec.ts` |
| Change a sticky-header behavior on scroll | Playwright | `boundingBox()` before + after `el.scrollBy(...)` |

Every existing Playwright spec has a one-line comment at the top explaining which of 1–6 keeps it there — read those before adding a new Playwright test to see if there's an existing pattern that fits.

**Component test starter template:**

```tsx
import { expect, test } from 'vitest';
import { renderApp } from './helpers/render';
import { seedWorkspace, seedProject, seedTask } from './helpers/seed';

test('<what changed>', async () => {
  let ctx: { projectSlug: string; taskIdentifier: string };
  const { findByText, user, router } = await renderApp({
    initialPath: '/',
    seed: async () => {
      const ws = await seedWorkspace();
      const project = await seedProject(ws, { name: 'Demo' });
      const task = await seedTask(ws, project, { title: 'Demo Task' });
      ctx = { projectSlug: project.slug, taskIdentifier: task.identifier };
    },
  });
  await router.navigate({
    to: '/projects/$projectId/tasks/$taskId',
    params: { projectId: ctx!.projectSlug, taskId: ctx!.taskIdentifier.toLowerCase() },
  });
  // Drive the change: user.click / user.type / etc.
  // Assert: await findByText(...) auto-waits for refetches.
});
```

`packages/web/test/task-create.test.tsx`, `task-comments.test.tsx`, and `project-crud.test.tsx` are good real-world examples to crib from.

### Playwright environment

Root `playwright.config.ts` auto-starts server (:3101) and web (:5174). Use `authenticate(page)` to bypass the master-key gate when not testing auth itself. The `sharedWorkspace` fixture in `test/browser/fixtures.ts` provisions a Startup-templated team once per worker; tests create their own per-test project under it via `createProjectAndClearPlanning`. Captain's coherence-review run is suppressed by `HEZO_E2E_SKIP_COHERENCE_REVIEW=1` in the test server env — without it, team setup blocks for ~30-60s.

### No spurious `[error]`/`[warn]` in unit-test output

A green test run should have a quiet log. If a test produces `[error]` or `[warn]` lines that are not the test itself asserting on an error path, fix the source — don't leave it as background noise. The two patterns that bite:

- **Fire-and-forget background work must be tracked.** Any `xxx(...).catch((e) => log.error(...))` left orphaned at a route or service boundary races test teardown — the DB closes under it and you get `PGlite is closing/closed` errors. Wrap every such call in `trackBackground(...)` from `packages/server/src/lib/background.ts`. `safeClose` (used by `destroyTestContext` and every test's `afterAll`) drains the tracker before closing the DB. The `.catch(...)` stays inside the wrapper so a rejection still becomes a settled promise.
- **Inline docker mocks must extend `createStubDocker()`.** Tests that build an ad-hoc `mockDocker` with only the methods they care about will trigger `TypeError: docker.containerLogs is not a function` (or similar) when production code that runs as a side-effect calls a method the stub omitted. Always go through `createStubDocker({ ... })` (exported from `packages/server/test/helpers/app.ts`) and pass the overrides as the argument — never hand-roll a partial object. The same rule applies for any other interface: start from a complete stub.

When the global `app.onError` handler logs a `Route error on ...` line for an expected-failure test, the route is using a 500 where a 4xx would be honest. Catch known constraint codes locally (see `isFkViolation` in `packages/server/src/lib/sql.ts`) and return a `4xx` with `err(c, ...)` instead of letting the error propagate.

### Server side effects — await vs `trackBackground`

If a side effect produces state that the immediate response or the next refetch from the same client must reflect, **`await`** it inside the handler. `trackBackground(...)` is for work whose completion is decoupled from the current request — agent wakeups, container spin-up, summary/context fan-outs, audit logs.

Concretely, on `PATCH /tasks` the system comments that record the change (`recordStatusChange`, `recordTitleChange`, `recordAssigneeChange` from `packages/server/src/services/task-events.ts`) MUST be awaited, because the client's onSettled invalidation triggers an immediate comments refetch that has to see the row. `recordTaskLinks` lands on a *different* task and stays fire-and-forget — the source response doesn't carry it. `createWakeup` / `wakeAgentIfAssigned` stay fire-and-forget — the agent's run is inherently async.

Wrap the awaited call in `try/catch` and `log.error(...)` to keep the "log and continue" semantics — a failed side effect should not 500 the request.

### Browser test flake patterns

The remaining Playwright suite is small but still subject to a 1 Hz agent wakeup cron and a dev-mode Vite. When a spec flakes:

- **Scope every response matcher to the test's own IDs.** Use `taskMatcher` / `teamMatcher` / `agentMatcher` from `test/browser/helpers.ts` (all keyed by `projectSlug`). A bare `/api/projects/[^/]+/tasks/[^/]+/` regex can match Captain's background planning-task PATCH and satisfy the matcher before your mutation has even left the browser. For tasks, `taskId` is the lowercase identifier, not the UUID.
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

Browser URLs use slugs (e.g. `/projects/operations`). Internal IDs (DB keys, WebSocket rooms, server broadcasts) use UUIDs.

- Route params are slugs. TanStack Query keys must use the route-param slug (not a resolved UUID), so WebSocket-driven `invalidateQueries` matches.
- When a component renders inside a route, pass the **route-param value** (`projectId` / `taskId` from `Route.useParams()`) to any child component or hook whose query key includes it — not `data?.id` from a resolved query (`<CommentReactions taskId={task?.id} />` is the antipattern). Mismatched keys cause optimistic mutations to write to a different cache entry than the query reads from, so the chip/row never appears even though the server processed the mutation correctly.
- WebSocket rooms use UUIDs (`team:${uuid}`). `useWebSocket` takes both: UUID for subscription, slug for query invalidation.
- Server broadcasts use UUIDs.

Mixing the two — UUID in a query key, or slug in a room name — silently breaks realtime updates.

## UX

**All UI must be mobile-first and use a responsive layout.** No exceptions. Build the mobile layout first, then enhance for larger screens with `sm:`/`md:`/`lg:` — never the reverse. Desktop-only or fixed-width components are not acceptable.

Three breakpoints:

- **Mobile** (<768px): single-column, hamburger drawer, stacked fields, near full-screen dialogs, 16px padding.
- **Tablet** (768–1023px): team rail visible (60px), text sidebar hidden, 2-column form grids at `sm:`, centered modals, 24px padding.
- **Desktop** (1024px+): full rail + sidebar (260px), all table columns, 2–3 column grids, 32px padding.

Base Tailwind targets mobile; use `sm:`/`md:`/`lg:` to enhance. Every UI change must work at all three breakpoints, and every browser test for a UI change must verify the mobile layout.

## Database transactions

Wrap any multi-write sequence that must succeed/fail together in `BEGIN`/`COMMIT`. Prefer transactions over `SELECT … FOR UPDATE` for read-modify-write flows.

## Security

Never expose raw secrets, private keys, or signing keys via endpoints or logs. Use asymmetric crypto for cross-service verification, encrypt sensitive data at rest, and use `timingSafeEqual` for all hash/token/signature comparisons (never `===`).

### Credentials

Agents reference secrets by **placeholder**, never by literal value. The pattern is `__HEZO_SECRET_<NAME>__` in any header or URL the agent emits; the egress proxy substitutes the real value at request time. Background and full lifecycle: `.dev/architecture.md` (§ Credentials, egress & secrets).

When you wire a new agent integration that needs a credential:

- Don't put the real value in the agent's container env. Put the placeholder there. The real value lives in the `secrets` table with `allowed_hosts` constraining which upstream hosts the substitution may fire for.
- If the agent needs to obtain a raw secret at runtime (API key, webhook secret, …), it calls `request_credential` (MCP tool) and the human pastes the value via the task thread. HTTP-auth kinds (`api_key`, `oauth_token`, `github_pat`) MUST pass `allowed_hosts` — the tool rejects the request otherwise, since an unscoped secret either can't be substituted or leaks into every host. Agents should request the narrowest scope and shortest expiry the provider offers, and prefer a registered connector (`register_connector`) when one covers the provider.
- For GitHub repo access, the human connects a GitHub OAuth account once via device flow on the project's Connections page; subsequent repos pick that connection. The OAuth token is used for REST API calls only (listing orgs/repos, creating repos). Repo clone/fetch/push runs over **SSH** (`git@github.com:owner/repo.git`) authenticated by the project's Ed25519 key — the same key used for commit signing. On first OAuth connect the public key is auto-registered on the connecting user's GitHub account as both a *signing* key (commits land as Verified) and an *authentication* key (so SSH git ops work). Both host-side and in-container git ops go through the existing `SshAgentServer` — host via its Unix socket directly, container via the per-run socat bridge. Full design: `.dev/architecture.md` (§§ OAuth, GitHub & MCP connectors; SSH signing & git).
- For SaaS MCPs requiring OAuth (DatoCMS, Linear, …), the operator starts the auth-code flow from the MCP-connection form. The resulting `oauth_connection_id` is linked to the `mcp_connections` row; the injector emits a placeholder Authorization header and the egress proxy substitutes at request time.

The egress audit log records substitution events by **secret name** only, never the value. No-op requests (no placeholder anywhere) are not audited.

### Route authorization

Every route enforces authorization — never trust URL params alone.

- Routes with `:projectId` resolve the project to its backing team and verify the authenticated user has access to that team per request (board users can be in multiple teams; an agent JWT carries `teamId` and must match the resolved team). Project resolution + access check run once in `requireProjectAccessMiddleware`, which exposes `c.var.projectId` and `c.var.teamId`.
- **API keys authenticate the MCP surface only** — they are rejected on REST (and the WebSocket) in `authMiddleware`. An approved key is instance-scoped and admin-equivalent across every project/team; `authorizeScope`/`authorizeTeam` in `mcp/tools.ts` let it act anywhere (it must name the `project` on project-scoped tools). The api-keys management routes — list/mint/approve/revoke — stay human-superuser-only (`requireSuperuser`), so a key can never mint or approve keys; self-register + status polling are public, token-keyed endpoints.
- Nested resources (`:taskId`, `:secretId`, `:commentId`, …) verify the resource belongs to the parent `:projectId` (and its team) via WHERE/JOIN before any read or write.
- Global endpoints (no `:projectId` in path) still verify the authenticated user has access to the resource's team.
- WebSocket subscriptions verify team membership matches the room.
- MCP tool handlers enforce the same authorization as their REST equivalents — pass caller identity in and validate team access.

## AI runtime hooks

Every agent run is gated by a completeness check that fires when the assistant decides to end its turn. The hook blocks the stop when the agent is bailing on failing tests, calling problems "out of scope", deferring with "leave it for later" without filing a sub-task or self-comment, or otherwise stopping with unfinished work. The block keeps the same headless exec alive for another turn — the run-completion path (`HeartbeatRunStatus.Succeeded` on exit 0) doesn't change. The hook is on for every runtime that exposes a turn-end hook (no per-team or per-agent opt-out); the sole exception is **OpenCode**, which can't enforce it (see below). The judge LLM runs inside the container against the team's existing primary-provider credential, through the same egress path as any other API call.

Per-runtime wiring lives in the per-runtime MCP injectors:

- **Claude Code** (Anthropic, DeepSeek, Z.ai per `PROVIDER_RUNTIME_ADAPTERS`): native `Stop` hook of `type: "prompt"` in a per-run `settings.json` Claude Code loads via `--settings`. Claude Code itself makes the judge sub-LLM call — no helper script needed. See `packages/server/src/services/mcp-injectors/claude-code.ts`.
- **Codex** (OpenAI): native `Stop` hook of `type: "command"` in `config.toml` (Codex's `type: "prompt"` is parsed-but-skipped, so we have to run the judge ourselves). The command is a Node script written next to the config that reads Codex's StopCommandInput JSON from stdin, calls the OpenAI Chat Completions API with the judge prompt, and writes `{"decision":"block","reason":...}` to stdout when work is incomplete. See `mcp-injectors/codex.ts` and `buildCodexJudgeScript` in `stop-hook-prompt.ts`.
- **Gemini** (Google): native `AfterAgent` hook (the analogue of Stop — fires once per turn after the model produces its final response). Same command-script pattern as Codex; calls Google's Generative AI API. See `mcp-injectors/gemini.ts` and `buildGeminiJudgeScript`.
- **Kimi** (Kimi/Moonshot): native `[[hooks]]` `event = "Stop"` command in `config.toml`. Kimi's block protocol differs — the judge exits **code 2 with the reason on stderr** (Kimi feeds stderr back to the model as a correction) rather than writing stdout JSON. Kimi's Stop stdin payload isn't documented to carry the final message, so the script probes candidate fields and fails open when none is present. See `mcp-injectors/kimi.ts` and `buildKimiJudgeScript`.
- **OpenCode** (OpenRouter, …): **no completeness judge.** OpenCode's plugin API can't block-and-continue the agent loop in headless `opencode run` — `session.idle` only fires after the loop has torn down, and a blocking `session.stopping` hook is an unmerged upstream request (sst/opencode#16626). OpenCode therefore runs with the judge omitted, the same fail-open posture used for subscription-auth runtimes. See `mcp-injectors/opencode.ts`.

The judge prompt body (`STOP_HOOK_RULES` in `stop-hook-prompt.ts`) is identical across every runtime that runs it, so changes to the rules apply everywhere. The judge models are hardcoded per provider (Sonnet for Anthropic, gpt-4o-mini for OpenAI, gemini-1.5-flash for Google, `kimi-for-coding` for Kimi) and intended to be revisited after dogfooding. For the **file-mount** subscription providers (Codex / Gemini / Kimi OAuth flows) the helper script has no API key in env and fails open — exits silently, the agent stops normally. **Anthropic subscription** is the exception: it runs via `CLAUDE_CODE_OAUTH_TOKEN` (a `claude setup-token` value injected as env), so Claude Code's native `type: "prompt"` judge still fires — there is no helper script to fail open.

OpenCode and Kimi take the task prompt as a CLI **argument** rather than on stdin (`opencode run <message>`, `kimi --prompt <text>`), so the runner sets `HEZO_PROMPT_MODE=arg` (see `RUNTIME_PROMPT_DELIVERY`) and the exec wrapper appends `"$(cat $HEZO_PROMPT_FILE)"` instead of redirecting stdin.

## Browser automation inside the container

Playwright (and any other browser-driver) installs cleanly at runtime — nothing is pre-baked. Both `apt` and the binary download route through the per-run egress proxy; the Hezo CA is already trusted via `NODE_EXTRA_CA_CERTS` and the system bundle. Do not special-case TLS.

```sh
mkdir -p /tmp/pw && cd /tmp/pw
npm init -y && npm install playwright
sudo npx playwright install --with-deps chromium
# Run from the same dir so require('playwright') resolves:
node test.mjs
```

Stay in `/tmp/pw` (or wherever you ran `npm install`) for any follow-up `npx playwright …` calls — running from a sibling directory will warn about missing deps and may fail. Prefer `--with-deps` over a hand-curated apt list; Playwright tracks its own version-pinned requirements.

## Known gaps / TODOs

- No rate limiting yet.
