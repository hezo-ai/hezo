---
title: Secret protection & egress
order: 11
section: Security
---

# Secret protection & the egress proxy

Agents run real code and make real network calls, often needing real credentials — a
Stripe key, a GitHub token, a webhook secret. Hezo is built so that **agents never
hold the real value of any secret.** This is the single most important thing to
understand about how Hezo keeps you safe.

## Placeholders, not secrets

Whenever an agent needs a credential, it uses a **placeholder** — a named stand-in —
instead of the real value. The placeholder is an inert string. The agent can put it in
a request header or a URL, log it, or paste it into a comment, and nothing leaks,
because it isn't the secret.

The real value lives encrypted in Hezo's vault (see
[Master key & encryption](/docs/security/master-key)) and is only ever materialised at
the last possible moment.

## The egress proxy

All of an agent's outbound network traffic is routed through Hezo's **egress proxy**.
As a request leaves, the proxy:

1. **Looks for placeholders** in the request's headers and URL.
2. **Checks the destination** against that secret's list of **allowed hosts**.
3. **Substitutes the real value** only if the host is allowed, then forwards the
   request.

If a placeholder is used against a host it isn't allowed for, the proxy **blocks the
request**. So even if an agent is tricked or compromised into trying to send your
Stripe key somewhere it shouldn't, the substitution simply never happens and the
secret never leaves.

## Scoped to the hosts that need it

Every secret carries an **allowed-hosts** list — the upstreams it may be used with
(for example `api.stripe.com`). This is what makes a leak structurally impossible
rather than just discouraged: a secret can only ever reach the destinations you scoped
it to.

## Audited, never logged

Every substitution is recorded in an audit log **by secret name and destination only**
— the value itself is never logged. Requests that contain no placeholder aren't
audited at all. You get a clear trail of which secret was used, for which run, against
which host.

## How secrets get in

You're always the one who provides a secret:

- **An agent asks** — when an agent hits something it needs a credential for, it
  requests one, and you paste the value into the task thread. It's encrypted and stored
  immediately, and the agent only ever references it by placeholder afterwards.
- **You add it directly** in the web app, scoping its allowed hosts.
- **You connect an account** via OAuth (for example GitHub, or a SaaS tool), and Hezo
  stores and refreshes the token for you.

## Why this matters

The net effect: a buggy, jailbroken, or outright malicious agent **cannot exfiltrate
your secrets.** It never sees them, it can only use them against hosts you allowed, and
every use is on the record.

## Next

- [Master key & encryption](/docs/security/master-key) — how the vault is protected.
- [Container isolation](/docs/security/container-isolation) — why egress can't be bypassed.
