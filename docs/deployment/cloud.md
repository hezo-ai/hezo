---
title: Deploying to the cloud
order: 27
section: Deployment
---

# Deploying to a cloud server

Running Hezo on an always-on cloud server lets your teams keep working around the clock
without your laptop being on. Any VPS that can run Docker works - for example
DigitalOcean, Hetzner, Fly, Linode, or an EC2 instance.

> **Want the fast path?** [One-click deploy](/docs/deployment/one-click) provisions all
> of the below for you from a single cloud-init snippet - Docker, the binary, automatic
> HTTPS, systemd, and the firewall - on DigitalOcean, Hetzner, Vultr, Linode, or
> Lightsail. This page covers the manual shape if you'd rather set it up yourself.

> **Running agent containers on a
> [managed sandbox service](/docs/containers/remote/overview) instead?** Then the server
> needs no Docker at all, and a much smaller VPS will do - the containers' memory lives
> with the provider, not on this host. Skip the Docker steps below and pass
> `--sandbox-backend` on first start
> ([configuration](/docs/deployment/configuration#running-agent-containers-on-a-managed-sandbox-service)),
> or move an already-running instance over from **Settings -> Containers**
> ([Switching at any time](/docs/containers/overview#switching-at-any-time)) - restarting
> with different environment variables does not switch an existing instance.

## The shape of a cloud deployment

1. **Provision a host with Docker** and install the `hezo` binary
   ([Installation](/docs/getting-started/installation)).
2. **Choose where your data lives.** The data directory goes on persistent storage so
   it survives restarts and redeploys:

   ```sh
   hezo --data-dir /var/lib/hezo
   ```

   By default that directory also holds the embedded database and all asset files. Or
   hand either to a managed service - a hosted Postgres for the database, an
   S3-compatible bucket for assets - so your provider handles backups and durability;
   see [Managed database & asset storage](#managed-database--asset-storage) below.
3. **Serve it over HTTPS** with a reverse proxy - required, not a nice-to-have; see
   [below](#serve-it-over-https).
4. **Unlock it from the browser.** After boot Hezo starts **locked** - open its gate
   and enter your twelve-word master key to unlock the instance. This is by design:
   the master key is kept in memory only and is never stored on the server, so a stolen
   disk image can't decrypt your vault. If you need to unlock a single startup without
   the browser, you can pass the key to that one invocation - but don't bake it into a
   file or service definition:

   ```sh
   HEZO_MASTER_KEY="your twelve word master key phrase here" hezo --data-dir /var/lib/hezo
   ```

5. **Set the public URL** so account sign-ins redirect back correctly:

   ```sh
   hezo --web-url https://hezo.example.com
   ```

See the [Configuration reference](/docs/deployment/configuration) for every option.

## Managed database & asset storage

Local disk is the default, not a requirement: point Hezo at a **managed Postgres**
and/or an **S3-compatible bucket** and the server itself becomes nearly stateless -
the data directory then holds only workspaces, SSH/signing keys, and pre-migration
backups. Each backend is one setting, adoptable independently:

1. **Provision a PostgreSQL 14+ instance** in the same region as your server (Hezo's
   scheduling polls every 1-5 seconds, so latency counts), with TLS and a **direct or
   session-pooled** connection - transaction-mode poolers (PgBouncer in transaction
   mode) are not supported. Full requirements:
   [Using an external Postgres](/docs/deployment/configuration#using-an-external-postgres).
2. **Provision a private bucket** on any S3-compatible store (AWS S3, Cloudflare R2,
   DigitalOcean Spaces, Backblaze B2, MinIO, …) with an access key. The bucket stays
   private - Hezo serves asset bytes through signed URLs. URL grammar and options:
   [Storing assets in S3-compatible object storage](/docs/deployment/configuration#storing-assets-in-s3-compatible-object-storage).
3. **Set the URL(s) where your service definition reads its environment** - e.g. the
   `EnvironmentFile` of your systemd unit (see
   [Self-hosting](/docs/deployment/self-hosting)), kept root-only (mode 600) since the
   URLs carry credentials. Prefer the config file over the CLI flags - flags are visible
   in the process list - and give it mode 600:

   ```js
   // /etc/hezo/hezo.config.cjs
   module.exports = {
     dataDir: '/var/lib/hezo',
     database: { url: 'postgres://hezo:••••@db-host:5432/hezo?sslmode=verify-full' },
     assetStorage: { url: 's3://ACCESS_KEY:SECRET@endpoint/bucket' },
   };
   ```

   Most managed providers sign their database certificates with their own CA, so
   `verify-full` also needs the provider's CA certificate:
   `?sslmode=verify-full&sslrootcert=/etc/hezo/db-ca.crt`. See
   [TLS and sslmode](/docs/deployment/configuration#tls-and-sslmode).

4. **Verify at startup.** Hezo checks both backends and fails fast with guidance if
   the database is older than 14 or the bucket is unreachable. The startup log shows
   `Using external Postgres at …` and `Asset storage: S3-compatible (…)`, and
   **Settings → Storage** shows the active **Database** and **Asset storage** backends
   with credentials occluded.

Provider-specific walkthroughs (DigitalOcean Managed Postgres + Spaces, serverless
Postgres like Neon or Supabase) are in
[One-click deploy → Using managed data hosting](/docs/deployment/one-click#using-managed-data-hosting) -
the steps apply to a manual deployment unchanged. To move an **existing** instance's
data into managed backends, use `hezo backup` / `hezo restore` - see
[Switching an existing instance](/docs/deployment/configuration#switching-an-existing-instance).

## Serve it over HTTPS

Hezo's own process serves plain HTTP, so every deployment puts a TLS-terminating
reverse proxy (Caddy, nginx, or Traefik) in front, forwarding to the Hezo port (3100 by
default). Treat HTTPS as **essential**, whether the address is public or on a private
network:

- **OAuth-connected MCP servers require it.** Connecting a SaaS MCP server runs an
  OAuth flow whose callback lands on your instance's URL, and providers and browsers
  only accept HTTPS (or `localhost`) callbacks - over plain HTTP the connect flow
  fails. (REST API connectors authorized with the device flow have no callback, so
  they work without it.) See
  [Connecting external services](/docs/mcp/connecting-mcp-servers).
- **The phone experience requires it.** Installing Hezo as a home-screen app needs a
  secure context.
- **Everything sensitive rides on every request** - your admin password, agent output,
  task content. TLS is the baseline.

Configure the proxy to do all three of:

- **Pass through WebSocket upgrades** - the web app streams agent activity in real
  time.
- **Preserve the `Host` header** of the original request.
- **Send `X-Forwarded-Proto`** - Hezo builds absolute URLs (such as the OAuth callback
  an MCP connection registers with its provider) from the forwarded scheme and host;
  without this header it falls back to `http://` and OAuth connects fail even though
  you're browsing over HTTPS.

With Caddy all three are the default - a complete Caddyfile is:

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
your hostname, use a private CA or a DNS-01 certificate - see
[Secure remote access](/docs/deployment/secure-remote-access) for the options per
setup.

## Don't expose it to the open internet unguarded

Your Hezo instance can run agents, spend money, and reach your connected accounts, so it
should never sit on a public address without protection. The simplest and safest
approach is to keep it on a **private network** and not expose the port publicly at all -
see [Secure remote access](/docs/deployment/secure-remote-access) for the recommended
options (Tailscale, Cloudflare Tunnel, and others).
