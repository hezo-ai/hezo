---
title: One-click deploy
order: 25
section: Deployment
---

# One-click deploy

The fastest way to get a public, always-on Hezo running is to let your VPS
provider provision it for you. You paste one snippet when you create the server,
wait a couple of minutes, and open a working HTTPS URL — then finish the short
[first-run setup](/docs/getting-started/first-run) in your browser.

This works on any provider that runs Ubuntu and accepts **cloud-init user data**,
which is all of the common ones: DigitalOcean, Hetzner, Vultr, Linode, and AWS
Lightsail.

## What it sets up

On first boot the snippet:

- installs **Docker** and starts it (Hezo runs each project's agents in a container),
- downloads the latest **`hezo`** binary for the server's CPU architecture,
- puts **Caddy** in front for **automatic HTTPS** with a real certificate — no domain
  required (see [How the HTTPS URL works](#how-the-https-url-works)),
- runs Hezo under **systemd** so it restarts on boot and after a crash, and
- locks the **firewall** down so only the web ports (80/443) are public.

It deliberately does **not** set your master key — that's generated in your browser
on first run and shown once, so it can't be pre-filled. The deploy gets you to the
setup screen; you take it from there.

## Deploy it

1. **Create an Ubuntu server** on your provider — 2 GB RAM or more is a good start.
2. **Paste the snippet below** into the provider's user-data field (each provider
   calls it something slightly different — see [Where to paste it](#where-to-paste-it)).
3. **Create the server and wait ~2 minutes** for first boot to finish.
4. **Open `https://<your-server-ip>.sslip.io`** and complete
   [first-run setup](/docs/getting-started/first-run): create your master key, set an
   admin password, and connect a model.

```yaml
#cloud-config
package_update: true
packages:
  - curl
runcmd:
  # To use your own domain instead of sslip.io, point an A record at this server, then
  # uncomment the next line and set your domain (do it before the curl line runs):
  # - [ sh, -c, "echo 'HEZO_DOMAIN_OVERRIDE=hezo.example.com' >> /etc/environment" ]
  - [ sh, -c, "curl -fsSL https://raw.githubusercontent.com/hezo-ai/hezo/main/deploy/provision.sh -o /root/hezo-provision.sh" ]
  - [ sh, -c, "set -a; [ -f /etc/environment ] && . /etc/environment; set +a; bash /root/hezo-provision.sh" ]
```

The same file lives in the repo at
[`deploy/cloud-init/hezo.cloud-config.yaml`](https://github.com/hezo-ai/hezo/blob/main/deploy/cloud-init/hezo.cloud-config.yaml),
and the installer it runs is
[`deploy/provision.sh`](https://github.com/hezo-ai/hezo/blob/main/deploy/provision.sh) —
read them before you paste if you'd like to see exactly what runs.

### Where to paste it

| Provider | Field, on the create-server page |
|---|---|
| DigitalOcean | **Advanced options → Add Initialization scripts (user data)** |
| Hetzner Cloud | **Cloud config** |
| Vultr | **Additional Features → Enable Cloud-Init User-Data** |
| Linode | **Add User Data** |
| AWS Lightsail | **Add launch script** — and also open ports **80** and **443** in the Lightsail firewall (its console firewall is separate from the server's) |

## How the HTTPS URL works

HTTPS is essential for a working instance — OAuth-connected MCP servers only complete
their connect flow on an HTTPS address, installing Hezo on your phone needs a secure
context, and the web app streams agent activity over a secure WebSocket. But a fresh
server has a public IP and usually no domain. To bridge that, the deploy uses
**[sslip.io](https://sslip.io)** — a DNS service where `<ip>.sslip.io` always resolves
to `<ip>`. So `https://203.0.113.10.sslip.io` points straight at your server, and Caddy
automatically obtains a real Let's Encrypt certificate for it. No domain to buy, no DNS
to configure, and no browser warnings.

**Prefer your own domain?** Point an A record at the server's IP, then set
`HEZO_DOMAIN_OVERRIDE` (uncomment the line in the snippet above). Caddy provisions a
certificate for that name instead.

## After it's up

- **The master key locks the *instance*.** After a restart, Hezo comes up **locked**
  until you provide the twelve words again on the browser gate — that locked-on-restart
  behaviour is by design, and unlocking from the browser is the secure way to bring it
  back up. (In-app **update** restarts are the exception: the unlock key is handed to
  the new process in memory, so an update doesn't re-lock.) **Don't save your master key
  to a file on the server** (an env file, the systemd unit, anywhere on disk): it's the
  one secret Hezo keeps in memory only, and a copy sitting next to the encrypted data
  lets anyone who can read the disk decrypt everything. See
  [First-run setup](/docs/getting-started/first-run) and
  [Master key & encryption](/docs/security/master-key).
- **Backups.** Everything lives in `/var/lib/hezo` — back that one directory up. See
  [Backup & recovery](/docs/deployment/backup-and-recovery).
- **Updates** work as usual: a superuser clicks **Install & restart** in the web app.
  See [Self-hosting → Updating](/docs/deployment/self-hosting#updating).

## Doing it by hand instead

If you'd rather provision an existing server yourself, the same installer runs
standalone:

```sh
curl -fsSL https://raw.githubusercontent.com/hezo-ai/hezo/main/deploy/provision.sh | sudo bash
```

For the fully manual path — your own systemd unit, reverse proxy, and firewall rules,
step by step — see [Self-hosting](/docs/deployment/self-hosting) and
[Deploying to the cloud](/docs/deployment/cloud).
