# Hosted Hezo — Architecture

**Status (2026-08).** Written 2026-05/06 (#397, #594) and not built: none of the
*Hezo-core changes* below exists in the tree. The analysis still holds - every seam it
names still resolves - so this remains the design of record for hosted, not a historical
note.

This document is the single reference for the hosted, click-to-signup version of
Hezo: the tenant topology, storage, SSO/unlock design, the control plane at
`app.hezo.ai`, DigitalOcean provisioning, the (small) set of Hezo-core changes,
and the build phasing. It is a design reference for a build-out that lives
mostly *outside* this repo; the core changes it requires are enumerated in
§ "Hezo-core changes".

- **Product shape:** a user signs up at `app.hezo.ai`, gets their own always-on
  Hezo instance at `username.app.hezo.ai`, and is signed in to it from the
  control plane with no separate instance password. Billing, login, and account
  management live at `app.hezo.ai`.
- **Goal:** scale to ~100 users with the least effort, keeping the Hezo core
  as close to unmodified as possible.
- **Threat model:** untrusted / open signup. Anyone can sign up and run
  arbitrary agent code. The isolation boundary must hold against a malicious
  tenant.
- **Availability:** every tenant instance is **always-on**. A signed-up user
  expects their Hezo to keep doing background work (agents picking up tasks,
  heartbeat wakeups) whether or not they are attending to it. Instances are
  **not** transient and must not scale to zero.

## Recommendation: instance-per-tenant

**One isolated Hezo instance per user — a dedicated VM running the stock
`hezo` binary with its own Docker daemon — orchestrated by a thin control
plane. Do not build a single-DB multi-tenant rewrite.**

For untrusted signup, the single-DB rewrite loses on *both* axes: it is a very
large rewrite **and** it yields a weaker security boundary. Instance-per-tenant
requires only a small, additive set of core changes (SSO endpoint + config);
the real new work is the control plane around an unmodified binary.

### Why — what the code forces

Hezo is single-tenant by design at three independent layers:

1. **The data model is hardcoded to one instance**
   (`packages/shared/src/constants.ts`, `packages/server/migrations/001_initial_schema.sql`):
   fixed `DEFAULT_TEAM_ID`, singleton CEO/Coach/HQ (`ensureInstanceCeo` /
   `ensureInstanceCoach` in `services/team-template-apply.ts`), a singleton
   `chat_sessions` index, and global `UNIQUE` constraints with no `tenant_id`
   anywhere (`projects.slug`, `secrets.name`, `mcp_connections.name`,
   `skills.slug`, `ai_provider_configs(provider, label)`, `api_keys.prefix`).
   A per-instance master key roots the JWT signing key and the AES-256-GCM
   encryption for the whole database; an approved API key is admin-equivalent
   across all teams.
2. **The runtime assumes it owns the host**
   (`services/docker.ts`, `services/containers.ts`, `services/egress/*`):
   exclusive `/var/run/docker.sock`, one container per project (started on
   demand, idle-stopped),
   in-memory per-process egress port allocators (front 20000–29999, host MITM
   30000–39999, dev 10000–19999), `/tmp/hezo-<hash>/` run sockets.
3. **Security boundary — decisive for untrusted signup.** Agents execute
   arbitrary untrusted code in Docker containers. Containers share the host
   kernel and are not a sufficient boundary against a malicious tenant. In a
   shared-host model a single container escape compromises every tenant. The
   per-tenant VM places the boundary at hardware virtualization: each tenant's
   Hezo, Docker daemon, and containers live inside one VM, and sharing a kernel
   *within* the VM is fine because everything in it belongs to the same tenant.

### Rejected: single-DB multi-tenant rewrite

Rejected because it requires re-architecting the data model, auth,
secrets/MCP/skills namespacing, and the instance singletons across the whole
codebase — and still co-locates all tenants' untrusted agent containers on one
shared kernel and daemon. More work, weaker isolation.

## Topology

```
                    ┌──────────────── app.hezo.ai (control plane, new repo) ───────────────┐
 signup / login ──▶ │  accounts · sessions · Stripe billing · SSO issuer · unlock-key       │
                    │  custody · provisioner · job worker · health monitor · fleet versions │
                    └──────┬──────────────────────────────┬──────────────────┬─────────────┘
                           │ provisions / unlocks / SSO   │                  │
              ┌────────────▼───┐            ┌─────────────▼──┐        ┌──────▼─────────┐
              │ tenant droplet │            │ tenant droplet │  ...   │ tenant droplet │
              │ Caddy ─ hezo   │            │ Caddy ─ hezo   │        │ Caddy ─ hezo   │
              │ + dockerd      │            │ + dockerd      │        │ + dockerd      │
              └───┬───────┬────┘            └───┬───────┬────┘        └───┬───────┬────┘
                  │       │                     │       │                 │       │
        ┌─────────▼──┐ ┌──▼─────────┐  (per tenant: one database on a shared managed-PG
        │ managed PG │ │ Spaces     │   cluster + one Spaces bucket with a per-bucket key)
        │ database   │ │ bucket     │
        └────────────┘ └────────────┘
```

Each tenant = one stock `hezo` binary on its own DigitalOcean Droplet (the KVM
boundary; Docker runs single-level inside — no nested virtualization needed),
with **managed Postgres** (`HEZO_DATABASE_URL`) and **Spaces object storage**
(`HEZO_ASSET_STORAGE_URL`) instead of the embedded PGlite + local assets. That
makes the droplet **near-stateless**: the database and assets — the data that
matters — live in managed services with managed backups/PITR, and a dead
droplet is rebuilt from the golden image without data loss. The `dataDir` on
the droplet holds only scratch (run sockets, extracted docker context, tmp).

The control plane never reads a tenant's database content; it provisions,
routes, unlocks, and lifecycle-manages.

## Auth: control-plane accounts, SSO, and unlock

### Accounts at app.hezo.ai (no passwords)

Sign-up / login at the control plane is **email magic link + GitHub OAuth +
Google OAuth**, all resolving to one `accounts` row keyed by verified email
(`account_identities(provider, provider_user_id)` holds the OAuth links; magic
links go out via Resend, the existing hezo.ai sender). Successful auth sets an
httpOnly session cookie. Signup collects the `username` subdomain (unique,
reserved-word denylist).

### First-run setup and unlock-key custody

At first setup on a fresh instance the hosted wizard runs the existing
in-browser flow: generate the 12-word mnemonic, show it, require the user to
save it, `POST /api/auth/setup` to the instance. Then — mandatory, hosted-only —
the browser **pushes the derived 32-byte unlock key to
`app.hezo.ai/api/account/unlock-key`** (authenticated by the control-plane
session cookie, CORS-scoped). Setup is not complete until this succeeds.

- What is stored is the **unlock key, never the 12 words** — the mnemonic and
  the mnemonic-derived Ed25519 auth seed never leave the browser. The control
  plane can unlock instances; it can never reconstruct the phrase.
- At rest the key is encrypted in the control-plane DB under a KMS-wrapped data
  key (AWS KMS — DigitalOcean has no KMS; the control plane's secret store is
  an acceptable stand-in until the KMS wiring lands), decrypted per use, with
  every decrypt audited.
- **The instance never sees the custody path and never persists the key.**
  `HEZO_MASTER_KEY` is never written to any env file or unit; the core
  in-memory-only invariant holds unchanged.
- The 12 words remain the user's recovery root: manual unlock at the gate
  still works, and they are the exit path to self-hosting with their own data.

Threat posture (stated, not optional): the control plane holds tenant unlock
keys *and* the managed-PG admin credentials, so a control-plane compromise can
decrypt tenant instances. Mitigations: KMS wrapping, per-use decryption, audit
trail, alerting on unlocks outside a restart window. This is the deliberate
trade for a hosted product whose instances survive restarts without user
intervention.

### SSO into the instance — the token carries the unlock key

One flow serves login *and* unlock. There is **no admin password on hosted
instances**: the hosted wizard never enrolls a password verifier, and the gate
offers only "Continue with hezo.ai" (plus the manual mnemonic unlock as
recovery). The password machinery stays fully intact in core for self-hosted
installs.

Token: a canonical signed string in the style of the existing
`hezo-auth-v1:*` messages (`packages/shared/src/crypto/auth.ts`), domain tag
`hezo-sso-v1:`, signed with the control plane's Ed25519 **issuer key**:

```
payload: kid · aud (instance host) · sub (account_id) · jti · iat · exp (+60s) · unlock_key
```

Flows:

- **IdP-initiated (primary).** User visits `app.hezo.ai` → signs up / logs in →
  control plane checks the account owns `username` and the instance is running
  → mints the token → `302 https://username.app.hezo.ai/#sso=<b64 token>`. The
  token rides the **URL fragment**, so it never appears in instance access
  logs. The web app reads and immediately clears the fragment, then
  `POST /api/auth/sso`.
- **SP-initiated (direct visit).** Hitting `username.app.hezo.ai` with no local
  session redirects to `app.hezo.ai/sso/authorize?instance=username`, which is
  invisible when the control-plane cookie is present and a login page
  otherwise; it ends in the same redirect back.

Instance-side verification (`POST /api/auth/sso`):

1. Signature verifies against `HEZO_SSO_ISSUER_PUBLIC_KEY` (a `kid:hex` list,
   so issuer keys can rotate) via the existing `verifyAuthSignature`.
2. `aud` equals the instance's own `HEZO_WEB_URL` host — a token minted for
   tenant A is unusable at tenant B even though one issuer key signs for all.
3. `iat`/`exp` window (≤60s, small clock skew allowance).
4. `jti` unused (small in-memory replay cache; the 60s expiry bounds its size).
5. If the master key is locked, `masterKeyManager.unlock(unlock_key)` — the
   existing canary check rejects a wrong key.
6. `sub` maps through `user_auth_methods(provider='hezo_cloud',
   provider_user_id=sub)`; the row is auto-created bound to the single
   superuser iff `sub == HEZO_SSO_OWNER_SUBJECT` (an env pin of the owning
   account id — defense in depth on top of the control plane's ownership
   check). Any other `sub` is rejected.
7. Mint the normal 7-day admin session via the existing `signAdminJwt`.
   Everything downstream — REST bearer, WebSocket `?token=` — is unchanged.

A login-style throttle (same in-memory pattern as `routes/auth.ts`) guards the
endpoint. Logout stays instance-local (drop the localStorage token); hard
revocation is instance suspension. Control-plane logout does not revoke
already-minted 7-day instance sessions — acceptable for a single-owner
instance, documented.

### Proactive re-unlock after restarts

Version rollouts and reboots restart the server, which by design comes up
locked. Waiting for the user's next visit would silently pause their agents,
so the control plane's health monitor watches `GET /api/status` and, on
`masterKeyState: 'locked'`, mints the same signed token shape with
`sub = system:unlock` and POSTs it to `/api/auth/sso`. The instance unlocks
and mints **no session** for the system subject. One endpoint, two consumers;
restarts become invisible to the user.

## Control plane (`app.hezo.ai`)

A **new repository in the hezo-ai organisation** (working name
`hezo-ai/cloud`): a Bun + Hono full-stack app. It consumes `@hezo/shared` as a
published (or git-pinned) dependency for the Ed25519 message builders — crypto
is never copy-pasted across repos. It is deployed on its own infrastructure
and is never part of the single-binary instance build.

Three stateless processes from one codebase, coordinated through the control
plane's own Postgres database (never a tenant DB):

- **web/api** — Hono: marketing-agnostic app shell, account auth, dashboard,
  Stripe webhooks, SSO issuer, unlock-key custody API, fleet state API.
- **worker** — job runner over a `provisioning_jobs` table
  (`FOR UPDATE SKIP LOCKED` poll loop; idempotent resumable steps).
- **monitor** — health loop (per-instance `GET /api/status` every ~60s),
  drives auto-unlock and alerting.

### Schema sketch

```sql
accounts(id, email citext UNIQUE, username citext UNIQUE,  -- username = subdomain
         stripe_customer_id, created_at, deleted_at)
account_identities(account_id FK, provider enum('github','google'),
         provider_user_id, UNIQUE(provider, provider_user_id))
sessions(id, account_id FK, token_hash, ip, ua, expires_at)      -- httpOnly cookie
subscriptions(id, account_id FK, stripe_subscription_id UNIQUE, plan, status,
         current_period_end)                                      -- Stripe-webhook-written only
instances(id, account_id FK UNIQUE,                               -- 1 instance/account at launch
         subdomain citext UNIQUE, region,
         status enum('queued','provisioning','running','locked','suspended',
                     'destroy_scheduled','destroying','destroyed','error'),
         droplet_id, droplet_ip, pg_cluster_id FK, pg_db_name, pg_role,
         spaces_bucket, version, desired_version,
         sso_owner_subject,                                       -- == account_id, denormalized into env
         fleet_token_hash,                                        -- per-instance pull-agent credential
         last_health_at, last_health jsonb,                       -- {masterKeyState,passwordSet,version}
         suspended_at, destroy_after)
pg_clusters(id, do_cluster_id, host, port, admin_secret_ref, tenant_count, max_tenants)
provisioning_jobs(id, instance_id FK,
         kind enum('create','destroy','suspend','resume','upgrade','rotate_creds'),
         state enum('pending','running','waiting_retry','succeeded','failed','cancelled'),
         step, attempt, max_attempts, run_after, last_error, payload jsonb)
unlock_keys(instance_id PK FK, encrypted_key bytea, key_kid, created_at, last_used_at)
sso_issuer_keys(kid PK, public_key_hex, private_key_wrapped, active, created_at)
audit_events(id, account_id, instance_id, actor enum('user','system','stripe','monitor'),
         type, payload jsonb, created_at)                         -- append-only
```

### Billing (Stripe)

- Signup → Stripe Checkout → webhook `checkout.session.completed` → enqueue
  `create`.
- `invoice.payment_failed` → dunning emails → after a grace period (e.g. 7
  days) enqueue `suspend`.
- `invoice.paid` on a suspended instance → `resume`.
- `customer.subscription.deleted` → `destroy_scheduled` with
  `destroy_after = now() + 30d`, an export email (pg_dump + bucket sync +
  "Hezo is GPL — take the binary and self-host"), then `destroy` after grace
  with a final logical backup + bucket snapshot to cold storage.
- Stripe webhooks are the only writer of `subscriptions`; card/plan management
  goes through the Stripe customer portal.

### Signup → provision state machine (`create` job; each step idempotent)

1. `reserve` — validate/claim the subdomain (unique constraint is the lock).
2. `db` — on the least-loaded `pg_clusters` row: `CREATE ROLE hezo_t_<id>
   LOGIN PASSWORD …; CREATE DATABASE hezo_t_<id> OWNER …; REVOKE CONNECT ON
   DATABASE … FROM PUBLIC;`. Hezo migrates itself on first boot through the
   existing external-Postgres path (`db/migrate-external.ts`, advisory-locked)
   — the control plane never touches tenant schema.
3. `storage` — create the Spaces bucket `hezo-t-<shortid>` + a **per-bucket
   access key**.
4. `droplet` — create from the golden image; `user_data` cloud-init writes
   `/etc/hezo/hezo.env` (matrix below), the Caddy site address, and the fleet
   agent token; attach the DO Cloud Firewall.
5. `dns` — A record `<sub>.app.hezo.ai → droplet_ip` (Caddy retries ACME until
   DNS resolves, so ordering is forgiving).
6. `verify` — poll `https://<sub>.app.hezo.ai/health`, then `/api/status`
   until it reports `masterKeyState: 'unset'` (timeout ~10 min →
   `waiting_retry` with backoff, then `error` + operator alert).
7. `done` — `status = running`; the user's first visit runs the in-browser
   master-key setup + unlock-key push (§ above).

Failure past `max_attempts` runs a compensating teardown of whichever steps
completed (droplet / DNS / bucket / db are all recorded on the instance row).
`destroy` is the same list reversed, snapshot first.

### Lifecycle

- **Suspend / resume:** power the droplet off and repoint the DNS A record to
  a control-plane "suspended" page (low TTL); resume reverses it. With the GA
  proxy layer this becomes an instant route flip instead of DNS surgery.
- **Version rollouts — pull, not push.** A tiny `hezo-fleet-agent` (systemd
  timer baked into the golden image) polls
  `GET app.hezo.ai/fleet/v1/state` with its per-instance bearer token; the
  response carries `{desired_version, binary_url, sha256}`. The agent
  downloads, verifies the checksum, swaps `/usr/local/bin/hezo`, restarts the
  service, and reports back. `HEZO_DISABLE_AUTO_UPDATE=1` keeps the core
  self-updater off (`services/updater.ts`); rollouts stage by cohort (canary
  N≈5 → fleet). Restart-induced locks are healed by the proactive re-unlock.
  Pull-based means **no steady-state inbound SSH** to tenant droplets.
- **Health monitor:** `GET /api/status` per running instance (~60s, batched);
  stores `{masterKeyState, passwordSet, version}`. `locked` → auto-unlock;
  unreachable ×3 → alert + dashboard surface.

## Routing & certificates

Two stages:

| | MVP: per-droplet DNS + on-droplet ACME | GA: central proxy layer |
|---|---|---|
| Cert | Caddy HTTP-01 per host on the droplet (exactly the shipped `deploy/provision.sh` shape) | Wildcard `*.app.hezo.ai` (DNS-01) at 2× proxy droplets, or Cloudflare-for-SaaS at the edge |
| New moving parts | none | proxy pair + VPC, or Cloudflare Advanced Certificate Manager (`username.app.hezo.ai` is a second-level subdomain — Universal SSL does **not** cover it; verify) |
| Suspend UX | DNS repoint (TTL lag) | instant route flip |
| Constraint | **Let's Encrypt's ~50 new certs/week per registered domain** caps signup velocity (Caddy's ZeroSSL fallback softens it) | proxy is a chokepoint; all tenant traffic incl. WebSockets traverses it |

Ship the MVP on per-droplet ACME (zero new infra); build the proxy layer
before open signup — it also brings central rate limiting and instant
suspend. **Never push a wildcard certificate's private key onto tenant
droplets** — a compromised tenant VM would then hold a key valid for every
other tenant's hostname.

## DigitalOcean provisioning

- **Droplet:** default `s-2vcpu-4gb` (~$24/mo) — the Bun server + dockerd +
  one long-lived container per project + bursty agent CLI runs; PGlite is gone
  but coding CLIs are RAM-hungry. Validate an `s-1vcpu-2gb` (~$12) "lite" tier
  in the sizing spike before offering it. Droplet, PG cluster, and Spaces
  bucket are pinned to the same region; droplet↔PG rides the DO VPC private
  hostname.
- **Image:** a **Packer golden image** extending the existing
  `deploy/marketplace/digitalocean` template (which already supports
  `HEZO_IMAGE_BUILD=1`): Docker + Caddy + the `hezo` binary + the fleet agent
  baked in, services enabled-but-not-started; the hosted image drops the
  sslip.io `hezo-firstboot` URL derivation (the control plane supplies the
  real hostname). Per-tenant cloud-init only writes env files → boot in <60s
  instead of ~4–5 min of apt.
- **Managed Postgres:** one shared cluster is not enough at 100 tenants — the
  driver pool is up to 10 connections per instance
  (`db/drivers/postgres.ts`; `HEZO_DATABASE_POOL_SIZE`, floor 2) and DO
  backend connection limits are on the order of low hundreds per node. DO's
  built-in pools are PgBouncer transaction mode, which Hezo cannot use
  (session advisory locks; one-server-per-database design). Plan: set
  `HEZO_DATABASE_POOL_SIZE` low (~4) for hosted tenants, shard tenants across
  clusters at ~20–30 tenants/cluster (`pg_clusters` + capacity-aware
  placement), starting from one 2-node cluster. Per-tenant `ROLE` owns only
  its database; the cluster admin credential lives only in the control plane.
  Managed backups/PITR come with the service — that is the point of the
  managed-PG decision.
- **Spaces:** **bucket-per-tenant + per-bucket access keys.** Spaces keys
  cannot be prefix-scoped, and one account-wide key on every tenant VM is
  unacceptable, so per-bucket keys are the only layout where a droplet's key
  cannot read siblings. Bucket names `hezo-t-<shortid>` (regional global
  namespace). Verify the per-bucket key API and the buckets-per-account cap
  (historically ~100) before tenant #100.
- **Firewall:** keep the on-droplet ufw from `provision.sh` (80/443 public;
  egress/3100 host-local; docker0 → host allowed) **plus** a DO Cloud
  Firewall: inbound 80/443 from anywhere, SSH only from control-plane IPs
  (break-glass; steady state uses the pull agent), everything else denied.
- **Provisioner interface:** a thin TS interface in the control-plane repo —
  `createVM / destroyVM / powerOff / powerOn`, `upsertDnsRecord /
  deleteDnsRecord`, `createTenantDatabase / dropTenantDatabase`,
  `createBucketWithKey / destroyBucket`, `snapshotForArchive` — with
  `DigitalOceanProvisioner` (REST) as the first implementation. Hetzner (the
  cheapest-compute alternative below) slots in later without touching the
  state machine.

### Per-tenant env (written once by cloud-init to `/etc/hezo/hezo.env`, mode 600)

| Var | Value | Note |
|---|---|---|
| `HEZO_PORT` | `3100` | behind local Caddy |
| `HEZO_DATA_DIR` | `/var/lib/hezo` | scratch only — DB and assets are external |
| `HEZO_DATABASE_URL` | `postgres://hezo_t_<id>:<pw>@<cluster-private-host>:25060/hezo_t_<id>?sslmode=require` | per-tenant role + database. `require` is libpq-semantic (see `.dev/architecture.md` § 12 (*External TLS (`sslmode`)*)): encrypted, certificate not verified — accepted here because the host is the cluster's private VPC address. Verifying it would mean `sslmode=verify-full&sslrootcert=` with the DO cluster CA placed by provisioning. |
| `HEZO_DATABASE_POOL_SIZE` | `4` | keeps cluster connection math sane |
| `HEZO_ASSET_STORAGE_URL` | `s3://<KEY>:<SECRET>@<region>.digitaloceanspaces.com/hezo-t-<shortid>?region=…` | per-bucket key |
| `HEZO_WEB_URL` | `https://<sub>.app.hezo.ai` | also the SSO `aud` |
| `HEZO_TELEMETRY_ENDPOINT` | `https://app.hezo.ai/api/telemetry` | fleet telemetry lands in the control plane |
| `HEZO_DISABLE_AUTO_UPDATE` | `1` | fleet agent owns versions |
| `HEZO_OPEN` | `0` | headless |
| `HEZO_HOSTED` | `1` | *new* — hosted gate/wizard variants, hide update UI |
| `HEZO_SSO_ISSUER_URL` | `https://app.hezo.ai` | where the gate redirects |
| `HEZO_SSO_ISSUER_PUBLIC_KEY` | `<kid1>:<hex>[,<kid2>:<hex>]` | *new* — list enables issuer rotation |
| `HEZO_SSO_OWNER_SUBJECT` | `<account uuid>` | *new* — owner pin |
| `HEZO_MASTER_KEY` | **never set** | custody + SSO unlock replace it; the never-persist invariant holds |

Secrets in this file are per-tenant scoped by construction — a compromised
droplet exposes only that tenant's database and bucket. A `rotate_creds` job
can re-issue both.

## Hezo-core changes (the complete list)

Everything else in this document is control-plane work. Core changes are
additive and inert unless the SSO config is present:

1. `packages/shared/src/crypto/auth.ts` — one new builder,
   `buildSsoTokenMessage(kid, aud, sub, jti, iat, exp, unlockKeyHex)`
   (`hezo-sso-v1:` domain tag); the existing `verifyAuthSignature` verifies.
2. `packages/server/src/cli.ts` — new config: `HEZO_HOSTED`,
   `HEZO_SSO_ISSUER_URL`, `HEZO_SSO_ISSUER_PUBLIC_KEY`,
   `HEZO_SSO_OWNER_SUBJECT` (+ docs sync per repo rules).
3. `packages/server/src/routes/auth.ts` (or a sibling `routes/sso.ts`) — one
   endpoint, `POST /api/auth/sso`: verify → unlock-if-locked → bind `sub` via
   `user_auth_methods` → mint the session with the existing `signAdminJwt`;
   the `system:unlock` subject unlocks without minting. In-memory jti replay
   cache + login-style throttle.
4. `packages/server/src/middleware/auth.ts` — add `/api/auth/sso` to
   `PUBLIC_PATHS`.
5. `packages/server/src/startup.ts` — `/api/status` gains `sso`/`hosted`
   fields so the gate knows what to render.
6. `packages/web` — hosted gate: `#sso=` fragment handler + "Continue with
   hezo.ai" redirect, no password form; hosted setup wizard: mnemonic save →
   mandatory unlock-key push to the control plane, no password enrollment;
   hide the self-update UI when hosted.
7. `deploy/` — a hosted Packer image variant (fleet agent baked in, firstboot
   sslip.io logic disabled). Additive; the marketplace image is untouched.

**No database migration is needed** — `user_auth_methods` already exists in
the baseline schema with exactly the right shape. Master-key/unlock semantics,
password challenge-response, the JWT scheme, the migrations runner, and the
storage/asset drivers are all unchanged.

## Cost posture

Always-on does not mean always-busy: Hezo's background work is periodic and
bursty (scheduler ticks ~1 Hz; agent wakeups default to 12 h; a run is a
transient `docker exec`), so an instance idles at its baseline most of the
time. Per-tenant at ~100 tenants on DO: droplet ~$12–24 + amortized shared PG
cluster ~$1–3 + Spaces ~$0.1–1 → roughly **$15–28/tenant/mo**. Hetzner Cloud
(~€5.5/VM, 20 TB egress) remains the cheapest VM-per-tenant substrate and
Hetzner dedicated with packed Firecracker micro-VMs the cost floor (~€2.3),
at the price of a second vendor for managed PG and (respectively) operating a
hypervisor — the provisioner interface keeps that door open.

> The bigger cost is probably not infrastructure. At 100 always-on tenants
> doing background agent work, **LLM API token spend likely dwarfs compute**.
> The credential/billing model (bring-your-own-key vs. a pooled platform key
> with metering) deserves at least as much design effort as the substrate;
> Hezo's per-project/per-agent budget caps and the instance-wide
> `max_container_memory_gb` budget are the existing levers.

## Quotas, rate limiting, abuse

Hezo core has no rate limiting; hosted enforcement lives in the control plane
and (at GA) the proxy layer: per-tenant run/spend caps via Hezo's existing
budget fields, provisioning throttles, email verification at signup, egress
caps on droplets. The new `/api/auth/sso` endpoint carries an instance-local
login-style throttle.

## Phasing

- **M0 — validation spikes** (throwaway):
  - *S1 storage:* stock binary on a droplet with managed PG + Spaces env → a
    full agent run end-to-end. Confirms the near-zero-core-change claim under
    the hosted storage config.
  - *S2 provisioning:* script `DO API: droplet(golden image) + DNS + tenant
    db/role + bucket/per-bucket key → reach the master-key gate over HTTPS`.
    This is where the flagged assumptions below get verified.
  - *S3 sizing:* idle + active-run RAM/CPU on `s-1vcpu-2gb` vs `s-2vcpu-4gb`
    with external PG → plan tier / unit economics.
- **M1 — private alpha** (invite-only, ~5–10 tenants): `hezo-ai/cloud`
  skeleton (accounts + magic-link/OAuth login, sessions, instances, jobs +
  worker), DO provisioner, create/destroy, per-droplet ACME routing, SSO +
  unlock-key custody end-to-end (core changes 1–6; secret-store encryption
  acceptable, KMS in M2), proactive auto-unlock, health monitor + a basic
  dashboard. No billing.
- **M2 — paid beta:** Stripe (checkout, webhooks, dunning → suspend/resume),
  KMS wrapping for key custody, fleet agent + staged version rollouts,
  destroy-with-grace + final export snapshot, audit events.
- **M3 — GA / open signup:** the routing proxy layer with central rate
  limiting and instant suspend (mandatory before open signup, given the LE
  cert-rate cap and the abuse surface), PG cluster sharding + capacity-aware
  placement, monitoring/alerting (uptime, cert expiry, disk), abuse controls,
  an SSO issuer-key rotation drill, a restore-from-backup runbook, and the
  self-host offboarding path (pg_dump + bucket export + the GPL binary).

## Assumptions flagged for verification (S2 unless noted)

1. **DO Spaces per-bucket access keys** — API-creatable; key-per-bucket limits
   and grant granularity.
2. **DO buckets-per-account cap** (~100 historically) — raise or shard before
   tenant #100.
3. **DO managed-PG connection limits** per node size vs. the pool math —
   confirms ~20–30 tenants/cluster.
4. **Let's Encrypt ~50 certs/week/registered-domain** applies to
   `*.app.hezo.ai` — caps MVP signup velocity; confirm Caddy's ZeroSSL
   fallback behaviour.
5. **Cloudflare**: second-level subdomain certs need Advanced Certificate
   Manager / Cloudflare-for-SaaS (GA proxy option only).
6. **No DO KMS** — AWS KMS cross-cloud for custody wrapping (or the
   secret-store stand-in until M2).
7. `HEZO_DISABLE_AUTO_UPDATE` is env-only (read in `services/updater.ts`, not
   `parseConfig`) — fine for env-file deployment; keep documented.
8. DO VPC private connectivity droplet → managed PG within a region.
9. Clock skew: droplets run NTP; the 60s token window assumes ≤ a few seconds
   of skew — confirm on the golden image.

## Key files referenced

- `packages/shared/src/crypto/{auth.ts, mnemonic.ts}` — key derivation, signed
  message builders (the SSO token builder lands here).
- `packages/server/src/crypto/master-key.ts` — `MasterKeyManager`, unlock,
  canary, JWT-key derivation.
- `packages/server/src/routes/auth.ts`, `middleware/auth.ts` — auth routes,
  `signAdminJwt`, `PUBLIC_PATHS` (the SSO endpoint lands here).
- `packages/server/src/db/drivers/postgres.ts`, `db/open.ts`,
  `db/migrate-external.ts` — external-Postgres support the hosted storage
  rides on.
- `packages/server/src/assets/` — S3 asset storage (`parseAssetStorageUrl`).
- `packages/server/src/cli.ts` — `HEZO_*` config surface.
- `packages/server/migrations/001_initial_schema.sql` — `user_auth_methods`
  (the SSO identity seam), the single-tenant unique constraints.
- `deploy/provision.sh`, `deploy/cloud-init/`, `deploy/marketplace/` — the
  provisioning assets the golden image extends.
