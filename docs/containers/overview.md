---
title: Containers overview
order: 17.5
section: Containers
---

# Containers

Agents write and run real code. Hezo never runs that code on your host: **agents only ever
work inside a container, and a container is only ever used by one project.**

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

**Limits.** Each container runs against a hard memory cap, and where it shares your own
machine ([local Docker](/docs/containers/local-docker)) Hezo also applies a process limit
that stops fork bombs and drops Linux capabilities to the few the workload needs, so a
runaway agent cannot exhaust the machine it is on. On a managed service the equivalent
guardrails between sandboxes are the provider's own.

For the full security picture, including the honest note on where a container's boundary
ends, see [Container isolation](/docs/security/container-isolation) and
[Secret protection](/docs/security/secret-protection).

## Containers run only when there is work

A container starts automatically the moment an agent run or an assistant chat needs one,
and stops again after sitting idle for a couple of minutes. A quiet instance runs zero
containers. That window is fixed rather than configurable: its only job is to keep a
container warm between one run and the next in the same project. Because containers do not
stay up between bursts, they are not a place to run a long-lived dev or preview server.

**Each container is timed separately.** A project running several tasks at once holds one
container per run, and any of them that finishes and then sits idle past the window is
retired on its own - the project does not have to fall completely quiet first. So a busy
project gives its unused memory back while it keeps working, rather than holding it until
the last task ends.

**An open assistant chat gets a longer window.** A pause between chat messages is you
reading a reply, not an idle project, so a container serving a live chat session is kept
up for about fifteen minutes after the last message rather than a couple of minutes. That
way a reply you take a few minutes to answer does not cost a container start. Once the
session ends, the ordinary window applies again.

Each container serves one run at a time, which is why a problem in one run stays in one
run. A project therefore has as many containers as it has runs going at once - two agents
working in the same project get a container each - and they all go away when the work does.

**Settings -> Containers lists every container running on your instance**, whichever
project it belongs to and whatever state it is in, with the task it last served. A
container appears there as soon as it exists, marked **Starting** while it is still being
set up, so you can watch a slow start rather than wait for it. Open one to see its output,
including the output it captured on the way down if it failed. The only action there is
**Remove**, which is the fix for a container that has wedged: Hezo starts a fresh one the
next time a run needs it. Removing a container that is running a task ends that task's run,
and the confirmation says so.

A container that fails while it is being set up stays in the list as **Failed**, with the
reason and whatever its output captured, so you can read what went wrong and remove it.

**A run's log opens by naming the container it was given**, along with the memory and disk
that container was built with. The identifier is a link to that container's page, so a run
that behaved oddly leads straight to the container that served it rather than to a guess
based on timing. Because a project holds several containers at once, that link is the only
reliable way to tell which one a particular run used - and it keeps working after the
container itself is gone, since the log records it rather than looking it up.

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

The key field is offered every time you switch to a managed service, including when a key
is already saved. Leave it blank to keep the saved one, or enter a new one to replace it -
which is how you correct a key that has expired or been revoked.

Three things happen, in this order, and the order is the point:

1. **Hezo checks the destination first.** If the key is wrong or the provider is
   unreachable, the switch is refused and you stay exactly where you were. Nothing is
   destroyed before the new service has answered.
2. **Every container running at that moment is destroyed.** Agent runs in progress end and
   are reported as failed, and can be started again once the switch is done. Hezo tells you
   how many containers and how many runs that is before you confirm.
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
hezo --config /etc/hezo/hezo.config.cjs   # containers: { backend: 'daytona', daytona: { apiKey: '<key>' } }
```

**This sets the service a brand-new instance starts on.** It is a convenience for
provisioning an instance non-interactively, not a second way to configure a running one.
The first startup records the choice, and from then on the stored setting wins:
restarting with a different flag or environment variable does not switch an existing
instance - Hezo logs that it ignored the flag and stays where it is, so a stale launch
script or leftover environment variable can never flip the substrate under your agents.
To change an instance once it has booted - stopped or running - use Settings ->
Containers.

The provider key is the one flag that stays live: passing `--daytona-api-key` (or
`containers.daytona.apiKey`) at a later startup rotates or supplies the credential for the
backend already chosen - it never chooses a backend by itself. See
[Restarting an instance on a managed service](#restarting-an-instance-on-a-managed-service).

Selecting a managed service Hezo cannot reach is **fatal at startup**. Hezo reports the
problem and exits rather than silently falling back to local Docker: an instance that
quietly switched substrates would look healthy while doing something you did not ask for.

### Restarting an instance on a managed service

Your service's API key is kept encrypted, so Hezo can only read it once the instance is
unlocked. Every restart comes back locked by design, which means Hezo connects to the
service a moment after you unlock rather than during startup. Nothing is lost by that:
agent runs do not start while the instance is locked either way.

If the connection then fails, Hezo records the reason in the server log and stays
disconnected. It never falls back to local Docker, so container operations report that
failure instead of running somewhere you did not choose.

Passing `--daytona-api-key` (or `containers.daytona.apiKey`) at startup works on a locked
instance too. Hezo uses the key straight away for that run and saves it once you unlock,
so later restarts no longer need it.

See the [CLI reference](/docs/reference/cli#the-config-file) and the
[Configuration reference](/docs/deployment/configuration) for the full list of settings and
flags.

## How much can run at once

Two global limits in **Settings -> Containers** bound what a burst of agent activity can
consume:

- **Total container memory** - how much memory all project containers may use at once. The
  assistant chat's container runs on top of it, so a chat turn never waits behind
  background work. A run whose container will not fit in what is left waits in the queue
  and starts as memory frees up; the assistant chat always starts. There is no separate
  limit on the *number* of containers: how many fit follows from this budget and the cap
  below.

  The budget is shared across every project, and no project can sit on a share of it that
  it is not using. A container belongs to the project it was built for and is never handed
  to another - it is built around that project's checkout - so when a run cannot fit,
  Hezo retires an idle container belonging to some other project and builds a fresh one
  for the waiting run. Containers that have only just gone idle are left alone, so a
  project working through a burst of tasks keeps its containers warm between them. Where
  more than one project is holding idle containers, the one holding the most gives one up
  first.
- **RAM cap per container** - the memory limit applied to every container (2 GB by
  default). A project that needs more can override it on its own Containers page. A
  container over its cap is stopped, or has its biggest process killed by the kernel,
  rather than taking down anything else. When the kernel does the killing, the run it was
  serving is reported as failed with an error naming the signal and this cap, so a run
  that ran out of memory says so instead of failing without explanation.

  Changing the cap does not resize a container that is already running - nothing can
  resize one in place - so Hezo replaces it instead. The next run in that project gets a
  container built to the new cap and the old one is removed, which costs one cold start.
  Until that happens the Containers page shows what each container actually has, not what
  the setting now says.
- **Disk per container** - how much disk each container is given for its checkouts,
  dependencies and build output (5 GB by default). Like the RAM cap, a project that needs
  more can override it on its own Containers page. A container that fills most of its
  allocation is replaced rather than reused, so a run never runs out of space partway
  through. This only allocates anything where the container service gives each container
  its own filesystem: on [local Docker](/docs/containers/local-docker) a container's
  workspace has your whole disk behind it, so there is nothing to allocate.

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
