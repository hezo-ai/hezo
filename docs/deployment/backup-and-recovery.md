---
title: Backup & recovery
order: 30
section: Deployment
---

# Backup & recovery

Hezo's own backup format is a **portable logical backup**: one file that works for both
storage backends — the embedded database *and* an
[external Postgres](/docs/deployment/configuration) — which also makes it the way to
**move an instance between them**. But there's one crucial pairing to understand first.

## You need the data *and* the master key

Your secrets are **encrypted with your master key**, and the master key is never stored
with them. To restore a working instance you need **both**:

- a **backup** (and, for a complete instance, the data directory — see below), and
- the **twelve-word master key** that unlocks it.

A backup without the master key cannot decrypt the secrets inside it. Store the master
key separately and safely (see [Master key & encryption](/docs/security/master-key)).

## Backing up

```sh
hezo backup                        # embedded database (stop the server first)
hezo backup --output /safe/place/hezo.backup.gz
HEZO_DATABASE_URL=postgres://… hezo backup   # external database, any time
```

`hezo backup` writes a gzipped logical backup (default
`<data-dir>/backups/hezo-<timestamp>.backup.gz`) containing every row plus the exact
schema version it was taken at. For the **embedded** database, run it while the server
is stopped. For an **external** database it can run any time — and pairs well with your
provider's own snapshots or point-in-time recovery.

**Also back up the data directory.** Uploaded assets, project workspaces, and keys live
under `<data-dir>` (not in the database), so a complete instance backup is the
`hezo backup` file **plus** a copy of the data directory (a file backup or volume
snapshot works; stopped-server copies are cleanest).

## Restoring

```sh
hezo restore <backup file>                     # into the embedded database
HEZO_DATABASE_URL=postgres://… hezo restore <backup file>   # into an external database
```

Restore replays Hezo's own migrations up to exactly the version the backup recorded,
then loads the data — so the target must be an **empty database** (pass `--wipe` to drop
and restore over a non-empty one). A backup taken by a *newer* Hezo than the running
binary is refused with instructions to upgrade first. On the next server start, normal
migrations bring the restored database forward to the binary's current schema.

Legacy physical snapshots (`.tar.gz` files from older Hezo versions) still restore with
the same command, into the embedded database only.

## Moving between embedded and hosted Postgres

The same two commands are the migration path, in either direction:

```sh
# Embedded → hosted Postgres
hezo backup --output move.backup.gz                      # server stopped
HEZO_DATABASE_URL=postgres://… hezo restore move.backup.gz
HEZO_DATABASE_URL=postgres://… hezo                      # start against the new backend

# Hosted Postgres → embedded
HEZO_DATABASE_URL=postgres://… hezo backup --output back.backup.gz
hezo restore back.backup.gz --data-dir ~/.hezo
hezo
```

Your master key is unchanged by a move — the encrypted vault travels inside the backup.

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
