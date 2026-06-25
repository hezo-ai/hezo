# Hosted Hezo — Architecture Recommendation

This document records the recommended backend architecture for a hosted,
click-to-signup version of Hezo, and the analysis behind it. It is a design
reference, not an implementation spec; the build-out (control plane) is a
separate effort.

- **Goal:** a hosted product where a user signs up and starts using Hezo
  immediately, with no local install — scaling to ~100 users with the least
  effort.
- **Threat model:** untrusted / open signup. Anyone can sign up and run
  arbitrary agent code. The isolation boundary must hold against a malicious
  tenant.
- **Availability:** every tenant instance is **always-on**. A signed-up user
  expects their Hezo to keep doing background work (agents picking up tasks,
  heartbeat wakeups) whether or not they are attending to it. Instances are
  **not** transient and must not scale to zero. This is Hezo's natural mode — it
  is designed to run as a persistent server with a recurring heartbeat — so
  always-on *removes* the snapshot/resume recovery risk that a suspend-based
  model would introduce. The cost question is therefore "run 100 always-on
  instances cheaply," not "minimize idle footprint by suspending."

## The question

Two candidate backend shapes:

1. **Instance-per-tenant** — one isolated Hezo instance per user (a micro-VM
   that runs Hezo, which in turn launches Docker containers). Many isolated
   instances.
2. **Single-DB multi-tenant** — a restructured Hezo with one database and one
   host that serves many users and launches many containers, appearing as many
   instances to users.

## Recommendation

**Adopt instance-per-tenant, isolated by a hardware-virtualization boundary
(micro-VM). Do not build the single-DB multi-tenant rewrite.**

For untrusted signup, the single-DB rewrite is the worse choice on *both* axes:
it is a very large rewrite **and** it yields a weaker security boundary.
Instance-per-tenant requires ~zero changes to Hezo core; the only real new work
is a thin **control plane** around an unmodified binary. At 100 users this is
easily achievable and the cheapest path to ship.

## Why — what the code forces

Hezo is single-tenant by design at three independent layers. Any one would make
the rewrite expensive; together they make it a rewrite of the system's spine.

### 1. The data model is hardcoded to one instance

(`packages/shared/src/constants.ts`, `packages/server/migrations/001_initial_schema.sql`)

- Fixed `DEFAULT_TEAM_ID = 00000000-…-0001` and team slug `'default'`; exactly
  one `is_internal=true` HQ project; CEO/Coach/HQ are **instance singletons**
  resolved globally by slug (`services/team-template-apply.ts`
  `ensureInstanceCeo` / `ensureInstanceCoach`).
- `ceo_sessions` carries a singleton unique index (one live CEO chat per
  instance).
- Global `UNIQUE` constraints with **no `tenant_id` column anywhere**:
  `projects.slug`, `secrets.name`, `oauth_connections`, `mcp_connections.name`,
  `skills.slug`, `ai_provider_configs(provider, label)`, `api_keys.prefix`.
  Tenants would collide on every one of these.
- A per-instance master key derives the JWT signing key and the AES-256-GCM
  encryption for the *whole* database; an approved API key is admin-equivalent
  across **all** teams.

A real multi-tenant DB means threading `tenant_id` through ~50 tables,
converting every global unique into a composite, per-tenant CEO/Coach/HQ
singletons, per-tenant keys, and tenant-scoped authorization on every route,
MCP tool, and WebSocket room. That is the spine of the system, not an add-on.

### 2. The runtime assumes it owns the host

(`services/docker.ts`, `services/containers.ts`, `services/egress/*`, `db/client.ts`)

- Embedded **PGlite** — one process per `dataDir`; concurrent opens corrupt it.
  A Hezo process is therefore already, by construction, a single-tenant unit.
- Exclusive `/var/run/docker.sock`; one long-lived container **per project**;
  in-memory, per-process egress port allocators (front 20000–29999, host MITM
  30000–39999, dev ports 10000–19999); `/tmp/hezo-<hash>/` run sockets.

### 3. Security boundary — decisive for untrusted signup

Hezo agents execute **arbitrary untrusted code** inside Docker containers.
Containers share the host kernel and are **not** a sufficient boundary against
a malicious tenant (container escape, side channels, daemon abuse). In the
single-DB / single-host model, every tenant's untrusted containers sit on one
shared kernel and one shared Docker daemon — a single escape compromises all
tenants. That is disqualifying for open signup, independent of rewrite cost.

