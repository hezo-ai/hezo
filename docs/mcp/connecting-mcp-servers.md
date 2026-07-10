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

### Servers that use an API key

Some hosted MCP servers don't offer OAuth at all — they authenticate with a plain API
key. When an agent registers one (or you add it yourself), its **Connect required** card
in the task and the project's **Connectors** page show a **Use API key** option next to
**Connect**. Paste the key there: Hezo stores it encrypted in your vault, scoped so it's
only ever sent to that server's host, and each agent run receives a **placeholder** — the
real key is never visible to the agent. By default the key is sent as an `Authorization:
Bearer <key>` header; open **Advanced** to change the header name or drop the scheme for
servers that expect something else (for example `X-API-Key: <key>`).

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

A local server that reaches an outside API usually reads its key from an **environment
variable** (say a YouTube tool that reads `YOUTUBE_API_KEY`). You never put the real key in
the connection — the connection holds a **placeholder**, and the value is stored as a
[credential](/docs/security/secret-protection) the agent requests from you and you paste in.
The [egress proxy](/docs/security/secret-protection) swaps in the real value only when the
server calls out, scoped to that API's host. Because connections are scoped per project
(below), each project supplies its own key for the same tool without them ever colliding —
each project's credential just gets its own name.

## Where a connection applies

MCP connections are **scoped by project**. A connection you add to a project is private to
that project's agent runs, so two projects can each connect a *different* account for the
same provider (for example, a separate GitHub account per project) without one bleeding
into the other. Each project's runs see its own connections plus any connection scoped to
**All projects** — the global scope for servers you want shared everywhere. When a project
and the global scope both define a connection of the same name, the project's own wins.

Manage connections two ways:

- **Project → Settings → Connectors** shows just that project's connectors. **Add** a
  connector here — give it a name and MCP server URL — and it's scoped to that project;
  Hezo probes it for OAuth and opens the connect popup automatically, or you attach an
  API key from its row if the server authenticates with a header instead.
- The global **Settings → Connectors** page (admin) lists connectors across every project.
  Each connector shows its scope — **All projects** or a specific project — as a badge you
  can click to re-scope it: a searchable dropdown lets you move the connector to any
  project or back to the global scope. New connectors pick their scope in the Add form the
  same way.

## Reconnecting a revoked connector

Revoking a connector clears its stored token or API key so agents lose access immediately,
but the connector stays on the page marked **Revoked**. To reconnect, just press **Connect**
(or **API key**) on it again — Hezo restores the connector in place and runs a fresh
authorization, so you never have to delete and recreate it. (The exception is an
instance-address change — see [OAuth connections need an HTTPS address](#oauth-connections-need-an-https-address)
above — where the OAuth client is tied to the old address and the connector must be removed
and added again.)

## Connectors and their credentials

[Credentials](/docs/security/secret-protection) stay **global** — one shared vault, not
scoped per project. But because a connector *is* scoped, the credential a connector creates
is **named after that connector's project** (a project-scoped connector's API key gets a
short project tag in its name; a global connector's does not), so when two projects connect
the same kind of server you can still tell their credentials apart at a glance.

Both pages show the link between the two:

- Under each connector, the **credential** it uses — click it to jump to that credential on
  the Credentials page.
- Under each credential (**Settings → Credentials**), the **connectors** that use it — click
  one to jump to it on the Connectors page.

Because a connector depends on its credential, a credential that's still in use **can't be
deleted**: its revoke button is disabled with a note explaining why. Remove the connector
first, then the credential can be revoked.

## Adding a connection

Register connections from the web app, or let an agent add one itself when it needs a
tool (subject to your approval). Either way the connection is scoped, stored, and made
available to the relevant runs.
