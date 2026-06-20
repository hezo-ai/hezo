---
title: Self-hosting
order: 17
section: Deployment
---

# Self-hosting Hezo

Hezo is **self-hosted by design** — it's a single binary you run on hardware you
control, with no external services required to operate it. You own the data, the model
keys, and the spend.

## What you need

- A host that can run **Docker** (your laptop, a home server, or a cloud VPS).
- The **`hezo` binary** (see [Installation](/docs/getting-started/installation)).
- Your **master key** (created on first run; see
  [First-run setup](/docs/getting-started/first-run)).

## The data directory

Everything Hezo keeps lives in one place — the **data directory** (default `~/.hezo/`):

- the embedded database (teams, projects, tasks),
- your **encrypted** secrets and signing keys, and
- project assets.

There's no separate database server to run. Because this directory holds everything,
it's the one thing to back up — see [Backup & recovery](/docs/deployment/backup-and-recovery).

## Running it

Start the server in the foreground:

```sh
hezo
```

For an always-on instance, run it under your platform's service manager (for example a
`systemd` unit on Linux) so it restarts on boot. Remember that Hezo starts **locked**
after a restart — either unlock it from the web app or pass the master key via
`HEZO_MASTER_KEY` so it can come up unattended (see
[Deploying to the cloud](/docs/deployment/cloud)).

## Ports

- **3100** — the Hezo server and web app (configurable with `--port`).
- **4100** — Hezo Connect, the gateway that brokers account sign-ins (such as GitHub).

Only the server port needs to be reachable by the people using Hezo.

## Updating

Upgrading is replacing the binary. On startup Hezo runs any required database
migrations automatically, taking a snapshot first so an upgrade is safe to roll back.
See [Backup & recovery](/docs/deployment/backup-and-recovery).

## Next

- [Deploying to the cloud](/docs/deployment/cloud) — run it on a server.
- [Secure remote access](/docs/deployment/secure-remote-access) — reach it safely.
- [Configuration reference](/docs/deployment/configuration) — every flag and variable.
