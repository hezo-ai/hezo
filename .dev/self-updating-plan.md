# Auto-update: detect, download, in-place swap & self-restart

> Status: **proposed / deferred.** Captures the feasibility verdict and a concrete
> design so we can pick this up later. Not yet implemented.

## Context

Hezo ships as a single Bun-compiled binary that operators run themselves; today
"upgrading is replacing the binary" by hand (`docs/deployment/self-hosting.md`).
We want Hezo to (1) check GitHub Releases on a schedule, (2) download the new
binary for the current platform, (3) swap it in place and restart onto the new
binary, and (4) drive the web UI through the restart — a full-screen "restarting"
view that auto-resumes, a global bottom banner when a newer version exists, and a
current-version display in settings that links to its GitHub release.

The gating question is **feasibility**: can we do runtime in-place binary
replacement + seamless self-restart on Linux, macOS, and Windows?

## Feasibility verdict — YES, with a supervisor process and platform-specific swap

The naive "overwrite my own running binary and restart myself" is unreliable:
Linux can return `ETXTBSY` overwriting an executing file, and **Windows locks a
running `.exe`** so it can't be overwritten or deleted at all. The robust,
cross-platform answer is a **thin supervisor process**:

- `hezo` runs as a **supervisor** that spawns the real server as a child
  (`[process.execPath, ...argv]` with `HEZO_WORKER=1`). The supervisor forwards
  signals and, on a normal crash/exit, exits with the child's code (so existing
  systemd/launchd/Docker restart policies behave exactly as today).
- The server (worker) downloads + verifies + **stages** the new binary, then on
  user confirmation shuts down gracefully and exits with a **restart sentinel
  code**. The supervisor sees the sentinel, performs the on-disk swap *while the
  worker is down* (no lock/`ETXTBSY` contention), and relaunches the worker from
  the new binary.

Per-platform swap (all confirmed feasible):
- **Linux / macOS:** write staged binary next to the target, `rename(2)` over
  `process.execPath` (atomic, same filesystem). The supervisor keeps executing its
  old inode; the relaunched worker runs the new file. *(macOS caveat: a downloaded
  unsigned binary can be Gatekeeper-quarantined; strip `com.apple.quarantine` via
  `xattr` after download. Long-term, releases should be notarized.)*
- **Windows:** the running `.exe` is locked, so use the NTFS **rename trick** —
  rename the live `hezo.exe` → `hezo-<oldver>.exe` (permitted while running), write
  the new binary to `hezo.exe`, relaunch the worker; clean up the stale file on the
  next supervisor start.

The supervisor itself keeps running its *old* code until a full process restart;
only the worker (the part that serves) is refreshed immediately. That's an
accepted trade-off — the supervisor is tiny and rarely changes.

**State across restart is already safe.** All durable state is in PGlite
(`<dataDir>/pgdata`) + project workspaces; `jobManager.reconcileOnStartup()` marks
in-flight `heartbeat_runs` failed and creates recovery wakeups, containers are
re-verified, and queued wakeups re-dispatch within seconds. The restart aborts
in-flight agent runs (recovered automatically) and disconnects WebSocket clients
(they auto-reconnect). The instance is allowed to come back **locked** if no
`HEZO_MASTER_KEY` is set — the existing master-key gate shows and agents resume
once unlocked.

## Decisions

1. **Restart mechanism:** built-in supervisor process (above).
2. **Apply mode:** auto-download/stage in background; **apply + restart only on
   user click** ("Update & restart"). No surprise restarts. The click does not
   apply immediately — it opens a **confirmation dialog** that restates the
   consequences (shutdown + restart on the new version, in-flight runs aborted
   and auto-recovered) and **warns the operator they will need their 12-word
   master key to unlock Hezo again after the restart**. `POST /updates/apply`
   fires only on explicit confirm.
