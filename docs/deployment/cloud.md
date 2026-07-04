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

3. **Unlock it from the browser.** After boot Hezo starts **locked** — open its gate
   and enter your twelve-word master key to unlock the instance. This is by design:
   the master key is kept in memory only and is never stored on the server, so a stolen
   disk image can't decrypt your vault. If you need to unlock a single startup without
   the browser, you can pass the key to that one invocation — but don't bake it into a
   file or service definition:

   ```sh
   HEZO_MASTER_KEY="your twelve word master key phrase here" hezo --data-dir /var/lib/hezo
   ```

4. **Set the public URL** so account sign-ins redirect back correctly:

   ```sh
   hezo --web-url https://hezo.example.com
   ```

See the [Configuration reference](/docs/deployment/configuration) for every option.

## Terminate TLS with a reverse proxy

Hezo serves plain HTTP. For a public deployment, put a reverse proxy (Caddy, nginx, or
Traefik) in front of it to handle HTTPS and your domain, forwarding to the Hezo port
(3100 by default). Make sure the proxy is configured to **pass through WebSocket
upgrades**, since the web app streams agent activity in real time.

## Don't expose it to the open internet unguarded

Your Hezo instance can run agents, spend money, and reach your connected accounts, so it
should never sit on a public address without protection. The simplest and safest
approach is to keep it on a **private network** and not expose the port publicly at all —
see [Secure remote access](/docs/deployment/secure-remote-access) for the recommended
options (Tailscale, Cloudflare Tunnel, and others).
