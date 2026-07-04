#!/usr/bin/env bash
#
# provision.sh — one-shot installer that turns a fresh Ubuntu host into a
# running, HTTPS-reachable Hezo instance.
#
# It is the single source of truth for the one-click / cloud-init deploy:
#   • the portable cloud-config (deploy/cloud-init/hezo.cloud-config.yaml) runs it
#   • the DigitalOcean Marketplace image (deploy/marketplace/digitalocean) bakes it in
#   • you can also just SSH into a box and run it by hand
#
# What it does, idempotently:
#   1. installs Docker Engine and starts it (Hezo needs the host Docker socket)
#   2. downloads the arch-matched `hezo` binary from GitHub Releases
#   3. installs Caddy as a reverse proxy with automatic HTTPS + WebSocket passthrough
#   4. installs systemd units (a first-boot unit that derives the public URL, then Hezo)
#   5. locks the firewall down (only 80/443 public; 3100 + egress ports stay host-local)
#
# It never sets the master key: that is generated in the browser on first run and
# shown once, so it cannot be pre-seeded. After boot, open the printed URL and
# finish the short setup (create master key, set admin password, connect a model).
#
# Optional environment variables:
#   HEZO_DOMAIN_OVERRIDE   use this domain instead of <public-ip>.sslip.io
#                          (point an A record at the host first; Caddy gets a cert for it)
#   HEZO_RELEASE_TAG       pin a release tag (default: latest)
#   HEZO_IMAGE_BUILD       set to 1 when baking a machine image (e.g. the DigitalOcean
#                          Marketplace Packer build). Installs and enables everything but
#                          does NOT start the services or derive the public URL — that is
#                          deferred to the end user's first boot, so no build-VM URL or
#                          first-boot sentinel is baked into the snapshot.

set -euo pipefail

if [[ "${EUID}" -ne 0 ]]; then
	echo "provision.sh must run as root (it installs packages and system services)." >&2
	exit 1
fi

DATA_DIR="/var/lib/hezo"
ENV_FILE="/etc/hezo/hezo.env"
DEPLOY_ENV="/etc/hezo/deploy.env"
RELEASE_TAG="${HEZO_RELEASE_TAG:-latest}"

log() { echo "[hezo-provision] $*"; }

# ---------------------------------------------------------------------------
# 1. Docker Engine
# ---------------------------------------------------------------------------
if ! command -v docker >/dev/null 2>&1; then
	log "Installing Docker Engine…"
	curl -fsSL https://get.docker.com | sh
fi
systemctl enable --now docker
log "Docker is running."

# ---------------------------------------------------------------------------
# 2. Hezo binary
# ---------------------------------------------------------------------------
case "$(uname -m)" in
	x86_64) ARCH="x64" ;;
	aarch64 | arm64) ARCH="arm64" ;;
	*)
		echo "Unsupported architecture: $(uname -m). Hezo ships linux-x64 and linux-arm64." >&2
		exit 1
		;;
esac

if [[ "${RELEASE_TAG}" == "latest" ]]; then
	BINARY_URL="https://github.com/hezo-ai/hezo/releases/latest/download/hezo-linux-${ARCH}"
else
	BINARY_URL="https://github.com/hezo-ai/hezo/releases/download/${RELEASE_TAG}/hezo-linux-${ARCH}"
fi

log "Downloading hezo (${ARCH}) from ${BINARY_URL}"
curl -fsSL -o /usr/local/bin/hezo "${BINARY_URL}"
chmod +x /usr/local/bin/hezo

# ---------------------------------------------------------------------------
# 3. Data dir + environment file (never overwrite an operator-edited env file)
# ---------------------------------------------------------------------------
install -d -m 700 /etc/hezo
install -d -m 755 "${DATA_DIR}"
if [[ ! -f "${ENV_FILE}" ]]; then
	install -m 600 /dev/null "${ENV_FILE}"
	cat >"${ENV_FILE}" <<EOF
HEZO_DATA_DIR=${DATA_DIR}
# HEZO_WEB_URL is written by hezo-firstboot on first boot (see /usr/local/sbin/hezo-firstboot.sh).
# After first-run setup you may add your 12-word master key here so reboots unlock unattended:
# HEZO_MASTER_KEY=word1 word2 ... word12
EOF
fi

# Persist the optional domain override so the first-boot unit can read it.
if [[ -n "${HEZO_DOMAIN_OVERRIDE:-}" ]]; then
	install -m 600 /dev/null "${DEPLOY_ENV}"
	echo "HEZO_DOMAIN_OVERRIDE=${HEZO_DOMAIN_OVERRIDE}" >"${DEPLOY_ENV}"
fi

# ---------------------------------------------------------------------------
# 4. Caddy (reverse proxy, automatic HTTPS, WebSocket passthrough)
# ---------------------------------------------------------------------------
if ! command -v caddy >/dev/null 2>&1; then
	log "Installing Caddy…"
	apt-get update -y
	apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl
	curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' |
		gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
	curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' |
		tee /etc/apt/sources.list.d/caddy-stable.list >/dev/null
	apt-get update -y
	apt-get install -y caddy
fi

# The site address is provided at runtime by hezo-firstboot via /etc/caddy/hezo.env.
cat >/etc/caddy/Caddyfile <<'EOF'
# Managed by Hezo provision.sh — the site address comes from HEZO_SITE_ADDRESS
# (written to /etc/caddy/hezo.env by hezo-firstboot). Caddy provisions a
# Let's Encrypt certificate for it automatically and passes WebSocket upgrades
# (Hezo's /ws stream) straight through.
{$HEZO_SITE_ADDRESS} {
	reverse_proxy 127.0.0.1:3100
}
EOF

