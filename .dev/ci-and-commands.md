# Commands and CI

The full flag reference for the test runner, the shape of the CI pipeline, and how to run or
diagnose one failing test. The trip-wires that bind someone who does not know they are in this
territory - a required check names a rollup and never a bare matrix job, no required job may
need a write-scoped token, a suite needing the agent image runs in the container tier, CI is
the canonical check rather than a local full run - are in `AGENTS.md`; this is the detail.

## Commands and flags

- `bun run test` — server vitest + server Bun-native (`bun test`) + web component + shared unit + Playwright, in that order.
- `--skip-browser` drops Playwright (~30s); `--browser` runs it alone.
- `--pattern <substring>` filters by file path across all tiers and is repeatable (matches are OR-ed); `--package <server|web|shared>` restricts the vitest run; `--concurrency <n>` sets workers (default: `availableParallelism()` clamped to 2..10); `--shard <i>/<n>` runs one shard; `--bail` stops on first failure. `--bun-native` / `--skip-bun-native` force the Bun tier on or off against what `--pattern`/`--shard` would select.
- `--coverage` instruments the vitest and Bun tiers. Each vitest tier writes `packages/<pkg>/coverage/coverage-final.json`; the Bun tier writes `packages/server/coverage-bun/lcov.info` (lcov only, no branch data). Composes with `--package`/`--shard`. Playwright is not instrumented.
- `bun run test:daytona` — conformance suites against a live Daytona account (`HEZO_DAYTONA_API_KEY`). Manual only: it provisions billable sandboxes and refuses to start under `CI`. `bun run test:live` runs every `test/live/` fixture.

## Live and conformance runs

- **`describeAgentCliConformance` runs the provider × CLI matrix, gated per key.** `liveModelProviders()` (`test/conformance/fixture.ts`) pairs every provider a key was supplied for with every runtime `providerRuntimes` says it can drive, so one key buys every CLI that provider reaches and a runtime added in production is covered with no edit. Keys are `HEZO_<PROVIDER>_API_KEY` (`ANTHROPIC`, `OPENAI`, `GOOGLE`, `DEEPSEEK`, `ZAI`, `OPENROUTER`, `KIMI`, `XAI`); the local runners take `HEZO_OLLAMA_BASE_URL` / `HEZO_LMSTUDIO_BASE_URL` instead, and need an address *the container* can reach. `HEZO_LIVE_MODEL_<PROVIDER>` overrides the pinned model. **Subscriptions are covered too**: `HEZO_<PROVIDER>_SUBSCRIPTION_FILE` points at a file holding the blob (a path, not the value - two of the three are multi-line JSON, and it keeps a live credential out of the process list), validated with production's own `validateSubscriptionBlob` and materialised by `buildSubscriptionMount`, so Anthropic's env-var delivery and Codex's mounted-file delivery are both exercised. **Codex rotates its refresh token and the suite does not write the rotation back**, so a run there leaves the supplied credential stale - it warns at run time rather than refusing. Each pairing provisions a container and bills a completion, so supply only the keys you mean to spend. Both fixtures use it — Docker (`test/bun/`) is the cheap path and needs no Daytona account.
- `bun run build` / `check` / `check:fix` / `typecheck` / `dev`; plus `build:compile` (host binary), `build:release` (all platforms + `SHA256SUMS`), `release`.
- **`build:*` bundle steps are `packages/server` scripts — invoke as `bun run --cwd packages/server <script>`**; there is no root alias. `build:agents`, `build:skills`, `build:teams`, `build:docs` and `build:migrations` run inside the root `bun run build`. `build:marketplace` and `build:icons` are author-run, deliberately outside `bun run build` and CI.
- `bun run build:icons` regenerates the PWA bitmaps from `packages/web/brand/icon-geometry.ts` into `packages/web/public/icons/`; needs Chromium (`bunx playwright install chromium`, or `HEZO_CHROMIUM_PATH`). Run it after editing `icon-geometry.ts` and commit the PNGs. Each `manifest.webmanifest` icon declares a **single** `purpose` (`any`, `maskable`, `monochrome`) — never a combined `"any maskable"`. The apple-touch icon is a `<link>` in `packages/web/index.html`, not a manifest entry. Keep `pwa-icons.test.ts` green rather than regenerating blind.

