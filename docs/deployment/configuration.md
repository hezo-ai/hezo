---
title: Configuration reference
order: 29
section: Deployment
---

# Configuration reference

Hezo is configured with a **config file** you point at with `--config`, and with
**command-line flags**. A flag always wins over the file, and anything neither sets falls
back to the built-in default.

```sh
hezo --config /etc/hezo/hezo.config.cjs
```

There is no automatic search: without `--config`, Hezo runs on the defaults plus whatever
flags you pass. The one setting that is never read from the file is the master key - see
[The master key is not a config setting](#the-master-key-is-not-a-config-setting).

## The config file

The file is a CommonJS module that exports an object:

```js
// /etc/hezo/hezo.config.cjs
module.exports = {
  port: 3100,
  dataDir: '/var/lib/hezo',
  webUrl: 'https://hezo.example.com',

  database: { url: 'postgres://hezo:PASSWORD@db-host:5432/hezo?sslmode=verify-full' },
  assetStorage: { url: 's3://ACCESS_KEY:SECRET@endpoint/bucket' },
};
```

Only name the settings you want to change; everything else keeps its default. Because it is
real JavaScript, it can compute values at load time - reading a side file, or branching on
the host name:

```js
const { existsSync, readFileSync } = require('node:fs');
const webUrlFile = '/etc/hezo/web-url';

module.exports = {
  dataDir: '/var/lib/hezo',
  webUrl: existsSync(webUrlFile) ? readFileSync(webUrlFile, 'utf8').trim() : '',
};
```

A misspelled or unknown key is an **error naming the key**, not something quietly ignored,
so a typo cannot leave you running a setting you thought you had changed.

**Give the file mode 600 if it carries credentials.** `database.url`,
`assetStorage.url` and `containers.daytona.apiKey` are secrets:

```sh
sudo install -d -m 700 /etc/hezo
sudo install -m 600 /dev/null /etc/hezo/hezo.config.cjs
```

## Options

Nested keys are written in dot form below: `database.url` means
`{ database: { url: '...' } }`.

### Core

| Setting | Flag | Default | Description |
|---|---|---|---|
| - | `--config <path>` | - | Path to the config file. Without it, only defaults and flags apply. |
| `port` | `--port <port>` | `3100` | Port the server and web app listen on (1-65535). |
| `dataDir` | `--data-dir <path>` | `~/.hezo/` | Where Hezo stores its database, encrypted secrets, and assets. Still required with an external database or S3 asset storage - workspaces and keys live here. |
| `webUrl` | `--web-url <url>` | same origin | Public base URL, used so account sign-ins redirect back correctly. |
| `logLevel` | `--log-level <level>` | `info` | Logging verbosity: `debug`, `info`, `warn`, or `error`. |
| `open` | `--no-open` | on | Auto-open the web app in your browser on startup. Automatically skipped in environments without a browser (CI, containers, SSH, headless Linux). Also governs the Windows dialog shown when no container runtime is installed. |
| - | `--reset` | off | Start fresh with an empty **embedded** database (the existing `pgdata` is renamed aside, not deleted). A flag only - see [Why `reset` is not a config setting](#why-reset-is-not-a-config-setting). Not applicable with an external database - recreate that with your provider's tools. |
| - | `--version` | - | Print the Hezo version and exit (also `hezo version`). |

### Database

| Setting | Flag | Default | Description |
|---|---|---|---|
| `database.url` | `--database-url <url>` | - | Connection string for an [external Postgres](#using-an-external-postgres) (`postgres://user:password@host:5432/hezo`). Its `sslmode` follows standard libpq rules - see [TLS and sslmode](#tls-and-sslmode). Omit to use the embedded database under the data directory (the default). |
| `database.poolSize` | - | `10` | Connection-pool size for the external database (2-100). Ignored for the embedded database. |

### Asset storage

| Setting | Flag | Default | Description |
|---|---|---|---|
| `assetStorage.url` | `--asset-storage-url <url>` | - | [S3-compatible object storage](#storing-assets-in-s3-compatible-object-storage) for asset files (`s3://KEY:SECRET@endpoint/bucket[/prefix]`). Omit to store assets on the local filesystem under the data directory (the default). |

### Containers

| Setting | Flag | Default | Description |
|---|---|---|---|
| `containers.backend` | `--sandbox-backend <name>` | `docker` | Where agent containers run on a **new** instance: `docker` (the local daemon) or `daytona` (a [managed sandbox service](#running-agent-containers-on-a-managed-sandbox-service)). Once set in Settings -> Containers, the stored choice wins and this is ignored. Selecting a managed backend Hezo cannot reach is fatal at startup - it never falls back to local Docker. |
| `containers.daytona.apiKey` | `--daytona-api-key <key>` | - | Daytona API key. Required when the backend is `daytona`. Used only by Hezo itself to reach the provider - it is never placed inside an agent container. |
| `containers.daytona.apiUrl` | `--daytona-api-url <url>` | Daytona's public API | Daytona API base URL, for a regional or self-hosted endpoint. |
| `containers.dockerSocket` | `--docker-socket <path>` | auto | Path to the container runtime's Unix socket. By default Hezo finds it: `DOCKER_HOST`, then the docker CLI's current context, then the well-known path for each supported runtime (Docker Engine/Desktop, Colima, Rancher Desktop, OrbStack, Lima, rootless Docker). Set it only when the daemon listens somewhere none of those cover. Unix sockets only - `tcp://` and `npipe://` are not supported. See [Container runtimes](/docs/deployment/container-runtimes). |
| `containers.dockerRequestTimeoutMs` | - | `10000` | Ceiling on a single call to the Docker daemon, so a wedged one cannot stall the container-sync loop. Raise it for a slow host. |
| `containers.keepOld` | `--keep-old-containers` | off | Keep old project containers instead of removing them - for debugging a crashed container. |
| `containers.skipMountCheck` | - | off | Skip the boot check that verifies agent containers get a writable view of the data directory. The check is a diagnosis, not a dependency - skipping it hides the warning, it does not make a read-only mount work. |
| `containers.agentBaseImage` | - | the release's published image | Container image every project's agents run in, overriding the default for this instance. Must be a reference the backend in use can pull, e.g. `ghcr.io/hezo-ai/agent-base:0.42.0`. Mainly for running a development server against a managed sandbox service, where the default is built into the local Docker daemon and a managed service has nothing to pull. A project that names its own base image keeps it. |
| - | `DOCKER_HOST` (environment) | - | Standard Docker environment variable, honoured when it points at a `unix://` socket. Takes effect only if `containers.dockerSocket` / `--docker-socket` is unset. |

### Egress

| Setting | Flag | Default | Description |
|---|---|---|---|
| `egress.allowPrivateTargets` | `--egress-allow-private-targets` | off | Allow agent egress through the proxy to reach loopback, link-local and private (RFC1918) addresses. Blocked by default: the proxy runs on the host, so without the guard an agent could tunnel to Hezo's own API, its database, or any host-bound daemon. The check is made on the address a hostname resolves to, not on the name. Enable only when an MCP server or git remote your agents genuinely need lives on your LAN. |
| `egress.proxyAuth` | `--no-egress-proxy-auth` | on | Per-run egress-proxy authentication. On by default: each run's `HTTP(S)_PROXY` URL carries a random token the proxy verifies before substituting any secret, so a process that reaches the proxy address can't drive substitution for another run. Only disable to unblock a runtime whose HTTP client can't send proxy credentials - the secret red line still holds either way (an unauthenticated caller only ships unsubstituted placeholders, which fail upstream). |
| `egress.debug` | - | off | Per-connection proxy lifecycle tracing. Diagnostic only, and very noisy. |

### Telemetry and updates

| Setting | Flag | Default | Description |
|---|---|---|---|
| `telemetry.enabled` | `--disable-telemetry` | on | The anonymous daily usage report (see [Anonymous usage telemetry](#anonymous-usage-telemetry)). Pass `--disable-telemetry` or set `telemetry.enabled: false`. |
| `telemetry.endpoint` | `--telemetry-endpoint <url>` | `https://hezo.ai/api/telemetry` | Where the daily report is sent. Point it at your own collector to keep the data in-house. |
| `updates.disabled` | - | off | Disable the in-app auto-update (release check, the background download, and the "Install & restart" banner). When disabled the banner instead links to the GitHub release page. |
| `updates.autoInstall` | `--auto-install-updates` | off | Install staged updates automatically: once a newer release is downloaded and verified, Hezo gracefully restarts onto it without waiting for "Install & restart" in the web UI. The restart is deferred while agent runs are in flight, and only happens where in-app auto-update is available at all (the self-managed binary - not inside a container). The instance comes back **unlocked**: the unlock key is handed to the new process in memory, never written to disk. See [Updating](/docs/deployment/self-hosting#updating). |

### Marketplace and connectors

| Setting | Flag | Default | Description |
|---|---|---|---|
| `marketplace.ref` | - | `main` | Git ref the [team marketplace](/docs/concepts/marketplace) is fetched from. Point it at a branch or tag to pin the catalog. |
| `marketplace.baseUrl` | - | `https://raw.githubusercontent.com` | Base URL the marketplace is fetched from, for a fork or an internal mirror. |
| `github.oauthClientId` | - | Hezo's public OAuth app | Client id for the GitHub connector's device flow. Register your own GitHub OAuth app and name it here to keep the authorization under your own organization's control. |

### Background job schedules

All schedules are **seconds-precision six-field** cron expressions
(`second minute hour day month weekday`). The defaults suit a normal instance; change one
only when you have a reason to.

| Setting | Default | Description |
|---|---|---|
| `jobs.wakeupCron` | `*/5 * * * * *` | Delivery of queued agent wakeups. |
| `jobs.heartbeatCron` | `*/5 * * * * *` | Scan for agents whose heartbeat interval is due. |
| `jobs.wakeupCoalescingMs` | `2000` | Window in which repeated wakeups for one agent collapse into a single run. |
| `jobs.heartbeatCooldownSec` | `60` | Quiet window after a run before that agent is heartbeat-eligible again. Prevents back-to-back runs when the configured interval is shorter than the run itself. |
| `jobs.heartbeatFloorMin` | `60` | Lowest heartbeat cadence the scheduler honours, in minutes. Raising it clamps every agent up to it, and the web UI's cadence options will under-report the new floor. |
| `jobs.containerSyncCron` | `* * * * * *` | Container status reconciliation. Every second keeps the dashboard snappy; slow it down on a CPU-starved host. |
| `jobs.containerIdleStopCron` | `15 * * * * *` | Idle-container reaper. |
| `jobs.orphanDetectionCron` | `*/30 * * * * *` | Detection of runs whose container disappeared. |
| `jobs.orphanContainerSweepCron` | `45 */10 * * * *` | Removal of containers this instance created that no project points at any more. On a managed backend an orphan bills until it is swept. |
| `jobs.connectorHealthCron` | `0 */5 * * * *` | OAuth token renewal and hosted-connector re-probing. |
| `jobs.budgetResumeCron` | `*/30 * * * * *` | Re-evaluation of budget-paused agents, so a rolling window that has rolled over frees them. |
| `jobs.inboxArchiveCron` | `0 0 3 * * *` | Inbox archiving sweep. |
| `jobs.inboxRetentionDays` | `30` | How long archived inbox items are kept, in days. |
| `jobs.pricingRefreshCron` | `0 0 2 * * *` | Daily model-pricing refresh from [pricepertoken.com](https://pricepertoken.com). Pricing also refreshes at startup; a failed refresh keeps the existing rates. |
| `jobs.modelPinRefreshCron` | `0 0 3 * * *` | Daily re-read of each connected provider's model catalog, which keeps the model a **newly added** connection starts on current. Connections you already have keep the model you chose. A provider Hezo cannot reach keeps its previous default. |
| `jobs.updateCheckCron` | `0 0 4 * * *` | Daily check that downloads and stages a newer release. A running instance also stages as soon as it detects an update, so the banner's "Install & restart" is instant. |
| `jobs.autoInstallCron` | `0 */5 * * * *` | Auto-install check that restarts onto a staged update once no agent runs are in flight. Only registered when `updates.autoInstall` is on. |
| `jobs.telemetryCron` | `0 0 5 * * *` | Daily telemetry report. |
| `jobs.dbMaintenanceCron` | `0 30 4 * * *` | Planner-statistics refresh and scheduler bookkeeping sweep. |

### Run-log compaction

Compaction is started by an operator from the Storage settings page; these control how it
drains once running. Nothing here starts a pass on its own.

| Setting | Default | Description |
|---|---|---|
| `logCompaction.cron` | `*/10 * * * * *` | Drain tick. Cheap when idle - it only does work while a pass is active. |
| `logCompaction.batch` | `50` | Runs compacted per batch. |
| `logCompaction.maxPerTick` | `500` | Runs compacted per tick before yielding to the next. |
| `logCompaction.preservedBytes` | `12288` | Trailing bytes of each old run's log kept - the slice holding the end-of-run summary and the token/cost line. Everything before it is discarded. |

### Settings fixed by the deployer

Where someone other than the person using an instance decides its limits - a
managed service, or an IT team that fixes them for a group - those settings can
be **pinned** from the config file. A pinned setting is read from the config
instead of from the database, renders locked in the UI with the name of whoever
fixed it, and is refused with a `409` if changed through the API. Nothing is
pinned unless you say so, so an ordinary instance is unaffected.

| Setting | Default | Description |
|---|---|---|
| `policy.managedBy` | - | Who fixed these settings, as shown to the operator. Required when `policy` is set. |
| `policy.manageUrl` | - | Where to change them. Must be `https:`. Omit it to lock the settings with no link. |
| `policy.pinned.maxContainerMemoryGb` | - | Fixes the instance-wide container memory budget. |
| `policy.pinned.defaultRamCapPerContainerGb` | - | Fixes the per-container RAM cap. |
| `policy.pinned.defaultContainerDiskGb` | - | Fixes the per-container disk size. |
| `policy.pinned.monthlyContainerHours` | - | Fixes the monthly container-hours allowance. `0` pins "no limit". |
| `policyFile` | - | Path to a JSON file holding the `policy` block. The file wins over an inline block, and is re-read when it changes. |

Each key under `pinned` is independent: pin the memory budget and leave disk to
the operator if that is what you mean.

```js
module.exports = {
  policy: {
    managedBy: 'Acme Cloud',
    manageUrl: 'https://acme.example/account/plan',
    pinned: { maxContainerMemoryGb: 16, monthlyContainerHours: 100 },
  },
};
```

**Use `policyFile` when the limits change while the instance runs.** A plan change
must not need a restart - a restart kills in-flight agent runs, and under an
hours meter that is billed compute thrown away. Hezo watches the file and picks
up a change on the next setting it reads, without restarting anything. Write it
by renaming a temporary file into place (`policy.json.tmp`, then `rename`), which
is atomic, so Hezo can never read a half-written file. If a read or a parse does
fail, the previous limits stay in force rather than silently unpinning.

## The master key is not a config setting

The master key is **never** read from the config file, and Hezo rejects a `masterKey` key
with an error rather than accepting it. It is kept in memory only, which is what makes
encryption at rest meaningful: a copy of the key on disk next to the encrypted data would
let anyone who reads the host decrypt your vault.

Hezo starts **locked** by design; you unlock it from the browser gate. To unlock a single
non-interactive startup, pass the phrase to that one invocation with `HEZO_MASTER_KEY` (an
environment variable rather than a flag, because flags are visible in the process list):

```sh
HEZO_MASTER_KEY="your twelve word master key phrase here" hezo --config /etc/hezo/hezo.config.cjs
```

Never persist it - not to a config file, an env file, a service definition, or a shell
profile. See [Master key & encryption](/docs/security/master-key).

## Why `reset` is not a config setting

`--reset` renames the existing embedded `pgdata` aside and starts with an empty database.
That is a one-off action, so it is a flag only and Hezo rejects a `reset` key in the config
file: a persistent file carrying it would wipe your database on **every** restart rather
than once.

## Examples

Run on a custom port with a dedicated data directory:

```sh
hezo --port 8080 --data-dir /var/lib/hezo
```

Unlock a single startup non-interactively by passing the master key to that one
invocation (Hezo normally starts **locked** and you unlock from the browser gate):

```js
// /etc/hezo/hezo.config.cjs
module.exports = {
  dataDir: '/var/lib/hezo',
  webUrl: 'https://hezo.example.com',
};
```

```sh
HEZO_MASTER_KEY="your twelve word master key phrase here" \
  hezo --config /etc/hezo/hezo.config.cjs
```

Pass `HEZO_MASTER_KEY` inline like this only for a one-off launch - **never persist it**
to the config file, an env file, a service definition, or anywhere on the host. The master
key is kept in memory only so a copy of your disk can't decrypt your data; writing it to
disk defeats that. See [Master key & encryption](/docs/security/master-key).

## Using an external Postgres

By default Hezo embeds its database inside the single binary and stores it under the data
directory - no external database to run. If you'd rather use a managed/hosted Postgres
(for managed backups, more headroom, or your own operational tooling), point Hezo at it
(this section is the reference; for a walkthrough on a cloud server see
[Managed database & asset storage](/docs/deployment/cloud#managed-database--asset-storage)
or, for the cloud-init deploy,
[Using managed data hosting](/docs/deployment/one-click#using-managed-data-hosting)):

```js
// /etc/hezo/hezo.config.cjs
module.exports = {
  dataDir: '/var/lib/hezo',
  database: { url: 'postgres://hezo:••••@db.internal:5432/hezo?sslmode=verify-full' },
};
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
- The connection string carries credentials: prefer the config file over the flag (flags
  are visible in the process list), give the file mode 600, and never commit it to a repo.
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
```

```js
// /etc/hezo/hezo.config.cjs
module.exports = {
  dataDir: '/var/lib/hezo',
  database: {
    url: 'postgres://hezo:••••@db-postgresql-lon1-12345-do-user-0.db.ondigitalocean.com:25060/hezo?sslmode=verify-full&sslrootcert=/etc/hezo/db-ca.crt',
  },
};
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

```js
// /etc/hezo/hezo.config.cjs
module.exports = {
  dataDir: '/var/lib/hezo',
  assetStorage: {
    url: 's3://ACCESS_KEY:SECRET@s3.eu-west-1.amazonaws.com/my-bucket/hezo-assets?region=eu-west-1',
  },
};
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
- The URL carries credentials: prefer the config file over the flag (flags are visible in
  the process list), give the file mode 600, and never commit it to a repo.

### Switching an existing instance

`hezo backup` / `hezo restore` move an instance's assets between local storage and a bucket
for you - they carry the database in the same backup bundle, so one pair of commands moves
the whole instance (see [Backup & recovery](/docs/deployment/backup-and-recovery)). To move
existing assets into a bucket:

1. Stop the server.
2. Back up the instance: `hezo backup --output move/`. If your data directory isn't the
   default, point the command at it - `hezo backup` accepts the same `--config` as the
   server (so a deployment that already has a config file needs only that), or pass
   `--data-dir`. This writes the database and every asset file into `move/`.
3. Restore into the bucket: `hezo restore move/ --asset-storage-url "s3://…"` - add
   `--database-url` as well if you're also moving to hosted Postgres. Restored blobs are
   checksum-verified against the database rows.
4. Start the server with `assetStorage.url` set in your config file.

Moving back to local storage is the same, restoring without `--asset-storage-url`. The
backup only reads the source, so your original assets stay in place until you remove them
yourself.

Because the local `<data-dir>/assets/` layout and the bucket keys are identical
(`<project-id>/<asset-id>`), you can alternatively sync the tree directly with any S3 tool
while the server is stopped - `aws s3 sync /var/lib/hezo/assets/ s3://my-bucket/hezo-assets/`
(or `rclone sync`).

## Running agent containers on a managed sandbox service

Every agent run executes inside a container. By default that container runs on the local
Docker daemon, which is why a Docker-compatible runtime is a prerequisite for a normal
install. `--sandbox-backend` (or `containers.backend`) starts a **brand-new** instance on
a managed sandbox service instead, and Docker stops being required at all.

These only choose what a brand-new instance starts on. The first startup records the
choice, and from then on the stored setting wins: the launch settings are ignored on later
startups - Hezo logs that it ignored them if they disagree - so restarting with a different
config file never switches an existing instance. Switching, in either direction, is done
from Settings -> Containers at any time, no restart needed. See
[Switching at any time](/docs/containers/overview#switching-at-any-time).

[Remote containers](/docs/containers/remote/overview) covers what changes when you do:
how a container reaches your instance, what stays on your side, and what is not available
there; [Daytona](/docs/containers/remote/daytona) carries that provider's own limits. This
section is the configuration itself.

Today the one managed backend is **Daytona**:

```sh
hezo --sandbox-backend daytona --daytona-api-key "dtn_..."
```

or, in the config file:

```js
module.exports = {
  containers: {
    backend: 'daytona',
    daytona: {
      apiKey: 'dtn_...',
      apiUrl: 'https://app.daytona.io/api', // optional: a regional endpoint
    },
  },
};
```

Set `apiUrl` (or `--daytona-api-url`) only if you are pointed at a regional or self-hosted
endpoint; it defaults to Daytona's public API.

The provider API key is stored **encrypted in the secrets vault** and read only by Hezo
itself to drive the provider's control plane - it never enters an agent container.
Because it is encrypted, a restarted instance reconnects to the provider once you
unlock; a key passed at startup is used straight away and saved once you unlock. The
Containers settings page names the service in use and is also where you replace an
expired or revoked key - see
[Restarting an instance on a managed service](/docs/containers/overview#restarting-an-instance-on-a-managed-service).

### The agent image on a managed backend

A released Hezo pulls its agent image from a public registry, so this needs no thought:
the managed service pulls the same image your local Docker would.

A **development server** is the exception, and it is worth knowing before you try it.
Running from source, Hezo builds the agent image into your local Docker daemon from the
Dockerfile in your working tree - which is what makes edits to it take effect on the next
restart. A managed sandbox service cannot see that image; it pulls from a registry. So
point the instance at a published image instead:

```js
module.exports = {
  containers: {
    backend: 'daytona',
    agentBaseImage: 'ghcr.io/hezo-ai/agent-base:0.42.0',
    daytona: { apiKey: 'dtn_...' },
  },
};
```

That applies to every project. A project that names its own base image on its Container
settings keeps it. Without it, Hezo refuses at provision time with a message saying so,
rather than letting the provider fail the build against an image it cannot find.

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

**Turn it off** with the flag or the config file:

```sh
hezo --disable-telemetry
```

```js
module.exports = { telemetry: { enabled: false } };
```

You can also keep the data in-house by pointing `--telemetry-endpoint` (or
`telemetry.endpoint`) at your own collector.

## See also

- [CLI reference](/docs/reference/cli) - commands and usage.
- [Backup & recovery](/docs/deployment/backup-and-recovery) - `--reset` and restoring.
- [First-run setup](/docs/getting-started/first-run) - the master key.
