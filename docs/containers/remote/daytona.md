---
title: Daytona
order: 25.4
section: Containers
---

# Daytona

[Daytona](https://www.daytona.io) is the managed sandbox service Hezo supports today.
Everything on [Remote containers](/docs/containers/remote/overview) applies; this page
carries the figures and caveats that are Daytona's own.

## Connecting

1. Create an API key in your Daytona dashboard.
2. In Hezo, open **Settings -> Containers**, choose Daytona, and paste the key.
3. Confirm the switch. Hezo checks the key before destroying anything, so a wrong key
   leaves you exactly where you were.

The key is stored encrypted in the secrets vault and used only by Hezo to reach Daytona.
It never enters an agent container.

### Replacing an expired or revoked key

The same form replaces it. Choose Daytona in **Settings -> Containers** and paste the new
key: the field is always offered, and leaving it blank keeps the key already saved. If
Daytona refuses the stored key, that is where you correct it.

If the stored key stops working while Hezo is running on Daytona, containers stop being
provisioned and the reason is reported in the server log. Hezo still starts and the web
app still loads, so you can paste a new key or switch back to local Docker.

You can also set it at startup on a brand-new instance, with
`--sandbox-backend daytona --daytona-api-key "<key>"` or the matching
`HEZO_SANDBOX_BACKEND` and `HEZO_DAYTONA_API_KEY` environment variables. That only chooses
what a fresh instance starts on; see
[Setting the service at startup](/docs/containers/overview#setting-the-service-at-startup).

`--daytona-api-url` (or `HEZO_DAYTONA_API_URL`) points Hezo at a regional or self-hosted
Daytona endpoint instead of the public API.

## Limits

These numbers are Daytona's. Another provider will have different ones.

- **A sandbox gets at most 8 GB of memory.** A project memory cap above that is refused
  when the run tries to start, with the limit named.
- **Your account has a total disk quota across all sandboxes**, and it is usually what you
  hit first - before the memory quota, and before Hezo's own memory budget. It is what
  makes **Disk per container** the setting to think about here: at Hezo's 5 GB default a
  30 GB quota is six sandboxes at once, where the 10 GB Hezo used to request would have
  allowed three. If runs queue while the memory budget looks free, this is the limit to
  check.

Size Hezo's total container memory and its disk per container against whichever of those
binds first for your plan.

## Startup time

**The first sandbox for a project takes about half a minute** because Daytona builds the
image; later ones start in a few seconds.

The build is cached on the text of the Dockerfile Hezo sends rather than on an image tag,
which is why Hezo pins the image by digest. A tag would be byte-identical forever and
Daytona would keep serving a stale toolchain.

## Network access from a sandbox

**Daytona filters outbound traffic by protocol, not just by destination**, and this is the
one limit most likely to surprise you. Measured from a live sandbox:

- **HTTPS works**, to the common developer hosts Daytona pre-approves - GitHub, package
  registries and similar. A host outside that set has its connection accepted and then
  reset partway through, which surfaces as `curl: (35) Recv failure: Connection reset by peer`.
- **SSH does not work, on any port.** Port 22 is dropped, so you get a connect timeout.
  Port 443 accepts the connection and then resets it once the traffic turns out not to be
  TLS, which surfaces as `kex_exchange_identification: read: Connection reset by peer`. It
  reads like the far end refusing you, but the reset comes from Daytona.
- **Other non-TLS protocols behave like SSH** - admitted, then reset.

Daytona does expose network settings on a sandbox (an allowlist of domains, or one of IP
ranges), and Hezo could set them, but neither lifts this. A domain allowlist matches on the
server name inside a TLS handshake, which SSH has none of; and allowing the destination's
own IP ranges outright still leaves both SSH ports dead, because the filter is looking at
the protocol.

**What this means in practice.** Agents are told which container service they are on and
what its network will carry, so they reach for an HTTPS equivalent - a REST API or an MCP
connector - rather than retrying an `ssh` that cannot succeed. If you are choosing a
container service and your work genuinely needs SSH out of the container, local Docker is
the one that has it.

## Caveats

- **No per-sandbox memory statistics.** Daytona's telemetry endpoint is unavailable on an
  ordinary account, so Hezo cannot watch a container approach its cap and stop it
  gracefully. Daytona's own out-of-memory handling applies instead. Because a container
  serves one run at a time, that ends the run that overran and nothing else.
- **Agent output arrives over one long-lived connection**, which Daytona's gateway closes when
  it goes quiet - and an agent thinking or waiting on a tool call is quiet for tens of seconds
  at a time. Hezo reopens it and carries on from where it stopped, so a run is not affected. If
  it cannot stay open at all, the run is retried rather than failed.
- **Daytona's gateway returns a brief error now and then** - most often a `502 Bad Gateway`
  while it cannot reach the service behind it. Hezo retries these itself, so a passing blip
  does not fail a container that is starting up, a project resuming, or a run in progress. If
  it lasts longer than that the operation fails with the status Daytona returned, and the
  container list shows the project's real state on the next refresh.
- **Suspended sandboxes still count.** A suspended container holds its memory and disk
  against your account quota. On a small plan, idle projects can hold the whole allowance.

## When the quota is already full

A create refused with `Total disk limit exceeded` means the account has no room left,
not that anything is wrong with Hezo. Hezo removes its own sandboxes once nothing
references them - including the ones a previous life of the same instance left behind,
which it recognises by a label carrying an id kept beside the data directory rather than
in the database, so a `--reset` does not lose track of them. That sweep runs at startup
and every ten minutes after.

What Hezo will **not** touch is a sandbox another Hezo created, because several instances
can share one Daytona account and it has no way to know whether that one is busy. If the
dashboard shows sandboxes from an instance you no longer run, remove them there. Lowering
**Disk per container** is the other lever: it decides how many fit in the quota at all.
