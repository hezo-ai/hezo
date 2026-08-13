---
title: Secure remote access
order: 28
section: Deployment
---

# Secure remote access

A cloud-hosted Hezo can run agents, spend money, and reach your connected accounts - so
how you reach it matters as much as where you run it. Two rules cover it:

1. **Don't expose the Hezo port to the public internet.** Keep it on a private network
   or behind an authenticated tunnel.
2. **Reach it over HTTPS - even on a private network.** The one address that's fine
   over plain HTTP is `http://localhost` (loopback on your own machine, for example
   through an SSH tunnel).

Hezo's own process serves plain HTTP and has no built-in VPN, so both properties come
from what you put around it: a private network or tunnel for reachability, and a
TLS-terminating reverse proxy for HTTPS (see
[Serve it over HTTPS](/docs/deployment/cloud#serve-it-over-https) for the proxy setup).

## Why HTTPS is essential, even on a VPN

- **OAuth-connected MCP servers won't finish connecting without it.** Connecting a SaaS
  MCP server ([Connecting external services](/docs/mcp/connecting-mcp-servers)) runs an
  OAuth flow that redirects your browser back to your instance's callback URL. Providers
  and browsers only accept **HTTPS** callbacks (plus `localhost`), so on a plain-HTTP
  private address the consent popup's final **Allow** step is rejected or silently
  blocked. The instance doesn't need to be publicly reachable - the redirect happens in
  your browser - it just needs an HTTPS address. (REST API connectors authorized with
  the device flow have no callback and work on any address.)
- **Your phone needs a secure context.** Installing Hezo as an app (below) and other
  browser capabilities only work over HTTPS or `localhost`.
- **Defense in depth.** Your admin password, agent output, and everything you paste
  into a task ride on every request; TLS keeps them sealed even if another device on
  the network is compromised.

Here are the common ways to set up access, roughly easiest first.

## Private mesh VPN - Tailscale / WireGuard (recommended)

Put the server and your devices on a private network and reach Hezo as if it were
local. With **Tailscale** (or plain **WireGuard**), the Hezo port is never published to
the internet - only devices on your mesh can connect. This is the simplest secure setup
and the one we recommend for most people, and your phone joins the same way for
on-the-go oversight.

Mesh hostnames aren't public, so add HTTPS one of these ways:

- **Tailscale:** `tailscale cert` issues a real certificate for your machine's
  `*.ts.net` name, or `tailscale serve` puts an HTTPS proxy in front of the Hezo port
  in one command.
- **Any other mesh (WireGuard, NordVPN Meshnet, …):** run a reverse proxy with a
  private CA (Caddy's `tls internal` is the least-effort option) and trust its root
  certificate on the devices you browse from. Or, if you own a domain, point a DNS
  record at the private address and get a Let's Encrypt certificate via the **DNS-01**
  challenge: a browser-trusted certificate with no public exposure and no CA-trust
  step on any device.

## Cloudflare Tunnel

A **Cloudflare Tunnel** connects your server out to Cloudflare, so you get an HTTPS
hostname **without opening any inbound ports** - the certificate comes with the tunnel,
nothing extra to set up. Pair it with an access policy (Cloudflare Access) to require
sign-in before anyone reaches Hezo.

## SSH tunnel

For quick, occasional access, forward the port over SSH from your machine. Hezo listens
on **3100** by default - if you changed it with `--port`, use that port on the right-hand
(server) side:

```sh
ssh -L 3100:localhost:3100 user@your-server
```

Then open `http://localhost:3100` locally. Nothing is exposed publicly; the tunnel
lives only as long as the SSH session. This is the one setup where plain HTTP is fine:
browsers and OAuth providers treat loopback as a secure context, so everything -
including OAuth-connected MCP servers - works through the tunnel.

## Public domain + reverse proxy + auth

If you do want a public URL, terminate HTTPS with a reverse proxy (see
[Deploying to the cloud](/docs/deployment/cloud)). Never publish the raw Hezo port
directly.

Hezo authenticates every session with your **admin password**, so a public deployment is
no longer open by default. Access is gated by that password on every request; the master
key's job is separate - it unlocks the instance's encryption, and you provide it from the
browser gate after each restart. **Don't store the master key on the server** to skip the
unlock; keeping it in memory only is what protects the vault if the host is compromised.

- **Set a strong admin password** and, if you upgraded an existing instance, change the
  default (`password`) in **Settings → Users & access** before exposing it. See
  [Master key & encryption](/docs/security/master-key).
- For defense in depth you can still add a second authentication layer in front (your
  proxy's auth, an identity-aware proxy, or an SSO gateway) - recommended for
  internet-facing deployments.

## Install Hezo on your phone

Hezo is a Progressive Web App, so you can add it to your home screen and run it
full-screen like a native app. Open Hezo in your mobile browser and it offers an
**Install** prompt; on iPhone/iPad, use Safari's **Share → Add to Home Screen**. This
needs a secure context - your instance's **HTTPS** URL, or `localhost` via an SSH
tunnel - one more reason the HTTPS setup above isn't optional. If you used a private
CA, trust its root certificate on the phone too.

## Rule of thumb

Prefer a private network (Tailscale/WireGuard) or an authenticated tunnel, and serve
Hezo **over HTTPS either way** - OAuth-connected MCP servers and the phone app depend
on it. Treat a public, internet-facing Hezo as something that always needs both TLS
and an auth layer in front of it.
