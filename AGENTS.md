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

## E2E Tests

End-to-end tests live in `tests/e2e/` and use Playwright. The Playwright config at root `playwright.config.ts` auto-starts all three services (server on :3100, connect on :4100, web on :5173).

E2E tests verify full-stack user flows through the browser. They are included in `bun run test` by default but can be skipped with `--skip-e2e` or run in isolation with `--e2e`.

All UI changes must include e2e tests covering the affected user flows. E2E test files use the `.spec.ts` extension and import helpers from `./helpers`. Use the `authenticate(page)` helper to bypass the master key gate in tests that don't specifically test authentication.

## Type Safety

Avoid `any` in source code. Use specific types, `unknown`, `Record<string, unknown>`, or typed generics instead. If a library lacks type declarations, install them (e.g. `@types/bun` for Bun APIs) rather than falling back to `any` or `declare const` hacks. The only acceptable place for `any` is test files where JSON response shapes are unpredictable.

## Security

Security must not be compromised when building. Never expose raw secrets, private keys, or signing keys via endpoints or logs. Use asymmetric cryptography for cross-service verification. Validate and sanitize all external input. Encrypt sensitive data at rest. Use timing-safe comparisons for signature verification.

## Implementation Phases

When completing an implementation phase, update `.dev/implementation-phases.md` to mark the phase as done with a completion date. Keep the phase content intact — just add a status line at the top of the phase section.

Every phase that adds backend functionality must include corresponding UI that allows manual browser-based testing of that functionality. No backend feature ships without a way to exercise it from the browser. The UI Designer produces mockups for each phase's UI work, and the Engineer implements both backend and frontend within the same phase.
