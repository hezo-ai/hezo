import type { ContainerProcessInfo } from './docker';

/**
 * Pure decision logic for the boot-time dangling-process sweep.
 *
 * Docker can't kill an exec'd process, so a server restart/crash strands every
 * in-flight exec's process tree inside the (deliberately warm-surviving)
 * project containers. At startup `JobManager.sweepDanglingContainerProcesses`
 * scans each running container (`ContainerEngine.listHezoProcesses`) and applies
 * the policy here: kill everything a previous server lifetime left behind
 * EXCEPT background processes belonging to runs that completed successfully —
 * an agent may intentionally leave e.g. a dev server running on the project's
 * dev port, and those survive a Hezo restart.
 */

/**
 * Processes younger than this are never swept. Routes and provisioning are
 * live while startup reconciliation runs, so a git/provision exec started
 * seconds after boot carries a scope id the DB doesn't know — the age guard is
 * what keeps the sweep from killing it mid-flight. Anything older than this at
 * boot necessarily predates the current server lifetime.
 */
export const SWEEP_MIN_AGE_SECS = 120;

/**
 * SSH-bridge infrastructure processes: the run wrapper, the per-connection
 * bridge helper, and any socat serving a `/run/hezo/` socket. These only ever
 * exist while an exec is in flight, so at boot (age guard passed) they are
 * always stale — killed regardless of marker or run status.
 */
const BRIDGE_CMD_RE = /hezo-run-with-bridge|hezo-ssh-bridge|socat .*\/run\/hezo\//;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * The scanned run ids that could be `heartbeat_runs` rows — UUID-format only,
 * so the caller can pass them straight into an `= ANY($1::uuid[])` lookup.
 * Non-UUID scope ids (`provision-*`, `gitop-*`, `mcp-install-*`) are never DB
 * rows and need no lookup.
 */
export function collectCandidateRunIds(procs: ContainerProcessInfo[]): string[] {
	const ids = new Set<string>();
	for (const proc of procs) {
		if (proc.runId !== null && UUID_RE.test(proc.runId)) ids.add(proc.runId);
	}
	return [...ids];
}

/**
 * Decide which scanned pids the boot sweep kills. Per process, in order:
 * PID 1 (the container's own init/sleep) and anything younger than
 * {@link SWEEP_MIN_AGE_SECS} are spared; bridge infrastructure dies
 * unconditionally; a marker-carrying process dies unless its run id is a
 * *succeeded* `heartbeat_runs` row (failed/cancelled runs, chat session ids,
 * and provision/gitop/mcp-install tags all fail that lookup); a marker-less
 * process dies only when it is bridge-socket-scoped (`hasHezoSock` — legacy
 * git/ssh trees from versions predating the marker). Everything else —
 * succeeded runs' intentional background processes, unrelated processes — is
 * preserved.
 */
export function decideSweepKills(
	procs: ContainerProcessInfo[],
	succeededRunIds: ReadonlySet<string>,
): number[] {
	const kills: number[] = [];
	for (const proc of procs) {
		if (proc.pid === 1) continue;
		if (proc.ageSecs < SWEEP_MIN_AGE_SECS) continue;
		if (BRIDGE_CMD_RE.test(proc.cmdline)) {
			kills.push(proc.pid);
			continue;
		}
		if (proc.runId !== null) {
			if (!succeededRunIds.has(proc.runId)) kills.push(proc.pid);
			continue;
		}
		if (proc.hasHezoSock) kills.push(proc.pid);
	}
	return kills;
}
