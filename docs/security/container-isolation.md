---
title: Container isolation
order: 20
section: Security
---

# Container isolation

Agents execute real, often AI-generated code. Hezo runs that code where it can't hurt
you: **agents only ever work inside a container - never on your host directly.** Where
those containers live is your choice, made in **Settings -> Containers**: on your own
machine through any [Docker-compatible runtime](/docs/deployment/container-runtimes) (the
default), or on a [managed sandbox service](/docs/containers/remote/overview) such as
[Daytona](/docs/containers/remote/daytona), so agent work does not touch your machine at
all. The choice is not a commitment: the same settings page
[switches a running instance](/docs/containers/overview#switching-at-any-time) between
them at any time, in either direction.

This page is the security case for that boundary, and it is one case, not two: the same
container image, the same tunnel back to Hezo, the same egress proxy and the same key
handling apply on either backend. The few properties that belong to one backend are
called out as such. For where containers run, how they are sized and how to switch, see
[Containers](/docs/containers/overview).

## One project, one run, one container

A container belongs to **exactly one project**, and serves **one agent run at a time**. A
project with two agents working at once holds two containers; between runs a container is
kept briefly and reused for that project's next run; and a container is never shared or
handed between projects.

The blast radius of anything going wrong is therefore one run in one project. Another
run's work - even in the same project - is in a different container, and another
project's might as well be on a different machine. What runs in the same project do
share is the project's work itself: the repositories they are collaborating on.

## Containers run only when there is work

A container starts the moment an agent run or an assistant chat needs one, and is
retired after a couple of minutes idle (a live assistant chat keeps its container for
about fifteen minutes, so a reply you take a moment to type does not pay a cold start). A
quiet instance runs zero containers.

What a burst of agent activity can consume is bounded in **Settings -> Containers**, and
every ceiling is enforced per container:

- a **global memory budget** every container shares, the assistant chat's included - a
  run whose container will not fit waits in the queue, while one container's worth of
  the budget is off limits to task runs so a chat turn always has room to start;
- a **RAM cap per container** (2 GB by default, with a per-project override) - a
  container at its cap is stopped, or has its biggest process killed, and the run reports
  the cap by name rather than failing mysteriously;
- a **disk allocation per container**, where the container service gives each container
  its own filesystem.

How the automatic defaults are derived - from your machine's memory locally, as a flat
budget you raise deliberately on a managed service - and the sizing arithmetic live in
[Containers](/docs/containers/overview#how-much-can-run-at-once).

## What a container cannot reach

From inside the container, agents **cannot** reach your **host filesystem** (only the
project's own workspace is available) or your **host processes and devices**. On a
managed service this holds in the strongest possible sense: the container is not on your
machine, so there is nothing of yours beside it to reach.

Outbound network access is handled separately, through the tunnel and egress proxy below.

## The container reaches Hezo through a tunnel

A run needs three things from Hezo: the MCP endpoint (its tools), the egress proxy
(below), and the ssh-agent (commit signing). Hezo **reaches into the container** and runs
a small tunnel client there; all three arrive on the container's own loopback. The
mechanism is described in
[Remote containers](/docs/containers/remote/overview#how-a-container-reaches-hezo), and
it is identical on local Docker.

Two consequences matter for your security posture:

- **Your instance exposes nothing.** The per-run endpoints on Hezo's side bind loopback
  only, so there is no inbound port to open and no public hostname to have - not for
  local containers, and not for remote ones.
- **Each run's endpoints are its own**, guarded by per-run tokens, so one run cannot
  drive another run's proxy or signer.

## Secrets are substituted outside the container, at the egress proxy

Agents hold **placeholders**, never secret values - see
[Secret protection](/docs/security/secret-protection). A request to any host that one of
your credentials or connectors is scoped to travels the tunnel to Hezo's **egress
proxy**, which substitutes the real value at the last moment and enforces that secret's
allowed hosts. Requests to everything else - package registries, documentation, a public
API no credential is scoped to - go straight out from the container and never pass
through your instance.

Routing those directly loses nothing: a secret can only ever materialise at the proxy,
so a request that reaches a credentialed host without the proxy carries the
unsubstituted placeholder, which is inert and simply fails upstream. The proxy, not the
route, is what the guarantee rests on.

Two boundaries sit on the proxy itself:

- **A per-run token.** Each run's proxy requires that run's own credential, so a process
  that somehow reached it without one is turned away - and even then, the most it could
  ever have shipped is a placeholder.
- **A destination guard.** The proxy refuses to carry traffic to loopback, link-local or
  private addresses, so it cannot be used as a tunnel to Hezo's own API, its database,
  or anything else on your host or LAN.

One exception, the same on every backend: the credential the coding CLI uses to reach
its **AI model provider** is injected into the run and travels direct, because proxying
breaks some model endpoints. It is the only secret that exists in plaintext inside a
run.

## Resource and privilege limits

Every container runs against a hard **memory ceiling**, and on a managed service a fixed
**disk allocation** - a runaway run is stopped at its cap, with the cap named, rather
than taking anything else down with it.

On **local Docker**, where the container shares your machine, Hezo also hardens the
container itself: a **process limit** that stops fork bombs, **all Linux capabilities
dropped** with only the few the workload needs added back, and a proper init process as
PID 1 so exited helpers are always cleaned up. On a **managed service** those knobs are
the provider's: isolation between sandboxes is the provider's own, and what Hezo
enforces there is the memory and disk contract above.

## Where the boundary actually is

One honest note per backend:

- **On your own machine**, a container shares your kernel - a strong sandbox, not a
  virtual machine. On macOS and Windows the runtime already runs every container inside
  a lightweight VM (Docker Desktop, Colima, Rancher Desktop, OrbStack and Lima all work
  this way); on a Linux server, the usual and recommended setup is to give Hezo its own
  VM or host. If you run untrusted work, that dedicated machine or VM is the boundary
  that isolates it from everything else.
- **On a managed service**, nothing of the agent's work executes on your machine - the
  container, its kernel and its neighbours are the provider's. The provider's machines
  hold your project's checkout and the run's output while work happens, plus the one
  plaintext credential noted above; they never hold your stored secrets, your keys or
  your master key, which stay on your instance. See
  [Remote containers](/docs/containers/remote/overview) for exactly what moves and what
  does not.

## Keys never enter the container

The keys that matter most never sit inside the sandbox where agent code could read
them:

- **Your secrets** are referenced by placeholder and substituted *outside* the
  container, at the proxy.
- **Your git credentials and signing key** stay on your instance. Clones and pushes
  authenticate through a placeholder the proxy substitutes on the way out, and commit
  signing happens instance-side on the agent's behalf - so commits land **verified**
  while the private key never exists inside the container. See
  [Git & verified commits](/docs/security/git-and-verified-commits).
- **Your master key** never leaves Hezo's own memory: it is not written to disk on your
  instance, let alone into a container. See
  [Master key & encryption](/docs/security/master-key).

## What this gives you

Putting the pillars together - placeholders + egress scoping, encryption at rest, and
container isolation - a compromised agent is boxed in: it can't read your secrets
(they only ever materialise at the proxy, behind host allow-lists), can't reach your
host, and can't escape its run's container or its project. You get the upside of
autonomous agents running real code without betting your system on every line of it
being safe.
