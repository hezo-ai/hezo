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
#   1. ensures a swap file exists (default 6 GB) so low-RAM hosts don't get OOM-killed
#   2. installs Docker Engine and starts it (Hezo needs the host Docker socket)
#   3. downloads the arch-matched `hezo` binary from GitHub Releases
#   4. installs Caddy as a reverse proxy with automatic HTTPS + WebSocket passthrough
#   5. installs systemd units (a first-boot unit that derives the public URL, then Hezo)
#   6. exempts Hezo from needrestart's automatic restarts (it comes back locked)
#   7. locks the firewall down (only 80/443 public; 3100 + egress ports stay host-local)
#
# It never sets the master key: that is generated in the browser on first run and
# shown once, so it cannot be pre-seeded. After boot, open the printed URL and
# finish the short setup (create master key, set admin password, connect a model).
#
# Optional environment variables (set in the shell, or seeded into /etc/hezo/deploy.env
# by cloud-init before this script runs — see deploy/cloud-init/hezo.cloud-config.yaml):
#   HEZO_DOMAIN_OVERRIDE   use this domain instead of <public-ip>.sslip.io
#                          (point an A record at the host first; Caddy gets a cert for it)
#   HEZO_DATABASE_URL      managed/external Postgres 14+ connection string
#                          (postgres://user:pass@host:5432/hezo?sslmode=require).
#                          sslmode follows libpq rules: require encrypts without
#                          verifying the certificate; for verified TLS use
#                          sslmode=verify-full, adding &sslrootcert=/etc/hezo/db-ca.crt
#                          when the provider signs with its own CA (most do).
#                          A provisioning-shell input, not a runtime variable: it is
#                          persisted into /etc/hezo/hezo.config.cjs on first provision, and
#                          the server reads it from there. Omit to use the embedded
#                          database on the VM's disk (the default).
#   HEZO_ASSET_STORAGE_URL S3-compatible object storage for asset files
#                          (s3://KEY:SECRET@endpoint/bucket[/prefix]). A provisioning-shell
#                          input, not a runtime variable: persisted into
#                          /etc/hezo/hezo.config.cjs on first provision; omit for local disk.
#   HEZO_DATABASE_POOL_SIZE  connection-pool size for the external database (2-100).
#   HEZO_SWAP_SIZE         size of the swap file this script creates so low-RAM hosts
#                          don't OOM (default 6G; accepts 6G / 6144M). Set 0 to disable.
#                          Auto-shrinks to fit the disk when 6G plus headroom won't fit,
#                          and is skipped when the host already has active swap.
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
CONFIG_FILE="/etc/hezo/hezo.config.cjs"
WEB_URL_FILE="/etc/hezo/web-url"
DEPLOY_ENV="/etc/hezo/deploy.env"
RELEASE_TAG="${HEZO_RELEASE_TAG:-latest}"

# Cloud-init can seed optional settings (managed database / asset storage, domain
# override) into deploy.env before this script runs — pick them up. Explicit shell
# environment still wins over the file.
if [[ -f "${DEPLOY_ENV}" ]]; then
	while IFS='=' read -r key value; do
		[[ "${key}" =~ ^HEZO_[A-Z_]+$ ]] || continue
		if [[ -z "${!key:-}" ]]; then
			export "${key}=${value}"
		fi
	done <"${DEPLOY_ENV}"
fi

log() { echo "[hezo-provision] $*"; }

# ---------------------------------------------------------------------------
# 1a. Migrate a pre-0.50 /etc/hezo/hezo.env
#     Before 0.50 this script wrote an env file and wired it in with
#     EnvironmentFile=. 0.50 reads a config file instead and ignores those
#     variables entirely, so a host upgraded in place would fall back to the
#     built-in defaults - an empty database that looks like a fresh install.
#     Read the old file into this shell so the config file written below carries
#     its settings; the shell environment still wins. The file itself is only
#     renamed aside once the config file exists, so an interrupted run loses
#     nothing.
# ---------------------------------------------------------------------------
LEGACY_ENV="/etc/hezo/hezo.env"
LEGACY_ENV_CARRIED=""
if [[ -f "${LEGACY_ENV}" && ! -f "${CONFIG_FILE}" ]]; then
	while IFS='=' read -r key value; do
		[[ "${key}" =~ ^(HEZO_DATA_DIR|HEZO_WEB_URL|HEZO_DATABASE_URL|HEZO_DATABASE_POOL_SIZE|HEZO_ASSET_STORAGE_URL)$ ]] || continue
		if [[ -z "${!key:-}" ]]; then
			export "${key}=${value}"
			LEGACY_ENV_CARRIED+=" ${key}"
		fi
	done <"${LEGACY_ENV}"
	log "Found ${LEGACY_ENV} from a pre-0.50 install."
	if [[ -n "${LEGACY_ENV_CARRIED}" ]]; then
		log "Carrying into ${CONFIG_FILE}:${LEGACY_ENV_CARRIED}"
	fi
	# The generated config reads its webUrl from the side file hezo-firstboot
	# writes, and firstboot will not re-run here - its sentinel was set the day
	# this host was provisioned. Seed the file from the old variable instead of
	# special-casing the generator, so both paths keep one mechanism.
	if [[ -n "${HEZO_WEB_URL:-}" && ! -s "${WEB_URL_FILE}" ]]; then
		echo "${HEZO_WEB_URL}" >"${WEB_URL_FILE}"
		log "Seeded ${WEB_URL_FILE} with ${HEZO_WEB_URL}"
	fi
