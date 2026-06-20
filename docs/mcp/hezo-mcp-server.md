---
title: Hezo's MCP server
order: 15
section: AI models & MCP
---

# Hezo's MCP server

Hezo ships its **own MCP ([Model Context Protocol](https://modelcontextprotocol.io))
server.** Any MCP-capable agent or client — Claude Code, Cursor, Claude Desktop, your
own scripts — can connect to it and manage your Hezo workspace: create and update
projects, file and work tasks, post comments, inspect agents, and more.

It's the same interface Hezo's own agents use internally, exposed for you to plug your
tools into.

## Connection details

- **Endpoint:** `POST http://<host>:3100/mcp`
- **Transport:** Streamable HTTP
- **Authentication:** an `Authorization: Bearer <token>` header, where the token is a
  **Hezo API key** (it starts with `hezo_`).

### Get an API key

Create an API key from the web app. The key is **scoped to a team**, so a client using
it acts within that team and its projects — exactly the same authorization an agent
would have. Copy the key when it's shown; it isn't displayed again.

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

If your Hezo runs on a remote server, replace `localhost:3100` with its address — and
make sure that address is reached over a secure channel, since the API key travels in
the header. See [Secure remote access](/docs/deployment/secure-remote-access).

## What you can do with it

Once connected, your agent can manage work in Hezo the way a teammate would — for
example list and create projects, create and update tasks (including their rules and
progress summaries), comment on tasks, and inspect the team's agents. The connected
client discovers the full, current tool list automatically on connect.

## Next

- [Connecting MCP servers](/docs/mcp/connecting-mcp-servers) — the other direction:
  giving Hezo's own agents access to external MCP servers.
