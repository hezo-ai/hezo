---
title: Backup & recovery
order: 30
section: Deployment
---

# Backup & recovery

`hezo backup` captures a **complete instance** - the database *and* every uploaded asset
file - as a portable **backup bundle**. It works for both database backends (embedded and
[external Postgres](/docs/deployment/configuration)) and both asset backends (local files
and an [S3-compatible bucket](/docs/deployment/configuration)), which also makes it the way
to **move an instance between them**. But there's one crucial pairing to understand first.

## You need the data *and* the master key

Your secrets are **encrypted with your master key**, and the master key is never stored
with them. To restore a working instance you need **both**:

- a **backup** (and, for a complete instance, the data directory - see below), and
- the **twelve-word master key** that unlocks it.

A backup without the master key cannot decrypt the secrets inside it. Store the master
key separately and safely (see [Master key & encryption](/docs/security/master-key)).

## Backing up

```sh
hezo backup                         # whole instance (database + assets) → a bundle directory; stop the server first
hezo backup --output /safe/place/hezo-backup/   # choose where the bundle goes
hezo backup --no-assets             # database only → a single .backup.gz file
hezo backup --config /etc/hezo/hezo.config.cjs   # back up a hosted instance, any time
```

`hezo backup` writes a **backup bundle** (default `<data-dir>/backups/hezo-<timestamp>/`)
containing `database.backup.gz` (every row plus the exact schema version it was taken at),
an `assets/` tree of every uploaded file, and a `manifest.json`. Use `--no-assets` for a
database-only single `.backup.gz` file, or `--no-database` for an assets-only bundle.

**Stop the server first for the embedded database and local assets.** The embedded database
is single-process: `hezo backup` opens a *second* database over the same files, which is not
a safe read-only operation - it races the running server's writes and can corrupt the data.
So the command **refuses to run while the server is up** (the running instance holds an
advisory lock at `<data-dir>/hezo.lock`; backup and restore check it and stop with guidance
rather than risk the files). A **hosted** database and bucket are different - there `hezo
backup` is an ordinary consistent read against your one Postgres server, so you can back them
up **any time, server running**, and they pair well with your provider's own snapshots or
versioning.

> If a crash ever leaves a stale `hezo.lock` behind, the next server start overwrites it, and
> backup/restore ignore it automatically (they verify the recorded process is actually
> running). You only ever delete it by hand if the error insists a server is running when you
> know none is.

### Point the command at your data directory

`hezo backup` resolves its data directory the **same way the server does** - the `--config` file
first, then `--data-dir`, then the default `~/.hezo`. This matters the moment your instance
does **not** live at the default location.

**If your server runs with a custom data directory, the backup command has to know about it
too.** Run `hezo backup` with the same `--config` the server uses,
or pass `--data-dir /your/path` explicitly. Otherwise the command falls back to `~/.hezo` - a
directory your instance never used - and backs up the wrong database instead of yours.

- **systemd / Docker:** pass the same `--config` to the backup command - for example,
  `hezo backup --config /etc/hezo/hezo.config.cjs` or
  `docker exec <container> hezo backup --config <path>`.
- **A custom dir passed only as a startup flag** (`hezo --data-dir /var/lib/hezo`): pass the
  **same** `--data-dir /var/lib/hezo` to `hezo backup` (there is no env var to inherit).

Pointed at a directory that holds no Hezo database, the command stops with a clear error
(`No Hezo database found at …`) instead of silently writing a backup of an empty one - but
it's on you to point it at the *right* directory; a valid-but-wrong data dir is still a valid
backup of the wrong instance. The same resolution applies to `hezo restore`, which **writes**
into the resolved data directory.

**The bundle does not cover the whole data directory.** Project workspaces (git worktrees)
and the instance's keys live under `<data-dir>` and are **not** in a backup, so a full
disaster-recovery copy is the bundle **plus** a copy of the data directory (a file backup
or volume snapshot works; stopped-server copies are cleanest). If your assets already live
in [S3-compatible object storage](/docs/deployment/configuration), `hezo backup` reads them
straight from the bucket into the bundle - or rely on the bucket's own
versioning/replication and take a `--no-assets` database backup.

