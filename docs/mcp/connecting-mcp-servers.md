---
title: Connecting external services
order: 25
section: AI models & connections
---

# Connecting your agents to external services

The other side of [Hezo's MCP server](/docs/mcp/hezo-mcp-server): **connectors** give
Hezo's own agents access to the external services you already rely on — web search, a
project tracker, a CMS, a payments API, and so on. Once a connector is registered it's
available to your agents' runs and survives container rebuilds.

A connector comes in one of three kinds, depending on how the service is exposed:

- A **hosted MCP server** — the service publishes an HTTP
  [MCP](https://modelcontextprotocol.io) endpoint, and its tools appear directly in your
  agents' tool list (GitHub, Linear, Notion, …).
- A **REST API** — the service has no MCP server, just a credentialed plain HTTP API.
  Agents call the API directly, and the credential is filled in on the way out.
- A **local MCP server** — a process-based (stdio) server that runs inside the project
  container.

Whatever the kind, the credential handling is the same: agents only ever see a
[placeholder](/docs/security/secret-protection), and the egress proxy substitutes the
real value at request time, scoped to the hosts you allowed — the real key never enters
an agent's environment in any form.

## Hosted MCP servers

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

For MCP servers that authenticate with OAuth, completing the connection sends your browser
from the provider's consent page back to your instance's callback URL. Providers and
browsers only accept **HTTPS** callback URLs (with `http://localhost` as the one
exception), so your instance must be reached over HTTPS for the final **Allow** step to
work — on a private network or VPN too, where a plain-HTTP address makes the consent
popup fail with a blocked or rejected redirect. Your instance does **not** need to be
publicly reachable: the redirect happens in your browser, so a private HTTPS address
works fine. See [Serve it over HTTPS](/docs/deployment/cloud#serve-it-over-https) and
[Secure remote access](/docs/deployment/secure-remote-access) for setting that up.
(REST API connectors authorized with the [device flow](#connecting-an-oauth-api-with-the-device-flow-no-callback)
have no callback and no HTTPS requirement.)

If your instance's address changes (for example you move from plain HTTP to HTTPS),
remove the connector and add it again before reconnecting: the OAuth client Hezo
registered with the provider is tied to the address it was created on, and a stale
registration is rejected with a "redirect_uri does not match" error. Re-adding the
connector registers a fresh client on the current address.

## REST API connectors

Plenty of services have no MCP server at all — just a well-documented HTTP API
(Google's APIs, Stripe, Cloudflare, …). A **REST API connector** covers those without
any middleman: agents call the API directly through the
[egress proxy](/docs/security/secret-protection), which substitutes the credential on
the way out.

Add one from the project's **Connectors** page: press **Add**, switch the type from
**MCP server** to **REST API**, and fill in:

- the **base URL** agents should call (for example `https://api.example.com/v1`),
- the **allowed hosts** the credential may be sent to,
- where the credential goes — a **header** (with an optional scheme prefix such as
  `Bearer `) or a **query parameter** — and its name,
- an optional **API docs** link, shown on the connector's row and passed along to
  agents.

Then attach the credential from the connector's row with **API key**: it's stored
encrypted in your vault, scoped to the allowed hosts, exactly like an MCP server's API
key above. Agents discover the connector's base URL together with a placeholder, put the
placeholder in the header or query parameter you named, and the egress proxy fills in
the real key at request time.

Agents can also register a REST API connector themselves when they need one — it
appears on the Connectors page, ready for you to attach the credential.

For an API that authenticates with OAuth rather than a static key (Google/YouTube, for
example), skip the API key and press **Complete connection** on the connector's row instead —
the device flow below.

### Connecting an OAuth API with the device flow (no callback)

A REST API connector can be authorized with the **OAuth device flow**, which needs no
browser callback at all. That means it works on any address — `localhost`, a private
hostname, plain HTTP — with none of the HTTPS-callback requirements that apply to
OAuth-connected MCP servers above.

Add the REST API connector (name, base URL, allowed hosts), then press **Complete
connection** on its row. Pick a bundled provider (Google/YouTube is built in) or choose
**Custom…** and paste the device-code and token endpoints yourself, then enter the OAuth
**client ID** (and **client secret**, if the provider's device-flow client needs one).
Hezo shows a short code and a verification link: open the link on any device, enter the
code, and approve. That's it — no redirect back to your instance.

When an **agent** sets up the connector it pre-selects the provider for you, so there's
no picker to choose — you just paste the client ID it asked for. The same completion
panel appears in two places, and you can finish from either: **inline in the task
comment** where the agent requested it, or on the project's **Connectors** page (where
each pending request also names and links the task it came from). Completing on the
Connectors page expands the panel in place — no separate dialog.

Hezo keeps the durable pieces **host-side, never inside a run**: the refresh token and the
client secret are stored encrypted in your vault and are never handed to an agent or sent
anywhere except the provider's own token endpoint. Only the short-lived **access token** is
exposed to a run, as a [placeholder](/docs/security/secret-protection) the agent puts in an
`Authorization: Bearer` header; the [egress proxy](/docs/security/secret-protection)
substitutes the real token and refreshes it automatically before it expires, so the
connection stays live without you re-authorizing.

## Local (stdio) servers

Hezo also supports **local, process-based** MCP servers that run inside the project
container. The connection model is in place; automatic installation of local servers is
still being rolled out, so prefer a hosted (HTTP) server or a REST API connector for now
where you have the choice.

A local server that reaches an outside API usually reads its key from an **environment
variable** (say a YouTube tool that reads `YOUTUBE_API_KEY`). You never put the real key in
the connection — the connection holds a **placeholder**, and the value is stored as a
[credential](/docs/security/secret-protection) the agent requests from you and you paste in.
The [egress proxy](/docs/security/secret-protection) swaps in the real value only when the
server calls out, scoped to that API's host. Because connections are scoped per project
(below), each project supplies its own key for the same tool without them ever colliding —
each project's credential just gets its own name.

## How agents pick the right connection

Hezo ships a built-in **`connector-recipes`** [skill](/docs/concepts/skills) — a curated
catalog of connection recipes for dozens of popular services (GitHub, GitLab, Linear,
Notion, Stripe, Cloudflare, Google APIs, Slack, and many more), each verified against
the provider's own documentation: whether the service has a hosted MCP server or a plain
REST API, the endpoint to use, the credential it needs, and the hosts that credential
should be scoped to.

Agents consult it before wiring up a new service, so they reach straight for a hosted
MCP server or a REST API connector — where secrets stay placeholders — rather than an
integration designed for desktop use that would need an interactive browser login or a
token file written to disk. The skill appears read-only in **Settings → Skills** with a
**Built-in** badge; it can't be edited or deleted, and it updates automatically as Hezo
does.

## Where a connection applies

Connections are **scoped by project**. A connection you add to a project is private to
that project's agent runs, so two projects can each connect a *different* account for the
same provider (for example, a separate GitHub account per project) without one bleeding
into the other. Each project's runs see its own connections plus any connection scoped to
**All projects** — the global scope for services you want shared everywhere. When a project
and the global scope both define a connection of the same name, the project's own wins.

Manage connections two ways:

- **Project → Settings → Connectors** shows just that project's connectors. **Add** a
  connector here — an MCP server (name + URL) or a REST API (base URL, allowed hosts,
  and where the credential goes) — and it's scoped to that project. For an MCP server,
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

When an agent adds a connection itself, it also records how to drive the service as a
[skill](/docs/concepts/skills) once the connection works — and keeps that skill current —
so future runs start from working knowledge rather than vendor docs.
