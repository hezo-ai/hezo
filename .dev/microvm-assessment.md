# Docker containers → microVMs — Feasibility Assessment

Assessment of replacing (or augmenting) Hezo's per-project Docker containers
with microVMs, written 2026-07. This is a **decision reference, not a
commitment**: it records what the migration would take, what it would break,
what it would actually buy, and the recommended path. External facts
(hypervisor/runtime capabilities, cloud nested-virt support, Docker Sandboxes)
were verified against primary sources at the date above and will drift —
re-check the "Watch list" items before acting on them.

**Verdict up front:** a wholesale migration is feasible only on Linux hosts
with KVM, costs ~4–6 engineer-months, and breaks three load-bearing product
promises ("Docker is the only prerequisite", "any VPS that can run Docker",
five-target cross-platform binaries) — for a security gain that materializes
only on native-Linux workstations. Not worth it as a migration. The realistic
microVM story is **opt-in**: cheap container hardening now, a runtime seam,
and a Docker Sandboxes backend where hardware allows.

## The question

Every agent runs inside a per-project Docker container, and Hezo explicitly
frames that container as a security boundary (`docs/security/container-isolation.md`;
the preflight copy in `packages/server/src/services/docker-preflight.ts`).
Containers share the host kernel; a microVM (hardware-virtualized guest with
its own kernel) would upgrade that boundary. Questions: how hard, is it
feasible, does Hezo still run on every OS, and is it worth it?

## What "Docker" is inside Hezo — the migration surface

Docker is not packaging here; it is five interlocked planes. Any replacement
runtime must re-provide all five. Everything funnels through the concrete
`DockerClient` class (`packages/server/src/services/docker.ts`) — there is no
interface seam today; the test double (`services/fake-docker.ts`) is cast
`as unknown as DockerClient`.

1. **Control plane** — `docker.ts`: 17 methods over the Unix socket
   (`/var/run/docker.sock`, API v1.44): ping; image exists/inspect/pull/remove;
   container create/start/stop/remove/inspect/list-by-prefix/stats/logs; exec
   create/start/inspect; network inspect. Dual transport: Bun `fetch({unix})`
   for one-shots, raw `node:http` for the two long-lived streams (exec attach,
   log follow) because Bun's fetch enforces a ~5-minute idle timeout
   (oven-sh/bun#5930). The 8-byte multiplexed stream framing is parsed by hand
   in three places (`docker.ts` `demuxDockerStream`/`streamDockerExec`,
   `container-logs.ts`, `containers.ts` `captureContainerLogs`). The one CLI
   shell-out is `docker build` (`services/image-builder.ts`).
2. **Execution plane** (deepest dependency) — every command execution is a
   streaming `docker exec` into a persistent `sleep infinity` container:
   agent CLI runs (`agent-runner.ts`), **all git** (`git-executor.ts` — the
   host runs no git), MCP server installs (`mcp-installer.ts`), run-user
   detection/chown (`container-user.ts`), CA trust and MTU setup
   (`containers.ts`), CEO chat (`ceo-session-manager.ts`). Exec supports
   per-call `User:` deprivileging (root for chowns, `node` for agent work).
3. **Filesystem plane** — exactly four bind mounts, assembled in
   `containers.ts` `provisionContainer`: `workspace:/workspace:rw`,
   `worktrees:/worktrees:rw`, `.previews:/workspace/.previews:rw`, egress CA
   `:ro`. Bidirectional semantics are load-bearing: the host writes per-run
   config/prompts under `/workspace/.hezo/` through the mount and reads
   worktrees back; `container-user.ts` has retry machinery for Docker Desktop
   bind-propagation lag and an in-container chown dance for ownership.
4. **Network plane** — `ExtraHosts: ['host.docker.internal:host-gateway']`
   carries three container→host callbacks: the MCP server (:3100), the per-run
   egress proxy (loopback 20000–29999; env-var `HTTP(S)_PROXY` TLS-MITM with
   the per-instance CA bind-mounted + `update-ca-certificates`; placeholder
   credential substitution), and the per-run SSH-agent TCP listener (16-byte
   token) reached via the in-container socat bridge
   (`docker/scripts/hezo-run-with-bridge`, `hezo-ssh-bridge`) because Docker
   Desktop does not forward AF_UNIX bind mounts. Dev ports map from a host
   10000–19999 pool via `PortBindings`. `container-connectivity-preflight.ts`
   (~490 lines) exists solely to absorb the Docker-Desktop-vs-native-Linux
   `host.docker.internal`/bridge-gateway split and auto-rebinds the proxy/SSH
   listeners to the bridge gateway IP on native Linux. Conditional
   `CapAdd: ['NET_ADMIN']` pins the container MTU on VPN-tunnelled hosts.
5. **Image & ops plane** — `docker/Dockerfile.agent-base` (node:24-slim + the
   four coding CLIs + bun + socat + sudo) published multi-arch to GHCR;
   release binaries pull with a local-`docker build` fallback from the
   base64-embedded build context (`docker-assets.ts`, `ensure-image.ts`,
   `image-registry.ts`); custom per-project images
   (`projects.docker_base_image`) pass through. Userland memory ceiling polls
   `containerStats` and stops the container (no cgroup limit is set). Log
   follow, name-prefix self-heal (`findContainerByNamePrefix`), startup
   preflight gate, fake client for the whole test suite.

Two properties worth noting for any isolation discussion:

- Hezo sets **no** Docker security options — no `SecurityOpt`, no cap-drop, no
  cgroup limits, no restart policy; the only capability ever added is the
  conditional `NET_ADMIN`. Docker's *defaults* (seccomp, `docker-default`
  AppArmor, bounded caps) are what's active.
