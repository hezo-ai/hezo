# What Hezo Cloud needs from this repo

**Inbound requirements from the `hezo-ai/cloud` control plane.** Nine tasks, two
of them optional. Everything here is **additive and inert unless hosted config
is present** — self-hosted behaviour must stay byte-identical.

Every claim below was verified against the working tree, not from memory. Where
something turned out to already exist, that is recorded at the end rather than
quietly dropped.

The control-plane repo keeps a companion copy at `.dev/track-h-spec.md` so its
own readers know what Track H blocks. **This file is the one to work from**; if
the two disagree, this one is newer.

> **Relationship to [`hosted-architecture.md`](./hosted-architecture.md).** That
> document is the 2026-05/06 design of record and predates the substrate
> actually chosen: tenants are now **one DigitalOcean Droplet each**, agent
> containers run on **Daytona** rather than on the tenant box, and tenant data
> lives in **DO Managed Postgres** rather than a self-managed cluster. Its
> "Hezo-core changes" section is superseded by this file. The rest of it is
> still useful as background.

| | Task | Unblocks | Size |
|---|---|---|---|
| **H1** | SSO token builder in `@hezo/shared` | H3 | small |
| **H2** | `sso` config-file block | H3 | small |
| **H3** | `POST /api/auth/sso`, in two phases | cloud SSO login | medium |
| **H4** | `/api/status` hosted fields | H5 | small |
| **H5** | Hosted gate + setup wizard | cloud SSO login | **large** |
| **H9** | Behind-gateway seam in `provision.sh` | cloud provisioning | small |
| **H14** | Migration path without session affinity | cloud DB density | **large** |
| **H15** | Wire up the policy-file watcher | live tier changes | small |
| **H16** | Make the container backend pinnable | tenant can't break itself | small |
| H10 | Unprefix provision-script env vars | nothing | optional |
| H18 | A 1-vCPU Daytona shape | 38% off the container-hour rate | optional |

`H1 → H3`; `H2 → H3`; `H4 → H5`; `H3 → H5`. **H9, H14, H15 and H16 are
independent** of the SSO chain and of each other.

**One release containing H1–H5 + H9 + H16 unblocks the control plane's SSO
work.** H14 can ride that release or a later one. H15 either ships or the cloud
plan stops claiming a restart-free tier change — today it does not have one.

---

## The SSO chain (H1–H5)

### The invariant the whole chain exists to preserve

The control plane must be able to log a user into their instance **without ever
being able to unlock it**. Those are different powers:

- **Identity** is a signed assertion the instance verifies.
- **The unlock key** is a 12-word phrase that lives only between the user's
  browser and their instance.

**Nothing in this chain may accept, store, log or forward an unlock key.** A
locked instance that accepts a valid SSO token is *still locked* and must still
demand the phrase at the gate.

Verified absent: no SSO, no OIDC, no SAML, no external issuer, no JWKS, no
configurable signing key. The existing JWT secret is derived from the master key
(`crypto/master-key.ts`, `getDerivedKey('jwt')`) — which is precisely why a
second, externally-verifiable mechanism is needed rather than reusing it.

### The load-bearing consequence: identity and session must be separable in time

A hosted tenant **boots locked after any restart the supervisor does not survive**.
The supervisor unlock handoff (`lib/unlock-handoff.ts`) survives an *update* restart,
by design; reboot, crash and `systemctl restart` all come up locked.

And a locked instance cannot mint a session at all:

- `signAdminJwt` (`middleware/auth.ts:248`) signs with `getJwtKey()` →
  `getDerivedKey('jwt')` (`crypto/master-key.ts:120`), which needs the unlock
  key in memory.
- `verifyToken` (`middleware/auth.ts:65`) returns `null` unless the state is
  `unlocked` — a valid session JWT is rejected outright while locked.
- The web gate calls `api.clearToken()` on mount for any non-unlocked state
  (`packages/web/src/routes/__root.tsx:186`).

