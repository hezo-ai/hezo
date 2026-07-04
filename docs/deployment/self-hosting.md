---
title: Self-hosting
order: 26
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
after a restart — by design — so you unlock it from the web app's gate each time it comes
back up. Don't store the master key on the server to skip that step; it's the one secret
Hezo keeps in memory only (see [Master key & encryption](/docs/security/master-key)).

### Run as a systemd service (Linux)

On a Linux host, a `systemd` unit gives you **auto-restart** (on crash and on
boot). The unit below runs Hezo **as root** — the default when no `User=` is set
— so the process reaches the Docker socket directly, with no need to add a user
to the `docker` group.

**1. Install the prerequisites.** Make sure Docker is enabled and the `hezo`
binary is on disk (see [Installation](/docs/getting-started/installation)):

```sh
sudo systemctl enable --now docker     # Docker must be running first
command -v hezo                        # note the absolute path, e.g. /usr/local/bin/hezo
sudo mkdir -p /var/lib/hezo            # a stable data directory
```

**2. Put non-secret settings in an env file.** Create an env file for the
service — the data directory and, if the instance is reached via a public URL,
its address:

```sh
sudo install -d -m 700 /etc/hezo
sudo install -m 600 /dev/null /etc/hezo/hezo.env
```

```sh
# /etc/hezo/hezo.env
HEZO_DATA_DIR=/var/lib/hezo
# HEZO_WEB_URL=https://hezo.example.com   # only if reached via a public URL
```

> **Never put your master key in this file** (or anywhere else on the server).
> The master key is deliberately kept in memory only — a copy on disk next to the
> encrypted data defeats encryption at rest, letting anyone who can read the disk
> decrypt your vault. Hezo comes up **locked** after each restart on purpose; you
> unlock it from the browser gate (step 5).

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

**5. Unlock it in the browser.** Hezo comes up **locked** — open it in the browser
to create your master key and finish setup on first run, and to unlock it again
after each restart. Keep the twelve words somewhere safe **off** the server; Hezo
never stores them, so unlocking from the gate is how the instance comes back up.

In-app auto-update continues to work under systemd: Hezo swaps in the new binary
and relaunches itself internally, so systemd sees one continuously running
service.

**Running as a non-root user instead.** Add `User=hezo` (and `Group=hezo`) to the
`[Service]` section, make that user a member of the `docker` group
(`sudo usermod -aG docker hezo`), and give it ownership of the data directory
(`sudo chown -R hezo:hezo /var/lib/hezo`). This is fully supported: Hezo fixes
container file ownership from *inside* each container, so it needs no host
privilege either way.

**Custom agent images.** Inside each project container Hezo runs the agent (and its
git operations) as a non-root **run-user** — the stock agent image's `node` — so the
files the agent writes stay non-root-owned, and it automatically gives that user
ownership of the bind-mounted workspace and per-run config. A custom
`docker_base_image` with no `node` user simply runs the agent as the image's default
user (root for most images), which also works; include a non-root user named `node`
if you want agent-created files owned by a non-root uid on the host.

## Networking & firewall

- **3100** — the Hezo server and web app (configurable with `--port`).

That is the only port **people** need to reach — Hezo serves the web app and brokers
account sign-ins (such as GitHub) itself, so there is no separate gateway service or port.

### Container → host connectivity (native-Linux Docker)

There is a second path that is easy to miss: agents run inside Docker containers and call
**back to the host** for their tools and traffic. Each container reaches the host as
`host.docker.internal` and must connect to:

