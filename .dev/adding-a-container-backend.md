# Adding a container backend (Docker, Daytona, …)

The contributor guide for authoring a `ContainerEngine` adapter. For what the seam *is* and how a run uses it, see `architecture.md` § 5 (*The container-engine seam*). The two rules that bind every caller, not just adapter authors, are in `AGENTS.md`; everything below is for the person writing or changing an adapter.

## The seam

Every backend sits behind one seam, `ContainerEngine` (`services/sandbox/types.ts`); every caller above it talks only to that interface.

**Nothing above the seam may learn which backend is in use** — no provider name in a conditional, no provider-shaped field on a shared type, no "if remote". Each adapter is one directory of three files:

- **`sandbox/<provider>/client.ts`** — a hand-rolled REST/SDK client (not the vendor SDK, so the dependency stays out of the single-binary build) exporting the narrow port interface the engine drives, so tests supply a complete fake rather than a partial cast through `unknown`.
- **`sandbox/<provider>/command.ts`** — a pure renderer turning an exec into what the provider accepts (argv-to-string, user-switching, stream separation).
- **`sandbox/<provider>/engine.ts`** — the `ContainerEngine` implementation.

**Host-side work gets a seam method, never a call-site branch** — one method every backend answers, a real implementation on the ones that need it and an explicit commented no-op elsewhere. Reach for a new method whenever you catch yourself asking *which* backend you have; `createStubDocker` and `fake-docker.ts` must both answer it.

- **Grep the shape, not the name** — `instanceof` carries no provider name for a name-grep to find:
  ```sh
  grep -rn "instanceof DockerClient\|instanceof DaytonaEngine\|=== SandboxBackend\.\|!== SandboxBackend\." \
    packages/server/src packages/web/src --include=*.ts --include=*.tsx
  ```
  Hits are legitimate **only** where a provider is constructed or labelled (`sandbox/open.ts`, a display table); anything else is a bug, and a hit on the run path always is.
- **`instanceof` against the holder is always false** — callers hold the `SandboxBackendHolder.engine` proxy — so the branch doesn't just couple to a provider, it silently stops running.

**Ask what *kind* of backend it is, never which one** — a provider name in a conditional is a class property in disguise, hiding best in settings and credential plumbing where it reads as configuration. One table in `@hezo/shared`, callers asking the derived question:

```ts
export const SANDBOX_BACKEND_KIND: Record<SandboxBackend, 'local' | 'remote'> = {
    [SandboxBackend.Docker]: 'local',
    [SandboxBackend.Daytona]: 'remote',
};
export function sandboxBackendNeedsApiKey(b: SandboxBackend): boolean {
    return SANDBOX_BACKEND_KIND[b] === 'remote';
}
```

`Record<SandboxBackend, …>` makes a new backend a compile error until it declares its kind; use the *kind* rather than a bare `needsApiKey` so the next class-wide question extends the same table. Naming a provider is still fine for **which credential** (`--daytona-api-key`, the `DAYTONA_API_KEY` vault entry, `DaytonaClient`) — never for **whether one is needed**.

**Runtime-agnostic logic is shared, not reimplemented per adapter** — every engine runs the identical in-container scripts and reads them with the identical parsers (`sandbox/proc-scripts.ts`: the `/proc` scan and kills, the `df` disk measurement, the cgroup memory measurement), differing only in the transport that carries them. Same for the endpoint map (`sandbox/endpoints.ts`), file access (`sandbox/files.ts`) and the exec handle (`sandbox/handle.ts`). **Never import a measurement from another adapter's module** — if a helper you need lives in `docker.ts`, move it to `proc-scripts.ts` rather than reaching across.

**`containerStats` is required, not best-effort.** It is what `enforceContainerMemoryLimit` stops a container on, and an adapter that answers `null` forever has silently turned the memory cap into a number nothing checks. Run `buildMemoryUsageScript()` over your exec transport and hand the output to `parseCgroupMemory` — prefer something on your control plane only if it is genuinely cheaper *and* computes the same working set (total charge less reclaimable file pages), which is what makes one threshold mean one thing across backends. `null` is reserved for a reading that could not be taken this tick, never for "this backend does not do that".

