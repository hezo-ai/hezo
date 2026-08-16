# Container backends → cheaper alternatives to Daytona — Cost Comparison

Comparison of managed sandbox providers and self-hosting against Hezo's
current Daytona backend, written 2026-08. This is a **decision reference,
not a commitment**: it records what each option costs, which ones can
actually satisfy `ContainerEngine`, and where the break-even sits. Every
provider price was read from that provider's own pricing page at the date
above and **will drift** — both Scaleway and Hetzner raised prices in June
2026 — so re-check before acting on any figure here.

**Verdict up front:** nothing in the managed AI-sandbox category is
dramatically cheaper at equal API fit. Morph Cloud (-40%) and Freestyle
(-20%) are the only genuine savings; E2B and Blaxel price identically to
Daytona. Self-hosting on the Docker backend Hezo already ships is cheaper
still, but on Scaleway specifically the margin is thin — ~$30-43/month
against Daytona's ~$51 — because Scaleway Instances are priced well above
budget-VPS rates and the workload needs 32 GB, which forces Elastic Metal.
**At the modelled load the money is close enough that the case for moving
is capacity headroom and the absence of an hour meter, not the bill.**

## Assumptions

These were fixed by the operator; the arithmetic below depends on them.

| Assumption | Value | Note |
|---|---|---|
| Per-container RAM | **4 GB** | `default_ram_cap_per_container_gb`; shipped default is 2 (`packages/shared/src/constants.ts:79`) |
| Fleet memory budget | **12 GB** | `max_container_memory_gb`; gives 3 concurrent task runs |
| Per-container vCPU / disk | 2 vCPU / 4 GB | Daytona's `DEFAULT_CPU`; disk default 5 GB gives a 4 GiB pool ceiling |
| Preferred host vendor | **Scaleway** | |
| Load | 3 concurrent, a few hours a day | ~300 container-hours/month, derived below |

## What "same programmatic API" actually means

`ContainerEngine` (`packages/server/src/services/sandbox/types.ts:228`) has
28 required methods. Most are ordinary REST calls, but four filter the
candidate list hard — a provider failing any one of them is unsupported,
not a second code path.

| Requirement | Where | Why it filters |
|---|---|---|
| `openExecChannel` — a **bidirectional** byte channel | `types.ts:300` | Carries the whole multiplexed tunnel (MCP endpoint, egress proxy, ssh-agent, git). Daytona uses a PTY WebSocket; Docker uses a hijacked exec socket. A provider with stdout-only exec cannot host it. |
| `files()` — `SandboxFiles` read/write | `types.ts:374` | Needs a real file API or SFTP. No host-filesystem fast path is permitted. |
| `stopContainer` preserving the filesystem | `types.ts:265` | The container pool stops idle members and resumes them. |
| `containerStats` returning a real working-set figure | `types.ts:287` | Required, not best-effort — `null` means "no reading this tick", never "unsupported". |

The tunnel must also sustain **≥1000 B/s** or in-container git aborts
(`adding-a-container-backend.md`), and a new backend inherits
`describeContainerBackendConformance` (`test/conformance/index.ts:43`,
6 suites / 3,798 lines), which proves or disproves all of the above
empirically rather than by inspection.

Reference cost of building one: the Daytona adapter is 4 files, ~2,693
lines (`sandbox/daytona/`), hand-rolled REST/WS with no vendor SDK.

## The memory arithmetic

### The budget is not a container count

`max_container_memory_gb` is a **memory budget** (`constants.ts:119-136`):
each running container subtracts what it asked for. At 12 GB with a 4 GB
cap that is 3 concurrent task runs, as intended.

Worth recording what the shipped defaults would have done, because it is a
trap. `containerHostMemory()` returns `null` on a managed backend
(`daytona/engine.ts:741`), so the budget falls back to the flat
`DEFAULT_MAX_CONTAINER_MEMORY_GB = 6` (`constants.ts:161`) — a deliberate
spend guard, not a capacity estimate. At a 4 GB cap that is **one**
concurrent run, and nothing announces it; runs simply queue. Raising the
budget to 12 is what makes the 4 GB decision viable at all.

### The CEO chat container sits outside the budget — and is billed

A pool member flagged `reserved_for_chat` is excluded from `usedMemoryGb`
(`services/run-concurrency.ts:136-156, 170, 191`). The **automatic**
default prices that reservation in by holding back one container's cap; an
**explicitly set** budget does not. So at `max_container_memory_gb` = 12
the chat container runs on top of the 12 GB, not inside it.

