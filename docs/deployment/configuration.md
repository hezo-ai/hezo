---
title: Configuration reference
order: 29
section: Deployment
---

# Configuration reference

Most settings can be supplied as a **command-line flag** or an **environment variable**;
a few are environment-variable only (shown with `-` in the **Flag** column below).
When a setting supports both and both are present, the **environment variable wins** -
handy for baking defaults into a service definition while still overriding per run.

## Options

| Flag | Environment variable | Default | Description |
|---|---|---|---|
| `--port <port>` | `HEZO_PORT` | `3100` | Port the server and web app listen on (1-65535). |
| `--data-dir <path>` | `HEZO_DATA_DIR` | `~/.hezo/` | Where Hezo stores its database, encrypted secrets, and assets. Still required with an external database or S3 asset storage - workspaces and keys live here. |
| `--database-url <url>` | `HEZO_DATABASE_URL` | - | Connection string for an [external Postgres](#using-an-external-postgres) (`postgres://user:password@host:5432/hezo`). Its `sslmode` follows standard libpq rules - see [TLS and sslmode](#tls-and-sslmode). Omit to use the embedded database under the data directory (the default). |
| - | `HEZO_DATABASE_POOL_SIZE` | `10` | Connection-pool size for the external database (2-100). Ignored for the embedded database. |
| `--asset-storage-url <url>` | `HEZO_ASSET_STORAGE_URL` | - | [S3-compatible object storage](#storing-assets-in-s3-compatible-object-storage) for asset files (`s3://KEY:SECRET@endpoint/bucket[/prefix]`). Omit to store assets on the local filesystem under the data directory (the default). |
| `--sandbox-backend <name>` | `HEZO_SANDBOX_BACKEND` | `docker` | Where agent containers run on a **new** instance: `docker` (the local daemon) or `daytona` (a [managed sandbox service](#running-agent-containers-on-a-managed-sandbox-service)). Once set in Settings -> Containers, the stored choice wins and this is ignored. Selecting a managed backend Hezo cannot reach is fatal at startup - it never falls back to local Docker. |
| `--daytona-api-key <key>` | `HEZO_DAYTONA_API_KEY` | - | Daytona API key. Required when `--sandbox-backend` is `daytona`. Used only by Hezo itself to reach the provider - it is never placed inside an agent container. |
| `--daytona-api-url <url>` | `HEZO_DAYTONA_API_URL` | Daytona's public API | Daytona API base URL, for a regional or self-hosted endpoint. |
| `--master-key <phrase>` | `HEZO_MASTER_KEY` | - | The twelve-word master key, to set up or unlock without the web gate. |
| `--web-url <url>` | `HEZO_WEB_URL` | same origin | Public base URL, used so account sign-ins redirect back correctly. |
| `--reset` | `HEZO_RESET` | off | Start fresh with an empty **embedded** database (the existing `pgdata` is renamed aside, not deleted). Not applicable with `--database-url` - recreate an external database with your provider's tools. |
| `--no-open` | `HEZO_OPEN` | on | Auto-open the web app in your browser on startup. On by default; automatically skipped in environments without a browser (CI, containers, SSH, headless Linux). Pass `--no-open` or set `HEZO_OPEN=0` to disable. |
| `--log-level <level>` | `HEZO_LOG_LEVEL` | `info` | Logging verbosity: `debug`, `info`, `warn`, or `error`. |
| `--keep-old-containers` | `HEZO_KEEP_OLD_CONTAINERS` | off | Keep old project containers instead of removing them - for debugging a crashed container. |
| `--no-egress-proxy-auth` | `HEZO_EGRESS_PROXY_AUTH` | on | Per-run egress-proxy authentication. On by default: each run's `HTTP(S)_PROXY` URL carries a random token the proxy verifies before substituting any secret, so a process that reaches the proxy address can't drive substitution for another run. Only disable to unblock a runtime whose HTTP client can't send proxy credentials - the secret red line still holds either way (an unauthenticated caller only ships unsubstituted placeholders, which fail upstream). Pass `--no-egress-proxy-auth` or set `HEZO_EGRESS_PROXY_AUTH=0`. |
| `--version` | - | - | Print the Hezo version and exit (also `hezo version`). |
| `--disable-telemetry` | `HEZO_TELEMETRY_ENABLED` | on | Turn off the anonymous daily usage report (see [Anonymous usage telemetry](#anonymous-usage-telemetry)). On by default; pass `--disable-telemetry` or set `HEZO_TELEMETRY_ENABLED=0`. |
| `--telemetry-endpoint <url>` | `HEZO_TELEMETRY_ENDPOINT` | `https://hezo.ai/api/telemetry` | Where the daily report is sent. Point it at your own collector to keep the data in-house. |
| - | `HEZO_TELEMETRY_CRON` | `0 0 5 * * *` | Cron schedule (seconds-precision) for the daily telemetry report. |
| - | `HEZO_DISABLE_AUTO_UPDATE` | off | Disable the in-app auto-update (release check, the background download, and the "Install & restart" banner). When disabled the banner instead links to the GitHub release page. |
| - | `HEZO_UPDATE_CHECK_CRON` | `0 0 4 * * *` | Cron schedule (seconds-precision) for the daily check that downloads and stages a newer release. A running instance also stages as soon as it detects an update, so the banner's "Install & restart" is instant. |
| `--auto-install-updates` | `HEZO_AUTO_INSTALL_UPDATES` | off | Install staged updates automatically: once a newer release is downloaded and verified, Hezo gracefully restarts onto it without waiting for "Install & restart" in the web UI. The restart is deferred while agent runs are in flight, and only happens where in-app auto-update is available at all (the self-managed binary - not inside a container). The instance comes back **unlocked**: the unlock key is handed to the new process in memory, never written to disk. See [Updating](/docs/deployment/self-hosting#updating). |
| - | `HEZO_AUTO_INSTALL_CRON` | `0 */5 * * * *` | Cron schedule (seconds-precision) for the auto-install check that restarts onto a staged update once no agent runs are in flight. Only registered when auto-install is enabled. |
| - | `HEZO_PRICING_REFRESH_CRON` | `0 0 2 * * *` | Cron schedule (seconds-precision) for the daily model-pricing refresh from [pricepertoken.com](https://pricepertoken.com). Pricing also refreshes at startup; a failed refresh keeps the existing rates. |

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

Pass `HEZO_MASTER_KEY` inline like this only for a one-off launch - **never persist it**
to an env file, a service definition, or anywhere on the host. The master key is kept in
memory only so a copy of your disk can't decrypt your data; writing it to disk defeats
that. See [Master key & encryption](/docs/security/master-key).

## Using an external Postgres

By default Hezo embeds its database inside the single binary and stores it under the data
directory - no external database to run. If you'd rather use a managed/hosted Postgres
(for managed backups, more headroom, or your own operational tooling), point Hezo at it
(this section is the reference; for a walkthrough on a cloud server see
[Managed database & asset storage](/docs/deployment/cloud#managed-database--asset-storage)
or, for the cloud-init deploy,
[Using managed data hosting](/docs/deployment/one-click#using-managed-data-hosting)):

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
  network and live with the provider. Set `sslmode` deliberately - see
  [TLS and sslmode](#tls-and-sslmode) for what each mode does and does not protect against.
  [Secrets remain encrypted](/docs/concepts/your-data) with the master key either way.
- **Keep the database close to the server.** Hezo's background scheduling polls every
  1-5 seconds, so every millisecond of round-trip latency counts. Same-host,
  same-VPC, or same-region placement is strongly recommended.
- **Direct connections or session pooling only.** Transaction-pooling proxies
  (PgBouncer in transaction mode) break session-scoped advisory locks.
- **One Hezo server per database.** Concurrent startups coordinate migrations safely,
  but running two live servers against one database is not supported.
- The connection string carries credentials: prefer the environment variable over the
  flag (flags are visible in the process list), and never commit it to a repo.
- `hezo backup` / `hezo restore` work against an external database too - including
  **moving an existing embedded instance to hosted Postgres** (and back). See
  [Backup & recovery](/docs/deployment/backup-and-recovery).

### TLS and sslmode

Hezo reads `sslmode` from the connection string exactly as `psql` and libpq do, so a
connection string copied from your provider's dashboard behaves the same way in Hezo as
it does in any other Postgres client:

| `sslmode` | Encrypted | Certificate verified | Notes |
|---|---|---|---|
| *(omitted)* | No | - | **Plaintext.** There is no implicit TLS - set `sslmode` explicitly. |
| `disable` | No | - | Plaintext. Only over a trusted private network. |
| `prefer` | Yes | No | Same protection as `require` in Hezo. |
| `require` | Yes | No | Encrypted, but an interceptor can present any certificate. |
| `verify-ca` | Yes | Chain only | Needs `sslrootcert`. The host name is not checked. |
| `verify-full` | Yes | Chain + host name | **Recommended.** |
| `no-verify` | Yes | No | Same as `require`; accepted for compatibility. |

Hezo logs the mode it resolved on every start, so you can confirm what you actually got:

```
Using external Postgres at postgres://••••:••••@db.internal:5432/hezo?sslmode=require
  (server 16.4, pool max 10, TLS encrypted, certificate not verified ...)
```

**Verifying against a provider-private CA.** Managed Postgres (DigitalOcean, AWS RDS,
Azure) and most self-hosted servers present a certificate signed by their own CA rather
than a public one, so `verify-full` on its own fails with *"self signed certificate in
certificate chain"*. Download the provider's CA certificate and point `sslrootcert` at
it - this is the recommended setup:

```sh
# DigitalOcean: Databases → your cluster → Connection details → Download CA certificate
sudo install -m 644 ca-certificate.crt /etc/hezo/db-ca.crt

HEZO_DATABASE_URL="postgres://hezo:••••@db-postgresql-lon1-12345-do-user-0.db.ondigitalocean.com:25060/hezo?sslmode=verify-full&sslrootcert=/etc/hezo/db-ca.crt" \
  hezo --data-dir /var/lib/hezo
```

The `PGSSLMODE` environment variable is honoured only when the connection string carries
no `sslmode` of its own, and node-postgres reads it strictly (every verifying mode means
full verification). Put `sslmode` in the URL rather than relying on it.

## Storing assets in S3-compatible object storage

By default, uploaded [asset](/docs/concepts/assets) files (task attachments and the
project assets library) live on the local filesystem under `<data-dir>/assets/`. To keep
them in a bucket instead - for managed durability, or to keep the host closer to
stateless - point Hezo at any **S3-compatible** store (deployment walkthroughs:
[Managed database & asset storage](/docs/deployment/cloud#managed-database--asset-storage)
and [Using managed data hosting](/docs/deployment/one-click#using-managed-data-hosting)):

```sh
HEZO_ASSET_STORAGE_URL="s3://ACCESS_KEY:SECRET@s3.eu-west-1.amazonaws.com/my-bucket/hezo-assets?region=eu-west-1" \
  hezo --data-dir /var/lib/hezo
```

One URL carries the whole configuration:

```
s3://ACCESS_KEY:SECRET@endpoint[:port]/bucket[/prefix]?region=…&pathStyle=…&tls=…
```

- **`endpoint`** - the storage host. AWS S3, MinIO, Cloudflare R2, DigitalOcean Spaces,
  Backblaze B2, and anything else that speaks the S3 API all work; only the S3 protocol
  is supported (no provider-native APIs).
- **`bucket[/prefix]`** - the bucket, plus an optional key prefix if the bucket is shared
  with other data. Objects are stored as `[prefix/]<project-id>/<asset-id>`.
- **`region`** - defaults to `us-east-1` (many S3-compatible stores accept any value).
- **`pathStyle`** - defaults to `true` for custom endpoints (MinIO and friends) and
  `false` (virtual-hosted addressing) for `*.amazonaws.com`.
- **`tls`** - defaults to `true`; set `tls=false` only for local/dev endpoints.
- Percent-encode any `/`, `+`, or `@` characters inside the access key or secret.

At startup Hezo verifies it can reach the bucket with the given credentials and exits
with guidance if it can't. The active backend (with credentials occluded) is shown under
**Settings → Storage → Asset storage**.

Recommendations:

- **Use TLS and a private bucket.** Asset bytes are served through the Hezo server with
  signed URLs - the bucket never needs to be publicly readable. Assets are stored as
  plain objects, so enable your provider's server-side encryption if you want them
  encrypted at rest.
- **One Hezo server per bucket/prefix.** Two live servers sharing a prefix is not
  supported (same posture as the database).
- The URL carries credentials: prefer the environment variable over the flag (flags are
  visible in the process list), and never commit it to a repo.

### Switching an existing instance

`hezo backup` / `hezo restore` move an instance's assets between local storage and a bucket
for you - they carry the database in the same backup bundle, so one pair of commands moves
the whole instance (see [Backup & recovery](/docs/deployment/backup-and-recovery)). To move
existing assets into a bucket:

1. Stop the server.
2. Back up the instance: `hezo backup --output move/`. If your data directory isn't the
   default, point the command at it - `hezo backup` reads `HEZO_DATA_DIR` (so a deployment
   that already sets it needs nothing extra), or pass `--data-dir`. This writes the
   database and every asset file into `move/`.
3. Restore into the bucket: `hezo restore move/ --asset-storage-url "s3://…"` - add
   `--database-url` as well if you're also moving to hosted Postgres. Restored blobs are
   checksum-verified against the database rows.
4. Start the server with `HEZO_ASSET_STORAGE_URL` set.

Moving back to local storage is the same, restoring without `--asset-storage-url`. The
backup only reads the source, so your original assets stay in place until you remove them
yourself.

Because the local `<data-dir>/assets/` layout and the bucket keys are identical
(`<project-id>/<asset-id>`), you can alternatively sync the tree directly with any S3 tool
while the server is stopped - `aws s3 sync /var/lib/hezo/assets/ s3://my-bucket/hezo-assets/`
(or `rclone sync`).

## Running agent containers on a managed sandbox service

Every agent run executes inside a container. By default that container runs on the local
Docker daemon, which is why Docker is a prerequisite for a normal install. Setting
These flags choose what a **brand-new** instance starts on. After that the setting in
Settings -> Containers is what counts, and you can switch service (or switch back to local
Docker) there at any time without restarting - see
[Remote sandboxes](/docs/deployment/remote-sandboxes).

`--sandbox-backend` (or `HEZO_SANDBOX_BACKEND`) moves those containers onto a managed
sandbox service instead, and Docker stops being required at all.

[Remote sandboxes](/docs/deployment/remote-sandboxes) covers what changes when you do:
how a container reaches your instance, what stays on your side, and what is not available
there. This section is the configuration itself.

Today the one managed backend is **Daytona**:

```sh
hezo --sandbox-backend daytona --daytona-api-key "dtn_..."
```

or, as environment variables:

```sh
HEZO_SANDBOX_BACKEND=daytona
HEZO_DAYTONA_API_KEY=dtn_...
HEZO_DAYTONA_API_URL=https://app.daytona.io/api   # optional: a regional endpoint
```

Add `--daytona-api-url` (or `HEZO_DAYTONA_API_URL`) only if you are pointed at a regional
or self-hosted endpoint; it defaults to Daytona's public API.

**All of it is deployment configuration**, set before the server starts - there is no
setting for it in the web UI, and the API key does not go in the secrets vault. The
General settings page shows which backend is in use, read-only, next to the database and
asset backends.

### It is fatal, never a silent fallback

If you select a managed backend and Hezo cannot reach it - no key, a rejected key, or an
unreachable API - the server **refuses to start** and prints what to check. It never
quietly runs your agents on local Docker instead.

This is deliberate, and matches how an external database and S3 asset storage already
behave. An instance that silently degraded would look perfectly healthy while doing
something you did not ask for, and the first sign of trouble would be an agent run failing
for no visible reason.

Startup retries briefly first (a couple of seconds, twice), so a provider that is
restarting does not kill a boot.

### What the API key can reach

The Daytona API key is used **only by Hezo itself**, to create and manage sandboxes. It is
never placed inside an agent container, never written into a container's environment, and
never logged - the same handling as your database password and S3 credentials. Hezo also
does not use the provider's own secret storage: your credentials stay in Hezo's encrypted
vault and are substituted into agent requests by Hezo's egress proxy, exactly as they are
on a local Docker install.

## Anonymous usage telemetry

To help us understand how Hezo is used across self-hosted installs, each instance sends a
small **anonymous** usage report once a day. It is **on by default** and easy to turn off.

**What's sent** - aggregate counts only:

- a random per-install id (a UUID generated on first report - it lets reports from the same
  install be counted once across days; it is not derived from you, your machine, or your data),
- the Hezo version, operating system, and CPU architecture,
- totals: number of teams, projects, and agents,
- task counts by status, and how many tasks were completed in the last 24 hours,
- agent-run count and total input/output **tokens** over the last 24 hours,
- the mix of AI providers used (e.g. how many runs used Anthropic vs. OpenAI).

**What's never sent** - project, team, or task names; prompts or any task content; repository
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

- [CLI reference](/docs/reference/cli) - commands and usage.
- [Backup & recovery](/docs/deployment/backup-and-recovery) - `--reset` and restoring.
- [First-run setup](/docs/getting-started/first-run) - the master key.