**`inspectContainer` reports the memory ceiling the container was provisioned to cover** (`ContainerInfo.HostConfig.MemoryBytes`), and every adapter answers it. It backfills `container_pool_members.memory_bytes` for a container whose allocation was never recorded — one adopted from outside the pool, or predating the column — which otherwise reads as unknown-sized for the rest of its life. **Report the guarantee, not the raw control-plane figure**: any margin your adapter adds on create is subtracted back off (`cgroupLimitAsCeiling` inverts `withCgroupHeadroom` on Docker), so what the caller sees is what it asked for. Where the provider's unit is coarser, report what it actually allocated — that rounds *up*, which is the direction that keeps a backfilled figure conservative. `null` means this backend could not say for this container, never "this backend does not do that"; the caller then leaves the record alone rather than writing a guess. The field is optional on the type only so a test double that provisioned nothing can stay a literal — `describeContainerBackendConformance` is what holds you to it.

## Provisioning and lifecycle

**Never provision less of a resource than was asked for — refuse instead.** The per-container caps are guarantees the rest of the system is sized against, so a quietly-smaller container OOMs mid-run and reads as an agent failure. Round *up* when the provider's unit is coarser (a 1.5 GB cap asks for 2 GB, never 1); over the ceiling, throw a named error stating the request, the ceiling and which setting to lower (`DaytonaMemoryCapExceededError` is the worked example). Memory, disk and CPU alike.

The caller records what it asked for on the pool member (`memory_bytes`, `disk_ceiling_bytes`) and the pool destroys any member whose recorded figure no longer matches the setting, so an adapter never has to resize anything — but it does mean **the guarantee has to be real**. An adapter that quietly clamps a request to what the provider felt like giving produces a container the pool believes covers a cap it does not.

That record is the request, and it stays the request: what an adapter reports back through `inspectContainer` only ever *fills* a gap, never corrects one. Reporting the rounded-up figure over a recorded one would tell the ladder the container was built to a cap nobody set, so `recordPoolMemberMemoryIfUnknown` carries `memory_bytes IS NULL` in its predicate.

**The backend is switchable at runtime, so nothing may capture the engine.** It comes from a stored setting (the CLI flag seeds a fresh instance only) and changes from Settings → Containers. Take `SandboxBackendHolder.engine`, never a concrete engine, and add each new `ContainerEngine` method to the holder's delegation. Switching preflights the destination, destroys every container, then swaps — never another order, never a fallback when one backend is unreachable.

**Elevation is a flag, not a username.** The default identity differs per provider, so one adapter renders a per-exec `User` and another deprivileges from root with `runuser`. State `elevated` at the call site; each adapter renders it.

**A provider stopping a container on its own schedule is normal, and it means one pool member is suspended — never that the project's container failed.** Managed backends reclaim an idle sandbox (Daytona's `autoStopInterval`), and Hezo's idle pass cannot pre-empt it because that pass retires a pool only when the whole project is idle. Report the container as present-and-not-running and let the shared path handle it: the member becomes `suspended` and resumes in place, and only the runs *that container* was carrying end. An adapter that maps a provider-stopped sandbox to "gone" instead discards a warm filesystem and orphans the sandbox; a caller that reacts project-wide takes down runs in healthy sibling containers.

**Probe the provider; don't infer from its docs.** Measure every non-obvious behaviour against the live API, and say what was measured in the comment on each workaround.

## Telling agents what they are running on

**Declare what an agent can reach from inside each backend** in `SANDBOX_AGENT_ENVIRONMENTS` (`sandbox/agent-environment.ts`): service name, where the container runs, and the egress facts in an agent's terms — what works, what doesn't, what to use instead. `buildContainerEnvironmentBlock` renders it beside `SHARED_INSTRUCTIONS` on every run, resolved per run since the backend is a setting an operator can change. An agent told none of this can't tell a wrong command from a network that won't carry it, so it retries or reports a broken tool.

**Re-probe and restate whenever you touch an adapter** — a new backend is a compile error until it states its egress, a changed one is not.