3. **Re-unlock:** restart even without an env key; show the unlock screen on the
   way back up. The instance only returns **locked** when no `HEZO_MASTER_KEY`
   is configured in the server env — if it is, boot auto-unlocks and no key
   entry is needed. Surface a boolean (e.g. `masterKeyInEnv` / `autoUnlock`)
   from `GET /updates/status` (or `/api/status`) so the confirmation copy is
   accurate, and **default to showing the master-key warning when the state is
   unknown**.

## What already exists (reuse, don't rebuild)

- `packages/server/src/routes/updates.ts` — `GET /updates/latest` already queries
  `hezo-ai/hezo` releases, caches 1h, returns `{current, latest, updateAvailable, url}`
  and exports `isNewer()`. Extend this module.
- `packages/server/src/version.ts` — `HEZO_VERSION` (injected via `--define` at
  compile time; `readDevVersion()` in dev).
- `scripts/build.ts` — `TARGETS` array defines asset names
  `hezo-{os}-{arch}[.exe]` + `SHA256SUMS`; reuse the exact mapping for download.
- `packages/server/src/services/job-manager.ts` — cron job registration pattern
  (`guarded()`); add the daily check job here.
- Worker shutdown logic already exists in `registerRuntime().shutdown()` in
  `index.ts` (jobManager.shutdown → ceoSessionManager.stop → egressProxy/sshAgent
  releaseAll → db.close) — promote it to a reusable graceful-shutdown function.
- Frontend: `useUpdateCheck()` (`packages/web/src/hooks/use-update-check.ts`),
  existing `UpdateBanner` (`packages/web/src/components/update-banner.tsx`, mounted
  in `__root.tsx`), `useStatus()` retry-polling, `useSocket().connected`,
  `useInvalidateOnReconnect`.

## Implementation

### Server

1. **`@hezo/shared`** (`packages/shared/src/types/common.ts`): add
   `UPDATE_RESTART_EXIT_CODE` (e.g. `75`) and an update-state enum
   (`idle | checking | downloading | staged | applying | error`). No raw strings.

2. **Supervisor** — new `packages/server/src/supervisor.ts`, branched from the
   entry. In `index.ts`, before the current server bootstrap: if not a subcommand
   (`hezo restore …` still bypasses) and `HEZO_WORKER` is unset and we're a
   **compiled binary**, run the supervisor: spawn `[process.execPath, ...args]` with
   `HEZO_WORKER=1`, inherit stdio, forward SIGTERM/SIGINT. On child exit ===
   `UPDATE_RESTART_EXIT_CODE` → call `applyStagedUpdate()` then respawn; any other
   code → exit with it. Guard so dev (`bun run dev`, non-compiled) never supervises.

3. **Updater service** — new `packages/server/src/services/updater.ts`:
   - `currentAssetName()` from `process.platform`/`process.arch` → `hezo-{os}-{arch}[.exe]`.
   - `downloadAndStage(version)`: download the release asset + `SHA256SUMS`, verify
     the sha256, write to `<dataDir>/.update/staged[.exe]`, strip macOS quarantine,
     record target version.
   - `applyStagedUpdate()` (called by supervisor): platform swap — atomic rename on
     Unix; rename-trick on Windows — then clear staging. Pure file logic, unit-testable.
   - Guard the whole feature behind "is compiled binary" + an opt-out
     `HEZO_DISABLE_AUTO_UPDATE`.

4. **Routes** (extend `updates.ts`, superuser-only): `GET /updates/status`
   (download/staged state + target version), `POST /updates/download` (kick a
   background stage via `trackBackground`), `POST /updates/apply` (graceful shutdown
   then `process.exit(UPDATE_RESTART_EXIT_CODE)`). Keep `GET /updates/latest`.

5. **Daily scheduled check** — register an `update-check` cron job in
   `job-manager.ts` (e.g. `0 0 4 * * *`, env-overridable `HEZO_UPDATE_CHECK_CRON`,
   following the existing override pattern). When an update is available and the
   feature is enabled, auto-download+stage so "Update & restart" is instant.

