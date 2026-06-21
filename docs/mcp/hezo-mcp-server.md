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

## Connecting as a connected agent (instance-wide)

An external agent can **self-register** for instance-wide access instead of using a
team-scoped API key. A connected agent, once approved, acts with **full admin access** —
every project and every team, just like the admin. Registration is **pending** and grants
no access until a human admin approves it.

The flow:

1. **Register.** Call the `register` tool over MCP (no token required), or
   `POST /api/agent-connections/register` with `{ "name": "<your agent>" }`. You receive a
   token that starts with `hezoc_`, shown **once**.
2. **Set the token** as your `Authorization: Bearer <token>` header.
3. **Get approved.** A Hezo admin approves the connection under **Settings → Connected
   agents**. Until then the token is inert.
4. **Poll** the `connection_status` tool (or `GET /api/agent-connections/status` with the
   token) until it returns `{ "status": "approved" }`.
5. **Use it.** The same token now authorizes `POST /mcp`. Because a connected agent has no
   single home project, pass a `project` slug to project-scoped tools — use `list_projects`
   to discover them across the whole instance.

A connected agent has every admin power **except** managing connected agents — only the
human admin can approve or disconnect them. An admin can disconnect a connected agent at
any time from the same page, which revokes its token immediately.

> Hezo also serves a generated [`/SKILL.md`](http://localhost:3100/SKILL.md) (the full,
> live tool list plus these connection instructions) and a minimal `/llms.txt` that points
> to it — handy for agents that consume the [llmstxt.org](https://llmstxt.org) convention.

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