So a one-shot "verify the token, return a session" route cannot work: on the
common path there is nothing to sign with, and a 60-second token cannot wait for
a human to fetch twelve words. **H3 is therefore specified as a two-phase
exchange** — see below. This is not a refinement; without it a hosted tenant has
no way in after any reboot.

### H1 — SSO token builder in `@hezo/shared`

`buildSsoTokenMessage` / `parseSsoToken`, domain-tagged, Ed25519, verified by
the existing `verifyAuthSignature` (`packages/shared/src/crypto/auth.ts:80`).

Payload: `kid · aud · sub · jti · iat · exp`, with **`exp` ≤ 60 s** and a stated
clock-skew tolerance — two separate clouds, and a hard 60-second window with no
allowance is brittle. Name the tolerance and test both edges.

**Say the real accepted window, not the `exp`.** The skew widens it on *both*
sides, so a 60-second token is takeable from `iat - skew` to `exp + skew`: at a
30-second tolerance that is two minutes, not one. Anyone reasoning about how long
a captured token is worth carrying needs that figure rather than the one the
issuer wrote.

**The encoding must be unambiguous, and the obvious way is not.** The five
existing builders in the same file are colon-joined
(`hezo-auth-v1:<verb>:<hex>…`), which is safe **only because every field is
fixed-length hex** — the comment at `crypto/auth.ts:92-94` says so. This payload
carries variable-length text: `aud` is a hostname, `kid` is arbitrary. Naive
colon-joining is signature-ambiguous — `aud="a:b", sub="c"` and
`aud="a", sub="b:c"` produce identical signed bytes, so a signature over one is
a valid signature over the other. Length-prefix each field, use a canonical
encoding, or normalise and assert a fixed shape per field.

**Pick a domain tag deliberately.** `hezo-sso-v1:` opens a new family;
`hezo-auth-v1:sso:` extends the existing one. A separate family is defensible —
this key is external rather than phrase-derived — but say which and why, because
it lands in the same file as the other five.

**No unlock-key field, and adding one later is a breaking change by design.**

It belongs in `@hezo/shared` because the control plane imports it from there
rather than restating it — a drift then fails a test instead of silently
producing tokens of the wrong shape. Note that the cloud repo pins
`@hezo/shared` through a git submodule, so the drift test only bites once the
submodule moves.

**AC:** round-trip vectors; tamper, wrong-key, expired and skew-edge all
rejected; a field-boundary vector proving two different payloads cannot produce
the same signed bytes.

### H2 — `sso` config-file block

**Config keys, not env vars.** The `HEZO_*` variables are retired into
`config/removed-env.ts`, and the systemd unit `deploy/provision.sh` generates
runs `hezo --config /etc/hezo/hezo.config.cjs` with **no `EnvironmentFile=` at
all**. New settings arriving as env vars would run against that.

One block, in the idiom of the existing `database` / `containers` / `policy`
blocks:

```js
sso: {
  issuerUrl: 'https://app.hezo.ai',        // where an unidentified visitor is sent
  logoutUrl: 'https://app.hezo.ai/logout', // where signing out goes
  issuerPublicKey: 'k1:ab12…,k2:cd34…',   // kid:hex list, comma-separated
  ownerSubject: '9f1c…',                   // the account uuid allowed in
  audience: 'alice.app.hezo.ai',           // what `aud` must equal
}
```

`issuerPublicKey` is a **`kid:hex` list** so the issuer can rotate without a
flag day: publish both keys, move minting to the new one, then drop the old.

**`audience` is not optional and must not come from the request.** H3's `aud`
check is otherwise decorative: the only request-time source for "this instance's
own host" is the `Host` header, and `requestOrigin()` (`lib/request-origin.ts`)
takes both `host` and `x-forwarded-proto` from the request with no trusted-proxy
setting. If reusing the existing top-level `webUrl` key is preferred to a new
one, say so — but the value must be configured, not observed.

