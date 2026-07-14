#!/usr/bin/env bash
#
# deploy.sh — create a Google Compute Engine VM that runs Hezo.
#
# It provisions a real VM (Hezo runs each project's agents in a container on the
# host Docker socket, so it needs one) and sets provision.sh as the startup
# script — the SAME installer the cloud-init and AWS paths use (Docker + the hezo
# binary + Caddy automatic HTTPS via <ip>.sslip.io + systemd + firewall).
#
# Meant to be run from Google Cloud Shell (see this dir's README for the
# "Open in Cloud Shell" button), or locally with the gcloud CLI installed.
#
# Everything is overridable by environment variable:
#   HEZO_GCP_INSTANCE      instance name           (default: hezo)
#   HEZO_GCP_ZONE          zone                     (default: us-central1-a)
#   HEZO_GCP_MACHINE_TYPE  machine type             (default: e2-small = 2 GB)
#   HEZO_GCP_DISK_SIZE     boot disk size           (default: 30GB)
#   HEZO_DOMAIN_OVERRIDE   custom domain (A record) (default: use <ip>.sslip.io)
#   HEZO_RELEASE_TAG       hezo release to install  (default: latest)
#   HEZO_PROVISION_URL     installer URL            (default: main branch)

set -euo pipefail

INSTANCE="${HEZO_GCP_INSTANCE:-hezo}"
ZONE="${HEZO_GCP_ZONE:-us-central1-a}"
MACHINE_TYPE="${HEZO_GCP_MACHINE_TYPE:-e2-small}"
DISK_SIZE="${HEZO_GCP_DISK_SIZE:-30GB}"
DOMAIN_OVERRIDE="${HEZO_DOMAIN_OVERRIDE:-}"
RELEASE_TAG="${HEZO_RELEASE_TAG:-latest}"
PROVISION_URL="${HEZO_PROVISION_URL:-https://raw.githubusercontent.com/hezo-ai/hezo/main/deploy/provision.sh}"
NETWORK_TAG="hezo"

log() { echo "[hezo-gcp] $*"; }

PROJECT="$(gcloud config get-value project 2>/dev/null || true)"
if [[ -z "${PROJECT}" || "${PROJECT}" == "(unset)" ]]; then
	echo "No active gcloud project. Set one first:" >&2
	echo "  gcloud config set project YOUR_PROJECT_ID" >&2
	exit 1
fi
log "Project: ${PROJECT}   Zone: ${ZONE}   Machine: ${MACHINE_TYPE}"

# The Compute Engine API must be enabled; enabling is idempotent.
log "Ensuring the Compute Engine API is enabled…"
gcloud services enable compute.googleapis.com --project="${PROJECT}" >/dev/null

# Build the VM startup script (runs as root on first boot). Kept minimal — it just
# fetches and runs the canonical installer, optionally with a custom domain.
STARTUP="$(mktemp)"
trap 'rm -f "${STARTUP}"' EXIT
{
	echo '#!/usr/bin/env bash'
	echo 'set -eux'
	echo 'export DEBIAN_FRONTEND=noninteractive'
	if [[ -n "${DOMAIN_OVERRIDE}" ]]; then
		echo "echo 'HEZO_DOMAIN_OVERRIDE=${DOMAIN_OVERRIDE}' >> /etc/environment"
	fi
	echo "echo 'HEZO_RELEASE_TAG=${RELEASE_TAG}' >> /etc/environment"
	echo "curl -fsSL '${PROVISION_URL}' -o /root/hezo-provision.sh"
	echo 'set -a; [ -f /etc/environment ] && . /etc/environment; set +a'
	echo 'bash /root/hezo-provision.sh'
} >"${STARTUP}"

# Firewall: allow 80/443 to instances tagged `hezo`. Idempotent.
if ! gcloud compute firewall-rules describe hezo-allow-web --project="${PROJECT}" >/dev/null 2>&1; then
	log "Creating firewall rule hezo-allow-web (tcp:80,443)…"
	gcloud compute firewall-rules create hezo-allow-web \
		--project="${PROJECT}" \
		--direction=INGRESS \
		--action=ALLOW \
		--rules=tcp:80,tcp:443 \
		--source-ranges=0.0.0.0/0 \
		--target-tags="${NETWORK_TAG}" \
		--description="Hezo web app (HTTP/HTTPS)"
else
	log "Firewall rule hezo-allow-web already exists."
fi

log "Creating instance ${INSTANCE}…"
gcloud compute instances create "${INSTANCE}" \
	--project="${PROJECT}" \
	--zone="${ZONE}" \
	--machine-type="${MACHINE_TYPE}" \
	--image-family=ubuntu-2404-lts-amd64 \
	--image-project=ubuntu-os-cloud \
	--boot-disk-size="${DISK_SIZE}" \
	--boot-disk-type=pd-balanced \
	--tags="${NETWORK_TAG}" \
	--metadata-from-file=startup-script="${STARTUP}"

IP="$(gcloud compute instances describe "${INSTANCE}" \
	--project="${PROJECT}" --zone="${ZONE}" \
	--format='get(networkInterfaces[0].accessConfigs[0].natIP)')"

echo
if [[ -n "${DOMAIN_OVERRIDE}" ]]; then
	log "Instance up. Point ${DOMAIN_OVERRIDE} (A record) at ${IP}, then open:"
	log "  https://${DOMAIN_OVERRIDE}"
else
	log "Instance up. In ~2 minutes (first boot installs everything) open:"
	log "  https://${IP}.sslip.io"
fi
log "Then finish the in-browser setup: master key, admin password, connect a model."
log "SSH in with:  gcloud compute ssh ${INSTANCE} --zone ${ZONE}"