| Component | GB |
|---|---|
| Task budget | 12 |
| CEO chat container (unbudgeted) | 4 |
| `HOST_RESERVED_MEMORY_GB` — OS + Hezo's own process | 1 |
| **Peak** | **17** |

A 16 GB box cannot hold this. **32 GB is the real floor**, which is the
single fact that eliminates every reasonably-priced Scaleway Instance.

On a metered backend the same fact means **peak spend is 4 containers, not
3**: 4 × $0.1656 = $0.6624/hr at full tilt, against $0.4968/hr for the task
runs alone.

### Other ceilings worth knowing

- **Stopped pooled containers are nearly free on Daytona** — disk only,
  ~$0.32/mo per member (`autoStopInterval: 10 min`, `autoDeleteInterval: -1`).
  Active container-hours drive the bill, so duty cycle dominates.
- Daytona caps a sandbox at `MAX_MEMORY_GB = 8` (`daytona/engine.ts:132`),
  so 4 GB leaves exactly one doubling.
- vCPU is fixed at `DEFAULT_CPU = 2` (`daytona/engine.ts:120`). CPU is not
  on `ContainerConfig` and **is not enforced on Docker at all**, so a
  self-hosted box oversubscribes cores rather than partitioning them.

## Provider pricing at 2 vCPU / 4 GiB RAM / 4 GiB disk

Running rate per hour. Daytona = baseline.

| Provider | Rates | $/hr running | vs Daytona | API fit |
|---|---|---|---|---|
| **Daytona** | $0.0504/vCPU-hr + $0.0162/GiB-hr + $0.000108/GiB-hr disk | **$0.1656** | — | current |
| E2B | identical CPU/RAM rates; 10-20 GiB disk free | $0.1656 | 0% | good, no saving |
| Blaxel (S tier, 4 GB) | bundled by memory tier + $0.12/GB-mo | $0.1656 | 0% | good, no saving |
| **Freestyle** | $0.04032/vCPU-hr + $0.01294/GiB-hr + $0.000086/GiB-hr | **$0.1327** | **-20%** | HTTP exec + fs API |
| **Morph Cloud** | 2 MCU × $0.05; MCU = max(vCPU, ⌈RAM/4⌉, ⌈disk/16⌉) | **$0.1000** | **-40%** | **best fit** — SSH |
| AWS Fargate (x86) | $0.04048/vCPU-hr + $0.00444/GB-hr; 20 GB disk free | $0.0987 | -40% | ECS Exec via SSM |
| **Northflank** | $0.01667/vCPU-hr + $0.00833/GB-hr + $0.15/GB-mo | **$0.0675** | **-59%** | **exec is unidirectional** |
| Cloudflare Containers | $0.072/vCPU-hr **active only** + $0.009/GiB-hr + $0.000252/GB-hr | $0.076 idle + active CPU | varies | no arbitrary exec API |
| Modal (Sandbox tier) | $0.1419/core-hr (core = 2 vCPU) + $0.024/GiB-hr | $0.2379 | +44% | good |
| Fly.io Sprites | $0.07/CPU-hr + $0.04375/GB-hr **while awake**; $0.02/GB-mo asleep | $0.3150 awake, ~$0 asleep | +90% awake | good |
| Runloop | $0.108/CPU-hr + $0.0252/GB-hr + $0.000342/GiB-hr | $0.3182 | +92% | good |
| Vercel Sandbox | $0.128/vCPU-hr **active** + $0.0212/GB-hr wall-clock | $0.085 + active CPU | varies | 45-min session cap |

## Self-hosting on Scaleway

Using the Docker backend Hezo already ships — flat rate, unlimited hours,
zero new code.

**Instances** ship no local storage and no IPv4, so both are separate line
items: Block Storage SBS 5K at €0.0949/GB/month, Flexible IPv4 at
€0.005/hour = €3.65/month (raised from €0.004 on 1 June 2026). 80 GB is the
realistic floor — OS, the Hezo binary, the multi-GB agent-base image, and
per-project workspaces.

