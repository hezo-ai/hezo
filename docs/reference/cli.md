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
(default `~/.hezo/`). Docker must be installed and running first - Hezo checks at startup
and exits with install/start guidance if the daemon isn't reachable (see
[Installation](/docs/getting-started/installation)). See the
[Configuration reference](/docs/deployment/configuration) for the full table of flags and
their environment-variable equivalents. The most common:

```sh
hezo --port 8080                 # listen on a different port
hezo --data-dir /var/lib/hezo    # use a specific data directory
hezo --database-url postgres://user:pass@host:5432/hezo   # use an external Postgres instead of the embedded database
hezo --asset-storage-url "s3://KEY:SECRET@endpoint/bucket"   # store asset files in S3-compatible object storage
hezo --sandbox-backend daytona --daytona-api-key "<key>"   # run agent containers on a managed sandbox service
hezo --master-key "<phrase>"     # set up or unlock without the web gate
hezo --web-url https://hezo.example.com   # public base URL for sign-in redirects
hezo --no-open                   # don't open the web app in your browser on start
hezo --no-egress-proxy-auth      # drop per-run egress-proxy auth (escape hatch; on by default)
hezo --auto-install-updates      # restart onto downloaded updates automatically (waits for idle; comes back unlocked)
hezo --disable-telemetry         # turn off the anonymous daily usage report (on by default)
```

