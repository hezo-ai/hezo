# Hezo deploy artifacts

One-click / near-one-click deployment of a self-hosted Hezo instance onto a VPS.

Hezo runs as a host binary that needs the host Docker socket (it launches a
container per project), so it deploys to a **real VPS/Droplet with Docker on the
host** — not to a managed-container PaaS. These artifacts automate that host setup.

## What's here

| Path | Purpose |
|---|---|
| `provision.sh` | The canonical, self-contained installer. Installs Docker, downloads the `hezo` binary, sets up Caddy (automatic HTTPS + WebSocket passthrough), installs the systemd units, and locks the firewall down. Single source of truth — everything else runs it. |
| `cloud-init/hezo.cloud-config.yaml` | Portable cloud-init user-data. Paste it into any VPS provider's "User data" field; it fetches and runs `provision.sh` on first boot. |

## How it works

`provision.sh` provisions the host, then a `hezo-firstboot` systemd unit derives
the public HTTPS URL on first boot — `https://<public-ip>.sslip.io` by default (a
real Let's Encrypt cert, no domain required), or a domain you supply via
`HEZO_DOMAIN_OVERRIDE`. It never sets the master key: that is generated in the
browser on first run and shown once, so the deploy lands you at the setup gate and
you finish there (master key → admin password → connect a model). Password auth
makes exposing that URL safe.

Firewall posture: only **80/443** are public; **3100** (the Hezo server) and
**20000–29999** (the per-run egress proxy) stay host-local, while the Docker
bridge (`docker0`) can still reach the host so agent containers get their tools.
See `docs/deployment/self-hosting.md` § Networking & firewall.

## Using it

The user-facing guide with per-provider steps is
[`docs/deployment/one-click.md`](../docs/deployment/one-click.md). In short: create
an Ubuntu server (≥2 GB RAM), paste `cloud-init/hezo.cloud-config.yaml` into its
user-data field, wait ~2 minutes, open the `sslip.io` URL, finish setup.

To run it by hand instead (e.g. an existing box):

```sh
curl -fsSL https://raw.githubusercontent.com/hezo-ai/hezo/main/deploy/provision.sh | sudo bash
```

## Verifying a change

`provision.sh` has no unit-test tier — it provisions a host, so verify it on a
throwaway VM/droplet:

1. **Local VM:** `multipass launch 24.04 --cloud-init cloud-init/hezo.cloud-config.yaml`,
   then check `systemctl is-active hezo caddy` and
   `curl -s http://127.0.0.1:3100/health` → `{"ok":true}`. (Multipass has no public
   IP — set `HEZO_DOMAIN_OVERRIDE` to a local name to exercise Caddy.)
2. **Throwaway droplet:** create a small droplet with the cloud-init, then from your
   laptop hit `https://<ip>.sslip.io/health` (a valid cert proves the Let's Encrypt
   path) and load the root URL to confirm you reach the master-key gate. Destroy it.

## Roadmap — Phase 2 (not built yet)

A `marketplace/digitalocean/` Packer template that bakes `provision.sh` into a
DigitalOcean Marketplace image gives the literal one-click "Create Hezo Droplet"
button. It's deferred because publishing requires an external DigitalOcean vendor
account and image review that can't be done from this repo.
