---
title: Installation
order: 3
section: Getting started
---

# Installation

Hezo ships as a **single self-contained binary** - there's no runtime, language
toolchain, or dependencies to install. Download it, run it, and you're up in seconds.
The one thing to have in place first is a **Docker-compatible runtime**, which Hezo uses
to run each project's agents in isolated containers on your machine - unless you point
the instance at a managed sandbox service instead (below).

## Prerequisites

- **A Docker-compatible container runtime**, running and reachable. Docker
  Engine (Linux), Docker Desktop, Colima, Rancher Desktop, OrbStack, Lima and rootless
  Docker all work - Hezo finds the daemon's socket automatically, whichever you use. On
  startup it checks for a working daemon and, if none is reachable, prints how to install
  or start one (with a link to
  [Docker's install page](https://docs.docker.com/get-docker/)) and exits - so set one up
  first. On **Windows**, where the console window closes with the process and would take
  that message with it, Hezo instead shows a dialog and offers to open Docker Desktop in
  the Microsoft Store. See [Container runtimes](/docs/deployment/container-runtimes) for
  the full list, how the socket is discovered, and the extra mount step VM-backed runtimes
  like Colima need.
- A machine you're happy to leave running while agents work (a laptop is fine to
  start; a small always-on server is better for long-running teams).

**Rather not run containers on this machine at all?** A brand-new instance can start its
agent containers on a [managed sandbox service](/docs/containers/remote/overview) instead
- `hezo --sandbox-backend daytona --daytona-api-key "<key>"` - and then no container
runtime is needed here. See [Containers](/docs/containers/overview) for the trade-off.
The choice stays live after install: **Settings -> Containers** switches an existing
instance between local and remote containers at any time
([Switching at any time](/docs/containers/overview#switching-at-any-time)) - the flag and
environment variable only seed the first startup.

## Install the binary

The one-line installer detects your OS and CPU architecture and downloads the matching
binary from the [latest release](https://github.com/hezo-ai/hezo/releases/latest).

```sh tab=macOS
curl -fsSL https://hezo.ai/install.sh | sh
```

```sh tab=Linux
curl -fsSL https://hezo.ai/install.sh | sh
```

```powershell tab=Windows
irm https://hezo.ai/install.ps1 | iex
```

### Manual download

Prefer to grab the binary yourself? Every release is published on
[GitHub Releases](https://github.com/hezo-ai/hezo/releases/latest). Download the asset for
your platform, make it executable (`chmod +x`), and put it on your `PATH`.

| Platform | Asset |
|---|---|
| macOS (Apple Silicon) | `hezo-darwin-arm64` |
| macOS (Intel) | `hezo-darwin-x64` |
| Linux (x86-64) | `hezo-linux-x64` |
| Linux (ARM64) | `hezo-linux-arm64` |
| Windows (x64) | `hezo-windows-x64.exe` |

## Start the server

```sh
hezo
```

This boots the Hezo server on **port 3100** and creates its data directory at
`~/.hezo/` on first run. Open **http://localhost:3100** in your browser to continue.

To run on a different port or data directory:

```sh
hezo --port 8080 --data-dir /path/to/data
```

See the [Configuration reference](/docs/deployment/configuration) for every flag and
environment variable.

## Verify the install

```sh
hezo --help
```