| Instance | vCPU | RAM | €/hr | Compute €/mo | +80 GB SBS | +IPv4 | **Total €/mo** | Verdict |
|---|---|---|---|---|---|---|---|---|
| PLAY2-NANO | 2 | 4 GB | €0.02754 | €20.10 | €7.59 | €3.65 | **€31.34** | too small |
| PLAY2-MICRO | 4 | 8 GB | €0.05508 | €40.20 | €7.59 | €3.65 | **€51.44** | cannot run one 4 GB container |
| PRO2-XXS | 2 | 8 GB | €0.0561 | €40.95 | €7.59 | €3.65 | **€52.19** | too small |
| PRO2-XS | 4 | 16 GB | €0.1122 | €81.90 | €7.59 | €3.65 | **€93.14** | **cannot hold the 17 GB peak** |

**Elastic Metal** — local disk and IP included, no add-ons:

| Server | CPU | RAM | Storage | **€/mo** | ≈ $/mo |
|---|---|---|---|---|---|
| EM-A116X-SSD | Xeon E3-1220, 4C/4T @ 3.1 GHz | 32 GB | 2 × 1.02 TB SSD | **€27.99** | ~$30 |
| **EM-A610R-NVMe** | Ryzen PRO 3600, 6C/12T @ 3.6 GHz | 32 GB | 2 × 1.02 TB NVMe | **€39.99** | ~$43 |

Monthly billing carries a one-off commitment fee of one month's rental;
hourly billing carries none.

**The key Scaleway finding: their Instances are poor value for this job,
their bare metal is good value.** PLAY2-MICRO gives 4 vCPU / 8 GB for
€51/mo all-in and cannot run a single 4 GB container. EM-A116X-SSD gives 4
real cores / 32 GB / 2 TB for €27.99 — roughly half the price for four
times the RAM.

EUR converted at ~$1.08/EUR throughout.

## Modelled at the assumed load

3 task containers × 3 h/day ≈ 270 task-hours/month, plus the CEO chat
container up ~1 h/day ≈ 30 chat-hours/month (billed, unbudgeted), plus 4
pooled members sitting stopped. Metered providers are charged on all **300
container-hours**; a self-hosted box is sized for the 17 GB peak and runs
24/7 regardless.

| Option | Monthly | Concurrent @ 4 GB | Notes |
|---|---|---|---|
| Daytona (today) | **~$50.96** | 3 + chat | 300 × $0.1656 + $1.28 disk |
| E2B | ~$49.68 | 3 + chat | disk free |
| **Scaleway EM-A610R-NVMe** | **~$43 flat** | **6 + chat** | **recommended box** — 6C/12T, 32 GB |
| Freestyle | ~$39.90 | 3 + chat | |
| Scaleway EM-A116X-SSD | ~$30 flat | 6 + chat | cheaper, CPU-thin at 4C/4T |
| Morph Cloud | ~$30.00 | 3 + chat | 2 MCU covers 4 GB **and** 8 GB — free headroom |
| AWS Fargate | ~$29.60 **+ ~$32 NAT** = ~$62 | 3 + chat | NAT gateway makes it a non-starter |
| Northflank | ~$21.90 | 3 + chat | cheapest number, worst API fit |
| Scaleway PRO2-XS | ~$100 flat | **cannot hold 17 GB peak** | ruled out |
| Scaleway PLAY2-MICRO | ~$56 flat | **0** | ruled out |

**Why EM-A610R-NVMe over the cheaper EM-A116X-SSD:** with the chat
container counted there are 4 containers × 2 vCPU = 8 vCPU of demand on 4
cores, 2:1 oversubscription. Hezo does not enforce CPU limits on Docker, so
this degrades under contention rather than refusing work, and agent runs
are mostly idle waiting on model streaming — it would probably be fine. The
€12/month buys 12 threads instead of 4 and removes the doubt, while still
beating Daytona.

### Break-even against Daytona

At a fixed 4 GB cap, Daytona costs $0.1656/hr per running container, chat
included:

| Box | Monthly | Break-even | In practice |
|---|---|---|---|
| EM-A116X-SSD | ~$30 | 181 container-hrs/mo | ~6 h/day aggregate |
| EM-A610R-NVMe | ~$43 | 260 container-hrs/mo | ~8.5 h/day aggregate |

At 300 container-hours/month both clear, but only just: EM-A116X-SSD saves
~$21/month, EM-A610R-NVMe ~$8/month. **If real usage is nearer 1-2
containers for an hour or two a day, Daytona stays cheaper and the right
move is to leave it alone.**

The 30 chat-hours/month figure is an assumption, not a measurement, and is
the least certain input in this document. Heavy CEO chat use pushes
Daytona's number up faster than the flat-rate options, since chat is billed
at the full container rate.

## Findings