**`logoutUrl` is required, not optional.** Clearing the instance's session is
only half of signing out: the issuer still has one, and would sign the person
straight back in on the very next redirect, so the button reads as broken. An
issuer that can sign someone in can sign them out, and leaving the key optional
would mean a logout that quietly does half of what it says.

**`ownerSubject` is singular, and that is a 1:1 baked in on purpose.** The local
side is single-superuser today (`services/password.ts:28` selects
`WHERE is_superuser = true ORDER BY created_at LIMIT 1`). Record that hosted
multi-user is a breaking change to this key rather than an additive one.

**Two settings originally scoped for this are unnecessary — `policy` already
carries them:**

| Originally | Use instead | Because |
|---|---|---|
| a control-plane URL | `policy.manageUrl` | already an `https:`-validated URL, already surfaced to clients |
| a `managed by` label | `policy.managedBy` | already means "an operator manages this instance", and names them in the UI |

`routes/instance-settings.ts` and `routes/container-hours.ts` already return
`{ managed_by, manage_url }`.

**But a `hosted` flag derived from `policy` is wrong — see H4.**

**AC:** parses and validates; **inert when unset** (an instance with no `sso`
block behaves byte-identically); a malformed `kid:hex` list fails at startup
naming the key, not at first login; docs updated in the same PR.

### H3 — `POST /api/auth/sso`, in two phases

The verification chain, in order, failing closed at each step:

1. signature against the `sso.issuerPublicKey` entry matching the token's `kid`
2. `aud` equals `sso.audience`
3. `iat` / `exp` inside the window, within the stated skew tolerance
4. `jti` not seen before (replay cache)
5. `sub` equals `sso.ownerSubject`

**Then it branches on lock state:**

- **Unlocked** — mint the **normal admin session**, the same one a password
  login produces, for the local superuser. No new privilege level.
- **Locked** — mint nothing. Return `{ locked: true, handle }`, where `handle`
  is a single-use, **in-memory** record of the verified identity with its own
  short expiry (minutes, not seconds). The gate holds it, runs the ordinary
  mnemonic unlock, then exchanges it for a session.

That keeps `exp ≤ 60 s` on the signed token while decoupling it from human time,
and makes replay protection fall out for free — the handle is single-use. **The
handle proves identity and unlocks nothing**, so the invariant is untouched. Per
`AGENTS.md`, the handle map states its bound and its invalidation where it is
declared. **Not "cleared on lock"** - there is no runtime unlocked-to-locked
transition to hook; `locked` is only ever set on the way up. The expiry is the
bound, and the code says so.

**Check the throttle only AFTER verifying, never before.** This is the part that
matters, and it is easy to get backwards. On a hosted instance the issuer is the
only door, so a throttle checked first hands anyone who can reach the gate a way
to lock the owner out of their own instance with a stream of rubbish. Verify
first; let anything that verifies through however hot the counter is; count and
refuse only failures. A shorter backoff is not the fix - it only shortens the
outage.

**The throttle must also be its own, not the login one.** There is no rate-limit
middleware in this repo. The login throttle is a module-global counter
(`routes/auth.ts:43-65`) with exponential backoff to **one hour**, justified by
"single admin, so one global counter suffices". Reusing it hands anyone who can
reach the public gateway an hour-long lockout of the only door into a hosted
instance, for the price of malformed tokens. Give SSO a short, bounded lockout
that a valid signature resets. Note that per-IP throttling is unavailable behind
the gateway — every request shares one source address.

Both phases need an entry in `PUBLIC_PATHS` (`middleware/auth.ts:16`).

**AC:** valid, wrong-`aud`, expired, skewed, replayed and unknown-`sub` each
tested; **a locked instance returns a handle and stays locked**; the handle is
single-use and expires; the full locked → unlock → exchange path yields a working
session; the route is inert without hosted config; a valid token is accepted
however hot the throttle is.

### H4 — `/api/status` hosted fields

Add the fields the gate needs, absent entirely when not hosted so existing
consumers see no change.

