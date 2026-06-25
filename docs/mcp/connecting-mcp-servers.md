---
title: Connecting MCP servers
order: 24
section: AI models & MCP
---

# Connecting MCP servers to your agents

The other side of [Hezo's MCP server](/docs/mcp/hezo-mcp-server): you can give Hezo's
own agents access to **external MCP servers**, so they can use the tools you already
rely on — web search, a project tracker, a CMS, a filesystem, and so on. Once a
connection is registered it's available to your agents' runs and survives
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

MCP connections are **instance-wide**: there's a single shared catalog and each
connection name is unique across the instance. Once you add a server it's available to
every team's agent runs.

## Adding a connection

Register connections from the web app, or let an agent add one itself when it needs a
tool (subject to your approval). Either way the connection is scoped, stored, and made
available to the relevant runs.
