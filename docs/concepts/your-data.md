---
title: Your data & the database
order: 17
section: Concepts
---

# Your data & the database

Hezo is built so that **everything stays yours** - your work, your credentials, your spend,
all on hardware you control. Part of what makes that practical is that Hezo carries its own
database: by default there's nothing external to provision, and your data never leaves your
machine.

## An embedded database by default - nothing external to run

Out of the box Hezo runs an **embedded Postgres** database *inside* the single binary.
There is **no separate database server** to install, configure, or keep running alongside
it - you start `hezo` and the database comes with it. Your teams, projects, tasks,
comments, documents, and settings all live in one local **data directory** (default
`~/.hezo/`). Back that directory up and you've backed up your instance; move it to another
machine and your instance moves with it. See [Self-hosting](/docs/deployment/self-hosting)
for where the data directory lives and how to run Hezo unattended.

## Or bring your own Postgres

If you'd rather run against a managed or self-run **PostgreSQL 14+** - for managed
backups, more headroom, or your own operational tooling - point Hezo at it with
`--database-url` / `HEZO_DATABASE_URL` (see
[Using an external Postgres](/docs/deployment/configuration#using-an-external-postgres);
for a cloud deployment there's a step-by-step in
[Managed database & asset storage](/docs/deployment/cloud#managed-database--asset-storage)).
The data directory is still used for workspaces, uploaded assets, and keys; only the
database rows move.

Uploaded **asset files** work the same way: they live under `<data-dir>/assets/` by
default, or in any **S3-compatible bucket** when you set `--asset-storage-url` /
`HEZO_ASSET_STORAGE_URL` (see
[Storing assets in S3-compatible object storage](/docs/deployment/configuration)). With a
bucket configured, asset bytes live only with your storage provider - stored as plain
objects (enable the provider's server-side encryption if you want them encrypted at
rest) and always served through Hezo's signed URLs, so the bucket stays private. The
active backend is shown under **Settings → Storage → Asset storage**.

Be clear-eyed about what changes: **your business content - tasks, comments, documents -
is stored as ordinary database rows**, so with an external database that content lives
with your database provider and travels the network. Hezo checks the server version at
startup and shows the connection target (credentials occluded, never the full URL) under
**Settings → Storage → Database**. Use TLS: `sslmode=verify-full` encrypts *and* proves
you are talking to the right server, where `sslmode=require` only encrypts - see
[TLS and sslmode](/docs/deployment/configuration#tls-and-sslmode). Prefer private networking,
and treat the provider's at-rest encryption and access controls as part of your security
posture. Secrets are unaffected - see below.

## Encrypted where it counts

The sensitive things - your AI provider keys, OAuth tokens, the per-project SSH/signing
keys, and any secrets you store - are **encrypted at rest** with AES-256-GCM, behind the
[master key](/docs/security/master-key) that only you hold. That holds on **both**
backends: an external database only ever sees ciphertext for these values, and a copy of
the database without the master key cannot decrypt them, which is why a complete backup
needs [both](/docs/deployment/backup-and-recovery).

## Safe upgrades that preserve your data

New Hezo versions sometimes need to change the database's shape. Those changes ship as
**real, tracked, data-preserving migrations** that run automatically on startup - and the
process is deliberately cautious:

- **Embedded: your live data is never migrated in place.** Hezo migrates a *copy* of the
  database and only swaps the upgraded copy in once every step has succeeded - keeping the
  previous copy aside in the data directory as a known-good point to roll back to. If
  anything fails, the copy is discarded and your original data is left exactly as it was -
  so you can simply go back to the previous binary.
- **External: migrations apply one transaction at a time,** serialized by a database-side
  lock so two starting instances can't collide. A failed migration rolls back cleanly and
  everything applied before it remains intact; pair this with your provider's backups or
  point-in-time recovery before upgrading.
- **Downgrades are caught, not corrupted.** If you point an older binary at a database
  written by a newer one, Hezo notices and exits with a clear message rather than risking
  your data.

The net effect: upgrades are safe by default, and your data is preserved across them
without any manual migration work on your part.

## Reclaiming disk from old database versions

Each embedded upgrade leaves the previous database copy behind in the data directory as a
rollback point, and Hezo keeps the few most recent ones automatically. On a long-running
instance these can add up to gigabytes. When you're confident you won't need to roll back,
open **Settings → Storage → Database** (superuser only): it shows how much disk the retained
copies are using next to a **Prune** button that deletes them all. Your current database is
untouched - but once pruned, you can no longer roll back to an earlier version. This applies
to the embedded database only; an external Postgres keeps no such copies.

## Reclaiming disk from old agent run logs

Every agent run keeps its full step-by-step log, and on a busy instance those logs become
the largest thing in the database. When you no longer need the blow-by-blow detail of old
runs, open **Settings → Storage → Database** (superuser only) and use **Compact old run
logs**. Pick a window (for example, older than 30 days) and Hezo trims each of those runs'
logs down to the part that still matters - the agent's end-of-run summary and outcome -
while keeping the exact command that launched the run and clearly marking the log as
compacted. Status, timing, token counts, and cost are untouched; runs newer than the window
are left alone.

The card also shows your current **database size** and how much run logs are using, so you
can see the effect. Compaction runs in the background a batch at a time, so the button is
disabled while a pass is in progress. On the embedded database the pass finishes by
reclaiming the freed space (and accumulated storage overhead) so the on-disk size actually
drops. Trimming is permanent - the detailed output of a compacted run can't be recovered -
so Hezo confirms before it starts.
