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
[Deploying to the cloud](/docs/deployment/cloud)) **and** put an authentication layer in
front (your proxy's auth, an identity-aware proxy, or an SSO gateway). Never publish the
raw Hezo port directly.

## Rule of thumb

Prefer a private network (Tailscale/WireGuard) or an authenticated tunnel. Treat a
public, internet-facing Hezo as something that always needs both TLS and an auth layer
in front of it.
