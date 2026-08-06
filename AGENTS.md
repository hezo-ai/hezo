# Agent Guidelines

**This file carries rules, not rationale, in as few words as leave them unambiguous.** No incident narratives, no "this exists because PR #N", no defence of a rejected alternative, no example that only re-illustrates the rule above it. Cut every hedge, restatement and connective carrying no constraint. Rationale goes in `.dev/architecture.md` (or another `.dev/*.md`); link to it in one clause only when the rule can't be applied without it. A rule needing a paragraph of context is two things: the rule here, the context in `.dev/`. **Edit every entry down after writing it** — if a sentence can go without losing a constraint, it goes.

## Commands

- `bun run test` — server vitest + server Bun-native (`bun test`) + web component + shared unit + Playwright, in that order.
- `--skip-browser` drops Playwright (~30s); `--browser` runs it alone.
- `--pattern <substring>` filters by file path across all tiers; `--package <server|web|shared>` restricts the vitest run; `--concurrency <n>` sets workers (default 10); `--shard <i>/<n>` runs one shard; `--bail` stops on first failure.
- `--coverage` instruments the vitest and Bun tiers. Each vitest tier writes `packages/<pkg>/coverage/coverage-final.json`; the Bun tier writes `packages/server/coverage-bun/lcov.info` (lcov only, no branch data). Composes with `--package`/`--shard`. Playwright is not instrumented.
- `bun run test:daytona` — conformance suites against a live Daytona account (`HEZO_DAYTONA_API_KEY`). Manual only: it provisions billable sandboxes and refuses to start under `CI`. `HEZO_DEEPSEEK_API_KEY` additionally enables `describeAgentCliConformance` (a real coding-CLI run against a real provider). `bun run test:live` runs every `test/live/` fixture.
- `bun run build` / `check` / `check:fix` / `typecheck` / `dev`; plus `build:compile` (host binary), `build:release` (all platforms + `SHA256SUMS`), `release`.
- **`build:*` bundle steps are `packages/server` scripts — invoke as `bun run --cwd packages/server <script>`**; there is no root alias. `build:agents`, `build:skills`, `build:teams`, `build:docs` and `build:migrations` run inside the root `bun run build`. `build:marketplace` and `build:icons` are author-run, deliberately outside `bun run build` and CI.
- `bun run build:icons` regenerates the PWA bitmaps from `packages/web/brand/icon-geometry.ts` into `packages/web/public/icons/`; needs Chromium (`bunx playwright install chromium`, or `HEZO_CHROMIUM_PATH`). Run it after editing `icon-geometry.ts` and commit the PNGs. Each `manifest.webmanifest` icon declares a **single** `purpose` (`any`, `maskable`, `monochrome`) — never a combined `"any maskable"`. The apple-touch icon is a `<link>` in `packages/web/index.html`, not a manifest entry. Keep `pwa-icons.test.ts` green rather than regenerating blind.

`scripts/test.ts` is a commander CLI: it rejects unknown flags and `--` passthrough. Narrow by test name with `test.only`/`describe.only`, reverted before commit. Never load vitest and Playwright in one process — their global `expect`s clash.

### CI structure

- CI fans `test-backend` (5 shards), `test-integration` (5, the **web** tier), `test-browser` (3, Playwright); `test-shared` is unsharded. The Bun-native tier runs on shard 1 only.
- **Required checks must name the `*-complete` rollup, never a bare matrix job** — `test-backend-complete`, `test-integration-complete`, `test-browser-complete`, `test-shared-complete` (the last is unsharded but keeps the convention). Sharding, renaming or adding a required job does three things at once: add its rollup to `.github/workflows/ci.yml`; give each matrix upload a shard-unique artifact name (`name: report-${{ matrix.shard }}`); update the `main` ruleset's required checks (`gh api repos/<org>/<repo>/rulesets` → PUT), dropping stale bare names.
- **CI must stay green on a fork PR, which runs with a read-only `GITHUB_TOKEN`** — no job may *require* a write-scoped token. `build-agent-image` computes a `published` output (`github.event_name != 'pull_request' || github.event.pull_request.head.repo.full_name == github.repository`) gating `push:` and the downstream registry login/pull. Gate any new registry write or package publish the same way, and never put a non-fork-capable job in a required check's `needs:` chain.
- `test-postgres` and `test-s3` run the external-driver legs no local `bun run test` reaches (single jobs, no rollup): `HEZO_TEST_DATABASE_URL` at a `postgres:16` service with `--package server --pattern database-` plus `bun test ./test/bun/database-pg-driver.bun.test.ts`; `HEZO_TEST_ASSET_STORAGE_URL` at MinIO with `--pattern asset-storage` plus `bun test ./test/bun/asset-s3-client.bun.test.ts`. **A change to `db/drivers/postgres.ts` or the S3 asset store is only covered once the gated leg runs** — export the env var and re-run locally.
- **Coverage merges in the `coverage-merge` job, never as a Coveralls parallel build** (coverage-v8 branch ordinals are unstable across runs, so parallel builds double-count branches). Shards upload `coverage-final.json`; `scripts/coverage/merge.ts` (`--artifacts <dir> --out coverage/lcov.info`) merges them in JSON space via `istanbul-lib-coverage` into one non-parallel build. Pure transforms live in `scripts/coverage/lcov.ts`, guarded by `coverage-lcov.test.ts`. `reconcileBunLcovLineModel` keeps only Bun `DA` rows on lines present in the merged vitest line model.

### Running one file or one test

- vitest: `cd packages/<pkg> && bunx vitest run <path>`; `-t '<substring>'` filters by name, dropping `run` watches.
- Bun-native: `cd packages/server && bun test ./test/bun/<spec>.bun.test.ts` (never under vitest).
- Playwright: `bunx playwright test test/browser/<spec>.spec.ts` from the root; `--headed --debug` to step through.

### Diagnosing failures fast

- **vitest:** the failing assertion and file:line print in the summary; re-run the one file for stack traces. For an unhelpful single line (timeouts, async), add `--reporter=verbose` or a `console.log` plus a name filter.
- **Playwright:** the trace zip lands in `playwright-report/` and `test-results/` (`retain-on-failure`). Download the `playwright-report` artifact, then `bunx playwright show-report playwright-report/`.
- **CI:** `gh run view --job=<job-id> --log 2>&1 | grep -E "✘|FAIL"`.

## Layout

- `agents/<template>/*.md` — single source of truth for agent system prompts. `blank/` (bootstrap Captain) and `_instance/` (CEO, Coach) are read by `db/seed.ts` into `agents-bundle.json`. Marketplace team dirs (those carrying a `team.json`) compile to `marketplace/teams/<slug>.json` instead, excluded from the binary. Hezo-specific tooling, file paths and conventions belong in this file, not in role docs.
- **Team marketplace** (`marketplace/`, `agents/<team>/team.json`). Prompt bodies stay in `agents/<team>/*.md`; roster and metadata (name, description, summary, `keywords`, per-role slug/reports_to/effort/budgets/role_description/summary/team_context, `changelog`) live in a hand-authored `team.json`. A marketplace team ships only roster + prompts — no bundled skills, MCP servers or MPP config.
  - **`keywords` is the discovery vocabulary** — the words someone would type when they want this team. The New Project picker ranks against them above the team's own name, so make a team findable for a new phrasing by adding the phrasing, never by teaching the matcher about that team. Author readable words and phrases, not stems (`extractTerms`/`stemTerm` in `@hezo/shared` stem both sides); be generous with variants the stemmer won't fold ("code" *and* "coding"). Keywords are excluded from the content hash, so retuning them does not bump `version`.
  - `bun run --cwd packages/server build:marketplace` regenerates the committed JSONs — run it after editing any `agents/<team>/` prompt or `team.json` (`bun run dev` does it automatically). It auto-increments `version` on a content-hash diff (excluding version/changelog/keywords); add a `changelog` entry per bump. **Commit the regenerated `marketplace/teams/*.json` + `index.json`** — production fetches them from GitHub raw, and `marketplace-build.test.ts` fails on a stale or missing file.
  - `build:teams` bundles the committed JSONs into the gitignored `teams-bundle.json`, the offline fallback only. At runtime `services/marketplace.ts` prefers the repo folder in dev (`HEZO_MARKETPLACE_DIR`), then GitHub raw (`main`, then `master`), then the bundle.
  - Only the **Blank** template is seeded into the DB. Marketplace teams are never persisted as `team_templates`/`agent_types` rows — they are provisioned directly with `agent_type_id` null. Launch from one via `POST /api/projects {marketplace_slug}`; add to an existing project via `POST /api/projects/:projectId/marketplace-team`.
