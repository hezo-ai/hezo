# MCP connections

Persistent registration of MCP servers (SaaS HTTP and local stdio) made available to every agent run inside a company / project. Persisted in `mcp_connections` so registration survives container rebuild.

## Schema

```sql
CREATE TYPE mcp_connection_kind AS ENUM ('saas', 'local');
CREATE TYPE mcp_install_status AS ENUM ('pending', 'installed', 'failed');

CREATE TABLE mcp_connections (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id      UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    project_id      UUID REFERENCES projects(id) ON DELETE CASCADE,
    name            TEXT NOT NULL,
    kind            mcp_connection_kind NOT NULL,
    config          JSONB NOT NULL DEFAULT '{}'::jsonb,
    install_status  mcp_install_status NOT NULL DEFAULT 'pending',
    install_error   TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (company_id, project_id, name)
);
```

`project_id NULL` means company-wide. A project-scoped row with the same name shadows the company-wide one for runs in that project — useful for swapping a sandbox MCP server in dev while production agents use a different one.

## Config shapes

`kind = 'saas'`:

```json
{
  "url": "https://mcp.exa.ai/mcp",
  "headers": {
    "x-api-key": "__HEZO_SECRET_EXA_API_KEY__"
  }
}
```

Header values may contain `__HEZO_SECRET_*__` placeholders. The egress proxy substitutes them at request time exactly the same way it substitutes any other header. SaaS rows install instantly: `install_status='installed'` on insert.

`kind = 'local'`:

```json
{
  "command": "/workspace/.hezo/mcp/filesystem/node_modules/.bin/server-filesystem",
  "args": ["/workspace"],
  "env": { "FOO": "bar" },
  "package": "@modelcontextprotocol/server-filesystem"
}
```

Local MCPs default to `install_status='pending'` and are skipped from agent runtime descriptors until something marks them `installed`. The on-demand installer that runs `npm install` / `uv tool install` against the project workspace is currently deferred — the descriptor + dispatch path is in place and exercised by tests, but landing automatic install is a follow-up phase.

`env` values may contain `__HEZO_SECRET_*__` placeholders. They are passed through to the spawned MCP process verbatim; that process's outbound HTTPS calls still go through the egress proxy and trigger substitution there.

## How agents register MCPs

Three MCP tools, callable by board / api-key / agent auth:

- `list_mcp_connections({ company_id, project_id? })`
- `add_mcp_connection({ company_id, project_id?, name, kind, config })`
- `remove_mcp_connection({ company_id, id })`

A REST surface mirrors them for board UIs:

- `GET /api/companies/:companyId/mcp-connections?project_id=...`
- `POST /api/companies/:companyId/mcp-connections`
- `DELETE /api/companies/:companyId/mcp-connections/:id`

## How runs see MCPs

`agent-runner.buildRunContext` calls `loadMcpConnectionDescriptors(db, companyId, projectId)` and merges the result into the descriptor list **after** the built-in `hezo` descriptor. Each runtime adapter (Claude Code, Codex, Gemini) translates the descriptor list into the spawn-time artifacts the runtime CLI expects:

- `McpHttpDescriptor` carries `{ kind: 'http', name, url, headers?, bearerToken? }`.
- `McpStdioDescriptor` carries `{ kind: 'stdio', name, command, args?, env? }`.

All three adapters now handle both kinds. For Claude Code the spawn args become `--mcp-config '{ "mcpServers": { ... } }' --strict-mcp-config`; for Codex a `config.toml` is materialised in the runtime home dir; for Gemini a `.gemini/settings.json` is written.

## Local MCP layout (when installer lands)

Local MCPs live under `${workspace}/.hezo/mcp/<name>/`. The workspace is host-bind-mounted, so the install survives container rebuilds. The installer script (a follow-up) runs `npm install --prefix /workspace/.hezo/mcp/<name>` (or `uv tool install --target` for Python MCPs) inside the container, marks `install_status`, and surfaces `install_error` on failure.

## Tests

`packages/server/src/test/__tests__/`:
- `mcp-connections.test.ts` — REST + service-layer unit tests including project-scoped overrides of company-wide entries.
- `mcp-connections-docker.test.ts` — Docker e2e against a custom test MCP server (`fixtures/test-mcp-stdio-server.mjs` and `helpers/test-mcp-http-server.ts`):
  1. SaaS substitution path: connection row with placeholder header → loader → egress proxy → real MCP server sees the real header value.
  2. SaaS no-op: forwards untouched when no placeholder is present (no audit row written).
  3. Local stdio path: bind-mounts the fixture, spawns it via `node test-mcp-stdio-server.mjs`, exchanges initialize + tools/call JSON-RPC.
