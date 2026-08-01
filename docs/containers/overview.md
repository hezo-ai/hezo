---
title: Containers overview
order: 25.1
section: Containers
---

# Containers

Agents write and run real code. Hezo never runs that code on your host: **every project
gets its own container, and agents only ever work inside it.**

That single decision is what makes the rest of the product safe to use. A container is
the boundary between an agent's work and everything else you own, and it is also the unit
Hezo schedules, sizes and bills against. This section covers what a container is, where
you can run them, and how to choose.

- [Local Docker](/docs/containers/local-docker) - the default: containers on the Docker
  daemon on the same machine as Hezo.
- [Remote containers](/docs/containers/remote/overview) - containers on a managed sandbox
  service, so nothing runs on your machine.

## What a container gives you

**Isolation.** Each project's container is a private workspace holding that project's code
and tools. One project's agents cannot see or touch another's work, and from inside the
container agents cannot reach your host filesystem, processes or devices. If something
goes wrong, the blast radius is one project.

**Secret protection.** Outbound traffic that could carry one of your secrets goes through
Hezo's egress proxy, which substitutes the real value at the last moment. Agents inside
the container hold placeholders, never the actual credentials, and the proxy enforces
which hosts each secret may be sent to. Git signing and SSH keys stay outside the
container too, so commits land verified without the private key ever being exposed.

**Limits.** Each container runs with a memory cap, a process limit that stops fork bombs,
and a reduced set of Linux capabilities, so a runaway agent cannot exhaust the machine it
is on.

For the full security picture, including the honest note on where a container's boundary
ends, see [Container isolation](/docs/security/container-isolation) and
[Secret protection](/docs/security/secret-protection).

## Containers run only when there is work

A container starts automatically the moment an agent run or an assistant chat needs one,
and stops again after sitting idle for a couple of minutes. A quiet instance runs zero
containers. That window is fixed rather than configurable: its only job is to keep a
container warm between one run and the next in the same project. Because containers do not
stay up between bursts, they are not a place to run a long-lived dev or preview server.

Each container serves one run at a time, which is why a problem in one run stays in one
run.

## Choosing where containers run

Both options give you the same product. The agents, the tools, the tunnel back to Hezo,
the egress proxy and every security property above are identical. What differs is whose
machine the container process runs on, and therefore what bounds how many you can run at
once.

| | [Local Docker](/docs/containers/local-docker) | [Remote](/docs/containers/remote/overview) |
| --- | --- | --- |
| Where the container runs | Your machine | The provider's machines |
| Prerequisite | A running Docker daemon | An account and API key with the provider |
| What bounds concurrency | Your machine's memory | Your provider plan's memory and disk quota |
| Load on your machine | Every container | Effectively none |
| Cost | Hardware you already own | Billed by the provider |

Local Docker is the default and needs no credentials. Choose a remote service when you
want agent work off your machine entirely, when you want to run more at once than your
hardware allows, or when Hezo itself runs somewhere too small to host containers.

## Switching at any time

**You choose the container service in Settings -> Containers, and you can change it
whenever you like** - including switching back to local Docker, which needs no
credentials. Switching to a managed service asks for that provider's API key, which is
stored encrypted in the secrets vault and used only by Hezo to reach the provider. It
never enters an agent container.

Three things happen, in this order, and the order is the point:

1. **Hezo checks the destination first.** If the key is wrong or the provider is
   unreachable, the switch is refused and you stay exactly where you were. Nothing is
   destroyed before the new service has answered.
2. **Every container running at that moment is destroyed.** Agent runs in progress end and
   are reported as failed on their project's Container page, and can be started again once
   the switch is done. Hezo tells you how many containers and how many runs that is before
   you confirm.
3. **New runs provision on the new service.**

Containers cannot be moved between services, which is why the switch destroys rather than
migrates. A project's repositories are re-cloned from their git remote on the new service,
so no work that has been pushed is lost.

## Setting the service at startup

The container service can also be set when Hezo starts, with a flag or an environment
variable:

```sh
hezo --sandbox-backend daytona --daytona-api-key "<key>"
```

```sh
HEZO_SANDBOX_BACKEND=daytona HEZO_DAYTONA_API_KEY=<key> hezo
```

**This sets the service a brand-new instance starts on.** It is a convenience for
provisioning an instance non-interactively, not a second way to configure a running one.
Once a service has been chosen in Settings -> Containers, that stored choice wins and the
flag and environment variable are ignored on later startups. To change a running
instance, use Settings -> Containers.

Selecting a managed service Hezo cannot reach is **fatal at startup**. Hezo reports the
problem and exits rather than silently falling back to local Docker: an instance that
quietly switched substrates would look healthy while doing something you did not ask for.

See the [CLI reference](/docs/reference/cli#environment-variables) and the
[Configuration reference](/docs/deployment/configuration) for the full list of flags and
environment variables.

## How much can run at once

Two global limits in **Settings -> Containers** bound what a burst of agent activity can
consume:

- **Total container memory** - how much memory all project containers may use at once. The
  assistant chat's container runs on top of it, so a chat turn never waits behind
  background work. A run whose container will not fit in what is left waits in the queue
  and starts as memory frees up; the assistant chat always starts. There is no separate
  limit on the *number* of containers: how many fit follows from this budget and the cap
  below.
- **RAM cap per container** - the memory limit applied to every container (2 GB by
  default). A project that needs more can override it on its own Container page. A
  container over its cap is stopped, or has its biggest process killed by the kernel,
  rather than taking down anything else.

The automatic default for the first of those depends on where containers run, because the
memory being budgeted is not the same memory. The settings page names the service in use
and shows which rule applies; each backend page below explains its own.

As a sizing rule of thumb, one working agent (its coding CLI plus the helper tools it
spawns) typically uses 300-350 MB of memory, and the container cap bounds the total
regardless of how many agents share it.

## What is not available on either backend

- **Dev-server previews.** Mapping a port out of a container to a browser is not currently
  supported on either backend.
- **Long-lived processes.** Containers stop when a project goes idle, so nothing that
  needs to stay up belongs in one.