**Do not derive `hosted` from `policy`.** `policySchema` requires `managedBy`
whenever a `policy` block exists, so "a policy is configured" is well-defined —
it just means the wrong thing. It means *an operator manages this instance*, not
*the control plane can sign me in*. A self-hoster who sets `policy` purely to
pin container settings would get a "Continue with hezo.ai" button that cannot
work. Two predicates, kept apart:

| Surface | Predicate |
|---|---|
| SSO affordance on the gate, `#sso=` handler | an `sso` block is configured |
| "managed by X" banner | a `policy` block is configured |

Three distinct URLs are in play and they are not interchangeable:
`policy.manageUrl` is the **dashboard**, `sso.issuerUrl` is the **issuer**, and
`sso.audience` is this **instance**. Return the one the gate actually uses.

**`/api/status` is served twice.** `startup.ts:709` once booted, and
`startup-serving.ts:71` while still starting — the latter returns
`{ starting: true, … }` with no `masterKeyState`. Either add the fields to both,
or the gate must handle their absence during boot. Say which.

### H5 — Hosted gate + setup wizard

**The instance draws no sign-in page. The control plane owns signing in.** The
user is already signed in there; it mints a token and sends them to the instance
URL carrying it, so the session is set by the time they arrive. An instance that
drew its own sign-in would be asking for credentials it has no business seeing,
and duplicating a screen the control plane already has. The whole hosted gate is
therefore: hand an unidentified visitor back to the issuer, and know what to do
with the token they return with.

- An unidentified visitor is **redirected to `sso.issuerUrl`**. No form, no
  button to press first.
- `#sso=` fragment handler, stripping the fragment via `history.replaceState`
  before anything else, so a copied URL or a back-navigation cannot carry a token.
- The locked-instance flow: hold the handle, run the ordinary mnemonic unlock,
  exchange for a session. Mnemonic unlock stays the primary unlock affordance.
- **A rejected token stops and waits.** Redirecting again is a loop: the issuer
  mints another and sends the visitor straight back. The retry is theirs to make.
- **The redirect must not race the redemption.** Between the unlock landing and
  the handle becoming a session there is at least one render with no session; a
  plain "redirect when signed out" fires in it and throws away an identity that
  was about to be honoured. The gate tracks a phase, not a boolean.
- Setup wizard with **no password enrollment and no custody push** — the browser
  generates the phrase and POSTs the derived key to the instance. The password
  step leaves the stepper too, rather than showing as a completed step that never
  happened.
- **Signing out goes to `sso.logoutUrl`** after clearing the local session. It
  ends a session; it does not re-lock the instance. A reboot or service restart
  still does.
- **A token arriving before setup is early, not failed.** The control plane sends
  a new signup straight to a brand-new instance, which has no account to be
  anybody yet and refuses the token. Treating that as a failure strands every new
  signup on an error screen the moment they finish creating their phrase. It
  falls through to the ordinary redirect instead, which fetches a fresh token
  once there is an account - which is necessary anyway, the first one having a
  life of one minute and the phrase taking longer than that to write down.
- **The self-update UI stays exactly as it is** — see *already satisfied*; a
  hosted tenant confirms its own updates like any other instance.

**There is no password fallback, and that is the design rather than an
omission.** A hosted instance never enrolls a password, so there is nothing to
fall back to, and a second door would defeat the point of the first. The accepted
consequence belongs in the product docs and not only here: a tenant whose control
plane is unreachable cannot reach their own instance, even at the console.

**Two surfaces H5 must reach before.** The mnemonic never mints a session —
`/api/auth/setup` and `/api/auth/verify` both return only a `password_setup`-scoped
token (`routes/auth.ts:387-420`). So on hosted `passwordSet` stays `false`
forever, and the issuer branch has to come before both of these:

1. the root gate's `CreatePasswordFlow` branch (`__root.tsx`, on `!passwordSet`)
2. the `PasswordLogin` branch behind it

**Every new string reaches all twelve catalogs in the same commit.** This is a
commit gate, not a nicety.

