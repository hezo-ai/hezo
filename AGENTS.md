# Agent Guidelines

## Commands

- `bun run test` — server unit/integration (vitest, Node) + server Bun-native tier (`bun test`) + web component tier (vitest) + shared pure-logic unit tier (vitest) + browser (Playwright), in that order
- `bun run test --skip-browser` — drop Playwright; runs server, web, and shared vitest only (~30s)
- `bun run test --browser` — Playwright only
- `bun run test --pattern <substring>` — filter by file-path substring (works across all tiers; combine with `--browser` to narrow browser tests)
- `bun run test --package <server|web|shared>` — restrict vitest run to one package
- `bun run test --concurrency <n>` — override worker count (default 10)
- `bun run test --shard <index>/<count>` — run one shard (e.g. `1/3`); CI fans `test-backend` (5 shards), `test-integration` (5 shards), and `test-browser` (3 shards — Playwright, via `--browser --shard`) across runners this way; the pure-logic `shared` package runs unsharded as a single `test-shared` job. The Bun-native tier runs only on shard 1. Composes with `--package`/`--concurrency`.
- **A sharded (matrix) CI job can't be a required status check directly — gate branch protection on its `*-complete` rollup, never the bare job name.** A matrix job reports as `test-browser (1)`, `test-browser (2)`, … — there is *no* check named `test-browser`, so a branch-protection rule pinned to the bare name hangs forever on "Expected — waiting for status to be reported" and blocks every PR. Each sharded job therefore has a tiny aggregate job that `needs:` the matrix and is green only when all shards passed: `test-backend-complete`, `test-integration-complete`, `test-browser-complete`. The `main` ruleset's required status checks must list those `*-complete` names. **When you shard a new job, rename a job, or add a required job, do all of: (1) add/keep its `*-complete` rollup in `.github/workflows/ci.yml`; (2) give each matrix upload a shard-unique artifact name (`name: report-${{ matrix.shard }}`) so the parallel uploads don't collide; (3) update the `main` ruleset's required status checks (`gh api repos/<org>/<repo>/rulesets` → PUT) to require the `*-complete` name and drop any stale bare name — in the same change.**
- **CI must stay green on a pull request from a fork, which runs with a read-only `GITHUB_TOKEN`.** No job may *require* a write-scoped token to pass: a `packages: write` request is silently not granted on a fork PR, so anything pushing to GHCR is denied ("installation not allowed to Write organization package"). `build-agent-image` therefore computes a `published` output (`github.event_name != 'pull_request' || github.event.pull_request.head.repo.full_name == github.repository`), passes it to `build-push-action`'s `push:`, and `test-backend` gates its registry login + `docker pull` on that output — so a fork PR still builds the image (Dockerfile stays under test) and still runs the whole backend tier, with only the three `*-docker.test.ts` container suites self-skipping (logged as a run notice, never silently). **When you add a job that writes to a registry, publishes a package, or otherwise needs a write-scoped token, make the write conditional the same way and never let a non-fork-capable job sit in a required check's `needs:` chain** — a hard `needs:` on it turns one denied push into a skipped tier and a failed `*-complete` rollup, i.e. an unmergeable fork PR.
- `bun run test:daytona` — the backend-conformance suites against a **live Daytona account** (`HEZO_DAYTONA_API_KEY=...`). Manual only: it provisions billable sandboxes, is excluded from the default vitest run, and its config refuses to start under `CI`. Without a key it skips with a reason. `bun run test:live` runs every fixture under `test/live/`. Adding a **second, independent** key `HEZO_DEEPSEEK_API_KEY=...` turns on `describeAgentCliConformance` — a real coding-CLI run inside the provisioned sandbox, against the real provider. The two keys buy different answers: the Daytona key proves the *sandbox* works, the model key proves an *agent* can run in it (the image really carries the CLI, the sandbox reaches the endpoint, the exec transport carries a long streaming stdout intact, the prompt arrives on the channel the runtime expects, and the CLI reports token buckets the pricing table can charge against). The invocation is assembled from the production tables (`PROVIDER_RUNTIME_ADAPTERS`, `RUNTIME_COMMANDS`, the arg tables) so it cannot drift from how the runner actually invokes a CLI, and a second provider is a fixture field rather than a second suite. The Docker fixture takes the same key, so this is not a Daytona-only assertion.
- `bun run test --bail` — stop on first failure
- `bun run test --coverage` — instrument the vitest (server, web, and shared) and Bun-native tiers with V8 coverage; each vitest tier writes an istanbul `coverage-final.json` to `packages/<pkg>/coverage`, and the Bun tier writes `packages/server/coverage-bun/lcov.info` (lcov only, no branch data). Off by default so normal runs stay fast. Composes with `--package`/`--shard`. **Coveralls scores this repo on lines + branches combined**, so branch measurement has to survive sharding. A full local run (unsharded) prints the combined line+branch total and writes `coverage/lcov.info`; in CI each shard uploads its `coverage-final.json` as an artifact and the `coverage-merge` job combines them (see below). Playwright is not yet instrumented.
  - **Why the merge job, not a Coveralls parallel build.** Line coverage (`DA`, keyed by absolute line number) merges cleanly across shards, but coverage-v8 assigns each branch a synthetic `(block, branch)` ordinal that is **not stable across separate runs**. Uploading each shard's lcov as its own parallel build made Coveralls count the same source branch under different identities — inflating the branch denominator (~19.5k real branches were reported as ~36k) and pushing the combined total ~6 points below its true value (it read 88% when the real figure was ~94%). The fix (`scripts/coverage/`): merge the shards' `coverage-final.json` in **JSON space** (`istanbul-lib-coverage`, branches keyed by AST source location) into one coverage map per package, emit one lcov, and upload that as a single (non-parallel) Coveralls build. Branch identities are then assigned once, deterministically, from the merged map. `scripts/coverage/lcov.ts` holds the pure transforms (`mergeCoverageJsonToLcov`, `normalizeLcov` → repo-root-relative `packages/<pkg>/src/…` scoped to `src/`, `reconcileBunLcovLineModel`, `combinedCoverageStats`); `scripts/coverage/merge.ts` is the CLI CI runs (`--artifacts <dir> --out coverage/lcov.info`) and the function the local run calls. Guarded by `packages/server/test/coverage-lcov.test.ts`.
  - **The Bun reconcile.** `bun test --coverage` counts every line of a loaded file as executable (comments, blank lines, type-only lines) and reports them as missed in files its specs merely load, which would depress the total. `reconcileBunLcovLineModel` keeps only Bun `DA` rows on lines present in the **merged** vitest line model (files only the Bun tier loads pass through unchanged) — now reconciled against all shards at once, in the merge job, not against a single shard.
- `bun run build` / `check` / `check:fix` / `typecheck` / `dev`
- `bun run build:icons` — regenerate the PWA icon bitmaps from `packages/web/brand/icon-geometry.ts` into `packages/web/public/icons/`. **Author-run with committed output**, like `build:marketplace`; it needs a Chromium binary (`bunx playwright install chromium`, or point `HEZO_CHROMIUM_PATH` at an existing build) so it is deliberately **not** part of `bun run build`, `bun run dev`, or CI. Run it after editing `icon-geometry.ts` and commit the PNGs. The manifest declares four variants (`any`, `maskable`, `monochrome`, plus the apple-touch icon) with a **single** `purpose` each — a combined `"any maskable"` claims one bitmap serves two jobs and is what produced a clipped, white-banded icon on Android. `packages/web/test/pwa-icons.test.ts` decodes the committed PNGs and fails on truncation, a missing safe zone, or a transparent apple-touch icon; keep it green rather than regenerating blind.

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