fi

# An operator who moved the data dir keeps it. Everything below writes to this path.
DATA_DIR="${HEZO_DATA_DIR:-${DATA_DIR}}"

# ---------------------------------------------------------------------------
# 1. Swap file — give low-RAM hosts a memory cushion so the install itself and
#    the running services (Hezo + agent containers) don't get OOM-killed. The
#    cheapest droplets ship as little as 512 MB RAM with no swap. Written as a
#    standalone helper so the first-boot unit can reuse it: a machine-image
#    build (HEZO_IMAGE_BUILD=1) defers swap creation to the user's first boot so
#    no /swapfile is baked into the snapshot.
# ---------------------------------------------------------------------------
install -d /usr/local/sbin
cat >/usr/local/sbin/hezo-ensure-swap.sh <<'EOF'
#!/usr/bin/env bash
# Idempotently ensure a swap file exists. Safe to run repeatedly and on every
# boot: a no-op when the host already has active swap. Never aborts the caller —
# a host that forbids swapon just logs a warning and exits 0.
#
#   HEZO_SWAP_SIZE  desired size (default 6G; accepts 6G / 6144M / integer MiB).
#                   Set 0/off/none to disable. Auto-shrinks to fit the disk.
set -uo pipefail

SWAPFILE="/swapfile"
HEADROOM_MIB=2048 # keep at least this much free disk beyond the swap file
FLOOR_MIB=512     # don't bother creating swap smaller than this

log() { echo "[hezo-swap] $*"; }

REQUEST="${HEZO_SWAP_SIZE:-6G}"
case "${REQUEST,,}" in
	0 | off | none | no | false | disabled)
		log "swap disabled (HEZO_SWAP_SIZE=${REQUEST})"
		exit 0
		;;
esac

# Already have swap somewhere? Respect it and do nothing.
if [[ -n "$(swapon --show=NAME --noheadings 2>/dev/null)" ]]; then
	log "swap already active; leaving it as-is"
	exit 0
fi

# Parse the requested size to MiB (6G / 6144M / bare integer MiB).
size_to_mib() {
	local v="${1,,}" num unit
	num="${v%[gm]}"
	unit="${v#"${num}"}"
	[[ "${num}" =~ ^[0-9]+$ ]] || {
		echo ""
		return
	}
	case "${unit}" in
		g) echo $((num * 1024)) ;;
		m | "") echo "${num}" ;;
		*) echo "" ;;
	esac
}

want_mib="$(size_to_mib "${REQUEST}")"
if [[ -z "${want_mib}" || "${want_mib}" -lt 1 ]]; then
	log "unrecognised HEZO_SWAP_SIZE='${REQUEST}'; skipping swap setup"
	exit 0
fi

# A leftover /swapfile from a previous run: just switch it on and persist.
if [[ -f "${SWAPFILE}" ]]; then
	if swapon "${SWAPFILE}" 2>/dev/null; then
		grep -q "^${SWAPFILE} " /etc/fstab 2>/dev/null || echo "${SWAPFILE} none swap sw 0 0" >>/etc/fstab
		log "enabled existing ${SWAPFILE}"
	else
		log "could not enable existing ${SWAPFILE}; leaving it in place"
	fi
	exit 0
fi

# Disk headroom guard ("if possible"): never fill the root filesystem.
avail_bytes="$(df --output=avail -B1 / 2>/dev/null | tail -1 | tr -d ' ')"
if [[ "${avail_bytes}" =~ ^[0-9]+$ ]]; then
	avail_mib=$((avail_bytes / 1024 / 1024))
	usable_mib=$((avail_mib - HEADROOM_MIB))
	if ((usable_mib < FLOOR_MIB)); then
		log "only ${avail_mib} MiB free on /; too little for swap after ${HEADROOM_MIB} MiB headroom — skipping"
		exit 0
	fi
	if ((want_mib > usable_mib)); then
		log "shrinking swap from ${want_mib} MiB to ${usable_mib} MiB to fit the disk"
		want_mib="${usable_mib}"
	fi