- The container runs in-container root with the `node` user holding
  passwordless sudo by design ("ephemeral, egress-constrained sandbox") — the
  kernel is the only boundary, which is exactly what a microVM would harden.

## External facts (verified 2026-07)

| Fact | Status | Source |
|---|---|---|
| Firecracker: Linux+KVM only, **no virtio-fs** (host FS sharing open since 2019) | Confirmed | firecracker FAQ; firecracker#1180 |
| Cloud Hypervisor: has virtio-fs (vhost-user-fs + virtiofsd); Linux-host only (KVM/MSHV) | Confirmed | cloud-hypervisor docs/fs.md |
| Kata 3.x under Docker Engine: registration works, **but Docker 26.0 and again 28+ broke Kata networking** (containers get loopback only); fix proposal open as of 2026-02 | Confirmed | moby/moby#52017, moby/moby#47626, Kata Limitations.md |
| Kata legacy caveats: no systemd cgroup driver, `docker stats` reads the shim cgroup (fidelity gap), no host network mode, virtio-fs can't back an overlayfs upper (DinD), historical exec fd-leak under exec-heavy load | Confirmed | Kata docs/issues |
| gVisor: Linux-only, no KVM needed (systrap), works as a Docker runtime — **but Claude Code has two open 2026 breakage issues under runsc, and `bun run build` hangs** | Confirmed | claude-code#27230, claude-code#35454, oven-sh/bun#16063, gvisor#11331 |
| Nested virt on Hezo's documented deploy targets: **Hetzner Cloud: none**; DigitalOcean droplets: exposed but discouraged for performance (community-sourced, medium confidence); AWS: only C8i/M8i/R8i/C7i/M7i-class since 2026-02; GCP: `enableNestedVirtualization` flag; Azure: select sizes only | Confirmed (DO detail medium-confidence) | AWS what's-new 2026-02; GCP docs; DO community Q&A |
| Apple `container` 1.0.0 (2026-06): per-container lightweight VMs, but **macOS 26 + Apple Silicon only** | Confirmed | apple/container releases |
| Windows: no shippable microVM path (KVM-in-WSL2 needs a custom kernel; WHP backends aren't embeddable in a single self-hosted binary) | Confirmed | microsoft/WSL#11216 |
| Docker Sandboxes (`sbx`): released early 2026, v0.23.x as of 2026-04; sources conflict on GA status and future pricing — treat as evolving | Confirmed existence; status flagged | docker.com blog 2026-04; docs.docker.com/ai/sandboxes; msbiro.net writeup |

## Option space

### A. Wholesale microVM replacement — **rejected**

Firecracker is disqualified outright: no virtio-fs means Hezo's bidirectional
workspace bind-mount semantics (host writing `/workspace/.hezo/` per run,
concurrent host/guest access to worktrees) cannot be reproduced without
redesigning the product's data flow around a vsock file-sync agent or
single-writer block devices. **Cloud Hypervisor (+ virtiofsd) is the only
defensible VMM.** The rebuild, per plane:

| Subsystem | Rebuild as | Estimate |
|---|---|---|
| Execution | In-guest exec agent over vsock: streaming stdout/stderr frames, exit codes, abort, per-exec user switching; rewrite of every exec call site | 3–4 wks |
| Image | OCI → ext4/erofs rootfs conversion per arch + guest kernel build/pin/distribution; rework GHCR pull + embedded-context fallback + custom-image support | 3–4 wks |
| Filesystem | Per-VM virtiofsd process lifecycle (spawn/supervise/cleanup); re-validate chown/propagation semantics | 2–3 wks |
| Network | TAP per VM + bridge/NAT; replace `host.docker.internal` with gateway-IP injection; dev-port DNAT; egress env + CA path; rewrite connectivity preflight; MTU | 3 wks |
| Ops | VM supervision, serial-console log capture, balloon/guest-agent memory stats, self-heal, crash forensics | 2 wks |
| Preflight/tests/docs | `/dev/kvm` gate, fake VMM for the suite, docs/deploy rewrite | 2–3 wks |

**Total: 15–19 focused engineer-weeks (~4–6 calendar months) to Linux-only
parity**, plus a permanent second runtime matrix if Docker is kept for
macOS/Windows — which it must be, because there is no cross-platform VMM path
a single self-hosted binary can ship (see OS matrix). Breaks macOS/Windows
support and the "any VPS" story outright.

### B. Kata / gVisor as a Docker runtime (`HostConfig.Runtime` passthrough) — **seam yes, supported mode no (today)**

Mechanically the cheap option (~50–150 LOC: a `Runtime` field on
`HostConfig`, a `--container-runtime` config, a preflight probe of `/dev/kvm`
+ the daemon's registered runtimes, docs). The Docker API, exec model, binds,
and networking all stay. But as of 2026-07 both candidate runtimes fail for
Hezo's workload:

- **Kata**: Docker Engine 28+'s containerd-task path hands Kata a shim PID
  where it expects the netns owner → containers come up loopback-only
  (moby/moby#52017 open). Until that lands, a Kata container cannot reach the
  egress proxy, MCP, or the internet — unusable. Post-fix caveats to spike:
  `docker stats` fidelity (Hezo's memory poller would read the wrong cgroup),
  virtio-fs vs the chown/propagation dance, `host-gateway` resolution,
  exec-heavy fd-leak history, and KVM required anyway.
- **gVisor**: needs no KVM (systrap) — but currently cannot run Claude Code
  (two open upstream issues) and hangs Bun builds. Shipping it would break the
  flagship agent.

### C. Container hardening without VMs — **do this regardless**

What's missing today is cheap and breaks nothing on any OS (~1–2 weeks total):

1. **Real cgroup limits**: `Memory`/`MemorySwap` + `PidsLimit` (fork-bomb
   protection is entirely absent) on `HostConfig`, driven by the existing
   per-project limit; keep the stats poller as the graceful early-stop, cgroup
   as hard backstop.
2. **`Init: true`**: PID 1 is `sleep infinity`, which never reaps zombies;
   exec-heavy long-lived containers accumulate them.
3. **`CapDrop: ['ALL']` + explicit add-back** (at minimum `CHOWN`,
   `DAC_OVERRIDE`, `FOWNER`, `SETUID`, `SETGID`, `KILL`, `AUDIT_WRITE`, plus
   conditional `NET_ADMIN`); budget a test pass across agent apt/npx installs.
4. **Do NOT set `no-new-privileges`** — verified conflict: execs run as `node`
   and runtime apt installs depend on passwordless sudo's setuid transition.
   Document the tradeoff instead.
5. **Skip `userns-remap`**: daemon-global (would remap every other container
   on the operator's machine) and breaks the bind-mount ownership model. A
   rootless-Docker compatibility spike is the better-shaped investigation
   (unverified).

### D. Status quo + VM-around-Hezo — already the de facto architecture

On 4 of 5 deployment surfaces the hardware boundary already exists: Docker
Desktop containers live inside its VM (macOS/Windows), and every documented
VPS deploy runs the entire Hezo host inside a single-purpose VM — an escape
compromises a disposable droplet, not the operator's machine.
`hosted-architecture.md` already chose **VM-per-tenant** for untrusted
multi-tenant (explicitly: containers are not a sufficient boundary against a
malicious tenant; no nested virt needed) and reserved Firecracker for a
future Hetzner-dedicated cost-packing optimization. The only uncovered
population is a developer running the binary directly on a native-Linux
workstation — the zero-code answer is a documented "run Hezo inside a local
VM" recipe.

### E. Docker Sandboxes (`sbx`) as an opt-in backend — **the realistic microVM path**

Docker's `sbx` is very nearly "Hezo's sandbox layer as a product": persistent
named microVMs on a custom VMM (Apple Hypervisor.framework on **Apple Silicon
only**, Windows Hypervisor Platform on **Windows 11**, KVM on Linux; Docker
Desktop not required; free including commercial use; closed source; requires
`sbx login` with a Docker account; telemetry with env opt-out).

What maps onto Hezo's five planes:

- `sbx create --name <n> [--memory 4g] <template> <workspace…>` — persistent
  microVM, multi-workspace mounts (`:ro` supported), **filesystem passthrough
  at the identical host path, bidirectional and instant** (plane 3 ✓).
- `sbx exec -it|-d <name> <cmd>` — docker-exec-like flags, auto-starts a
  stopped sandbox (plane 2 ✓, via child-process stdio rather than a socket
  API — there is **no documented REST/socket API**, so all ops become CLI
  spawns; precedent exists in `image-builder.ts`).
- `sbx ports <name> --publish/--unpublish` — **dynamic** port forwarding,
  strictly better than create-time `PortBindings` (plane 4, dev ports ✓).
- Custom templates: extend `docker/sandbox-templates:{shell,claude-code,…}`
  with a Dockerfile, push to a registry, `--template <ref>` —
  `Dockerfile.agent-base` rebases cleanly (plane 5 ✓).
- **Built-in SSH agent forwarding**: host `SSH_AUTH_SOCK` forwarded into the
  sandbox; keys stay host-side; signing works. Hezo's `SshAgentServer`
  already speaks the ssh-agent protocol on a host Unix socket — pointing
  `SSH_AUTH_SOCK` at it would replace the socat TCP bridge natively.
- Host-side TLS-MITM policy proxy (deny-by-default domain rules, own CA,
  `sbx policy` presets open/balanced/locked-down) with **placeholder
  credential injection** (`sbx secret set-custom`: env var + wildcard domains
  + placeholder; agent sees `proxy-managed`; proxy injects the real value at
  egress) — conceptually identical to Hezo's `__HEZO_SECRET_<NAME>__` +
  `allowed_hosts` substitution. Descriptive parity only: Hezo does **not**
  adopt it — see the credential-custody decision below.
- Each sandbox has a private inner Docker daemon — agents could run
  `docker build`/`compose`, a capability Hezo containers do not have today.

Why it can only be **opt-in**, never the default:

- Docker account login is a hard prerequisite — unacceptable as *the*
  requirement for a self-hosted product; closed-source and young
  (v0.23.x; "kits" explicitly experimental; pricing may change).
- Platform floor: Apple Silicon only (Hezo ships `darwin-x64`), Windows 11
  only, KVM-only on Linux (excludes DO droplets — the one-click marketplace
  target — and Hetzner Cloud).
- Headless/server operation is undocumented (workstation product; the Linux
  secret store falls back to an encrypted file; no systemd story).
- Overlaps Hezo's egress/credential layer — resolved by the custody decision
  below: Hezo's proxy stays the substitution point; sbx's policy proxy is at
  most a pass-through/outer layer, never the credential holder.

**Decision (2026-07): credential storage stays in Hezo.** An `SbxRuntime`
must not use sbx's credential features (`sbx secret`, `sbx secret
set-custom`, the built-in provider injection). Secrets remain
AES-256-GCM-encrypted in Hezo's `secrets` table under the in-memory-only
master key, and placeholder substitution + `allowed_hosts` enforcement +
audit stay in Hezo's egress proxy (`services/egress/proxy.ts`,
`substitution.ts`, `audit.ts`). Rationale:

- sbx stores secrets in the OS keychain with a **disk-persisted
  encrypted-file fallback on headless Linux** — outside the master-key
  custody model that makes Hezo's encryption-at-rest meaningful.
- Delegation would create two sources of truth (secrets table ↔ sbx store)
  that need syncing, and secrets would leave Hezo's vault at sync time.
- Hezo's egress audit trail (substitution events by secret name) and
  per-secret `allowed_hosts` checks live in Hezo's substitution layer;
  ceding injection to sbx loses both.
- The `request_credential` MCP flow provisions secrets into Hezo's vault; a
  second store breaks that loop.

Concretely: sandboxes keep Hezo's env-var proxy wiring (`HTTP(S)_PROXY` →
Hezo's egress proxy, Hezo CA trusted in-guest), with sbx's own proxy either
bypassed under a permissive policy or chaining to Hezo's proxy as its
upstream (`DOCKER_SANDBOXES_PROXY`, HTTP/S only).

**Spike questions that gate any build (≈1 week):**

1. Can the sandbox reach host services? The quickstart says
   `host.docker.internal` works; the isolation doc says host localhost and
   private-IP ranges are blocked. Hezo's MCP callback (:3100) depends on the
   answer.
2. Does git-over-SSH egress work under any policy? Raw TCP is "blocked at the
   network layer", yet SSH-agent forwarding is advertised for git — unclear
   how SSH transits (special case? CONNECT tunnel? open policy only?).
3. Exec exit-code/stream fidelity under CLI stdio, a container-logs-follow
   equivalent, machine-readable stats, and headless/systemd operation.
4. Per the custody decision: can sbx run with its credential injection
   entirely unused while Hezo's proxy does the substitution — CONNECT
   pass-through (or upstream chaining) that preserves Hezo's placeholder
   rewriting, and the in-guest trust path for Hezo's CA when sbx's own
   MITM CA sits in front (double-MITM)?

If favorable: `SbxRuntime` behind the runtime seam is ~3–6 weeks (CLI client
w/ streaming execs, template pipeline, SSH_AUTH_SOCK wiring, egress chaining,
preflight, connectivity adaptation, docs).

## OS-support matrix

| Host | Today (Docker) | A: wholesale microVM | E: Docker default + sbx opt-in | C: hardening |
|---|---|---|---|---|
| macOS Apple Silicon | ✅ Desktop | ❌ | ✅ (sbx available) | ✅ |
| macOS Intel (`darwin-x64` ships today) | ✅ Desktop | ❌ — no path exists | ✅ (Docker only) | ✅ |
| Windows 11 / older | ✅ Desktop | ❌ | ✅ (sbx on Win11 / Docker only) | ✅ |
| Linux workstation with KVM | ✅ Engine | ✅ | ✅ (+ opt-in) | ✅ |
| DigitalOcean droplet (one-click target) | ✅ | ❌/caveated | ✅ (Docker only) | ✅ |
| Hetzner Cloud (cloud-init target) | ✅ | ❌ — no nested virt | ✅ (Docker only) | ✅ |
| AWS / GCP / Azure VPS | ✅ | Specific families/flags only | ✅ (Docker default) | ✅ |

Answer to "will it still run on every OS?": **only if Docker remains the
default runtime.** As a replacement, microVMs cannot cover macOS Intel or
pre-11 Windows at all, and exclude most cloud VPSes.

## Worth it? — threat-model verdict

A microVM upgrades exactly one boundary: *the operator's own
(prompt-injected / supply-chain-compromised) agent armed with a
kernel-LPE/container-escape 0-day, versus the operator's host* — and only
where that boundary doesn't already exist, i.e. **native-Linux hosts running
the binary directly**. Docker Desktop already interposes a VM on macOS and
Windows; every documented VPS deploy already dedicates a VM to Hezo; the
hosted multi-tenant design already isolates tenants with full VMs.

A microVM does **not** change the channels an injected agent abuses first,
because they are intended features that must survive any hypervisor: writing
malicious code into the rw workspace the operator will run, exfiltrating
through whatever the egress allowlist permits, and using the MCP/ssh-agent
callbacks. Cross-project lateral movement (all projects share a kernel today)
does improve — but in the self-hosted model all projects already belong to
one operator's trust domain.

Weighed against the wholesale price — three product promises plus 4–6 months
plus a permanently forked runtime matrix — **the migration is not worth it.
The opt-in path is**: it captures the real (if narrow) native-Linux gain and
the marketing value ("VM-grade isolation where your hardware supports it")
without giving up a single supported platform.

## Recommended path

1. **Phase 0 — container hardening (~1–2 wks, all OSes)**: cgroup
   `Memory`/`MemorySwap`/`PidsLimit` + `Init: true` + `CapDrop ALL`/add-back
   in `provisionContainer`; keep the poller as graceful early-stop; update
   `docs/security/container-isolation.md` to state the per-OS boundary
   honestly. Explicitly no `no-new-privileges` (sudo conflict).
2. **Phase 1 — runtime seam (~1 wk)**: extract a `ContainerRuntime` interface
   from `DockerClient` (also kills the `fake-docker.ts` cast — a test-quality
   win on its own) and optionally add the experimental `HostConfig.Runtime`
   passthrough behind `--container-runtime` with a `/dev/kvm` + daemon-runtime
   preflight and loud "experimental, Linux-only" framing. Zero
   default-behavior change.
3. **Phase 2 — sbx spike (1 wk), then decide**: prototype the four spike
   questions; if favorable, build the `SbxRuntime` opt-in (~3–6 wks) as the
   "microVM isolation" mode on Apple Silicon / Windows 11 / KVM-Linux —
   with credentials remaining in Hezo's vault and Hezo's egress proxy doing
   substitution/audit (sbx's secret store unused, per the custody decision).
4. **Watch list (don't build)**: moby/moby#52017 (Kata-under-Docker fix);
   Claude-Code-under-gVisor issues (#27230, #35454) and Bun-under-runsc
   (bun#16063); Apple `container` maturation (possible future macOS backend);
   Docker Sandboxes licensing/GA/headless support; Firecracker re-enters only
   for hosted-dedicated packing per `hosted-architecture.md`.

## Open questions / spikes

- sbx: host-callback reachability, git-SSH egress, exec/stats/headless
  fidelity, and Hezo-proxy chaining with sbx credential injection unused
  (the Phase-2 spike).
- DigitalOcean nested-virt quality (community-sourced; verify against DO
  docs/support before relying on it).
- Kata virtio-fs vs Hezo's chown/propagation semantics; `host-gateway`
  behavior under Kata — only if the Docker/Kata fix lands.
- Rootless-Docker compatibility (`DockerClient` already takes a socketPath;
  host-gateway under slirp4netns unknown).

## Key files

`packages/server/src/services/docker.ts` · `containers.ts` · `fake-docker.ts`
· `docker-preflight.ts` · `container-connectivity-preflight.ts` ·
`container-user.ts` · `git-executor.ts` · `agent-runner.ts` ·
`image-builder.ts` / `image-registry.ts` / `ensure-image.ts` ·
`services/egress/proxy.ts` · `services/ssh-agent/server.ts` ·
`docker/Dockerfile.agent-base` · `docker/scripts/hezo-run-with-bridge` ·
`docker/scripts/hezo-ssh-bridge` · `.dev/architecture.md` (§ Agent execution,
§ Credentials/egress, § SSH signing & git) · `.dev/hosted-architecture.md`.

## Sources

- Firecracker: FAQ; issue #1180 (host FS sharing, open since 2019)
- Cloud Hypervisor: `docs/fs.md` (virtio-fs)
- Kata/Docker: moby/moby#52017, moby/moby#47626, kata-containers
  `Limitations.md`, Docker "alternative runtimes" docs
- gVisor: platforms/compatibility docs; anthropics/claude-code#27230 and
  #35454; oven-sh/bun#16063; google/gvisor#11331
- Nested virt: AWS what's-new (2026-02, nested virt on 7i/8i-class); GCP
  nested-virtualization docs; Azure size docs; DO community Q&A (medium
  confidence); RedHat-EMEA-SSA-Team/hetzner-ocp#10 (Hetzner Cloud)
- Apple: apple/container releases (1.0.0, 2026-06; macOS 26 + Apple Silicon)
- Windows/WSL2: microsoft/WSL#11216 (nested-virt constraints)
- Docker Sandboxes: docker.com blog "Why microVMs" (2026-04);
  docs.docker.com/ai/sandboxes (+ architecture, security, security/isolation,
  security/defaults, security/credentials, customize, FAQ); `sbx` CLI
  reference (create/run/exec/ports); msbiro.net "Docker Sandboxes: Running AI
  Agents in YOLO Mode, Safely" (v0.23.0 hands-on); dockersamples/sbx-quickstart
