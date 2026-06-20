---
title: Connecting MCP servers
order: 16
section: AI models & MCP
---

# Connecting MCP servers to your agents

The other side of [Hezo's MCP server](/docs/mcp/hezo-mcp-server): you can give Hezo's
own agents access to **external MCP servers**, so they can use the tools you already
rely on — web search, a project tracker, a CMS, a filesystem, and so on. Once a
connection is registered it's available to that team's agent runs and survives
container rebuilds.

## Remote (HTTP) servers

Hosted, HTTP-based MCP servers connect by **URL plus any headers** they need. They're
available to your agents as soon as you add them.

Header values can reference your stored secrets with a **placeholder** rather than a
literal key — so an API-key header is filled in by the [egress
proxy](/docs/security/secret-protection) at request time and the real value never sits
in the connection config. For servers that authenticate with OAuth, connect the account
once and Hezo attaches and refreshes the token for you.

## Local (stdio) servers

Hezo also supports **local, process-based** MCP servers that run inside the project
container. The connection model is in place; automatic installation of local servers is
still being rolled out, so prefer hosted (HTTP) servers for now where you have the
choice.

## Where a connection applies

Connections can be registered at three scopes:

- **Instance-wide** — shared with every team.
- **Team** — available to one team's projects.
- **Project** — available to a single project, and shadows a team or instance entry of
  the same name.

When the same name exists at more than one scope, the most specific one wins
(**project, then team, then instance**) — handy for swapping in a sandbox server for one
project while everything else uses the shared one.

## Adding a connection

Register connections from the web app, or let an agent add one itself when it needs a
tool (subject to your approval). Either way the connection is scoped, stored, and made
available to the relevant runs.

## Next

- [Hezo's MCP server](/docs/mcp/hezo-mcp-server) — let external agents drive Hezo.
- [Secret protection & egress](/docs/security/secret-protection) — how connection
  secrets are kept safe.
