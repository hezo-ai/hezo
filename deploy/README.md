# Hezo deploy artifacts

One-click / near-one-click deployment of a self-hosted Hezo instance onto a VPS.

Hezo runs as a host binary that needs the host Docker socket (it launches a
container per project), so it deploys to a **real VPS/Droplet with Docker on the
host** — not to a managed-container PaaS. These artifacts automate that host setup.

## What's here

| Path | Purpose |
|---|---|
| `provision.sh` | The canonical, self-contained installer. Installs Docker, downloads the `hezo` binary, sets up Caddy (automatic HTTPS + WebSocket passthrough), installs the systemd units, exempts Hezo from needrestart's automatic restarts, and locks the firewall down. Single source of truth — everything else runs it. |
| `cloud-init/hezo.cloud-config.yaml` | Portable cloud-init user-data. Paste it into any VPS provider's "User data" field; it fetches and runs `provision.sh` on first boot. |
| `aws/` | CloudFormation **Launch Stack** template (`hezo.cfn.yaml`) — an EC2 VM whose UserData runs `provision.sh`. See [`aws/README.md`](aws/README.md). |
| `gcp/` | **Open in Cloud Shell** deploy — `deploy.sh` creates a Compute Engine VM (startup script runs `provision.sh`) with a guided `tutorial.md`. See [`gcp/README.md`](gcp/README.md). |
| `marketplace/digitalocean/` | Packer template that bakes `provision.sh` into a DigitalOcean Marketplace 1-Click image. See [`marketplace/digitalocean/README.md`](marketplace/digitalocean/README.md). |

Every per-provider button hands `provision.sh` (or the cloud-init) to a fresh VM —
there is one installer, wrapped per provider. Hezo needs the **host Docker socket**
(it launches a container per project), so all of these target a **real VM**; a
managed-container PaaS (Render, Railway, Cloud Run) can't run it.

### How one-click per provider stands today

| Provider | Wrapper (in this repo) | Fully-hosted button needs |
|---|---|---|
| **Google Cloud** | `gcp/` Cloud Shell button | Nothing — Cloud Shell reads this repo directly; works on `main`. |
| **AWS** | `aws/hezo.cfn.yaml` | A one-time upload of the template to a public S3 URL (CloudFormation quick-create requires S3). Manual `aws cloudformation deploy` works today. |
| **DigitalOcean** | `marketplace/digitalocean/` Packer image | An external DO vendor account + DO's image review to publish the listing. The cloud-init path works today. |

## How it works

`provision.sh` provisions the host, then a `hezo-firstboot` systemd unit derives
the public HTTPS URL on first boot — `https://<public-ip>.sslip.io` by default (a
real Let's Encrypt cert, no domain required), or a domain you supply via
`HEZO_DOMAIN_OVERRIDE`. Managed data hosting is wired the same way: seed
`HEZO_DATABASE_URL` (managed Postgres) and/or `HEZO_ASSET_STORAGE_URL`
(S3-compatible bucket) into `/etc/hezo/deploy.env` before the script runs (the
cloud-init has commented lines for it) and they're persisted into the service's
env file — see `docs/deployment/one-click.md` § Using managed data hosting. It never sets the master key: that is generated in the
browser on first run and shown once, so the deploy lands you at the setup gate and
you finish there (master key → admin password → connect a model). Password auth
makes exposing that URL safe.

Unattended upgrades: Ubuntu's post-upgrade `needrestart` hook restarts services
running against replaced libraries, which would leave Hezo **locked** (its master
key is in memory only) until an operator unlocked it from the browser. The script
drops `/etc/needrestart/conf.d/hezo.conf` so the restart is reported but never
performed - patches still install on schedule, and the restart is taken
deliberately. See `docs/deployment/self-hosting.md` § Keeping the host patched.

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

## DigitalOcean Marketplace image (Phase 2)

[`marketplace/digitalocean/`](marketplace/digitalocean/README.md) holds a Packer
template that bakes `provision.sh` into a DigitalOcean snapshot — the literal
one-click "Create Hezo Droplet" button. The template and build/validation runbook
are in-repo and buildable today; **publishing** the listing still requires an
external DigitalOcean vendor account and DO's image review, which can't be done
from this repo. See that directory's README for the build + submission steps.
