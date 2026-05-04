# Agent Guidelines

## Commands

- `bun run test` — all tests (unit + integration + e2e) in parallel
- `bun run test --skip-e2e` — skip Playwright
- `bun run test --e2e` — Playwright only
- `bun run test --pattern <substring>` — filter by file-path substring (works for both unit/integration and e2e; combine with `--e2e` to narrow e2e)
- `bun run test --package <server|connect>` — restrict unit/integration to one package
- `bun run test --concurrency <n>` — override worker count (default 10)
- `bun run test --bail` — stop on first failure
- `bun run build` / `check` / `check:fix` / `typecheck` / `dev`

`scripts/test.ts` is a commander CLI — it rejects unknown flags and `--` passthrough. To narrow by test name, use `test.only` / `describe.only` and revert before commit. Never call `npx playwright` or `npx vitest` directly (vitest's global `expect` clashes with Playwright outside the runner).

## Layout

- `agents/<template>/*.md` — single source of truth for agent system prompts. Each company template (e.g. `software-development/`, `blank/`) owns its own role docs. The seed in `packages/server/src/db/seed.ts` reads these at startup. Edit them directly. Hezo-specific tooling/file-paths/conventions belong here in AGENTS.md, not in role docs.
- `.dev/` — specs, schema, API, implementation plans. Keep in sync with code: describe what the system **does**, not what changed. No backwards-compat concerns pre-v1.

## Database migrations

Pre-v1: modify `packages/server/migrations/001_initial_schema.sql` in place and reset. Do not create new migration files.

## Testing

All changes ship with tests that exercise functionality (not "code runs without throwing"). Backend → unit/integration; UI → e2e. Prefer integration over heavily-mocked unit tests.

Each test file is fully isolated via `createTestContext()` / `destroyTestContext()` (`packages/server/src/test/helpers/context.ts`, `packages/connect/src/test/helpers/context.ts`) — fresh PGlite + Hono app + HTTP server on port 0.

- Use `ctx.app` / `ctx.baseUrl` / `ctx.port` — never a shared singleton, never hardcoded ports.
- No mutable state shared between files.
- Always `destroyTestContext()` in `afterAll` (resource leak otherwise).
- Pure logic tests (crypto, parsing) can call functions directly.

GitHub OAuth/repo/SSH-key tests use the local simulator at `packages/server/src/test/helpers/github-sim.ts` — set `GITHUB_API_BASE_URL` and `GITHUB_OAUTH_BASE_URL` before the test context boots.

E2E specs live in `tests/e2e/` (Playwright). Root `playwright.config.ts` auto-starts server (:3100), connect (:4100), web (:5173). Use `authenticate(page)` to bypass the master-key gate when not testing auth itself. Every UI change ships with an e2e test for the affected flow.

## Type safety

No `any` in source code. Use specific types, `unknown`, `Record<string, unknown>`, or generics. If a library lacks types, install them (`@types/*`) — don't fall back to `any` or `declare const` hacks. `any` is acceptable only in test files for unpredictable JSON.

## Build artifacts

Never commit `.js`/`.d.ts`/`.js.map`/`.d.ts.map` alongside source. Compiled output lives in `dist/`. If generated files appear under `packages/*/src/`, delete them.

## Conventions

- `commander` for all CLI argument parsing — never parse `process.argv` manually.
- Use shared constants/enums from `@hezo/shared` (`packages/shared/src/types/common.ts`) — no raw status/type strings. Add new enum values to the shared package first.
- `bunx`, not `npx`.

## Slugs vs UUIDs

Browser URLs use slugs (e.g. `/companies/test/projects/operations`). Internal IDs (DB keys, WebSocket rooms, server broadcasts) use UUIDs.

- Route params are slugs. TanStack Query keys must use the route-param slug (not a resolved UUID), so WebSocket-driven `invalidateQueries` matches.
- WebSocket rooms use UUIDs (`company:${uuid}`). `useWebSocket` takes both: UUID for subscription, slug for query invalidation.
- Server broadcasts use UUIDs.

Mixing the two — UUID in a query key, or slug in a room name — silently breaks realtime updates.

## UX

**All UI must be mobile-first and use a responsive layout.** No exceptions. Build the mobile layout first, then enhance for larger screens with `sm:`/`md:`/`lg:` — never the reverse. Desktop-only or fixed-width components are not acceptable.

Three breakpoints:

- **Mobile** (<768px): single-column, hamburger drawer, stacked fields, near full-screen dialogs, 16px padding.
- **Tablet** (768–1023px): company rail visible (60px), text sidebar hidden, 2-column form grids at `sm:`, centered modals, 24px padding.
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
- If the agent needs to obtain a credential at runtime, it calls `request_credential` (MCP tool) and the human pastes the value via the issue thread.
- For GitHub repos: the `setup_github_repo` MCP tool generates / reuses the company's single Ed25519 deploy key and prompts the human to add the public key on the named repo. SSH signing flow: `.dev/ssh-signing.md`.

The egress audit log records substitution events by **secret name** only, never the value. No-op requests (no placeholder anywhere) are not audited.

### Route authorization

Every route enforces authorization — never trust URL params alone.

- Routes with `:companyId` verify the authenticated user has access per request (board users can be in multiple companies; agent / API-key auth carries `companyId` and must match the route param).
- Nested resources (`:issueId`, `:secretId`, `:commentId`, …) verify the resource belongs to the parent `:companyId` via WHERE/JOIN before any read or write.
- Global endpoints (no `:companyId` in path) still verify the authenticated user has access to the resource's company.
- WebSocket subscriptions verify company membership matches the room.
- MCP tool handlers enforce the same authorization as their REST equivalents — pass caller identity in and validate company access.

## Implementation phases

When you complete a phase, mark it done with a completion date at the top of the phase section in `.dev/implementation-phases.md`. Keep the phase content intact. Every phase that adds backend functionality ships with UI for manual browser testing.

## Pre-v1 notes

- No backwards-compatibility concerns. Change things cleanly.
- No rate limiting yet — will be a unified middleware before v1.0.0; highest-priority targets are `POST /api/auth/token` and `POST /mcp`. Don't add rate limiting piecemeal.
