---
title: One-click deploy
order: 25.5
section: Deployment
---

# One-click deploy

The fastest way to get a public, always-on Hezo running is to let your VPS
provider provision it for you. You paste one snippet when you create the server,
wait a couple of minutes, and open a working HTTPS URL - then finish the short
[first-run setup](/docs/getting-started/first-run) in your browser.

This works on any provider that runs Ubuntu and accepts **cloud-init user data**,
which is all of the common ones: DigitalOcean, Hetzner, Vultr, Linode, and AWS
Lightsail.

Hezo runs each project's agents in a container on the host's Docker, so it needs a
**real VM** - not a managed-container service like Render, Railway, or Cloud Run.
The buttons and snippet below all provision a VM for you.

## One-click provider buttons

For **Google Cloud** and **AWS** there's a purpose-built button that runs the whole
deploy for you - click it, answer a couple of prompts, and you land at the setup
screen.

[![Deploy on Google Cloud](https://img.shields.io/badge/Deploy_on-Google_Cloud-4285F4?style=for-the-badge&logo=googlecloud&logoColor=white)](https://ssh.cloud.google.com/cloudshell/editor?cloudshell_git_repo=https://github.com/hezo-ai/hezo&cloudshell_workspace=deploy/gcp&cloudshell_tutorial=tutorial.md)
[![Deploy on AWS](https://img.shields.io/badge/Deploy_on-AWS-FF9900?style=for-the-badge&logo=amazonwebservices&logoColor=white)](https://console.aws.amazon.com/cloudformation/home?region=us-east-1#/stacks/create/review?templateURL=https://hezo-deploy.s3.us-east-1.amazonaws.com/hezo.cfn.yaml&stackName=hezo)

- **Google Cloud** opens **Cloud Shell** and runs the deploy against a fresh
  Compute Engine VM - no local tooling needed. Details:
  [Cloud Shell deploy guide](https://github.com/hezo-ai/hezo/blob/main/deploy/gcp/README.md).
- **AWS** opens a CloudFormation **Launch Stack** that creates an EC2 instance -
  pick an instance size, then **Create stack**. Details:
  [AWS deploy guide](https://github.com/hezo-ai/hezo/blob/main/deploy/aws/README.md).
- **DigitalOcean** - a Marketplace 1-Click Droplet is in the works; until it's
  listed, use the [cloud-init snippet](#deploy-it) below (paste it into the
  Droplet's user-data field).

Every other provider - Hetzner, Vultr, Linode, AWS Lightsail, or any Ubuntu VM -
uses the portable [cloud-init snippet](#deploy-it) below.

## What it sets up

On first boot the snippet:

- creates a **6 GB swap file** so a low-RAM server doesn't get OOM-killed while
  installing and running (auto-shrunk to fit the disk, and skipped if the box already
  has swap - size it with `HEZO_SWAP_SIZE`, or set `0` to disable),
- installs **Docker** and starts it (Hezo runs each project's agents in a container),
- downloads the latest **`hezo`** binary for the server's CPU architecture,
- puts **Caddy** in front for **automatic HTTPS** with a real certificate - no domain
  required (see [How the HTTPS URL works](#how-the-https-url-works)),
- runs Hezo under **systemd** so it restarts on boot and after a crash,
- exempts Hezo from the automatic service restarts that follow an **unattended
  security upgrade**, so a background patch never leaves it sitting locked (see
  [Keeping the host patched](/docs/deployment/self-hosting#keeping-the-host-patched)), and
- locks the **firewall** down so only the web ports (80/443) are public.

It deliberately does **not** set your master key - that's generated in your browser
on first run and shown once, so it can't be pre-filled. The deploy gets you to the
setup screen; you take it from there.

## Deploy it

1. **Create an Ubuntu server** on your provider - 2 GB RAM or more is a good start.
   The deploy also adds a 6 GB swap file, so it still comes up on a smaller box.
2. **Paste the snippet below** into the provider's user-data field (each provider
   calls it something slightly different - see [Where to paste it](#where-to-paste-it)).
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
  # To change the swap size (default 6G; set 0 to disable), uncomment and edit this
  # before the curl line runs:
  # - [ sh, -c, "echo 'HEZO_SWAP_SIZE=2G' >> /etc/environment" ]
  # To use your own domain instead of sslip.io, point an A record at this server, then
  # uncomment the next line and set your domain (do it before the curl line runs):
  # - [ sh, -c, "echo 'HEZO_DOMAIN_OVERRIDE=hezo.example.com' >> /etc/environment" ]
  # To use a managed database and/or object storage for assets, seed the URLs into
  # /etc/hezo/deploy.env (root-only, mode 600 - not /etc/environment: they carry credentials).
  # provision.sh persists them into the service's env file. sslmode=require encrypts
  # without verifying the certificate; for verified TLS use sslmode=verify-full plus
  # &sslrootcert=/etc/hezo/db-ca.crt when the provider signs with its own CA (most do).
  # - [ sh, -c, "install -d -m 700 /etc/hezo && install -m 600 /dev/null /etc/hezo/deploy.env" ]
  # - [ sh, -c, "echo 'HEZO_DATABASE_URL=postgres://hezo:PASSWORD@db-host:5432/hezo?sslmode=require' >> /etc/hezo/deploy.env" ]
  # - [ sh, -c, "echo 'HEZO_ASSET_STORAGE_URL=s3://ACCESS_KEY:SECRET@endpoint/bucket' >> /etc/hezo/deploy.env" ]
  - [ sh, -c, "curl -fsSL https://raw.githubusercontent.com/hezo-ai/hezo/main/deploy/provision.sh -o /root/hezo-provision.sh" ]
  - [ sh, -c, "set -a; [ -f /etc/environment ] && . /etc/environment; set +a; bash /root/hezo-provision.sh" ]
```

The same file lives in the repo at
[`deploy/cloud-init/hezo.cloud-config.yaml`](https://github.com/hezo-ai/hezo/blob/main/deploy/cloud-init/hezo.cloud-config.yaml),
and the installer it runs is
[`deploy/provision.sh`](https://github.com/hezo-ai/hezo/blob/main/deploy/provision.sh) -
read them before you paste if you'd like to see exactly what runs.

### Where to paste it

| Provider | Field, on the create-server page |
|---|---|
| DigitalOcean | **Advanced options → Add Initialization scripts (user data)** |
| Hetzner Cloud | **Cloud config** |
| Vultr | **Additional Features → Enable Cloud-Init User-Data** |
| Linode | **Add User Data** |
| AWS Lightsail | **Add launch script** - and also open ports **80** and **443** in the Lightsail firewall (its console firewall is separate from the server's) |

## Using managed data hosting

By default the deploy keeps everything on the server's own disk: the embedded database
and asset files both live under `/var/lib/hezo`. That's a fine place to start - but you
can just as well point Hezo at a **managed Postgres** for the database and an
**S3-compatible bucket** for assets, so your provider handles database backups and
storage durability and the server itself holds little worth losing. Each one is a single
URL setting, and you can adopt either independently - managed database with local
assets, or the other way around.

### 1. Provision the database

Create a managed **PostgreSQL 14 or newer** instance (Hezo checks the version at
startup), plus a database and user for Hezo, and assemble the connection string:

```
postgres://hezo:PASSWORD@db-host:5432/hezo?sslmode=require
```

- **Same region as the server** - Hezo's scheduling polls every 1-5 seconds, so keep
  round-trip latency low. Same-VPC/private networking is ideal.
- **Any connection mode works** - direct, session-pooled, or transaction-pooled.
- **Use TLS** - `sslmode=require` encrypts the connection but does not verify the
  server's certificate. For verified TLS use `sslmode=verify-full`, adding
  `&sslrootcert=/etc/hezo/db-ca.crt` if your provider signs with its own CA (most do).

Full requirements: [Configuration → Using an external
Postgres](/docs/deployment/configuration#using-an-external-postgres).

### 2. Provision the bucket

Create a **private** bucket on any S3-compatible store (AWS S3, Cloudflare R2,
DigitalOcean Spaces, Backblaze B2, MinIO, …) and an access key for it, then assemble
the storage URL:

```
s3://ACCESS_KEY:SECRET@endpoint/bucket[/prefix]
```

The bucket never needs to be publicly readable - Hezo serves asset bytes through signed
URLs. Percent-encode any `/`, `+`, or `@` inside the key or secret. Full URL grammar
(`region`, `pathStyle`, `tls`): [Configuration → Storing assets in S3-compatible object
storage](/docs/deployment/configuration#storing-assets-in-s3-compatible-object-storage).

### 3. Wire it into the deploy

**At provision time** - uncomment the `/etc/hezo/deploy.env` lines in the
[snippet above](#deploy-it) and fill in your URLs before you paste it. The installer
persists them into `/etc/hezo/hezo.config.cjs` and Hezo uses the managed backends
from its very first boot. One caveat: on most providers, anything in the user-data
field stays readable later via the instance's metadata service - if you'd rather keep
the credentials out of user data entirely, deploy without them and use the post-boot
path instead.

**Post-boot, or on an existing server** - the same two settings go into
`/etc/hezo/hezo.config.cjs` (root-only, mode 600 - the file the systemd unit reads). SSH in
and:

```sh
sudo $EDITOR /etc/hezo/hezo.config.cjs
# add, inside module.exports:
#   database: { url: 'postgres://hezo:PASSWORD@db-host:5432/hezo?sslmode=require' },
#   assetStorage: { url: 's3://ACCESS_KEY:SECRET@endpoint/bucket' },
sudo systemctl restart hezo
```

> **Already have data on the server?** Adding these settings points Hezo at the new
> backends but does not move existing rows or files. Move them first with
> `hezo backup` / `hezo restore` - see [Configuration → Switching an existing
> instance](/docs/deployment/configuration#switching-an-existing-instance).

### 4. Verify

Hezo checks both backends at startup and **fails fast with guidance** if something's
off - an unreachable bucket, bad credentials, or a Postgres older than 14 stop the
server rather than silently falling back. Check:

```sh
sudo journalctl -u hezo | grep -Ei 'postgres|asset storage'
```

You should see `Using external Postgres at …` and `Asset storage: S3-compatible (…)`.
In the web app, **Settings → Storage** shows the active **Database** and **Asset
storage** backends with credentials occluded.

### DigitalOcean: Managed Postgres + Spaces

The concrete version for a DigitalOcean Droplet deployed with the snippet above:

1. **Database:** create a [Managed PostgreSQL](https://www.digitalocean.com/products/managed-databases)
   cluster in the **same region** as the Droplet. On the cluster's overview, pick the
   **direct connection** details (host, port `25060`, user, password, database), or a
   **connection pool** in either mode. Your URL looks like:

   ```
   postgres://doadmin:PASSWORD@db-postgresql-fra1-12345-do-user-0.db.ondigitalocean.com:25060/defaultdb?sslmode=require
   ```

   DigitalOcean signs cluster certificates with its own CA, so `sslmode=require`
   encrypts without verifying them. For verified TLS, download the cluster's CA from
   **Connection details → Download CA certificate**, put it on the Droplet, and extend
   the URL:

   ```sh
   sudo install -m 644 ca-certificate.crt /etc/hezo/db-ca.crt
   # ...?sslmode=verify-full&sslrootcert=/etc/hezo/db-ca.crt
   ```

2. **Assets:** create a [Spaces](https://www.digitalocean.com/products/spaces) bucket
   (keep it private) and a Spaces access key, then:

   ```
   s3://SPACES_KEY:SPACES_SECRET@fra1.digitaloceanspaces.com/my-hezo-assets?region=fra1
   ```

3. Wire both in via the snippet or post-boot as above.

### Serverless Postgres (Neon, Supabase, …)

Serverless Postgres providers work too. The rule that matters is to keep the database in
the **same region** as your server; any endpoint they offer will work, pooled or direct.

## How the HTTPS URL works

HTTPS is essential for a working instance - OAuth-connected MCP servers only complete
their connect flow on an HTTPS address, installing Hezo on your phone needs a secure
context, and the web app streams agent activity over a secure WebSocket. But a fresh
server has a public IP and usually no domain. To bridge that, the deploy uses
**[sslip.io](https://sslip.io)** - a DNS service where `<ip>.sslip.io` always resolves
to `<ip>`. So `https://203.0.113.10.sslip.io` points straight at your server, and Caddy
automatically obtains a real Let's Encrypt certificate for it. No domain to buy, no DNS
to configure, and no browser warnings.

**Prefer your own domain?** Point an A record at the server's IP, then set
`HEZO_DOMAIN_OVERRIDE` (uncomment the line in the snippet above). Caddy provisions a
certificate for that name instead.

## After it's up

- **The master key locks the *instance*.** After a restart, Hezo comes up **locked**
  until you provide the twelve words again on the browser gate - that locked-on-restart
  behaviour is by design, and unlocking from the browser is the secure way to bring it
  back up. (In-app **update** restarts are the exception: the unlock key is handed to
  the new process in memory, so an update doesn't re-lock.) **Don't save your master key
  to a file on the server** (an env file, the systemd unit, anywhere on disk): it's the
  one secret Hezo keeps in memory only, and a copy sitting next to the encrypted data
  lets anyone who can read the disk decrypt everything. See
  [First-run setup](/docs/getting-started/first-run) and
  [Master key & encryption](/docs/security/master-key).
- **Backups.** Everything lives in `/var/lib/hezo` - back that one directory up. See
  [Backup & recovery](/docs/deployment/backup-and-recovery). With
  [managed data hosting](#using-managed-data-hosting) your provider covers database
  backups and asset durability, but `/var/lib/hezo` still holds workspaces and keys -
  keep backing it up.
- **Updates** work as usual: a superuser clicks **Install & restart** in the web app.
  See [Self-hosting → Updating](/docs/deployment/self-hosting#updating).

## Doing it by hand instead

If you'd rather provision an existing server yourself, the same installer runs
standalone:

```sh
curl -fsSL https://raw.githubusercontent.com/hezo-ai/hezo/main/deploy/provision.sh | sudo bash
```

For the fully manual path - your own systemd unit, reverse proxy, and firewall rules,
step by step - see [Self-hosting](/docs/deployment/self-hosting) and
[Deploying to the cloud](/docs/deployment/cloud).