**Keep a provider's numbers in its own docs section.** `docs/containers/remote/overview.md` states each limit's *shape* and never a figure; `docs/containers/remote/<provider>.md` carries the numbers, so nothing reads as a property of managed sandboxes in general. The Containers settings page shows only the caveats of the backend in use — **local Docker included, a backend like any other**. A new adapter ships its docs page (linked from the overview list) and its UI branch.

## Tests

**Unit, against a fake API** — command rendering, state mapping (transitional states never reading as dead), exit-code propagation, each accepted degradation. Crib `sandbox-daytona-{command,engine}.test.ts`.

**Conformance, against the real backend** — `packages/server/test/conformance/` is backend-agnostic and parameterised by a `LiveAdapterFixture`, so a new provider is a fixture file rather than a second suite. A free backend's fixture goes under `test/bun/` and runs in CI, self-skipping with a logged reason when the daemon or image is missing; a paid provider's goes under `test/live/` and is manual (`bun run test:daytona`). Where a backend legitimately can't answer something (`diskUsedBytes` may be null by design), the fixture declares it with a flag and the suite asserts the documented alternative rather than skipping silently.

**Every suite in `conformance/` runs against every adapter** (today `engine`, `files`, `agent-cli`, `egress`, `tunnel`, `git`); write any new suite generically so existing adapters pick it up.

