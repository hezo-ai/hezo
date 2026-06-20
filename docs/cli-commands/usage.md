---
title: CLI usage
order: 5
section: Reference
---

# CLI usage

Hezo is one binary with a small, consistent set of commands. Run `hezo --help`
at any time for the authoritative list.

## Project commands

| Command | Description |
|---|---|
| `hezo new` | Scaffold a new project with a chosen stack. |
| `hezo deploy` | Build and ship the current project to production. |
| `hezo status` | See health and traffic across all your projects. |
| `hezo launch` | Run marketing and growth actions for a project. |

## Common flags

```sh
hezo --version       # print the installed version
hezo --help          # show all commands and flags
```

Every project responds to the same commands, so once you've learned the loop
for one project it carries over to all the others.

## Next

- [Deployment](/docs/deployment) — production targets and self-hosting.