The instance-per-tenant model places the boundary at the **VM**: each tenant's
Hezo, its Docker daemon, and its containers all live inside one
hardware-isolated micro-VM. The containers Hezo spawns belong to the same
tenant, so sharing a kernel *within* the VM is fine. This matches Hezo's
existing assumptions exactly (exclusive socket, exclusive `dataDir`, exclusive
ports) — **no core changes required**.

> The "micro-VM per user, Docker inside" shape is correct. The one refinement:
> the isolation unit must be a real hardware VM, not a shared-kernel container,
> because signup is untrusted.

## Recommended topology

```
            ┌────────────── Control plane (new, thin) ──────────────┐
 signup ──▶ │  auth/identity · provisioner · router · lifecycle ·    │
            │  versioning · quota/billing · secret custody           │
            └───────────┬───────────────────────────────────────────┘
                        │ provisions / routes (subdomain → instance)
        ┌───────────────┼───────────────┬───────────────┐
   ┌────▼────┐     ┌────▼────┐     ┌────▼────┐
   │ micro-VM│     │ micro-VM│ ... │ micro-VM│   one per tenant
   │  Hezo   │     │  Hezo   │     │  Hezo   │   (unmodified binary)
   │  +Docker│     │  +Docker│     │  +Docker│
   │  +PGlite│     │  +PGlite│     │  +PGlite│
   └─────────┘     └─────────┘     └─────────┘
```

Each tenant = one unmodified Hezo binary in its own micro-VM with its own
`HEZO_DATA_DIR`, `HEZO_PORT`, master key, and Docker daemon. The control plane
never touches a tenant's database; it only provisions, routes, and
lifecycle-manages VMs.

## Infrastructure options (target infra undecided)

Every option below runs each tenant VM **always-on** (no auto-stop). Auto-stop /
scale-to-zero is explicitly out of scope per the availability requirement.

| Option | Isolation | Effort to 100 users | Always-on cost posture | Notes |
|---|---|---|---|---|
| **Fly.io Machines (recommended to start)** | Firecracker micro-VM per tenant | **Lowest** — per-machine volumes, subdomain routing, simple provisioning API | Pay per running Machine, billed continuously. Fine at 100; right-size each Machine small (see cost model). Do **not** enable auto-stop. | Closest match to "click → always-on instance." Hezo runs Docker *inside* the Machine. Least control-plane code to write. |
| AWS/GCP VMs or self-managed Firecracker/Kata | Hardware VM per tenant | Medium–high (build provisioning, routing, packing yourself) | **Cheapest at scale** — pack many always-on micro-VMs per large host with CPU/RAM oversubscription. | Most control; most orchestration to own. The path once per-tenant unit economics on Fly stop making sense. |
| Kubernetes + gVisor/Kata | Sandboxed pod per tenant | Medium, with sharp edges | Always-on pods; bin-packed by the scheduler. | Nested Docker is awkward; **plain pods are NOT enough** for untrusted code — needs Kata/gVisor. Only if k8s is already the platform. |

### Cost model under always-on

Always-on does not mean always-busy. Hezo's background work is **periodic and
bursty**, not continuous: the scheduler ticks ~1 Hz but agent wakeups default to
720 min (12 h) intervals, and a run is a transient `docker exec` inside the
project's long-lived (`sleep infinity`, near-zero idle cost) container. So a
resident instance spends most wall-clock time idle, consuming only its baseline
(the Bun server + embedded PGlite + an idle container — modest), and spikes
CPU/RAM only while a run is active.

The cost levers, in order of impact:

1. **Right-size the guest.** The 16 GiB `projects.memory_limit_gib` default is a
   per-project *cap*, not a baseline — set a much smaller per-tenant floor (e.g.
   1–2 GiB) and let it burst. Baseline RAM, not the cap, is what you pay for
   100× over.
2. **Oversubscribe shared hosts.** Because instances are idle-but-resident most
   of the time, pack many always-on micro-VMs onto large hosts and oversubscribe
   CPU and RAM (KSM / memory ballooning help). Concurrent *active* runs, not
   instance count, set the true ceiling. This is why self-managed Firecracker on
   big hosts is the cheapest at scale; Fly does the packing for you but you pay
   for it.