- **`agent-cli` registers once per `modelProviders` entry, not once per fixture.** An entry names a provider *and* the `runtime` it runs on, because a credential carries its own CLI choice and an alternate runtime is by definition not the default - so resolving the runtime from the provider alone can only ever exercise defaults. Each entry provisions its own container and buys its own completion. A pairing `providerSupportsRuntime` rejects fails the suite (in `beforeAll`, so the backend's other suites still run) rather than skipping it.
- **Build that list with `liveModelProviders()`, never by hand.** It derives the matrix from `ALL_AI_PROVIDERS` × `providerRuntimes`, gated on whether each provider's key is present, so a provider that gains an alternate CLI is covered with no edit and cannot be quietly missed. Keys are `HEZO_<PROVIDER>_API_KEY`; the local runners take `HEZO_OLLAMA_BASE_URL` / `HEZO_LMSTUDIO_BASE_URL` and are unreachable from a managed backend, since `localhost` inside a container is the container. `HEZO_LIVE_MODEL_<PROVIDER>` overrides the pinned model. Subscription credentials come from `HEZO_<PROVIDER>_SUBSCRIPTION_FILE` (a path to the blob) and are materialised through production's `buildSubscriptionMount`, so a provider can contribute both an api-key and a subscription entry for the same runtime; Codex's rotates on use and the suite cannot write it back, which it warns about rather than silently consuming. `HEZO_CONFORMANCE_DUMP` writes one directory per pairing (`<backend>-<provider>-<runtime>-<authmethod>/`) - fixed filenames would leave a multi-entry run holding the evidence of exactly one of them.

- **A fixture registers the set, never individual suites** — `describeContainerBackendConformance(fixture, harness)` (`conformance/index.ts`) is a backend entry point's only call, and `conformance-coverage.test.ts` asserts both directions. Adding a suite fails the build until it is in the set.
- **Never add a backend-specific end-to-end test.** Worth asserting against one live backend means worth asserting against all.
- **A suite that can't do its job refuses rather than skips** — a skip reports green while asserting nothing. The egress suite needs the image to carry `hezo-tunnel` and says so.
- **From source, agent-base builds into the local daemon's image store** — right for Docker, invisible to a registry-backed provider, which pulls. `HEZO_AGENT_BASE_IMAGE=ghcr.io/hezo-ai/agent-base:<sha>` overrides it for every project that doesn't name its own, on Docker too; `assertRegistryPullableImage` refuses the local-build sentinel with a message naming the variable rather than letting the provider report a confusing build failure.
- `HEZO_CONFORMANCE_IMAGE` points at the image CI published. `build-agent-image` tags with `github.sha`, the *merge* commit on a `pull_request` — resolve with `git ls-remote origin refs/pull/<pr>/merge`, re-resolving rather than reusing a stale tag:
  ```sh
  HEZO_CONFORMANCE_IMAGE=ghcr.io/hezo-ai/agent-base:<merge-sha> \
  HEZO_DAYTONA_API_KEY=… HEZO_DEEPSEEK_API_KEY=… bun run test:daytona
  ```
- `test/live/**` is excluded from `vitest.config.ts`, and `vitest.live.config.ts` **throws if `CI` is set** — a key reaching CI must never start billing. Every container the suites create carries the `hezo.conformance` label and is swept on the way in as well as out.

## Testing the tunnel and git transport

The transport suites are the only thing standing between a working adapter and a run that silently does nothing, and they are unusually easy to write in a shape that passes while production fails. Every rule below is one that was learned the expensive way: a provisioning clone failed on a managed backend with `expected flush after ref listing` while `tunnel` and `git` were green on both backends.

**The trap is always a variable held constant.** Each suite fixed one half of a pair and tested the other, so a combination production runs on every repo add was covered by nothing. Before adding a transport assertion, ask which of these it holds constant, and whether anything else varies it.

| Axis | The easy half | The half production runs |
|---|---|---|
| Payload | printable ASCII | TLS records, i.e. incompressible bytes |
| Volume | nine bytes | megabytes, and a rate that matters |
| Git protocol | dumb HTTP (static files) | smart HTTP (pkt-line, chunked, streaming `POST`) |
| Remote | a fixture server on host loopback | a real host, over the internet |
| Credential | none, or a local server's Basic realm | a real `401` → retry-with-`Authorization` |
| Container state | freshly created and idle | already holding a tunnel and streaming an exec |

**A payload that is anyone's text proves nothing about a binary channel.** ASCII survives a UTF-8 decode, a tty line discipline and an escape filter unchanged, so a transport that mangles anything else passes it — and every byte a CONNECT tunnel carries is the other kind. Keep both cases: the printable one shows truncation as a clean short count, the binary one is the only thing that catches corruption. Build the binary payload as every value `0x00`-`0xff` as a prologue plus a CSPRNG tail, not random alone — NUL, CR, LF, XON, XOFF, SUB, DEL and the high range must cross on *every* run, not with probability. Compare by digest, both directions in one round trip against the same buffer; a byte count is blind to corruption.

**Assert a rate, not just arrival.** An in-container `git` abandons a transfer that spends 30s under 1000 B/s (`GIT_HTTP_TIMEOUT_ENV`, `git-executor.ts`), so a backend below that cannot clone at all — a correctness bound, not a benchmark. Keep the floor as **one shared constant**: a per-fixture floor is a capability branch wearing a config hat, and a slow backend would declare itself conforming. Time in-container around the transfer alone; an exec's own startup is around a second on a managed backend and folding it in makes the floor a lie.

**Dumb HTTP is not smart HTTP.** A fixture repo served as static files needs no git server, which is why it is tempting, but it exercises none of what a real host does: a `service=git-upload-pack` advertisement in pkt-line framing, a chunked response, and a negotiation `POST` whose request and response stream *concurrently*. That last one is the only exchange where the proxy pipes both directions of a single request at once — a proxy that buffered a request body before opening its upstream would deadlock exactly there while every request/response test stayed green. Assert both halves against a real host through the proxy: `ls-remote` for the advertisement, a full clone for negotiation and pack.

**A credential leg must eventually meet a real host.** The `401` → retry-carrying-`Authorization: Basic` sequence is the server's behaviour, not git's, so a fixture that answers `401` on the first request tests a different dance. Gate the real-repo leg on operator-supplied env (`HEZO_LIVE_GIT_REMOTE` + `HEZO_LIVE_GIT_TOKEN`) and **register the `it` only when both are set** — an assertion that cannot run is better absent than reported as a skip that reads like coverage.

**A quiet container is the state production never provisions in.** A repo add does not create a container; it reuses the project's running one (`repo-provisioning.ts`), and `withProvisionBridge` opens its **own** tunnel beside the agent's for the duration of the git op. So two tunnels on one container is normal, not exotic — the 300-wide `TUNNEL_PORT_RANGE` exists because they used to collide and it presented as "the tunnel client did not bind its ports". Assert a seam clone with a second tunnel up *and* a megabytes-scale exec streaming concurrently; on a managed backend that stream is a separate long-lived HTTP response and is observably fragile under volume.

**Test a container-side script inside a container, not on the host.** The `/proc` scripts (`proc-scripts.ts`) are pure strings built on the host, so running them through the host's own `sh` looks equivalent and is not: `/proc` is Linux-only, and on macOS the port probe's `grep` fails on a missing file while the kill loop's `/proc/[0-9]*` glob matches nothing. Both degrade to **silence**, so every assertion expecting silence passes - four of six did exactly that on a Mac while two failed, which is a worse signal than not running at all. The coverage lives in `conformance/engine.ts` where the scripts run in a container; the host-side file is gated to Linux and is fast local echo, not the coverage. Same rule for any future container-side script.

**A test setting that switches production behaviour off is a coverage hole, not a convenience.** `allowPrivateTargets: true` is the worked example: it exists so a suite can reach a loopback fixture, and it also disables the egress destination guard for *every* host - taking the whole suite off the resolve-then-dial path production runs. A defect lived there unseen (a custom DNS `lookup` silently dropped the body of any request that had one, so every proxied `POST` reached its upstream empty) because no suite in the repo ever exercised it. Exempt the *one* address the fixture needs, via `selfEndpoint`, rather than turning the rule off globally - and when a flag reads "allow X", check what else it permits before setting it in a test.

**A precondition that makes an assertion conditional is a vacuous pass waiting to happen.** `if (toolIsPresent) { expect(...) }` reports green on an image without the tool. Bind a port with `node` rather than `nc`, count processes by scanning `/proc` rather than with `ps` - the agent image installs no `procps` - and reach for the things the image is guaranteed to carry so nothing has to be conditional.

**Run Docker before the paid backend, always.** It is free, it is the control experiment, and the two transports fail differently — Docker hands the tunnel a raw socket, a managed provider may put a terminal and a WebSocket in the path. A failure on Docker localises the fault off the provider entirely and costs nothing to reproduce. Note the Docker fixture hardcodes `hezo/agent-base:latest`, so `HEZO_CONFORMANCE_IMAGE` does **not** apply to it and the image must be built locally:

```sh
docker build -t hezo/agent-base:latest -f docker/Dockerfile.agent-base docker
bun test ./test/bun/sandbox-conformance-docker.bun.test.ts
```

### When a stall is not reproducible

A stalled transport reports nothing by itself: the keepalive keeps the socket looking healthy, the framing layer waits for bytes that never come, and the only artifact is git's `curl 28` thirty seconds later, which names the symptom and nothing else. So the transport carries always-on anomaly detection, silent on a healthy run and each pointing at a distinct layer:

| Signal | Where | What it means |
|---|---|---|
| `tunnel stream N has been blocked for Ns` | `tunnel/mux.ts` | flow control has held bytes it cannot move; fires at 20s, deliberately below git's 30s floor so the diagnosis lands before the failure. The predicate is "we have bytes and cannot move them", never "no traffic" — a tunnel is legitimately silent for minutes while an agent thinks |
| `tunnel channel closed holding N byte(s) of a partial frame` | `tunnel/mux.ts` | the channel stopped mid-frame; the streams above lost their tail |
| `tunnel framing error … next bytes [hex]` | `tunnel/mux.ts` | the hex is the diagnosis: `ef bf bd` runs mean something re-encoded the binary stream as text, plausible payload bytes mean a header was read at the wrong offset because bytes were lost |
| `egress bridge … discarded N unflushed byte(s)` | `egress/proxy.ts` | a CONNECT leg was destroyed while its peer was behind; `destroy()` cancels queued writes rather than flushing them |
| `Daytona PTY … waited Ns for the socket to drain` | `daytona/client.ts` | the far end stopped reading; the wait is unbounded by design, since the alternative is dropping bytes the framing layer has already counted |
| `delivered a text frame after the handshake` | `daytona/client.ts` | a framed binary protocol cannot survive one — the bytes were UTF-8 decoded before this code saw them and are unrecoverable |

`HEZO_EGRESS_DEBUG=1` adds per-connection lifecycle tracing on top. Counters (`TunnelMux.stats`) are always collected and never logged on their own, so a suite asserts numbers rather than grepping a log: `payloadBytesIn + 9·framesIn + decoderPending` should account for every byte the channel delivered.
