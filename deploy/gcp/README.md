# Hezo — Google Cloud one-click deploy (Cloud Shell)

This is the **"Open in Cloud Shell"** path for Google Cloud. It clones this repo
into the user's Cloud Shell, opens a guided [tutorial](tutorial.md), and runs
[`deploy.sh`](deploy.sh) — which creates a Compute Engine VM whose startup script
runs the same [`deploy/provision.sh`](../provision.sh) the cloud-init and AWS
paths use (Docker + the `hezo` binary + Caddy automatic HTTPS via `<ip>.sslip.io`
+ systemd + firewall). One source of truth for host setup.

Hezo runs each project's agents in a container on the **host Docker socket**, so
it needs a real VM — **Compute Engine, not Cloud Run** (Cloud Run is a
managed-container service with no host Docker). `deploy.sh` provisions a GCE VM.

Unlike the AWS and DigitalOcean buttons, this one needs **no external hosting**:
Cloud Shell reads the script straight from the public repo, so the button works
as soon as this is on `main`.

## The Open in Cloud Shell button

Markdown for the README:

```md
[![Open in Cloud Shell](https://gstatic.com/cloudssh/images/open-btn.svg)](https://ssh.cloud.google.com/cloudshell/editor?cloudshell_git_repo=https://github.com/hezo-ai/hezo&cloudshell_workspace=deploy/gcp&cloudshell_tutorial=tutorial.md)
```

The URL parameters:

| Param | Value | Purpose |
|---|---|---|
| `cloudshell_git_repo` | `https://github.com/hezo-ai/hezo` | Repo cloned into Cloud Shell. |
| `cloudshell_workspace` | `deploy/gcp` | Working directory the terminal opens in. |
| `cloudshell_tutorial` | `tutorial.md` | Guided walkthrough shown alongside the terminal. |

## What the user does

1. Click the button → Cloud Shell opens with the tutorial.
2. Select a project (billing enabled).
3. Run `bash deploy.sh`.
4. Wait ~2 min, open `https://<instance-ip>.sslip.io`, finish setup.

## Run it by hand

From Cloud Shell or any machine with the `gcloud` CLI authenticated:

```sh
cd deploy/gcp
gcloud config set project <YOUR_PROJECT_ID>
bash deploy.sh
```

Overrides (environment variables, set before running):

| Variable | Default | Notes |
|---|---|---|
| `HEZO_GCP_INSTANCE` | `hezo` | Instance name. |
| `HEZO_GCP_ZONE` | `us-central1-a` | Zone. |
| `HEZO_GCP_MACHINE_TYPE` | `e2-small` | 2 GB runs the install; `e2-medium`+ for real agent work. |
| `HEZO_GCP_DISK_SIZE` | `30GB` | Boot disk (holds Hezo's data directory). |
| `HEZO_DOMAIN_OVERRIDE` | *(empty)* | Custom domain instead of sslip.io (point an A record first). |
| `HEZO_RELEASE_TAG` | `latest` | Pin a release; in-app update upgrades it later. |

## Test before relying on the button

1. `bash deploy.sh` into a throwaway project.
2. Hit `https://<ip>.sslip.io/health` from your laptop — a valid (non-self-signed)
   certificate proves the Let's Encrypt path provisioned against sslip.io on first
   boot (allow ~2 min after the VM is created).
3. Load the root URL, reach the master-key gate, complete the three setup steps.
   The CEO chat's live log stream proves WebSocket passthrough.
4. Confirm the container→host path (agents' tools) is open — SSH in
   (`gcloud compute ssh hezo --zone <ZONE>`) and run:
   ```sh
   docker run --rm --add-host=host.docker.internal:host-gateway curlimages/curl \
     curl -sv --max-time 5 http://host.docker.internal:3100/mcp
   ```
   Any HTTP status (even 401/404) is success; a timeout means the `docker0`
   firewall rule is wrong. See
   [`docs/deployment/self-hosting.md`](../../docs/deployment/self-hosting.md)
   § Networking & firewall.
5. Tear down:
   ```sh
   gcloud compute instances delete hezo --zone <ZONE>
   gcloud compute firewall-rules delete hezo-allow-web
   ```

## A full GCP Marketplace listing (optional, later)

The Cloud Shell button is the zero-friction path. A native **Google Cloud
Marketplace** VM listing (a Deployment Manager / Terraform package published
through the Producer Portal) is the heavier, DO-Marketplace-equivalent option —
it requires an external Google Cloud partner account and Google's review, so it
can't be completed from this repo. The Cloud Shell path needs none of that.