- **3100** — the MCP server (the agent's Hezo toolset) and, for git, the SSH bridge.
- **20000–29999** — the per-run egress proxy (outbound API calls and secret substitution).

On **Docker Desktop** (macOS/Windows) this just works — it tunnels `host.docker.internal`
to the host. On **native-Linux Docker** `host.docker.internal` resolves to the *bridge
gateway IP*, so two things have to be true or **every agent run hangs with no tools and the
CEO chat reports its tools "aren't available"**:

1. **The host firewall must let the Docker bridge reach the host.** Docker opens the path
   for container→internet traffic but **not** container→host, so a default-deny firewall
   (commonly `ufw`) silently drops it. The simplest correct rule trusts the bridge interface:

   ```sh
   sudo ufw allow in on docker0          # allow the Docker bridge to reach the host
   sudo ufw reload
   ```

   To scope it tighter instead, open the specific ports (adjust `3100` if you changed
   `--port`; git-over-SSH also uses an ephemeral high port, which the interface rule above
   covers but a port list does not):

   ```sh
   sudo ufw allow in on docker0 to any port 3100 proto tcp
   sudo ufw allow in on docker0 to any port 20000:29999 proto tcp
   ```

   On a custom bridge network, replace `docker0` with its interface
   (`docker network inspect bridge -f '{{index .Options "com.docker.network.bridge.name"}}'`).
   On raw `iptables`, insert matching `ACCEPT` rules for `-i docker0`. `firewalld` usually
   trusts `docker0` already.

2. **The egress proxy and SSH bridge bind a container-reachable interface — usually
   automatically.** They default to `127.0.0.1` (loopback — correct for Docker Desktop), which a
   container can't reach via the bridge gateway. On native-Linux Docker the **boot-time
   connectivity check below detects this and auto-rebinds them to the docker bridge gateway IP**
   (host-local and container-reachable — not exposed on external interfaces), so proxied egress
   and git-over-SSH normally work out of the box with no flag. To pin a specific interface
   yourself, set `--container-bind-host` (an explicit non-loopback value is never auto-overridden)
   and let the firewall above restrict who can reach it:

   ```sh
   HEZO_CONTAINER_BIND_HOST=0.0.0.0 hezo     # or --container-bind-host 0.0.0.0
   ```

   The MCP server already listens on all interfaces, so step 1 alone restores the agent
   toolset; step 2 covers outbound proxied API calls, credentialed requests, and git-over-SSH.

Hezo runs a **boot-time connectivity check** — it starts a throwaway container, has it call
back to the host, and (as above) auto-rebinds the proxy / SSH bridge to the bridge gateway IP
when a loopback bind is unreachable, logging the exact firewall / `--container-bind-host` fix
for anything still blocked, so you see the problem at startup instead of as a stalled agent run.
An unreachable MCP server is logged as an error (no tools load); a residual egress/SSH bind-host
problem is a non-fatal **warning**. If the egress proxy stays unreachable, **agent runs and CEO
chat turns now fail with a clear error** (rather than silently bypassing the proxy) — the gate
clears on its own within minutes once you open the path, no restart needed. To verify by hand:

```sh
docker run --rm --add-host=host.docker.internal:host-gateway curlimages/curl \
  curl -sv --max-time 5 http://host.docker.internal:3100/mcp
```

Read the result carefully — it tells you which problem you have:

- **Timeout** → packets are being *dropped* by a firewall (or a VPN kill-switch, below). Open
  the path. This is the common case.
- **Connection refused** → nothing is listening on that interface. Check the server is up
  (`sudo ss -ltnp | grep ':3100'` should show `0.0.0.0:3100`) and that the egress proxy / SSH
  bridge use `--container-bind-host` (step 2 above).
- **Any HTTP status** (even `401` / `404`) → connectivity is fine; look elsewhere.

#### Opening the path, by firewall tool

The traffic is the container (`172.17.0.0/16`) reaching the host over `docker0`, so it lands
in the host's **INPUT** chain — which Docker never opens for you:

```sh
# ufw
sudo ufw allow in on docker0 && sudo ufw reload

# iptables (persist with netfilter-persistent save / iptables-save)
sudo iptables -I INPUT -i docker0 -j ACCEPT

# nftables — add to your input chain (adjust table/chain names to your ruleset)
sudo nft add rule inet filter input iifname "docker0" accept

# firewalld — usually already trusts docker0; if not:
sudo firewall-cmd --permanent --zone=trusted --add-interface=docker0 && sudo firewall-cmd --reload
```

#### VPN kill-switches (NordVPN, Tailscale, Mullvad, …)

A VPN kill-switch installs its **own** firewall rules — often in `nftables`, or in `OUTPUT`
and custom chains rather than `INPUT` — that drop everything not bound for the tunnel,
including the Docker bridge ↔ host path. The tell-tale sign is a `docker0` **timeout even
though `sudo iptables -S INPUT` shows `-P INPUT ACCEPT`** and no rule matching the
container's source: a different ruleset is dropping the packet (or the host's reply). Allow
the Docker subnet through the VPN instead of disabling protection:

```sh
# NordVPN — allowlist the docker bridge subnet (older builds call it `whitelist`)
nordvpn allowlist add subnet 172.17.0.0/16
# …or permit private LAN ranges, which include the bridge:
nordvpn set lan-discovery enable
# confirm it's the cause by toggling the kill-switch off briefly, then re-run the probe:
nordvpn set killswitch disable
```

For Tailscale, Mullvad, or another client, allow the local network / the `172.17.0.0/16`
(or your custom bridge) subnet in its settings. When hunting the drop, inspect **all** chains
and both backends, not just `INPUT`: `sudo iptables -S` and `sudo nft list ruleset`.

## Updating

### In-app auto-update

Hezo checks GitHub Releases and, when a newer version is available, downloads and
verifies the binary for your platform in the background. Once it's staged, a bar
appears in the web UI; a superuser clicks **Install & restart** and confirms.
Because the download already happened, the restart is instant — Hezo shuts down
gracefully, swaps in the new binary, and restarts onto it, with no manual file
replacement. If a background download fails, the bar offers a **Retry download**
button (with the GitHub release as a manual fallback), and it automatically
re-attempts on a later check. (If the background download is disabled or can't
run — for example inside a container — the bar instead links to the GitHub
release page.)

Because the restart re-locks the instance, **you'll need your 12-word master key
to unlock Hezo again afterward** from the browser gate — that re-lock is by design,
and unlocking interactively is the secure way back up (don't stash the key on the
server to avoid it). In-flight agent runs are aborted and recovered automatically,
and connected browsers reconnect on their own.

Auto-update applies to the self-managed single binary. It is disabled when Hezo
runs inside a container (update the image instead) and can be turned off with
`HEZO_DISABLE_AUTO_UPDATE`. The daily check schedule is configurable via
`HEZO_UPDATE_CHECK_CRON`. See [Configuration](/docs/deployment/configuration).

### Updating manually

You can always upgrade by replacing the binary yourself. On startup Hezo runs any
required database migrations automatically, taking a snapshot first so an upgrade
is safe to roll back. See [Backup & recovery](/docs/deployment/backup-and-recovery).
