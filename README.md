# Hezo

Self-hosted company orchestration platform for AI agents.

## Prerequisites

- [Bun](https://bun.sh/) v1.1+

## Quick Start

```bash
bun install
bun run dev
```

## Monorepo Structure

| Package | Description | Default Port |
|---------|-------------|--------------|
| `packages/server` | Main application server (Hono + PGlite) | 3100 |
| `packages/connect` | OAuth gateway for GitHub | 4100 |
| `packages/shared` | Shared types, constants, and utilities | — |

## Scripts

| Command | Description |
|---------|-------------|
| `bun run dev` | Start all packages in development mode |
| `bun run build` | Build all packages |
| `bun run test` | Run all tests |
| `bun run typecheck` | Type-check all packages |
