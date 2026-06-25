---
title: Self-hosting
order: 21
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

### Run as a systemd service (Linux)

On a Linux host, a `systemd` unit gives you **auto-restart** (on crash and on
boot) and **unattended unlock**. The unit below runs Hezo **as root** — the
default when no `User=` is set — so the process reaches the Docker socket
directly, with no need to add a user to the `docker` group.

**1. Install the prerequisites.** Make sure Docker is enabled and the `hezo`
binary is on disk (see [Installation](/docs/getting-started/installation)):

```sh
sudo systemctl enable --now docker     # Docker must be running first
command -v hezo                        # note the absolute path, e.g. /usr/local/bin/hezo
sudo mkdir -p /var/lib/hezo            # a stable data directory
```

**2. Store the master key in a locked-down env file.** Pass the master key
through the environment, never the `--master-key` flag — a flag is visible in
`ps` and `systemctl cat`. Create a root-only env file:

```sh
sudo install -d -m 700 /etc/hezo
sudo install -m 600 /dev/null /etc/hezo/hezo.env
```

Then add your settings to it (the twelve words come from
[first-run setup](/docs/getting-started/first-run)):

```sh
# /etc/hezo/hezo.env
HEZO_MASTER_KEY=word1 word2 word3 word4 word5 word6 word7 word8 word9 word10 word11 word12
HEZO_DATA_DIR=/var/lib/hezo
# HEZO_WEB_URL=https://hezo.example.com   # only if reached via a public URL
```

**3. Create the unit** at `/etc/systemd/system/hezo.service`:

```ini
[Unit]
Description=Hezo
Requires=docker.service
After=docker.service network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=/usr/local/bin/hezo
EnvironmentFile=/etc/hezo/hezo.env
Restart=always
RestartSec=5
TimeoutStopSec=30

[Install]
WantedBy=multi-user.target
```

`Requires=`/`After=docker.service` start Docker first; `Restart=always` brings
Hezo back after a crash; `WantedBy=multi-user.target` starts it on boot. Hezo
handles `SIGTERM` and exits cleanly, so `systemctl stop` won't trigger a restart
and in-flight agent runs recover on the next start.

**4. Enable and start it:**

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now hezo
systemctl status hezo
journalctl -u hezo -f          # follow the logs
```

> **First run.** Until the master key is in `hezo.env`, Hezo comes up **locked** —
> open it in the browser to create the key and finish setup, then add the twelve
> words to the env file and `sudo systemctl restart hezo` so every future restart
> unlocks unattended.

In-app auto-update continues to work under systemd: Hezo swaps in the new binary
and relaunches itself internally, so systemd sees one continuously running
service.

**Running as a non-root user instead.** Add `User=hezo` (and `Group=hezo`) to the
`[Service]` section, make that user a member of the `docker` group
(`sudo usermod -aG docker hezo`), and give it ownership of the data directory
(`sudo chown -R hezo:hezo /var/lib/hezo`).

## Ports

- **3100** — the Hezo server and web app (configurable with `--port`).
- **4100** — Hezo Connect, the gateway that brokers account sign-ins (such as GitHub).

Only the server port needs to be reachable by the people using Hezo.

## Updating

### In-app auto-update

Hezo checks GitHub Releases daily and, when a newer version is available,
downloads and verifies the binary for your platform in the background. A bar
then appears at the bottom of the web UI; a superuser clicks **Update &
restart** and confirms. Hezo shuts down gracefully, swaps in the new binary, and
restarts onto it — no manual file replacement.

Because the restart re-locks the instance, **you'll need your 12-word master key
to unlock Hezo again afterward** — unless you run Hezo with the master key set in
the environment (`HEZO_MASTER_KEY`), in which case it unlocks itself on restart.
The confirmation dialog tells you which case applies. In-flight agent runs are
aborted and recovered automatically, and connected browsers reconnect on their
own.

Auto-update applies to the self-managed single binary. It is disabled when Hezo
runs inside a container (update the image instead) and can be turned off with
`HEZO_DISABLE_AUTO_UPDATE`. The daily check schedule is configurable via
`HEZO_UPDATE_CHECK_CRON`. See [Configuration](/docs/deployment/configuration).

### Updating manually

You can always upgrade by replacing the binary yourself. On startup Hezo runs any
required database migrations automatically, taking a snapshot first so an upgrade
is safe to roll back. See [Backup & recovery](/docs/deployment/backup-and-recovery).
