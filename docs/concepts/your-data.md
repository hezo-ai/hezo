---
title: Your data & the database
order: 16
section: Concepts
---

# Your data & the database

Hezo is built so that **everything stays yours** — your work, your credentials, your spend,
all on hardware you control. Part of what makes that practical is that Hezo carries its own
database: there's nothing external to provision, and your data never leaves your machine.

## An embedded database — nothing external to run

Hezo runs an **embedded Postgres** database *inside* the single binary. There is **no
separate database server** to install, configure, or keep running alongside it — you start
`hezo` and the database comes with it. Your teams, projects, tasks, comments, documents,
and settings all live in one local **data directory** (default `~/.hezo/`). Back that
directory up and you've backed up your instance; move it to another machine and your
instance moves with it. See [Self-hosting](/docs/deployment/self-hosting) for where the
data directory lives and how to run Hezo unattended.

## Encrypted where it counts

The sensitive things — your AI provider keys, OAuth tokens, the per-project SSH/signing
keys, and any secrets you store — are **encrypted at rest** with AES-256-GCM, behind the
[master key](/docs/security/master-key) that only you hold. A copy of the data directory
without the master key cannot be decrypted, which is why a complete backup needs
[both](/docs/deployment/backup-and-recovery).

## Safe upgrades that preserve your data

New Hezo versions sometimes need to change the database's shape. Those changes ship as
**real, tracked, data-preserving migrations** that run automatically on startup — and the
process is deliberately cautious:

- **Your live data is never migrated in place.** Hezo migrates a *copy* of the database and
  only swaps the upgraded copy in once every step has succeeded. If anything fails, the
  copy is discarded and your original data is left exactly as it was — so you can simply go
  back to the previous binary.
- **A snapshot is taken first.** Before applying migrations to an existing instance, Hezo
  writes a snapshot into the data directory, so there's always a known-good point to roll
  back to. See [Backup & recovery](/docs/deployment/backup-and-recovery).
- **Downgrades are caught, not corrupted.** If you point an older binary at a data
  directory written by a newer one, Hezo notices and exits with a clear message rather than
  risking your data.

The net effect: upgrades are safe by default, and your data is preserved across them
without any manual migration work on your part.
