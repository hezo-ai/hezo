---
title: Installation
order: 2
section: Getting started
---

# Installation

Hezo ships as a **single self-contained binary** — there's no runtime, language
toolchain, or dependencies to install. Download it, run it, and you're up in seconds.
The one thing to have in place first is **Docker**, which Hezo uses to run each
project's agents in an isolated container.

## Prerequisites

- **Docker** — Docker Engine (Linux) or Docker Desktop (macOS/Windows), running and
  reachable. Hezo launches a container per project through it. On startup Hezo checks
  for a working Docker daemon and, if it's missing or stopped, prints how to install or
  start it (with a link to [Docker's install page](https://docs.docker.com/get-docker/))
  and exits — so install Docker first.
- A machine you're happy to leave running while agents work (a laptop is fine to
  start; a small always-on server is better for long-running teams).

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
