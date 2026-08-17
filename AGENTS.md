# Agent Guidelines

**This file carries rules, not rationale, in as few words as leave them unambiguous.** No incident narratives, no "this exists because PR #N", no defence of a rejected alternative, no example that only re-illustrates the rule above it. Cut every hedge, restatement and connective carrying no constraint. Rationale goes in `.dev/architecture.md` (or another `.dev/*.md`); link to it in one clause only when the rule can't be applied without it. A rule needing a paragraph of context is two things: the rule here, the context in `.dev/`. **Edit every entry down after writing it** — if a sentence can go without losing a constraint, it goes.

**Where a piece of writing goes** — decided by who needs it and when, not by what it is about:

| Writing | Home |
|---|---|
| A rule that binds anyone, or that someone could break without knowing they were in that territory | **this file** |
| The how-to for one kind of work — authoring an adapter, writing a migration | a `.dev/<doing-the-thing>.md` guide, summarized here as its trip-wires plus a link |
| What the system *does* — data model, run pipeline, mechanisms | `.dev/architecture.md` |
| Anything a Hezo user or operator reads | `docs/` |

**A new specialized area is born as a `.dev/` guide, not as a new section here.** This file reached 150K by accreting them; the summary it keeps is only the rules that bind someone who does not yet know they are in that territory. When you add a guide, link it from the matching section, list it in the `.dev/` bullet under **Layout**, and add its row to **Mirrored surfaces**. **When a surface list or a seam home would go inline, extend the table that already holds it** rather than writing a thirteenth restatement in prose.

## Commands

- `bun run test` — server vitest + server Bun-native (`bun test`) + web component + shared unit + Playwright, in that order.
- `--skip-browser` drops Playwright (~30s); `--browser` runs it alone.
- `--pattern <substring>` filters by file path across all tiers; `--package <server|web|shared>` restricts the vitest run; `--concurrency <n>` sets workers (default 10); `--shard <i>/<n>` runs one shard; `--bail` stops on first failure.
- `--coverage` instruments the vitest and Bun tiers. Each vitest tier writes `packages/<pkg>/coverage/coverage-final.json`; the Bun tier writes `packages/server/coverage-bun/lcov.info` (lcov only, no branch data). Composes with `--package`/`--shard`. Playwright is not instrumented.
- `bun run test:daytona` — conformance suites against a live Daytona account (`HEZO_DAYTONA_API_KEY`). Manual only: it provisions billable sandboxes and refuses to start under `CI`. `bun run test:live` runs every `test/live/` fixture.
- **`describeAgentCliConformance` runs the provider × CLI matrix, gated per key.** `liveModelProviders()` (`test/conformance/fixture.ts`) pairs every provider a key was supplied for with every runtime `providerRuntimes` says it can drive, so one key buys every CLI that provider reaches and a runtime added in production is covered with no edit. Keys are `HEZO_<PROVIDER>_API_KEY` (`ANTHROPIC`, `OPENAI`, `GOOGLE`, `DEEPSEEK`, `ZAI`, `OPENROUTER`, `KIMI`, `XAI`); the local runners take `HEZO_OLLAMA_BASE_URL` / `HEZO_LMSTUDIO_BASE_URL` instead, and need an address *the container* can reach. `HEZO_LIVE_MODEL_<PROVIDER>` overrides the pinned model. **Subscriptions are covered too**: `HEZO_<PROVIDER>_SUBSCRIPTION_FILE` points at a file holding the blob (a path, not the value - two of the three are multi-line JSON, and it keeps a live credential out of the process list), validated with production's own `validateSubscriptionBlob` and materialised by `buildSubscriptionMount`, so Anthropic's env-var delivery and Codex/Gemini's mounted-file delivery are both exercised. **Codex rotates its refresh token and the suite does not write the rotation back**, so a run there leaves the supplied credential stale - it warns at run time rather than refusing. Each pairing provisions a container and bills a completion, so supply only the keys you mean to spend. Both fixtures use it — Docker (`test/bun/`) is the cheap path and needs no Daytona account.
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
  - `bun run --cwd packages/server build:marketplace` regenerates the committed JSONs — run it after editing any `agents/<team>/` prompt or `team.json`, **or any `agents/_partials/` file a team role resolves** (`bun run dev` does it automatically). It auto-increments `version` on a content-hash diff (excluding version/changelog/keywords); add a `changelog` entry per bump. **Commit the regenerated `marketplace/teams/*.json` + `index.json`** — production fetches them from GitHub raw, and `marketplace-build.test.ts` fails on a stale or missing file. It is deliberately outside `bun run build`, so a local build passes with the JSONs stale and only CI catches it.
  - `build:teams` bundles the committed JSONs into the gitignored `teams-bundle.json`, the offline fallback only. At runtime `services/marketplace.ts` prefers the repo folder in dev (`HEZO_MARKETPLACE_DIR`), then GitHub raw (`main`, then `master`), then the bundle.
  - Only the **Blank** template is seeded into the DB. Marketplace teams are never persisted as `team_templates`/`agent_types` rows — they are provisioned directly with `agent_type_id` null. Launch from one via `POST /api/projects {marketplace_slug}`; add to an existing project via `POST /api/projects/:projectId/marketplace-team`.
