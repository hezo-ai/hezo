---
title: Configuration reference
order: 29
section: Deployment
---

# Configuration reference

Most settings can be supplied as a **command-line flag** or an **environment variable**;
a few are environment-variable only (shown with `—` in the **Flag** column below).
When a setting supports both and both are present, the **environment variable wins** —
handy for baking defaults into a service definition while still overriding per run.

## Options

| Flag | Environment variable | Default | Description |
|---|---|---|---|
| `--port <port>` | `HEZO_PORT` | `3100` | Port the server and web app listen on (1–65535). |
| `--data-dir <path>` | `HEZO_DATA_DIR` | `~/.hezo/` | Where Hezo stores its database, encrypted secrets, and assets. Still required with an external database or S3 asset storage — workspaces and keys live here. |
| `--database-url <url>` | `HEZO_DATABASE_URL` | — | Connection string for an [external Postgres](#using-an-external-postgres) (`postgres://user:password@host:5432/hezo`). Omit to use the embedded database under the data directory (the default). |
| — | `HEZO_DATABASE_POOL_SIZE` | `10` | Connection-pool size for the external database (2–100). Ignored for the embedded database. |
| `--asset-storage-url <url>` | `HEZO_ASSET_STORAGE_URL` | — | [S3-compatible object storage](#storing-assets-in-s3-compatible-object-storage) for asset files (`s3://KEY:SECRET@endpoint/bucket[/prefix]`). Omit to store assets on the local filesystem under the data directory (the default). |
| `--master-key <phrase>` | `HEZO_MASTER_KEY` | — | The twelve-word master key, to set up or unlock without the web gate. |
| `--web-url <url>` | `HEZO_WEB_URL` | same origin | Public base URL, used so account sign-ins redirect back correctly. |
| `--reset` | `HEZO_RESET` | off | Start fresh with an empty **embedded** database (the existing `pgdata` is renamed aside, not deleted). Not applicable with `--database-url` — recreate an external database with your provider's tools. |
| `--no-open` | `HEZO_OPEN` | on | Auto-open the web app in your browser on startup. On by default; automatically skipped in environments without a browser (CI, containers, SSH, headless Linux). Pass `--no-open` or set `HEZO_OPEN=0` to disable. |
| `--log-level <level>` | `HEZO_LOG_LEVEL` | `info` | Logging verbosity: `debug`, `info`, `warn`, or `error`. |
| `--keep-old-containers` | `HEZO_KEEP_OLD_CONTAINERS` | off | Keep old project containers instead of removing them — for debugging a crashed container. |
| `--container-bind-host <host>` | `HEZO_CONTAINER_BIND_HOST` | `127.0.0.1` | Interface the egress proxy and SSH bridge bind to so agent containers can reach them. The default suits Docker Desktop; on native-Linux Docker the boot connectivity check auto-rebinds them to the detected bridge gateway IP (host-local, container-reachable), so this usually needs no change. Set it to pin a specific interface (an explicit non-loopback value is never auto-overridden); firewall-restrict the range (20000–29999) to the docker bridge. See [Self-hosting → Networking & firewall](/docs/deployment/self-hosting). |
| `--version` | — | — | Print the Hezo version and exit (also `hezo version`). |
| `--disable-telemetry` | `HEZO_TELEMETRY_ENABLED` | on | Turn off the anonymous daily usage report (see [Anonymous usage telemetry](#anonymous-usage-telemetry)). On by default; pass `--disable-telemetry` or set `HEZO_TELEMETRY_ENABLED=0`. |
| `--telemetry-endpoint <url>` | `HEZO_TELEMETRY_ENDPOINT` | `https://hezo.ai/api/telemetry` | Where the daily report is sent. Point it at your own collector to keep the data in-house. |
| — | `HEZO_TELEMETRY_CRON` | `0 0 5 * * *` | Cron schedule (seconds-precision) for the daily telemetry report. |
| — | `HEZO_DISABLE_AUTO_UPDATE` | off | Disable the in-app auto-update (release check, the background download, and the "Install & restart" banner). When disabled the banner instead links to the GitHub release page. |
| — | `HEZO_UPDATE_CHECK_CRON` | `0 0 4 * * *` | Cron schedule (seconds-precision) for the daily check that downloads and stages a newer release. A running instance also stages as soon as it detects an update, so the banner's "Install & restart" is instant. |
| — | `HEZO_PRICING_REFRESH_CRON` | `0 0 2 * * *` | Cron schedule (seconds-precision) for the daily model-pricing refresh from [pricepertoken.com](https://pricepertoken.com). Pricing also refreshes at startup; a failed refresh keeps the existing rates. |

## Examples

Run on a custom port with a dedicated data directory:

```sh
hezo --port 8080 --data-dir /var/lib/hezo
```

Unlock a single startup non-interactively by passing the master key to that one
invocation (Hezo normally starts **locked** and you unlock from the browser gate):

```sh
HEZO_MASTER_KEY="your twelve word master key phrase here" \
HEZO_DATA_DIR=/var/lib/hezo \
HEZO_WEB_URL=https://hezo.example.com \
  hezo
```

Pass `HEZO_MASTER_KEY` inline like this only for a one-off launch — **never persist it**
to an env file, a service definition, or anywhere on the host. The master key is kept in
memory only so a copy of your disk can't decrypt your data; writing it to disk defeats
that. See [Master key & encryption](/docs/security/master-key).

## Using an external Postgres

By default Hezo embeds its database inside the single binary and stores it under the data
directory — no external database to run. If you'd rather use a managed/hosted Postgres
(for managed backups, more headroom, or your own operational tooling), point Hezo at it:

```sh
HEZO_DATABASE_URL="postgres://hezo:••••@db.internal:5432/hezo?sslmode=verify-full" \
  hezo --data-dir /var/lib/hezo
```

On first start Hezo checks the server version, then creates its schema by applying its
migrations directly (each migration runs in its own transaction, guarded by an advisory
lock so two instances can't migrate at once). Upgrades migrate the same way. The current
backend and connection target (with credentials occluded) are shown under **Settings →
General → Database**.

Requirements and recommendations:

- **PostgreSQL 14 or newer.** The version is checked at startup.
- **Use TLS.** With an external database your tasks, comments, and documents travel the
  network and live with the provider — prefer `sslmode=verify-full` and private
  networking. [Secrets remain encrypted](/docs/concepts/your-data) with the master key
  either way.
- **Keep the database close to the server.** Hezo's background scheduling polls every
  1–5 seconds, so every millisecond of round-trip latency counts. Same-host,
  same-VPC, or same-region placement is strongly recommended.
- **Direct connections or session pooling only.** Transaction-pooling proxies
  (PgBouncer in transaction mode) break session-scoped advisory locks.
- **One Hezo server per database.** Concurrent startups coordinate migrations safely,
  but running two live servers against one database is not supported.
- The connection string carries credentials: prefer the environment variable over the
  flag (flags are visible in the process list), and never commit it to a repo.
- `hezo backup` / `hezo restore` work against an external database too — including
  **moving an existing embedded instance to hosted Postgres** (and back). See
  [Backup & recovery](/docs/deployment/backup-and-recovery).

## Storing assets in S3-compatible object storage

By default, uploaded [asset](/docs/concepts/assets) files (task attachments and the
project assets library) live on the local filesystem under `<data-dir>/assets/`. To keep
them in a bucket instead — for managed durability, or to keep the host closer to
stateless — point Hezo at any **S3-compatible** store:

```sh
HEZO_ASSET_STORAGE_URL="s3://ACCESS_KEY:SECRET@s3.eu-west-1.amazonaws.com/my-bucket/hezo-assets?region=eu-west-1" \
  hezo --data-dir /var/lib/hezo
```

One URL carries the whole configuration:

```
s3://ACCESS_KEY:SECRET@endpoint[:port]/bucket[/prefix]?region=…&pathStyle=…&tls=…
```

- **`endpoint`** — the storage host. AWS S3, MinIO, Cloudflare R2, DigitalOcean Spaces,
  Backblaze B2, and anything else that speaks the S3 API all work; only the S3 protocol
  is supported (no provider-native APIs).
- **`bucket[/prefix]`** — the bucket, plus an optional key prefix if the bucket is shared
  with other data. Objects are stored as `[prefix/]<project-id>/<asset-id>`.
- **`region`** — defaults to `us-east-1` (many S3-compatible stores accept any value).
- **`pathStyle`** — defaults to `true` for custom endpoints (MinIO and friends) and
  `false` (virtual-hosted addressing) for `*.amazonaws.com`.
- **`tls`** — defaults to `true`; set `tls=false` only for local/dev endpoints.
- Percent-encode any `/`, `+`, or `@` characters inside the access key or secret.

At startup Hezo verifies it can reach the bucket with the given credentials and exits
with guidance if it can't. The active backend (with credentials occluded) is shown under
**Settings → General → Asset storage**.

Recommendations:

- **Use TLS and a private bucket.** Asset bytes are served through the Hezo server with
  signed URLs — the bucket never needs to be publicly readable. Assets are stored as
  plain objects, so enable your provider's server-side encryption if you want them
  encrypted at rest.
- **One Hezo server per bucket/prefix.** Two live servers sharing a prefix is not
  supported (same posture as the database).
- The URL carries credentials: prefer the environment variable over the flag (flags are
  visible in the process list), and never commit it to a repo.

### Switching an existing instance

The local layout under `<data-dir>/assets/` and the bucket key layout are identical
(`<project-id>/<asset-id>`), so moving is a plain sync with any S3 tool. To move to a
bucket:

1. Stop the server (upgrade it and start it once first, if you're coming from an older
   version — the first start moves any old-layout assets into `<data-dir>/assets/`).
2. Copy the tree into the bucket, e.g.
   `aws s3 sync /var/lib/hezo/assets/ s3://my-bucket/hezo-assets/` (or `rclone sync`).
3. Start the server with `HEZO_ASSET_STORAGE_URL` set.

Moving back to local storage is the same sync in reverse, then start without the URL.

## Anonymous usage telemetry

To help us understand how Hezo is used across self-hosted installs, each instance sends a
small **anonymous** usage report once a day. It is **on by default** and easy to turn off.

**What's sent** — aggregate counts only:

- a random per-install id (a UUID generated on first report — it lets reports from the same
  install be counted once across days; it is not derived from you, your machine, or your data),
- the Hezo version, operating system, and CPU architecture,
- totals: number of teams, projects, and agents,
- task counts by status, and how many tasks were completed in the last 24 hours,
- agent-run count and total input/output **tokens** over the last 24 hours,
- the mix of AI providers used (e.g. how many runs used Anthropic vs. OpenAI).

**What's never sent** — project, team, or task names; prompts or any task content; repository
details; user identities; secrets; or any monetary/cost figure. Aggregated numbers from all
opted-in installs are shown publicly at [hezo.ai/stats](https://hezo.ai/stats).

**Turn it off** with the flag or the environment variable:

```sh
hezo --disable-telemetry
# or
HEZO_TELEMETRY_ENABLED=0 hezo
```

You can also keep the data in-house by pointing `--telemetry-endpoint` (or
`HEZO_TELEMETRY_ENDPOINT`) at your own collector.

## See also

- [CLI reference](/docs/reference/cli) — commands and usage.
- [Backup & recovery](/docs/deployment/backup-and-recovery) — `--reset` and restoring.
- [First-run setup](/docs/getting-started/first-run) — the master key.
