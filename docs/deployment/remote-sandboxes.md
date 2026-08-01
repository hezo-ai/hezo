---
title: Remote sandboxes
order: 26.5
section: Deployment
---

# Remote sandboxes

Every agent run executes inside a container. Normally that container runs on the Docker
daemon on the same machine as Hezo. Point `--sandbox-backend` at a managed sandbox service
and the containers run on the provider's machines instead, while Hezo keeps doing all of
the work that touches your data.

The flags themselves are in
[Configuration → Running agent containers on a managed sandbox service](/docs/deployment/configuration).
This page is about what actually changes when you flip it.

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

The provider never receives a secret, a private key, or a decrypted anything. It receives
an image reference and a command.

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

## What to expect

- **Concurrency is bounded by the container memory budget**, exactly as it is locally. See
  [Settings → Concurrency](/docs/security/container-isolation).
- **A project's memory cap must fit that budget.** Providers also cap a single sandbox
  (Daytona allocates at most 8 GB). Ask for more than the provider can give and the run
  fails with a message naming the limit - Hezo never quietly starts a smaller container
  than the cap it promised, because the rest of the system is sized against that promise.
- **Disk is finite.** A local `/workspace` has your whole disk behind it; a sandbox has a
  few GB. Hezo prunes worktrees for closed tasks and recycles a container that approaches
  its ceiling.
- **Idle containers are suspended, not destroyed.** A project keeps at most one suspended
  container, which resumes with its clones and worktrees intact; extra containers from a
  burst are destroyed when they go idle and are rebuilt from the git remote next time.
- **The first container of a project is slower to start** than a local one (roughly half a
  minute) because the provider builds it. Later ones start in a few seconds.

## Limits

- **Dev-server previews are not available.** `dev_ports` maps a port from a container to
  your host, and on a provider the container is not on your host. Previews are not
  currently supported on either backend.
- **A local model provider is not reachable.** Pointing an AI provider at
  `http://host.docker.internal:11434` works only when the container is on your own
  machine. Use a provider the container can reach over the internet.
- **Per-sandbox memory statistics may be unavailable.** Locally Hezo watches a container's
  memory and stops it gracefully as it approaches its cap. Where the provider does not
  expose that, the provider's own out-of-memory handling applies instead. Because a
  container serves one run at a time, that ends only the run that overran, not the rest of
  the project's work.

## If the provider is unreachable

Selecting a managed backend Hezo cannot reach is **fatal at startup** - it never falls back
to local Docker. If the provider becomes unreachable while Hezo is running, in-flight runs
fail through the normal container-death path and are reported on the project's Container
page. There is no automatic failover: an instance that silently switched substrates would
look healthy while doing something you did not ask for.

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
