---
title: Container isolation
order: 20
section: Security
---

# Container isolation

Agents execute real, often AI-generated code. Hezo runs that code where it can't hurt
you: **every project gets its own Docker container, and agents only ever run inside
it** - never on your host directly.

## A sandbox per project

Each project's container is a private workspace holding that project's code and tools.
Because the sandbox is per project, one project's agents can't see or touch another's
work - the blast radius of anything going wrong is contained to a single project.

## Containers run only when there is work

A container starts automatically the moment an agent run or an assistant chat needs it,
and stops again after sitting idle (15 minutes by default). A quiet instance runs zero
containers. Two global limits in **Settings > Concurrency** bound what a burst of agent
activity can consume:

- **Maximum active containers** - how many project containers agent runs may use at the
  same time. The assistant chat's container does not count against it, so a chat turn
  never waits behind background work. When unset, Hezo sizes it automatically from the
  machine's memory: RAM plus swap, minus 1 GB for the machine itself and one container's
  worth for the assistant chat, divided by the RAM cap below. Swap counts in full, since
  a container is idle between runs. Runs that would need another container past the limit
  wait in the queue and start as containers go idle; the assistant chat always starts.
- **RAM cap per container** - the memory limit applied to every container (2 GB by
  default; projects that need more can override it in their own settings). A container
  over its cap is stopped, or has its biggest process killed by the kernel, instead of
  taking down the whole server.

As a sizing rule of thumb, one working agent (its coding CLI plus the helper tools it
spawns) typically uses 300-350 MB of memory, and the container cap bounds the total
regardless of how many agents share it. The idle timeout is configurable on the same
page; note that stopping an idle container also stops any dev or preview servers running
inside it, and setting the timeout to 0 keeps containers always on.

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
strong sandbox, not a virtual machine. On macOS and Windows, Docker Desktop already runs
every container inside a lightweight VM; on a server, the usual and recommended setup is to
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
