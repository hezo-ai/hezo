# @hezo/server

Main Hezo application server. Embeds a PGlite database by default (or runs against an external Postgres via `--database-url`), runs migrations on startup, manages the master key lifecycle, and serves the REST API.

## Tech

- [Hono](https://hono.dev/) - HTTP framework
- [PGlite](https://electric-sql.com/docs/api/pglite) - embedded Postgres with filesystem persistence (default backend)
- [node-postgres](https://node-postgres.com/) - driver for the optional external Postgres backend (`--database-url`)
- AES-256-GCM - encryption for secrets and master key canary

## Setup

```bash
# From the monorepo root
bun install
```

## Dev Server

```bash
bun run dev
```

Starts the server on port 3100 with hot reload. In dev, PGlite data persists at `.hezo-dev/pgdata` in the repo root (gitignored) between restarts, isolated from a production instance; the production binary uses `~/.hezo`. Override with `--data-dir` or `HEZO_DATA_DIR`.

## CLI Flags

| Flag | Default | Description |
|------|---------|-------------|
| `--port <n>` | `3100` | HTTP listen port (env: `HEZO_PORT`) |
| `--data-dir <path>` | `~/.hezo` | Data directory for the embedded database and assets (env: `HEZO_DATA_DIR`) |
| `--database-url <url>` | - | External Postgres connection string; omit for the embedded database (env: `HEZO_DATABASE_URL`) |
| `--asset-storage-url <url>` | - | S3-compatible object storage for asset files (`s3://KEY:SECRET@endpoint/bucket[/prefix]`); omit to store assets under the data directory (env: `HEZO_ASSET_STORAGE_URL`) |
| `--sandbox-backend <name>` | `docker` | Where agent containers run: `docker` (the local daemon) or `daytona` (a managed sandbox service). A managed backend that cannot be reached is fatal at startup - Hezo never falls back to local Docker (env: `HEZO_SANDBOX_BACKEND`) |
| `--daytona-api-key <key>` | - | Daytona API key, required when `--sandbox-backend` is `daytona` (env: `HEZO_DAYTONA_API_KEY`) |
| `--daytona-api-url <url>` | Daytona's public API | Daytona API base URL, for a regional or self-hosted endpoint (env: `HEZO_DAYTONA_API_URL`) |
| `--master-key <phrase>` | - | Twelve-word master key to set up/unlock on startup (env: `HEZO_MASTER_KEY`) |
| `--web-url <url>` | same origin | Public base URL for sign-in redirects (env: `HEZO_WEB_URL`) |
| `--reset` | `false` | Start fresh (existing `pgdata` is renamed aside, not deleted) (env: `HEZO_RESET`) |
| `--no-open` | open on | Auto-open the web app in the browser on startup (on by default; skipped automatically in CI/containers/SSH/headless Linux). Disable with `--no-open` or `HEZO_OPEN=0` |
| `--log-level <level>` | `info` | Logging verbosity: `debug`, `info`, `warn`, `error` (env: `HEZO_LOG_LEVEL`) |
| `--keep-old-containers` | `false` | Keep old project containers instead of removing them, for debugging (env: `HEZO_KEEP_OLD_CONTAINERS`) |
| `--docker-socket <path>` | auto | Path to the container runtime's Unix socket. By default Hezo finds it: `DOCKER_HOST`, then the docker CLI's current context, then the well-known path for each supported runtime (Docker Engine/Desktop, Colima, Rancher Desktop, OrbStack, Lima, rootless Docker). Unix sockets only - `tcp://` and `npipe://` are not supported (env: `HEZO_DOCKER_SOCKET`) |
| `--no-egress-proxy-auth` | auth on | Per-run egress-proxy authentication. On by default: each run's `HTTP(S)_PROXY` URL carries a token the proxy verifies before substituting secrets. Only disable to unblock a runtime whose HTTP client can't send proxy credentials - the secret red line still holds (env: `HEZO_EGRESS_PROXY_AUTH=0`) |
| `--auto-install-updates` | `false` | Install staged updates automatically: gracefully restart onto a downloaded-and-verified newer release without the web UI's "Install & restart", deferring while agent runs are in flight. Only effective where in-app auto-update is available (self-managed binary, not in a container); the instance comes back unlocked - the unlock key is handed to the relaunched process in memory, never written to disk (env: `HEZO_AUTO_INSTALL_UPDATES`) |
| `--disable-telemetry` | telemetry on | Turn off the anonymous daily usage report (aggregate counts only - no names, content, or costs). On by default (env: `HEZO_TELEMETRY_ENABLED=0`) |
| `--telemetry-endpoint <url>` | `https://hezo.ai/api/telemetry` | Where the daily usage report is sent; point at your own collector to keep data in-house (env: `HEZO_TELEMETRY_ENDPOINT`) |
| `--version` | - | Print the Hezo version and exit (also `hezo version`) |

## Master Key

The master key encrypts all secrets using AES-256-GCM. It is held in memory only - never written to disk.

**First run** (no existing database):
- If `--master-key` provided: stores a canary value and unlocks
- If no key: server starts in `unset` state - the web UI will prompt to generate or enter a key

**Subsequent runs** (canary exists in database):
- If `--master-key` provided and correct: unlocks
- If `--master-key` wrong: starts in `locked` state
- If no key: starts in `locked` state - web UI prompts for the key

**Reset**: `--reset` starts fresh with an empty embedded database. The existing `pgdata` is renamed aside rather than deleted, and the containers the previous life left behind are reclaimed on the next start.

## Migrations

SQL migrations are bundled into the binary at build time as a JSON map.

```bash
bun run build:migrations    # bundle migrations/*.sql into src/db/migrations-bundle.json
```

On startup, the migration runner:
1. Creates the `_migrations` tracking table if needed
2. Loads migrations from the bundle (or filesystem in dev)
3. Applies unapplied migrations in order, each in a transaction
4. Verifies checksums of previously applied migrations

Migrations are forward-only - no rollbacks. Use `--reset` during development to start fresh.

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Returns `{ "ok": true }` |
| GET | `/api/status` | Returns `{ "masterKeyState": "...", "version": "<server version>" }` |

## Testing

```bash
bun run test
```

Tests use in-memory PGlite instances - no external database needed. The driver-conformance and external-migration suites additionally run env-gated legs against a real Postgres when `HEZO_TEST_DATABASE_URL` is set (CI's `test-postgres` job provides a postgres:16 service).

**Test helpers:**
- `createTestDb()` - fresh in-memory PGlite with base schema applied
- `createTestDbWithMigrations()` - in-memory PGlite with full migrations
- `getAvailablePort()` - allocates an ephemeral port for integration tests

## Scripts

| Command | Description |
|---------|-------------|
| `bun run dev` | Start with hot reload |
| `bun run build` | Compile TypeScript |
| `bun run test` | Run Vitest tests |
| `bun run typecheck` | Type-check without emitting |
| `bun run build:migrations` | Bundle SQL migrations |