**AC:** component tests for both variants; **a Playwright spec covering the
locked → unlock → session journey against an actually locked server** - the
component harness always boots unlocked, so that path has no other home, and it
is the one the redirect race breaks; the fragment stripped from a real address
bar; a rejected token that does not bounce; non-hosted flows byte-identical;
twelve catalogs.

---

## H9 — Behind-gateway seam

**Was absent before this task:** `BEHIND_GATEWAY` appeared zero times in `deploy/`.

A hosted tenant sits behind a shared gateway that already terminates TLS for the
whole wildcard domain. The tenant Droplet must therefore **not** install Caddy,
**not** attempt ACME, and **not** open 80/443 publicly — it needs the configured
`port` reachable on the private network only.

Without this the control plane cannot verify a tenant end to end: two things
race for port 80, and the tenant tries to solve an ACME challenge for a name the
gateway owns.

What the flag has to reach, verified in `deploy/provision.sh`: the Caddy install
from the Cloudsmith apt repo (:328-362), firstboot's public-IP-to-site-address
derivation (:387-400), and the ufw rules opening 22/80/443 (:474-483), where
port 3100 is otherwise host-local plus the `docker0` bridge. ACME is entirely
implicit — Caddy's automatic HTTPS, no `tls` directive anywhere — so not
installing Caddy is what disables it.

- **Provision-script-only flag. The hezo binary never reads it.**
- Unprefixed, like the other provision-script inputs.
- **Not** named "proxy" — that word already means hezo's internal egress proxy,
  and reusing it for the ingress path would be actively misleading.

**The assumption that makes this safe, recorded because nothing else records
it:** agent containers never dial the tenant box. The run tunnel's endpoints are
all loopback *inside* the container and the bytes ride the engine's own byte
channel (`services/sandbox/tunnel/run-tunnel.ts`). That is why closing public
ingress does not break the egress proxy, the MCP endpoint or the ssh agent for
Daytona sandboxes. **If that ever changes, H9 breaks silently.**

**One thing to confirm on the gateway side:** `requestOrigin()` trusts
`x-forwarded-proto` and `host` from any client, with no trusted-proxy setting.
That is correct behind a gateway that overwrites both, and a spoofing surface if
it does not.

**AC:** flag set → no Caddy installed, no public 80/443, the configured `port`
reachable from the private network only. Flag unset → today's behaviour
byte-identical.

---

## H14 — A migration path that needs no session affinity

### Two goals, and one mechanism that delivers both

The goals are `database.poolSize: 1` (fleet density) and transaction-mode
connection pooling (the much larger prize). They look like separate changes.
They are not: **`pg_advisory_xact_lock` gets both**, and the pinned-connection
refactor that first suggests itself gets neither cleanly.

### Why the obvious fix is the wrong one

*What follows describes the code as it stood before this task; `acquireSessionLock`
is gone now.* It checked out a dedicated client, and said why:

> Advisory locks are session-scoped, so the holder must be one dedicated client —
> taking the lock through the pool would bind it to a random connection that the
> next query no longer uses.

That dedicated client was the second connection, and the entire reason
`config/schema.ts` enforced a floor of two.

But the migration does **not** run on that client. `migrate-external.ts:96`
takes the lock and then passes the **pool** `Db` to `runMigrations`, which does
`db.exec` / `db.query` / `db.transaction` (`migrate.ts:66,75,99`) on *other*
connections. So "take the lock on the same connection that runs the migration"
means threading a pinned-connection `Db` through `runMigrations`, the
pre-migration logical backup and `findUnknownAppliedMigrations` — and having
done all that, it still does not give you a pooler, because a transaction-mode
pooler does not keep you on one backend between statements.

### What to change

`db.transaction()` checks out exactly one client (`runExclusiveTransaction`,
`postgres.ts:119`), and a transaction-scoped lock lives and dies inside it.
Nothing is held between migrations, so no second connection is ever needed. No
migration uses `CONCURRENTLY`, so every one is already transactional.

