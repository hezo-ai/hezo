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

## Caveats

- **No per-sandbox memory statistics.** Daytona's telemetry endpoint is unavailable on an
  ordinary account, so Hezo cannot watch a container approach its cap and stop it
  gracefully. Daytona's own out-of-memory handling applies instead. Because a container
  serves one run at a time, that ends the run that overran and nothing else.
- **Suspended sandboxes still count.** A suspended container holds its memory and disk
  against your account quota. On a small plan, idle projects can hold the whole allowance.
