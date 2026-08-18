# Hezo on xCloud

[xCloud](https://xcloud.host/) is a server-management control panel, not a
managed-container service: you own the Ubuntu VPS and xCloud provisions and manages it.
That is exactly the shape Hezo needs - a real VM with a host Docker socket - but it
means xCloud, not Hezo, owns the web server, the certificate and the firewall.

So Hezo installs as a **host systemd service behind xCloud's Nginx**, using the same
[`deploy/provision.sh`](../provision.sh) as every other target, run with
`HEZO_PROXY=none HEZO_FIREWALL=none`. One source of truth for host setup; the two modes
say which parts of the host this script is not to touch.

## What's code (here) vs. external ops

| Step | Where |
|---|---|
| The installer and its `HEZO_PROXY` / `HEZO_FIREWALL` modes (`deploy/provision.sh`) | **This repo** |
| The Nginx directives Hezo needs behind a proxy | **This repo** (below, and [`docs/deployment/cloud.md`](../../docs/deployment/cloud.md) § Serve it over HTTPS) |
| An xCloud account, a server, a domain | **External** - the user's; there is a free trial |
| Connecting the server, creating the site, issuing the certificate, pasting the Nginx block | **External** - xCloud dashboard |
| Getting Hezo into xCloud's one-click catalogue | **External** - no self-serve process exists, see [Getting listed](#getting-listed) |

## Do it in this order

**Connect the server to xCloud first, then install Hezo.** xCloud only accepts a
**fresh, empty** Ubuntu 24.04 LTS x64 server with root access
([their requirements](https://xcloud.host/docs/how-to-set-up-server-with-other-providers/)),
so a box that already has Hezo on it is a box xCloud will refuse.

1. Create an Ubuntu 24.04 LTS x64 server, 2 GB RAM or more, and connect it to xCloud.
2. Create a site for your domain and let xCloud issue its Let's Encrypt certificate.
   Confirm the placeholder site loads over HTTPS **before** installing Hezo - that keeps
   certificate problems and Hezo problems separate.
3. SSH in and run the installer (below).
4. Add the Nginx directives to the site.
5. Open `https://your-domain` and finish the short first-run setup.

## Why the two modes

Run bare, `provision.sh` assumes it owns the host, and each of those assumptions is
wrong here:

| What it would do | Why that breaks an xCloud server |
|---|---|
| Install Caddy on 80/443 | xCloud's Nginx is already there; two services would fight for the ports |
| `ufw --force reset` | Deletes the firewall rules xCloud manages from its dashboard |
| Derive `<public-ip>.sslip.io` | xCloud owns the domain and holds the certificate for it |

`HEZO_PROXY=none` turns off the first and third; `HEZO_FIREWALL=none` turns off the
second. Everything else - swap, Docker, the binary, the systemd unit, the needrestart
exemption - runs exactly as it does everywhere else.

## Run it

```sh
curl -fsSL https://raw.githubusercontent.com/hezo-ai/hezo/main/deploy/provision.sh \
  | sudo HEZO_PROXY=none HEZO_FIREWALL=none HEZO_DOMAIN_OVERRIDE=hezo.example.com bash
```

**The variables go after `sudo`, not before `curl`.** `sudo` scrubs the environment, so
`export HEZO_PROXY=none; curl ... | sudo bash` silently loses them - and that run is the
one that installs Caddy and resets xCloud's firewall.

`HEZO_DOMAIN_OVERRIDE` is required in this mode: with no Caddy there is nothing to derive
an address from, and it is the only source of the config's `webUrl`. Hezo builds absolute URLs
from that value (the OAuth callback an MCP connection registers with its provider among
them), so a wrong one fails later at connect time rather than during the install.

Both modes are recorded in `/etc/hezo/deploy.env`, so a later bare re-run of the
installer on this host stays in them - it will not suddenly install Caddy and reset your
firewall because someone forgot the variables. Passing a variable explicitly still wins,
so switching back is possible.

To put the database in a managed Postgres or assets in an S3-compatible bucket, add
`HEZO_DATABASE_URL` and `HEZO_ASSET_STORAGE_URL` the same way - see
[`docs/deployment/one-click.md`](../../docs/deployment/one-click.md) § Using managed data
hosting.

## The Nginx directives

**Read the generated vhost first:** `cat /etc/nginx/sites-available/<site-name>`. Nginx
refuses a duplicated single-value directive, and repeated `proxy_set_header` lines
accumulate rather than replace, so add only what is missing rather than pasting blind.

Target state for the location that proxies to Hezo:

```nginx
# Hezo - reverse proxy to the systemd service on this host.
proxy_pass http://127.0.0.1:3100;
proxy_http_version 1.1;

proxy_set_header Host              $host;
proxy_set_header X-Real-IP         $remote_addr;
proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
proxy_set_header X-Forwarded-Proto $scheme;

proxy_set_header Upgrade    $http_upgrade;
proxy_set_header Connection "upgrade";

proxy_read_timeout   3600s;
proxy_send_timeout   3600s;
client_max_body_size 12m;
```

What each group is for, and why none of it is optional, is in
[`docs/deployment/cloud.md`](../../docs/deployment/cloud.md) § Serve it over HTTPS. The
short version: `proxy_http_version 1.1` is what makes the WebSocket upgrade possible at
all, `X-Forwarded-Proto` is what keeps OAuth callbacks on `https://`, the timeouts stop
an idle activity stream being cut every 60 seconds, and the body size lets 10 MB
attachments through.

Add it through **NGINX -> Add a New Config** in the site's dashboard
([how](https://xcloud.host/docs/configure-custom-nginx-xcloud/)). xCloud offers five
placements:

- **Inside Proxy Location Block** - use this on a site type where xCloud already emits
  its own `proxy_pass` to an application port (set that port to `3100`), and drop the
  `proxy_pass` line from the block above.
- **Inside Server Block** - use this if the site has no `location /` of its own; paste a
  complete `location / { ... }` including `proxy_pass`.
- **After Server Block** is wrong for this: that include lands outside `server { }`,
  where a `location` is a syntax error.

Use **Run & Debug** rather than **Save Config** - it surfaces `nginx -t` errors in the
dashboard instead of leaving a broken vhost.

## What differs from the cloud-init path

- Your own domain, not `<ip>.sslip.io`.
- xCloud's certificate, renewed by xCloud. No Caddy is installed and nothing is written
  under `/etc/caddy`.
- xCloud's firewall. The installer leaves it completely alone - which also means
  **closing port 3100 to the internet is now xCloud's job, not ours**: Hezo binds
  `0.0.0.0` and has no bind-host setting. xCloud opens only 22, 80 and 443 by default,
  so the default posture is right - verify it anyway (below).
- Everything else is identical, the master key included: Hezo comes up **locked** after
  any restart, by design, and unlocks from the browser gate.

## Verify it

On the server:

```sh
systemctl is-active hezo                  # active
curl -s 127.0.0.1:3100/health             # {"ok":true}
command -v caddy                          # nothing - no proxy was installed
ufw status numbered                       # unchanged from before the install
docker info >/dev/null && echo docker-ok  # the default sandbox backend needs it
```

From another machine, in this order:

1. `curl --max-time 5 http://<server-ip>:3100/health` **must fail** (timeout or refused).
   If it answers, the instance is exposed on a bare HTTP port - fix the firewall in the
   xCloud dashboard before going any further.
2. `curl -sI https://<domain>/health` returns 200 over a valid chain, with no `-k`.
3. The WebSocket upgrade, which is the directive most likely to be missing:

   ```sh
   curl -si --max-time 5 https://<domain>/ws \
     -H "Connection: Upgrade" -H "Upgrade: websocket" \
     -H "Sec-WebSocket-Version: 13" \
     -H "Sec-WebSocket-Key: $(openssl rand -base64 16)"
   ```

   `101 Switching Protocols` is a pass. A 200, 400 or 426 almost always means
   `proxy_http_version 1.1` is missing.

In the browser:

4. Finish [first-run setup](../../docs/getting-started/first-run.md) - master key, admin
   password, connect a model.
5. Open the CEO chat and leave it idle for more than a minute. A live log stream that
   survives proves both the upgrade and `proxy_read_timeout`.
6. Connect an OAuth-backed MCP server or a GitHub account. The callback must land on
   `https://`. If `X-Forwarded-Proto` is missing, Hezo builds an `http://` callback and
   the provider rejects it, while every page still looks fine over TLS.
7. Attach a roughly 9 MB file to a task. A 413 means `client_max_body_size` did not take.
8. Create a project and confirm its container starts (Settings -> Containers).
9. Reboot the server from the panel. Nginx and Hezo both come back, and Hezo is
   **locked** at the gate - expected, not a failed deploy. Check
   `/etc/needrestart/conf.d/hezo.conf` survived the panel's package management.

If some API calls return 403 while the site otherwise works, suspect xCloud's WAF
(`/etc/nginx/conf.d/7g-firewall.conf` and the per-site security toggles) and read
`/var/log/nginx/<site-name>-error.log`.

## Getting listed

xCloud has a curated [one-click app catalogue](https://xcloud.host/one-click-apps/)
carrying adjacent self-hosted AI tools - n8n, LibreChat, OpenWebUI/Ollama. Hezo belongs
on that shelf, but:

**There is no submission process.** No template spec, no partner program, no manifest
format, no URL-based "Deploy to xCloud" button. `oneclick` is a read-only site-type
filter in [their API](https://app.xcloud.host/api/v1/docs); neither the
[CLI](https://github.com/xCloudDev/xCloud-cli) nor their agent skills have an
app-authoring surface, and "Blueprints" are WordPress plugin and theme packs, not app
templates. The catalogue is curated internally. The only route is contact:
`support@xcloud.host`.

That is the same split this repo already lives with for the
[DigitalOcean Marketplace](../marketplace/digitalocean/README.md): everything needed to
make it work today is in here, and the listing is theirs to grant.

**Do the outreach only after the whole of [Verify it](#verify-it) has passed on a real
server**, and keep that instance running. A live Hezo on their own platform is the
strongest thing the pitch has.

### What to send

What Hezo is, what it needs from a host - Ubuntu 24.04 x64 or arm64, 2 GB RAM plus the
6 GB swap the installer creates, Docker on the host for the default sandbox backend, one
local port - the install command and the Nginx block above, and the URL of the live
instance.

Lead with the two questions that decide whether this is possible at all:

1. **Does a catalogue entry have to be Docker Compose shaped?** Every current entry
   appears to be, and the Docker + NGINX stack is mandatory for custom Docker apps. Hezo
   runs agents in containers on the **host's** Docker socket, so containerizing the Hezo
   server is not a packaging detail - it is a different product shape. Can an entry
   instead be a host-level install script plus a site Nginx template?
2. **Is there a spec, template repo, or intake form** we can PR or fill in?

Record the date sent and the answer here - this file is the memory.

If the answer is "Compose only", the decision to bring back is whether to publish a Hezo
**server** image at all. None exists today (`ghcr.io/hezo-ai/agent-base` is the agent
sandbox image, not the server), running the server in a container disables in-app update,
and it would need a reviewed `/var/run/docker.sock` mount. That is a project, not a
follow-up commit.

## Teardown

```sh
sudo systemctl disable --now hezo hezo-firstboot
sudo rm -f /usr/local/bin/hezo /usr/local/sbin/hezo-*.sh \
  /etc/systemd/system/hezo.service /etc/systemd/system/hezo-firstboot.service \
  /etc/needrestart/conf.d/hezo.conf
sudo rm -rf /etc/hezo
sudo systemctl daemon-reload
```

`/var/lib/hezo` is your data - back it up before deleting it, then remove it with
`sudo HEZO_DATA_DIR=/var/lib/hezo hezo uninstall --yes` **before** deleting the binary
above, since that also reaps the containers Hezo created. Finally delete the site from
the xCloud dashboard, which removes its vhost and certificate.