1. `runMigrations` takes `pg_advisory_xact_lock(MIGRATION_LOCK_KEY)` as the
   **first statement** of each migration's existing transaction, and re-reads
   the applied set **inside** that same transaction before applying.
2. `applyPendingMigrationsExternal` drops `acquireSessionLock` entirely.
   `acquireSessionLock` then has no production caller — remove it from the `Db`
   interface and both drivers rather than leaving a trap for the next person.
3. Resolve the downgrade guard. `findUnknownAppliedMigrations` currently re-runs
   *under* the lock (`migrate-external.ts:98`) precisely because the winner of
   the lock race may have been a newer binary. With per-migration locks it moves
   inside the first migration's transaction, or is accepted as best-effort.
   Decide and write it down.
4. Drop the floor in **both** places, or it silently comes back:
   `config/schema.ts:22` (`z.int().min(2)`) and `MIN_POOL_SIZE`
   (`db/drivers/postgres.ts:14,65`, where `Math.max(MIN_POOL_SIZE, …)` raises
   any lower value). The stale comment referring to a `parsePoolSize` in
   `db/open.ts` — a function that does not exist — goes with it.
5. **Audit the pool-from-inside-a-transaction deadlock class. This, not the
   lock, is the bulk of the task.** Any code that inside `db.transaction(tx => …)`
   reaches for `db` instead of `tx` merely stalls at pool 2 and **hangs forever**
   at pool 1. Enumerate the transaction call sites and confirm none does it.

### Why the lock can go

The lock serializes *concurrent migrators*. The same file already states the
topology it defends against:

> Cross-INSTANCE serialization is out of scope — **Hezo runs one server per
> database** (migrations, the multi-writer case, take a `pg_advisory_lock`).

The transaction-scoped lock keeps that guarantee everywhere — including where
two processes can share a database — while removing the connection affinity.
Nothing is being given up.

### Why it is worth doing

Postgres connections are what a managed cluster is sized by, so this floor sets
the hosted fleet's density directly.

| | An 8 GiB cluster carries | Cost per tenant |
|---|---:|---:|
| pool 2 (today) | 98 tenants | $1.25 |
| pool 1 | 197 tenants | $0.62 |

The larger prize is that it makes **transaction-mode connection pooling** safe.
Under a pooler, backend connections track *concurrent transactions* rather than
tenants — at 1,000 tenants roughly $146/mo of database instead of $1,466.

### What pool 1 costs, and where it belongs

One connection then serves the API, the tool endpoint, the egress proxy, the
container control plane **and** a background scheduler polling every 1-5 s
(`docs/deployment/configuration.md:304`), against a reference workload of ~10
concurrent agent runs. It should be a **hosted-tenant setting arrived at
deliberately, not the shipped default**, and the cloud plan's `C0.5` load spike
should measure pool 1 rather than assume it.

### The blast radius

A sweep of `packages/server/src` for everything transaction pooling breaks:

| Feature | Occurrences |
|---|---|
| `LISTEN` / `NOTIFY` | none |
| named prepared statements | none |
| `SET search_path`, `SET SESSION`, `SET TIME ZONE` | none |
| cursors (`DECLARE`) | none |
| `LOCK TABLE` | none |
| temp tables | none |
| **`pg_advisory_lock`** | **one real call site** |

hezo is otherwise already pooler-compatible. **But that is a snapshot, and the
property regresses silently.** If a database line rests on it, it needs a guard
that fails when someone adds a `LISTEN` — not a table in a document.

**Three docs pages contradict this and change in the same PR:**
`docs/deployment/configuration.md:306-307` (prohibits transaction pooling),
`configuration.md:85` (documents the range as "2-100"), and
`docs/deployment/one-click.md:137-138,209,235-240`.

**AC:** an instance starts and migrates on `database.poolSize: 1`; the same
instance starts and migrates through a **transaction-mode PgBouncer**; the
concurrent-migration guard still holds wherever two processes can share a
database; a deadlock-class audit is recorded; the pooler-compat guard fails on a
deliberately-added `LISTEN`.

