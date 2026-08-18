---
title: Hezo's MCP server
order: 24
section: AI models & connections
---

# Hezo's MCP server

Hezo ships its **own MCP ([Model Context Protocol](https://modelcontextprotocol.io))
server.** Any MCP-capable agent or client - Claude Code, Cursor, Claude Desktop, your
own scripts - can connect to it and manage your Hezo workspace: create and update
projects, file and work tasks, post comments, inspect agents, and more.

It's the same interface Hezo's own agents use internally, exposed for you to plug your
tools into.

## Connection details

- **Base URL:** your instance's address. Running locally with default settings that's
  `http://localhost:3100`; a deployed instance is its **HTTPS** URL - its own domain
  behind the TLS reverse proxy, not necessarily port 3100. (The port Hezo itself listens
  on is set by `--port` / the config file's `port`, default `3100`.)
- **Endpoint:** `POST <base-url>/mcp`
- **Transport:** Streamable HTTP
- **Authentication:** an `Authorization: Bearer <token>` header, where the token is a
  **Hezo API key** (it starts with `hezo_`).

### Get an API key

Create an API key under **Settings → API keys** in the web app. Copy the key when it's
shown - it isn't displayed again. It starts with `hezo_` and goes in the
`Authorization: Bearer` header on every request. An API key has global access:
pass a `project` slug to project-scoped tools (use `list_projects` to discover them).

Revoke a key at any time from the same page, which disables it immediately.

## Connecting an external agent (self-registration)

Instead of pasting a key, an external agent can **self-register** and have an admin
approve it - useful for agents that connect on their own initiative. Registration is
**pending** and grants no access until a human admin approves it.

The flow:

1. **Register.** Call the `register` tool over MCP (no token required), or
   `POST /api/api-keys/register` with `{ "name": "<your agent>" }`. You receive a token,
   shown **once**.
2. **Set the token** as your `Authorization: Bearer <token>` header.
3. **Get approved.** A Hezo admin approves the request under **Settings → API keys**.
   Until then the token is inert.
4. **Poll** the `connection_status` tool (or `GET /api/api-keys/status` with the token)
   until it returns `{ "status": "approved" }`.
5. **Use it.** The same token now authorizes `POST /mcp` with global access. Pass a
   `project` slug to project-scoped tools - use `list_projects` to discover them across the
   whole instance.

An admin can revoke an agent's access at any time from the same page, which disables its
token immediately.

> Hezo also serves a generated [`/SKILL.md`](http://localhost:3100/SKILL.md) (the full,
> live tool list plus these connection instructions) and a minimal `/llms.txt` that points
> to it - handy for agents that consume the [llmstxt.org](https://llmstxt.org) convention.

## Add it to an agent

### Claude Code

```sh
claude mcp add --transport http hezo http://localhost:3100/mcp \
  --header "Authorization: Bearer hezo_your_api_key"
```

### Any MCP client (config file)

Most clients (Cursor, Claude Desktop, and others) take an HTTP MCP server as JSON. Point
it at the `/mcp` endpoint and pass your key in the `Authorization` header:

```json
{
  "mcpServers": {
    "hezo": {
      "type": "http",
      "url": "http://localhost:3100/mcp",
      "headers": {
        "Authorization": "Bearer hezo_your_api_key"
      }
    }
  }
}
```

If your Hezo runs on a remote server, replace `http://localhost:3100` with its **HTTPS**
base URL - a remote instance sits behind a TLS reverse proxy on its own domain (see
[Serve it over HTTPS](/docs/deployment/cloud#serve-it-over-https)). The API key travels
in the header, so never call a remote instance over plain HTTP. See
[Secure remote access](/docs/deployment/secure-remote-access).

## What you can do with it

Once connected, your agent can manage work in Hezo the way a teammate would - for
example list and create projects, create and update tasks (including their rules and
progress summaries), comment on tasks, and inspect the team's agents. The connected
client discovers the full, current tool list automatically on connect.

For a complete, tool-by-tool description of every parameter and return value, see the
[MCP API reference](/docs/reference/mcp-api).

## File uploads

A binary file (an image, a PDF, …) can't ride inside a JSON-RPC tool call. To upload one,
POST it as `multipart/form-data` to `/mcp/assets` with the same `Authorization: Bearer`
header and a `file` field. Optional fields:

- `path` - the full destination path (folders + basename, up to two levels, e.g.
  `launch/images/hero.png`); its folders are preserved. A folder embedded in the file
  part's `filename=` is honoured the same way when no `path` field is sent.
- `overwrite` - `true` replaces an existing asset at the path in place, keeping the
  reference stable (the same behaviour as re-saving through `write_project_asset`);
  otherwise a colliding name is auto-suffixed.
- `project` - name the project when you're acting across projects.
- `folder` - legacy: place the basename inside a library folder (up to two levels).
  Ignored when `path` is given.

```sh
curl -X POST http://localhost:3100/mcp/assets \
  -H "Authorization: Bearer hezo_your_api_key" \
  -F file=@diagram.png \
  -F path=launch/images/diagram.png \
  -F overwrite=true
```

The response returns the stored asset (including its `byte_size`, so you can confirm the
full file landed) and a signed read URL, and the file then shows up in the
`list_project_assets` and `read_project_asset` tools under its full path
(`launch/images/diagram.png`).

Prefer this streaming endpoint for any large binary: base64 in a `write_project_asset`
call can be silently cut short by a runtime's tool-call argument-size cap. If you do write
a binary through `write_project_asset`, pass `byte_size` (the file's exact byte length) so
a truncated `content` is rejected instead of stored corrupt.
