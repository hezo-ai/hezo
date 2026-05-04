# Hezo

Self-hosted company orchestration platform for AI agents. Orchestrate teams of AI agents (CEO, Architect, Engineer, QA, etc.) to run autonomous companies under human board oversight.

## Prerequisites

- [Bun](https://bun.sh/) v1.1+

## Setup

```bash
bun install
```

## Dev Server

```bash
bun run dev
```

This starts:

1. **Hezo Server** (port 3100) — main application with embedded PGlite database
2. **Hezo Connect** (port 4100) — OAuth gateway for GitHub

The server creates its database at `~/.hezo/pgdata` on first run.

### Server CLI Flags

```bash
hezo                              # Start with defaults
hezo --port 3100                  # Custom port (default: 3100)
hezo --data-dir /path/to/dir     # Custom data directory (default: ~/.hezo/)
hezo --master-key <key>          # Provide master key for unlock
hezo --web-url <url>             # Web UI base URL for redirects (default: same origin)
hezo --reset                      # Wipe database and start fresh
```

## Testing

```bash
bun run test
```

Tests use Vitest with in-memory PGlite instances — no external database needed.

## Project Structure

```
packages/
  server/    — Main application server (Hono + PGlite)
  web/       — React frontend (bundled into the server binary at build time)
  shared/    — Shared TypeScript types and constants
```

## Key URLs

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

## Tech Stack

| Component | Technology |
|-----------|-----------|
| Server | [Hono](https://hono.dev/) (TypeScript) |
| Database | [PGlite](https://electric-sql.com/docs/api/pglite) (embedded Postgres) |
| Encryption | AES-256-GCM (master key in memory only) |
| OAuth | Hezo Connect gateway (self-hosted) |
| Monorepo | Bun workspaces + Turborepo |
| Tests | Vitest |