fi

log "creating ${want_mib} MiB swap at ${SWAPFILE}"
if ! fallocate -l "${want_mib}M" "${SWAPFILE}" 2>/dev/null; then
	if ! dd if=/dev/zero of="${SWAPFILE}" bs=1M count="${want_mib}" status=none 2>/dev/null; then
		log "failed to allocate ${SWAPFILE}; skipping swap setup"
		rm -f "${SWAPFILE}"
		exit 0
	fi
fi
chmod 600 "${SWAPFILE}"
if ! mkswap "${SWAPFILE}" >/dev/null 2>&1; then
	log "mkswap failed; skipping swap setup"
	rm -f "${SWAPFILE}"
	exit 0
fi
grep -q "^${SWAPFILE} " /etc/fstab 2>/dev/null || echo "${SWAPFILE} none swap sw 0 0" >>/etc/fstab
if ! swapon "${SWAPFILE}" 2>/dev/null; then
	log "swapon failed (host may forbid swap); ${SWAPFILE} stays in fstab for next boot"
	exit 0
fi
log "swap is on: $(swapon --show=NAME,SIZE --noheadings | tr '\n' ' ')"
EOF
chmod +x /usr/local/sbin/hezo-ensure-swap.sh

# Create swap now for the direct/cloud-init/AWS/GCP paths, before the memory-heavy
# Docker + Caddy installs. Skipped for machine-image builds (see the heredoc note
# above); the first-boot unit creates it on the end user's real first boot instead.
if [[ "${HEZO_IMAGE_BUILD:-}" != "1" ]]; then
	HEZO_SWAP_SIZE="${HEZO_SWAP_SIZE:-6G}" /usr/local/sbin/hezo-ensure-swap.sh || log "swap setup skipped"
fi

# ---------------------------------------------------------------------------
# 2. Docker Engine
# ---------------------------------------------------------------------------
if ! command -v docker >/dev/null 2>&1; then
	log "Installing Docker Engine…"
	curl -fsSL https://get.docker.com | sh
fi
systemctl enable --now docker
log "Docker is running."

# ---------------------------------------------------------------------------
# 3. Hezo binary
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
# 4. Data dir + environment file (never overwrite an operator-edited env file)
# ---------------------------------------------------------------------------
install -d -m 700 /etc/hezo
install -d -m 755 "${DATA_DIR}"
if [[ ! -f "${CONFIG_FILE}" ]]; then
	# Mode 600: this file can hold database and object-storage credentials.
	install -m 600 /dev/null "${CONFIG_FILE}"
	cat >"${CONFIG_FILE}" <<EOF
// Hezo configuration. Edit and restart: systemctl restart hezo
// Reference: https://hezo.ai/docs/deployment/configuration
//
// Do NOT put your master key in this file. Hezo keeps it in memory only and comes up
// locked after each restart by design; unlock it from the browser gate. A copy of the
// key on disk next to the encrypted data would let anyone who reads this box decrypt
// your vault.
const { existsSync, readFileSync } = require('node:fs');

// Written by hezo-firstboot on first boot (see /usr/local/sbin/hezo-firstboot.sh).
const webUrlFile = '${WEB_URL_FILE}';