`scripts/test.ts` is a commander CLI: it rejects unknown flags and `--` passthrough. Narrow by test name with `test.only`/`describe.only`, reverted before commit. Never load vitest and Playwright in one process — their global `expect`s clash.

## CI structure

- CI fans `test-backend` (5 shards), `test-integration` (5, the **web** tier), `test-browser` (3, Playwright); `test-shared` is unsharded.
- **Everything needing Docker and the agent-base image runs in `test-containers`, not in a backend shard** — the three suites gating on `imageExists(hezo/agent-base:latest)` and the whole Bun-native tier. The shards pull no image and pass `--skip-bun-native`; `test-containers` names each suite in a `--pattern` and passes `--bun-native`. It rolls into `test-backend-complete`, so the required check needs no ruleset edit. **A new suite gating on that image must be added to that `--pattern` list** — left in the shards it self-skips on every run and reports green having tested nothing; `ci-container-tier.test.ts` fails when one isn't.
- **Required checks must name the `*-complete` rollup, never a bare matrix job** — `test-backend-complete`, `test-integration-complete`, `test-browser-complete`, `test-shared-complete`, `test-ui-complete` (the last two are unsharded but keep the convention). Sharding, renaming or adding a required job does three things at once: add its rollup to `.github/workflows/ci.yml`; give each matrix upload a shard-unique artifact name (`name: report-${{ matrix.shard }}`); update the `main` ruleset's required checks (`gh api repos/<org>/<repo>/rulesets` → PUT), dropping stale bare names.
- **CI must stay green on a fork PR, which runs with a read-only `GITHUB_TOKEN`** — no job may *require* a write-scoped token. `build-agent-image` computes a `published` output (`github.event_name != 'pull_request' || github.event.pull_request.head.repo.full_name == github.repository`) gating `push:` and the downstream registry login/pull. Gate any new registry write or package publish the same way, and never put a non-fork-capable job in a required check's `needs:` chain.
- `test-postgres` and `test-s3` run the external-driver legs no local `bun run test` reaches (single jobs, no rollup): `HEZO_TEST_DATABASE_URL` at a `postgres:16` service with `--package server --pattern database-` plus `bun test ./test/bun/database-pg-driver.bun.test.ts`; `HEZO_TEST_ASSET_STORAGE_URL` at MinIO with `--pattern asset-storage` plus `bun test ./test/bun/asset-s3-client.bun.test.ts`. **A change to `db/drivers/postgres.ts` or the S3 asset store is only covered once the gated leg runs** — export the env var and re-run locally.
- **Coverage merges in the `coverage-merge` job, never as a Coveralls parallel build** (coverage-v8 branch ordinals are unstable across runs, so parallel builds double-count branches). Shards upload `coverage-final.json`; `scripts/coverage/merge.ts` (`--artifacts <dir> --out coverage/lcov.info`) merges them in JSON space via `istanbul-lib-coverage` into one non-parallel build. Pure transforms live in `scripts/coverage/lcov.ts`, guarded by `coverage-lcov.test.ts`. Backend artifacts are `backend-coverage-<suffix>`, the suffix being a shard ordinal or `containers`. `reconcileBunLcovLineModel` keeps only Bun `DA` rows on lines present in the merged vitest line model.

## Running one file or one test

- **`--package ui`** runs the shared-primitive tier: every component rendered with no provider of any kind, which is the property that lets a second app draw them and the one thing the web tier (always wrapped in a catalog and a router) cannot check.
- vitest: `cd packages/<pkg> && bunx vitest run <path>`; `-t '<substring>'` filters by name, dropping `run` watches.
- Bun-native: `cd packages/server && bun test ./test/bun/<spec>.bun.test.ts` (never under vitest).
- Playwright: `bunx playwright test test/browser/<spec>.spec.ts` from the root; `--headed --debug` to step through.

## Diagnosing failures fast

- **vitest:** the failing assertion and file:line print in the summary; re-run the one file for stack traces. For an unhelpful single line (timeouts, async), add `--reporter=verbose` or a `console.log` plus a name filter.
- **Playwright:** the trace zip lands in `playwright-report/` and `test-results/` (`retain-on-failure`). Download the `playwright-report` artifact, then `bunx playwright show-report playwright-report/`.
- **CI:** `gh run view --job=<job-id> --log 2>&1 | grep -E "✘|FAIL"`.

