---
title: Your first project
order: 3
section: Getting started
---

# Your first project

With the [`hezo` binary installed](/docs/getting-started/installation), you can
take a project from an empty directory to a live deployment in two commands.

## Scaffold and deploy

```sh
hezo new my-app      # scaffold a project with a chosen stack
cd my-app
hezo deploy          # build and ship to production
```

`hezo new` lays down a project using sensible defaults and conventions. `hezo
deploy` builds the project and ships it to production on your own
infrastructure — Hezo orchestrates the steps, you own the accounts.

## Check on it

```sh
hezo status          # health and traffic across all your projects
```

## Keep shipping

From here, the same commands work for every project you create — that's the
point. Spinning up the next idea costs minutes, not a whole evening of setup.

- [Core concepts](/docs/core-concepts) — how Hezo thinks about projects.
- [CLI usage](/docs/cli-commands/usage) — the full command reference.
- [Deployment](/docs/deployment) — targets and self-hosting notes.
