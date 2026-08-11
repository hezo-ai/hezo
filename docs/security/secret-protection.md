---
title: Secret protection & egress
order: 18
section: Security
---

# Secret protection & the egress proxy

Agents run real code and make real network calls, often needing real credentials - a
Stripe key, a GitHub token, a webhook secret. Hezo is built so that **agents never
hold the real value of any secret.** This is the single most important thing to
understand about how Hezo keeps you safe.

## Placeholders, not secrets

Whenever an agent needs a credential, it uses a **placeholder** - a named stand-in -
instead of the real value. The placeholder is an inert string. The agent can put it in
a request header or a URL, log it, or paste it into a comment, and nothing leaks,
because it isn't the secret.

The real value lives encrypted in Hezo's vault (see
[Master key & encryption](/docs/security/master-key)) and is only ever materialised at
the last possible moment.

## The egress proxy

Any agent request that could carry one of your secrets - a request to a host that some
credential or connector is scoped to - is routed through Hezo's **egress proxy**,
wherever the [container runs](/docs/containers/overview). As such a request leaves, the
proxy:

1. **Looks for placeholders** in the request's headers and URL.
2. **Checks the destination** against that secret's list of **allowed hosts**.
3. **Substitutes the real value** only if the host is allowed, then forwards the
   request.

If a placeholder is used against a host it isn't allowed for, the proxy **blocks the
request**. So even if an agent is tricked or compromised into trying to send your
Stripe key somewhere it shouldn't, the substitution simply never happens and the
secret never leaves.

Traffic with no security stake - an `npm install`, a documentation fetch, a request to a
host no credential is scoped to - connects straight out from the container rather than
round-tripping through your instance. Nothing is lost by that: a secret can only ever
materialise at the proxy, so a request that goes out directly can carry at most a
placeholder, which is inert and simply fails upstream. The proxy, not the route, is what
the guarantee rests on.

### Credentials that go in the request body

Some APIs take a credential in the request body rather than a header - for example a
login endpoint that you `POST` a username and password to and that returns a token. By
default the proxy never touches request bodies, but you can opt an individual secret
into **body substitution**. When you do, the proxy will substitute that secret's
placeholder into a small JSON request body (a single `application/json` request up to
8 KB) - still only for the secret's allowed hosts. You enable it per secret, either by
ticking the box when you provide the credential the agent asked for, or by editing the
secret on the **Credentials** settings page. It stays **off** until you turn it on, and
a placeholder in a body for a secret without it is blocked just like a disallowed host.
After such a login, the agent uses the returned token via the normal `Authorization`
header, so the credential itself only ever travels in that one login request.

## Scoped to the hosts that need it

Every secret carries an **allowed-hosts** list - the upstreams it may be used with
(for example `api.stripe.com`). This is what makes the boundary structural rather than
just discouraged: a secret can only ever be sent to the destinations you scoped it to,
whatever the agent asks for.

Write each entry as a bare hostname. Hezo normalizes what you type - a scheme, a port
or a path is stripped, so `https://api.stripe.com:443/v1` is stored as `api.stripe.com`
and matches the same way. A leading `*.` is a wildcard for subdomains
(`*.googleapis.com` covers `sheets.googleapis.com`).

### What the scope does and does not promise

Scoping means an agent can **use** a credential against the hosts you named without
ever **knowing** its value. Two limits are worth understanding, because they are
properties of the design rather than gaps in it:

- **The upstream sees the real value.** That is the whole point - it is a real request
  with a real credential. So if a host you allowed happens to echo the credential back
  (a debug or echo endpoint, or an error message that quotes the `Authorization`
  header), the agent reads it in the response. Scope secrets to hosts you trust not to
  reflect them, and prefer the narrowest, shortest-lived credential the provider
  offers.
- **"Allow all hosts" gives up the guarantee.** With no host list, the agent chooses
  the destination, so it can send the credential somewhere it controls. Use it only for
  a credential you would be comfortable handing over outright.

## Logging

Substitution happens inside the egress proxy, and a secret's **value is never written to
a log line or to disk**. Hezo also keeps no per-request trail of which secret was used
against which host, so there is no record to leak: the value never leaves the vault
except as a live substitution into the outbound request.

Diagnostics deliberately record the **placeholder** rather than the value. If a request
fails to reach its upstream, the log line names the host and the path with
`__HEZO_SECRET_<NAME>__` still in it - enough to debug the failure, inert if the log is
ever shared.

## Where agents can reach

The egress proxy runs on the machine hosting Hezo, so by default it refuses to carry
agent traffic to **loopback, link-local and private addresses** - an agent cannot tunnel
through it to reach Hezo's own API, its database, or anything else bound to your host or
LAN. The check is made on the address a name actually resolves to, not on the name
itself.

If an MCP server or a git remote your agents genuinely need lives on your local network,
start Hezo with `--egress-allow-private-targets` (or
`HEZO_EGRESS_ALLOW_PRIVATE_TARGETS=1`) to lift the restriction.

## How secrets get in

You're always the one who provides a secret:

- **An agent asks** - when an agent hits something it needs a credential for, it
  requests one. The request lands in your Inbox (and the project Dashboard's action items)
  and you paste the value into the task thread. It's encrypted and stored immediately, and
  the agent only ever references it by placeholder afterwards.
- **You add it directly** in the web app, scoping its allowed hosts.
- **You connect an account** via OAuth (for example GitHub, or a SaaS tool), and Hezo
  stores and refreshes the token for you.

## Why this matters

The net effect: a buggy, jailbroken, or outright malicious agent **cannot exfiltrate
your secrets.** It never sees them, and it can only use them against the hosts you
allowed.