- `skills/<slug>.md` — the default global skills (flat dir, filename = slug; frontmatter `name`/`description`/optional `source_url`), bundled by `build:skills` into `skills-bundle.json`. A fresh instance auto-installs the catalog on first boot (`installDefaultSkillsIfFreshInstance`, before `seedDefaultTeam`, gated on HQ not existing); an upgrading instance is **not** auto-seeded — the operator installs missing ones from the global Skills page (`GET /api/skills/defaults`, `POST /api/skills/defaults/install`). A per-slug `system_meta` marker (`default_skill_shipped_hash:<slug>`) prevents re-offering a deleted default or clobbering a user-owned same-slug skill. Keep `skills/ATTRIBUTION.md` accurate (it's excluded from the bundle). Content rules: domain-neutral where the category allows, single self-contained document, short `description`, "task" never "ticket". `default-skills.test.ts` enforces the mechanical half; domain-neutrality is on you.
- **Where guidance goes — pick by reach.**
  - `SHARED_INSTRUCTIONS` (`services/template-resolver.ts`) resolves at **runtime** and reaches **every agent on every run**, including runtime hires and every team type. Anything every agent must have goes here, never copied into each role doc. Content must be domain-neutral.
  - `agents/_partials/<group>/<name>.md` resolves at **build/load time only** (`db/resolve-partials.ts`, baked in by `build:agents`) and reaches only seeded built-in agents. Use for guidance shared by a subset of seeded roles; changing one requires re-running `build:agents`.
  - `agents/<template>/*.md` — one seeded role's own prose.
  - Decision rule: every agent incl. future hires → `SHARED_INSTRUCTIONS`; a subset of seeded roles → a partial; one role → that role's `.md`.
- `.dev/architecture.md` — the consolidated architecture reference and the home for rationale. Describe what the system **does**. Any architecture-altering change updates it in the same PR.
- `docs/` — user-facing documentation rendered at `https://hezo.ai/docs`. A change to user-visible behaviour updates the relevant page in the same PR. `docs/reference/cli.md` is hand-written; `docs/reference/mcp-api.md` is **generated** from the MCP tool registry — never hand-edit it. After touching an MCP tool, author its return shape / authorization note in `TOOL_DOC_META` (`mcp/mcp-reference.ts`) and rebuild with `bun run --cwd packages/server build:docs`.
  - The full `docs/` tree is bundled into the binary and injected into the CEO real-time chat. Each `.md` carries `title`/`order`/`section` frontmatter; `bundle-docs.ts` writes `docs-bundle.json`, `docs-bundle.ts` organises it, `template-resolver.ts` swaps it in at the `<!-- HEZO_DOCS -->` marker in `agents/_instance/ceo.md`. **Keep the marker; never copy doc prose into the role doc.** Adding/removing a page or changing frontmatter must keep `docs-bundle.test.ts` green.
- **API/route changes propagate to every agent-facing surface in the same PR.** Adding, renaming, removing or changing an MCP tool or REST route updates: (1) the docs reference — `docs/reference/cli.md`, `docs/mcp/hezo-mcp-server.md`, and the generated `docs/reference/mcp-api.md` (rebuild it; `mcp-reference.test.ts` fails if stale); (2) the SKILL.md generator (`mcp/skill-file.ts`, served at `GET /SKILL.md`); (3) `llms.txt` (`mcp/llms-txt.ts`) if the change touches the MCP endpoint, the SKILL.md pointer or the docs links. Update the generators and their tests, not a static file. SKILL.md covers the MCP surface plus a pointer to `HEZO_DOCS_URL` — not the REST API, not the docs themselves.
- **A REST route and its MCP-tool twin must be named in parallel**, wherever both expose the same resource/action. Not every route needs a tool (`routes/connectors.ts` documents a deliberate no-twin case).
  - **The resource noun is mandatory and must match on both sides** (kebab-case in the path, snake_case in the tool): `GET`/`PATCH /api/projects/:projectId/custom-prompt` ↔ `get_project_custom_prompt`/`update_project_custom_prompt`. No exceptions.
  - **The verb mapping is the default, not a law:** `GET`→`get_`/`list_`, `PATCH`/`PUT`→`update_`, `POST`→`create_`, `DELETE`→`delete_`/`remove_`. These departures are correct — do not "fix" them: `read_project_doc`/`write_project_doc`, `apply_marketplace_team`, `add_connector`/`register_connector`, `resolve_approval`, `full_text_search`. Follow the table for a new pair unless a comment says why a departure reads better.
  - Rename both sides in the same change. Only internal identifiers a route reads from (DB columns, enum values, template variables) may keep historical names.

## Keeping docs in sync with code

**Every code change ships with a docs-alignment pass in the same PR.** Find what the change touched:

- **CLI flag / subcommand / env var / port / default** (`src/cli.ts`) → `docs/reference/cli.md`, `docs/deployment/configuration.md`, the CLI table in `packages/server/README.md`, and any getting-started/deployment page showing the command.
- **MCP tool / REST route / auth / response shape** → every surface in the "API/route changes propagate" bullet above.
- **Data model, agent runtime, providers/runtimes, egress/credentials, SSH/git, OAuth/MCP, auth, build/release** → `.dev/architecture.md`.
- **Adding/changing an AI provider** (`AiProvider` + `PROVIDER_RUNTIME_ADAPTERS` in `packages/shared/src/types/common.ts`) → `.dev/architecture.md`, the provider docs, and verify the pricing table carries rates for its models (an unpriced model records $0). Decide whether it belongs in `claudeCodeProviderUsesCustomEndpoint`.
- **User-visible behaviour, a feature, or the setup/onboarding flow** → the relevant `docs/` page(s).
- **Removing a feature** → grep the whole repo and delete every stale reference (`docs/**`, `.dev/`, READMEs, comments).

**Verify, don't assume.** Generated surfaces have drift tests (`{mcp-reference,llms-txt,docs-bundle}.test.ts`); hand-written prose has one guard, `docs-terminology.test.ts`, checking punctuation only. Nothing checks whether prose is *true* — re-read the pages describing what you changed and confirm every concrete claim still matches the code.

**Two husky hooks run on every commit.** `.husky/pre-commit`: `bunx biome check --diagnostic-level=error .`, `bun run typecheck`, `bun run build`. `.husky/commit-msg`: `bunx commitlint --edit`, `scripts/check-docs-ack.ts`, `scripts/check-translations-ack.ts`.

**`Docs-Checked:` is enforced at commit time.** Any commit staging doc-bearing code (`packages/*/src/`, `packages/*/migrations/`, `agents/`, `skills/`, `docker/`, `deploy/`, `marketplace/`, `scripts/`) is rejected without a `Docs-Checked:` trailer recording the pass you did across **both** `docs/` and `.dev/`. Bare values (`yes`, `n/a`, `done`, anything under 10 characters) are rejected:

```
Docs-Checked: updated docs/reference/cli.md + configuration.md for the new --foo flag
Docs-Checked: updated .dev/architecture.md § Agent execution for the new run phase
Docs-Checked: verified docs/concepts/tasks.md and .dev/architecture.md still match; no other doc surface affected
Docs-Checked: internal refactor, no user-visible behaviour or documented surface changed
```

The trailer must be true. **Never bypass the hook with `--no-verify`.** Docs-only, test-only, merge, revert and fixup commits are exempt. Classification is tested in `docs-ack-hook.test.ts`; a new doc-bearing top-level directory goes into `DOC_BEARING_PATTERNS` in the same change.

## Project / team model (1:1)

A **project** is the primary unit and owns exactly one **team** (its agent roster), enforced by `UNIQUE(projects.team_id)`. The FK runs `projects.team_id → teams.id` but conceptually teams belong to projects. Reach a team through its project; address all project work by project slug (`/api/projects/:projectId/...`).

There is no per-team internal project. The only `is_internal` project is **HQ**, the one team with cross-project powers, hosting two singletons:

- **CEO** — all coordination. Project intake and first-run onboarding live in HQ; per-team setup and hiring live in that team's own project, CEO-actioned. On a new team the CEO's **initial** coherence pass runs first and blocks the Captain's planning task; later **reactive** coherence reviews go to that team's own Captain.
- **Coach** — reviews completed tasks across every project.

Project-teams get a Captain plus the roster's worker roles; rosters never include CEO/Coach. `POST /api/projects` (superuser) creates the team, project, planning task and initial CEO coherence task. The roster comes from the seeded Blank `team_templates` row or, with a `marketplace_slug`, straight from the marketplace catalog.

**Cross-team execution:** CEO/Coach are HQ members acting inside other teams' projects. A run is scoped to the **task's project team** (JWT, `HEZO_TEAM_ID`, MCP, skills, git, container) while the agent's system prompt loads from its **home** team (HQ). Auth validates the `heartbeat_runs` row, not team membership.

## Database migrations

Migrations are real, tracked, append-only and data-preserving. `packages/server/migrations/001_initial_schema.sql` is the frozen baseline. Never edit a shipped migration — each is checksummed and applied once, so an edit is logged as a warning and skipped on existing instances.

- **Every new migration MUST preserve existing data.** Additive or reshaping DDL carries data forward (backfill, re-encode, re-key).
- **Every new migration MUST ship a data-preservation test**, one file per migration named `packages/server/test/migrate-<NNN>-<slug>.test.ts`, using `createDataPreservationHarness()` (`test/helpers/migrate.ts`). Seed representative rows at the prior schema, apply through the real `runMigrations`, then assert **both** that pre-existing data survived **and** that the change took effect. Don't just assert "the migration ran".
- **Before creating a file, check for an unshipped migration to extend** — the first step, not a cleanup:
  ```sh
  git fetch origin main
  for f in packages/server/migrations/*.sql; do
    git cat-file -e "origin/main:$f" 2>/dev/null || echo "UNSHIPPED: $f"
  done
  ```
  Anything printed was added by this branch and applied nowhere. If one belongs to your change, put your DDL in that file and your assertions in its existing test. Only when nothing related comes back do you add a new `NNN_description.sql`. Never edit `001` or any file the loop did not print.
- **Append-only binds on *shipped*, not on *written*.** Merge sibling migrations from the same unmerged PR into one file, and their tests into one test file. Three constraints survive: keep each `NNN` distinct from anything on `main` (rebase if `main` took your number); the whole file runs in **one transaction**, so `ALTER TYPE … ADD VALUE` cannot have its new value *used* further down the same file (state predicates in terms of pre-existing values, as `049` does); and a dev instance that already applied the old version will not re-apply the edited one — reset the local data dir or you are coding against a schema that silently lacks the change.
- **Data transforms SQL can't express** (parse/re-encode/re-encrypt with app-side logic) → a code migration under `src/db/migrations/code/`, registered in that dir's `index.ts`. SQL and code migrations share one ordered `NNN_` sequence and one per-migration transaction.
- **How they apply:** the embedded backend migrates a copy (`<dataDir>/.migrate-tmp`) and atomically swaps on success, leaving live `pgdata` untouched on failure. External Postgres migrates in place — per-migration transactions under a session `pg_advisory_lock` (`applyPendingMigrationsExternal`) — so a migration must be safe to half-apply-and-roll-back alone. A data dir carrying unrecognized migrations (a downgrade) makes the server exit.
- Runner guarantees are covered by `migrate-data-preservation.test.ts`, `migrate-runner.test.ts` and `migrate-code-steps.test.ts`; the baseline by `migrate-baseline-schema.test.ts`. Per-migration tests are additive.

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDataPreservationHarness, type DataPreservationHarness } from './helpers/migrate';