module.exports = {
	dataDir: '${DATA_DIR}',
	webUrl: existsSync(webUrlFile) ? readFileSync(webUrlFile, 'utf8').trim() : '',
EOF
	# Managed data hosting (optional): persist the database / asset-storage settings
	# provided at provision time. To wire them into an already-provisioned host, edit
	# this file directly and restart hezo — see
	# docs/deployment/one-click.md § Using managed data hosting.
	if [[ -n "${HEZO_DATABASE_URL:-}" || -n "${HEZO_DATABASE_POOL_SIZE:-}" ]]; then
		{
			echo "	database: {"
			[[ -n "${HEZO_DATABASE_URL:-}" ]] && echo "		url: '${HEZO_DATABASE_URL}',"
			[[ -n "${HEZO_DATABASE_POOL_SIZE:-}" ]] && echo "		poolSize: ${HEZO_DATABASE_POOL_SIZE},"
			echo "	},"
		} >>"${CONFIG_FILE}"
	fi
	if [[ -n "${HEZO_ASSET_STORAGE_URL:-}" ]]; then
		echo "	assetStorage: { url: '${HEZO_ASSET_STORAGE_URL}' }," >>"${CONFIG_FILE}"
	fi
	echo "};" >>"${CONFIG_FILE}"
fi

# Now that the settings live in the config file, take the old one out of the way:
# nothing reads it any more, and leaving it invites a hand-edit that does nothing.
if [[ -n "${LEGACY_ENV_CARRIED}" && -f "${CONFIG_FILE}" && -f "${LEGACY_ENV}" ]]; then
	mv "${LEGACY_ENV}" "${LEGACY_ENV}.migrated"
	log "Renamed ${LEGACY_ENV} to ${LEGACY_ENV}.migrated (no longer read)."
fi

# Persist optional settings the first-boot unit reads (domain override, swap size).
if [[ -n "${HEZO_DOMAIN_OVERRIDE:-}" || -n "${HEZO_SWAP_SIZE:-}" ]]; then
	install -m 600 /dev/null "${DEPLOY_ENV}"
	[[ -n "${HEZO_DOMAIN_OVERRIDE:-}" ]] && echo "HEZO_DOMAIN_OVERRIDE=${HEZO_DOMAIN_OVERRIDE}" >>"${DEPLOY_ENV}"
	[[ -n "${HEZO_SWAP_SIZE:-}" ]] && echo "HEZO_SWAP_SIZE=${HEZO_SWAP_SIZE}" >>"${DEPLOY_ENV}"
fi

# ---------------------------------------------------------------------------
# 5. Caddy (reverse proxy, automatic HTTPS, WebSocket passthrough)
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
# 6. First-boot unit: derive the public URL, wire it into Caddy + Hezo
# ---------------------------------------------------------------------------
cat >/usr/local/sbin/hezo-firstboot.sh <<'EOF'
#!/usr/bin/env bash
# Runs once, before Caddy and Hezo start. Derives the public HTTPS URL from the
# host's public IP (via <ip>.sslip.io) unless HEZO_DOMAIN_OVERRIDE is set, then
# writes it where Caddy (/etc/caddy/hezo.env) and Hezo (/etc/hezo/web-url, read
# by /etc/hezo/hezo.config.cjs) each pick it up.
set -euo pipefail

SENTINEL="/var/lib/hezo/.firstboot-done"
[[ -f "${SENTINEL}" ]] && exit 0

[[ -f /etc/hezo/deploy.env ]] && . /etc/hezo/deploy.env

# Ensure host swap exists before Caddy/Hezo start (no-op if already active). On the
# machine-image path this is where swap first gets created, since provision.sh
# skipped it at build time.
if [[ -x /usr/local/sbin/hezo-ensure-swap.sh ]]; then
	HEZO_SWAP_SIZE="${HEZO_SWAP_SIZE:-}" /usr/local/sbin/hezo-ensure-swap.sh || true
fi

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
# The config file reads this path for `webUrl`; a .cjs object cannot be appended to.
[[ -s /etc/hezo/web-url ]] || echo "https://${DOMAIN}" >/etc/hezo/web-url

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
# 7. Hezo systemd unit (mirrors docs/deployment/self-hosting.md)
# ---------------------------------------------------------------------------
cat >/etc/systemd/system/hezo.service <<'EOF'
[Unit]
Description=Hezo
Requires=docker.service
After=docker.service network-online.target hezo-firstboot.service
Wants=network-online.target

[Service]
Type=simple
ExecStart=/usr/local/bin/hezo --config /etc/hezo/hezo.config.cjs
Restart=always
RestartSec=5
TimeoutStopSec=30

[Install]
WantedBy=multi-user.target
EOF

# ---------------------------------------------------------------------------
# 8. Hold Hezo back from unattended-upgrade restarts
#    Ubuntu runs needrestart from the APT hook in automatic mode, so a security
#    upgrade replacing a library the binary maps (the C library among them)
#    restarts the service with no prompt. Hezo keeps its master key in memory
#    only and comes back locked, so an unattended restart takes agent execution
#    offline until someone unlocks it from the browser gate - minutes if you are
#    awake, hours if it lands overnight. Patches still install on schedule; the
#    restart becomes yours to make when you can unlock it straight after.
#    See docs/deployment/self-hosting.md § Keeping the host patched.
# ---------------------------------------------------------------------------
install -d /etc/needrestart/conf.d
cat >/etc/needrestart/conf.d/hezo.conf <<'EOF'
# Managed by Hezo provision.sh.
# Hezo comes back locked after a restart (its master key lives in memory only),
# so an unattended restart takes agent execution offline until an operator
# unlocks it. needrestart still reports Hezo as needing a restart - check with
# `needrestart -b -r l` - it just must never perform one on its own.
$nrconf{override_rc} = { qr(^hezo\.service$) => 0 };
EOF

# ---------------------------------------------------------------------------
# 9. Firewall — only 80/443 public; keep 3100 and the egress range host-local,
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
# 10. Enable (and, outside image builds, start) everything
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
	log "  cat /etc/hezo/hezo.config.cjs    # webUrl comes from /etc/hezo/web-url"
fi
