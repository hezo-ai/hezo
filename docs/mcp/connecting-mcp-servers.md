---
title: Connecting MCP servers
order: 25
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

### OAuth connections need an HTTPS address

For servers that authenticate with OAuth, completing the connection sends your browser
from the provider's consent page back to your instance's callback URL. Providers and
browsers only accept **HTTPS** callback URLs (with `http://localhost` as the one
exception), so your instance must be reached over HTTPS for the final **Allow** step to
work — on a private network or VPN too, where a plain-HTTP address makes the consent
popup fail with a blocked or rejected redirect. Your instance does **not** need to be
publicly reachable: the redirect happens in your browser, so a private HTTPS address
works fine. See [Serve it over HTTPS](/docs/deployment/cloud#serve-it-over-https) and
[Secure remote access](/docs/deployment/secure-remote-access) for setting that up.

If your instance's address changes (for example you move from plain HTTP to HTTPS),
remove the connector and add it again before reconnecting: the OAuth client Hezo
registered with the provider is tied to the address it was created on, and a stale
registration is rejected with a "redirect_uri does not match" error. Re-adding the
connector registers a fresh client on the current address.

## Local (stdio) servers

Hezo also supports **local, process-based** MCP servers that run inside the project
container. The connection model is in place; automatic installation of local servers is
still being rolled out, so prefer hosted (HTTP) servers for now where you have the
choice.

## Where a connection applies

MCP connections are **scoped by project**. A connection you add to a project is private to
that project's agent runs, so two projects can each connect a *different* account for the
same provider (for example, a separate GitHub account per project) without one bleeding
into the other. Each project's runs see its own connections plus any connection scoped to
**All projects** — the global scope for servers you want shared everywhere. When a project
and the global scope both define a connection of the same name, the project's own wins.

Manage connections two ways:

- **Project → Settings → Connectors** shows just that project's connectors.
- The global **Settings → Connectors** page (admin) lists connectors across every project,
  with a scope filter — **All projects** or a specific project — to narrow the view and
  choose where a newly added connector lives.

## Adding a connection

Register connections from the web app, or let an agent add one itself when it needs a
tool (subject to your approval). Either way the connection is scoped, stored, and made
available to the relevant runs.