# Feed HEZO_SITE_ADDRESS into Caddy's process and order it after first-boot.
install -d /etc/systemd/system/caddy.service.d
cat >/etc/systemd/system/caddy.service.d/hezo.conf <<'EOF'
[Unit]
After=hezo-firstboot.service
Wants=hezo-firstboot.service

[Service]
EnvironmentFile=/etc/caddy/hezo.env
EOF
# Placeholder so caddy's EnvironmentFile exists before first-boot writes the real value.
[[ -f /etc/caddy/hezo.env ]] || echo 'HEZO_SITE_ADDRESS=:80' >/etc/caddy/hezo.env

# ---------------------------------------------------------------------------
# 5. First-boot unit: derive the public URL, wire it into Caddy + Hezo
# ---------------------------------------------------------------------------
cat >/usr/local/sbin/hezo-firstboot.sh <<'EOF'
#!/usr/bin/env bash
# Runs once, before Caddy and Hezo start. Derives the public HTTPS URL from the
# host's public IP (via <ip>.sslip.io) unless HEZO_DOMAIN_OVERRIDE is set, then
# writes it where Caddy and Hezo read it.
set -euo pipefail

SENTINEL="/var/lib/hezo/.firstboot-done"
[[ -f "${SENTINEL}" ]] && exit 0

[[ -f /etc/hezo/deploy.env ]] && . /etc/hezo/deploy.env

if [[ -n "${HEZO_DOMAIN_OVERRIDE:-}" ]]; then
	DOMAIN="${HEZO_DOMAIN_OVERRIDE}"
else
	# DigitalOcean metadata first (exact public IP), then a provider-agnostic fallback.
	IP="$(curl -fsS --max-time 5 http://169.254.169.254/metadata/v1/interfaces/public/0/ipv4/address 2>/dev/null || true)"
	[[ -z "${IP}" ]] && IP="$(curl -fsS --max-time 5 https://api.ipify.org 2>/dev/null || true)"
	if [[ -z "${IP}" ]]; then
		echo "hezo-firstboot: could not determine public IP; leaving Caddy on :80" >&2
		exit 0
	fi
	DOMAIN="${IP}.sslip.io"
fi

echo "HEZO_SITE_ADDRESS=${DOMAIN}" >/etc/caddy/hezo.env
grep -q '^HEZO_WEB_URL=' /etc/hezo/hezo.env || echo "HEZO_WEB_URL=https://${DOMAIN}" >>/etc/hezo/hezo.env

install -d /var/lib/hezo
touch "${SENTINEL}"
echo "hezo-firstboot: public URL is https://${DOMAIN}"
EOF
chmod +x /usr/local/sbin/hezo-firstboot.sh

cat >/etc/systemd/system/hezo-firstboot.service <<'EOF'
[Unit]
Description=Hezo first-boot URL setup
After=network-online.target
Wants=network-online.target
Before=caddy.service hezo.service
ConditionPathExists=!/var/lib/hezo/.firstboot-done

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/usr/local/sbin/hezo-firstboot.sh

[Install]
WantedBy=multi-user.target
EOF

# ---------------------------------------------------------------------------
# 6. Hezo systemd unit (mirrors docs/deployment/self-hosting.md)
# ---------------------------------------------------------------------------
cat >/etc/systemd/system/hezo.service <<'EOF'
[Unit]
Description=Hezo
Requires=docker.service
After=docker.service network-online.target hezo-firstboot.service
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
EOF

# ---------------------------------------------------------------------------
# 7. Firewall — only 80/443 public; keep 3100 and the egress range host-local,
#    but let the Docker bridge reach the host (agents call back over docker0).
#    See docs/deployment/self-hosting.md § Networking & firewall.
# ---------------------------------------------------------------------------
if command -v ufw >/dev/null 2>&1; then
	ufw --force reset >/dev/null 2>&1 || true
	ufw default deny incoming
	ufw default allow outgoing
	ufw allow OpenSSH
	ufw allow 80/tcp
	ufw allow 443/tcp
	ufw allow in on docker0
	ufw --force enable
fi

# ---------------------------------------------------------------------------
# 8. Enable (and, outside image builds, start) everything
# ---------------------------------------------------------------------------
systemctl daemon-reload

if [[ "${HEZO_IMAGE_BUILD:-}" == "1" ]]; then
	# Machine-image build: enable units for boot but do not start them, and do not
	# derive a URL. The end user's first boot runs hezo-firstboot (its sentinel is
	# absent, so it fires) which sets the real <ip>.sslip.io address, then Caddy and
	# Hezo start. Guard against a baked sentinel/URL just in case.
	rm -f /var/lib/hezo/.firstboot-done
	systemctl enable hezo-firstboot.service caddy hezo
	log "Image build: services enabled for first boot (not started). URL is derived on the user's first boot."
else
	systemctl enable --now hezo-firstboot.service
	systemctl enable --now caddy
	# Re-run Caddy now that the real site address exists.
	systemctl restart caddy
	systemctl enable --now hezo
	log "Done. Once DNS + certificate settle (a few seconds), open the URL from:"
	log "  cat /etc/hezo/hezo.env    # HEZO_WEB_URL=https://<host>.sslip.io"
fi
