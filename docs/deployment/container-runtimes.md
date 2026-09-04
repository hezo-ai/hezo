---
title: Container runtimes
order: 26.5
section: Deployment
---

# Container runtimes

Hezo runs every project's agents inside a container. That container is a **security
boundary**, not a packaging convenience - it keeps agents off the rest of your system, so a
buggy or compromised agent can't reach your files, credentials, or wider network (see
[Container isolation](/docs/security/container-isolation)).

This page is about the default setup, where containers run on **your own machine**. If
the instance runs its agent containers on a
[managed sandbox service](/docs/containers/remote/overview), there is no local runtime to
install and nothing below applies. You choose - and can switch - between the two in
**Settings -> Containers**.

Hezo talks to the container runtime over the **Docker Engine API on a Unix socket**, so it
works with any Docker-compatible runtime. You do not have to run Docker Desktop.

## Supported runtimes

| Runtime | Platforms | Socket Hezo looks for |
|---|---|---|
| Docker Engine | Linux | `/var/run/docker.sock` |
| Docker Desktop | macOS, Linux | `/var/run/docker.sock`, `~/.docker/run/docker.sock` |
| Colima | macOS, Linux | `~/.colima/<profile>/docker.sock` |
| Rancher Desktop | macOS, Linux | `~/.rd/docker.sock` |
| OrbStack | macOS | `~/.orbstack/run/docker.sock` |
| Lima | macOS, Linux | `~/.lima/<instance>/sock/docker.sock` |
| Rootless Docker | Linux | `$XDG_RUNTIME_DIR/docker.sock` |

Anything else that serves the Docker Engine API over a Unix socket should work too - point
Hezo at it with `--docker-socket` (below). Podman is not auto-detected and is untested with
Hezo; its Docker-compatible API covers most of what Hezo needs, but the container exec and
host-gateway behaviour agent runs depend on has not been verified, so treat it as
experimental.

**On Windows**, Docker Desktop and Rancher Desktop expose the Engine API as a *named pipe*
(`npipe://`), which Hezo cannot connect to - it speaks the API over a Unix socket. Run Hezo
inside WSL2, where Docker Desktop's WSL integration provides `/var/run/docker.sock`.

If you start Hezo on Windows with **no container runtime installed at all**, it does not
just print the guidance below and exit: launched from Explorer it owns its console window,
which closes with the process, so you would never get to read it. Instead a dialog explains
why a container runtime is required, and clicking **OK** opens
[Docker Desktop in the Microsoft Store](https://apps.microsoft.com/detail/xp8cbj40xlbwkx).
Install it, start it, then start Hezo again. `--no-open` (or `open: false`) suppresses the
dialog along with the browser, and it never appears over SSH, in CI or in a container.

## How Hezo finds the daemon

At startup Hezo works through these in order and uses the first socket that answers:

1. `--docker-socket` / `containers.dockerSocket`, if you set one.
2. `DOCKER_HOST`, if it is set to a `unix://` socket.
3. The **current docker context** (what `docker context show` reports), read from the
   docker CLI's own configuration. This is how a Colima or Rancher Desktop install is
   normally picked up, since those set a context rather than touching `/var/run`.
4. The **well-known path for each supported runtime** in the table above.

The socket it settled on is named in the startup log, so you can always see which daemon
Hezo is talking to:

```
Docker daemon reachable at ~/.colima/default/docker.sock (Colima, via docker context)
```

If nothing answers, Hezo prints the sockets it tried along with how to start each runtime,
then exits - it will not boot a server that cannot run a single agent.

## Pointing Hezo at a specific socket

When your daemon listens somewhere none of the above cover:

```sh
hezo --docker-socket /path/to/docker.sock
# or
hezo --config /etc/hezo/hezo.config.cjs   # containers: { dockerSocket: '/path/to/docker.sock' }
```

Hezo connects over a **Unix socket only**. `tcp://`, `npipe://` and `ssh://` endpoints are
not supported; if `DOCKER_HOST` is set to one, Hezo says so at startup rather than quietly
connecting somewhere else. Use the socket file path instead.

## VM-backed runtimes need the data directory shared and writable

Colima, Lima and Rancher Desktop run the daemon inside a **virtual machine**, and a VM only
sees the host directories you tell it to share. This matters because agents work on a bind
mount of Hezo's data directory (`~/.hezo` by default) - each project's workspace, worktrees
and previews live there.

**Colima shares your home directory read-only by default**, so agent runs would fail on
their first write even though Docker itself is working. Share the data directory writable:

```sh
colima stop
colima start --mount $HOME/.hezo:w
```

For the other runtimes:

- **Lima** - add a writable mount for the data directory to the instance YAML
  (`~/.lima/<instance>/lima.yaml`), then restart the instance.
- **Rancher Desktop** - Preferences > Virtual Machine > Volumes; use the virtiofs mount
  type and make sure the data directory is covered.
- **Docker Desktop** - Settings > Resources > File sharing, then add the data directory.

Hezo checks this at boot by mounting a scratch directory into a throwaway container and
writing to it. If the mount is missing or read-only it logs the fix above and keeps
running, so you can correct the host configuration and restart without losing the web UI.
To skip the check entirely, set `containers.skipMountCheck: true` - note that this only hides the
diagnosis, it does not make the mount work.

If you keep the data directory somewhere else (`--data-dir`), share that path instead.

## See also

- [Installation](/docs/getting-started/installation) - prerequisites and getting the binary
- [Self-hosting](/docs/deployment/self-hosting) - networking, firewall and updates
- [Configuration reference](/docs/deployment/configuration) - config-file settings and flags
- [Container isolation](/docs/security/container-isolation) - what the sandbox protects
