---
title: Remote containers
order: 25.3
section: Containers
---

# Remote containers

Point Hezo at a managed sandbox service and agent containers run on the provider's
machines instead of yours, while Hezo keeps doing all of the work that touches your data.

Everything in [Containers](/docs/containers/overview) still holds: one container per
project, started on demand, isolated from everything else, with secrets substituted at
Hezo's own egress proxy. This page covers what is different.

Hezo supports one managed provider today:

- [Daytona](/docs/containers/remote/daytona)

## What moves, and what does not

Only the compute moves. The provider supplies a machine that runs the container image and
nothing else:

| Stays on your Hezo instance | Runs on the provider |
| --- | --- |
| The database and every task, comment and document in it | The container process |
| The secrets vault and all encryption | The agent's coding CLI |
| The egress proxy, and every credential substitution it makes | Whatever the agent runs (builds, tests, package installs) |
| The SSH agent and your repositories' signing key | - |
| Deciding what each agent may reach | - |

The provider never receives a private key, a stored credential, or the master key. Secrets
an agent uses reach the outside world as placeholders that are substituted at Hezo's own
egress proxy, so what runs in the sandbox is a stand-in that is useless to anyone who reads
it, including the provider.

There is one exception, and it is the same one that applies to a local container: the API
key or token the coding CLI uses to reach its **AI model provider** is passed to it
directly, because some model endpoints break when proxied. On a managed backend that means
the provider's infrastructure handles that one credential. Nothing else about a run is in
the clear there. See [Secret protection](/docs/security/secret-protection).

## How a container reaches Hezo

A container needs three things from Hezo: the MCP endpoint (its toolset), the egress proxy
(so credentialed requests get their real values), and the SSH agent (so commits are signed
and `git push` works).

Hezo reaches **into** the container rather than the other way round. It opens one extra
exec, runs a small tunnel program there, and multiplexes those three connections over that
stream. Inside the container all three arrive on `127.0.0.1`.

Three consequences worth knowing:

- **Your Hezo instance needs no public hostname and no inbound port.** Outbound access to
  the provider is enough, which is what lets an instance on a laptop drive a fleet of
  remote containers.
- **There is nothing new to firewall.** The egress proxy and SSH agent bind loopback only,
  on every backend.
- **It is the same mechanism locally.** Containers on your own Docker daemon reach Hezo
  the same way, over the same code, so behaviour does not differ between the two.

## Egress

Requests that could carry one of your secrets, or that belong to a connector with a method
allowlist, travel the tunnel to Hezo's egress proxy, which substitutes the real credential
at the last moment. Everything else - `apt`, `npm`, `pip`, downloading a browser - goes
straight out from the container to the internet and never passes through your instance.

Hezo does not use any egress or firewall feature the provider offers. There is one egress
path and Hezo owns it, so the rules are the same wherever the container runs.

## What bounds how much can run

Three ceilings apply, and on a managed backend the one that binds first is usually not the
one you set.

**Hezo's memory budget, which you set.** Concurrency is bounded by the total container
memory limit as it is locally, but the automatic default is different. Locally Hezo sizes
it from your machine's memory; with a managed backend the containers are not on your
machine, so the default is a flat starting figure you raise deliberately. Treat it as a
spend limit rather than a share of your RAM. The Containers settings page names the
service in use and shows which of the two rules applies.

**Your provider account, which Hezo cannot see.** Providers cap how much memory and disk
your organisation may hold across all sandboxes at once, and on a small plan that ceiling
is reached well before Hezo's memory budget is. Hezo keeps admitting runs the provider
then refuses, and the refusal surfaces as a container error on the project, naming the
provider's limit.

To size the budget so this does not happen, divide your plan's total memory **and** its
total disk by what one container takes, and use the smaller of the two. Note a container
takes slightly more than its cap (the cap plus a little headroom, rounded up to whole GB).
The actual figures are per provider: see the provider's own page.

**The per-sandbox cap, which the provider enforces.** Providers also cap a single sandbox.
Ask for more than the provider can give and the run fails with a message naming the limit.
Hezo never quietly starts a smaller container than the cap it promised, because the rest
of the system is sized against that promise.

## What else to expect

- **Disk is finite, and you choose how much.** A local workspace has your whole disk behind
  it; a sandbox gets exactly what Hezo asks for. **Disk per container** in Settings ->
  Containers sets that (5 GB by default), and a project that needs more can override it on
  its own Containers page - the same shape as the RAM cap. Hezo prunes worktrees for closed
  tasks and replaces a container that fills most of its allocation, so a run never runs out
  of space partway through.

  It is worth sizing deliberately rather than raising to be safe: disk is billed and
  quota'd per sandbox, and the account-wide disk quota is usually what binds first, so
  every extra GB is one fewer container you can run at once. Divide your plan's disk quota
  by this number to see how many sandboxes your plan actually allows.
- **Idle containers are suspended, not destroyed.** A project keeps at most one suspended
  container, which resumes with its clones and worktrees intact; extra containers from a
  burst are destroyed when they go idle and are rebuilt from the git remote next time. A
  suspended sandbox still counts against your provider account's memory and disk limits, so
  on a small plan a handful of idle projects can hold the whole allowance. If runs start
  failing to provision while nothing appears to be running, that is what to look at.
- **The first container of a project is slower to start** than a local one, because the
  provider builds it. Later ones start in a few seconds.
- **A local model provider is not reachable.** Pointing an AI provider at
  `http://host.docker.internal:11434` works only when the container is on your own machine.
  Use a provider the container can reach over the internet.
- **Per-sandbox memory statistics may be unavailable.** Locally Hezo watches a container's
  memory and stops it gracefully as it approaches its cap. Where the provider does not
  expose that, the provider's own out-of-memory handling applies instead. Because a
  container serves one run at a time, that ends only the run that overran, not the rest of
  the project's work. The run is reported as failed with an error saying it was killed and
  naming the container's memory cap, so the cause is on the run itself rather than buried
  in its log.

## If the provider is unreachable

Selecting a managed backend Hezo cannot reach is **fatal at startup** - it never falls back
to local Docker. If the provider becomes unreachable while Hezo is running, in-flight runs
fail through the normal container-death path and are reported on the project's Container
page. There is no automatic failover: an instance that silently switched substrates would
look healthy while doing something you did not ask for.

Switching back to [local Docker](/docs/containers/local-docker) from Settings -> Containers
is always available and needs no credentials.

## Uninstalling

`hezo uninstall` removes the containers it created as well as the data directory, so give
it the same backend settings the server ran with:

```sh
hezo uninstall --yes --sandbox-backend daytona --daytona-api-key "<key>"
```

The environment variables work too (`HEZO_SANDBOX_BACKEND`, `HEZO_DAYTONA_API_KEY`,
`HEZO_DAYTONA_API_URL`). Without them uninstall cleans up local Docker and leaves the
remote sandboxes running - and nothing else will remove them, because the sweep that reaps
unreferenced sandboxes lives in the instance being deleted. If the provider cannot be
reached, uninstall says so and still removes the data directory; remove the leftovers from
the provider's dashboard.