3. **Cap concurrency & budgets.** `projects.max_concurrent_runs` (default 1) and
   the existing per-agent / per-project budget caps bound the worst-case
   resource and spend per tenant — essential when 100 instances share
   oversubscribed hosts.

> Optional, only if a tenant's work is *purely* scheduled (no event-driven
> wakeups): the platform could suspend a VM between known wakeups and resume it
> just before (Fly suspend resumes in sub-second). This reintroduces
> snapshot/resume recovery risk and contradicts the "always doing work"
> expectation, so it is **not** the default — noted only as a future lever for
> provably-idle tenants.

## What the control plane must own (the only real new work)

This is orchestration around Hezo, not Hezo internals:

1. **Signup → identity → provisioning.** Today onboarding is the
   operator-facing master-key gate (`routes/auth.ts`, `POST /api/auth/setup`),
   not self-service. The control plane owns email/OAuth signup, then provisions
   a VM and an instance per user.
2. **Master-key custody — the hard product/security decision.** Hezo's key is
   operator-held; if lost, the only recovery is `--reset` (data wipe). A
   consumer hosted product cannot expect users to custody a 12-word phrase with
   no recovery. Decide: server-side custody (KMS/HSM-backed) vs. user-held with
   explicit no-recovery UX. This is the biggest non-infra decision.
3. **Routing & OAuth base URL.** Subdomain per tenant → that VM's `HEZO_PORT`;
   set `HEZO_WEB_URL` per instance so GitHub OAuth redirects resolve.
4. **AI-provider credentials & cost.** Today providers are per-instance,
   operator-added. Decide: platform supplies a pooled key (then you need
   metering/billing) vs. bring-your-own-key. Ties directly to billing.
5. **Quotas / rate limiting / billing.** Currently absent (no rate limiting;
   no quota/billing in code). Enforce at the control plane (per-tenant run/spend
   caps) and/or via Hezo's existing per-project/agent budget fields.
6. **Version & update management.** Set `HEZO_DISABLE_AUTO_UPDATE` and roll
   versions centrally per fleet rather than letting each instance self-update.
7. **Backup / lifecycle.** Per-tenant `dataDir` volume snapshots; teardown on
   churn.

## Rejected: single-DB multi-tenant rewrite

Rejected because, for untrusted signup, it loses on both axes: (a) it requires
re-architecting the data model, auth, secrets/MCP/skills namespacing, and the
instance singletons across the whole codebase; and (b) it still co-locates all
tenants' untrusted agent containers on one shared kernel and daemon — the wrong
security posture for open signup. It would also need rate limiting, per-tenant
accounting, and secret isolation that do not exist today. More work, weaker
isolation.

## Validation before committing to a build

Three feasibility spikes confirm the path works with an unmodified core:

- **Isolation spike:** boot the stock `hezo` binary unchanged inside one
  micro-VM (e.g. a Fly Machine) with Docker available; confirm a project
  container launches and an agent run completes end-to-end with no Hezo code
  changes.
- **Always-on density spike:** run many right-sized, always-on tenant VMs on
  one oversubscribed host and measure idle baseline RAM/CPU per instance plus
  the host's ceiling under N concurrent *active* runs. This is what sets
  per-tenant unit economics — validate the baseline is small enough to pack 100
  cheaply.
- **Provisioning spike:** script "signup event → provision VM → inject
  `HEZO_DATA_DIR` / `HEZO_PORT` / `HEZO_WEB_URL` → route subdomain → reach the
  master-key gate," to size control-plane effort.

## Key files referenced

- `packages/shared/src/constants.ts` — `DEFAULT_TEAM_ID`, instance agent slugs.
- `packages/server/migrations/001_initial_schema.sql` — global `UNIQUE`
  constraints, `is_internal`, `ceo_sessions` singleton.
- `packages/server/src/services/team-template-apply.ts` — `ensureInstanceCeo` /
  `ensureInstanceCoach`.
- `packages/server/src/middleware/auth.ts`, `routes/auth.ts` — master-key gate,
  JWT, API-key scope.
- `packages/server/src/services/{docker.ts,containers.ts,egress/*}`,
  `db/client.ts` — host-ownership assumptions.
- `packages/server/src/cli.ts` — `HEZO_PORT` / `HEZO_DATA_DIR` /
  `HEZO_MASTER_KEY` / `HEZO_WEB_URL` / `HEZO_DISABLE_AUTO_UPDATE`.
