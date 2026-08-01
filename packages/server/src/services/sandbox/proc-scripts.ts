import type { ProcessEnvMarker } from './types';

/**
 * The `/proc` shell scripts Hezo runs inside a container to find and kill its own
 * processes.
 *
 * These are plain POSIX shell over `/proc` - nothing in them is Docker-specific,
 * only the transport that carries them is. Extracted here so every engine runs
 * the *same* script rather than each reimplementing the scan, because the two
 * things they encode are subtle and easy to get wrong independently: how a pid's
 * marker is recovered from a NUL-separated `environ`, and how process age is
 * derived from `/proc/uptime` minus the `stat` starttime field.
 */

/**
 * Every env-marker value interpolated into a script must match this - UUIDs and
 * `<kind>-<hex>` scope ids do; anything shell-active (quotes, spaces, `$`,
 * backticks) is rejected before it reaches the shell.
 */
export const ENV_MARKER_VALUE_RE = /^[0-9a-zA-Z_-]{1,64}$/;

/**
 * SIGKILL every process whose environment carries `name=value`.
 *
 * `/proc/<pid>/environ` is NUL-separated; `basename $(dirname …)` recovers the
 * pid without relying on `${…}` shell parameter expansion (a JS-template
 * look-alike). `|| true` keeps a since-exited pid from failing the loop.
 *
 * Throws on a value that would need shell escaping - the character-class check is
 * what makes the unquoted interpolation below safe.
 */
export function buildKillByEnvMarkerScript(name: ProcessEnvMarker, value: string): string {
	if (!ENV_MARKER_VALUE_RE.test(value)) {
		throw new Error(`unsafe env marker value: ${JSON.stringify(value)}`);
	}
	const marker = `${name}=${value}`;
	return (
		'for e in /proc/[0-9]*/environ; do ' +
		`grep -qFz "${marker}" "$e" 2>/dev/null || continue; ` +
		'kill -9 "$(basename "$(dirname "$e")")" 2>/dev/null || true; ' +
		'done'
	);
}

/**
 * Emit one tab-separated row per Hezo-owned process: pid, run id, whether it
 * carries a `/run/hezo/` ssh socket, age in seconds, and cmdline.
 *
 * Age derives from `/proc/uptime` minus stat field 22 (starttime, in clock
 * ticks). The stat line's second field (comm) may contain spaces or parentheses,
 * so everything up to the *last* `) ` is stripped first - after that, starttime
 * is field 20 of the remainder. Only matching pids are emitted, so output stays
 * tiny even under a high process count.
 */
export function buildListHezoProcessesScript(): string {
	return (
		'up=$(cut -d. -f1 /proc/uptime); hz=$(getconf CLK_TCK 2>/dev/null || echo 100); ' +
		'for d in /proc/[0-9]*; do ' +
		'pid=${d#/proc/}; ' +
		'rid=$(tr "\\0" "\\n" < "$d/environ" 2>/dev/null | sed -n "s/^HEZO_HEARTBEAT_RUN_ID=//p" | head -n1); ' +
		'sock=0; grep -qz "SSH_AUTH_SOCK=/run/hezo/" "$d/environ" 2>/dev/null && sock=1; ' +
		'cmd=$(tr "\\0" " " < "$d/cmdline" 2>/dev/null); ' +
		'st=$(sed "s/^.*) //" "$d/stat" 2>/dev/null | cut -d" " -f20); ' +
		'age=$(( up - ${st:-0} / hz )); ' +
		'case "$cmd" in *hezo-run-with-bridge*|*hezo-ssh-bridge*|*/run/hezo/*) hit=1;; *) hit=0;; esac; ' +
		'if [ -n "$rid" ] || [ "$sock" = 1 ] || [ "$hit" = 1 ]; then ' +
		'printf "%s\\t%s\\t%s\\t%s\\t%s\\n" "$pid" "$rid" "$sock" "$age" "$cmd"; ' +
		'fi; ' +
		'done'
	);
}

