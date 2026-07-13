---
title: Backup & recovery
order: 30
section: Deployment
---

# Backup & recovery

`hezo backup` captures a **complete instance** — the database *and* every uploaded asset
file — as a portable **backup bundle**. It works for both database backends (embedded and
[external Postgres](/docs/deployment/configuration)) and both asset backends (local files
and an [S3-compatible bucket](/docs/deployment/configuration)), which also makes it the way
to **move an instance between them**. But there's one crucial pairing to understand first.

## You need the data *and* the master key

Your secrets are **encrypted with your master key**, and the master key is never stored
with them. To restore a working instance you need **both**:

- a **backup** (and, for a complete instance, the data directory — see below), and
- the **twelve-word master key** that unlocks it.

A backup without the master key cannot decrypt the secrets inside it. Store the master
key separately and safely (see [Master key & encryption](/docs/security/master-key)).

## Backing up

```sh
hezo backup                         # whole instance (database + assets) → a bundle directory; stop the server first
hezo backup --output /safe/place/hezo-backup/   # choose where the bundle goes
hezo backup --no-assets             # database only → a single .backup.gz file
HEZO_DATABASE_URL=postgres://… HEZO_ASSET_STORAGE_URL="s3://…" hezo backup   # back up a hosted instance, any time
```

`hezo backup` writes a **backup bundle** (default `<data-dir>/backups/hezo-<timestamp>/`)
containing `database.backup.gz` (every row plus the exact schema version it was taken at),
an `assets/` tree of every uploaded file, and a `manifest.json`. Use `--no-assets` for a
database-only single `.backup.gz` file, or `--no-database` for an assets-only bundle. For
the **embedded** database and **local** assets, run it while the server is stopped. A
**hosted** database and bucket can be backed up any time — and pair well with your
provider's own snapshots or versioning.

**The bundle does not cover the whole data directory.** Project workspaces (git worktrees)
and the instance's keys live under `<data-dir>` and are **not** in a backup, so a full
disaster-recovery copy is the bundle **plus** a copy of the data directory (a file backup
or volume snapshot works; stopped-server copies are cleanest). If your assets already live
in [S3-compatible object storage](/docs/deployment/configuration), `hezo backup` reads them
straight from the bucket into the bundle — or rely on the bucket's own
versioning/replication and take a `--no-assets` database backup.

## Restoring

```sh
hezo restore <bundle-or-file>                              # into the embedded database + local assets
HEZO_DATABASE_URL=postgres://… hezo restore <bundle>       # database into an external Postgres
hezo restore <bundle> --asset-storage-url "s3://…"         # assets into an S3-compatible bucket
```

Restore replays Hezo's own migrations up to exactly the version the backup recorded,
then loads the data — so the target must be an **empty database** (pass `--wipe` to drop
and restore over a non-empty one). Asset blobs from a bundle are written into the target
asset store and checksum-verified against the restored rows (`--strict-assets` fails on any
blob with no matching row); use `--no-assets` / `--no-database` to restore only one half of
a bundle. A backup taken by a *newer* Hezo than the running binary is refused with
instructions to upgrade first. On the next server start, normal migrations bring the
restored database forward to the binary's current schema.

Legacy physical snapshots (`.tar.gz` files from older Hezo versions) still restore with
the same command, into the embedded database only.

## Moving between local and hosted storage

The same two commands are the migration path for the database **and** assets, in either
direction. Which backends you point `restore` at decides where the data lands; the source
is only ever read, so nothing is removed until you do it yourself.

```sh
# Local → hosted (external Postgres + S3 bucket)
hezo backup --output move/                               # server stopped
HEZO_DATABASE_URL=postgres://… HEZO_ASSET_STORAGE_URL="s3://…" hezo restore move/
HEZO_DATABASE_URL=postgres://… HEZO_ASSET_STORAGE_URL="s3://…" hezo   # start against the new backends

# Hosted → local
HEZO_DATABASE_URL=postgres://… HEZO_ASSET_STORAGE_URL="s3://…" hezo backup --output back/
hezo restore back/ --data-dir ~/.hezo
hezo
```

Migrate just one side by setting only that target on `restore` (e.g. only
`HEZO_DATABASE_URL` to move the database while leaving assets where they are), or with
`--no-assets` / `--no-database`. Your master key is unchanged by a move — the encrypted
vault travels inside the backup.

## Upgrades are safe to roll back

When you upgrade the binary, Hezo runs any needed database migrations on startup, and
each backend has a safety net:

- **Embedded:** migrations run against a *copy* of the database, which is swapped in
  only on success; the previous copy is kept aside in the data directory. A failed
  migration leaves your original data untouched — just run the previous binary.
- **External:** a pre-migration `hezo backup` file is written into
  `<data-dir>/backups/` automatically before anything changes (the last 5 are kept),
  and each migration commits its own transaction. To roll back a bad upgrade, restore
  that file with the previous binary (or use your provider's point-in-time recovery).

```sh
hezo restore <backup>
```

## Starting over

If you need a clean slate — or you've lost the master key and have no way back — reset
the instance:

```sh
hezo --reset
```

This **starts fresh with an empty embedded database**. Your previous data isn't deleted —
the existing `pgdata` is renamed aside on disk — but it stays encrypted with the old
master key, so there's no recovery path for a lost key. Treat `--reset` as the last
resort it is. (For an external database, drop and recreate it with your provider's tools
instead.)