### 1. Nothing in the AI-sandbox category is dramatically cheaper at equal fit

E2B and Blaxel price identically to Daytona. Modal, Runloop, Sprites and
Vercel are more expensive. The genuine savings are Morph at -40% and
Freestyle at -20%.

### 2. Morph Cloud is the best-fitting cheaper managed option

- **$0.10/hr, -40%.** The MCU formula `max(vCPU, ⌈RAM/4⌉, ⌈disk/16⌉)` means
  2 vCPU / 4 GB / 4 GB and 2 vCPU / 8 GB / 32 GB both cost 2 MCU — free
  headroom, and no 8 GB ceiling to run into.
- SSH satisfies `openExecChannel` more naturally than Daytona's
  PTY-WebSocket workaround; SFTP covers `SandboxFiles`; exec-as-user is
  free rather than the rendered `runuser` Daytona needs
  (`daytona/command.ts`).
- Snapshot/branch (~250 ms restore) maps well onto the container pool.
- **Cost:** an SSH client dependency inside the single-binary build,
  cutting against the "hand-rolled client, not the vendor SDK" rule in
  `adding-a-container-backend.md`. That is a deliberate decision to take,
  not an assumption to make quietly.
- Tiers: free (300 MCU), Developer $40/mo (1,000 MCU, effectively
  $0.04/MCU), Team $250/mo (7,500 MCU).

### 3. Northflank is the cheapest number and the weakest fit

$0.0675/hr (-59%), with `nf-compute-200` matching 2 vCPU / 4 GB exactly.
But its documented exec (`apiClient.exec.execServiceSession()`) returns
stdout/stderr readable streams **with no stdin** — unidirectional. That
leaves the multiplexed tunnel with no transport. Working around it means an
undocumented interactive WebSocket, or a publicly exposed port that
contradicts the no-inbound-port design (`sandbox/endpoints.ts:1-27`). There
is also no documented file read/write API; persistence is volumes only.
**Do not pick this on price alone without first confirming an interactive
exec exists.**

### 4. Remote Docker over TCP is deliberately unsupported, and the transport is not the hard part

`parseDockerHost` (`services/docker-socket.ts:66-82`) accepts only `unix://`
or a bare path and returns `{ kind: 'unsupported', scheme }` for anything
else, surfaced as a fatal startup message (`docker-preflight.ts:209-224`).
The docblock at `docker-socket.ts:50-56` states the reason: both request
paths are filesystem-only.

Swapping the transport is contained — 4 call sites (`docker.ts:266`,
`:286`, `:326`, `:459`), with TLS forcing `node:https`/`tls.connect` and
making the hijack return a `TLSSocket`. The real blockers are elsewhere:

- **Three host bind mounts** (`services/containers.ts:461-481`) —
  workspace, worktrees, previews. Against a remote daemon these silently
  resolve on the *other* machine and the container gets an empty workspace.
  No error.
- **Host-side `node:fs` on those same paths** — `repo-sync.ts:129-130,271-305`,
  `routes/preview.ts:38-42` (serves previews straight off the host fs),
  `routes/repos.ts:370`, `services/workspace.ts:30-109`.
- **Dev-port publishing** (`containers.ts:483-500`) binds on the daemon's
  host; the UI links `http://localhost:{port}`.
- **Image build fallback** shells out to the local `docker` CLI with a local
  context (`services/image-builder.ts:14-30`). Only the GHCR pull path
  would work remotely.
- **`containerHostMemory()`** (`docker.ts:1072-1074`) returns *this*
  process's RAM, so the fleet budget would be sized from the wrong machine.

The layers built for this already survive it: `files()` uses
`/containers/{id}/archive` explicitly so a TCP or rootless daemon works
(`docker.ts:1078-1086`, `architecture.md` § the `SandboxFiles` seam), and
the tunnel names no host at all (`sandbox/endpoints.ts:1-27`).

Per `adding-a-container-backend.md`, a genuinely remote Docker would
properly be a **second backend** (`SandboxBackend.RemoteDocker`, kind
`remote`), not a flag on the local one.

### 5. Self-hosting means co-location, and on Scaleway that means Elastic Metal

Because the Docker backend needs the daemon on the same machine, "use
Docker" means running the Hezo server and dockerd on one rented box — zero
new code, the existing `SandboxBackend.Docker` path unchanged.

On Scaleway only Elastic Metal makes that work, for two independent
reasons: their Instances are priced above budget-VPS rates, and the 17 GB
peak needs 32 GB, which no reasonably-priced Instance offers.

