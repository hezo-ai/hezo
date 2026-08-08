---
title: Container isolation
order: 20
section: Security
---

# Container isolation

Agents execute real, often AI-generated code. Hezo runs that code where it can't hurt
you: **every project gets its own container, and agents only ever run inside it** - never
on your host directly. Hezo drives that through any
[Docker-compatible runtime](/docs/deployment/container-runtimes); the isolation described
here is the same whichever you use.

This page is the security case for that boundary. For where those containers run and how
to choose - your own Docker daemon or a managed service - see
[Containers](/docs/containers/overview). Every property described here holds on either.

## A sandbox per project

Each project's container is a private workspace holding that project's code and tools.
Because the sandbox is per project, one project's agents can't see or touch another's
work - the blast radius of anything going wrong is contained to a single project.

## Containers run only when there is work

A container starts automatically the moment an agent run or an assistant chat needs it,
and stops again after sitting idle (a couple of minutes). A quiet instance runs zero
containers. Two global limits in **Settings > Containers** bound what a burst of agent
activity can consume:

- **Total container memory** - how much memory all project containers may use at once.
  The assistant chat's container runs on top of it, so a chat turn never waits behind
  background work. When unset, Hezo sizes it automatically, and how depends on where
  containers run: on [local Docker](/docs/containers/local-docker) it is derived from the
  machine's memory (RAM + swap, less 1 GB always kept free for the operating system and
  Hezo itself, less one container's worth for the assistant chat; swap counts in full,
  since a container sits idle between runs), while on a
  [managed service](/docs/containers/remote/overview) the containers are not on your
  machine at all and the default is a flat starting figure you raise deliberately. A run
  whose container will not fit in what is left waits in the queue and starts as memory
  frees up; the assistant chat always starts. There is no separate limit on the *number*
  of containers: how many fit follows from this budget and the RAM cap below, and a
  project that raises its own cap simply takes a larger share.
- **RAM cap per container** - the memory limit applied to every container (2 GB by
  default; projects that need more can override it on their own Containers page). A
  container over its cap is stopped, or has its biggest process killed by the kernel,
  instead of taking down the whole server.

A third setting on the same page, **Disk per container**, sizes each container's own
filesystem where the container service allocates one - see
[Containers](/docs/containers/overview#how-much-can-run-at-once).

As a sizing rule of thumb, one working agent (its coding CLI plus the helper tools it
spawns) typically uses 300-350 MB of memory, and the container cap bounds the total
regardless of how many agents share it.

Containers stop a couple of minutes after a project's last activity and start again on
demand, so a quiet instance runs none. That window is fixed rather than configurable -
its only job is to keep a container warm between one run and the next in the same
project, which takes seconds, and there is no setting an operator could tune better than
that. Because containers do not stay up between bursts, they are not a place to run a
long-lived dev or preview server.

From inside the container, agents **cannot** reach:

- your **host filesystem** (only the project's own workspace is available), or
- your **host processes or devices**.

Outbound network access is handled separately, through Hezo's egress proxy (below).

## Outbound traffic goes through the egress proxy

Hezo points the container's outbound traffic at its **egress proxy** using the standard
`HTTP(S)_PROXY` settings. That's what makes the
[secret protection](/docs/security/secret-protection) guarantee hold: your real secrets
are only ever materialised at the proxy - agents inside the container hold placeholders,
never the actual values - and the proxy enforces which hosts each secret may be sent to.
(Calls to your LLM provider are the one exception: they go direct, with the model
credentials injected into the run.)

Each run's proxy is scoped to that run with its own token, so one run can't route requests
through another's proxy. A run that somehow reached the proxy without its token is simply
turned away - it never gets a secret substituted, so the guarantee holds even then.

## Resource and privilege limits

Each container also runs with guardrails so a runaway or misbehaving agent can't exhaust the
host: a **memory cap** (the global RAM cap per container, overridable per project, with
the running total shown while an agent works), a
**process limit** that stops fork bombs, and a **reduced set of Linux capabilities** (the
container starts with all capabilities dropped and only the few the workload needs added
back). A proper init process runs as PID 1 so exited helper processes are always cleaned up.

One honest note on the boundary: a container shares your machine's Linux kernel, so it is a
strong sandbox, not a virtual machine. On macOS and Windows the runtime already runs every
container inside a lightweight VM (Docker Desktop, Colima, Rancher Desktop, OrbStack and
Lima all work this way); on a server, the usual and recommended setup is to
run Hezo on its own VM or host. If you're running untrusted work, keep Hezo on a dedicated
machine or VM - that is the boundary that isolates it from everything else.

## Keys never enter the container

The keys that matter most never sit inside the sandbox where agent code could read
them:

- **Your secrets** are referenced by placeholder and substituted *outside* the
  container, at the proxy.
- **Git signing and SSH keys** stay on the host. When an agent commits or pushes, the
  signing happens host-side on its behalf - the private key is never exposed to the
  agent. Commits land **verified**, signed by your project's key. See
  [Git & verified commits](/docs/security/git-and-verified-commits).

## What this gives you

Putting the three pillars together - placeholders + egress scoping, encryption at rest,
and container isolation - a compromised agent is boxed in: it can't read your secrets
(they're only ever materialised at the proxy, behind host allow-lists), can't reach your
host, and can't escape its project. You get the upside of autonomous agents running real
code without betting your system on every line of it being safe.