---

## H15 — Wire up the policy-file watcher

`watchPolicyFile()` (`config/policy.ts:78-135`) is written, correct, debounced,
and re-arms after every event to survive the inode swap from a `rename()`. It is
also **never called anywhere** — repo-wide grep returns one hit, its own
definition. The only live path is `loadPolicy()` once from `cli.ts:887`.

So a policy change needs a restart today, and the cloud plan's "change a
tenant's tier by renaming a file into place, no restart" is false. Nothing
tests it, which is how it got lost.

Wire it up at startup when `policyFile` is set, and ship the test that was
missing. Bad-parse behaviour is already right — `reload()` short-circuits on
`null` and keeps the last good policy rather than unpinning.

**AC:** renaming a new policy file into place changes a pinned setting with no
restart; a malformed file keeps the previous value and logs; the watcher
survives the inode swap; nothing is watched when `policyFile` is unset.

---

## H16 — Make the container backend pinnable

`policy.pinned` covered four keys before this task, and `backend` was not one.
`containers.backend` is a bare `z.string()` in the schema, and
`backend-store.ts:160-178` lets the **stored** setting win over the config file
with a warning, falling back to Docker for an unrecognised value.

On a hosted tenant whose box runs **no container runtime at all**, a user
switching the backend to Docker in the UI breaks every run, and the control
plane has no way to stop them. The config file only sets a default; it does not
hold.

Add `backend` to the pinned set, with the same 409 the other pinned settings
get (`routes/instance-settings.ts:252-263`). Consider narrowing the schema from
`z.string()` to the `SandboxBackend` enum in the same change, so an unrecognised
value fails at startup naming the key rather than silently becoming Docker.

**AC:** a pinned backend wins over the stored setting; a `PATCH` of it returns
409 attributed to `managedBy`; the UI renders it locked; unpinned behaviour
byte-identical.

---

## H10 — Unprefix the provision-script env vars *(optional)*

`HEZO_DOMAIN_OVERRIDE` → `DOMAIN_OVERRIDE`, `HEZO_RELEASE_TAG` →
`RELEASE_TAG`, `HEZO_IMAGE_BUILD` → `IMAGE_BUILD`, across `provision.sh`,
firstboot, cloud-init, the AWS and GCP templates, the Packer image and the
deploy docs. Old names accepted as deprecated aliases that warn and keep
working. Persistence moves to `/etc/hezo/deploy.env` rather than
`/etc/environment`.

The `HEZO_` prefix implies the binary reads these; it does not. Nothing blocks
on it.

**AC:** new names work; old names work with a deprecation warning; a
DO-marketplace image build passes; docs updated in the same PR.

---

## H18 — A 1-vCPU Daytona shape *(optional, and the largest cost lever left)*

`services/sandbox/daytona/engine.ts:120` hardcodes `DEFAULT_CPU = 2` with no
key, flag or setting behind it. vCPU is roughly 75% of the container-hour rate,
so a 1-vCPU option would cut it by about 38% — which the cloud plan itself calls
the largest remaining lever on container cost.

Not a launch blocker, and not free: a 1-vCPU agent container is a product
decision about how a run feels, not only a price. Recorded here so it is chosen
rather than defaulted.

---

## Already satisfied upstream — do not build these

Recorded because the reason they are unnecessary is easy to lose, and because
each looks like a gap from the outside.

### A per-instance concurrent-run ceiling — not needed

The control plane's plan carried this because the run cap was *per project*
(`projects.max_concurrent_runs`), so a tenant with three projects could run 3×
the intended agents. `048_global_concurrency_and_container_idle_stop.sql:6` does:

```sql
ALTER TABLE projects DROP COLUMN max_concurrent_runs;
```

and the column is **gone from source entirely**. Concurrency is bounded
instance-wide by a container memory *budget* — the arithmetic lives in
`services/run-concurrency.ts`, and one-run-per-container is enforced by a
compare-and-swap (`services/sandbox/pool-db.ts:258-279`), not by convention. So:

