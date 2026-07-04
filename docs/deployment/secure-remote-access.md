---
title: Secure remote access
order: 28
section: Deployment
---

# Secure remote access

A cloud-hosted Hezo can run agents, spend money, and reach your connected accounts — so
how you reach it matters as much as where you run it. Hezo serves plain HTTP and has no
built-in VPN, so you put a secure channel **around** it. The goal is simple: **don't
expose the Hezo port to the public internet.**

Here are the common ways to do that, roughly easiest first.

## Private mesh VPN — Tailscale / WireGuard (recommended)

Put the server and your devices on a private network and reach Hezo as if it were
local. With **Tailscale** (or plain **WireGuard**), the Hezo port is never published to
the internet — only devices on your mesh can connect. This is the simplest secure setup
and the one we recommend for most people. You can browse to the server's private
address, and your phone joins the same way for on-the-go oversight.

## Cloudflare Tunnel

A **Cloudflare Tunnel** connects your server out to Cloudflare, so you get an HTTPS
hostname **without opening any inbound ports**. Pair it with an access policy
(Cloudflare Access) to require sign-in before anyone reaches Hezo.

## SSH tunnel

For quick, occasional access, forward the port over SSH from your machine. Hezo listens
on **3100** by default — if you changed it with `--port`, use that port on the right-hand
(server) side:

```sh
ssh -L 3100:localhost:3100 user@your-server
```

Then open `http://localhost:3100` locally. Nothing is exposed publicly; the tunnel
lives only as long as the SSH session.

## Public domain + reverse proxy + auth

If you do want a public URL, terminate HTTPS with a reverse proxy (see
[Deploying to the cloud](/docs/deployment/cloud)). Never publish the raw Hezo port
directly.

Hezo authenticates every session with your **admin password**, so a public deployment is
no longer open by default. Access is gated by that password on every request; the master
key's job is separate — it unlocks the instance's encryption, and you provide it from the
browser gate after each restart. **Don't store the master key on the server** to skip the
unlock; keeping it in memory only is what protects the vault if the host is compromised.

- **Set a strong admin password** and, if you upgraded an existing instance, change the
  default (`password`) before exposing it. See [Master key & encryption](/docs/security/master-key).
- For defense in depth you can still add a second authentication layer in front (your
  proxy's auth, an identity-aware proxy, or an SSO gateway) — recommended for
  internet-facing deployments.

## Install Hezo on your phone

Hezo is a Progressive Web App, so you can add it to your home screen and run it
full-screen like a native app. Open Hezo in your mobile browser and it offers an
**Install** prompt; on iPhone/iPad, use Safari's **Share → Add to Home Screen**. This
needs a secure context — an **HTTPS** URL (a Cloudflare Tunnel or reverse proxy) or
`localhost` (an SSH tunnel) — so the install option won't appear over a plain‑HTTP private
address.

## Rule of thumb

Prefer a private network (Tailscale/WireGuard) or an authenticated tunnel. Treat a
public, internet-facing Hezo as something that always needs both TLS and an auth layer
in front of it.
