---
title: Backup & recovery
order: 24
section: Deployment
---

# Backup & recovery

Everything Hezo keeps lives in its **data directory** (default `~/.hezo/`), which makes
backups straightforward — but there's one crucial pairing to understand first.

## You need the data *and* the master key

Your secrets in the data directory are **encrypted with your master key**, and the
master key is never stored there. To restore a working instance you need **both**:

- the **data directory**, and
- the **twelve-word master key** that unlocks it.

A backup of the data directory without the master key cannot be decrypted. Store the
master key separately and safely (see [Master key & encryption](/docs/security/master-key)).

## Backing up

Snapshot the data directory with whatever you already use — a file backup, a volume
snapshot, or a copy to object storage. Doing it while the server is stopped gives the
cleanest result. Keep the master key in your password manager or another safe place,
not next to the backup.

## Upgrades are safe to roll back

When you upgrade the binary, Hezo runs any needed database migrations on startup and
**takes a snapshot first**. If a newer version doesn't work out, you can roll back to a
snapshot and run the previous binary against it:

```sh
hezo restore <backup>
```

This restores a pre-upgrade snapshot into the data directory; you then start the
matching (older) binary.

## Starting over

If you need a clean slate — or you've lost the master key and have no way back — reset
the instance:

```sh
hezo --reset
```

This **wipes the database** and starts fresh. There's no other recovery path for a lost
master key, so treat `--reset` as the last resort it is.

## Next

- [Configuration reference](/docs/deployment/configuration)
- [Self-hosting](/docs/deployment/self-hosting)
