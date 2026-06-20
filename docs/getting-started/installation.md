---
title: Installation
order: 2
section: Getting started
---

# Installation

Hezo ships as a single self-contained binary. The install command detects your
OS and CPU architecture and downloads the matching build.

## macOS & Linux

```sh
curl -fsSL https://hezo.ai/install.sh | sh
```

## Windows (PowerShell)

```powershell
irm https://hezo.ai/install.ps1 | iex
```

## Manual download

Prefer to grab the binary yourself? Every build is published on
[GitHub Releases](https://github.com/hezo-ai/hezo/releases). Download the asset
for your platform (for example `hezo_darwin_arm64` or
`hezo_windows_amd64.exe`), make it executable, and put it on your `PATH`.

## Verify the install

```sh
hezo --version
```

Once that prints a version number you're ready to
[create your first project](/docs/getting-started/first-project).