/**
 * Bytes used on the filesystem holding a container's workspace, **or nothing at
 * all when that filesystem is not the container's own**.
 *
 * `df` rather than `du`: the question is how close the container is to filling
 * up, and `df` answers it from the superblock in constant time, where `du` walks
 * every `node_modules` in every worktree - the exact trees that make the number
 * interesting in the first place. It is measured once per run, so a walk would be
 * a per-run cost proportional to how much the container has accumulated.
 *
 * The device check in front of it is what makes the number mean what the pool
 * thinks it means. The pool recycles a container that is near its disk ceiling,
 * on the reasoning that a replacement starts empty - which only holds while the
 * storage belongs to the container. On a local Docker daemon `/workspace` is a
 * bind mount of the host data dir, so `df` there reports the **host partition**:
 * essentially always past a 2 GiB ceiling, and replacing the container frees
 * none of it. Every member of every project read as out of disk, so affinity
 * never fired, suspended members were never resumable, and each run provisioned
 * a fresh container.
 *
 * Comparing the path's device against `/` distinguishes the two cases exactly,
 * and it is the measurement's own property rather than a per-backend rule - which
 * is why it lives in the shared script instead of one engine. Measured: on
 * Daytona `/workspace` and `/` are the same overlay device, so a sandbox reports
 * its real usage; a bind-mounted path is a different device and reports nothing.
 * No output parses to null, and null already means "could not measure" to every
 * caller - which is not zero, and deliberately leaves the last figure alone.
 */
export function buildDiskUsageScript(path: string): string {
	if (!/^\/[A-Za-z0-9._/-]*$/.test(path)) {
		throw new Error(`unsafe path: ${JSON.stringify(path)}`);
	}
	return (
		`[ "$(stat -c %d / 2>/dev/null)" = "$(stat -c %d ${path} 2>/dev/null)" ] || exit 0; ` +
		`df -Pk ${path} 2>/dev/null | awk 'NR==2 {print $3}'`
	);
}

/** SIGKILL an explicit pid list. Validates every pid so nothing unexpected reaches the shell. */
export function buildKillPidsScript(pids: number[]): string {
	for (const pid of pids) {
		if (!Number.isInteger(pid) || pid <= 1) {
			throw new Error(`unsafe pid: ${JSON.stringify(pid)}`);
		}
	}
	return `kill -9 ${pids.join(' ')} 2>/dev/null || true`;
}

/**
 * Report whether every one of `ports` is being listened on, on loopback.
 *
 * Reads `/proc/net/tcp` rather than shelling out to `ss` or `netstat`: the
 * pseudo-file is always there, while the tools are packages a custom
 * `docker_base_image` need not carry, and a missing tool would read as "not
 * listening" forever.
 *
 * The file's `local_address` column is `<addr>:<port>` in **hex**, address
 * little-endian - so 127.0.0.1 is `0100007F` - and the state column is `0A` for
 * LISTEN. Matching on the port alone would accept a listener on any interface,
 * which is not what the tunnel promises the container.
 *
 * Prints `ready` when all of them are up and nothing otherwise, so the caller
 * tests one exact string rather than parsing.
 */
export function buildPortsListeningScript(ports: readonly number[]): string {
	if (ports.length === 0) return 'echo ready';
	for (const port of ports) {
		if (!Number.isInteger(port) || port <= 0 || port > 65535) {
			throw new Error(`invalid port: ${String(port)}`);
		}
	}
	// `0100007F` is 127.0.0.1 in the file's byte order; `0A` is TCP_LISTEN.
	const tests = ports
		.map((port) => {
			const hex = port.toString(16).toUpperCase().padStart(4, '0');
			return `grep -qi " 0100007F:${hex} .* 0A " /proc/net/tcp`;
		})
		.join(' && ');
	return `${tests} && echo ready`;
}
