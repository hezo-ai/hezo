---
title: Self-hosting
order: 26
section: Deployment
---

# Self-hosting Hezo

Hezo is **self-hosted by design** - it's a single binary you run on hardware you
control, with no external services required to operate it. You own the data, the model
keys, and the spend.

## What you need

- A host that can run a **Docker-compatible container runtime** (your laptop,
  a home server, or a cloud VPS). Colima, Rancher Desktop, OrbStack, Lima and rootless
  Docker all work - see [Container runtimes](/docs/deployment/container-runtimes).
  Running agent containers on a
  [managed sandbox service](/docs/containers/remote/overview) instead? Then the host
  needs no container runtime at all - and **Settings -> Containers** switches an
  instance between the two at any time.
- The **`hezo` binary** (see [Installation](/docs/getting-started/installation)).
- Your **master key** (created on first run; see
  [First-run setup](/docs/getting-started/first-run)).

**Low-RAM host?** Agent containers are memory-hungry, so on a small box (under ~2 GB
RAM) add swap or the kernel may OOM-kill Hezo. The
[one-click deploy](/docs/deployment/one-click) sets up a 6 GB swap file for you; on a
manual install, add one yourself:

```sh
sudo fallocate -l 6G /swapfile && sudo chmod 600 /swapfile
sudo mkswap /swapfile && sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
```

## The data directory

Everything Hezo keeps lives in one place - the **data directory** (default `~/.hezo/`):

- the embedded database (teams, projects, tasks),
- your **encrypted** secrets and signing keys, and
- project assets (under `assets/`).

