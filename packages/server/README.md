# @hezo/server

Hezo Server — main application server.

## Tech

- [Hono](https://hono.dev/) HTTP framework
- [PGlite](https://electric-sql.com/docs/api/pglite) embedded Postgres

## Default Port

`3100` (override with `PORT` env var)

## CLI Flags

| Flag | Description |
|------|-------------|
| `--port` | HTTP listen port |
| `--data-dir` | PGlite data directory |
