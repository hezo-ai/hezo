---
title: Installation
order: 2
section: Getting started
---

# Installation

Hezo runs as a single self-contained binary on your own machine or server. It uses
**Docker** to run each project's agents in an isolated container, so Docker is the
one prerequisite to have in place first.

## Prerequisites

- **Docker** — Docker Engine (Linux) or Docker Desktop (macOS/Windows), running and
  reachable. Hezo launches a container per project through it.
- A machine you're happy to leave running while agents work (a laptop is fine to
  start; a small always-on server is better for long-running teams).

## Install the binary

The install script detects your OS and CPU architecture and downloads the matching
build.

### macOS & Linux

```sh
curl -fsSL https://hezo.ai/install.sh | sh
```

### Windows (PowerShell)

```powershell
irm https://hezo.ai/install.ps1 | iex
```

### Manual download

Every build is published on
[GitHub Releases](https://github.com/hezo-ai/hezo/releases). Download the asset for
your platform, make it executable, and put it on your `PATH`.

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
hezo --version
```

## Next

The first time you open the web app, Hezo walks you through creating a **master key**
and connecting a model. Continue to [First-run setup](/docs/getting-started/first-run).