- `agents/<template>/*.md` — single source of truth for agent system prompts. `blank/` (the bootstrap Captain) and `_instance/` (CEO, Coach) are read by the binary seed (`packages/server/src/db/seed.ts`) at startup and bundled into `agents-bundle.json`. Every **marketplace team** dir (one carrying a `team.json` manifest, e.g. `software-development/`) is instead compiled into a committed `marketplace/teams/<slug>.json` and served from the marketplace — its prompt bodies are **excluded from the binary** (see the marketplace bullet). Edit the `.md` directly. Hezo-specific tooling/file-paths/conventions belong here in AGENTS.md, not in role docs.
- **Team marketplace** (`marketplace/`, `agents/<team>/team.json`) — the default team templates ship from a **marketplace** (a folder in this repo), not baked into the binary, so a running instance can pick up improved default teams from GitHub without a binary upgrade. A team's prompt bodies stay authored as `agents/<team>/*.md`; its structured roster + team metadata (name, description, summary, `keywords`, per-role slug/reports_to/effort/budgets/role_description/summary/team_context, `changelog`) live in a hand-authored `agents/<team>/team.json` manifest. A marketplace team ships **only** its roster + prompts — no bundled skills, MCP servers, or MPP config (those are configured per project). The **build compiles** these into one self-contained, **committed** `marketplace/teams/<slug>.json` (metadata + full roster incl. each agent's partial-resolved `system_prompt` with `{{…}}` intact) plus `marketplace/index.json`:
  - **`keywords`** is the team's discovery vocabulary — the words and short phrases someone would type when they want this team ("website", "saas", "todo list"). The New Project picker ranks against them (highest weight, above the team's own name), so **recall is data, not code**: make a team findable for a new phrasing by adding the phrasing to its manifest, never by teaching the matcher about that team. Keywords are deliberately **excluded from the content hash**, so retuning them does **not** bump the team's `version` and does not trigger the roster reconcile on instances already running it; the picker reads the live catalog, so they take effect on the next fetch anyway. Author readable words/phrases, not stems — stemming is the matcher's job (`extractTerms`/`stemTerm` in `@hezo/shared`, applied to both sides). Be generous with variants the crude stemmer won't fold together ("code" *and* "coding").
  - `bun run --cwd packages/server build:marketplace` regenerates the committed JSONs (run it after editing any `agents/<team>/` prompt or `team.json`; `bun run dev` runs it automatically). It **auto-increments** a team's integer `version` when its content changed vs the committed file (content-hash diff, excluding version/changelog/keywords); a changelog note per version is **optional but recommended** — add `{ "version": N, "notes": "what changed" }` to the manifest's `changelog` for each bump (the build prints a reminder when a bump has no note). **Commit the regenerated `marketplace/teams/*.json` + `index.json`** — production fetches them from GitHub raw; `marketplace-build.test.ts` fails if they are stale.
  - `build:teams` (in `scripts/build.ts`) bundles the committed JSONs into the gitignored, embedded `teams-bundle.json` — the **offline fallback** only. At runtime the loader (`services/marketplace.ts`) prefers the live catalog: the repo folder in dev (`HEZO_MARKETPLACE_DIR`), else GitHub raw on `main`, else the embedded bundle.
  - Only the **Blank** template is still seeded into the DB; marketplace teams are **never** persisted as `team_templates`/`agent_types` rows — they are provisioned directly (roster members with `agent_type_id` null, like hires). Launch a project from one via `POST /api/projects {marketplace_slug}`; add one to an existing project via `POST /api/projects/:projectId/marketplace-team` (kicks off a CEO task that hires + reconciles, updating existing roles in place when it's a version update). See `.dev/architecture.md` (§ Team marketplace).
- `skills/<slug>.md` — single source of truth for the **default global skills** Hezo ships (flat dir, filename = slug; frontmatter `name`/`description`/optional `source_url`). Bundled into the binary by `bun run build:skills` (`skills-bundle.json`, same embed pattern as agents/docs). A **fresh instance** auto-installs the whole catalog on first boot (`installDefaultSkillsIfFreshInstance`, called from `startup.ts` before `seedDefaultTeam`, gated on HQ not yet existing); an **existing instance upgrading is not auto-seeded** — the operator installs the missing ones from the global Skills page behind a confirmation (`GET /api/skills/defaults` + `POST /api/skills/defaults/install`; `listMissingDefaultSkills`/`installDefaultSkills` in `db/default-skills.ts`). A per-slug `system_meta` marker (`default_skill_shipped_hash:<slug>`) records "installed here" so a deleted default is never re-offered and a user-owned same-slug skill is never clobbered. `skills/ATTRIBUTION.md` tracks upstream sources/licenses for the adapted skills (several come from MIT/Apache-2.0 collections — keep it accurate when adding or replacing skills; it's excluded from the bundle). Content rules: domain-neutral where the category allows (global skills reach every team type), single self-contained document, short manifest-friendly `description`, "task" never "ticket" (`default-skills.test.ts` enforces the catalog invariants).
- **Where guidance goes — pick by *reach*.** Agent prompts compose from three layers with different audiences:
  - `SHARED_INSTRUCTIONS` (`packages/server/src/services/template-resolver.ts`) is resolved at **runtime** and appended to **every agent prompt on every run — all agents that exist now and all created in the future**, including agents hired at runtime via the Captain/hire workflow (which never pass through partial resolution). Guidance that must reach *every* agent belongs here — add it here, never by copying a directive into each role doc. It is also appended across **all team types** (software-development, marketing, research, blank, …), so its content must be domain-neutral — no software-specific role slugs or artifacts except as clearly-illustrative, generalized examples.
  - `agents/_partials/*.md` are resolved at **build/load time only** (`resolve-partials.ts`, baked into `agents-bundle.json` by `bun run build:agents`) and so only compose the **built-in agents Hezo seeds** from templates. A partial **does not reach runtime-created agents**. Use one for role-scoped guidance shared by a *subset* of the seeded built-in roles (e.g. code-quality for engineer/qa, repo rules for execution roles, captain-only workflows). Changing a partial requires `bun run build:agents`.
  - `agents/<template>/*.md` — a single seeded role's own prose.
  - Decision rule: must every agent (incl. future runtime hires) have it → `SHARED_INSTRUCTIONS`; shared by a subset of seeded roles → a `_partial`; one role → that role's `.md`.
- `.dev/architecture.md` — the single consolidated architecture reference (data model, agent runtime, AI providers/runtimes, egress/credentials, ssh/git, OAuth/connectors, auth, web frontend, build/release). Keep in sync with code: describe what the system **does**, not what changed. Any change that alters the architecture updates `.dev/architecture.md` in the **same PR**.
- `docs/` — the **user-facing** documentation (sourced from this repo and rendered on the website at `https://hezo.ai/docs`). It gives the high-level view and explains features the way a Hezo *user* needs to understand them, not implementation detail. Keep it current as features change: a change that adds, removes, or alters user-visible behaviour updates the relevant `docs/` page in the **same PR**. `docs/reference/` must stay an **accurate reference** to the CLI and the Hezo MCP server's tools/API: `docs/reference/cli.md` is hand-written (update it when you add, rename, or remove a CLI flag/subcommand), and `docs/reference/mcp-api.md` is **generated** from the live MCP tool registry — never hand-edit it. When you add, rename, remove, or change an MCP tool, **rebuild the docs with `bun run build:docs`** (which runs `build-mcp-reference.ts` to regenerate the page, then re-bundles) and author the tool's return shape / authorization note in `TOOL_DOC_META` (`packages/server/src/mcp/mcp-reference.ts`), so the reference never drifts from the code.
  - **The full `docs/` tree is bundled into the binary and injected into the CEO real-time chat** so the CEO can answer setup/usage questions authoritatively. Each `.md` carries `title`/`order`/`section` frontmatter; `bundle-docs.ts` (run by `build:docs`) writes `packages/server/src/services/docs-bundle.json`, `docs-bundle.ts` organises it (`buildHezoDocsBlock`), and `template-resolver.ts` swaps it in at the `<!-- HEZO_DOCS -->` marker in `agents/_instance/ceo.md` (full docs when `embedDocs` is set — the live chat via `ceo-session-manager.ts`; a one-line `HEZO_DOCS_URL` pointer for headless CEO runs/previews). A `docs/` change therefore reaches the CEO automatically — **keep the marker, never copy doc prose into the role doc**. Adding/removing a docs page or changing its frontmatter must keep the bundle and `docs-bundle.test.ts` green.
- **API/route changes propagate to every agent-facing surface — same PR.** When you add, rename, remove, or change the behaviour, params, or response shape of an MCP tool or REST route, you MUST update *all* of the surfaces that describe it, in the same changeset: (1) the human **docs reference** — `docs/reference/cli.md`, the connection guide `docs/mcp/hezo-mcp-server.md`, and the generated full tool reference `docs/reference/mcp-api.md` (**rebuild it with `bun run build:docs`** whenever you touch an MCP tool; per-tool return/auth notes live in `TOOL_DOC_META` in `packages/server/src/mcp/mcp-reference.ts`, and `packages/server/test/mcp-reference.test.ts` fails if the committed page is stale); (2) the agent-facing **SKILL.md** manifest generator (`packages/server/src/mcp/skill-file.ts`, served at `GET /SKILL.md`) so its tool list and connect/register instructions stay exact; and (3) **`llms.txt`** (`packages/server/src/mcp/llms-txt.ts`, served at `GET /llms.txt`) *if* the change touches anything it surfaces (the MCP endpoint, the SKILL.md pointer, or the docs links). These are generated from code, so update the generator and its test (`packages/server/test/llms-txt.test.ts`), not a static file. Divergence between any of these and the actual API is a bug — agents and humans both rely on them to construct requests and parse responses. **SKILL.md is scoped to the MCP surface** — MCP endpoint/root references, agent-usable routes (`/mcp`, `/mcp/assets`, `/SKILL.md`), and the connect/register flow — plus a **pointer** to the live docs site (`HEZO_DOCS_URL`); it does **not** document the broader REST API (agents use MCP) and does **not** embed the docs themselves (those go to the CEO chat — see the `docs/` bullet above).
- **REST routes and their MCP-tool equivalents must be named in parallel — for every route.** When a REST route and an MCP tool expose the **same resource/action**, their names must correspond: the resource noun matches on both sides (kebab-case in the REST path, snake_case in the tool name) and the HTTP verb maps to the tool verb (`GET`→`get_`/`list_`, `PATCH`/`PUT`→`update_`, `POST`→`create_`, `DELETE`→`delete_`/`remove_`). For example the project Custom Prompt is `GET`/`PATCH /api/projects/:projectId/custom-prompt` ↔ `get_project_custom_prompt` / `update_project_custom_prompt` — **not** one surface called "preferences" and the other "custom prompt". When you add or rename either side, rename the other in the **same change** so the two stay in lockstep. Only the **internal identifiers a route reads from** — DB columns, `DocumentType`/enum values, template variables like `{{team_preferences_context}}` — are exempt and may keep their historical names; the user-facing route and tool names must match.

## Keeping docs in sync with code (check on every code change)

Docs are part of the contract, not an afterthought. **Every code change ships with a docs-alignment pass in the same PR** — code and docs drift silently otherwise, and agents and humans both build requests from these surfaces. Before a change is done, find what it touched in this map and update the matching docs:

- **CLI flag / subcommand / env var / port / default** (source of truth: `packages/server/src/cli.ts`) → `docs/reference/cli.md`, `docs/deployment/configuration.md`, the CLI table in `packages/server/README.md`, and any getting-started/deployment page that shows the command.
- **MCP tool / REST route / auth / response shape** → every agent-facing surface in the **"API/route changes propagate"** bullet above (rebuild with `bun run build:docs`, plus the `SKILL.md` and `llms.txt` generators).
- **Data model, agent runtime, providers/runtimes, egress/credentials, SSH/git, OAuth/MCP, auth, build/release** → `.dev/architecture.md` (describe what the system *does*).
- **Adding/changing an AI provider** (`AiProvider` enum + `PROVIDER_RUNTIME_ADAPTERS`) → besides `.dev/architecture.md` and the provider docs, verify the pricing table carries sane rates for the provider's models (runs price **only** from the table — see **Cost: always priced from the table** below); an unpriced model records $0.
- **User-visible behaviour, a feature, or the setup/onboarding flow** → the relevant `docs/` page(s) (concepts / security / deployment / getting-started / ai-models); a `docs/` edit reaches the CEO chat automatically via the bundle.
- **Removing a feature** → grep the whole repo for stale references and delete them everywhere (`docs/**`, `.dev/`, READMEs, code comments) — a removed feature still named in a doc is a bug.

**Verify, don't assume.** The *generated* surfaces have drift tests that fail on mismatch — `packages/server/test/{mcp-reference,llms-txt,docs-bundle}.test.ts` (run them after any tool/route/docs change). Hand-written prose has exactly one automated guard, `packages/server/test/docs-terminology.test.ts`, and it only checks punctuation (the em/en dash ban below) across `docs/**` and the READMEs. Nothing checks whether the prose is *true*, so re-read the page(s) describing the area you changed and confirm every concrete claim — flags, defaults, ports, type/enum names, file paths, behaviours — still matches the code you just wrote.

**The acknowledgment is enforced at commit time.** The `commit-msg` hook (`.husky/commit-msg` → `scripts/check-docs-ack.ts`) rejects any commit that stages doc-bearing code — anything under `packages/*/src/`, `packages/*/migrations/`, `agents/`, `skills/`, `docker/`, `deploy/`, `marketplace/`, or `scripts/` — unless the commit message carries a **`Docs-Checked:` trailer** recording the docs-alignment pass you actually did. The pass covers **both audiences**: the user-facing `docs/` tree **and** the internal `.dev/` docs — an architecture-altering change must update `.dev/architecture.md` in the same PR, and the trailer is the record that you checked it. Write what you checked, not a rubber stamp — bare values (`yes`, `n/a`, `done`, anything under 10 characters) are rejected:

```
Docs-Checked: updated docs/reference/cli.md + configuration.md for the new --foo flag
Docs-Checked: updated .dev/architecture.md § Agent execution for the new run phase
Docs-Checked: verified docs/concepts/tasks.md and .dev/architecture.md still match; no other doc surface affected
Docs-Checked: internal refactor, no user-visible behaviour or documented surface changed
```

The trailer must be true — it is the audit record that the pass in this section happened. Never write it without doing the pass, and **never bypass the hook with `--no-verify`**. Docs-only, test-only, merge, revert, and fixup commits are exempt (no trailer needed). The hook's classification rules are unit-tested in `packages/server/test/docs-ack-hook.test.ts`; if you add a new doc-bearing top-level directory, add it to `DOC_BEARING_PATTERNS` in `scripts/check-docs-ack.ts` in the same change.

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
- **Schema change → check for an unshipped migration to extend BEFORE creating a file.** This is the first step, not a cleanup afterwards. Run
  ```sh
  git fetch origin main
  for f in packages/server/migrations/*.sql; do
    git cat-file -e "origin/main:$f" 2>/dev/null || echo "UNSHIPPED: $f"
  done
  ```
  Anything printed is a migration **this branch added** that has been applied nowhere. If one of them belongs to the same change you are making, **put your DDL in that file** - extend its `CREATE TABLE`, extend its backfill `SELECT`, add an `ALTER` at its end - and add your assertions to that migration's existing test file. Only when nothing comes back, or nothing that comes back is related, do you add a new `NNN_description.sql` (next free number). Never edit `001` or any file the loop did **not** print - those have shipped.
- **Append-only binds on *shipped*, not on *written*.** A migration that has been released - it exists on `main` and could have been applied to a real instance - is frozen forever. A migration added by the branch you are still working on has been applied nowhere, so it is ordinary unmerged code: keep editing it, and **merge sibling migrations from the same unmerged PR into one** rather than stacking `NNN`, `NNN+1`, `NNN+2` for what is one change. Two migrations in one PR is a smell, not a requirement - it leaves the released history longer than the change actually was, and it presents a reviewer with a two-step reshaping of a table that never existed in the intermediate shape. Merge their data-preservation tests into that migration's one test file too. The moment the PR merges, the usual rule takes over. Three things survive the merge: keep each `NNN` distinct from anything on `main` (rebase if `main` took your number); remember the whole file runs in **one transaction** - so `ALTER TYPE … ADD VALUE` still cannot have its new value *used* further down the same file (state a predicate in terms of pre-existing values, as `049` does); and **a dev instance that already applied the old version of the file will not re-apply the edited one** (it is checksummed and apply-once, so the edit is logged as a warning and skipped) - reset the local data dir, or the schema you are coding against silently lacks the change.
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

All changes ship with tests that exercise functionality (not "code runs without throwing"). Prefer integration over heavily-mocked unit tests. Five tiers:

| Tier | Where | Run cost | What it tests | When to use |
|---|---|---|---|---|
| Server unit/integration | `packages/server/test/**/*.test.ts` | ~ms each | API handlers, DB queries, services, MCP tools, agent run plumbing. Each test boots a fresh PGlite + Hono app via `createTestContext()`. | Everything backend. |
| Web component | `packages/web/test/**/*.test.tsx` | ~100-700ms each | React tree rendered in happy-dom against an **in-process** Hono + PGlite backend via `renderApp()` in `packages/web/test/helpers/render.tsx`. Asserts on DOM, forms, React Query refetches, navigation, mention rendering. Stubs WebSocket (`reconnecting-websocket`'s constructor checks) and `IntersectionObserver`. | Anything render-driven that doesn't depend on a real browser layout engine or WebSocket stream. ~80% of what would otherwise be a browser test. |
| Shared pure-logic unit | `packages/shared/test/**/*.test.ts` | ~ms each | Pure functions in `@hezo/shared` (crypto/auth, mnemonic, mention parsing, budget/pricing math, task-progress, enum/type guards) — no DB, no DOM, plain Node via vitest. Counted in the Coveralls total alongside server/web. | The shared package's logic. |
| Playwright browser | `test/browser/**/*.spec.ts` | ~10-30s each | Real Chromium. Mobile viewport (responsive checks at 375px), drag-drop file events, `boundingBox()` / sticky positioning, Virtuoso virtualization windows + scroll, scroll-to-bottom buttons, real `clientHeight`/`scrollHeight` comparisons, real WebSocket-streamed logs, the master-key gate flow before any token is set. | The thin slice that genuinely needs the browser. Default: write a component test instead. |
| Bun-native runtime | `packages/server/test/bun/**/*.bun.test.ts` | ~ms each | Code whose behaviour diverges between Node and Bun, exercised on the **production Bun runtime** via `bun test` (not vitest, which runs under Node). Today: the egress proxy's TLS MITM path, the docker exec/log stream transport, and the S3 asset client (SigV4 over the runtime's own `fetch`/`crypto.subtle`). Imports `bun:test`; reuses the server helpers (`createTestApp`, etc.). | Anything that relies on runtime-specific `node:` API behaviour (TLS, `net`, `crypto`, `child_process`) where a Node-only test would give false confidence. |

### Server unit/integration rules

- Each test file is fully isolated via `createTestContext()` / `destroyTestContext()` (`packages/server/test/helpers/context.ts`) — fresh PGlite + Hono app + HTTP server on port 0.
- Use `ctx.app` / `ctx.baseUrl` / `ctx.port` — never a shared singleton, never hardcoded ports.
- No mutable state shared between files.
- Always `destroyTestContext()` in `afterAll` (resource leak otherwise).
- Pure logic tests (crypto, parsing) can call functions directly.
- GitHub OAuth/repo/SSH-key tests use the local simulator at `packages/server/test/helpers/github-sim.ts` — set `GITHUB_API_BASE_URL` and `GITHUB_OAUTH_BASE_URL` before the test context boots.
- `HEZO_SKIP_DOCKER=1` swaps the real `DockerClient` for the in-process fake (`services/fake-docker.ts`) so suites (and the startup Docker preflight) run without a Docker daemon. It is wired into the test harnesses (`packages/web/vitest.config.ts`, the browser specs) and is **test/CI-only**. **Never expose it to users** — Docker is a hard prerequisite, so it must not appear in user-facing output (CLI/preflight messages, `docs/`, README, `--help`) or be documented as a supported way to run Hezo. Referencing it in code comments or `.dev/architecture.md` is fine; surfacing it to operators is not.

### Test-setup performance (shared across all vitest/Bun tiers)

`createTestApp()` runs in effectively every backend/component test's `beforeEach`, so its two dominant costs are optimized once, centrally — don't reintroduce them per test:

- **Migration snapshot.** `createTestDbWithMigrations()` (`packages/server/test/helpers/db.ts`) migrates a fresh PGlite from scratch only on the *first* call per worker process, then snapshots the datadir and restores every later DB from it (`dumpDataDir`/`loadDataDir`). Restoring skips Postgres `initdb` + the migration replay (~1066ms → ~470ms) and is byte-identical to a fresh migration. Migration-preservation tests use their own `runMigrations` path (`helpers/migrate.ts`) and are unaffected.
- **Test-only KDF cost.** The password verifier every `createTestApp` enrolls derives via scrypt; at the production cost (N=2¹⁵) that is ~280ms per test. `HEZO_TEST_SCRYPT_LOG_N` lowers N to `2**<log-n>` (set to `1` in `scripts/test.ts` for all tiers incl. Bun-native, and in both vitest configs for direct single-file runs). It is read in `passwordScryptParams()` (`packages/shared/src/crypto/auth.ts`), **honoured only under `NODE_ENV=test` and clamped to lower-only**, so it can never weaken production and never raises cost. Salt stays randomized; enrollment and login both go through `derivePasswordKeyPair`, so they read the same N and stay in lockstep. A crypto test that needs the real cost should assert relative properties (determinism, salt/case sensitivity), not a known-answer vector pinned to N=2¹⁵.

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

Root `playwright.config.ts` auto-starts server (:3101) and web (:5174). The web frontend is served two ways: `bun run test [--browser]` builds the bundle once and serves it via `vite preview` (the runner sets `HEZO_E2E_PREVIEW=1`), because two on-demand-transforming Vite dev servers saturate a 2-core CI runner and starve the backend until task fetches time out; a raw `bunx playwright test` (no runner, no prebuilt `dist`) falls back to the Vite dev server so one-off local debugging needs no build step. Use `authenticate(page)` to bypass the master-key gate when not testing auth itself. The `sharedWorkspace` fixture in `test/browser/fixtures.ts` provisions a Startup-templated team once per worker; tests create their own per-test project under it via `createProjectAndClearPlanning`. Captain's coherence-review run is suppressed by `HEZO_E2E_SKIP_COHERENCE_REVIEW=1` in the test server env — without it, team setup blocks for ~30-60s. **Any test that starts the server via the CLI (`src/index.ts`) MUST pass `--no-open`** (or set `HEZO_OPEN=0`) so the desktop browser auto-open never fires — it's skipped in CI/containers/SSH/headless already, but on a local macOS/Windows run it pops a browser tab mid-test. Both the `playwright.config.ts` webServer and the `master-key-gate` spec's self-spawned server pass it.

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
- **Keep the e2e server hermetic — every outbound call it makes is a third party voting on your test run.** `playwright.config.ts`'s webServer env exists mostly for this: `HEZO_SKIP_PRICING_REFRESH`, `HEZO_TELEMETRY_ENABLED=0`, `HEZO_SKIP_UPDATE_CHECK=1`. The last one is the cautionary tale. `routes/updates.ts` asks GitHub for the latest release, and if it is newer than this working tree the `UpdateBanner` renders **between the app header and the content row** - so `<main>` and everything in it moves down 47px (75px at mobile, where the banner stacks). The day `0.39.0` shipped, five specs that have nothing to do with updates went red: `project-menu-collapse` read `Expected: <= 1, Received: 47`, and the sticky specs saw their frame of reference move mid-test when the poll resolved. It presented as flake because unauthenticated GitHub rate-limiting made it shard-dependent. **When you add a feature that calls out from the server, gate it in that env block in the same change** - and if it renders shell chrome, assume it will silently re-measure the whole suite.
- **When a geometry assertion fails only on CI, read the page-state dump before theorising.** Every browser failure prints one into the job log (`test/browser/diagnostics.ts`, an auto fixture): viewport, `<main>`'s box and scroll metrics, every sibling stacked above it, every fixed/sticky element, and the console/failed-request recording. It named the update banner on its first CI run after two sessions of guessing. CI also prints Playwright's `error-context.md` for specs that drive their own `test`.

## Code design

Write the second occurrence as shared code, not a copy. These are decision rules, not style preferences, and they apply to every change — not just new features.

- **Two call sites means extract.** The moment the same logic — a validation rule, a format, a lookup, a request shape, a piece of UI — is needed in a second place, it moves to one home and both places call it. Copy-paste-and-tweak is the failure mode this exists to prevent: the copies drift, and the bug gets fixed in one of them.
- **Pick the home by reach**, the same way agent guidance does (see the *Where guidance goes* bullet in **Layout**). Needed by server *and* web, or by a pure-logic test → `@hezo/shared`. Several server modules → `packages/server/src/lib/` or `services/`. Several components → `packages/web/src/lib/` or `hooks/`. One consumer → keep it local until there is a second.
- **Validation lives once and runs twice.** A rule the client checks for inline feedback and the server enforces for real is **one** exported function in `@hezo/shared`, called from both. Two hand-written copies of one rule will disagree, and the client's copy is the one that silently gets stale.
- **Table over branch.** When behaviour varies by an enum, express it as a `Record<Enum, Descriptor>` and read from it — don't repeat a `switch`/`if` chain at each call site, which duplicates the same decision N times. The `Record<Enum, …>` makes an unhandled enum value a compile error and makes a new case one row.
- **Extend the existing seam before adding a parallel one.** A new instance setting extends `routes/instance-settings.ts` and the `system-meta` helpers; new date behaviour extends `packages/web/src/lib/format-date.ts`; a new chat app implements `ChatChannelAdapter`. A second stack doing an existing stack's job is how a codebase ends up with two of everything. If the existing seam genuinely doesn't fit, **widen it** rather than routing around it.
- **Preserve public signatures when changing internals.** When a shared helper's behaviour grows, keep its exported shape and delegate inward, so its consumers don't churn.
- **Generate what would otherwise be hand-synced**, and guard the remainder with a drift test (the `marketplace/`, `docs/reference/mcp-api.md`, and `llms.txt` surfaces all work this way). Anything a human must remember to update in two places eventually gets updated in one.
- **Follow the idiom already in the file.** A React context provider copies `lib/theme.tsx`; a settings row copies `InstanceSettingsSection`; a mutation picks one of the three documented strategies (**Web frontend mutations**). Novel structure needs a reason beyond preference.

**Don't over-rotate.** A shared abstraction with one real caller and a speculative second is worse than the duplication it avoids — it fixes the shape of the code before you know the shape of the problem. Extract on the second *real* occurrence, not the first imagined one.

## One mechanism, no silent fallbacks

**Build what was planned, once.** When a design names a mechanism - the container tunnel, the egress proxy, the `SandboxFiles` seam, a provider's file API - that mechanism is **the** way it is done, on every backend and in every environment. Never add a second path that engages when the first is unavailable, unproven, or inconvenient.

This is easy to violate with good intentions, and each violation looks careful on its own: a rollout flag that keeps the old path as the default, a capability check that picks the "supported" branch, a `catch` that quietly does the thing the other way. Together they mean the system has two shapes, only one of which local dev and CI exercise - so the untested shape is the one production runs. A fallback also hides the failure it was added for: the operator sees a working instance doing the wrong thing instead of an error naming what broke.

None of these ship unless the user explicitly asked for them:

- **No fallback path.** If the designated mechanism fails, **fail** - loudly, with an error that names what broke and what to check. `openSandboxBackend` refusing to start rather than quietly using local Docker is the pattern (§ *Adding a container backend*); so is the egress proxy aborting a run rather than letting it egress direct.
- **No rollout gate that leaves the new mechanism off.** An env var like `HEZO_FEATURE=1` guarding a finished mechanism means the old path is still the real one. Either it is ready and it is the only path, or it is not landed yet.
- **No capability branch above a seam.** A backend that cannot do what the interface requires is unsupported, not a second code path. Absorb a provider's quirks inside its own adapter, never by teaching a caller which provider is in use.
- **No "degrades to" behaviour** invented at the call site - no `?? legacyThing()`, no `if (!supported)` alternative, no retry that lands somewhere else.

**When the designated mechanism genuinely cannot work somewhere, ask the user - do not decide it yourself.** Adding a fallback changes the architecture, and the answer is often "then it is unsupported there" rather than "then add a second path". State the constraint, state the trade-off, and let the user choose.

A deliberate exception is fine **once the user has made that call**, and it gets written down as an exception. The run CLI's model-provider credential going direct past the egress proxy (**Security** § red line) is the worked example: documented, narrow, and explicitly not the default posture.

## Translations

The web app's message catalogs (`packages/web/src/lib/i18n/catalog/*.json`) are **hand-authored source files**, not generated — there is no translation API and no build step behind them. `en.json` is the source of truth; the other eleven are written against it by whoever is doing the work, and reviewed like any other code.

That changes the failure mode. A machine pass fails by translating things it shouldn't; an authored pass fails by **omission** — a key added to `en.json` and copy-pasted unchanged into the rest, which renders English inside an otherwise translated screen. `test/i18n-catalog.test.ts` is what catches that (it is how `settings.skills` was found sitting untranslated in all eleven languages, and how the orphaned `common.*`/`nav.*`/`theme.*` keys were found rendering as hardcoded English), including an `IDENTICAL_TO_ENGLISH_OK` allowlist for words that genuinely coincide. **Adding an allowlist entry to quiet the test is the mistake it exists to prevent** — every entry is a claim that the two really are the same word.

### A string change cascades to every language (check on every code change)

**A user-facing string is not changed until it is changed in all twelve languages.** Adding, rewording, splitting, or deleting a string in `en.json` is only half the work; the other eleven catalogs need the same edit, translated. The same applies in the other direction: a component that starts rendering a new hardcoded literal has silently made the UI English for eleven languages, so **new UI copy goes through `t()` and a catalog key, never a bare literal**.

Concretely, before a change is done:

- **New string** → add the key to `en.json` **and** author it in all eleven non-English catalogs.
- **Reworded string** → retranslate it everywhere. A changed English source with stale translations underneath is worse than an untranslated key, because nothing flags it.
- **Renamed key** → rename in all twelve; a key left behind in ten catalogs is dead weight that reads as coverage.
- **Deleted string** → delete the key from all twelve.
- **New hardcoded literal in a component** → it is a missing catalog key, not a shortcut. Wire it through `t()`.

**A sentence containing a link or other node still goes through the catalog — use `<Trans>`, not a literal.** `t()` returns a string and interpolates over `Record<string, string | number>`, so it cannot carry a `ReactNode`. That is not a reason to leave the sentence hardcoded: `<Trans k="..." vars={{ source: <Link …/> }} />` (same module, `lib/i18n`) splits the identical `{name}` template and interleaves nodes, keeping the **whole** sentence as one catalog entry. Do **not** work around it by splitting the sentence into a key per fragment — that hard-codes English word order into all twelve languages, which is exactly what the translation is meant to be free to change (Japanese puts the actor first and the verb last). The `task_link`, `status_change`, `parent_change`, `run_failed` and `repo_designated` branches in `packages/web/src/components/comment-renderers/system-comment.tsx` are the worked example. The branches still reading a server-baked `content.text` (`title_change`, `assignee_change`, `description_change`) are *not* translated - localizing those means rebuilding each sentence from its structured payload fields first, not just swapping in a key. Note `TASK_STATUS_LABELS` (`@hezo/shared`) is **not** localized yet, so a translated status sentence still reads its status words in English; localizing it means touching every status surface (board, filters, task detail), not just one sentence.

The mechanical half is enforced: `packages/web/test/i18n-catalog.test.ts` fails on a key missing from a catalog, an empty value, a value left identical to its English source outside the allowlist, a dropped `{placeholder}`, an em/en dash, the word "ticket", a value carrying another language's script (hangul outside `ko`, kana outside `ja` — the typo that comes from authoring twelve languages down a row), and **a key referenced nowhere in `packages/web/src/`**.

That last one is the mirror of the others, and the only mechanical check that catches a **hardcoded literal**: a key authored in all twelve catalogs but never referenced almost always means the component still renders the English word inline, so the catalog reads as coverage it does not have. It is how `theme.system` was found translated in twelve languages while `theme-switcher.tsx` rendered `label: 'System'`. It scans for dotted string *literals* rather than `t(...)` call shapes, because keys reach the catalog three ways — a direct `t('x')`, a `labelKey: MessageKey` table read as `t(item.labelKey)`, and a `plural('x')` stem — and `MessageKey = keyof typeof en` already type-checks any literal that lands in a key position. **It has no allowlist, deliberately**: an exemption would be a standing claim that a translated string is meant to reach no screen. Wire the key up, or delete it from all twelve catalogs.

There is no missing-key check to add, either: `MessageKey = keyof typeof en` makes a typo'd `t()` key a compile error, so `bun run typecheck` covers that direction.

What the suite still cannot tell you is whether a translation is *right*, or notice English copy that never became a key at all — that judgement is the pass this section asks for. Note that the app carries plenty of English literals with no catalog key yet; the check constrains the keys that exist, and does not by itself mean a screen is fully translated.

**The acknowledgment is enforced at commit time.** The `commit-msg` hook (`.husky/commit-msg` → `scripts/check-translations-ack.ts`) rejects any commit that stages string-bearing code — anything under `packages/web/src/` or `packages/shared/src/` — unless the commit message carries a **`Translations-Checked:` trailer** recording the cascade pass you actually did. Write what you checked, not a rubber stamp - bare values (`yes`, `n/a`, `done`, anything under 10 characters) are rejected:

```
Translations-Checked: added settings.locale.* to all 12 catalogs
Translations-Checked: reworded onboarding.language.subtitle; retranslated in all 11 non-English catalogs
Translations-Checked: no user-facing strings added or changed; catalogs untouched
```

The trailer must be true — it is the audit record that the cascade happened. Never write it without doing the pass, and **never bypass the hook with `--no-verify`**. Server-only, test-only, docs-only, merge, revert, and fixup commits are exempt (no trailer needed). The hook shares its machinery with the `Docs-Checked:` hook (`scripts/commit-ack.ts`) and its classification rules are unit-tested in `packages/server/test/translations-ack-hook.test.ts`; if you add a new string-bearing top-level path, add it to `STRING_BEARING_PATTERNS` in `scripts/check-translations-ack.ts` in the same change.

Rules for any catalog edit:

- **Never translated:** `Hezo`, `Captain`, `CEO`, `Coach`, `HQ`, `MCP`, agent role names, marketplace team names, and any CLI/command text. Role and team names must match the app's `marketplace/teams/*.json` rosters — translating one side desyncs them.
- **"task", never "ticket" — in every language.** Pick the word for a unit of work, not a support ticket: `Aufgabe` not `Ticket`, `tâche` not `ticket`, `タスク` not `チケット`. The test asserts the literal string, which only catches the English-shaped mistake; the rest is on you.
- **The em/en dash ban applies to every language**, not just English (**User-facing docs terminology**).
- **`{placeholder}` tokens are copied verbatim.** A translated `{count}` renders literally.
- **One term per concept per language.** Whatever a language calls Settings, it calls it that everywhere — French is `Réglages` throughout, so a string referring to the page uses `Réglages` too. Check the existing catalog before inventing a second word.
- **Watch for repetition the English doesn't have.** French once read "modifier ces réglages … dans les réglages" — correct, consistent, and clumsy. Recast rather than accepting it.

**Register is a per-language decision, already made.** Do not "fix" one language to match another — forcing formal address onto Swedish would be actively wrong, since it is archaic there after the du-reform.

| | Address | Why |
|---|---|---|
| de | formal (Sie) | The safe default for business software |
| fr | formal (vous) | Standard for product UI |
| es / it | informal (tú / tu) | Modern software convention |
| nl | informal (je) | Normal for product UI |
| pt-BR | você | Standard and neutral |
| pl | informal 2nd person | Now standard in Polish developer tooling |
| sv | informal (du) | Required — formal address is archaic |
| zh-Hans / ja / ko | polite-neutral | 您 / です・ます / 해요체 |

These are **unreviewed by native speakers**. The register calls above and the CJK politeness levels in particular deserve a native pass before a release that markets the translations.

## Type safety

No `any` in source code. Use specific types, `unknown`, `Record<string, unknown>`, or generics. If a library lacks types, install them (`@types/*`) — don't fall back to `any` or `declare const` hacks. `any` is acceptable only in test files for unpredictable JSON.

## Design for scale, reuse and contention

The reference workload is **~10 concurrent agent runs on an instance holding 1GB+ of database and asset data**. That is the product, not a stress test, and the whole system is one Bun process that is simultaneously the API, the MCP endpoint, the egress proxy, the Docker control plane and — on the default embedded backend — the database itself. Design against that.

Each rule below cites the real bug it exists to prevent, so the precedent stays findable.

- **No duplicated logic — extract at the *second* occurrence, not the third.** Search `packages/shared/`, the per-package `lib/` directories, and `services/` before writing a helper. Precedents: the SQL fragments in `db/run-log-chunks.ts`, `services/run-concurrency.ts` as the single source of truth for the run rules, `createStubDocker()`, `services/docker-frames.ts`. *(Two docker frame decoders and two worker pools each drifted before being merged.)*
- **Bound list endpoints in row count *and* row width.** Never return a column whose size has no ceiling — a run log, a document body — from a list route; `parsePagination` allows `per_page` up to 200, which multiplies it. Send a size hint instead and serve the full value from the single-item read. *(The runs list carried full `log_text` per row: one page could materialize gigabytes.)*
- **Budget the DB round trips a request costs.** Fold repeated lookups into one query, batch or join instead of looping, and memoize what is hot and rarely-changing (`MasterKeyManager.getDerivedKey` is the pattern). A request whose cost grows with the number of rows it renders is a defect. *(Every signed URL derived its HKDF key from scratch, so a feed paid one derivation per row.)*
- **Load progressively: cheap structure first, heavy content on demand.** Return counts, order and per-item size hints up front so the layout settles and the user sees the total, then fetch bodies for what they actually reach, batched. `useCommentSkeletons` + `useCommentBody` (scroll-dwell, `?ids=` batching, stable scrollbar) is the worked example — copy it rather than either loading everything or paginating the structure away.
- **Share resources; do not multiply them per unit of work.** Prefer one pooled, refcounted, idle-released resource over one per run/request/project, and key it by what it is actually keyed on.
- **But find out why something was scoped narrowly before you widen it.** The general rule lives in `SHARED_INSTRUCTIONS`; the live examples here are the **per-run egress proxy scoping** (#101 tried the shared SNI-multiplexed server, #103 reverted it as structurally impossible under Bun — whose `https.Server` has no `addContext` and ignores `SNICallback` — and **the Bun-native test tier exists because of that revert**), `keepAlive: false` on the upstream agent (#283, a GitHub MCP production failure), and `PostgresDb.txQueue`, which exists for read-modify-write correctness and not by accident.
- **A new mutex is a throughput ceiling.** Say in a comment what it protects and why a narrower scope is insufficient; never hold one across IO. Know what you are queueing behind: `PostgresDb.txQueue` (every transaction, process-wide), `acquireCredentialLock`, `withProjectGitLock`, `JobManager.guarded`. *(A three-statement transaction on the twice-a-second-per-run log path sat in front of every user request.)*
- **Stream; do not copy.** Data that can exceed a few MB is streamed end to end — never collected into an array, joined into a string, or buffered before being written or sent. Copy: `streamLogicalBackupLines`, `dumpLogicalBackupToFile`, `restoreLogicalBackupFromFile`, `updater.downloadAndStage`. Avoid: #858 (buffered dump and restore, OOM-killed a live instance) and #817 (whole-log rewrite per flush).
- **Index the hot path, and index what the query actually asks for.** An index a predicate cannot use is not an index: `LOWER(identifier)` will not use `(team_id, identifier)`, and a JSONB expression (`payload->>'task_id'`) uses nothing. Filter-then-sort-then-limit wants a composite index in that order. Every cron or per-request query ships with its index **in the same change**, in a migration with a data-preservation test — the precedent #763 set. *(The 5s heartbeat scan had nothing serving its recency test; `resolveTaskId` defeated its own index on nearly every request.)*
- **Filter, limit and aggregate in the query, not in the language.** Loading a row to keep its last 1000 characters, or counting a whole table to render a page number, is a query bug. Prefer keyset pagination and `has_more` over `COUNT(*)` on tables that only grow. *(Four sites materialized a 10MB log to keep a tail.)*
- **Never write a row that has not changed.** Under MVCC every no-op `UPDATE` leaves a dead tuple, and the embedded backend has no autovacuum to reclaim it. Guard with `IS DISTINCT FROM` or an explicit change check. *(An unconditional `UPDATE projects` fired per project per second.)*
- **Every recurring job is bounded, observable, and paced to what it watches.** A `LIMIT` on every scan; a log line when a tick is skipped for overrun (a silently-dropped tick is stale state with no signal — see #186); a cadence matched to how fast the thing actually changes.
- **A cache needs an invalidation story and a bound.** State the eviction rule in a comment where you declare it: TTL, LRU cap, explicit invalidation, or lifecycle scope. A `Map` with none of those is a leak. Security-sensitive caches also state their clear-on-lock behaviour.
- **Coalesce on the wire and respect backpressure.** Batch high-frequency events into periodic frames rather than one message per item, and handle a slow consumer explicitly — an ignored `send()` result is unbounded server-side buffering. *(One WS frame per log line; 10MB replay snapshots per subscriber.)*
- **Deleting the user's data is the operator's decision, never a default.** Run logs, cost records and audit history are things a user may deliberately want to keep forever; a table that only grows is a query-design problem, not a licence to prune. Hezo's run-log compaction is an explicit control on the global Storage settings page and **stays that way** — no cron may start a pass. Only internal bookkeeping with no user-facing surface may be swept automatically, and the comment must say why it qualifies.
- **Measure the claim.** A performance change states what it improved and how that was observed. "Should be faster" is not a result.

## Build artifacts

Never commit `.js`/`.d.ts`/`.js.map`/`.d.ts.map` alongside source. Compiled output lives in `dist/`. If generated files appear under `packages/*/src/`, delete them.

## Conventions

- `commander` for all CLI argument parsing — never parse `process.argv` manually.
- Use shared constants/enums from `@hezo/shared` (`packages/shared/src/types/common.ts`) — no raw status/type strings. Add new enum values to the shared package first.
- `bunx`, not `npx`.

### Adding a container backend (Docker, Daytona, …)

Agent-run containers run either on the operator's local Docker daemon or on a third-party sandbox service. Both sit behind **one seam**, `ContainerEngine` (`packages/server/src/services/sandbox/types.ts`), and every caller above it — `agent-runner.ts`, `containers.ts`, `git-executor.ts`, `chat-session-manager.ts`, `job-manager.ts`, the process sweeper — talks only to that interface. `DockerClient` (`services/docker.ts`) and `DaytonaEngine` (`services/sandbox/daytona/`) are the implementations.

**Every provider-specific fact lives inside that provider's adapter directory.** Nothing above the seam may learn which backend is in use — no provider name in a conditional, no provider-shaped field on a shared type, no "if remote" anywhere. A provider's API quirks are its adapter's problem to absorb, and absorbing them is the entire job:

- **`services/sandbox/<provider>/client.ts`** — the REST/SDK client and its wire types. Hand-rolled rather than the vendor SDK, so the dependency stays out of the single-binary build and the error shapes are ours to map. Export the **narrow port interface** the engine actually drives (e.g. `DaytonaApi`) and have the client implement it, so tests supply a complete fake instead of a partial object cast through `unknown`.
- **`services/sandbox/<provider>/command.ts`** — pure, testable rendering of an exec into whatever the provider accepts. This is where an argv-to-string translation, a user-switching workaround or a stream-separation trick belongs.
- **`services/sandbox/<provider>/engine.ts`** — the `ContainerEngine` implementation.

**A backend that needs host-side work gets a seam method, never a branch at the call site.** The rule above is easy to keep while writing an adapter and easy to break while writing a *caller*, because the violation does not look provider-specific - it looks like a type check. `startup.ts` carried two of them:

```ts
// WRONG - a capability branch above the seam.
if (initialEngine instanceof DockerClient) {
    await extractBundledDockerContext(dataDir);   // no image store on a managed backend
    trackBackground(checkContainerMounts({ docker: initialEngine, dataDir }));  // no binds either
}
```

Both existed because the *other* backend cannot do those things, which is exactly the shape the seam is for. The fix is a method every backend answers - `ContainerEngine.prepareHost({ dataDir })`, where `DockerClient` extracts its build context, prunes bundled images, refreshes the published tag and probes its mounts, and `DaytonaEngine` implements it as an explicit no-op with a comment saying why. The caller then does the work unconditionally and learns nothing:

```ts
await docker.prepareHost({ dataDir: config.dataDir });
```

Two things make this worth stating rather than leaving to the general rule:

- **`instanceof` evades every grep you would write for the general rule.** It carries no provider *name*, no enum value, no `'daytona'` string - a search for those comes back clean while the branch sits there. Grep for the shape instead: `grep -rn "instanceof DockerClient\|instanceof DaytonaEngine\|=== SandboxBackend\.\|!== SandboxBackend\." packages/server/src packages/web/src --include=*.ts --include=*.tsx` and expect hits **only** where a provider is genuinely being *constructed or named* - `sandbox/open.ts` picking a client, and a display/label table keyed by backend. Everything else is a bug, including in the settings and credential plumbing (see the next bullet). A hit anywhere on the run path is always a bug.
- **`instanceof` against the holder is always false**, because callers hold `SandboxBackendHolder.engine`, a proxy. So the branch does not merely couple the caller to a provider, it silently stops running: introducing the holder turned the image setup above into dead code - agent-base was never extracted and stale images were never pruned, with nothing logged. It was caught by `startup-real-docker-branch.test.ts` rather than by anything noticing at runtime. Routing the work through the seam removes the hazard entirely, since a proxy forwards a method call just fine.

Reach for a new `ContainerEngine` method whenever you catch yourself asking *which* backend you have. Adding one is cheap and the compiler finds every implementation for you - including `createStubDocker` and `fake-docker.ts`, which must both answer it (start from a complete stub, never a partial object).

**Ask what *kind* of backend it is, never which one - a provider name in a conditional is a class property in disguise.** The settings and credential plumbing sits above the seam but outside the run path, and it is where this hides best, because naming a provider there looks like configuration rather than a branch. It is not. Four sites decided "does this backend need an API key?" by writing `=== SandboxBackend.Daytona` / `!== SandboxBackend.Docker` - `switch-backend.ts`, `routes/sandbox-backend-info.ts`, `backend-store.ts` (twice) and the web switcher. Each reads as a statement about Daytona; each is actually the rule *every third-party container service is reached with an account credential*, and a second provider would have silently inherited "needs no key" at all of them - the route skipping its guard, the switch passing no key to the preflight, and the dialog rendering no field to type one into. Nothing would have failed to compile.

So the classification lives in **one table in `@hezo/shared`**, and callers ask the derived question:

```ts
export const SANDBOX_BACKEND_KIND: Record<SandboxBackend, 'local' | 'remote'> = {
    [SandboxBackend.Docker]: 'local',
    [SandboxBackend.Daytona]: 'remote',
};
export function sandboxBackendNeedsApiKey(b: SandboxBackend): boolean {
    return SANDBOX_BACKEND_KIND[b] === 'remote';
}
```

`Record<SandboxBackend, …>` is the whole point (**Table over branch**): adding a backend is a *compile error* until it declares its kind, where an `if` would have let it default into a branch. In `@hezo/shared` because the server enforces the requirement and the web app renders the field for it - one rule, two enforcers, per **pick the home by reach**. And it is the *kind* rather than a bare `needsApiKey` boolean, so the next class-wide question ("does it bill?", "can it bind-mount?") extends the same table instead of starting a parallel one.

What may still name a provider here: **which credential**, not **whether one is needed**. `--daytona-api-key`, the `DAYTONA_API_KEY` vault entry and `DaytonaClient` are per-provider *configuration* - one account, one key, one client - and stay named. The moment a *decision* keys off the name, it is this bug.

**Runtime-agnostic logic is shared, not reimplemented per adapter.** The in-container `/proc` scan and kill scripts live in `services/sandbox/proc-scripts.ts` and **both** engines run the identical script — only the transport that carries it differs. A second copy of one of those scripts is how the two backends silently drift apart. Same rule for the endpoint map (`sandbox/endpoints.ts`), file access (`sandbox/files.ts`) and the exec handle (`sandbox/handle.ts`).

**Never provision a container with less of a resource than was asked for - refuse instead.** A provider has ceilings (Daytona allocates at most 8 GB of RAM per sandbox) and it is always tempting to clamp a larger request down to what it will give. Don't: the per-container RAM cap is a *guarantee* the rest of the system is sized against - `enforceContainerMemoryLimit` stops a container that exceeds it, and the instance memory budget is spent in units of it - so a container quietly provisioned smaller OOMs partway through a run and reads as an agent failure rather than as the misconfiguration it is. Round *up* when the provider's unit is coarser than the request (a 1.5 GB cap asks for 2 GB, never 1), and throw a named, actionable error when the request exceeds the ceiling (`DaytonaMemoryCapExceededError` is the worked example: it states the request, the ceiling, and which setting to lower). The same holds for disk and CPU. This is the **One mechanism, no silent fallbacks** rule applied to sizing - degrading the allocation is a fallback with a bill and an OOM attached.

**The backend is switchable at runtime, so nothing may capture the engine.** It is chosen
from a stored setting (the CLI flag seeds a fresh instance only) and changed from Settings ->
Containers. Everything takes `SandboxBackendHolder.engine` - one proxy, built once at
startup - rather than a concrete engine, because a captured reference survives a swap and
keeps driving the backend the operator just left, which reads as a perfectly normal run on
the wrong provider. When you add a consumer, take the proxy. When you add a method to
`ContainerEngine`, add it to the holder's delegation too (the compiler will tell you).
Switching preflights the destination, then destroys every container, then swaps - never a
different order, and never a fallback to another backend when one is unreachable.

**Elevation is a flag, not a username.** Docker honours a per-exec `User`; third-party providers generally do not, and the default identity differs per provider — Daytona execs as **root**, so it renders a non-root user as `runuser -u <user> --` (deprivileging), the inverse of Docker's render. State the intent (`elevated`) at the call site and let each adapter render it.

**Probe the provider; do not infer it from its docs.** Every non-obvious behaviour the Daytona adapter encodes was measured against the live API, and several contradicted the documentation or the obvious reading of the OpenAPI spec: there is no `image` field on create at all (a custom image arrives as Dockerfile text), the build cache is keyed on that Dockerfile's **text** so a tag-pinned `FROM` never invalidates and serves a stale toolchain forever, `stdout`/`stderr` exist on the exec response but are **always null** so the streams arrive merged, and a per-exec `user` is accepted and silently ignored. When an adapter works around something, the comment says what was measured.

**Tell the agents what they are running on, and what its network will not carry.** An agent inside a container cannot tell "this command is wrong" from "this container's egress will not carry that protocol", and it has no way to find out - so it retries, reports a broken tool, or works around a constraint it has misdiagnosed. Daytona is the worked example: `ssh` fails there on **every** port (22 is dropped; 443 admits the connection and resets it once the payload turns out not to be TLS, which surfaces as `kex_exchange_identification: read: Connection reset by peer`), and no sandbox-level setting changes it - `domainAllowList` matches on TLS SNI, which SSH does not have, and even naming the destination's own CIDRs in `networkAllowList` leaves both ports dead. An agent told none of this reads it as GitHub refusing its key.

So every backend declares what an agent can reach from inside it, in `SANDBOX_AGENT_ENVIRONMENTS` (`services/sandbox/agent-environment.ts`): the service's name, where the container runs, and the egress facts in an agent's terms - what works, what does not, and what to reach for instead. `buildContainerEnvironmentBlock` renders it beside `SHARED_INSTRUCTIONS`, so it reaches **every agent on every run, including one hired at runtime**, and it is resolved per run because the backend is a setting an operator can change.

**When you add, remove or change a container service, update its entry in the same change.** `Record<SandboxBackend, …>` makes adding one a *compile error* until it states its egress, which is the enforcement - but changing an existing provider's behaviour is not, so re-probe and re-state it whenever you touch that adapter. Two rules bind the content: every claim is **measured against the live provider** (see *Probe the provider*), and anything provider-specific also goes on that provider's own `docs/containers/**` page, so an operator and an agent are reading the same facts rather than two drifting accounts.

**Keep a provider's numbers in that provider's own docs section.** A ceiling, a quota, a
per-sandbox allocation or a startup latency is a fact about *one* provider, and writing it
into the generic prose makes it read as a property of managed sandboxes in general - which
is wrong the moment a second provider exists, and wrong in a way nobody notices because the
page still reads correctly for the provider they happen to use. So the docs give each
provider **its own page** under `docs/containers/remote/`: `remote/overview.md` states the
**shape** of every limit generically ("your provider account caps total memory and disk
across all sandboxes, and Hezo cannot see that limit") and never a figure, while
`remote/daytona.md` carries that provider's numbers (8 GB per sandbox, 10 GB of disk each,
an account-wide disk quota that is usually what binds first, a ~30s first build). The same
split applies in the UI: the Containers settings page resolves the backend in use -
**including local Docker, which is a backend like any other here** - and shows only that
one's caveats. When you add an adapter, add its `docs/containers/remote/<provider>.md`
page (linked from `remote/overview.md`'s provider list) and its UI branch in the same
change, and move anything provider-specific you find in the generic prose into it.

**Ship the adapter's own tests, and a conformance fixture.** Two layers, and both are needed:

- **Unit, against a fake API** — pure command rendering (quoting, user rendering, stream handling), state mapping onto the shared `ContainerInfo` shape (including that *transitional* states never read as dead), the exec triad's exit-code propagation, and each degradation the adapter accepts. Crib `packages/server/test/sandbox-daytona-{command,engine}.test.ts`. These pin the requests Hezo *sends*; they cannot tell you the provider still answers them the way it did when they were written.
- **Conformance, against the real backend** — everything under `packages/server/test/conformance/` is a backend-agnostic suite parameterised by a `LiveAdapterFixture`, so a new provider is a fixture file rather than a second suite, and a divergence surfaces as a shared assertion failing on one backend instead of as an assertion nobody thought to write for it. Docker's fixture (`test/bun/sandbox-conformance-docker.bun.test.ts`) **runs in CI**, self-skipping with a logged reason when there is no daemon or no agent-base image; a paid provider's fixture lives in `test/live/` and is manual (`bun run test:daytona`). Where a backend legitimately cannot answer something (`diskUsedBytes` may return null by design), the fixture declares the fact with a flag and the suite asserts the documented alternative rather than skipping in silence.

**Every one of those suites must run against every adapter — that is the requirement, not a nice-to-have.** The end-to-end coverage that exists today is not "the Daytona tests"; it is the conformance set, which Daytona happens to be one fixture for. A new adapter (Modal, E2B, …) ships a fixture that runs **all** of them, and any suite added later is written generically so every existing adapter picks it up for free. Today that set is:

| Suite | What it proves about the backend |
|---|---|
| `conformance/engine.ts` | lifecycle, the exec triad and its exit code, streaming that arrives incrementally, env, elevation, stop/start preserving the filesystem, the `/proc` process scripts, and the disk/memory answers |
| `conformance/files.ts` | the whole `SandboxFiles` contract - byte fidelity, sizes, listing, recursive removal, root escape refusal, and that a mode reaches **every** directory it creates |
| `conformance/agent-cli.ts` | a real coding-CLI run inside a provisioned container, against a real model provider (opt-in via a second key) |
| `conformance/egress.ts` | the red line end to end: a placeholder written inside the container is substituted at the proxy, the value exists nowhere the container can read, and a host outside `allowed_hosts` gets the placeholder rather than the secret |
| `conformance/tunnel.ts` | what a run depends on *after* readiness: a connection made inside the container reaches the host address, every target key binds, the channel survives an idle period, an unrequested death fires `onClosed` while a caller's own `close()` does not, and the client's stderr reaches the host |

**Never add a backend-specific end-to-end test.** If something is worth asserting against a live backend, it is worth asserting against all of them - put it in `conformance/`, add whatever the fixture must declare, and let each adapter answer. A suite only one provider runs stops describing the interface and starts describing that provider, which is the failure this whole directory exists to prevent.

`conformance/egress.ts` needs the image to carry `hezo-tunnel` (there is no container-to-host path otherwise) and **refuses with that reason** rather than skipping, since a skip there would report green while asserting nothing about the only path it covers. That bites a managed backend before it bites Docker: Docker builds from the working tree, while a provider pulls a *published* image, so `agent-base:latest` is main's and lacks anything a branch added.

**The same gap bites a dev server on a managed backend, and has its own variable.** Running from source, `publishedAgentBaseRef()` returns null and agent-base is built from the working-tree Dockerfile into the *local daemon's* image store - right for Docker, invisible to a provider, which pulls from a registry. `HEZO_AGENT_BASE_IMAGE=ghcr.io/hezo-ai/agent-base:<sha>` overrides it for every project (a project naming its own image keeps it), and applies on Docker too, so you can test against exactly what CI built rather than your tree. Forgetting it is caught at provision: `assertRegistryPullableImage` refuses the local-build sentinel with a message naming the variable, rather than letting the provider report a build failure against a Docker Hub repository nobody typed. A registry-backed adapter calls it; one with its own image store does not.

Point `HEZO_CONFORMANCE_IMAGE` at the image CI published for the branch. **Finding its tag is not obvious**: `build-agent-image` tags with `github.sha`, which on a `pull_request` event is the *merge* commit rather than the branch head, so the tag matches no SHA `git log` will show you. Resolve it with `git ls-remote origin refs/pull/<pr>/merge`, then:

```sh
HEZO_CONFORMANCE_IMAGE=ghcr.io/hezo-ai/agent-base:<merge-sha> \
HEZO_DAYTONA_API_KEY=… HEZO_DEEPSEEK_API_KEY=… bun run test:daytona
```

(The merge ref moves when main does, so re-resolve it rather than reusing a stale tag.)

`test/live/**` is excluded from `vitest.config.ts` and `vitest.live.config.ts` **throws if `CI` is set** — a key reaching CI through a secret or a fork's environment must not start billing, and a guard that depends on the key being absent is one misconfiguration away from provisioning on every push. Every container the suites create carries the `hezo.conformance` label and is swept on the way *in* as well as out, so a crashed earlier run does not leave a sandbox billing until somebody notices it in a dashboard.

### Adding a chat channel adapter

External chat avenues to the CEO (Telegram, Slack, Discord now; WhatsApp later) are built on a **channel-adapter abstraction + registry** so a new app is one file, not a core change. The `ChatChannelAdapter` interface and registry live in `packages/server/src/services/chat-channels/`; the manager (`chat-session-manager.ts`), the generic inbound webhook route (`routes/chat-webhooks.ts`), the conversation model, and the web thread switcher are all **channel-agnostic** — they resolve a channel only through the registry, never by branching on a platform name.

**The thread model (no mirroring).** Every conversation has exactly **one home surface**: a web thread, a Telegram DM, a Slack channel, a Discord channel — each is its own `chat_conversations` row, and `(channel, external_thread_id, closed_at IS NULL)` **is the inbound routing key** (there is no bindings table). Nothing started on one surface ever creates or posts into a thread on another. The invariants every adapter must respect:

- **One home surface per thread.** An adapter never creates threads on other channels and never re-implements any cross-surface sync. Closing a thread (web ✕, or the platform's own close via `parseClose` → `closeConversationByExternalThread`) ends it; the next inbound message on that surface starts a fresh conversation.
- **Reply-where-asked.** A turn's reply is delivered to the surface the triggering message came from — the manager's `finalize` calls `ChannelHooks.deliver` with the **turn's** origin channel. A web-composed turn into an external assistant thread answers on web only; an adapter's `deliver` only ever addresses its own platform.
- **The web view is the hub.** `listConversations` returns all kinds with `channel` + `kind`; assistant threads stay fully interactive from web, **coworker threads are read-only in web** (`POST /api/chat/messages` 409s; the write surface is the platform, where the ephemeral channel context lives).
- **History capability is required for group mode.** A group-capable adapter MUST provide real channel context via `fetchThreadContext` — fetch-on-demand where the platform has a history API (Slack `conversations.history`/`replies`, Discord `GET /channels/{id}/messages`), or **passive accumulation** where it doesn't (Telegram: `observeMessage` → the bounded `chat_observed_messages` buffer, ~200/chat, topic-scoped reads). A coworker that can't see the channel is pointless — don't ship group mode without it.

**Every chat app can support two integration modes**, discriminated by `chat_conversations.kind`; an adapter implements one or both:

- **Assistant/DM mode** (`kind='assistant'`) — a private chat with the bot is a real-time CEO thread, listed in the web chatbox. Identity-allowlist gated. Telegram DMs + the operator's designated Topics supergroup (parallel personal threads); Slack DMs; Discord DMs.
- **Group/coworker mode** (`kind='coworker'`) — the CEO is invited into an existing group channel and responds to @-mentions with platform history as ephemeral context, replying in-thread. **Channel invite is the authorization** (no identity gate; a link only enriches attribution). Read-only in the web view; turns queue instead of interrupting; no compaction/auto-title (the operator's long-term chat memory stays out of group prompts). Slack channels; Telegram groups; Discord channels.

To add a channel:

1. Add a `ChatChannel` enum value in `packages/shared/src/types/common.ts` **and** an additive `ALTER TYPE chat_channel ADD VALUE` migration (with a data-preservation test). *Telegram/WhatsApp were in the enum from the start; Slack + Discord shipped via migration 038; WhatsApp's value exists but has no adapter yet.*
2. Implement a `ChatChannelAdapter` (`chat-channels/<channel>.ts`): `parseInbound` (raw event → `InboundChatEvent`), `deliver` (a message → platform thread, split via `splitMessageForLimit` from `chat-channels/format.ts` when the platform caps message length), optional `start`/`stop` (webhook registration, or a persistent transport like Slack's Socket Mode client / Discord's gateway client), optional `closeThread` (close/archive the adapter's own platform thread) + `parseClose` (platform thread-closed → external id), optional `observeMessage` (passive accumulation for history-less platforms), optional `promptToLink`/`validateConfig`. **Group mode is the optional capability trio** `parseGroupMention`/`supportsGroupMode`/`fetchThreadContext` (the adapter owns the platform history fetch and its filtering; the core owns prompt formatting via `formatGroupContextBlock`; a one-hop reply-quote rides on the event as `inlineContext`). Register it in `buildChatChannelRegistry` (`chat-channels/index.ts`).
3. Inbound transport: webhook channels flow through the generic route, which dispatches `parseGroupMention` → `parseInbound` → `parseClose` → `observeMessage` in that order — DMs land in `ingestInboundEvent`, group mentions in the **second, deliberately separate ingest path `ingestGroupMentionEvent`** (`chat-channels/ingest-group.ts`); never overload `ingestInboundEvent` with group semantics. A socket-transport adapter pushes parsed events through the `InboundEventSink` on its deps instead (same ingest functions, wired at startup). A **true-fanout** transport (Discord's gateway — every open connection receives every event, unlike Slack's load-balanced Socket Mode) must also hold the **single-instance ownership lease** (`metadata.gateway_owner`, TTL-renewed from the heartbeat; stand down on loss) so two server instances sharing a DB never double-answer.
4. Store all channel-specific settings in `chat_channel_configs.metadata` (jsonb) — **never add per-channel columns**. The bot token goes in the `secrets` vault (referenced by name) and is decrypted **in-process** by trusted server code, NOT via the agent egress proxy (that mechanism is for agent runs). A channel needing a **second** secret stores its vault name in metadata (Slack: `metadata.app_token_secret` → `SLACK_APP_TOKEN`; the config PUT route handles `app_token` generically).
5. Ship the channel's own unit tests (parse → event shape, mention/reply detection, close no-op safety) plus routing coverage: reply-where-asked and close semantics (crib `packages/server/test/chat-thread-routing.test.ts` — no cross-surface thread creation, a web turn into an external thread answers on web only, close → fresh thread) and, for a group-capable adapter, coworker-semantics coverage (crib `packages/server/test/chat-group-ingest.test.ts`: coworker kind, reply-to-origin, read-only web, ephemeral context never persisted).

**Do not touch** the manager, `ingestInboundEvent`/`ingestGroupMentionEvent`, the generic webhook route, or the conversation/identity schema — if a new channel forces a change there, close the gap in the abstraction instead. `chat-channels/slack.ts` + `slack-socket.ts` are the worked persistent-transport example; `chat-channels/discord.ts` + `discord-gateway.ts` are the worked true-fanout + lease example; `chat-channels/telegram.ts` is the worked webhook + passive-accumulation example.

### User-facing docs terminology

These rules apply to **user-facing prose** — the `docs/` tree and anything a Hezo operator reads — because the audience is users, not engineers. They do **not** force renames of code identifiers, DB columns, route paths, or internal comments.

- **Say "task", never "ticket".** The work item on the board is a **task** everywhere in `docs/`. "Ticket" is banned from user-facing prose — use "task" (plural "tasks"). The generated `docs/reference/mcp-api.md` is the one exception to *hand-editing* it into line: it is built from the MCP tool registry and must never be edited directly; when you author a tool's description or `TOOL_DOC_META` that will surface there, prefer "task" too so the generated page stays consistent.
- **Never use an em dash or an en dash. Use a hyphen.** No user-facing prose may contain `—` (U+2014) or `–` (U+2013), anywhere, for any reason. Put a plain ` - ` where an em dash would go; recast a paired parenthetical (`… — like this — …`) as parentheses or commas, since ` - x - ` reads ambiguously. Write numeric ranges with a hyphen (`0-100`, `20000-29999`), and use `-` for a "no value" cell in a table. This covers `docs/`, the READMEs, UI strings, and marketing copy.
  - **`docs/` and the READMEs are zero-tolerance and enforced.** `packages/server/test/docs-terminology.test.ts` fails on any em or en dash in either surface, with no allowlist. Do not add one.
  - **`docs/reference/mcp-api.md` is *not* exempt** (unlike the "ticket" rule above). Because it is generated, the ban reaches its sources: tool `description` strings and zod `.describe()` calls in `packages/server/src/mcp/tools.ts`, `TOOL_DOC_META` plus the generator preamble in `mcp/mcp-reference.ts`, and `mcp/onboarding.ts`. Write those with hyphens and regenerate with `bun run --cwd packages/server build:docs`. The same goes for the other generated agent-facing surfaces, `mcp/skill-file.ts` (`GET /SKILL.md`) and `mcp/llms-txt.ts` (`GET /llms.txt`) — note `generateSkillFile` re-emits every tool description verbatim, so a dash in `tools.ts` lands on both surfaces.
  - Internal-only text is exempt: code comments, `.dev/`, and this file's own existing prose are not user-facing and are not rewritten for this.
- **Say "global", never "instance-wide".** Describe HQ, the CEO, the Coach, skills, and MCP connections as **global** (e.g. "the global HQ project"). Users don't know what "instance-wide" means — don't use it in `docs/`.
- **The README carries no competitor-comparison section, ever.** A "How Hezo compares" table (Hezo vs terminal tabs / hosted platforms / agent frameworks) was deliberately removed and **must never be reintroduced** — not in `README.md`, not in `docs/`, not under a different heading ("Why Hezo", "Alternatives", "Comparison", a vs-table). Describe what Hezo *does* on its own terms. This is a standing rule, not a one-time deletion: when rewriting or expanding the README, do not add one back.

### Web frontend mutations

Three strategies, picked by mutation shape. Default to optimistic unless the mutation falls into the response-driven or invalidate carve-outs below.

- **Optimistic + rollback** — default for field edits, toggles, choose-option, reactions. Use `useOptimisticMutation` (`packages/web/src/hooks/use-optimistic-mutation.ts`). The cache updates synchronously; on server error the previous state is restored and `toast.error(...)` fires. `invalidateOnSettled` is for sibling queries (list views) that need to re-flow after the change lands. Pass `mergeResponse` to reconcile server-computed fields (timestamps, status set by server-side automations).
- **Response-driven** — creates, multi-resource responses, and fields where the server runs validation/automations whose outcome the UI should not preempt (e.g. task `status` — closing a task runs `assertChildrenAllClosed`/`assertNoOutstandingActivity` and triggers automations the UI can't predict). Standard `useMutation` with `onSuccess: (data) => queryClient.setQueryData(...)` seeded from the response.
- **Invalidate + refetch** — validation-heavy or long-running: AI provider verify, container lifecycle, anything where the server result depends on async work. Default `useMutation` + `invalidateQueries` in `onSuccess`.

Security-sensitive mutations (`useFulfillCredential`) MUST stay response-driven — never optimistically appear fulfilled.

Errors-only toast: `toast.error(...)` from `packages/web/src/hooks/use-toast.ts` fires automatically on `useOptimisticMutation` rollback. Successes are not toasted — the UI change itself is the confirmation. One carve-out: when an action's result lives on a **different page** (e.g. the review handoff posted as a comment onto a task), there is no visible UI change to confirm it, so fire `toast.success(...)` with a `link` to the result. For inline form errors (validation the user should fix in place), keep the inline pattern in addition to the toast.

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

### Red line: no plaintext confidential data in an agent run

**This is a hard architectural invariant — it must never be violated.** An agent run — its container env, CLI args, config files, MCP-server descriptors, mounted files, logs, anything the agent process can read — must **never** contain a confidential value in plaintext. Every secret an agent touches (user-pasted credentials, `request_credential` values, OAuth access/refresh tokens, MCP connector API keys, webhook secrets, signing material) is referenced **only** by its `__HEZO_SECRET_<NAME>__` placeholder. The real value lives encrypted in the `secrets` vault and is substituted **at the egress proxy**, at request time, scoped by `allowed_hosts`. Never decrypt, materialize, or otherwise write such a value into a descriptor header, env var, config file, CLI arg, mounted file, or log line that a run can reach.

- **Assume the egress proxy catches everything.** It is the single choke point (`.dev/architecture.md` § Credentials, egress & secrets) and the threat model assumes the agent itself may misbehave. If a call somehow bypasses the proxy, it carries the *unsubstituted placeholder* — a fake credential — and simply fails upstream. That is a **usability** failure, never a **leak**, and it is an acceptable trade: fail closed in placeholder form. "Fixing" such a failure by materializing the real value into the run is a red-line violation, not a fix.
- **Sole exception — the run CLI's own AI-model-provider credential.** The API key or subscription token the agent-run coding CLI uses to reach its AI **model provider** (e.g. `ANTHROPIC_API_KEY`, a `claude setup-token` OAuth token) is env-injected in plaintext and sent **direct** (`NO_PROXY`), because the provider endpoint is exempt from MITM — some Anthropic-compatible APIs break under it. This is the **only** plaintext secret permitted inside a run, and **only** for the CLI to reach its model provider. It never licenses materializing any other secret (a connector token, a pasted credential, an OAuth token for a tool the agent calls) into the run.
- **Connectors are not exempt.** OAuth-backed and API-key MCP connectors emit `Authorization: Bearer __HEZO_SECRET_<NAME>__` in the descriptor the runtime adapter builds; the descriptor loader resolves the secret **name** and never decrypts the value. Do not reintroduce build-time token materialization for connectors — the egress proxy substitutes at request time exactly as it does for any agent-emitted placeholder.

### Never encourage storing the master key on a system

The **master key** is the one secret Hezo deliberately keeps **in memory only, never written to disk** — that in-memory-only invariant is what makes encryption-at-rest meaningful (anyone who can read the data directory *and* a persisted copy of the key can decrypt the entire vault). **Never encourage a user to store the master key anywhere on a system** — not in an env file, a `HEZO_MASTER_KEY=` line persisted to disk, a systemd/service definition, a config file, a shell profile, a same-host secrets file, or a code comment. This holds on every surface an agent produces: `docs/**`, `.dev/`, READMEs, CLI/`--help` text, deploy scripts (`deploy/**`), and agent replies. The secure default is to **unlock interactively** from the web gate — after any restart Hezo comes up **locked** by design, and that is the intended, secure behaviour, not a gap to paper over.

`HEZO_MASTER_KEY` / `--master-key` are real and may be documented as the mechanism for a **single, non-interactive startup** (e.g. passed inline to one invocation) — but never as a place to *persist* the key. Whenever you touch a surface that mentions unattended unlock, frame it as "unlock from the browser" or "pass it for one startup without saving it," and warn against writing the phrase to disk. Treat "add your master key to the env file so reboots unlock unattended" as a security bug to fix, not a convenience to document.

### Credentials

Agents reference secrets by **placeholder**, never by literal value. The pattern is `__HEZO_SECRET_<NAME>__` in any header or URL the agent emits; the egress proxy substitutes the real value at request time. Background and full lifecycle: `.dev/architecture.md` (§ Credentials, egress & secrets).

When you wire a new agent integration that needs a credential:

- Don't put the real value in the agent's container env. Put the placeholder there. The real value lives in the `secrets` table with `allowed_hosts` constraining which upstream hosts the substitution may fire for.
- If the agent needs to obtain a raw secret at runtime (API key, webhook secret, …), it calls `request_credential` (MCP tool) and the human pastes the value via the task thread. HTTP-auth kinds (`api_key`, `oauth_token`, `github_pat`) MUST pass `allowed_hosts` — the tool rejects the request otherwise, since an unscoped secret either can't be substituted or leaks into every host. Agents should request the narrowest scope and shortest expiry the provider offers, and prefer a registered connector (`register_connector`) when one covers the provider.
- For GitHub repo access, the human connects a GitHub OAuth account once via device flow on the project's Connections page; subsequent repos pick that connection. The OAuth token is used for REST API calls only (listing orgs/repos, creating repos). Repo clone/fetch/push runs over **SSH** (`git@github.com:owner/repo.git`) authenticated by the project's Ed25519 key — the same key used for commit signing. On first OAuth connect the public key is auto-registered on the connecting user's GitHub account as both a *signing* key (commits land as Verified) and an *authentication* key (so SSH git ops work). Both host-side and in-container git ops go through the existing `SshAgentServer` — host via its Unix socket directly, container via the per-run socat bridge. Full design: `.dev/architecture.md` (§§ OAuth, GitHub & connectors; SSH signing & git).
- For SaaS MCPs requiring OAuth (DatoCMS, Linear, …), the operator starts the auth-code flow from the MCP-connection form. The resulting `oauth_connection_id` is linked to the `mcp_connections` row; the injector emits a placeholder Authorization header and the egress proxy substitutes at request time.

The egress proxy does not audit substitution events — no per-request `audit_log` row is written. Secret values are never logged regardless; substitution failures surface to the agent as explicit HTTP errors.

### Route authorization

Every route enforces authorization — never trust URL params alone.

- Routes with `:projectId` resolve the project to its backing team and verify the authenticated user has access to that team per request (board users can be in multiple teams; an agent JWT carries `teamId` and must match the resolved team). Project resolution + access check run once in `requireProjectAccessMiddleware`, which exposes `c.var.projectId` and `c.var.teamId`.
- **API keys authenticate the MCP surface only** — they are rejected on REST (and the WebSocket) in `authMiddleware`. An approved key is instance-scoped and admin-equivalent across every project/team; `authorizeScope`/`authorizeTeam` in `mcp/tools.ts` let it act anywhere (it must name the `project` on project-scoped tools). The api-keys management routes — list/mint/approve/revoke — stay human-superuser-only (`requireSuperuser`), so a key can never mint or approve keys; self-register + status polling are public, token-keyed endpoints.
- Nested resources (`:taskId`, `:secretId`, `:commentId`, …) verify the resource belongs to the parent `:projectId` (and its team) via WHERE/JOIN before any read or write.
- Global endpoints (no `:projectId` in path) still verify the authenticated user has access to the resource's team.
- WebSocket subscriptions verify team membership matches the room.
- MCP tool handlers enforce the same authorization as their REST equivalents — pass caller identity in and validate team access.

## AI runtime hooks

Every agent run is gated by a completeness check that fires when the assistant decides to end its turn. The hook blocks the stop when the agent is bailing on failing tests, calling problems "out of scope", deferring with "leave it for later" without filing a sub-task or self-comment, abandoning a plan it announced in the task thread without explicitly revising it there, ending the run with a handoff or active @-mention that was never posted to the task thread as a comment (a final message is delivered to no one), marking a ticket done on its own review while an approval the thread established as required (the admin's final approval or a named approver's sign-off) was never granted — an inherited approval-chain requirement a rework/detour does not discharge — or otherwise stopping with unfinished work. The block keeps the same headless exec alive for another turn — the run-completion path (`HeartbeatRunStatus.Succeeded` on exit 0) doesn't change. A run legitimately parked on input it can't obtain itself — an `@admin` question, a `request_credential`, or a filed hire proposal / pending approval awaiting an admin decision, with the task left non-terminal — is *allowed* to stop; the admin's reply or resolution auto-wakes it (a hire resolution queues a `hire-resolved:<id>` wakeup), so it need not spin re-reporting no work. Every runtime's judge also short-circuits on `stop_hook_active` — allowing the stop once the turn has already been continued once — so a persistent verdict can't loop the same exec indefinitely: the Codex/Gemini scripts guard it in code (`if (input.stop_hook_active) return`), and the Claude Code prompt hook carries the same instruction since its `$ARGUMENTS` (the raw Stop-hook input JSON) includes the flag — alongside the agent's final message in `last_assistant_message`, which the prompt points the judge at explicitly so a weaker judge model evaluates the message rather than the surrounding metadata. The hook is on for every runtime that exposes a block-and-continue turn-end hook (no per-team or per-agent opt-out); the exceptions are **OpenCode** and **Grok**, which can't enforce it (see below). Independently of the judge, the specific failure of ending a run with a handoff/@-mention *only* in the final message is also caught deterministically at run completion — see the delivery net below. The judge LLM runs inside the container against the team's existing primary-provider credential, through the same egress path as any other API call.

Per-runtime wiring lives in the per-runtime MCP injectors:

- **Claude Code** (Anthropic, DeepSeek, Z.ai, Kimi per `PROVIDER_RUNTIME_ADAPTERS`): native `Stop` hook of `type: "prompt"` in a per-run `settings.json` Claude Code loads via `--settings`. Claude Code itself makes the judge sub-LLM call — no helper script needed. The prompt tells the judge to allow the stop immediately when the input's `stop_hook_active` is `true` (loop parity with the command-script runtimes, so a persistent verdict can't spin the exec), and points it at the `last_assistant_message` field of `$ARGUMENTS` (the raw Stop-hook input JSON) so it evaluates the agent's final message, not the metadata blob. The judge model must be one the provider's endpoint actually serves, so for the third-party Anthropic-compatible providers (DeepSeek/Z.ai/Kimi) it **tracks the run's own selected model** (`judgeModelForProvider`) — the model the run uses is guaranteed served, so a provider model upgrade (e.g. Kimi `kimi-k2.7-code` → `k3`, picked live from the provider catalog) needs no code change — falling back to the per-provider constant (`CLAUDE_CODE_JUDGE_MODEL_BY_PROVIDER`) only when the run pins no explicit model. Anthropic is excluded and always uses its stable, cheaper Sonnet constant (its judge must not scale with the run model). The same run model likewise overrides the Claude Code subagent default (`CLAUDE_CODE_SUBAGENT_MODEL`) for those providers (`buildProviderEnv`), on the same fallback-to-constant rule. See `packages/server/src/services/mcp-injectors/claude-code.ts` and `claudeCodeProviderUsesCustomEndpoint` in `@hezo/shared`.
- **Codex** (OpenAI): native `Stop` hook of `type: "command"` in `config.toml` (Codex's `type: "prompt"` is parsed-but-skipped, so we have to run the judge ourselves). The command is a Node script written next to the config that reads Codex's StopCommandInput JSON from stdin, calls the OpenAI Chat Completions API with the judge prompt, and writes `{"decision":"block","reason":...}` to stdout when work is incomplete. See `mcp-injectors/codex.ts` and `buildCodexJudgeScript` in `stop-hook-prompt.ts`.
- **Gemini** (Google): native `AfterAgent` hook (the analogue of Stop — fires once per turn after the model produces its final response). Same command-script pattern as Codex; calls Google's Generative AI API. See `mcp-injectors/gemini.ts` and `buildGeminiJudgeScript`.
- **OpenCode** (OpenRouter, …): **no completeness judge.** OpenCode's plugin API can't block-and-continue the agent loop in headless `opencode run` — `session.idle` only fires after the loop has torn down, and a blocking `session.stopping` hook is an unmerged upstream request (sst/opencode#16626). OpenCode therefore runs with the judge omitted, the same fail-open posture used for subscription-auth runtimes. See `mcp-injectors/opencode.ts`.
- **Grok** (xAI): **no completeness judge.** Grok Build's hooks advertise `blockingEvents: ["pre_tool_use"]` only (per the CLI's own ACP handshake) — its `Stop`/`SessionEnd` hooks are passive notifications that fire *after* the agent has decided to stop and cannot block-and-continue the loop. Grok therefore runs fail-open, same as OpenCode. See `mcp-injectors/grok.ts`.
- **Kimi Code** (the `kimi_code` provider): native `Stop` hook of `type: "command"`, declared as a flat `[[hooks]]` entry in `config.toml` under `$KIMI_CODE_HOME`. Kimi's `Stop` is genuinely blockable (one of only three blockable events, with `UserPromptSubmit` and `PreToolUse`) and a blocked stop feeds the reason back as a new user message — the same continue-the-turn semantics as Codex. Two things make it unlike every other command-script runtime, and both are handled by opt-in `JudgeRuntimeSpec` fields that stay unset elsewhere: its stdin payload carries **no final assistant message** (`sessionLogLookup` reads the last one from the run's own `wire.jsonl` under `$KIMI_CODE_HOME` — the same file the usage scrape parses) and **no `stop_hook_active`** (`loopGuardFile` writes/checks a `.hezo-stop-blocked` marker in that per-run home, so the one-block ceiling is real rather than nominal). A block is emitted on all three channels Kimi documents: exit code **2** (its "intentional block"; any other non-zero is treated as a broken script and fails open), the reason on stderr, and the decision JSON on stdout. **`[[hooks]]` entries accept exactly four keys** (`event`, `matcher`, `command`, `timeout`) — the CLI refuses to load a config carrying any other, which breaks every run on the runtime, not just the hook. See `mcp-injectors/kimi.ts` and the `AgentRuntime.Kimi` entry in `JUDGE_SPECS`.

**Deterministic handoff-delivery net (independent of the judge).** The completeness judge is best-effort — an LLM, model-dependent, and (via `stop_hook_active`) it blocks at most once per run. So the specific failure of *ending with a handoff only in the final message* is also caught deterministically at run completion in `agent-runner.ts`, with no LLM in the loop. On a clean exit the runner reads the run's final assistant message from the stream parser's `getFinalAssistantMessage()` and handles three stranded forms **differently** (each checked against `task_comments` rows with `created_by_run_id = <run>`, so an agent that already posted/woke the target and merely echoed it isn't re-processed): **(1)** an **active `@`-mention** (`extractMentionSlugs` — the same extractor `fireCommentWakeups` uses, so detection == who would actually be woken) the run never posted is **delivered verbatim** as a real comment via `postAgentComment` (`comment-wakeups.ts`) — the exact insert + broadcast + `fireCommentWakeups` path `create_comment` uses — so the `@admin` inbox / agent wakeup fires; the agent wrote an explicit, unambiguous wake, so delivering it is safe, and it flips an otherwise no-op run to a success. **(2)** a **name-only address that reads as an ask** — the unlinked bold/leading-line form (`**slug** — … when you resume …`, via `detectUnlinkedTeammateAsks`) or the passive one (`Ready for @@slug review.`, via `detectPassiveTeammateAsks`), both run on the run team's roster + HQ + `@admin` and gated on directed-ask intent so a name written for emphasis/attribution is never touched — the wakes-no-one trap in either spelling — is **not** rewritten or auto-delivered (guessing intent to force a wake overreaches). `create_comment` already warns the agent interactively when it posts such a comment, but the final-message path skips that check, so the runner surfaces the **same warning in the run log** and leaves the handoff undelivered. **(3)** a **plain direct answer** (no mention, no ask) to a human who addressed this agent by **replying to** or **@-mentioning** it — the "give me the link" case, where the human asked and expects the reply in the thread but the agent left it only in its final message. When the run was woken by a `WakeupSource.Reply`/`Mention` whose waking comment (`payload.comment_id`) was authored by a human/admin (author not in `member_agents`, so agent-to-agent chatter is excluded) and the run posted no comment of its own on the task, the final message is delivered verbatim via `postAgentComment` as a reply **threaded under the waking comment** (`parentCommentId`), flipping the no-op run to success. It runs on **every** runtime, including OpenCode (which has no judge at all). This is why the one-block judge ceiling is acceptable: a stranded *active-mention* handoff and a stranded *direct answer* are both delivered, and a stranded name-only ask (bold, bare, or passive) is at least surfaced, regardless of whether the judge fired.

The judge prompt body (`STOP_HOOK_RULES` in `stop-hook-prompt.ts`) is identical across every runtime that runs it, so changes to the rules apply everywhere. Each provider has a judge-model **constant** (Sonnet for Anthropic, gpt-4o-mini for OpenAI, gemini-1.5-flash for Google, `kimi-k2.7-code` for Kimi); for the third-party Anthropic-compatible Claude Code providers (DeepSeek/Z.ai/Kimi) the constant is only the **fallback** — the judge and the Claude Code subagent default instead track the run's live-selected model, so they stay current across a provider model upgrade without a code change (`claudeCodeProviderUsesCustomEndpoint` encodes the split; Anthropic/OpenAI/Google keep their constants). A newly selected model still needs a `model_pricing` row or its runs price to $0. For the **file-mount** subscription providers (Codex / Gemini OAuth flows) the helper script has no API key in env and fails open — exits silently, the agent stops normally. **Anthropic subscription** is the exception: it runs via `CLAUDE_CODE_OAUTH_TOKEN` (a `claude setup-token` value injected as env), so Claude Code's native `type: "prompt"` judge still fires — there is no helper script to fail open.

OpenCode, Grok and Kimi Code take the task prompt as a CLI **argument** rather than on stdin (`opencode run <message>`, `grok -p <message>`, `kimi -p <message>`), so the runner sets `HEZO_PROMPT_MODE=arg` (see `RUNTIME_PROMPT_DELIVERY`) and the exec wrapper appends `"$(cat $HEZO_PROMPT_FILE)"` instead of redirecting stdin. Kimi Code additionally gets **no auto-approve flag**: `--yolo`/`--auto`/`--plan` are mutually exclusive with `--prompt`, so passing one makes the CLI reject the invocation outright; `-p` already applies the `auto` permission policy, and the injected `[permission.rules]` covers the rest.

## Cost: always priced from the table

Per-run cost is computed in `agent-stream-parser.ts`, **always** from the `model_pricing` table (`price()` via `PricingService`) using the token buckets each runtime reports (regular input, cache read, cache creation, output). Runtimes may also emit their own dollar figures (e.g. `total_cost_usd`), but those are **ignored in every parser** — they are client-side estimates from the CLI's built-in rate card, and for third-party Anthropic-compatible endpoints (DeepSeek/Z.ai/Kimi through Claude Code) that card belongs to the wrong provider entirely. The coding CLIs' only job in cost accounting is to report accurate input/output token counts; the table does the pricing. An unknown model prices to $0 — fail-low, never fail-high.

**Two runtimes report no token usage on their stdout stream, and both recover it from a file in the per-run home.** `recoverOffStreamRunUsage` in `agent-runner.ts` dispatches them and scrubs the file after parsing (each can carry the provider credential); everything downstream — the buckets, the table lookup, the fail-low-to-$0 rule — is identical to every other runtime.

- **Grok**: the per-run `--debug-file`. `extractGrokUsageFromDebugLog` parses the `process_conversation_turn` tracing spans for `input_tokens`/`output_tokens`/`cache_read_tokens`, keyed by `request_id` to dedup. The file also contains the `XAI_API_KEY` in plaintext.
- **Kimi Code**: the per-session `wire.jsonl` under `$KIMI_CODE_HOME`. `extractKimiUsageFromSessionLog` reads `inputOther`/`output`/`inputCacheRead`/`inputCacheCreation`, deduping by request id. Two rules matter: session-scoped records are **cumulative totals**, so when turn-scoped records exist only those are summed and otherwise the *last* session record is taken (never the sum); and `inputOther` is already the non-cached remainder, so unlike Codex/Grok the cached portion is **not** subtracted out of the input bucket. Field names are probed in both camelCase and snake_case — upstream ships two engine generations with duplicated logging paths, and a spelling change would otherwise silently price every run at $0.

## Container toolset & installing packages at runtime

The agent-run container (`docker/Dockerfile.agent-base`) pre-bakes the common toolset — `git`, `curl`/`wget`, `jq`, `unzip`, `file`, `python3` + `pip3`, ImageMagick, `openssh-client`, Node + `npm`/`bun`, and the AI coding CLIs. Anything not pre-baked installs cleanly at runtime: the container runs as the non-root `node` user with **passwordless `sudo`**, and both `apt` and binary/package downloads route through the per-run egress proxy with the Hezo CA already trusted via `NODE_EXTRA_CA_CERTS` and the system bundle — so `sudo apt-get install -y <pkg>`, `pip3 install <pkg>`, and `npm i -g <pkg>` all work with no TLS special-casing. Browser automation (Playwright) is the canonical worked example:

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
