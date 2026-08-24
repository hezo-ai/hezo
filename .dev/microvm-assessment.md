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

**Status (2026-08).** Phase 0 (container hardening) shipped in full - `Init`, `MemorySwap`,
`PidsLimit`, `CapDrop: ALL` with the stated add-back set, `no-new-privileges` deliberately
omitted, `userns-remap` skipped. Phase 1 shipped in a richer shape than proposed: the seam is
`ContainerEngine` with a Daytona adapter beside Docker, and its authoring guide is
`adding-a-container-backend.md`. Phase 2 (a microVM backend) was never built and is not
planned. Rootless Docker, listed below as an unverified spike, is now auto-detected and
supported.

What survives here is the part that cannot be reconstructed from the code: why Firecracker,
Kata and gVisor were rejected, which operating systems can host what, and whether the
isolation gain was worth it. The migration-surface section that opened the original document
has been dropped - it described a pre-seam codebase and is contradicted by the seam that now
exists.

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
