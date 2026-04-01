# Agent Guidelines

## Commands

- `bun run test` — run all tests across all packages in parallel
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

Tests must actually test functionality — not just assert that code runs without throwing. If something is too difficult to mock for a unit test, write an integration test instead. Prefer integration tests over heavily-mocked unit tests.

## Security

Security must not be compromised when building. Never expose raw secrets, private keys, or signing keys via endpoints or logs. Use asymmetric cryptography for cross-service verification. Validate and sanitize all external input. Encrypt sensitive data at rest. Use timing-safe comparisons for signature verification.

## Implementation Phases

When completing an implementation phase, update `.dev/implementation-phases.md` to mark the phase as done with a completion date. Keep the phase content intact — just add a status line at the top of the phase section.
