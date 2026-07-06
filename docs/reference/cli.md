---
title: CLI reference
order: 31
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
hezo --database-url postgres://user:pass@host:5432/hezo   # use an external Postgres instead of the embedded database
hezo --asset-storage-url "s3://KEY:SECRET@endpoint/bucket"   # store asset files in S3-compatible object storage
hezo --master-key "<phrase>"     # set up or unlock without the web gate
hezo --web-url https://hezo.example.com   # public base URL for sign-in redirects
hezo --no-open                   # don't open the web app in your browser on start
hezo --container-bind-host 0.0.0.0  # native-Linux Docker: let agent containers reach the egress proxy/SSH bridge
hezo --auto-install-updates      # restart onto downloaded updates automatically (waits for idle; comes back unlocked)
hezo --disable-telemetry         # turn off the anonymous daily usage report (on by default)
```

By default the database is embedded and lives under the data directory. With
`--database-url` (or `HEZO_DATABASE_URL`) Hezo runs against an external PostgreSQL 14+
instead — see [Using an external Postgres](/docs/deployment/configuration) for
requirements (TLS, latency, pooling).

Uploaded asset files live under the data directory by default. With
`--asset-storage-url` (or `HEZO_ASSET_STORAGE_URL`) they live in any S3-compatible
bucket instead — see
[Storing assets in S3-compatible object storage](/docs/deployment/configuration) for the
URL format and how to move an existing instance.

On **native-Linux Docker**, agent containers reach the host over the bridge gateway, so the
host firewall must allow the Docker bridge to reach Hezo's ports. The boot connectivity check
auto-rebinds the egress proxy / SSH bridge to the detected bridge gateway IP when a loopback
bind is unreachable, so `--container-bind-host` usually needs no change — set it only to pin a
specific interface. See
[Self-hosting → Networking & firewall](/docs/deployment/self-hosting) for the details.

On a desktop machine Hezo opens the web app in your default browser once the server is
ready. It skips this automatically in environments without a browser — CI, containers,
SSH sessions, and headless Linux (no `DISPLAY`/`WAYLAND_DISPLAY`) — and logs where to
point your browser instead. Use `--no-open` (or `HEZO_OPEN=0`) to turn it off.

## Back up the database

```sh
hezo backup [--output <path>] [--data-dir <path>] [--database-url <url>]
```

Writes a **portable logical backup** (default
`<data-dir>/backups/hezo-<timestamp>.backup.gz`) that restores onto either storage
backend — which also makes it the way to move an instance between the embedded database
and an external Postgres. For the embedded database, stop the server first. See
[Backup & recovery](/docs/deployment/backup-and-recovery).

## Restore a backup

```sh
hezo restore <backup> [--wipe] [--data-dir <path>] [--database-url <url>]
```

Restores a `hezo backup` file into the embedded database (default) or an external one
(`--database-url`). The target must be empty unless `--wipe` is passed. Backups taken by
a newer Hezo are refused — upgrade first. Legacy pre-upgrade `.tar.gz` snapshots restore
with the same command (embedded only). See
[Backup & recovery](/docs/deployment/backup-and-recovery).

## Reset

```sh
hezo --reset
```

Starts fresh with an empty database. Your previous data isn't deleted — the existing
`pgdata` is renamed aside on disk — but it stays encrypted with the old master key, so
this is effectively the only path forward once the master key is lost.

`--reset` applies to the **embedded** database only; combined with `--database-url` it
exits with an error. To start an external database fresh, drop and recreate it with your
provider's tools.

## Info

```sh
hezo --help          # show all commands and flags
hezo --version       # print the Hezo version and exit
```

## See also

- [Configuration reference](/docs/deployment/configuration) — every flag and variable.
- [MCP API reference](/docs/reference/mcp-api) — every tool the built-in MCP server exposes.
- [Installation](/docs/getting-started/installation) — getting the binary.