```
concurrent runs  ≤  concurrent containers  =  (budget − chat reservation) ÷ cap
```

Setting the budget sets the ceiling.

### Container shape and pool budget — not needed

Settable from the config file today:

```js
// /etc/hezo/hezo.config.cjs — mode 600
module.exports = {
  containers: {
    backend: 'daytona',
    daytona: { apiKey: '…' },
  },
  policy: {
    managedBy: 'Hezo Cloud',
    manageUrl: 'https://app.hezo.ai/dashboard',
    pinned: { maxContainerMemoryGb: 12 },
  },
};
```

The pin **wins over the stored value**, in `lib/system-meta.ts`:

```ts
export async function getMaxContainerMemoryGbSetting(db: Db): Promise<number | null> {
	const pinned = pinnedSetting('maxContainerMemoryGb');
	if (pinned !== undefined) return clampMaxContainerMemoryGb(pinned);
	const raw = await getSystemMeta(db, MAX_CONTAINER_MEMORY_GB_KEY);
	...
}
```

`policy.pinned` also covers `defaultRamCapPerContainerGb`,
`defaultContainerDiskGb` and `monthlyContainerHours`. A pinned setting renders
locked in the UI attributed to `managedBy`, and a `PATCH` of it returns **409**.

The **container shape needs no override at all**: Hezo Cloud prices a
2 vCPU / 2 GB / 5 GB container, and 2 GB / 5 GB *are* the shipped defaults
(`DEFAULT_RAM_CAP_PER_CONTAINER_GB`, `DEFAULT_CONTAINER_DISK_GB`). Only the
instance-wide budget differs from stock.

**Two caveats that were originally recorded here as working and are not:** the
backend is a *default*, not a pin — that is H16. And `policyFile` is not
re-read live — that is H15. A tier change needs a restart until H15 lands.

### Anything about updates — not needed, and the original ask was wrong

The control plane's plan asked to hide the self-update UI when hosted, on the
reasoning that the control plane drives updates. **It does not, and it should
not.** A hosted tenant confirms its own updates exactly like a self-hoster: the
banner appears, the superuser presses "Install & restart", and nothing installs
itself.

The shipped defaults are already that behaviour - `config/types.ts` sets
`updates: { disabled: false, autoInstall: false }`. So **hosted writes no
`updates` block at all**, H5 hides nothing, and this repo grows no hosted branch
in the update path.

For completeness, the two keys and what they would do if ever wanted:

| Key | Effect |
|---|---|
| `updates.disabled` | closes the whole path — check, download and banner. Not set on hosted. |
| `updates.autoInstall` | installs a staged update without asking, deferring while runs are in flight. **Off, deliberately.** Revisit only as its own decision. |

The consequence the control plane must absorb: a hosted fleet runs mixed
versions, because each tenant updates when its owner says so. That is a fleet-view
and support concern, not a reason to take the choice away.

---

## Two traps for whoever writes the provisioner

**Three retired env vars are fatal, not warn-only.** `HEZO_DATA_DIR`,
`HEZO_DATABASE_URL` and `HEZO_ASSET_STORAGE_URL` are `severity: 'fatal'` in
`config/removed-env.ts`. If cloud-init leaves one exported *and* it disagrees
with the resolved config, hezo refuses to start with a multi-line diagnostic.

Every other retired variable only warns and then silently runs on its default —
the more dangerous of the two failures. There is no env-var path for the Daytona
key: `HEZO_DAYTONA_API_KEY` is warn-only and ignored. The config key is
`containers.daytona.apiKey`; the asset-storage key is `assetStorage.url`.

**`provision.sh` does not quote credentials into the generated config.** Lines
300 and 306 append the database URL and the S3 URL into the `.cjs` by raw `echo`
with no shell-quote escaping. A `'` in a generated password produces a
syntactically invalid config file and the instance will not boot. **The control
plane generates these credentials**, so either it constrains its alphabet or
this repo fixes the escaping — the latter is better, and is a two-line change.
