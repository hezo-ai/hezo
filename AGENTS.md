# Agent Guidelines

Note that dev docs (prd, schema, impl phases, etc) are in `.dev` folder.

## Commands

- `bun run test` — run all tests across all packages in parallel (unit, integration, and e2e)
- `bun run test --skip-e2e` — run only unit/integration tests (no Playwright)
- `bun run test --e2e` — run only Playwright e2e tests
- `bun run build` — build all packages
- `bun run check` — lint/format check (biome)
- `bun run check:fix` — auto-fix lint/format issues
- `bun run typecheck` — TypeScript type checking
- `bun run dev` — start dev servers

## Agent Role Docs

Agent role definitions in `.dev/agents/` are generic — they define how each role behaves across any project, not just Hezo. When updating agent role docs, write rules and system prompts that apply to any codebase. Hezo-specific tooling, file paths, and conventions belong here in AGENTS.md.

## Documentation

The `.dev/` folder contains project specifications, schema definitions, API design, and implementation plans. These docs must stay in sync with the codebase — when code changes, update the relevant docs to reflect the current state.

When updating docs:
- Describe what the system **does**, not what changed
- Don't reference what was removed, replaced, or decided against — only document what exists now
- No backwards compatibility concerns until v1.0.0 — when things change, just change them cleanly

## Database Migrations

Pre-v1, do **not** create new migration files. Instead, modify `packages/server/migrations/001_initial_schema.sql` directly and reset. The migration system applies migrations by filename — modifying the existing file and resetting the database is the cleanest approach during active development.

## Testing

All codebase changes must include corresponding tests. Backend changes require unit or integration tests. UI changes require e2e tests. No change ships without test coverage for the new or modified behavior.

Tests must actually test functionality — not just assert that code runs without throwing. If something is too difficult to mock for a unit test, write an integration test instead. Prefer integration tests over heavily-mocked unit tests.

### Test Infrastructure

Tests run via `bun run scripts/test.ts` which discovers test files across packages, sorts them longest-first using `tests/test-run-order.json` for optimal parallelism, and runs them concurrently (default 4 workers, configurable via `--concurrency N`). After unit/integration tests, Playwright e2e tests from `tests/e2e/` run automatically (skip with `--skip-e2e`, run alone with `--e2e`).

**Every test file must be fully isolated.** Use the `createTestContext()` / `destroyTestContext()` pattern in `beforeAll` / `afterAll`:

- **Server** (`packages/server/src/test/helpers/context.ts`): Returns `{ db, app, server, baseUrl, port }` — fresh in-memory PGlite + Hono app + HTTP server on random port.
- **Connect** (`packages/connect/src/test/helpers/context.ts`): Returns `{ app, server, baseUrl, port }` — fresh Hono app + HTTP server on random port.

Each context binds via Node's `http.createServer` on port 0 for automatic port allocation.

Rules:
- Never import a shared app singleton in tests — always use `ctx.app` from the test context
- Never hardcode ports — use `ctx.baseUrl` or `ctx.port`
- Never share mutable state between test files
- Always call `destroyTestContext()` in `afterAll` to prevent resource leaks
- For pure logic tests (crypto, parsing, etc.) that don't need HTTP, test functions directly

When reviewing tests, reject if:
1. Tests import a shared app singleton instead of using `createTestContext()`
2. Tests hardcode ports instead of using `ctx.baseUrl` / `ctx.port`
3. Tests share mutable state between files (each file must be independently runnable)
4. `afterAll` is missing `destroyTestContext()` (resource leak)
5. Tests that need DB or HTTP skip the context pattern

## E2E Tests

End-to-end tests live in `tests/e2e/` and use Playwright. The Playwright config at root `playwright.config.ts` auto-starts all three services (server on :3100, connect on :4100, web on :5173).

E2E tests verify full-stack user flows through the browser. They are included in `bun run test` by default but can be skipped with `--skip-e2e` or run in isolation with `--e2e`.

All UI changes must include e2e tests covering the affected user flows. E2E test files use the `.spec.ts` extension and import helpers from `./helpers`. Use the `authenticate(page)` helper to bypass the master key gate in tests that don't specifically test authentication.

## Type Safety

Avoid `any` in source code. Use specific types, `unknown`, `Record<string, unknown>`, or typed generics instead. If a library lacks type declarations, install them (e.g. `@types/bun` for Bun APIs) rather than falling back to `any` or `declare const` hacks. The only acceptable place for `any` is test files where JSON response shapes are unpredictable.

## Build Artifacts

Never commit generated build output (`.js`, `.d.ts`, `.js.map`, `.d.ts.map`) that lives alongside source files. TypeScript compiles to `dist/` — files in `src/` are source only. If generated files appear in `src/`, delete them. The `.gitignore` excludes these patterns under `packages/*/src/`.

## Conventions

- Use `commander` for CLI argument parsing in all TypeScript binaries and scripts — never parse `process.argv` manually.
- Use shared constants and enums from `@hezo/shared` (`packages/shared/src/types/common.ts`) instead of hardcoded string literals. Never use raw strings for status values, entity types, approval types, or other enumerated values in application code. If a new enum value is needed, add it to the shared package first.

## Database Transactions

Use transactions (`BEGIN`/`COMMIT`) for any operation that performs multiple writes that must succeed or fail together. Prefer transactions over `SELECT ... FOR UPDATE` — wrap the entire read-modify-write sequence in a transaction instead of locking individual rows. This applies to multi-step creation flows (e.g. creating a parent record then child records), bulk updates, and any sequence where partial completion would leave the database in an inconsistent state.

## Security

Security must not be compromised when building. Never expose raw secrets, private keys, or signing keys via endpoints or logs. Use asymmetric cryptography for cross-service verification. Validate and sanitize all external input. Encrypt sensitive data at rest. Use timing-safe comparisons for signature verification.

### Route Authorization

Every API route must enforce authorization — never trust URL parameters alone.

- **Company scoping is mandatory.** Every route that takes `:companyId` must verify the authenticated user has access to that company. Board users can be members of multiple companies, so verify membership per-request (not assumed from the token). Agent and API key auth already carry `companyId` — verify it matches the route parameter.
- **Resource ownership is mandatory.** Every route that takes a nested resource (`:issueId`, `:secretId`, `:commentId`, etc.) must verify the resource belongs to the parent `:companyId` via a WHERE clause or JOIN. Never operate on a resource ID without confirming it belongs to the target company.
- **Global endpoints must still be scoped.** Endpoints without `:companyId` in the path (e.g., approval resolution) must still verify the authenticated user has access to the resource's company before allowing the operation.
- **WebSocket room subscriptions must be authorized.** Verify the subscriber's company membership matches the room before allowing subscription.
- **MCP tool handlers must enforce the same authorization as their REST equivalents.** Pass caller identity into tool handlers and validate company access.
- **Use `timingSafeEqual` for all secret/hash comparisons.** Never use `===` to compare hashes, tokens, or signatures.

## Implementation Phases

When completing an implementation phase, update `.dev/implementation-phases.md` to mark the phase as done with a completion date. Keep the phase content intact — just add a status line at the top of the phase section.

Every phase that adds backend functionality must include corresponding UI that allows manual browser-based testing of that functionality. No backend feature ships without a way to exercise it from the browser. The UI Designer produces mockups for each phase's UI work, and the Engineer implements both backend and frontend within the same phase.