6. **Graceful shutdown** — extract the `registerRuntime().shutdown()` body into a
   reusable function and call it from the apply path (and wire SIGTERM/SIGINT to it
   so supervisor-forwarded signals shut the worker cleanly).

### Frontend (`packages/web`)

1. **Settings version footer** — add a footer to the settings sidebar nav in
   `packages/web/src/routes/settings/index.tsx` (currently no bottom element)
   showing `current` from `useUpdateCheck()`, linking to
   `https://github.com/hezo-ai/hezo/releases/tag/<current>`. Mobile-first.

2. **Global bottom banner** — reposition/extend `UpdateBanner` to a full-width
   **sticky bottom** bar shown on every page when `updateAvailable`. Replace the
   passive dismiss with an **"Update & restart"** action plus version + release
   link; keep per-version localStorage dismiss for "later". The action does
   **not** apply on click — it opens a confirmation `AlertDialog` (mobile-first)
   restating the consequences and **warning that the operator will need their
   12-word master key to unlock Hezo again after the restart** (soften the copy
   to "Hezo will restart and resume automatically" when `autoUnlock` is true).
   Only the dialog's primary confirm fires `POST /updates/apply`; "Cancel"
   dismisses with no effect.

3. **Restart overlay** — new full-screen component. On confirm:
   `POST /updates/apply`, then mount the overlay ("Updating to vX.Y.Z…"). The
   overlay copy reiterates the master-key unlock requirement so it stays visible
   while the instance is down. Poll `/api/status` (reuse `useStatus` retry
   semantics) / watch `useSocket().connected`; while unreachable show
   "restarting", and when status returns reload the app. `AppShell` already gates
   on `/api/status`, so a locked return naturally lands on the master-key screen.
   `useInvalidateOnReconnect` refreshes data.

### Docs & architecture

- `README.md` — add self-updating to the feature list / highlights: Hezo can
  check GitHub Releases, download the new binary, and update + restart in place
  from the web UI, so operators no longer have to swap the binary by hand. Link
  to the self-hosting "Updating" section.
- `docs/deployment/self-hosting.md` "Updating" — describe the in-app auto-update,
  supervisor, "Update & restart", the apply-time confirmation + master-key
  re-unlock warning, and the relock-on-restart caveat. Do **not** surface
  `HEZO_WORKER` (internal); document `HEZO_DISABLE_AUTO_UPDATE` /
  `HEZO_UPDATE_CHECK_CRON` in `docs/deployment/configuration`.
- Surface self-updating wherever the user-facing docs introduce features (e.g.
  the docs overview/landing page), not only the deployment reference — it is a
  user-visible capability, and the full `docs/` tree is bundled into the binary
  and injected into the CEO chat, so the CEO can answer "how do I update Hezo?".
- `.dev/architecture.md` — add a "Self-update & supervisor" section (process model,
  swap-per-platform, exit sentinel, state recovery).

## Critical files

- `packages/server/src/index.ts` (supervisor branch + reusable shutdown)
- `packages/server/src/supervisor.ts` *(new)*
- `packages/server/src/services/updater.ts` *(new)*
- `packages/server/src/routes/updates.ts` (status/download/apply)
- `packages/server/src/services/job-manager.ts` (daily check job)
- `packages/shared/src/types/common.ts` (exit code + state enum)
- `packages/web/src/routes/settings/index.tsx` (version footer)
- `packages/web/src/components/update-banner.tsx` (bottom banner + apply action)
- `packages/web/src/components/update-restart-overlay.tsx` *(new)*
- `docs/deployment/self-hosting.md`, `docs/deployment/configuration`, `.dev/architecture.md`

## Verification

- **Server unit/integration** (`packages/server/test/**`, `createTestContext`):
  asset-name mapping per platform; SHA256 verify (good + tampered); `applyStagedUpdate`
  swap on a temp dir (assert Unix atomic-rename and Windows rename-trick branches);
  `/updates/{status,download,apply}` authz (superuser-only) and that apply triggers
  shutdown + sentinel exit (mock exit); daily `update-check` job registered/guarded.
