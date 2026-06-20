---
title: Deployment
order: 6
section: Guides
---

# Deployment

Shipping a project to production is a single command:

```sh
hezo deploy
```

`hezo deploy` builds the current project and ships it to production. Because Hezo
**orchestrates onto your own infrastructure**, the deploy runs against the
accounts and providers you already own — you stay in control of hosting,
domains, and data.

## Checking a deployment

```sh
hezo status          # health and traffic across all your projects
```

## Self-hosting notes

- Hezo keeps its state in a local data directory (default `~/.hezo/`).
- Everything ships as a single binary — there is no separate runtime or daemon
  to operate alongside it.

## Related

- [CLI usage](/docs/cli-commands/usage) — the full command reference.
- [Core concepts](/docs/core-concepts) — the model behind projects and deploys.