There's no separate database server to run by default - but both data stores can be
handed to managed services: an
[external Postgres](/docs/deployment/configuration#using-an-external-postgres) for the
database, and
[S3-compatible object storage](/docs/deployment/configuration#storing-assets-in-s3-compatible-object-storage)
for assets (step-by-step:
[Managed database & asset storage](/docs/deployment/cloud#managed-database--asset-storage)).
The data directory is still required for workspaces and keys either way. Because this
directory holds everything by default, it's the one thing to back up - see
[Backup & recovery](/docs/deployment/backup-and-recovery).

## Running it

Start the server in the foreground:

```sh
hezo
```

For an always-on instance, run it under your platform's service manager (for example a
`systemd` unit on Linux) so it restarts on boot. A new Hezo process starts **locked** by
default. A supervised in-app update hands the key to the new process in memory. A reboot,
crash, or direct service restart comes up locked unless that invocation deliberately
receives the one-shot `--master-key` or `HEZO_MASTER_KEY` input. You can otherwise unlock
from the web app's gate.
Don't store the master key on the server to skip the unlock step; it's the one secret
Hezo keeps in memory only (see [Master key & encryption](/docs/security/master-key)).

### Run as a systemd service (Linux)

On a Linux host, a `systemd` unit gives you **auto-restart** (on crash and on
boot). The unit below runs Hezo **as root** (the default when no `User=` is set),
so the process reaches the Docker socket directly, with no need to add a user
to the `docker` group.

**1. Install the prerequisites.** Make sure Docker is enabled and the `hezo`
binary is on disk (see [Installation](/docs/getting-started/installation)):

```sh
sudo systemctl enable --now docker     # Docker must be running first
command -v hezo                        # note the absolute path, e.g. /usr/local/bin/hezo
sudo mkdir -p /var/lib/hezo            # a stable data directory
```

**2. Put the settings in a config file.** Create a config file for the service -
the data directory and, if the instance is reached via a URL beyond `localhost`,
its HTTPS address:

```sh
sudo install -d -m 700 /etc/hezo
sudo install -m 600 /dev/null /etc/hezo/hezo.config.cjs
```

```js
// /etc/hezo/hezo.config.cjs
module.exports = {
  dataDir: '/var/lib/hezo',
  // webUrl: 'https://hezo.example.com',   // the HTTPS URL it's reached at (omit for localhost-only use)
};
```

Mode 600 because this file is where a database or object-storage URL would go, and
those carry credentials. See the
[Configuration reference](/docs/deployment/configuration) for every setting.

> **Never put your master key in this file** (or anywhere else on the server).
> The master key is deliberately kept in memory only - a copy on disk next to the
> encrypted data defeats encryption at rest, letting anyone who can read the disk
> decrypt your vault. A new service process starts **locked** by default. The unit below
> deliberately supplies no one-shot `--master-key` or `HEZO_MASTER_KEY` input, so a boot,
> crash recovery, or `systemctl restart hezo` requires an unlock (step 5).

**3. Create the unit** at `/etc/systemd/system/hezo.service`:

```ini
[Unit]
Description=Hezo
Requires=docker.service
After=docker.service network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=/usr/local/bin/hezo --config /etc/hezo/hezo.config.cjs
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

**5. Unlock it.** Open Hezo in the browser to create your master key and finish setup on
first run. The systemd unit above starts each new process locked, so use the browser gate
after a boot, crash, or direct service restart. A one-shot `--master-key` or
`HEZO_MASTER_KEY` input can unlock one deliberate invocation instead, but never persist
the phrase in the unit or on the server.

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
git operations) as a non-root **run-user** (the stock agent image's `node`), so the
files the agent writes stay non-root-owned, and it automatically gives that user
ownership of the bind-mounted workspace and per-run config. A custom
`docker_base_image` with no `node` user simply runs the agent as the image's default
user (root for most images), which also works; include a non-root user named `node`
if you want agent-created files owned by a non-root uid on the host.

## Serve it over HTTPS

Hezo's process itself serves plain HTTP, so for anything beyond `localhost` use - on a
private network or VPN just as much as on a public domain - put a TLS-terminating
reverse proxy in front and browse the instance through it. HTTPS is what makes
OAuth-connected MCP servers connectable (providers and browsers only accept HTTPS or
`localhost` callback URLs), lets Hezo install as an app on your phone, and keeps your
admin password and task content sealed in transit. The proxy must pass WebSocket
upgrades and forward the `Host` and `X-Forwarded-Proto` headers - see
[Serve it over HTTPS](/docs/deployment/cloud#serve-it-over-https) for a working
config, and [Secure remote access](/docs/deployment/secure-remote-access) for
certificate options on private networks.

## Networking & firewall

- **3100** - the Hezo server and web app (configurable with `--port`).

That is the only port the **reverse proxy** (and, through it, people) needs to reach -
Hezo serves the web app and brokers account sign-ins (such as GitHub) itself, so there
is no separate gateway service or port. With the proxy on the same host, 3100 doesn't
need to be reachable from outside the host at all - browsers connect to the proxy's
HTTPS port instead - agent containers never connect to it (see below).

### Agent containers do not connect back to the host

There used to be a whole class of native-Linux Docker problem here: agents run inside
containers, called **back to the host** for their tools and their traffic, and a
default-deny firewall silently dropped that path - so every agent run hung with no tools
and the CEO chat reported its tools "aren't available".

That path is gone. Hezo now reaches **into** each container instead: it opens one extra
exec and runs a small tunnel program there, which gives the container loopback ports
leading back to Hezo's MCP endpoint, egress proxy and SSH agent. Nothing in a container
resolves or dials a host address, so:

- **No inbound rule is needed for the Docker bridge.** There is nothing for a firewall to
  drop, on any Docker flavour.
- **The egress proxy and SSH bridge bind loopback only**, always. They are never exposed
  on a bridge or external interface, and there is no interface to choose.
- **Hezo needs no public hostname and no inbound port** for agent runs. Outbound access to
  the container backend is enough, which is also what lets a laptop drive a managed
  sandbox service.

This is the same on every supported runtime - Docker Engine and Docker Desktop, Colima,
Rancher Desktop, OrbStack, Lima and rootless Docker alike. Earlier versions needed a
firewall rule and a bind-host setting on native-Linux Docker, because a container reached
the host across the bridge gateway; containers now reach Hezo over their own loopback
through the run tunnel, so there is no interface to pick and nothing to open.

Only requests that need a security check - a host that could carry a substituted secret,
or one whose connector has a method allowlist - travel the tunnel to the egress proxy.
Everything else (`apt`, `npm`, `playwright install`) goes straight out from the container,
so package installs never transit the Hezo process.


#### VPN kill-switches (NordVPN, Tailscale, Mullvad, …)

A VPN kill-switch installs its **own** firewall rules - often in `nftables`, or in `OUTPUT`
and custom chains rather than `INPUT` - that drop everything not bound for the tunnel. That
no longer affects an agent's route to Hezo (there isn't one), but it can still drop a
container's **outbound internet** traffic, so a run fails on `apt`, `npm` or a git fetch.
Allow the Docker subnet through the VPN instead of disabling protection:

```sh
# NordVPN - allowlist the docker bridge subnet (older builds call it `whitelist`)
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
Because the download already happened, the restart is instant - Hezo shuts down
gracefully, swaps in the new binary, and restarts onto it, with no manual file
replacement. If a background download fails, the bar offers a **Retry download**
button (with the GitHub release as a manual fallback), and it automatically
re-attempts on a later check. (If the background download is disabled or can't
run (for example inside a container), the bar instead links to the GitHub
release page.)

An update restart comes back **unlocked**: the part of Hezo that supervises the
restart holds the unlock key **in memory** across the swap and hands it to the new
process, so nothing is ever written to disk and you don't re-enter your master key
after an update. Restarts that supervisor doesn't survive - a direct service restart, a
crash, a reboot - still come up locked by design unless that invocation receives the
one-shot `--master-key` or `HEZO_MASTER_KEY` input. You can otherwise unlock from the
browser gate. In-flight agent runs are
aborted and recovered automatically, and connected browsers reconnect on their own.

Auto-update applies to the self-managed single binary. It is disabled when Hezo
runs inside a container (update the image instead) and can be turned off with
`updates.disabled` in your config file. The daily check schedule is configurable via
`jobs.updateCheckCron`. See [Configuration](/docs/deployment/configuration).

### Installing updates automatically

For a hands-off server, start Hezo with `--auto-install-updates` (or
`updates.autoInstall: true`) and it installs staged updates by itself: once a
newer release has been downloaded and verified, Hezo waits until no agent runs
are in flight and then performs the same graceful restart as the **Install &
restart** button - no click needed. If agents are busy, the install is retried
every few minutes and lands as soon as the instance goes idle.

Two things to know before enabling it:

- **The instance comes back unlocked** after the automatic restart - the unlock
  key is handed to the new process in memory (see above), so agents resume
  without anyone re-entering the master key. Restarts outside the update flow
  (direct service restart, reboot, crash) still come up locked by design unless that
  invocation receives the one-shot `--master-key` or `HEZO_MASTER_KEY` input. You can
  otherwise use the browser gate - never persist the key to disk on the server
  to avoid that (see [Master key & encryption](/docs/security/master-key)).
- It only takes effect where in-app auto-update works at all: the self-managed
  single binary, not inside a container (update the image instead), and not
  with `updates.disabled` set.

### Updating manually

You can always upgrade by replacing the binary yourself. On startup Hezo runs any
required database migrations automatically - the embedded database is migrated on a
copy and swapped in only on success (the previous copy is kept aside), so an upgrade
is safe to roll back. See [Backup & recovery](/docs/deployment/backup-and-recovery).

### If an upgrade sits on "Running database migrations…"

Migrations run in the **server**, not the browser. The screen you see is the web UI
reporting the server's boot progress, and it names the step in flight - copying the
database aside, writing the pre-migration backup, then each migration as it is
applied. A large instance can legitimately spend a few minutes there, and the screen
shows an elapsed timer so you can tell it is still moving.

Two messages mean it is **not** just slow:

- **"The server restarted while starting up"** - the process is dying and your
  service manager is restarting it, so the same boot is being retried over and over.
- **"The previous start failed…"** with a reason - the last boot hit a fatal error
  (a failed migration, unreachable database, broken asset storage). The reason shown
  is what to fix.

Check the service log for what actually happened:

```sh
journalctl -u hezo -n 200 --no-pager
```

The most common cause on a small VPS is the host running out of memory: the log
shows the worker exiting with **code 137** (the kernel killed it) with no error of
Hezo's own. Give the host more RAM or add swap - the provisioning script sets up a
6 GB swap file for this reason, and `swapon --show` tells you whether it is active.

## Keeping the host patched

This section is about patching the **operating system** under Hezo, not Hezo
itself. On Ubuntu and Debian, `unattended-upgrades` installs security updates on
its own daily schedule. After each one a helper called `needrestart` runs from
the package manager's hook and, in the automatic mode Ubuntu uses there,
restarts every service still running against a library the upgrade replaced.
That is the right default for most daemons: a patched file on disk does nothing
for a process that still has the old code mapped in memory.

Hezo needs a deliberate restart path because its master key is held in memory only and
never written to disk. A supervised in-app update hands the key to the new process in
memory. A direct service restart starts the new process **locked** by default unless that
invocation deliberately receives the one-shot `--master-key` or `HEZO_MASTER_KEY` input. Agent
execution otherwise stays stopped until someone unlocks it. An unattended
restart therefore turns a routine background patch into an outage lasting until
you happen to notice - a couple of minutes if you are at your desk, the whole
night if it lands at 3am.

The one-click deploy installs an exemption at
`/etc/needrestart/conf.d/hezo.conf` so that never happens:

```perl
$nrconf{override_rc} = { qr(^hezo\.service$) => 0 };
```

Patches still download and install on the usual schedule. `needrestart` still
*reports* that Hezo wants a restart - it simply no longer performs one, so the
restart is yours to make at a moment when you can unlock right afterwards. If
you set the service up by hand rather than through the one-click deploy, write
that file yourself.

**The trade-off is that you have to come back for it.** Until you restart, Hezo
keeps running against the pre-patch copy of the library, so a fix for something
like a C-library vulnerability is not yet live in the running process. Check for
a pending restart whenever you are on the box:

```sh
sudo needrestart -b -r l      # lists services running against replaced libraries
```

If `hezo.service` is listed, restart it at a time when you can unlock it:

```sh
sudo systemctl restart hezo
```

Kernel upgrades need a full reboot, which locks Hezo the same way, so they are a
natural moment to take both together.
