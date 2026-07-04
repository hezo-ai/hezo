# Hezo — DigitalOcean Marketplace 1-Click image

This builds the DigitalOcean Marketplace **Droplet 1-Click** image — the literal
"Create Hezo Droplet" button. It bakes Hezo into an Ubuntu snapshot using the same
[`deploy/provision.sh`](../../provision.sh) the cloud-init path runs, so there is one
source of truth for how a host is set up.

The end-user experience: click **Create Hezo Droplet** → wait for first boot → open
`https://<droplet-ip>.sslip.io` → finish the short setup (master key, admin password,
model). Identical to the [cloud-init path](../../../docs/deployment/one-click.md), just
with the software pre-baked so first boot is fast.

## What's code (here) vs. external ops

| Step | Where |
|---|---|
| Packer template + build-time provisioning (`hezo.pkr.hcl`, reusing `provision.sh`) | **This repo** |
| DigitalOcean vendor account + Vendor Portal access | **External** — request at <https://marketplace.digitalocean.com/vendors> |
| Running the build (needs a real `DIGITALOCEAN_TOKEN`; creates a snapshot in your DO account) | **External** — you run `packer build` |
| Listing metadata, screenshots, category, pricing, first-boot instructions | **External** — Vendor Portal |
| DO's automated `img-check` + manual review + publication | **External** — DO-side, on their timeline |

You cannot complete the submission from this repo — it requires a DO vendor account and
DO's review. Everything needed to *produce a valid, submittable image* is here.

## How it works

`provision.sh` runs with `HEZO_IMAGE_BUILD=1` (see its header). In that mode it installs
Docker, the `hezo` binary, Caddy, the systemd units, and the firewall, and **enables** the
services — but does **not** start them or derive a URL. That is deliberate: the build VM's
IP must not be baked in. On the end user's first boot, `hezo-firstboot` (its sentinel is
absent) derives `https://<their-ip>.sslip.io`, then Caddy and Hezo start.

After provisioning, the template fetches and runs DigitalOcean's own
[`90-cleanup.sh`](https://github.com/digitalocean/marketplace-partners/blob/master/scripts/90-cleanup.sh)
(removes SSH host keys, `authorized_keys`, logs, bash history; zero-fills free space) and
[`99-img-check.sh`](https://github.com/digitalocean/marketplace-partners/blob/master/scripts/99-img-check.sh)
(validates the image against Marketplace requirements). They are fetched at build time so
you always run DO's current, unmodified checks — pin `do_marketplace_ref` to a commit SHA
for a reproducible build.

## Prerequisites

- [Packer](https://developer.hashicorp.com/packer/install) ≥ 1.9.
- A DigitalOcean API token with **write** scope:
  ```sh
  export DIGITALOCEAN_TOKEN=dop_v1_...
  ```

## Build

```sh
cd deploy/marketplace/digitalocean
packer init hezo.pkr.hcl        # installs the digitalocean plugin
packer build hezo.pkr.hcl       # builds + validates; produces a snapshot in your account
```

Useful overrides (`-var`):

- `hezo_release_tag=1.2.3` — bake a specific release instead of `latest`.
- `do_marketplace_ref=<sha>` — pin DO's validators for reproducibility (recommended).
- `region=`, `base_image=`, `size=` — build droplet location / base / size.

A green build means `img-check` passed and a snapshot named `hezo-<timestamp>` now exists
in your DO account. A failing `img-check` fails the build on purpose — fix the reported
item and rebuild before submitting.

## Test the snapshot before submitting

1. Create a small droplet **from the snapshot** (Create → Snapshots → `hezo-<timestamp>`).
2. From your laptop, hit `https://<droplet-ip>.sslip.io/health` — a valid (non-self-signed)
   certificate proves the Let's Encrypt path provisioned against sslip.io on first boot.
3. Load the root URL and confirm you reach the master-key gate; complete the three setup
   steps. The CEO chat's live log stream proves the WebSocket passthrough works.
4. Confirm the container→host path (agents' tools) is open:
   ```sh
   docker run --rm --add-host=host.docker.internal:host-gateway curlimages/curl \
     curl -sv --max-time 5 http://host.docker.internal:3100/mcp
   ```
   Any HTTP status (even 401/404) is success; a timeout means the `docker0` firewall rule
   is wrong. See [`docs/deployment/self-hosting.md`](../../../docs/deployment/self-hosting.md)
   § Networking & firewall.
5. Destroy the test droplet.

## Submit

In the [Vendor Portal](https://cloud.digitalocean.com/vendorportal): create the 1-Click
app, attach the snapshot, and fill the listing (description, logo, category, pricing).
For the **first-boot instructions**, tell users to open `https://<droplet-ip>.sslip.io`
and complete setup. DO then runs its own validation and manual review before publishing.

DO may ask for standard Marketplace niceties not needed for a working image — e.g. a
first-login MOTD describing the app. Add those iteratively during review; keep
`provision.sh` as the single source of truth for the actual host setup.
