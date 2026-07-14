# Deploy Hezo to Google Cloud

<walkthrough-tutorial-duration duration="5"></walkthrough-tutorial-duration>

This tutorial launches **Hezo** on a Google Compute Engine VM. Hezo runs each
project's AI agents in a container on the host Docker socket, so it needs a real
VM — this creates one and installs everything on first boot (Docker, the `hezo`
binary, automatic HTTPS via Caddy, systemd, and a locked-down firewall).

Click **Start** to begin.

## Choose a project

Pick the Google Cloud project to deploy into. Billing must be enabled on it.

<walkthrough-project-setup></walkthrough-project-setup>

The script uses your currently selected project. If you want a different one:

```sh
gcloud config set project <YOUR_PROJECT_ID>
```

## Deploy

Run the deploy script. It enables the Compute Engine API, creates a firewall rule
for ports 80/443, and creates a VM named `hezo` whose startup script installs and
starts Hezo:

```sh
bash deploy.sh
```

**Optional tweaks** (set before running `deploy.sh`):

```sh
# A bigger VM for heavier agent work (default is e2-small, 2 GB):
export HEZO_GCP_MACHINE_TYPE=e2-medium
# A different zone:
export HEZO_GCP_ZONE=europe-west1-b
# Your own domain instead of <ip>.sslip.io (point an A record at the VM after):
export HEZO_DOMAIN_OVERRIDE=hezo.example.com
```

When it finishes, the script prints your instance's public IP and the URL to
open.

## Open Hezo and finish setup

First boot takes about **2 minutes** to install everything and obtain the HTTPS
certificate. Then open the URL the script printed:

```
https://<your-instance-ip>.sslip.io
```

Complete the short in-browser setup:

1. **Create your master key** — shown once; store it safely (never on the server).
2. **Set an admin password.**
3. **Connect a model provider.**

That's it — your team is ready.

<walkthrough-conclusion-trophy></walkthrough-conclusion-trophy>

## Managing the VM

SSH in:

```sh
gcloud compute ssh hezo --zone <ZONE>
```

Delete it when you're done:

```sh
gcloud compute instances delete hezo --zone <ZONE>
gcloud compute firewall-rules delete hezo-allow-web
```

Everything Hezo stores lives in `/var/lib/hezo` on the VM — back that directory up.
After a reboot Hezo comes up **locked** by design; unlock it from the browser gate
with your master key.
