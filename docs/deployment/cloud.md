---
title: Deploying to the cloud
order: 27
section: Deployment
---

# Deploying to a cloud server

Running Hezo on an always-on cloud server lets your teams keep working around the clock
without your laptop being on. Any VPS that can run Docker works — for example
DigitalOcean, Hetzner, Fly, Linode, or an EC2 instance.

> **Want the fast path?** [One-click deploy](/docs/deployment/one-click) provisions all
> of the below for you from a single cloud-init snippet — Docker, the binary, automatic
> HTTPS, systemd, and the firewall — on DigitalOcean, Hetzner, Vultr, Linode, or
> Lightsail. This page covers the manual shape if you'd rather set it up yourself.

## The shape of a cloud deployment

1. **Provision a host with Docker** and install the `hezo` binary
   ([Installation](/docs/getting-started/installation)).
2. **Put the data directory on persistent storage** so it survives restarts and
   redeploys:

   ```sh
   hezo --data-dir /var/lib/hezo
   ```

3. **Serve it over HTTPS** with a reverse proxy — required, not a nice-to-have; see
   [below](#serve-it-over-https).
4. **Unlock it from the browser.** After boot Hezo starts **locked** — open its gate
   and enter your twelve-word master key to unlock the instance. This is by design:
   the master key is kept in memory only and is never stored on the server, so a stolen
   disk image can't decrypt your vault. If you need to unlock a single startup without
   the browser, you can pass the key to that one invocation — but don't bake it into a
   file or service definition:

   ```sh
   HEZO_MASTER_KEY="your twelve word master key phrase here" hezo --data-dir /var/lib/hezo
   ```

5. **Set the public URL** so account sign-ins redirect back correctly:

   ```sh
   hezo --web-url https://hezo.example.com
   ```

See the [Configuration reference](/docs/deployment/configuration) for every option.

## Serve it over HTTPS

Hezo's own process serves plain HTTP, so every deployment puts a TLS-terminating
reverse proxy (Caddy, nginx, or Traefik) in front, forwarding to the Hezo port (3100 by
default). Treat HTTPS as **essential**, whether the address is public or on a private
network:

- **OAuth-connected MCP servers require it.** Connecting a SaaS MCP server runs an
  OAuth flow whose callback lands on your instance's URL, and providers and browsers
  only accept HTTPS (or `localhost`) callbacks — over plain HTTP the connect flow
  fails. (REST API connectors authorized with the device flow have no callback, so
  they work without it.) See
  [Connecting external services](/docs/mcp/connecting-mcp-servers).
- **The phone experience requires it.** Installing Hezo as a home-screen app needs a
  secure context.
- **Everything sensitive rides on every request** — your admin password, agent output,
  task content. TLS is the baseline.

Configure the proxy to do all three of:

- **Pass through WebSocket upgrades** — the web app streams agent activity in real
  time.
- **Preserve the `Host` header** of the original request.
- **Send `X-Forwarded-Proto`** — Hezo builds absolute URLs (such as the OAuth callback
  an MCP connection registers with its provider) from the forwarded scheme and host;
  without this header it falls back to `http://` and OAuth connects fail even though
  you're browsing over HTTPS.

With Caddy all three are the default — a complete Caddyfile is:

```
hezo.example.com {
	reverse_proxy localhost:3100
}
```

For nginx, set the headers explicitly on the proxied location:

```nginx
proxy_set_header Host $host;
proxy_set_header X-Forwarded-Proto $scheme;
proxy_set_header Upgrade $http_upgrade;
proxy_set_header Connection "upgrade";
```

On a private network (a VPN or mesh) where a public certificate authority can't see
your hostname, use a private CA or a DNS-01 certificate — see
[Secure remote access](/docs/deployment/secure-remote-access) for the options per
setup.

## Don't expose it to the open internet unguarded

Your Hezo instance can run agents, spend money, and reach your connected accounts, so it
should never sit on a public address without protection. The simplest and safest
approach is to keep it on a **private network** and not expose the port publicly at all —
see [Secure remote access](/docs/deployment/secure-remote-access) for the recommended
options (Tailscale, Cloudflare Tunnel, and others).
