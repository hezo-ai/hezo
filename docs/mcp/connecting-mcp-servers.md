---
title: Connecting external services
order: 25
section: AI models & connections
---

# Connecting your agents to external services

The other side of [Hezo's MCP server](/docs/mcp/hezo-mcp-server): **connectors** give
Hezo's own agents access to the external services you already rely on - web search, a
project tracker, a CMS, a payments API, and so on. Once a connector is registered it's
available to your agents' runs and survives container rebuilds.

A connector comes in one of three kinds, depending on how the service is exposed:

- A **hosted MCP server** - the service publishes an HTTP
  [MCP](https://modelcontextprotocol.io) endpoint, and its tools appear directly in your
  agents' tool list (GitHub, Linear, Notion, …).
- A **REST API** - the service has no MCP server, just a credentialed plain HTTP API.
  Agents call the API directly, and the credential is filled in on the way out.
- A **local MCP server** - a process-based (stdio) server that runs inside the project
  container.

Whatever the kind, the credential handling is the same: agents only ever see a
[placeholder](/docs/security/secret-protection), and the egress proxy substitutes the
real value at request time, scoped to the hosts you allowed - the real key never enters
an agent's environment in any form.

## Hosted MCP servers

Hosted, HTTP-based MCP servers connect by **URL plus any headers** they need.

When you add one, Hezo contacts the server straight away and records what came back. A
server that answers with no credential is public, and your agents get it on their next
run. A server that asks for a credential Hezo doesn't have is held back until you connect
the account or paste an API key, so it never reaches a run only to fail inside one where
you can't see it. Hezo re-checks these servers periodically, so a public server that later
starts demanding auth drops out on its own. The connector's card says which of these
applies. A server authenticated by a placeholder header is exempt: Hezo can't reproduce
that substitution from its own side, so it takes the header at its word.

Header values can reference your stored secrets with a **placeholder** rather than a
literal key - so an API-key header is filled in by the [egress
proxy](/docs/security/secret-protection) at request time and the real value never sits
in the connection config. For servers that authenticate with OAuth, connect the account
once and Hezo attaches and refreshes the token for you.

### Servers that use an API key

Some hosted MCP servers don't offer OAuth at all - they authenticate with a plain API
key. When an agent registers one (or you add it yourself), its **Connect required** card
in the task and the project's **Connectors** page show a **Use API key** option next to
**Connect**. Paste the key there: Hezo stores it encrypted in your vault, scoped so it's
only ever sent to that server's host, and each agent run receives a **placeholder** - the
real key is never visible to the agent. By default the key is sent as an `Authorization:
Bearer <key>` header; open **Advanced** to change the header name or drop the scheme for
servers that expect something else (for example `X-API-Key: <key>`).

### OAuth connections need an HTTPS address

For MCP servers that authenticate with OAuth, completing the connection sends your browser
from the provider's consent page back to your instance's callback URL. Providers and
browsers only accept **HTTPS** callback URLs (with `http://localhost` as the one
exception), so your instance must be reached over HTTPS for the final **Allow** step to
work - on a private network or VPN too, where a plain-HTTP address makes the consent
popup fail with a blocked or rejected redirect. Your instance does **not** need to be
publicly reachable: the redirect happens in your browser, so a private HTTPS address
works fine. See [Serve it over HTTPS](/docs/deployment/cloud#serve-it-over-https) and
[Secure remote access](/docs/deployment/secure-remote-access) for setting that up.
(REST API connectors authorized with the [device flow](#connecting-an-oauth-api-with-the-device-flow-no-callback)
have no callback and no HTTPS requirement.)

If your instance's address changes (for example you move from plain HTTP to HTTPS),
just press **Connect** on the connector again - Hezo detects that its callback address
changed and automatically registers a fresh OAuth client with the provider on the
current address, so you don't have to remove and re-add the connector.

## REST API connectors

Plenty of services have no MCP server at all - just a well-documented HTTP API
(Google's APIs, Stripe, Cloudflare, …). A **REST API connector** covers those without
any middleman: agents call the API directly through the
[egress proxy](/docs/security/secret-protection), which substitutes the credential on
the way out.

Add one from the project's **Connectors** page: press **Add**, switch the type from
**MCP server** to **REST API**, and fill in:

- the **base URL** agents should call (for example `https://api.example.com/v1`),
- the **allowed hosts** the credential may be sent to,
- where the credential goes - a **header** (with an optional scheme prefix such as
  `Bearer `) or a **query parameter** - and its name,
- an optional **API docs** link, shown on the connector's row and passed along to
  agents.

Then attach the credential from the connector's row with **API key**: it's stored
encrypted in your vault, scoped to the allowed hosts, exactly like an MCP server's API
key above. Agents discover the connector's base URL together with a placeholder, put the
placeholder in the header or query parameter you named, and the egress proxy fills in
the real key at request time.

Agents can also register a REST API connector themselves when they need one - it
appears on the Connectors page, ready for you to attach the credential.

Many REST APIs need only a static key for the common case, and **YouTube is a good
example**: reading public data - searching, video and channel metadata, public comments and
statistics - needs just a **YouTube Data API key**, not OAuth. Create or pick a Google Cloud
project, enable the **YouTube Data API v3**, and create an API key (no OAuth consent screen);
register a REST API connector with the key in the `key` **query parameter** and attach it with
**API key**. Only reach for OAuth when an agent must act on a user's account - uploading,
editing a channel or playlists, private data, or its own analytics - which uses the device flow
below. When an agent registers the read-only connector for you, its row leads with the API-key
field and a short "how to get a key" walkthrough instead of the OAuth form.

For an API that genuinely authenticates with OAuth rather than a static key, skip the API key
and press **Complete connection** on the connector's row instead - the device flow below.

### Connecting an OAuth API with the device flow (no callback)

A REST API connector can be authorized with the **OAuth device flow**, which needs no
browser callback at all. That means it works on any address - `localhost`, a private
hostname, plain HTTP - with none of the HTTPS-callback requirements that apply to
OAuth-connected MCP servers above.

Add the REST API connector (name, base URL, allowed hosts), then press **Complete
connection** on its row. Pick a bundled provider (Google/YouTube is built in) or choose
**Custom…** and paste the device-code and token endpoints yourself, then enter the OAuth
**client ID** (and **client secret**, if the provider's device-flow client needs one).
Hezo shows a short code and a verification link: open the link on any device, enter the
code, and approve. That's it - no redirect back to your instance.

When an **agent** sets up the connector it pre-selects the provider for you, so there's
no picker to choose - you just paste the client ID it asked for. The same completion
panel appears in two places, and you can finish from either: **inline in the task
comment** where the agent requested it, or on the project's **Connectors** page (where
each pending request also names and links the task it came from). Completing on the
Connectors page expands the panel in place - no separate dialog.

Hezo keeps the durable pieces **host-side, never inside a run**: the refresh token and the
client secret are stored encrypted in your vault and are never handed to an agent or sent
anywhere except the provider's own token endpoint. Only the short-lived **access token** is
exposed to a run, as a [placeholder](/docs/security/secret-protection) the agent puts in an
`Authorization: Bearer` header; the [egress proxy](/docs/security/secret-protection)
substitutes the real token and refreshes it automatically before it expires, so the
connection stays live without you re-authorizing. Hezo also re-checks connectors on a
timer, so a token is renewed even on an instance where nothing has run for a while.

Refreshing can still fail - most often because the provider expired or revoked the
underlying authorization, which no amount of retrying will fix. When that happens the
connector is marked **Needs reconnect**; see
[When a connector stops working](#when-a-connector-stops-working).

## Local (stdio) servers

Hezo also supports **local, process-based** MCP servers that run inside the project
container. The connection model is in place; automatic installation of local servers is
still being rolled out, so prefer a hosted (HTTP) server or a REST API connector for now
where you have the choice.

A local server that reaches an outside API usually reads its key from an **environment
variable** (say a YouTube tool that reads `YOUTUBE_API_KEY`). You never put the real key in
the connection - the connection holds a **placeholder**, and the value is stored as a
[credential](/docs/security/secret-protection) the agent requests from you and you paste in.
The [egress proxy](/docs/security/secret-protection) swaps in the real value only when the
server calls out, scoped to that API's host. Because connections are scoped per project
(below), each project supplies its own key for the same tool without them ever colliding -
each project's credential just gets its own name.

## How agents pick the right connection

Hezo ships a built-in **`connector-recipes`** [skill](/docs/concepts/skills) - a curated
catalog of connection recipes for dozens of popular services (GitHub, GitLab, Linear,
Notion, Stripe, Cloudflare, Google APIs, Slack, and many more), each verified against
the provider's own documentation: whether the service has a hosted MCP server or a plain
REST API, the endpoint to use, the credential it needs, and the hosts that credential
should be scoped to.

Agents consult it before wiring up a new service, so they reach straight for a hosted
MCP server or a REST API connector (where secrets stay placeholders) rather than an
integration designed for desktop use that would need an interactive browser login or a
token file written to disk. The skill appears read-only in **Settings → Skills** with a
**Built-in** badge; it can't be edited or deleted, and it updates automatically as Hezo
does.

## Where a connection applies

Connections are **scoped by project**. A connection you add to a project is private to
that project's agent runs, so two projects can each connect a *different* account for the
same provider (for example, a separate GitHub account per project) without one bleeding
into the other. Each project's runs see its own connections plus any connection scoped to
**All projects** - the global scope for services you want shared everywhere. When a project
and the global scope both define a connection of the same name, the project's own wins.

Manage connections two ways:

- **Project → Connectors** shows just that project's connectors. **Add** a
  connector here - an MCP server (name + URL) or a REST API (base URL, allowed hosts,
  and where the credential goes) - and it's scoped to that project. For an MCP server,
  Hezo probes it for OAuth and opens the connect popup automatically, or you attach an
  API key from its row if the server authenticates with a header instead.
- The global **Settings → Connectors** page (admin) lists connectors across every project.
  Each connector shows its scope (**All projects** or a specific project) as a badge you
  can click to re-scope it: a searchable dropdown lets you move the connector to any
  project or back to the global scope. New connectors pick their scope in the Add form the
  same way.

### GitHub on a project that doesn't write code

GitHub is offered on every project, but it is only a *setup step* for a team that actually
works with repositories. Hezo decides that from the roster: an agent is marked **Touches
code** when it reads or writes repository code, and only those agents ever need a repo.

On a project where nobody touches code - an investment team, a marketing team, any roster
built from a non-engineering template - GitHub sits at the bottom of the Connectors list
with a neutral **Optional** badge instead of the amber **Pending connect**, so it doesn't
read as unfinished setup. It stays one click away if you want agents to use the GitHub MCP
server anyway. Hire a code-touching agent, or attach a repository, and GitHub moves back to
the top of the list as a real setup step.

## Choosing which methods agents can use

A hosted MCP server ships its read tools and its write tools in one connection. Connecting
a tracker to look things up would, by default, also hand your agents the tools that close
issues and delete comments.

Every connected MCP server has an **Enabled methods** control that fixes this - in the
connector's **Settings** section on a project's Connectors page, or as a **Methods** row on
the global Connectors page. It starts at **All**, meaning every method the server
advertises is available. Open the picker from there and the server's methods are split into
two groups:

- **Read-only** - methods that only look things up.
- **Write** - everything else: anything that creates, changes, or deletes.

Each group has a checkbox in its header that turns the whole group on or off in one click,
so the common choice - give them reads, withhold writes - takes one press without expanding
anything. Tick individual methods for anything finer. Nothing is saved until you press
**Save**, so you can change your mind freely; **Reset to all** puts the connector back to
unrestricted.

Hezo takes the server's word for which methods are read-only when the server says so. Where
a server declares nothing, Hezo infers the category from the method name and labels the row
**inferred** so you know it's a guess rather than a declaration. An unrecognised name counts
as a write method, so a method Hezo can't place is withheld rather than quietly allowed.

A disabled method is blocked on the way out of the container, so the restriction holds no
matter which AI model or coding tool the agent is running. On most of them the disabled
methods are also hidden from the agent's tool list, so it never sees a tool it can't use
and won't waste a turn trying; on the rest the tool is still listed but calling it fails
with an error saying it's disabled. Either way it cannot be called.

Methods are listed when you connect the server. If a connector shows that its methods
haven't been listed yet - it was connected before this existed, or the listing failed -
press **List methods** on the same row.

The allowlist belongs to the connector, so a connector scoped to **All projects** carries
one allowlist shared by every project, edited from the global **Settings → Connectors**
page. A project-scoped connector's is edited from that project's own Connectors page.

### When an agent asks for read-only

An agent registering a connector can ask for read-only up front. When it does, the connect
card in the task thread says **Read-only requested** before you authorize anything, and the
write methods are disabled automatically the moment the connection completes - you don't
have to remember to lock it down afterwards.

This only ever narrows access. An agent can't ask for *more* than it would get by default,
and the request is skipped entirely once you've chosen the enabled methods yourself: your
choice stands, and a later registration won't undo it. You can widen or narrow a connector
at any time from the same control.

## When a connector stops working

A connector that was working can stop working on its own - typically because the provider
expired the authorization behind it, or an administrator there revoked it. Nothing on your
side changed, so the only way you would otherwise find out is by noticing that an agent's
output had quietly got worse.

Hezo surfaces it four ways instead:

- A **banner at the top of every page in the project** naming what broke, linking straight
  to the connector.
- The connector's own row is marked **Needs reconnect** rather than **Connected**, with the
  provider's explanation underneath and a **Reconnect** button beside it.
- Agents see the connector as `degraded` rather than `active`, and are instructed to raise
  it with you rather than work around it silently.
- **The run that hit it says so.** When a connector refuses a request an agent run makes to
  it, or Hezo cannot supply the run's credential for it, the run's log gets a
  `[runner] WARNING:` line naming the connector, the HTTP status and whether the request
  carried a credential - and Hezo immediately re-checks the connector itself, then writes a
  second line with what it found. In a CEO chat the same two sentences appear as warning rows
  in the thread. That re-check is the same probe as the connector's **Refresh** button, so a
  dead credential lights the banner and the badge at that moment rather than at the next
  timed check, and a public server that has started demanding a credential is held back from
  later runs until you connect one. If the line says the request carried no credential
  although one is configured, the agent runtime is not sending it - that is a Hezo defect,
  not something reconnecting fixes; please report it with the runtime named in the line.

Press **Reconnect** and complete the provider's authorization exactly as you did the first
time. The connector is repaired in place - you keep its method allowlist, its credential
record, and its history, and every agent picks it up again on its next run. The row updates
itself as soon as the authorization window closes: the amber badge becomes **Connected** and
the provider's error message clears, with no page reload.

Until you do, the connector's tools may still appear in agent tool lists, but calls through
them fail. That is deliberate: withdrawing the tools mid-task would look to an agent like
the integration had never existed, whereas a failing call plus a `degraded` status tells it
what is actually wrong.

## Reconnecting a revoked connector

Revoking a connector clears its stored token or API key so agents lose access immediately,
but the connector stays on the page marked **Revoked**. To reconnect, just press **Connect**
(or **API key**) on it again - Hezo restores the connector in place and runs a fresh
authorization, so you never have to delete and recreate it. (An instance-address change
is handled the same way: pressing **Connect** re-registers the OAuth client on the new
address automatically - see
[OAuth connections need an HTTPS address](#oauth-connections-need-an-https-address).)

A connector that isn't connected - one still awaiting connection ("Pending connect"),
failed, or revoked - can instead be dropped outright with **Remove** on its row: it deletes
the connector from the project (an agent can request it again if it's still needed). A
connected connector shows **Disconnect** instead; disconnect it first, then **Remove** the
revoked row if you want it gone.

### When the connector also authenticates a repo

A GitHub connector and your linked repositories share one OAuth connection, but they read it
through different records, so the two controls do different damage:

- **Remove** deletes only the connector. Git keeps working, because your repositories hold
  their own reference to the connection. What goes away is the connector's MCP tools, on
  every future agent run.
- **Disconnect** deletes the connection itself. That drops the repositories' reference too,
  so those remotes fall back to anonymous access: fine for a public repository, a 403 for a
  private one.

Every one of these confirmations lists the repositories affected before you commit - on the
Connectors page and on the Git page alike - so neither surprise is one you find out about
later. Repositories in other teams are not listed, because they are not yours to see; the
count still includes them. Agents cannot make either change: `remove_connector` refuses a
connector that still authenticates a repository and tells the agent to bring it to you.

A connection shared across all projects can be disconnected from any project that can see it,
and doing so takes every other project's repositories with it. That is why the confirmation
names them. Removing the shared **connector** row is a Settings -> Connectors action.

## Connectors and their credentials

[Credentials](/docs/security/secret-protection) stay **global** - one shared vault, not
scoped per project. But because a connector *is* scoped, the credential a connector creates
is **named after that connector's project** (a project-scoped connector's API key gets a
short project tag in its name; a global connector's does not), so when two projects connect
the same kind of server you can still tell their credentials apart at a glance.

Both pages show the link between the two:

- Under each connector, in its **Settings** section, the **credential** it uses - click it to
  jump to that credential on the Credentials page.
- Under each credential (**Settings → Credentials**), the **connectors** that use it - click
  one to jump to it on the Connectors page.

Because a connector depends on its credential, a credential that's still in use **can't be
deleted**: its revoke button is disabled with a note explaining why. Remove the connector
first, then the credential can be revoked.

## Adding a connection

Register connections from the web app, or let an agent add one itself when it needs a
tool (subject to your approval). Either way the connection is scoped, stored, and made
available to the relevant runs.

When an agent adds a connection itself, it also records how to drive the service as a
[skill](/docs/concepts/skills) once the connection works - and keeps that skill current -
so future runs start from working knowledge rather than vendor docs.