- `skills/<slug>.md` — the default global skills (flat dir, filename = slug; frontmatter `name`/`description`/optional `source_url`), bundled by `build:skills` into `skills-bundle.json`. A fresh instance auto-installs the catalog on first boot (`installDefaultSkillsIfFreshInstance`, before `seedDefaultTeam`, gated on HQ not existing); an upgrading instance is **not** auto-seeded — the operator installs missing ones from the global Skills page (`GET /api/skills/defaults`, `POST /api/skills/defaults/install`). A per-slug `system_meta` marker (`default_skill_shipped_hash:<slug>`) prevents re-offering a deleted default or clobbering a user-owned same-slug skill. Keep `skills/ATTRIBUTION.md` accurate (it's excluded from the bundle). Content rules: domain-neutral where the category allows, single self-contained document, short `description`, "task" never "ticket". `default-skills.test.ts` enforces the mechanical half; domain-neutrality is on you.
- **Where guidance goes — pick by reach.**
  - `SHARED_INSTRUCTIONS` (`services/template-resolver.ts`) resolves at **runtime** and reaches **every agent on every run**, including runtime hires and every team type. Anything every agent must have goes here, never copied into each role doc. Content must be domain-neutral.
  - `agents/_partials/<group>/<name>.md` resolves at **build/load time only** (`db/resolve-partials.ts`, baked in by `build:agents`) and reaches only seeded built-in agents. Use for guidance shared by a subset of seeded roles; changing one requires re-running `build:agents`.
  - `agents/<template>/*.md` — one seeded role's own prose.
  - Decision rule: every agent incl. future hires → `SHARED_INSTRUCTIONS`; a subset of seeded roles → a partial; one role → that role's `.md`.
- **Agent-facing prose is written to one register — `.dev/writing-agent-prompts.md`.** ASD-STE100 plus Zinsser, adapted for LLM prompts; `agents/influencer/content-writer.md` is the reference doc. Trip-wires: one rule per bullet, ≤25 words a sentence, ≤60 words a bullet, imperative and second person, and the bold lead reads alone. State a rule **once**, in the highest-reaching surface that covers its audience (the reach rule above) — a role doc never restates `SHARED_INSTRUCTIONS`, and a `Responsibilities` list never restates the workflow below it. No rationale unless the rule cannot be applied without it, no example that only re-illustrates, one consequence clause per rule. **No Hezo symbol, path or precedent in `agents/<team>/**` or a partial reaching one** — those ship into other people's repositories; generic `AGENTS.md` and `hezo/<TASK>` stay. The machine-checkable half is `checkPromptStyle` (`@hezo/shared`), enforced at commit time by `scripts/check-prompt-style.ts` and at runtime on every authoring surface.
- `.dev/` — internal engineering docs and the home for the rationale this file omits. `architecture.md` is the consolidated **descriptive** reference; alongside it sit the **prescriptive** guides — `adding-a-container-backend.md`, `adding-a-chat-channel.md`, `writing-migrations.md`, `writing-agent-prompts.md` — and `bun-issues.md`, the register of the production runtime's divergences from Node. Which of them a given piece of writing belongs in is the routing table at the top of this file.
- `docs/` — user-facing documentation rendered at `https://hezo.ai/docs`. `docs/reference/cli.md` is hand-written; `docs/reference/mcp-api.md` is **generated** from the MCP tool registry — never hand-edit it. After touching an MCP tool, author its return shape / authorization note in `TOOL_DOC_META` (`mcp/mcp-reference.ts`) and rebuild with `bun run --cwd packages/server build:docs`.
  - The full `docs/` tree is bundled into the binary and injected into the CEO real-time chat. Each `.md` carries `title`/`order`/`section` frontmatter; `bundle-docs.ts` writes `docs-bundle.json`, `docs-bundle.ts` organises it, `template-resolver.ts` swaps it in at the `<!-- HEZO_DOCS -->` marker in `agents/_instance/ceo.md`. **Keep the marker; never copy doc prose into the role doc.** Adding/removing a page or changing frontmatter must keep `docs-bundle.test.ts` green.
- **The agent-facing surfaces are generated — update the generator and its test, never a static file.** Which surfaces mirror an MCP tool or REST route is in **Mirrored surfaces** below. Scope: `SKILL.md` (`mcp/skill-file.ts`, served at `GET /SKILL.md`) covers the MCP surface plus a pointer to `HEZO_DOCS_URL` — not the REST API, and not the docs themselves, which reach agents via the CEO chat bundle instead.
- **A REST route and its MCP-tool twin must be named in parallel**, wherever both expose the same resource/action. Not every route needs a tool (`routes/connectors.ts` documents a deliberate no-twin case).
  - **The resource noun is mandatory and must match on both sides** (kebab-case in the path, snake_case in the tool): `GET`/`PATCH /api/projects/:projectId/custom-prompt` ↔ `get_project_custom_prompt`/`update_project_custom_prompt`. No exceptions.
  - **The verb mapping is the default, not a law:** `GET`→`get_`/`list_`, `PATCH`/`PUT`→`update_`, `POST`→`create_`, `DELETE`→`delete_`/`remove_`. These departures are correct — do not "fix" them: `read_project_doc`/`write_project_doc`, `apply_marketplace_team`, `add_connector`/`register_connector`, `resolve_approval`, `full_text_search`. Follow the table for a new pair unless a comment says why a departure reads better.
  - Rename both sides in the same change. Only internal identifiers a route reads from (DB columns, enum values, template variables) may keep historical names.

## Mirrored surfaces

**A fact represented in more than one place changes in all of them, in one commit — every code change ships with this pass, not a follow-up.** This table is the canonical list; when a rule elsewhere in this file says "update it in the same change", this is what it means. **Extend the table rather than restating the obligation in prose.** The last column is the one to read: where it says *nothing*, no test will catch you.

| Change | What mirrors it | Enforced by |
|---|---|---|
| MCP tool / REST route (params, response shape, auth) | `docs/reference/cli.md`, `docs/mcp/hezo-mcp-server.md`, generated `docs/reference/mcp-api.md`, the `SKILL.md` generator, `llms.txt` | `mcp-reference.test.ts`, `llms-txt.test.ts` |
| A REST route name | its MCP-tool twin (same resource noun) | **nothing - on you** |
| A user-facing string | the 11 non-English catalogs | `i18n-catalog.test.ts` |
| A team prompt or `team.json` | committed `marketplace/teams/*.json` + `index.json` | `marketplace-build.test.ts` |
| Prose in `SHARED_INSTRUCTIONS` or a role doc | the ~324 `toContain` strings quoting it (`template-resolver{,-cov-fill}`, `qa-ci-merge-gate`, `mention-handoff-prompt`, `connector-recipes-skill`, `mcp-tools`, `description-tasks`, `agent-types`, `coach`) — reword the string, never delete the assertion | the suite, loudly |
| A prompt-style rule | `packages/shared/src/prompt-style.ts`, its `{{prompt_style_rules}}` render, the authoring tool descriptions, `.dev/writing-agent-prompts.md` | `mcp-reference.test.ts` for the tool docs, **nothing for the rest** |
| A new surface that accepts an authored prompt | its `checkPromptStyle` call | **nothing - on you** |
| A new server-wired wakeup path reachable from an agent run | `created_by_run_id` on the wakeup it creates | **nothing - on you** |
| A docs page (add / remove / frontmatter) | the embedded docs bundle | `docs-bundle.test.ts` |
| A link in a `docs/` page (another page, an anchor, a repo file, an external URL) | the target it names | `docs-links.test.ts` + the `check-docs-links.ts` hook |
| A new conformance suite | `conformance/index.ts` | `conformance-coverage.test.ts` |
| A new doc- or string-bearing path | `DOC_BEARING_PATTERNS` / `STRING_BEARING_PATTERNS` | its ack-hook test |
| Container backend behaviour | `SANDBOX_AGENT_ENVIRONMENTS`, that provider's `docs/containers/remote/` page, the Containers settings UI | compile error, **new backend only** |
| A `ContainerEngine` method added or its contract changed | every adapter, the conformance suite, `.dev/adding-a-container-backend.md` | compile error for the method, **nothing for the contract** |
| Architecture (data model, run pipeline, providers, egress, SSH/git, OAuth, auth, build) | `.dev/architecture.md` | the `Docs-Checked:` trailer |
| A `.dev/` guide added, renamed or removed | the link from its section here, the `.dev/` bullet under **Layout**, this table | **nothing - on you** |
| A Bun workaround added or removed, or `BUN_VERSION` moved | its entry in `.dev/bun-issues.md` | **nothing - on you** |
| A rule this file states | its guide in `.dev/`, if one covers that area - they must not disagree | **nothing - on you** |
| CLI flag / subcommand / env var / port / default (`src/cli.ts`) | `docs/reference/cli.md`, `docs/deployment/configuration.md`, the CLI table in `packages/server/README.md`, any page showing the command | **nothing - on you** |
| A sharded, renamed or newly-required CI job | its `*-complete` rollup, a shard-unique matrix artifact name, the `main` ruleset's required checks | **nothing - on you** |
| A tool added to the container image | the toolset paragraph in `SHARED_INSTRUCTIONS` | **nothing - on you** |
| A new AI provider (`AiProvider` + `PROVIDER_RUNTIME_ADAPTERS`) | `.dev/architecture.md`, the provider docs, `model_pricing` rows, and a decision on `claudeCodeProviderUsesCustomEndpoint` | **nothing** - an unpriced model silently records $0 |
| A provider gaining a second CLI (`alternateRuntimes`) | a `ProviderRuntimeBinding` for the new pairing, declared once as a constant if two providers share it | compile error for a missing binding, **nothing for a duplicated one** |
| User-visible behaviour, a feature, the setup/onboarding flow | the relevant `docs/` page(s) | **nothing - on you** |
| **Removing** a feature | every stale reference repo-wide (`docs/**`, `.dev/`, READMEs, comments) - grep for it | **nothing - on you** |

**Verify, don't assume.** Generated surfaces have drift tests (`{mcp-reference,llms-txt,docs-bundle}.test.ts`); hand-written prose has one guard, `docs-terminology.test.ts`, checking punctuation only. Nothing checks whether prose is *true* — re-read the pages describing what you changed and confirm every concrete claim still matches the code.

**Two husky hooks run on every commit.** `.husky/pre-commit`: `bunx biome check --diagnostic-level=error .`, `bun run typecheck`, `bun run build`. `.husky/commit-msg`: `bunx commitlint --edit`, `scripts/check-docs-ack.ts`, `scripts/check-translations-ack.ts`, `scripts/check-prompts-ack.ts`, `scripts/check-docs-links.ts`, `scripts/check-prompt-style.ts`.

**`check-docs-links.ts` fails a commit staging any `docs/**/*.md` on a broken link.** Internal links (docs-to-docs incl. `#anchors`, relative paths, `github.com/hezo-ai/hezo/{blob,raw,tree}/main/<path>`) are checked across the whole tree - a rename or delete breaks *other* files' links. External URLs are probed for staged files only (7-day success cache in `.git/`); a definitive 404/410 blocks, network-shaped failures (403 bot walls, timeouts, DNS) only warn, so an offline commit passes. Fix the link, never bypass; `docs-links.test.ts` re-runs the internal check in CI.

**`Docs-Checked:` is enforced at commit time.** Any commit staging doc-bearing code (`packages/*/src/`, `packages/*/migrations/`, `agents/`, `skills/`, `docker/`, `deploy/`, `marketplace/`, `scripts/`) is rejected without a `Docs-Checked:` trailer recording the pass you did across **both** `docs/` and `.dev/`. Bare values (`yes`, `n/a`, `done`, anything under 10 characters) are rejected:

```
Docs-Checked: updated docs/reference/cli.md + configuration.md for the new --foo flag
Docs-Checked: updated .dev/architecture.md § Agent execution for the new run phase
Docs-Checked: verified docs/concepts/tasks.md and .dev/architecture.md still match; no other doc surface affected
Docs-Checked: internal refactor, no user-visible behaviour or documented surface changed
```

The trailer must be true. **Never bypass the hook with `--no-verify`.** Docs-only, test-only, merge, revert and fixup commits are exempt. Classification is tested in `docs-ack-hook.test.ts`; a new doc-bearing top-level directory goes into `DOC_BEARING_PATTERNS` in the same change.

**`Prompts-Checked:` is enforced at commit time.** Any commit staging prompt-bearing prose (`agents/`, `skills/`, `marketplace/`, `services/template-resolver.ts`) is rejected without a `Prompts-Checked:` trailer recording the pass you did against `.dev/writing-agent-prompts.md` — the register, and the check that no rule is now stated twice. Bare values under 10 characters are rejected:

```
Prompts-Checked: rewrote SHARED_INSTRUCTIONS § Delegation to the register; no rule added or removed
Prompts-Checked: deleted the duplicated AGENTS.md bullet from 6 sw-dev docs; the rule now lives in _partials/common/repo-work.md
Prompts-Checked: role-specific edit, no shared guidance restated and no rule duplicated
```

The trailer must be true. **Never bypass the hook with `--no-verify`.** Same exemptions as `Docs-Checked:`. Classification is tested in `prompts-ack-hook.test.ts`; a new prompt-bearing path goes into `PROMPT_BEARING_PATTERNS` in the same change.

**`scripts/check-prompt-style.ts` runs alongside it, and severity decides what blocks.** The rules live once in `checkPromptStyle` (`@hezo/shared`), shared with the runtime authoring surfaces and the web UI. **Errors fail the commit** — a bullet duplicated across files, a Hezo symbol in a marketplace-reaching file, a backticked project-doc filename — because each is unambiguous. **Warnings print and pass** — sentence and bullet length, hedges, intensifiers — because they are judgement calls, and a heuristic that blocks an unrelated commit is how a rule gets weakened to quiet it. Demote a noisy rule rather than adding an exemption.

## Project / team model (1:1)

A **project** is the primary unit and owns exactly one **team** (its agent roster), enforced by `UNIQUE(projects.team_id)`. The FK runs `projects.team_id → teams.id` but conceptually teams belong to projects. Reach a team through its project; address all project work by project slug (`/api/projects/:projectId/...`).

There is no per-team internal project. The only `is_internal` project is **HQ**, the one team with cross-project powers, hosting two singletons:

- **CEO** — all coordination. Project intake and first-run onboarding live in HQ; per-team setup and hiring live in that team's own project, CEO-actioned. On a new team the CEO's **initial** coherence pass runs first and blocks the Captain's planning task; later **reactive** coherence reviews go to that team's own Captain.
- **Coach** — reviews completed tasks across every project.

Project-teams get a Captain plus the roster's worker roles; rosters never include CEO/Coach. `POST /api/projects` (superuser) creates the team, project, planning task and initial CEO coherence task. The roster comes from the seeded Blank `team_templates` row or, with a `marketplace_slug`, straight from the marketplace catalog.

**Cross-team execution:** CEO/Coach are HQ members acting inside other teams' projects. A run is scoped to the **task's project team** (JWT, `HEZO_TEAM_ID`, MCP, skills, git, container) while the agent's system prompt loads from its **home** team (HQ). Auth validates the `heartbeat_runs` row, not team membership.

## Database migrations

Migrations are real, tracked, append-only and data-preserving; real instances hold real user data, so one that drops or corrupts it is a production incident. **How to author one, and its data-preservation test, is in `.dev/writing-migrations.md`.** The rules that bind before you get there:

- **Never edit a shipped migration.** `001_initial_schema.sql` is the frozen baseline. Each migration is checksummed and applied once, so an edit is logged as a warning and silently skipped on existing instances - including your own dev instance.
- **Every new migration MUST preserve existing data** (backfill, re-encode, re-key) **and MUST ship a data-preservation test** asserting both that pre-existing rows survived and that the change took effect. Not "the migration ran".
- **A schema change starts by checking for an unshipped migration to extend**, not by creating a file. A migration this branch added has been applied nowhere and is ordinary unmerged code - extend it, and merge siblings from the same PR into one file rather than stacking numbers.
- **The whole file runs in one transaction**, so `ALTER TYPE … ADD VALUE` cannot have its new value *used* further down the same file.
- **Every cron or per-request query ships with its index** in the same migration.

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

On `PATCH /tasks`, `recordStatusChange`/`recordTitleChange`/`recordAssigneeChange` (`services/task-events.ts`) MUST be awaited — the client's onSettled invalidation refetches comments immediately. `recordTaskLinks` lands on a different task and stays fire-and-forget. `createWakeup`/`wakeAgentIfAssigned` are the documented exception to the fire-and-forget half: a wakeup created **inside an agent run** is awaited, because that run's own no-wake exit check reads it back before the run ends.

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
- **Extend the existing seam before adding a parallel one** — check the seam registry below first. If the seam genuinely doesn't fit, **widen it** rather than routing around it. A second stack doing an existing stack's job is how a codebase ends up with two of everything.
- **Preserve public signatures when changing internals** — keep a shared helper's exported shape and delegate inward.
- **Generate what would otherwise be hand-synced**, and guard the remainder with a drift test.
- **Follow the idiom already in the file.** A context provider copies `lib/theme.tsx`; a settings row copies `InstanceSettingsSection`; a mutation picks one of the three documented strategies. Novel structure needs a reason beyond preference.

**Don't over-rotate.** Extract on the second *real* occurrence, not the first imagined one.

### Seam registry

Before writing a helper, check whether it already has a home. **Extend the seam; never add a parallel one** — and extend this table when you add one, rather than naming the home inline somewhere else.

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
| A chat platform | `ChatChannelAdapter` (`services/chat-channels/`) |
| A host-side call to a repo's git host, with that repo's own credential | `resolveRepoGitHub` (`services/repo-github.ts`) - returns a verdict, never an upstream body |
| "Did this execution strand a handoff?" | `detectNoWakeExits` (`services/comment-wakeups.ts`) |
| "Who did this run notify without writing a comment?" | `created_by_run_id` on `agent_wakeup_requests` |
| Which rows of a task thread a reader wants | `packages/shared/src/task-thread.ts`, SQL via `lib/comment-filters.ts` |
| "May an uncredentialed hosted MCP reach a run?" | `probed_at IS NOT NULL AND probe_error IS NULL`, written only by `discoverConnectorMethods` (`services/connectors/method-discovery.ts`) and read through `SAAS_CREDENTIALED_SQL` (`services/connectors/connections.ts`) |
| "Is this run failure worth another attempt?" | `classifyRunFailure` (`services/run-failure-classification.ts`) - unrecognised is permanent, and no row may name a backend |
| Waking the assignee after an assignment write | `wakeAgentIfAssigned` (`services/wakeup.ts`) |
| "May this caller move this task's assignee?" | `assertNoBlockingRun` (`lib/reassign-guard.ts`) - not the one-run-per-task check, which is `isTaskBusyInDb` (`services/run-concurrency.ts`) |
| Serialising async work per key, with or without a bound | `lib/keyed-lock.ts` - `withKeyedLock` for a scope, `acquireKeyedLock` when the wait needs a `signal`/`timeoutMs`. Each family owns its own `KeyedLockRegistry`; never a second mutex |
| Fire-and-forget work | `trackBackground()` (`lib/background.ts`) |
| Paging (lists and large content) | `mcp/paging.ts` |
| Shared enums, constants, validation run on both sides | `@hezo/shared` (`types/common.ts`) |
| An instance setting | `routes/instance-settings.ts` + the `system-meta` helpers |
| Date formatting | `packages/web/src/lib/format-date.ts` |
| Duration formatting (a settled figure, not a live tick) | `formatDuration` (`packages/web/src/lib/format-duration.ts`) |
| A per-bucket stacked chart, and its axis/tooltip formatting | `StackedSeriesChart` + `chart-format.ts` (`packages/web/src/components/charts/`) |
| A dropdown panel's vertical side + height clamp | `usePanelPlacement` (`hooks/use-panel-placement.ts`), pure math in `lib/panel-placement.ts` |
| An optimistic mutation | `useOptimisticMutation` (`hooks/use-optimistic-mutation.ts`) |
| A server test context | `createTestContext()` (`test/helpers/context.ts`) |
| A migration test | `createDataPreservationHarness()` (`test/helpers/migrate.ts`) |
| A component test | `renderApp()` + `seed*()` (`packages/web/test/helpers/`) |
| A complete test double | `createStubDocker()` (`test/helpers/app.ts`) - never a hand-rolled partial |

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
- **A batch tool pages too, by item index.** Return as many results as fit plus a `next_index` cursor rather than rejecting the call. Always emit at least one item so the cursor can't stall, truncating a single oversized item rather than dropping it. Declare the array parameter as `batchArrayParam` on the tool's own `tool(...)` registration so the `result_too_large` guard can compute a concrete "retry with at most N items".
  - **Chunk to `MCP_BATCH_CHUNK_TARGET_BYTES`, not to the admission cap.** A raised `resultByteLimit` on a registration exists so one inherently-large resource isn't rejected; it is the wrong budget to fill when you control how many items go in.
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

### Bun runtime constraints

Bun is the production runtime and diverges from Node in ways that fail silently rather than throwing. **What we work around, what we are exposed to, and what was checked and cleared: `.dev/bun-issues.md`.** What binds before you get there:

- **The shipped runtime is the CI pin (`BUN_VERSION`), not your local Bun** — the compiled binary embeds the Bun that built it. A fix on Bun's `main`, or in a release above the pin, is not a fix we have. Moving the pin is a production-runtime change: re-read that file and drop what it resolves.
- **Never pass `lookup` to `http(s).request`** — the pinned runtime throws before sending on Node's documented scalar callback form. Resolve first, dial the literal, and pass the hostname as `servername` and `Host`; that also keeps the checked address the dialed one.
- **A Bun workaround carries a comment saying what was measured**, and survives until its upstream fix is in the pinned release. Never delete one as redundant without checking that entry.
- **Accept both spellings of a DNS error code** — Bun surfaces c-ares codes (`ESERVFAIL`, `ETIMEOUT`) where Node surfaces getaddrinfo ones.
- **A resolved `fetch` promise is not proof of a complete body** — a mid-transfer stream error resolves with truncated data. Verify what you fetched.

### Container backends

Every backend - local Docker, a third-party sandbox service - sits behind one seam, `ContainerEngine` (`services/sandbox/types.ts`). **Authoring or changing an adapter: `.dev/adding-a-container-backend.md`.** Five rules bind every caller, not just adapter authors:

- **Nothing above the seam may learn which backend is in use** - no provider name in a conditional, no provider-shaped field on a shared type, no "if remote". A backend needing host-side work gets a seam method every backend answers, never a branch at the call site. Ask what *kind* of backend it is (`SANDBOX_BACKEND_KIND` in `@hezo/shared`), never which one.
- **Take `SandboxBackendHolder.engine`, never a concrete engine.** The backend is switchable at runtime, so a captured reference keeps driving the one the operator just left. `instanceof` against the holder is always false, so such a branch silently stops running rather than failing.
- **Container-management logic is backend-agnostic; only its transport is adapter-specific.** Lifecycle, pooling, capacity, allocation, measurement and enforcement are written once, above the seam or in `services/sandbox/`. What a provider's API costs, spells or refuses is absorbed inside that provider's adapter - a ceiling constant, a rounding rule, a retry, a rendered `runuser`. Code that cannot be written without knowing the backend means the seam is missing a method.
- **An in-container script and its parser live together in `sandbox/proc-scripts.ts`**, never in an adapter and never imported from one. Each adapter runs them over its own transport. An adapter may read its own control plane where that is cheaper (local Docker takes memory from the daemon), but must return the same quantity - `describeContainerBackendConformance` proves it.
- **Every seam method is required of every backend.** `null` means "no answer this tick" and leaves the last value alone; it never means "this backend does not do that", and no capability flag may gate one. A backend that cannot answer is unsupported, not a second code path.

Catch violations by grepping the shape, since `instanceof` carries no provider name:

```sh
grep -rn "instanceof DockerClient\|instanceof DaytonaEngine\|=== SandboxBackend\.\|!== SandboxBackend\." \
  packages/server/src packages/web/src --include=*.ts --include=*.tsx
```

Hits are legitimate **only** where a provider is constructed or labelled; a hit on the run path is always a bug.

### Chat channel adapters

External chat avenues to the CEO sit behind a channel-adapter abstraction plus registry in `services/chat-channels/`. **Adding one: `.dev/adding-a-chat-channel.md`.** What binds anyone who touches this area:

- **The core is channel-agnostic and stays that way.** The manager, both ingest paths, the generic webhook route and the conversation/identity schema resolve a channel only through the registry, never by branching on a platform name. If a new channel forces a change there, close the gap in the abstraction instead.
- **One home surface per thread, and replies go where the turn was asked.** No adapter creates or mirrors threads on another channel.
- **Channel-specific settings live in `chat_channel_configs.metadata` (jsonb) - never a per-channel column.** Bot tokens go in the `secrets` vault and are decrypted in-process by trusted server code, not via the agent egress proxy.

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
- For GitHub repo access, the human connects an OAuth account once via device flow on the project's Connections page. The OAuth token authenticates REST calls and the git transport: clone/fetch/push run over HTTPS with the token as a `__HEZO_SECRET_*__` placeholder the egress proxy substitutes. The project's Ed25519 key signs commits only, reached through `SshAgentServer` over the per-run bridge; on first connect its public half is registered on the connecting user's account as a signing (and authentication) key.
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

**The judge is for task runs only — the CEO chat passes `stopJudge: false`** (`buildRuntimeInvocation` → `McpAdapterContext`), and an adapter honouring it drops the hook and its judge script together. Every rule the judge carries is about abandoning task work, and it reads only the final message; a chat turn has no task, and its final message is the reply already delivered to the operator. **Do not add a judge to a new non-task execution path** on the assumption it can only help: it costs a round trip per turn and, on a block, a whole extra turn spent on a task that does not exist. What such a path can genuinely strand — a handoff in a comment it posted — belongs to the structural layers below, which do run for chat.

Wiring lives in `services/mcp-injectors/<runtime>.ts`, specs in `JUDGE_SPECS`, the shared prompt body in `STOP_HOOK_RULES` (`stop-hook-prompt.ts`) — one body, so a rule change reaches every runtime. Where a runtime's native hook can run the judge itself the injector writes a prompt hook; otherwise it writes a helper script that calls the provider API. What you must know per runtime is only the constraint that bites:

| Runtime | Judge | Constraint |
|---|---|---|
| Claude Code | native prompt hook | Judge model **tracks the run's own selected model** for every provider `claudeCodeProviderUsesCustomEndpoint` covers, falling back to the per-provider constant only when the run pins no model. Anthropic is excluded and keeps its cheaper constant. The same run model overrides `CLAUDE_CODE_SUBAGENT_MODEL` for those providers. |
| Codex | helper script | Its `type: "prompt"` is parsed-but-skipped — the hook must be `type: "command"`. |
| Gemini | helper script | The Stop analogue is `AfterAgent`, not `Stop`. |
| Kimi Code | helper script | `[[hooks]]` entries accept **exactly four keys** (`event`, `matcher`, `command`, `timeout`) — any other makes the CLI refuse the whole config, breaking every run on the runtime. Block via exit code **2**; any other non-zero reads as a broken script and fails open. Its stdin payload carries neither the final assistant message nor `stop_hook_active`, so the spec opts into a session-log lookup and an on-disk loop-guard marker. |
| OpenCode | **none** | Its plugin API can't block-and-continue in headless mode. Fails open. |
| Grok | **none** | Its hooks block only on pre-tool-use; Stop is a passive notification. Fails open. |

**Two structural layers sit alongside it, and neither reads prose.** Every text-classifying check above needs new vocabulary for each new phrasing that strands a handoff, which is how `lib/mentions.ts` accumulated one positional branch per incident. The two below need none, and are the preferred place to strengthen this area:

- **The wake receipt.** `create_comment` / `update_comment` always return `wake: { woke, named_not_woken }` — who the write actually notified, and which roster teammates it names without notifying (a passive `@@slug`, or a bare/bold name in an addressing position). It is built inside `fireCommentWakeups` at the points wakeups are created, so it can never drift from the delivery it describes. It is a **fact about the write, not an advisory that fires when a heuristic guessed right**, so it stays true for phrasings no detector recognises; `SHARED_INSTRUCTIONS` tells agents to check it after any comment that hands work over. This is parity with the web composer's long-standing "Wake:" preview for human authors.
- **The no-wake exit check** (`detectNoWakeExits` in `comment-wakeups.ts`, called by `agent-runner.ts` after the net and by the chat's `runTurn`). An execution that ends having woken **nobody**, on a task left **non-terminal**, while **naming a teammate** in a form that notifies no one, gets a warning — a run-log line for a task run, a `system` chat message for a chat turn (the operator sees it, and the CEO reads it back next turn). A chat turn judges only the comments it posted, never its reply: the reply is delivered, so nothing is stranded there. That combination is what a stranded handoff *is*, whatever words carried it, and it covers the hole the net cannot reach — the net only inspects the **final message** and `create_comment` only inspects **one comment at a time**, so nothing else looks at what a run achieved in aggregate. **The aggregate is per task, not per run** — judged run-wide, a run that woke someone on its own task could strand a handoff in a comment on another task and pass clean. Each task the run commented on is judged on its own comments, wakes and status; the run's own task is always judged, and the final message counts only there. **A teammate the run notified structurally — an assignment, a reassignment, a blocker it released — is credited run-wide and never reported as stranded**, read from `created_by_run_id` on the wakeup; mention and reply wakes are excluded from that credit, since the per-task rule already covers them.

**When this area needs strengthening again, reach for a structural signal before a phrase.** A new regex branch is the last resort, not the first: prefer reporting what the system did (the receipt), or asking a question answerable from its own state (the exit check). If a phrase genuinely is needed, it belongs as one row in `DIRECTED_ASK_RES` — the single shared ask vocabulary every gate in `lib/mentions.ts` reads — never as a new positional branch on a detector.

A newly selected judge model needs a `model_pricing` row or its runs price to $0. For the file-mount subscription providers (Codex / Gemini OAuth) the helper script has no API key and fails open silently. **Anthropic subscription is the exception** — it runs via `CLAUDE_CODE_OAUTH_TOKEN`, so the native prompt judge still fires.

A runtime is reachable by any credential configured onto it, not only by the providers that *default* to it (`ai_provider_configs.runtime` — see the provider-runtime rule in **Mirrored surfaces**). So a Moonshot credential reaches Claude Code or Kimi Code depending on the operator's choice, and anything deciding judge behaviour from the provider must take the **resolved** runtime — `claudeCodeProviderUsesCustomEndpoint` and `judgeModelForProvider` both accept it for exactly this reason.

**Deterministic handoff-delivery net (independent of the judge).** At run completion `agent-runner.ts` reads the run's final assistant message and handles three stranded forms. It runs on **every** runtime, including those with no judge, and skips anything the run already posted (checked against that run's own comments), so an echoed handoff isn't delivered twice.

1. **An active `@`-mention** the run never posted is **delivered verbatim** as a real comment via `postAgentComment` (`comment-wakeups.ts`) — the same insert + broadcast + wakeup path `create_comment` uses, detected with the same extractor, so it matches exactly who would be woken. Flips an otherwise no-op run to success.
2. **A name-only address that reads as an ask** — the unlinked bold/leading-line form or the passive one, matched against the run team's roster + HQ + `@admin` and gated on directed-ask intent so a name written for emphasis is never touched — is **not** rewritten or auto-delivered; guessing intent to force a wake overreaches. The runner logs the same warning `create_comment` gives interactively and leaves the handoff undelivered.
3. **A plain direct answer** to a human who addressed this agent: when the run was woken by a reply or mention from a human (not another agent) and posted no comment of its own, the final message is delivered verbatim, threaded under the waking comment.

**Prompt delivery has three modes** (`RUNTIME_PROMPT_DELIVERY`, threaded as `HEZO_PROMPT_MODE` and acted on by `PROMPT_DELIVERY_SH` and its twin in `docker/scripts/hezo-run-with-bridge`): `stdin` (`< $HEZO_PROMPT_FILE`), `file` (the CLI opens the path itself - Grok's `--prompt-file`, whose **value `buildRuntimeInvocation` puts in argv**, so the wrapper appends nothing), and `arg` (the prompt's text becomes one argv element - Kimi Code's `-p`). **`arg` is capped at 128 KiB by Linux's `MAX_ARG_STRLEN`, per argument, and a Hezo prompt clears that on its own** - so `arg` is only viable for a runtime whose system prompt travels out of band, and `assertPromptDeliverable` fails the run by name rather than letting the exec die as `Argument list too long`. The `< /dev/null` on both non-stdin branches is load-bearing: an exec's stdin is a pipe nothing closes, and a CLI that reads it hangs with no output. **A new mode or runtime needs both shell copies updated** - `agent-prompt-delivery.test.ts` runs them through the same cases, extracting the bridge's block between its `# hezo:prompt-delivery:{start,end}` markers.

**`RUNTIME_SYSTEM_PROMPT_FILE`** names, per runtime, an instructions file inside the per-run home that the CLI auto-loads; when set, the resolved system prompt is written there by that runtime's MCP injector and the prompt carries the task body alone. Only Kimi Code uses it (`$KIMI_CODE_HOME/AGENTS.md`), because it is the only runtime with no file or stdin route for the prompt. Kimi Code additionally gets **no auto-approve flag** — `--yolo`/`--auto`/`--plan` are mutually exclusive with `--prompt`; `-p` already applies the `auto` permission policy and the injected `[permission.rules]` covers the rest.

## Cost: always priced from the table

Per-run cost is computed in `agent-stream-parser.ts` **always** from the `model_pricing` table (`price()` via `PricingService`), using the token buckets each runtime reports (regular input, cache read, cache creation, output). Runtimes' own dollar figures (`total_cost_usd` and similar) are **ignored in every parser** — they are client-side estimates from the CLI's built-in rate card, which for third-party Anthropic-compatible endpoints belongs to the wrong provider entirely. The CLIs' only job in cost accounting is accurate token counts. An unknown model prices to $0 — fail-low, never fail-high. The local providers (Ollama, LM Studio) have no pricing rows by design; $0 is correct there.

**Grok and Kimi Code report no token usage on stdout**, so the runner recovers it from a file in the per-run home and **scrubs that file after parsing** — each can carry the provider credential in plaintext. Everything downstream is identical to any other runtime. Three rules for that parsing, each a trap that otherwise prices runs silently wrong:

- **Dedup by request id** — both logs repeat records per turn.
- **Cumulative vs turn-scoped.** Where a log carries session-scoped totals, sum the turn-scoped records when they exist and otherwise take the *last* session record — never the sum.
- **Know whether the input bucket already excludes cache.** Kimi's does, so unlike Codex/Grok the cached portion is **not** subtracted out. Probe field names in both camelCase and snake_case: upstream ships two engine generations with duplicated logging paths, and a spelling change would price every run at $0.

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