By default the database is embedded and lives under the data directory. With
`--database-url` (or `HEZO_DATABASE_URL`) Hezo runs against an external PostgreSQL 14+
instead - see [Using an external Postgres](/docs/deployment/configuration) for
requirements (TLS, latency, pooling) and
[TLS and sslmode](/docs/deployment/configuration#tls-and-sslmode) for what each `sslmode`
protects against.

Uploaded asset files live under the data directory by default. With
`--asset-storage-url` (or `HEZO_ASSET_STORAGE_URL`) they live in any S3-compatible
bucket instead - see
[Storing assets in S3-compatible object storage](/docs/deployment/configuration) for the
URL format and how to move an existing instance.

Agent containers run on the local Docker daemon by default. With `--sandbox-backend`
(or `HEZO_SANDBOX_BACKEND`) they run on a managed sandbox service instead, and Docker
is no longer a prerequisite - see
[Running agent containers on a managed sandbox service](/docs/deployment/configuration).
A managed backend Hezo cannot reach is fatal at startup: it reports the problem and
exits rather than silently falling back to local Docker.

Agent containers never connect back to the host: Hezo reaches into each container and runs a
tunnel there, so the MCP endpoint, egress proxy and SSH agent arrive on container loopback.
No inbound firewall rule is needed for the Docker bridge, and the egress proxy and SSH bridge
bind loopback only. See
[Self-hosting → Networking & firewall](/docs/deployment/self-hosting) for the details.

On a desktop machine Hezo opens the web app in your default browser once the server is
ready. It skips this automatically in environments without a browser - CI, containers,
SSH sessions, and headless Linux (no `DISPLAY`/`WAYLAND_DISPLAY`) - and logs where to
point your browser instead. Use `--no-open` (or `HEZO_OPEN=0`) to turn it off.

## Back up

```sh
hezo backup [--output <path>] [--data-dir <path>] \
  [--database-url <url>] [--asset-storage-url <url>] [--no-assets] [--no-database]
```

By default `hezo backup` captures a **complete instance** - the database *and* every
uploaded asset file - as a **backup bundle** directory (default
`<data-dir>/backups/hezo-<timestamp>/`), containing `database.backup.gz`, an `assets/`
tree, and a `manifest.json`. The bundle restores onto either storage backend, which is
how you move an instance's database and assets between local storage and hosted
providers (external Postgres and an S3-compatible bucket). Point `--asset-storage-url`
(or `HEZO_ASSET_STORAGE_URL`) at the source bucket when the instance already keeps its
assets in S3.

- `--no-assets` - database only. Writes the single portable `.backup.gz` file (default
  `<data-dir>/backups/hezo-<timestamp>.backup.gz`) instead of a bundle.
- `--no-database` - assets only. Writes a bundle with just the asset files.

`--data-dir` (or `HEZO_DATA_DIR`) must point at the same data directory the instance
runs with. The env var is read exactly as the server reads it, so a deployment that sets
`HEZO_DATA_DIR` (systemd, Docker) needs no extra flag - omit `--data-dir` and the backup
targets the running instance's embedded database. Pointing at a directory with no Hezo
database is refused with a clear error rather than silently backing up an empty one.

For the embedded database (and local asset files), stop the server first - backup opens a
second database over the same single-process files, so it **refuses while the server is
running** (checked via an advisory `<data-dir>/hezo.lock` the live instance holds). A hosted
database + bucket can be backed up with the server running. See
[Backup & recovery](/docs/deployment/backup-and-recovery).

## Restore a backup

```sh
hezo restore <backup> [--wipe] [--data-dir <path>] \
  [--database-url <url>] [--asset-storage-url <url>] \
  [--no-assets] [--no-database] [--strict-assets]
```

`<backup>` is a bundle directory (database + assets) or a `.backup.gz` file (database
only). Restore writes into
whichever backends you point it at: the embedded database (default) or an external one
(`--database-url`), and local asset files (default) or an S3-compatible bucket
(`--asset-storage-url`). Setting different targets than the source is exactly how you
migrate an instance between local and hosted storage.

The target database must be empty unless `--wipe` is passed. Restored asset blobs are
verified by checksum against the database rows; `--strict-assets` fails if any blob has
no matching row. `--no-assets` / `--no-database` restore only one half of a bundle.
Backups taken by a newer Hezo are refused - upgrade first. Like `hezo backup`, restore
reads `--data-dir` from `HEZO_DATA_DIR` when the flag is omitted.

Restore prints its progress as it goes - a line per step, plus a live counter with a
percentage and an estimated time remaining while it loads rows and copies asset files. In a
terminal the counter is rewritten in place; piped to a log file it is appended every few
seconds. See
[Backup & recovery](/docs/deployment/backup-and-recovery).

## Reset

```sh
hezo --reset
```

Starts fresh with an empty database. Your previous data isn't deleted - the existing
`pgdata` is renamed aside on disk - but it stays encrypted with the old master key, so
this is effectively the only path forward once the master key is lost.

`--reset` applies to the **embedded** database only; combined with `--database-url` it
exits with an error. To start an external database fresh, drop and recreate it with your
provider's tools.

## Uninstall

```sh
hezo uninstall [--data-dir <path>] [--yes]
              [--sandbox-backend <name>] [--daytona-api-key <key>] [--daytona-api-url <url>]
```

Removes Hezo's **data directory** (default `~/.hezo/`) - every project workspace, the
embedded database, backups, and settings - and best-effort removes the containers Hezo
created. It does **not** remove the `hezo` binary itself.

If the instance ran its containers on a **remote sandbox service**, pass the same backend
settings the server used (`--sandbox-backend daytona` plus the API key, or the matching
`HEZO_SANDBOX_BACKEND` / `HEZO_DAYTONA_API_KEY` / `HEZO_DAYTONA_API_URL` environment
variables). Without them uninstall cleans up local Docker and leaves the remote sandboxes
running, and nothing else will remove them: the sweep that reaps unreferenced sandboxes
lives in the instance you are deleting. If the provider cannot be reached, uninstall says
so and still removes the data directory.

Prefer this over `rm -rf ~/.hezo`. On macOS, Docker Desktop tags Hezo's nested
`.previews` mount point with a *deny delete* ACL that a plain `rm -rf` can't override, so
the folder is left behind with a "Permission denied" error. `hezo uninstall` strips those
ACLs and deletes the tree cleanly.

Stop the server first - uninstall **refuses while a server is running** against the data
directory (removing it under a live server corrupts the database). Deletion is
irreversible, so it requires an explicit `--yes`; without it, the command prints exactly
what would be removed and deletes nothing. Like `hezo backup`, it reads `--data-dir` from
`HEZO_DATA_DIR` when the flag is omitted. Back up anything you want to keep with
`hezo backup` first - see [Backup & recovery](/docs/deployment/backup-and-recovery).

## Info

```sh
hezo --help          # show all commands and flags
hezo --version       # print the Hezo version and exit
```

## See also

- [Configuration reference](/docs/deployment/configuration) - every flag and variable.
- [MCP API reference](/docs/reference/mcp-api) - every tool the built-in MCP server exposes.
- [Installation](/docs/getting-started/installation) - getting the binary.