## Restoring

```sh
hezo restore <bundle-or-file>                              # into the embedded database + local assets
hezo restore <bundle> --database-url postgres://…         # database into an external Postgres
hezo restore <bundle> --asset-storage-url "s3://…"         # assets into an S3-compatible bucket
```

Restore replays Hezo's own migrations up to exactly the version the backup recorded,
then loads the data - so the target must be an **empty database** (pass `--wipe` to drop
and restore over a non-empty one). Asset blobs from a bundle are written into the target
asset store and checksum-verified against the restored rows (`--strict-assets` fails on any
blob with no matching row); use `--no-assets` / `--no-database` to restore only one half of
a bundle. A backup taken by a *newer* Hezo than the running binary is refused with
instructions to upgrade first. On the next server start, normal migrations bring the
restored database forward to the binary's current schema.

Physical `.tar.gz` snapshots written by older Hezo versions are **no longer restorable**.
They only ever loaded into the embedded database, so they could never be restored onto
external Postgres or moved between storage backends. If you still hold one, restore it with
a Hezo version old enough to read it, then take a fresh `hezo backup` - that artifact
restores onto either backend and is the format going forward.

### Watching a large restore

A big instance takes minutes to restore, so `hezo restore` reports what it is doing at every
step - reading and decompressing the backup, recreating the schema, then a live counter for
the two long parts:

```
Loading rows · 42% · 1,204,000/2,860,113 rows · task_comments · 1m 12s · ~1m 40s left
Restoring asset files · 88% · 8,412/9,530 files · 3.1 GB · 4m 06s · ~32s left
```

In a terminal that single line is rewritten in place. When the output goes to a pipe or a
log file (systemd, Docker), the same updates are appended as ordinary lines every few
seconds instead, so a restore you started over SSH or under a service manager still shows
its progress in the log.

## Moving between local and hosted storage

The same two commands are the migration path for the database **and** assets, in either
direction. Which backends you point `restore` at decides where the data lands; the source
is only ever read, so nothing is removed until you do it yourself.

```sh
# Local → hosted (external Postgres + S3 bucket)
hezo backup --output move/                               # server stopped
hezo restore move/ --database-url postgres://… --asset-storage-url "s3://…"
hezo --config /etc/hezo/hezo.config.cjs   # start against the new backends

# Hosted → local
hezo backup --config /etc/hezo/hezo.config.cjs --output back/
hezo restore back/ --data-dir ~/.hezo
hezo
```

Migrate just one side by setting only that target on `restore` (e.g. only
`--database-url` to move the database while leaving assets where they are), or with
`--no-assets` / `--no-database`. Your master key is unchanged by a move - the encrypted
vault travels inside the backup.

## Upgrades are safe to roll back

When you upgrade the binary, Hezo runs any needed database migrations on startup, and
each backend has a safety net:

- **Embedded:** migrations run against a *copy* of the database, which is swapped in
  only on success; the previous copy is kept aside in the data directory. A failed
  migration leaves your original data untouched - just run the previous binary.
- **External:** a pre-migration `hezo backup` file is written into
  `<data-dir>/backups/` automatically before anything changes (the last 5 are kept),
  and each migration commits its own transaction. To roll back a bad upgrade, restore
  that file with the previous binary (or use your provider's point-in-time recovery).

```sh
hezo restore <backup>
```

## Starting over

If you need a clean slate (or you've lost the master key and have no way back), reset
the instance:

```sh
hezo --reset
```

This **starts fresh with an empty embedded database**. Your previous data isn't deleted -
the existing `pgdata` is renamed aside on disk - but it stays encrypted with the old
master key, so there's no recovery path for a lost key. Treat `--reset` as the last
resort it is. (For an external database, drop and recreate it with your provider's tools
instead.)