const TARGET = '099_example.sql';

describe('099_example migration', () => {
  let h: DataPreservationHarness;
  let seededId: string;

  beforeAll(async () => {
    h = await createDataPreservationHarness();
    await h.applyUpToExclusive(TARGET);          // schema at N-1
    const r = await h.db.query<{ id: string }>(  // seed representative data
      `INSERT INTO teams (name, slug) VALUES ('Acme', 'acme') RETURNING id`,
    );
    seededId = r.rows[0].id;
    await h.applyTarget(TARGET);
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

**CI is the canonical check, not a local full run** — push and let CI answer. A dev box runs the suites serially against one PGlite; without a Docker daemon or with too little RAM it fails suites for reasons unrelated to the change. Iterate on a **subset** (`--pattern`, `--package`, or a single file), keep `bun run typecheck` in the loop, and reserve a full local run for a cross-suite interaction CI has already flagged.

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
- `HEZO_SKIP_DOCKER=1` swaps in the in-process fake (`services/fake-docker.ts`). **Test/CI-only — never expose it to users.** A Docker-compatible runtime is a hard prerequisite, so it must not appear in CLI/preflight output, `docs/`, README or `--help`; `docker-preflight.test.ts` guards this. Code comments and `.dev/` may reference it.

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

Root `playwright.config.ts` auto-starts server (:3101) and web (:5174). `bun run test [--browser]` builds the bundle once and serves it via `vite preview` (`HEZO_E2E_PREVIEW=1`); a raw `bunx playwright test` falls back to the Vite dev server, so one-off debugging needs no build. `authenticate(page)` bypasses the master-key gate when not testing auth. The `sharedWorkspace` fixture (`test/browser/fixtures.ts`) provisions one team per worker from the `software-development` slug, `createTeamLight` uses Blank when worker roles aren't needed, and tests create their own project via `createProjectAndClearPlanning` (`helpers.ts`). `HEZO_E2E_SKIP_COHERENCE_REVIEW=1` suppresses Captain's coherence run.

**Any test that starts the server via the CLI (`src/index.ts`) MUST pass `--no-open`** (or `HEZO_OPEN=0`) so the desktop browser auto-open never fires.

**Keep the e2e server hermetic — every outbound call is a third party voting on your test run.** `HEZO_SKIP_PRICING_REFRESH`, `HEZO_TELEMETRY_ENABLED=0` and `HEZO_SKIP_UPDATE_CHECK=1` are in the webServer env for this. **Gate any new feature that calls out from the server in that env block, in the same change** — and if it can render shell chrome, assume it will re-measure the whole suite's geometry.

### No spurious `[error]`/`[warn]` in test output

A green run should have a quiet log. If a test emits `[error]`/`[warn]` lines that aren't the test asserting on an error path, fix the source.

- **Fire-and-forget background work must be tracked.** Wrap every `xxx(...).catch((e) => log.error(...))` at a route or service boundary in `trackBackground(...)` (`lib/background.ts`); an orphaned one races teardown and produces `PGlite is closing/closed`. `safeClose` drains the tracker before closing the DB. Keep the `.catch(...)` inside the wrapper.
- **Inline docker mocks must extend `createStubDocker()`** (from `test/helpers/app.ts`), passing overrides as the argument — never a hand-rolled partial. Same for any interface: start from a complete stub.

When `app.onError` logs `Route error on ...` for an expected-failure test, the route is using a 500 where a 4xx would be honest. Catch known constraint codes locally (`isFkViolation` in `lib/sql.ts`) and return `err(c, ...)`.

### Server side effects — await vs `trackBackground`

If a side effect produces state the immediate response or the next refetch must reflect, **`await`** it in the handler. `trackBackground(...)` is for work decoupled from the request — agent wakeups, container spin-up, summary/context fan-outs, audit logs.

On `PATCH /tasks`, `recordStatusChange`/`recordTitleChange`/`recordAssigneeChange` (`services/task-events.ts`) MUST be awaited — the client's onSettled invalidation refetches comments immediately. `recordTaskLinks` lands on a different task and stays fire-and-forget, as do `createWakeup`/`wakeAgentIfAssigned`.

Wrap the awaited call in `try/catch` + `log.error(...)` — a failed side effect must not 500 the request.

### Browser test flake patterns

- **Scope every response matcher to the test's own IDs** with `taskMatcher`/`teamMatcher`/`agentMatcher` (`test/browser/helpers.ts`, keyed by `projectSlug`); a bare regex can match Captain's background planning PATCH. For tasks, `taskId` is the lowercase identifier, not the UUID.
- **For "click save → assert UI updated", use `saveAndWaitForRefetch(page, locator, { mutation, refetch })`** — mutation landing is not UI rendering.
- **Scroll Virtuoso before asserting on a bottom-of-list item:** `await page.locator('main').first().evaluate((el) => el.scrollTo({ top: el.scrollHeight }))`.
- **Sequence `page.request` after in-flight UI mutations** — it uses a separate APIRequestContext, so `await page.waitForResponse(...)` first.
- **Don't raise timeouts to mask a race** — it is almost always a missing matcher scope or a missing `await`.
- **When a geometry assertion fails only on CI, read the page-state dump before theorising.** Every browser failure prints one (`test/browser/diagnostics.ts`): viewport, `<main>`'s box and scroll metrics, siblings stacked above it, fixed/sticky elements, console and failed-request recordings. CI also prints Playwright's `error-context.md`.

## Code design

Write the second occurrence as shared code, not a copy. These are decision rules and apply to every change.

- **Two call sites means extract.** The moment the same logic — a validation rule, a format, a lookup, a request shape, a piece of UI — is needed in a second place, it moves to one home and both places call it.
- **Pick the home by reach.** Server *and* web, or a pure-logic test → `@hezo/shared`. Several server modules → `src/lib/` or `services/`. Several components → `packages/web/src/lib/` or `hooks/`. One consumer → keep it local until there is a second.
- **Validation lives once and runs twice.** A rule the client checks for inline feedback and the server enforces for real is one exported function in `@hezo/shared`, called from both.
- **Table over branch.** Behaviour varying by enum is a `Record<Enum, Descriptor>` read from, not a repeated `switch`: an unhandled value becomes a compile error and a new case becomes one row.
- **Extend the existing seam before adding a parallel one.** A new instance setting extends `routes/instance-settings.ts` and the `system-meta` helpers; new date behaviour extends `packages/web/src/lib/format-date.ts`; a new chat app implements `ChatChannelAdapter`. If the seam genuinely doesn't fit, **widen it** rather than routing around it.
- **Preserve public signatures when changing internals** — keep a shared helper's exported shape and delegate inward.
- **Generate what would otherwise be hand-synced**, and guard the remainder with a drift test.
- **Follow the idiom already in the file.** A context provider copies `lib/theme.tsx`; a settings row copies `InstanceSettingsSection`; a mutation picks one of the three documented strategies. Novel structure needs a reason beyond preference.

**Don't over-rotate.** Extract on the second *real* occurrence, not the first imagined one.

## One mechanism, no silent fallbacks

When a design names a mechanism — the container tunnel, the egress proxy, the `SandboxFiles` seam, a provider's file API — that mechanism is **the** way it is done, on every backend and in every environment. None of the following ship unless the user explicitly asked:

- **No fallback path.** If the designated mechanism fails, **fail** — loudly, with an error naming what broke and what to check (`openSandboxBackend` refusing to start rather than quietly using local Docker).
- **No rollout gate that leaves the new mechanism off.** Either it is ready and it is the only path, or it is not landed.
- **No capability branch above a seam.** A backend that can't do what the interface requires is unsupported, not a second code path. Absorb a provider's quirks inside its own adapter.
- **No "degrades to" behaviour** invented at the call site — no `?? legacyThing()`, no `if (!supported)` alternative, no retry landing somewhere else.

**When the designated mechanism genuinely cannot work somewhere, ask the user — do not decide it yourself.** State the constraint and the trade-off; the answer is often "then it is unsupported there". A deliberate exception is fine once the user has made that call, and is written down as an exception (the run CLI's model-provider credential — see **Security** § red line).

## Translations

`packages/web/src/lib/i18n/catalog/*.json` are hand-authored source files. `en.json` is the source of truth; the other eleven are written against it and reviewed like any other code.

### A string change cascades to every language

**A user-facing string is not changed until it is changed in all twelve languages.**

- **New string** → add to `en.json` and author it in all eleven non-English catalogs.
- **Reworded string** → retranslate everywhere. Nothing flags a changed English source with stale translations underneath.
- **Renamed key** → rename in all twelve. **Deleted string** → delete from all twelve.
- **New hardcoded literal in a component** → a missing catalog key, not a shortcut. Wire it through `t()`.

**A sentence containing a link or other node still goes through the catalog — use `<Trans>`, not a literal.** `t()` can't carry a `ReactNode`; `<Trans k="..." vars={{ source: <Link …/> }} />` splits the same `{name}` template and interleaves nodes, keeping the whole sentence as one entry. **Do not split a sentence into a key per fragment** — that hard-codes English word order into all twelve languages. See the `task_link`, `status_change`, `parent_change`, `run_failed` and `repo_designated` branches in `comment-renderers/system-comment.tsx`. Branches still reading a server-baked `content.text` (`title_change`, `assignee_change`, `description_change`) are not translated — localizing those means rebuilding each sentence from its structured payload first. `TASK_STATUS_LABELS` (`@hezo/shared`) is not localized, so a translated status sentence still reads its status words in English.

`i18n-catalog.test.ts` fails on a key missing from a catalog, an empty value, a value identical to its English source outside the `IDENTICAL_TO_ENGLISH_OK` allowlist, a dropped `{placeholder}`, an em/en dash, the word "ticket", a value carrying another language's script (hangul outside `ko`, kana outside `ja`), and **a key referenced nowhere in `packages/web/src/`**.

- **Adding an allowlist entry to quiet the identical-to-English check is the mistake it exists to prevent** — every entry claims the two really are the same word.
- **The unreferenced-key check has no allowlist, deliberately.** An unreferenced key almost always means the component still renders the English word inline. Wire the key up, or delete it from all twelve catalogs.
- A typo'd `t()` key is already a compile error (`MessageKey = keyof typeof en`), so `bun run typecheck` covers that direction.

The suite can't tell you whether a translation is *right*, or notice English copy that never became a key — that judgement is the pass this section asks for.

**`Translations-Checked:` is enforced at commit time.** Any commit staging `packages/web/src/` or `packages/shared/src/` is rejected without the trailer. Bare values under 10 characters are rejected:

```
Translations-Checked: added settings.locale.* to all 12 catalogs
Translations-Checked: reworded onboarding.language.subtitle; retranslated in all 11 non-English catalogs
Translations-Checked: no user-facing strings added or changed; catalogs untouched
```

The trailer must be true. **Never bypass the hook with `--no-verify`.** Server-only, test-only, docs-only, merge, revert and fixup commits are exempt. Classification is tested in `translations-ack-hook.test.ts`; a new string-bearing path goes into `STRING_BEARING_PATTERNS` in the same change.

Rules for any catalog edit:

- **Never translated:** `Hezo`, `Captain`, `CEO`, `Coach`, `HQ`, `MCP`, agent role names, marketplace team names, any CLI/command text. Role and team names must match `marketplace/teams/*.json`.
- **"task", never "ticket" — in every language.** `Aufgabe` not `Ticket`, `tâche` not `ticket`, `タスク` not `チケット`. The test only catches the English-shaped mistake.
- **The em/en dash ban applies to every language.**
- **`{placeholder}` tokens are copied verbatim.**
- **One term per concept per language** — check the existing catalog before inventing a second word.
- **Watch for repetition the English doesn't have.** Recast rather than accepting it.

**Register is a per-language decision, already made. Do not "fix" one language to match another.**

| | Address |
|---|---|
| de | formal (Sie) |
| fr | formal (vous) |
| es / it | informal (tú / tu) |
| nl | informal (je) |
| pt-BR | você |
| pl | informal 2nd person |
| sv | informal (du) — formal address is archaic there |
| zh-Hans / ja / ko | polite-neutral (您 / です・ます / 해요체) |

These are unreviewed by native speakers and deserve a native pass before a release that markets the translations.

## Type safety

No `any` in source code. Use specific types, `unknown`, `Record<string, unknown>`, or generics. If a library lacks types, install them (`@types/*`) — never fall back to `any` or `declare const`. `any` is acceptable only in test files for unpredictable JSON, and in generated files nobody hand-edits (`packages/web/src/routeTree.gen.ts` — regenerate rather than patch).

## Design for scale, reuse and contention

The reference workload is **~10 concurrent agent runs on an instance holding 1GB+ of database and asset data**, in one Bun process that is simultaneously the API, the MCP endpoint, the egress proxy, the Docker control plane and — on the default embedded backend — the database.

- **No duplicated logic.** Search `packages/shared/`, the per-package `lib/` dirs and `services/` before writing a helper. See **Code design** for picking the home.
- **Bound list endpoints in row count *and* row width.** Never return a column whose size has no ceiling (a run log, a document body) from a list route — `parsePagination` allows `per_page` up to 200. Send a size hint and serve the full value from the single-item read (`listDocumentSummaries` returns `content_length`).
- **Every read that returns a list, or content without a hard size cap, must page — and say so in its own response**, in the same change as the tool or route. Reuse `mcp/paging.ts`; there are exactly two shapes:
  - **Lists** take `limit` + an opaque `cursor` (`listPagingArgs()`) and return `{ items, next_cursor, has_more }` via `pagedList`. Query `limit + 1` so `has_more` is exact without a `COUNT(*)`, and build the predicate with `keysetPredicate` + `keysetOrderBy` so the cursor comparison and the `ORDER BY` can't drift. Keyset, not `OFFSET`.
  - **Large single content** takes `offset` + `max_bytes` and returns `{ content, offset, returned_bytes, total_bytes, next_offset, truncated }` via `windowContent`, which snaps to UTF-8 boundaries and shrinks until the result fits the tool's cap (`read_project_doc`, `get_agent_system_prompt`).

  Both carry a `paging_hint` when more remains. **A hard `LIMIT` with no cursor is the specific bug this prevents** — it drops rows silently with no way to reach them.
- **A batch tool pages too, by item index.** Return as many results as fit plus a `next_index` cursor rather than rejecting the call. Always emit at least one item so the cursor can't stall, truncating a single oversized item rather than dropping it. Register the array parameter in `MCP_BATCH_ARRAY_PARAMS` so the `result_too_large` guard can compute a concrete "retry with at most N items".
  - **Chunk to `MCP_BATCH_CHUNK_TARGET_BYTES`, not to the admission cap.** A raised `MCP_RESULT_BYTE_LIMIT_OVERRIDES` entry exists so one inherently-large resource isn't rejected; it is the wrong budget to fill when you control how many items go in.
- **A list route carries the structural fields callers reason about, not just the display ones.** If a workflow audits or traverses a relationship, the column encoding it belongs in the listing. Keep the MCP projection in step with the REST one — a field the web UI gets and agents don't is a gap, not a scoping decision.
- **Never suggest a remedy the caller cannot use.** The `result_too_large` guard builds `remedies` from the called tool's own schema (`oversizeRemedies`); keep it schema-driven when you add narrowing parameters.
- **Budget the DB round trips a request costs.** Fold repeated lookups into one query, batch or join instead of looping, memoize what is hot and rarely-changing (`MasterKeyManager.getDerivedKey`). A request whose cost grows with the rows it renders is a defect.
- **Load progressively: cheap structure first, heavy content on demand.** Return counts, order and per-item size hints up front, then fetch bodies for what the user reaches, batched (`useCommentSkeletons` + `useCommentBody`).
- **Share resources; do not multiply them per unit of work.** Prefer one pooled, refcounted, idle-released resource over one per run/request/project, keyed by what it is actually keyed on.
- **Find out why something was scoped narrowly before you widen it.** The per-run egress proxy scoping, `keepAlive: false` on the upstream agent, and `PostgresDb.txQueue` are each deliberate.
- **A new mutex is a throughput ceiling.** Say in a comment what it protects and why a narrower scope is insufficient; never hold one across IO. Know what you are queueing behind: `PostgresDb.txQueue` (every transaction, process-wide), `acquireCredentialLock`, `withProjectGitLock`, `JobManager.guarded`.
- **Stream; do not copy.** Data that can exceed a few MB is streamed end to end — never collected into an array, joined into a string, or buffered before being written or sent. Copy `streamLogicalBackupLines`, `dumpLogicalBackupToFile`, `restoreLogicalBackupFromFile`, `updater.downloadAndStage`.
- **Index the hot path, and index what the query actually asks for.** `LOWER(identifier)` won't use `(team_id, identifier)`; a JSONB expression (`payload->>'task_id'`) uses nothing. Filter-then-sort-then-limit wants a composite index in that order. Every cron or per-request query ships with its index in the same change, in a migration with a data-preservation test.
- **Filter, limit and aggregate in the query, not in the language.** Prefer keyset pagination and `has_more` over `COUNT(*)` on tables that only grow.
- **Never write a row that has not changed.** Under MVCC every no-op `UPDATE` leaves a dead tuple, and the embedded backend has no autovacuum. Guard with `IS DISTINCT FROM` or an explicit change check.
- **Every recurring job is bounded, observable, and paced to what it watches:** a `LIMIT` on every scan, a log line when a tick is skipped for overrun, a cadence matched to how fast the thing changes.
- **A cache needs an invalidation story and a bound.** State the eviction rule in a comment where you declare it: TTL, LRU cap, explicit invalidation, or lifecycle scope. Security-sensitive caches also state their clear-on-lock behaviour.
- **Coalesce on the wire and respect backpressure.** Batch high-frequency events into periodic frames, and handle a slow consumer explicitly — an ignored `send()` result is unbounded server-side buffering.
- **Deleting the user's data is the operator's decision, never a default.** Run logs, cost records and audit history may be wanted forever; a table that only grows is a query-design problem. Run-log compaction stays an explicit control on the Storage settings page — no cron may start a pass. Only internal bookkeeping with no user-facing surface may be swept automatically, and the comment must say why it qualifies.
- **Measure the claim.** A performance change states what it improved and how that was observed.

## Build artifacts

Never commit `.js`/`.d.ts`/`.js.map`/`.d.ts.map` alongside source. Compiled output lives in `dist/`. Delete generated files appearing under `packages/*/src/`.

## Conventions

- `commander` for all CLI argument parsing — never parse `process.argv` manually.
- Use shared constants/enums from `@hezo/shared` (`packages/shared/src/types/common.ts`) — no raw status/type strings. Add new enum values there first.
- `bunx`, not `npx`, in this repo's scripts, CI and docs. The rule stops at the repo boundary: inside the agent-run container `npx` is correct and is what `SHARED_INSTRUCTIONS` and the skills tell agents to use.

### Adding a container backend (Docker, Daytona, …)

One seam: `ContainerEngine` (`services/sandbox/types.ts`), implemented by `DockerClient` (`services/docker.ts`) and `DaytonaEngine` (`services/sandbox/daytona/`). Every caller above it — `agent-runner.ts`, `containers.ts`, `git-executor.ts`, `chat-session-manager.ts`, `job-manager.ts`, the process sweeper — talks only to that interface.

**Nothing above the seam may learn which backend is in use** — no provider name in a conditional, no provider-shaped field on a shared type, no "if remote". Every provider-specific fact lives in its adapter directory:

- **`sandbox/<provider>/client.ts`** — REST/SDK client and wire types, hand-rolled so the vendor dependency stays out of the single-binary build. Export the narrow port interface the engine drives (`DaytonaApi`) and have the client implement it, so tests supply a complete fake rather than a partial cast through `unknown`.
- **`sandbox/<provider>/command.ts`** — pure rendering of an exec into what the provider accepts (argv-to-string, user-switching, stream separation).
- **`sandbox/<provider>/engine.ts`** — the `ContainerEngine` implementation.

**Host-side work gets a seam method, never a call-site branch.** `ContainerEngine.prepareHost({ dataDir })` is the pattern: `DockerClient` extracts its build context, prunes bundled images, refreshes the published tag and probes mounts; `DaytonaEngine` no-ops with a comment. Reach for a new method whenever you catch yourself asking *which* backend you have; `createStubDocker` and `fake-docker.ts` must both answer it.

- **Grep the shape, not the name** — `instanceof` carries no provider name for a name-grep to find: `grep -rn "instanceof DockerClient\|instanceof DaytonaEngine\|=== SandboxBackend\.\|!== SandboxBackend\." packages/server/src packages/web/src --include=*.ts --include=*.tsx`. Hits are legitimate **only** where a provider is constructed or labelled (`sandbox/open.ts`, a display table); anything else is a bug, and a hit on the run path always is.
- **`instanceof` against the holder is always false** — callers hold the `SandboxBackendHolder.engine` proxy — so the branch doesn't just couple to a provider, it silently stops running.

**Ask what *kind* of backend it is, never which one** — a provider name in a conditional is a class property in disguise, hiding best in settings and credential plumbing where it reads as configuration. One table in `@hezo/shared`, callers asking the derived question:

```ts
export const SANDBOX_BACKEND_KIND: Record<SandboxBackend, 'local' | 'remote'> = {
    [SandboxBackend.Docker]: 'local',
    [SandboxBackend.Daytona]: 'remote',
};
export function sandboxBackendNeedsApiKey(b: SandboxBackend): boolean {
    return SANDBOX_BACKEND_KIND[b] === 'remote';
}
```

`Record<SandboxBackend, …>` makes a new backend a compile error until it declares its kind; use the *kind* rather than a bare `needsApiKey` so the next class-wide question extends the same table. Naming a provider is still fine for **which credential** (`--daytona-api-key`, the `DAYTONA_API_KEY` vault entry, `DaytonaClient`) — never for **whether one is needed**.

**Runtime-agnostic logic is shared, not reimplemented per adapter** — both engines run the identical `/proc` scan and kill scripts from `sandbox/proc-scripts.ts`, differing only in transport. Same for `sandbox/endpoints.ts`, `sandbox/files.ts` and `sandbox/handle.ts`.

**Never provision less of a resource than was asked for — refuse instead.** The per-container RAM cap is a guarantee the rest of the system is sized against. Round *up* when the provider's unit is coarser (a 1.5 GB cap asks for 2 GB, never 1); over the ceiling, throw a named error stating request, ceiling and which setting to lower (`DaytonaMemoryCapExceededError`). Same for disk and CPU.

**The backend is switchable at runtime, so nothing may capture the engine.** It comes from a stored setting (the CLI flag seeds a fresh instance only) and changes from Settings → Containers. Take `SandboxBackendHolder.engine`, never a concrete engine, and add each new `ContainerEngine` method to the holder's delegation. Switching preflights the destination, destroys every container, then swaps — never another order, never a fallback when one backend is unreachable.

**Elevation is a flag, not a username.** Docker honours a per-exec `User`; Daytona execs as root and renders non-root as `runuser -u <user> --`. State `elevated` at the call site; each adapter renders it.

**Probe the provider; don't infer from its docs.** Measure every non-obvious behaviour against the live API, and say what was measured in the comment on each workaround.

**Declare what an agent can reach from inside each backend** in `SANDBOX_AGENT_ENVIRONMENTS` (`sandbox/agent-environment.ts`): service name, where the container runs, and the egress facts in an agent's terms — what works, what doesn't, what to use instead. `buildContainerEnvironmentBlock` renders it beside `SHARED_INSTRUCTIONS`, per run. **Update the entry whenever you touch that adapter** — a new backend is a compile error until it states its egress, but a changed one isn't, so re-probe. Provider-specific facts also go on that provider's `docs/containers/**` page.

**Keep a provider's numbers in its own docs section.** `docs/containers/remote/overview.md` states each limit's *shape* generically, never a figure; `docs/containers/remote/<provider>.md` carries the numbers. The Containers settings page shows only the caveats of the backend in use — **local Docker included, a backend like any other**. A new adapter ships its docs page (linked from the overview list) and its UI branch in the same change.

**Tests: unit plus a conformance fixture.**

- **Unit, against a fake API** — command rendering (quoting, user rendering, stream handling), state mapping onto `ContainerInfo` (transitional states never reading as dead), the exec triad's exit-code propagation, each accepted degradation. Crib `sandbox-daytona-{command,engine}.test.ts`.
- **Conformance, against the real backend** — `packages/server/test/conformance/` is backend-agnostic, parameterised by a `LiveAdapterFixture`, so a new provider is a fixture rather than a second suite. Docker's (`test/bun/sandbox-conformance-docker.bun.test.ts`) runs in CI, self-skipping with a logged reason without a daemon or agent-base image; a paid provider's lives in `test/live/` and is manual. Where a backend legitimately can't answer (`diskUsedBytes` may be null by design), the fixture declares it with a flag and the suite asserts the documented alternative rather than skipping silently.

**Every suite in `conformance/` runs against every adapter** (today `engine`, `files`, `agent-cli`, `egress`, `tunnel`, `git`); write any new suite generically so existing adapters pick it up.

- **A fixture registers the set, never individual suites** — `describeContainerBackendConformance(fixture, harness)` (`conformance/index.ts`) is a backend entry point's only call, and `conformance-coverage.test.ts` asserts both directions. **A new container service adds its fixture under `test/live/` (paid, manual) or `test/bun/` (free, CI) and calls the aggregate; a new suite goes into `conformance/index.ts` in the same change.**
- **Never add a backend-specific end-to-end test.** Worth asserting against one live backend means worth asserting against all.
- `conformance/egress.ts` needs the image to carry `hezo-tunnel`, and **refuses with that reason** rather than skipping.
- **From source, agent-base builds into the local daemon's image store** — right for Docker, invisible to a registry-backed provider. `HEZO_AGENT_BASE_IMAGE=ghcr.io/hezo-ai/agent-base:<sha>` overrides it for every project that doesn't name its own, on Docker too; `assertRegistryPullableImage` refuses the local-build sentinel with a message naming the variable.
- `HEZO_CONFORMANCE_IMAGE` points at the image CI published. `build-agent-image` tags with `github.sha`, the *merge* commit on a `pull_request` — resolve with `git ls-remote origin refs/pull/<pr>/merge`, re-resolving rather than reusing a stale tag:
  ```sh
  HEZO_CONFORMANCE_IMAGE=ghcr.io/hezo-ai/agent-base:<merge-sha> \
  HEZO_DAYTONA_API_KEY=… HEZO_DEEPSEEK_API_KEY=… bun run test:daytona
  ```
- `test/live/**` is excluded from `vitest.config.ts`, and `vitest.live.config.ts` **throws if `CI` is set**. Every container the suites create carries the `hezo.conformance` label and is swept on the way in as well as out.

### Adding a chat channel adapter

External chat avenues to the CEO use a channel-adapter abstraction plus registry in `services/chat-channels/`. The manager (`chat-session-manager.ts`), the generic inbound webhook route (`routes/chat-webhooks.ts`), the conversation model and the web thread switcher are channel-agnostic — they resolve a channel only through the registry, never by branching on a platform name.

**Thread model (no mirroring).** Every conversation has exactly one home surface — a web thread, a Telegram DM, a Slack channel, a Discord channel — each its own `chat_conversations` row, and `(channel, external_thread_id, closed_at IS NULL)` is the inbound routing key (there is no bindings table).

- **One home surface per thread.** An adapter never creates threads on other channels and never re-implements cross-surface sync. Closing a thread (web ✕, or `parseClose` → `closeConversationByExternalThread`) ends it; the next inbound message on that surface starts a fresh conversation.
- **Reply-where-asked.** `finalize` calls `ChannelHooks.deliver` with the **turn's** origin channel. A web-composed turn into an external assistant thread answers on web only; an adapter's `deliver` only addresses its own platform.
- **The web view is the hub.** `listConversations` returns all kinds with `channel` + `kind`. Assistant threads stay fully interactive from web; **coworker threads are read-only in web** (`POST /api/chat/messages` 409s).
- **History capability is required for group mode.** A group-capable adapter MUST provide real channel context via `fetchThreadContext` — fetch-on-demand where the platform has a history API, or passive accumulation where it doesn't (Telegram: `observeMessage` → the bounded `chat_observed_messages` buffer, ~200/chat, topic-scoped reads). Don't ship group mode without it.

**Two integration modes**, discriminated by `chat_conversations.kind`; an adapter implements one or both:

- **Assistant/DM** (`kind='assistant'`) — a private chat with the bot is a real-time CEO thread listed in the web chatbox. Identity-allowlist gated.
- **Group/coworker** (`kind='coworker'`) — the CEO is invited into a group channel and responds to @-mentions with platform history as ephemeral context, replying in-thread. **Channel invite is the authorization** (no identity gate). Read-only in web; turns queue instead of interrupting; no compaction or auto-title.

To add a channel:

1. Add a `ChatChannel` enum value in `packages/shared/src/types/common.ts` **and** an additive `ALTER TYPE chat_channel ADD VALUE` migration with a data-preservation test.
2. Implement a `ChatChannelAdapter` (`chat-channels/<channel>.ts`): `parseInbound`, `deliver` (splitting via `splitMessageForLimit` from `chat-channels/format.ts` where the platform caps length), optional `start`/`stop`, `closeThread` + `parseClose`, `observeMessage`, `promptToLink`/`validateConfig`. Group mode is the optional trio `parseGroupMention`/`supportsGroupMode`/`fetchThreadContext` — the adapter owns the history fetch and its filtering, the core owns prompt formatting via `formatGroupContextBlock`, and a one-hop reply-quote rides on the event as `inlineContext`. Register it in `buildChatChannelRegistry`.
3. Inbound transport: webhook channels flow through the generic route, dispatching `parseGroupMention` → `parseInbound` → `parseClose` → `observeMessage`; a socket-transport adapter pushes parsed events through the `InboundEventSink` on its deps instead. DMs land in `ingestInboundEvent`, group mentions in the deliberately separate `ingestGroupMentionEvent` (`chat-channels/ingest-group.ts`) — never overload `ingestInboundEvent` with group semantics. A **true-fanout** transport (Discord's gateway) must also hold the single-instance ownership lease (`metadata.gateway_owner`, TTL-renewed from the heartbeat; stand down on loss) so two instances sharing a DB never double-answer.
4. Store all channel-specific settings in `chat_channel_configs.metadata` (jsonb) — **never add per-channel columns**. The bot token goes in the `secrets` vault and is decrypted in-process by trusted server code, NOT via the agent egress proxy. A channel needing a second secret stores its vault name in metadata (Slack: `metadata.app_token_secret` → `SLACK_APP_TOKEN`).
5. Ship the channel's unit tests (parse → event shape, mention/reply detection, close no-op safety) plus routing coverage (crib `chat-thread-routing.test.ts`) and, for a group-capable adapter, coworker-semantics coverage (crib `chat-group-ingest.test.ts`).

**Do not touch** the manager, `ingestInboundEvent`/`ingestGroupMentionEvent`, the generic webhook route, or the conversation/identity schema — if a new channel forces a change there, close the gap in the abstraction instead. Worked examples: `slack.ts` + `slack-socket.ts` (persistent transport), `discord.ts` + `discord-gateway.ts` (true-fanout + lease), `telegram.ts` (webhook + passive accumulation).

### User-facing docs terminology

These apply to user-facing prose — the `docs/` tree and anything a Hezo operator reads — and don't force renames of code identifiers, DB columns, route paths or internal comments.

- **Say "task", never "ticket".** Prefer "task" when authoring a tool description or `TOOL_DOC_META` surfacing in the generated `docs/reference/mcp-api.md` (never hand-edited).
- **Never use an em dash or an en dash. Use a hyphen.** No user-facing prose may contain `—` (U+2014) or `–` (U+2013), anywhere, for any reason. Put a plain ` - ` where an em dash would go; recast a paired parenthetical as parentheses or commas. Write numeric ranges with a hyphen (`0-100`), and use `-` for a "no value" table cell. Covers `docs/`, the READMEs, UI strings and marketing copy.
  - **`docs/`, `README.md`, `packages/server/README.md` and `packages/shared/README.md` are zero-tolerance and enforced** by `docs-terminology.test.ts` with no allowlist — do not add one. The rule still applies to operator-facing prose the guard doesn't reach (`deploy/` READMEs, UI strings, marketing copy).
  - **`docs/reference/mcp-api.md` is not exempt.** The ban reaches its sources: tool `description` strings and zod `.describe()` calls in `mcp/tools.ts`, `TOOL_DOC_META` and the generator preamble in `mcp/mcp-reference.ts`, and `mcp/onboarding.ts`. Same for `mcp/skill-file.ts` and `mcp/llms-txt.ts` — `generateSkillFile` re-emits every tool description verbatim.
  - Internal-only text is exempt: code comments, `.dev/`, and this file.
- **Say "global", never "instance-wide".**
- **The README carries no competitor-comparison section, ever** — not in `README.md`, not in `docs/`, not under a different heading ("Why Hezo", "Alternatives", "Comparison", a vs-table). Describe what Hezo does on its own terms. Standing rule, not a one-time deletion.

### Web frontend mutations

Three strategies, picked by mutation shape. Default to optimistic unless it falls into a carve-out.

- **Optimistic + rollback** — field edits, toggles, choose-option, reactions. Use `useOptimisticMutation` (`hooks/use-optimistic-mutation.ts`); `invalidateOnSettled` for sibling queries that must re-flow, `mergeResponse` to reconcile server-computed fields.
- **Response-driven** — creates, multi-resource responses, and fields where the server runs validation/automations the UI shouldn't preempt (task `status` runs `assertChildrenAllClosed`/`assertNoOutstandingActivity`). `useMutation` with `onSuccess: (data) => queryClient.setQueryData(...)`.
- **Invalidate + refetch** — validation-heavy or long-running: AI provider verify, container lifecycle, anything depending on async work.

**Security-sensitive mutations MUST never be optimistic.** A credential must not appear fulfilled until the server says it is — `useFulfillCredential` uses invalidate + refetch.

Errors-only toast: `toast.error(...)` fires automatically on `useOptimisticMutation` rollback. Successes are not toasted; the UI change is the confirmation. One carve-out: when the result lives on a **different page**, fire `toast.success(...)` with a `link`. Keep inline form errors in addition to the toast.

## Slugs vs UUIDs

Browser URLs use slugs (`/projects/operations`). Internal IDs (DB keys, WebSocket rooms, server broadcasts) use UUIDs.

- Route params are slugs. TanStack Query keys must use the route-param slug, not a resolved UUID, so WebSocket-driven `invalidateQueries` matches.
- Inside a route, pass the **route-param value** (`Route.useParams()`) to any child or hook whose query key includes it — not `data?.id` from a resolved query. Mismatched keys make optimistic mutations write to a different cache entry than the query reads.
- WebSocket rooms use UUIDs (`team:${uuid}`); `useWebSocket` takes both, UUID to subscribe and slug to invalidate. Server broadcasts use UUIDs.

Mixing the two silently breaks realtime updates.

## UX

**All UI must be mobile-first and responsive.** Build the mobile layout first, then enhance with `sm:`/`md:`/`lg:` — never the reverse. Desktop-only or fixed-width components are not acceptable.

- **Mobile** (<768px): single-column, hamburger drawer, stacked fields, near full-screen dialogs, 16px padding.
- **Tablet** (768-1023px): team rail visible (60px), text sidebar hidden, 2-column form grids at `sm:`, centered modals, 24px padding.
- **Desktop** (1024px+): full rail + sidebar (260px), all table columns, 2-3 column grids, 32px padding.

Every UI change must work at all three breakpoints, and every browser test for a UI change must verify the mobile layout.

## Database transactions

Wrap any multi-write sequence that must succeed or fail together in `BEGIN`/`COMMIT`. Prefer transactions over `SELECT … FOR UPDATE` for read-modify-write flows.

## Security

Never expose raw secrets, private keys or signing keys via endpoints or logs. Use asymmetric crypto for cross-service verification, encrypt sensitive data at rest, and use `timingSafeEqual` for all hash/token/signature comparisons (never `===`).

### Red line: no plaintext confidential data in an agent run

**A hard architectural invariant.** An agent run — container env, CLI args, config files, MCP-server descriptors, mounted files, logs, anything the agent process can read — must never contain a confidential value in plaintext. Every secret an agent touches (user-pasted credentials, `request_credential` values, OAuth tokens, MCP connector API keys, webhook secrets, signing material) is referenced only by its `__HEZO_SECRET_<NAME>__` placeholder. The real value lives encrypted in the `secrets` vault and is substituted **at the egress proxy**, at request time, scoped by `allowed_hosts`.

- **Assume the egress proxy catches everything.** A call bypassing it carries the unsubstituted placeholder and fails upstream — a usability failure, never a leak. "Fixing" that by materializing the real value into the run is a red-line violation, not a fix.
- **Sole exception — the run CLI's own AI-model-provider credential.** The API key or subscription token the coding CLI uses to reach its **model provider** (`ANTHROPIC_API_KEY`, a `claude setup-token` token) is env-injected in plaintext and sent direct (`NO_PROXY`), the provider endpoint being exempt from MITM. This is the only plaintext secret permitted inside a run, and only for that purpose. It never licenses materializing any other secret.
- **Connectors are not exempt.** OAuth-backed and API-key MCP connectors emit `Authorization: Bearer __HEZO_SECRET_<NAME>__`; the descriptor loader resolves the secret **name** and never decrypts the value. Do not reintroduce build-time token materialization.
- **Server-side code that resolves a credential must not take its destination, or any part of the value, from an agent.** A host-side helper that decrypts a secret and calls out itself (a connector probe, a token refresh, a webhook verify) runs outside the proxy entirely. Both halves matter:
  - **The destination must not be agent-influenceable.** Trace every field the destination is *derived* from back to who can write it. If an agent-writable path can move a credentialed row's destination, that path must reject the write atomically (as `add_connector` does in its `ON CONFLICT … WHERE`), not merely be trusted not to.
  - **Return nothing derived from the value.** No prefix, no length, no hash, no "masked" form. Answer the diagnostic question instead (`token_sent: boolean`), and scrub the value out of anything relayed from upstream.

### Never encourage storing the master key on a system

The master key is kept **in memory only, never written to disk** — the invariant that makes encryption-at-rest meaningful. **Never encourage a user to store it anywhere on a system**: not an env file, a persisted `HEZO_MASTER_KEY=` line, a systemd/service definition, a config file, a shell profile, a same-host secrets file, or a code comment. This holds on every surface an agent produces — `docs/**`, `.dev/`, READMEs, CLI/`--help` text, `deploy/**`, agent replies. The secure default is to unlock interactively from the web gate; coming up locked after a restart is intended behaviour, not a gap to paper over.

`HEZO_MASTER_KEY` / `--master-key` may be documented as the mechanism for a **single, non-interactive startup**, never as a place to persist the key. Treat "add your master key to the env file so reboots unlock unattended" as a security bug to fix, not a convenience to document.

### Credentials

Agents reference secrets by placeholder (`__HEZO_SECRET_<NAME>__`) in any header or URL they emit; the egress proxy substitutes at request time. Full lifecycle: `.dev/architecture.md` § Credentials, egress & secrets.

- Put the placeholder in the agent's container env, never the real value. The real value lives in `secrets` with `allowed_hosts` constraining which upstream hosts substitution may fire for.
- To obtain a raw secret at runtime the agent calls `request_credential` and a human pastes the value via the task thread. The three HTTP-auth `CredentialKind`s (`api_key`, `oauth_token`, `github_pat`) MUST pass `allowed_hosts` — the tool rejects the request otherwise. The other three (`ssh_private_key`, `webhook_secret`, `other`) are exempt, never riding an outbound HTTP header. Agents request the narrowest scope and shortest expiry, and prefer a registered connector (`register_connector`) where one covers the provider.
- For GitHub repo access, the human connects an OAuth account once via device flow on the project's Connections page. The OAuth token is for REST calls only (listing orgs/repos, creating repos); clone/fetch/push run over SSH authenticated by the project's Ed25519 key, which is also the commit-signing key. On first connect the public key is registered on the connecting user's account as both a signing and an authentication key. Host-side and in-container git both go through `SshAgentServer` — host via its Unix socket, container via the per-run socat bridge.
- For SaaS MCPs requiring OAuth, the operator starts the auth-code flow from the MCP-connection form; the resulting `oauth_connection_id` links to the `mcp_connections` row and the injector emits a placeholder Authorization header.

The egress proxy does not audit substitution events. Secret values are never logged; substitution failures surface to the agent as explicit HTTP errors.

### Route authorization

Every route enforces authorization — never trust URL params alone.

- Routes with `:projectId` resolve the project to its backing team and verify the authenticated user has access per request (an agent JWT carries `teamId` and must match). Resolution + access check run once in `requireProjectAccessMiddleware`, exposing `c.var.projectId` and `c.var.teamId`.
- **API keys authenticate the MCP surface only** — rejected on REST and the WebSocket in `authMiddleware`. An approved key is instance-scoped and admin-equivalent; `authorizeScope`/`authorizeTeam` let it act anywhere (it must name the `project` on project-scoped tools). The api-keys management routes stay human-superuser-only (`requireSuperuser`), so a key can never mint or approve keys; self-register and status polling are public token-keyed endpoints.
- Nested resources (`:taskId`, `:secretId`, `:commentId`, …) verify the resource belongs to the parent `:projectId` and its team via WHERE/JOIN before any read or write.
- Global endpoints still verify the user has access to the resource's team.
- WebSocket subscriptions verify team membership matches the room.
- MCP tool handlers enforce the same authorization as their REST equivalents.

## AI runtime hooks

Every agent run is gated by a completeness judge firing when the assistant ends its turn. It **blocks the stop** when the agent is bailing on failing tests, calling problems "out of scope", deferring without filing a sub-task or self-comment, abandoning a plan it announced in the task thread without revising it there, ending with a handoff or active @-mention never posted to the thread, marking a task done on its own review while a required approval (the admin's final approval or a named approver's sign-off, inherited across a rework or detour) was never granted, or otherwise stopping with unfinished work. A block keeps the same headless exec alive for another turn; the run-completion path (`HeartbeatRunStatus.Succeeded` on exit 0) is unchanged.

A run legitimately parked on input it can't obtain itself — an `@admin` question, a `request_credential`, a filed hire proposal or pending approval, with the task left non-terminal — is **allowed** to stop; the admin's reply or resolution auto-wakes it. Every judge short-circuits on `stop_hook_active` so a persistent verdict can't loop the same exec (command-script runtimes guard it in code, the Claude Code prompt carries the same instruction). The judge LLM runs inside the container against the team's primary-provider credential, through the normal egress path. The hook is on for every runtime exposing a block-and-continue turn-end hook, with no per-team or per-agent opt-out.

Per-runtime wiring lives in `services/mcp-injectors/<runtime>.ts`, with the judge specs in `JUDGE_SPECS`:

- **Claude Code** (Anthropic, DeepSeek, Z.ai, Kimi, plus the local runners Ollama and LM Studio): native `Stop` hook of `type: "prompt"` in a per-run `settings.json` loaded via `--settings`; Claude Code makes the judge call itself. The prompt points the judge at `last_assistant_message` in `$ARGUMENTS` and tells it to allow the stop when `stop_hook_active` is true. For every provider `claudeCodeProviderUsesCustomEndpoint` covers, the judge **tracks the run's own selected model** (`judgeModelForProvider`), falling back to `CLAUDE_CODE_JUDGE_MODEL_BY_PROVIDER` only when the run pins no model. Anthropic is excluded and always uses its cheaper Sonnet constant. The same run model overrides `CLAUDE_CODE_SUBAGENT_MODEL` for those providers (`buildProviderEnv`).
- **Codex** (OpenAI): native `Stop` hook of `type: "command"` in `config.toml` — its `type: "prompt"` is parsed-but-skipped. The command is a Node script reading StopCommandInput from stdin, calling the OpenAI Chat Completions API, and writing `{"decision":"block","reason":...}` when work is incomplete. See `buildCodexJudgeScript`.
- **Gemini** (Google): native `AfterAgent` hook (the Stop analogue). Same command-script pattern against Google's Generative AI API. See `buildGeminiJudgeScript`.
- **OpenCode** (OpenRouter, …): **no completeness judge** — its plugin API can't block-and-continue in headless `opencode run`. Runs fail-open.
- **Grok** (xAI): **no completeness judge** — Grok Build's hooks advertise `blockingEvents: ["pre_tool_use"]` only; `Stop`/`SessionEnd` are passive notifications. Runs fail-open.
- **Kimi Code**: native `Stop` hook of `type: "command"`, a flat `[[hooks]]` entry in `config.toml` under `$KIMI_CODE_HOME`. Two opt-in `JudgeRuntimeSpec` fields cover its differences: its stdin payload carries no final assistant message (`sessionLogLookup` reads it from the run's `wire.jsonl`) and no `stop_hook_active` (`loopGuardFile` writes/checks a `.hezo-stop-blocked` marker). A block is emitted on all three channels Kimi documents: exit code **2** (any other non-zero reads as a broken script and fails open), the reason on stderr, the decision JSON on stdout. **`[[hooks]]` entries accept exactly four keys** (`event`, `matcher`, `command`, `timeout`) — any other makes the CLI refuse the whole config, breaking every run on the runtime.

`STOP_HOOK_RULES` (`stop-hook-prompt.ts`) is identical across every runtime that runs the judge. Judge-model constants: `claude-sonnet-4-6` (Anthropic), `deepseek-v4-pro` (DeepSeek), `GLM-4.7` (Z.ai), `kimi-k2.7-code` (Kimi), `gpt-4o-mini` (OpenAI), `gemini-1.5-flash` (Google) — a fallback only for the custom-endpoint providers, which track the run's live-selected model. A newly selected model needs a `model_pricing` row or its runs price to $0. For the file-mount subscription providers (Codex / Gemini OAuth) the helper script has no API key and fails open silently. **Anthropic subscription is the exception** — it runs via `CLAUDE_CODE_OAUTH_TOKEN`, so the native prompt judge still fires.

**Deterministic handoff-delivery net (independent of the judge).** At run completion `agent-runner.ts` reads the final assistant message via `getFinalAssistantMessage()` and handles three stranded forms, each checked against `task_comments` with `created_by_run_id = <run>` so an agent that already posted isn't re-processed. It runs on **every** runtime, including those with no judge.

1. **An active `@`-mention** the run never posted is **delivered verbatim** as a real comment via `postAgentComment` (`comment-wakeups.ts`) — the same insert + broadcast + `fireCommentWakeups` path `create_comment` uses. Detection uses `extractMentionSlugs`, matching exactly who would be woken. Flips an otherwise no-op run to success.
2. **A name-only address that reads as an ask** — the unlinked bold/leading-line form (`detectUnlinkedTeammateAsks`) or the passive one (`detectPassiveTeammateAsks`), both run against the run team's roster + HQ + `@admin` and gated on directed-ask intent so a name written for emphasis is never touched — is **not** rewritten or auto-delivered. The runner logs the same warning `create_comment` gives interactively and leaves the handoff undelivered.
3. **A plain direct answer** to a human who addressed this agent: when the run was woken by a `WakeupSource.Reply`/`Mention` whose waking comment was authored by a human (author not in `member_agents`) and the run posted no comment of its own, the final message is delivered verbatim via `postAgentComment` threaded under the waking comment (`parentCommentId`).

OpenCode, Grok and Kimi Code take the task prompt as a CLI **argument** rather than on stdin, so the runner sets `HEZO_PROMPT_MODE=arg` (`RUNTIME_PROMPT_DELIVERY`) and the exec wrapper appends `"$(cat $HEZO_PROMPT_FILE)"`. Kimi Code additionally gets **no auto-approve flag** — `--yolo`/`--auto`/`--plan` are mutually exclusive with `--prompt`; `-p` already applies the `auto` permission policy and the injected `[permission.rules]` covers the rest.

## Cost: always priced from the table

Per-run cost is computed in `agent-stream-parser.ts` **always** from the `model_pricing` table (`price()` via `PricingService`), using the token buckets each runtime reports (regular input, cache read, cache creation, output). Runtimes' own dollar figures (`total_cost_usd` and similar) are **ignored in every parser** — they are client-side estimates from the CLI's built-in rate card, which for third-party Anthropic-compatible endpoints belongs to the wrong provider entirely. The CLIs' only job in cost accounting is accurate token counts. An unknown model prices to $0 — fail-low, never fail-high. The local providers (Ollama, LM Studio) have no pricing rows by design; $0 is correct there.

**Two runtimes report no token usage on stdout and recover it from a file in the per-run home.** `recoverOffStreamRunUsage` (`agent-runner.ts`) dispatches them and scrubs the file after parsing (each can carry the provider credential); everything downstream is identical to any other runtime.

- **Grok**: the per-run `--debug-file`. `extractGrokUsageFromDebugLog` parses `process_conversation_turn` spans for `input_tokens`/`output_tokens`/`cache_read_tokens`, keyed by `request_id` to dedup. The file also contains `XAI_API_KEY` in plaintext.
- **Kimi Code**: the per-session `wire.jsonl` under `$KIMI_CODE_HOME`. `extractKimiUsageFromSessionLog` reads `inputOther`/`output`/`inputCacheRead`/`inputCacheCreation`, deduping by request id. Two rules: session-scoped records are **cumulative totals**, so sum turn-scoped records when they exist and otherwise take the *last* session record (never the sum); and `inputOther` is already the non-cached remainder, so unlike Codex/Grok the cached portion is **not** subtracted from the input bucket. Probe field names in both camelCase and snake_case — upstream ships two engine generations with duplicated logging paths.

## Container toolset & installing packages at runtime

`docker/Dockerfile.agent-base` pre-bakes `git`, `curl`, `jq`, `unzip`, `p7zip-full` (`7z`), `file`, `python3` + `pip3`, ImageMagick, `openssh-client`, `ca-certificates`, `socat`, `sudo`, `iproute2`, Node + `npm`/`bun`, and the AI coding CLIs. **`wget` is deliberately not installed** — use `curl`. **If you add a tool here, add it to the toolset paragraph in `SHARED_INSTRUCTIONS` too**, or agents won't know it exists.

Anything not pre-baked installs cleanly at runtime: the container runs as non-root `node` with passwordless `sudo`, and `apt` plus binary/package downloads route through the per-run egress proxy with the Hezo CA already trusted via the system bundle and `NODE_EXTRA_CA_CERTS` (injected per run by `agent-runner.ts`, not baked into the image). So `sudo apt-get install -y <pkg>`, `pip3 install <pkg>` and `npm i -g <pkg>` work with no TLS special-casing. Playwright is the worked example:

```sh
mkdir -p /tmp/pw && cd /tmp/pw
npm init -y && npm install playwright
sudo npx playwright install --with-deps chromium
# Run from the same dir so require('playwright') resolves:
node test.mjs
```

Stay in the install dir for follow-up `npx playwright …` calls. Prefer `--with-deps` over a hand-curated apt list.

## Known gaps / TODOs

- **No general API rate limiting.** The REST, MCP and WebSocket surfaces are unthrottled. The one exception is password auth: `routes/auth.ts` keeps an in-memory brute-force counter (5 attempts, then a 60s lockout with exponential backoff capped at 1h, HTTP 429) on `/auth/password-verify` and the password-change path.
