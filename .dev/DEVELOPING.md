# Developing Hezo

Contributor setup for working on Hezo itself. For agent/runtime conventions, testing
tiers, and architecture notes, see [`AGENTS.md`](../AGENTS.md) and the design docs in
this `.dev/` directory.

## Prerequisites

- [Bun](https://bun.sh/) v1.3.14+ **(required)**
- Docker (Engine on Linux, or Docker Desktop on macOS/Windows) — agents run in
  per-project containers, so the dev server needs Docker available.

## Setup

```bash
bun install
```

## Dev server

```bash
bun run dev
```

This starts:

1. **Hezo Server** (port 3100) — main application with embedded PGlite database.
2. **Hezo Connect** (port 4100) — OAuth gateway (e.g. GitHub).

The server creates its database at `~/.hezo/pgdata` on first run, and the Vite dev
server for the web UI runs on port 5173 (the production binary serves the UI itself
from port 3100).

### Server CLI flags

```bash
hezo                              # Start with defaults
hezo --port 3100                  # Custom port (default: 3100)
hezo --data-dir /path/to/dir      # Custom data directory (default: ~/.hezo/)
hezo --master-key <phrase>        # 12-word master key phrase (setup/unlock)
hezo --web-url <url>              # Public base URL for redirects (default: same origin)
hezo --reset                      # Wipe database and start fresh
```

The full, user-facing flag and environment-variable reference lives in
`docs/deployment/configuration.md`.

## Testing

```bash
bun run test
```

Tests use Vitest with in-memory PGlite instances — no external database needed. See
[`AGENTS.md`](../AGENTS.md) for the full testing guide (the four tiers, how to run a
single file or test, and how to diagnose failures).

## Project structure

```
packages/
  server/    — Main application server (Hono + PGlite)
  web/       — React frontend (bundled into the server binary at build time)
  shared/    — Shared TypeScript types and constants
  connect/   — Hezo Connect OAuth gateway
agents/      — Agent system prompts (source of truth for seeded roles)
docs/        — User-facing documentation (rendered by the website)
.dev/        — Specs, schema, API, and implementation plans
```

## Key URLs (dev)

| URL | Description |
|-----|-------------|
| http://localhost:3100 | Hezo Server |
| http://localhost:3100/health | Server health check |
| http://localhost:3100/api/status | Server status (master key state) |
| http://localhost:5173 | Vite dev server (web UI) |

## Scripts

| Command | Description |
|---------|-------------|
| `bun run dev` | Start all packages in dev mode |
| `bun run build` | Build all packages |
| `bun run test` | Run all tests |
| `bun run typecheck` | Type-check all packages |
| `bun run check` | Lint with Biome |
| `bun run check:fix` | Lint and auto-fix |

## Tech stack

| Component | Technology |
|-----------|-----------|
| Server | [Hono](https://hono.dev/) (TypeScript, on Bun) |
| Database | [PGlite](https://electric-sql.com/docs/api/pglite) (embedded Postgres) |
| Frontend | React (bundled into the server binary) |
| Encryption | AES-256-GCM (master key in memory only) |
| OAuth | Hezo Connect gateway (self-hosted) |
| Monorepo | Bun workspaces + Turborepo |
| Tests | Vitest + Playwright |
