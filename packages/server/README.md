# @hezo/server

Main Hezo application server. Embeds a PGlite database, runs migrations on startup, manages the master key lifecycle, and serves the REST API.

## Tech

- [Hono](https://hono.dev/) — HTTP framework
- [PGlite](https://electric-sql.com/docs/api/pglite) — embedded Postgres with filesystem persistence
- AES-256-GCM — encryption for secrets and master key canary
- [@hiddentao/zip-json](https://github.com/hiddentao/zip-json) — migration bundling

## Setup

```bash
# From the monorepo root
bun install
```

## Dev Server

```bash
bun run dev
```

Starts the server on port 3100 with hot reload. PGlite data persists at `~/.hezo/pgdata` between restarts.

## CLI Flags

| Flag | Default | Description |
|------|---------|-------------|
| `--port <n>` | `3100` | HTTP listen port |
| `--data-dir <path>` | `~/.hezo` | Data directory for PGlite and assets |
| `--master-key <key>` | — | Provide master key to unlock on startup |
| `--connect-url <url>` | `http://localhost:4100` | Hezo Connect OAuth gateway URL |
| `--connect-api-key <key>` | — | API key for centrally hosted Connect |
| `--reset` | `false` | Wipe database and start fresh |

## Master Key

The master key encrypts all secrets using AES-256-GCM. It is held in memory only — never written to disk.

**First run** (no existing database):
- If `--master-key` provided: stores a canary value and unlocks
- If no key: server starts in `unset` state — the web UI will prompt to generate or enter a key

**Subsequent runs** (canary exists in database):
- If `--master-key` provided and correct: unlocks
- If `--master-key` wrong: starts in `locked` state
- If no key: starts in `locked` state — web UI prompts for the key

**Reset**: `--reset` wipes the database directory and starts fresh.

## Migrations

SQL migrations are bundled into the binary at build time using `@hiddentao/zip-json`.

```bash
bun run build:migrations    # compress migrations/*.sql into src/db/migrations-bundle.json
```

On startup, the migration runner:
1. Creates the `_migrations` tracking table if needed
2. Loads migrations from the bundle (or filesystem in dev)
3. Applies unapplied migrations in order, each in a transaction
4. Verifies checksums of previously applied migrations

Migrations are forward-only — no rollbacks. Use `--reset` during development to start fresh.

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Returns `{ "ok": true }` |
| GET | `/api/status` | Returns `{ "masterKeyState": "...", "version": "0.1.0" }` |

## Testing

```bash
bun test
```

Tests use in-memory PGlite instances — no external database or Docker needed.

**Test helpers:**
- `createTestDb()` — fresh in-memory PGlite with base schema applied
- `createTestDbWithMigrations()` — in-memory PGlite with full migrations
- `getAvailablePort()` — allocates an ephemeral port for integration tests

## Scripts

| Command | Description |
|---------|-------------|
| `bun run dev` | Start with hot reload |
| `bun run build` | Compile TypeScript |
| `bun run test` | Run Vitest tests |
| `bun run typecheck` | Type-check without emitting |
| `bun run build:migrations` | Bundle SQL migrations |
