---
title: CLI reference
order: 26
section: Reference
---

# CLI reference

The `hezo` binary **is the server.** Running it with no command starts Hezo; a couple of
subcommands and flags cover the rest. Run `hezo --help` for the authoritative list on
your version.

## Start the server

```sh
hezo [options]
```

Boots the Hezo server and web app (default port 3100) against the data directory
(default `~/.hezo/`). Docker must be installed and running first — Hezo checks at startup
and exits with install/start guidance if the daemon isn't reachable (see
[Installation](/docs/getting-started/installation)). See the
[Configuration reference](/docs/deployment/configuration) for the full table of flags and
their environment-variable equivalents. The most common:

```sh
hezo --port 8080                 # listen on a different port
hezo --data-dir /var/lib/hezo    # use a specific data directory
hezo --master-key "<phrase>"     # set up or unlock without the web gate
hezo --web-url https://hezo.example.com   # public base URL for sign-in redirects
hezo --open                      # open the web app in your browser on start
```

## Restore a snapshot

```sh
hezo restore <backup>
```

Restores a pre-upgrade database snapshot into the data directory, for a manual rollback
to an earlier version. After restoring, start the matching (older) binary. See
[Backup & recovery](/docs/deployment/backup-and-recovery).

## Reset

```sh
hezo --reset
```

Wipes the database and starts fresh. This is irreversible and is the only path forward
if the master key is lost.

## Info

```sh
hezo --version       # print the installed version
hezo --help          # show all commands and flags
```

## See also

- [Configuration reference](/docs/deployment/configuration) — every flag and variable.
- [MCP API reference](/docs/reference/mcp-api) — every tool the built-in MCP server exposes.
- [Installation](/docs/getting-started/installation) — getting the binary.
