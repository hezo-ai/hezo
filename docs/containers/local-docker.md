---
title: Local Docker
order: 25.2
section: Containers
---

# Local Docker

The default. Agent containers run on the Docker daemon on the same machine as Hezo, and
nothing about a run leaves that machine except the traffic the agent itself makes.

This is the right choice for most instances. It needs no account anywhere, no API key, and
no network path beyond what Hezo already has.

## What you need

A running Docker daemon. Hezo checks at startup and exits with install and start guidance
if it cannot reach one, so a misconfigured daemon is never a mysterious failure later. See
[Installation](/docs/getting-started/installation).

Docker Desktop on macOS and Windows works, as does Docker Engine on Linux. Nothing else is
required: Hezo builds and manages the container image itself.

## How much can run at once

When the total container memory limit is left unset, Hezo sizes it from the machine it is
running on:

**(RAM + swap), less 1 GB always kept free for the operating system and Hezo itself, less
one container's worth reserved for the assistant chat.**

Swap counts in full, because a container sits idle between runs rather than working
continuously. The remainder is the budget all project containers share. A run whose
container will not fit in what is left waits in the queue and starts as memory frees up;
the assistant chat always starts.

You can set the total explicitly in **Settings -> Containers** if you would rather keep
more headroom, and a project that needs a bigger container than the 2 GB default can raise
its own cap on its Containers page.

Because the budget is derived from your machine, it follows the machine. Move Hezo to a
larger host and the automatic figure grows with it.

## Disk

A project's workspace is a directory on your disk, so the whole disk is behind it. There
is no per-container disk ceiling to plan around, and Hezo does not prune anything on size
grounds here. Worktrees for closed tasks are cleaned up as tasks close, as they are
everywhere.

The **Disk per container** setting therefore allocates nothing on this backend. It is
still there, and still what a container would get if you moved to a managed service, but
on the local daemon there is no filesystem to size: giving a container a quota would need
a storage driver with project-quota support that Hezo does not require you to run.

## Reaching services on your machine

Because the container is on your machine, it can reach things that are also on it. The one
that matters in practice is a **local AI model provider**: pointing an AI provider at
`http://host.docker.internal:11434` (Ollama, LM Studio and similar) works here and only
here. See [AI models](/docs/ai-models).

## Network access from a container

Outbound network is whatever your machine allows, so it is normally unrestricted: HTTPS,
SSH and other protocols all work unless you run a firewall of your own. This is the
practical difference from a [remote service](/docs/containers/remote/overview), where the
provider may carry only some protocols - so if your agents need to reach something over
SSH from inside the container, local Docker is the option that has it.

HTTP and HTTPS still pass through Hezo's egress proxy either way. That is what substitutes
credentials into agent requests, and it applies on every container service.

## Startup

The first container for a project takes a few seconds. Hezo builds the agent image once
and reuses it, so later containers start immediately.

## Switching to and from local Docker

Local Docker is what a new instance starts on, and it is always available to switch back
to because it needs no credentials. Switching away destroys every running container first;
see [Switching at any time](/docs/containers/overview#switching-at-any-time) for exactly
what happens and in what order.

If you want containers off your machine entirely, see
[Remote containers](/docs/containers/remote/overview).

## Uninstalling

`hezo uninstall` removes the containers it created along with the data directory. On local
Docker that needs no extra arguments. See the [CLI reference](/docs/reference/cli).