- **Web component** (`packages/web/test/**`, `renderApp`): settings footer renders
  version + correct release link; bottom banner appears when `updateAvailable` and
  hides otherwise; "Update & restart" opens the confirmation dialog showing the
  master-key warning and does **not** call `POST /updates/apply` on the initial
  click; the dialog's confirm calls `POST /updates/apply` and mounts the overlay
  (and "Cancel" does not); overlay polls and resumes when `/api/status` recovers.
- **Manual cross-platform** (can't be automated): build two versions, run the
  supervisor, trigger "Update & restart", confirm the worker relaunches on the new
  version and reconciliation resumes agents — on Linux, macOS (incl. quarantine
  strip), and Windows (rename-trick).
- `bun run test`, `bun run typecheck`, `bun run check` green.

## Risks / notes

- **Supervisor stays on old code** until a full restart (worker is fresh) — accepted.
- **Dev mode**: feature is hard-disabled for non-compiled runs.
- Restart aborts in-flight runs (auto-recovered) and disconnects sockets
  (auto-reconnect) — surfaced in the overlay copy.

The swap design follows established updater patterns and is sound in principle,
but the per-platform behaviour below is **not guaranteed** and is why the
cross-platform validation above is manual and unautomatable. Treat these as open
items to resolve during implementation, not settled facts:

- **Cross-filesystem staging (`EXDEV`).** `rename(2)` is atomic only on the same
  filesystem. Staging lives in `<dataDir>/.update/` but the swap renames over
  `process.execPath`; if those are different mounts the rename fails with
  `EXDEV`. The swap must first **copy** the staged file to a temp path *adjacent
  to the binary*, then rename.
- **Write permission on the install dir (`EACCES`).** A common layout is systemd
  running as an unprivileged user with the binary in a root-owned dir
  (`/usr/local/bin`, `/opt`); the process then cannot rename over its own binary.
  Needs a documented failure mode / preflight check rather than a mid-apply crash.
- **Failed-swap rollback is unspecified.** Unix atomic rename is all-or-nothing,
  but the **Windows swap is multi-step and non-atomic** (rename old → write new);
  a crash in between leaves `hezo.exe` missing or partial. The supervisor needs an
  explicit verify + rollback path before relaunching the worker.
- **Windows signal semantics.** "Forward SIGTERM/SIGINT to the child" is a Unix
  model. Windows has no real `SIGTERM` (signals are emulated; console-control
  events behave differently), so graceful-shutdown-via-forwarded-signal differs
  there and needs its own handling.
- **macOS arm64 codesigning.** Stripping `com.apple.quarantine` only clears the
  Gatekeeper *prompt*. Apple Silicon **requires** a valid (≥ ad-hoc) signature to
  execute — an invalid one is `SIGKILL`ed, not prompted. This can be a hard
  blocker on arm64, not just a notarization follow-up.
- **Windows SmartScreen / Defender (and AV generally).** A freshly downloaded,
  unsigned or replaced `.exe` may be quarantined or locked by real-time AV,
  blocking the relaunch — the same risk class as macOS Gatekeeper.
- **Bun runtime divergence.** The supervisor leans entirely on runtime primitives
  (`Bun.spawn`/`child_process` `stdio:'inherit'`, signal forwarding, exit-code
  propagation, compiled-binary `process.execPath`/argv reconstruction). This repo
  maintains a dedicated Bun-native test tier precisely because Bun's `node:`
  behaviour diverges from Node and vitest (Node) gives false confidence here. The
  supervisor needs Bun-native tests (`packages/server/test/bun/**`) per platform;
  even those cannot exercise the Windows/macOS swap under Linux CI.
- **Deployment model.** In-place self-update assumes a **bare-binary** install. If
  Hezo itself runs inside a container, the swap is the wrong model (the change is
  lost on container recreate — the image should be updated instead). The feature
  should detect or document that it does not apply in that case.