What you give up: microVM-grade isolation (shared kernel instead),
provider-managed capacity, and you own the ops — on bare metal that
includes hardware failure being your problem. For a single-operator
instance running its own agents that is usually acceptable; for untrusted
multi-tenant code it is not. See `microvm-assessment.md` for the isolation
side of that trade in detail.

## Recommendation

1. **Size for 17 GB, not 12.** The chat container is unbudgeted, so peak is
   12 + 4 + 1. This rules out every Scaleway Instance — 32 GB is the floor,
   meaning Elastic Metal.
2. **Stay on Daytona if aggregate container time is under ~6 h/day.** Below
   that break-even, Daytona is cheaper than any Scaleway box rented to
   replace it. At the modelled 300 container-hours/month it clears, but not
   by much.
3. **Above the break-even: Scaleway Elastic Metal EM-A610R-NVMe (€39.99,
   6C/12T, 32 GB)**, running Hezo and dockerd together on the existing
   Docker backend. No new code, no hour meter. Bill hourly at first to skip
   the one-month commitment fee. EM-A116X-SSD (€27.99) saves €12 but leaves
   the box 2:1 oversubscribed on CPU once chat is counted. Either box can
   later take the budget to 27 GB — 6 concurrent runs — at no extra cost.
4. **If it must stay managed: Morph Cloud** (~$30/mo, level with the
   cheaper bare-metal box). Budget ~2,700 lines for the adapter, matching
   Daytona's shape, and settle the SSH-dependency question first.
5. **Do not switch to E2B or Blaxel** — identical pricing, all cost and no
   saving.
6. **Do not use Scaleway Instances for this.** PLAY2-MICRO cannot run even
   one 4 GB container; PRO2-XS costs twice Daytona and cannot hold the peak.
7. **Revisit Northflank only if** an interactive/bidirectional exec turns
   out to exist; the -59% is real but currently unusable.

### If the vendor is negotiable

Scaleway is a premium-priced host for this workload. Budget providers
(Hetzner's CX line starts around €4.49/mo for 2 vCPU / 4 GB / 40 GB **with**
local disk and IP included) would push the self-hosting break-even down to
roughly 1 h/day and make it the obvious answer rather than a marginal one.
The marginal conclusion above is driven by Scaleway's pricing, not by
Hezo's architecture.

## Verification, if any option is pursued

Prove a candidate against the live provider before adapter work starts,
never infer from docs — `adding-a-container-backend.md` says the same. The
cheap probe, in order:

1. Provision one container at 2 vCPU / 4 GB / 4 GB and confirm the
   provisioned figures are read back as a real guarantee.
2. Open a **bidirectional** channel and push ~10 MB of incompressible
   binary both ways, measuring throughput against the 1000 B/s floor.
3. Round-trip a file in and out via the provider's file API.
4. Stop and restart; confirm the filesystem survives and no processes do.
5. Only then write a `LiveAdapterFixture` and run
   `describeContainerBackendConformance` — it answers the rest.

For the self-hosted route there is no adapter to prove, but two things are
worth measuring before committing: actual aggregate container-hours (from
`heartbeat_runs`, to confirm the break-even is really cleared) and real CEO
chat usage, which is the least certain input here.

## Watch list

Re-check these before acting; they are the figures most likely to have
moved.

- **Daytona, E2B, Morph, Freestyle, Northflank rates** — the whole
  comparison is one repricing away from a different answer.
- **Scaleway Instance and Elastic Metal pricing, Block Storage SBS, and the
  Flexible IPv4 rate** — all raised in June 2026; Elastic Metal stock also
  varies by region.
- **Northflank exec** — if an interactive/bidirectional exec ships, it
  becomes the cheapest viable option by a wide margin.
- **Morph's SSH-only exec** — if it gains an HTTP exec API, the
  single-binary SSH-dependency objection disappears.
- **Daytona's `MAX_MEMORY_GB = 8`** — a 4 GB cap leaves one doubling before
  the backend itself becomes the constraint.

## Sources

Provider pricing pages for Daytona, E2B, Modal, Northflank, Beam, Morph,
Runloop, Cloudflare, Fly, Freestyle, Vercel, Scaleway (virtual-instances,
storage, elastic-metal, IP billing) and Hetzner, plus the Northflank and
swerdlow.dev comparison calculators and the sandbox-comparison.pages.dev
latency benchmark. All retrieved August 2026.
