import type { ContainerMemoryStats, ContainerProcessInfo, ProcessEnvMarker } from './types';

/**
 * The in-container shell scripts Hezo runs to find and kill its own processes and
 * to measure what a container is consuming, **and the parsers for what they
 * print**.
 *
 * These are plain POSIX shell over `/proc` and `/sys` - nothing in them is
 * specific to any backend, only the transport that carries them is. Every engine
 * runs the *same* script and reads it with the *same* parser rather than each
 * reimplementing either, because the things they encode are subtle and easy to
 * get wrong independently: how a pid's marker is recovered from a NUL-separated
 * `environ`, how process age is derived from `/proc/uptime` minus the `stat`
 * starttime field, and which reading of a cgroup is the container's own.
 *
 * **Script and parser stay together, and neither lives in an adapter.** A new
 * backend implements its `ContainerEngine` measurement methods by running these
 * strings over whatever exec transport it has and handing the output back here -
 * it never writes a second copy, and it never reaches into another adapter's
 * module to borrow one. That is what keeps two backends answering
 * `enforceContainerMemoryLimit` and the pool's disk rung with the same quantity
 * rather than two plausible ones. A backend whose control plane offers something
 * genuinely cheaper may prefer it (local Docker reads memory from the daemon's
 * own stats endpoint), but it must compute the same figure.
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

/**
 * Digits at which a cgroup memory limit is the kernel's "no limit" sentinel
 * rather than a real allocation. cgroup v1 spells unlimited as a number near
 * 2^63; nothing an operator can configure comes within three orders of magnitude
 * of it, and counting digits avoids asking a shell to compare 64-bit integers.
 */
const UNLIMITED_MEMORY_DIGITS = 19;

/**
 * A container's own memory charge and its reclaimable page cache, **or nothing
 * at all when the reading would not be the container's own**.
 *
 * Read from the cgroup files the kernel exposes inside the container, which is
 * the same accounting a local Docker daemon reports through its stats endpoint -
 * so both backends answer `enforceContainerMemoryLimit` with the same quantity
 * rather than two plausible ones. v2 first, v1 as the fallback; a runtime
 * offering neither says nothing.
 *
 * The limit check in front of it is what makes the number mean what the caller
 * thinks it means, and is the direct analogue of the device check in
 * {@link buildDiskUsageScript}. A container in its own cgroup namespace reads its
 * own charge at the cgroup root; one without a namespace reads the **host's**,
 * which would be the machine's memory use attributed to a single container and
 * would stop it on the first poll. An unlimited limit is exactly the case where
 * that has happened, since every Hezo container is created with one - so it is
 * the measurement's own property, which is why the guard lives in the shared
 * script rather than in one engine.
 *
 * Two whitespace-separated integers on success: total charge, then the inactive
 * file pages to discount from it. No output parses to null, which already means
 * "could not measure" to every caller - not zero, and it leaves the last reading
 * alone.
 */
export function buildMemoryUsageScript(): string {
	const v2 = '/sys/fs/cgroup';
	const v1 = '/sys/fs/cgroup/memory';
	return (
		`if [ -r ${v2}/memory.current ]; then ` +
		`lim=$(cat ${v2}/memory.max 2>/dev/null); ` +
		`cur=$(cat ${v2}/memory.current 2>/dev/null); ` +
		`ina=$(awk '$1=="inactive_file"{print $2; exit}' ${v2}/memory.stat 2>/dev/null); ` +
		`elif [ -r ${v1}/memory.usage_in_bytes ]; then ` +
		`lim=$(cat ${v1}/memory.limit_in_bytes 2>/dev/null); ` +
		`cur=$(cat ${v1}/memory.usage_in_bytes 2>/dev/null); ` +
		`ina=$(awk '$1=="total_inactive_file"{print $2; exit}' ${v1}/memory.stat 2>/dev/null); ` +
		'else exit 0; fi; ' +
		// Non-numeric covers v2's literal `max`; the digit count covers v1's
		// near-2^63 sentinel. Either means this is not a limited cgroup.
		'case "$lim" in "" | *[!0-9]*) exit 0;; esac; ' +
		`[ ${'${#lim}'} -lt ${UNLIMITED_MEMORY_DIGITS} ] || exit 0; ` +
		'case "$cur" in "" | *[!0-9]*) exit 0;; esac; ' +
		'printf "%s %s\\n" "$cur" "${ina:-0}"'
	);
}

/**
 * The in-container tunnel client, as `/proc/<pid>/cmdline` sees it.
 *
 * The client's shebang is `#!/usr/bin/env node`, so by the time it is running
 * the kernel has replaced `env` and argv reads `node /usr/local/bin/hezo-tunnel
 * <config>`. Matching **argv[1]** rather than scanning the whole cmdline is what
 * makes this safe to run from a shell whose own `-c` argument contains this very
 * string: the sweeping shell's argv[1] is `-c`, so it can never match itself. A
 * whole-cmdline grep here would SIGKILL the sweep mid-sweep.
 */
const TUNNEL_CLIENT_ARGV1 = 'hezo-tunnel';

/**
 * SIGKILL every tunnel client running in this container.
 *
 * Only ever correct when the caller owns **no** live tunnel into the container -
 * at startup reconcile, before this process has opened any - because a container
 * legitimately carries several at once (a run, a chat turn, a provisioning git
 * op), and they are indistinguishable from a stale one from inside.
 *
 * The stale ones exist because a Daytona PTY does not kill what runs on it when
 * its socket closes; only deleting the session does, and that delete runs on the
 * host's close path. A server killed mid-flight (any `ctrl-c` on a dev loop)
 * therefore abandons a client that goes on holding this container's three
 * loopback ports, and every later tunnel into that container dies on
 * `EADDRINUSE` having lost MCP, egress and ssh for the whole run.
 */
export function buildKillTunnelClientsScript(): string {
	return (
		'for d in /proc/[0-9]*; do ' +
		'pid=${d#/proc/}; ' +
		'[ "$pid" = "$$" ] && continue; ' +
		'a=$(tr "\\0" "\\n" < "$d/cmdline" 2>/dev/null | sed -n 2p); ' +
		`case "$a" in */${TUNNEL_CLIENT_ARGV1}|${TUNNEL_CLIENT_ARGV1}) ` +
		'kill -9 "$pid" 2>/dev/null || true;; esac; ' +
		'done'
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

/**
 * Report whether **any** of `ports` is already being listened on, on loopback.
 *
 * The inverse question to {@link buildPortsListeningScript}, and deliberately a
 * separate script rather than a negation of it: that one asks "are all three up
 * yet" (readiness), this one asks "is this triple already taken" (allocation).
 * Same `/proc/net/tcp` reasoning - the pseudo-file is always there, while `ss`
 * and `netstat` are packages a custom `docker_base_image` need not carry, and a
 * missing tool reading as "free" would hand out a port that is not.
 *
 * Prints `busy` when at least one is taken and nothing otherwise, so the caller
 * tests one exact string. Silence means free, which is the safe default here
 * only because the allocator still holds its own in-process reservation on top.
 */
export function buildAnyPortListeningScript(ports: readonly number[]): string {
	if (ports.length === 0) return '';
	for (const port of ports) {
		if (!Number.isInteger(port) || port <= 0 || port > 65535) {
			throw new Error(`invalid port: ${String(port)}`);
		}
	}
	const tests = ports
		.map((port) => {
			const hex = port.toString(16).toUpperCase().padStart(4, '0');
			return `grep -qi " 0100007F:${hex} .* 0A " /proc/net/tcp`;
		})
		.join(' || ');
	return `{ ${tests} ; } && echo busy`;
}

/**
 * Turn `buildDiskUsageScript`'s used column into bytes. Null for anything that is
 * not a plain number - a container without `df`, or one whose exec produced
 * nothing, has not reported "empty", it has failed to report.
 */
export function parseDfKilobytes(stdout: string): number | null {
	const kb = Number.parseInt(stdout.trim(), 10);
	return Number.isFinite(kb) && kb >= 0 ? kb * 1024 : null;
}

/**
 * Turn `buildMemoryUsageScript`'s two numbers into the stats shape.
 *
 * Working set is the total charge less the reclaimable file pages, which is the
 * same arithmetic the local Docker engine applies to the daemon's own figures -
 * they must be the same quantity, because one threshold is compared against
 * every backend's answer. A missing or unreadable second number discounts
 * nothing rather than failing the reading: over-reporting the working set is the
 * safe direction for a threshold that stops a container.
 *
 * Null for output that is not a usage figure at all - the script says nothing
 * when it cannot measure, and that is not zero.
 */
export function parseCgroupMemory(stdout: string): ContainerMemoryStats | null {
	const [usageField, inactiveField] = stdout.trim().split(/\s+/);
	const usage = Number.parseInt(usageField ?? '', 10);
	if (!Number.isFinite(usage) || usage < 0) return null;
	const inactive = Number.parseInt(inactiveField ?? '', 10);
	const discount = Number.isFinite(inactive) && inactive > 0 ? inactive : 0;
	return { usedBytes: Math.max(0, usage - discount), rawUsageBytes: usage };
}

/**
 * Parse the tab-separated `buildListHezoProcessesScript` scan output. The cmdline
 * is the trailing field and may itself contain tabs, so only the first four tabs
 * split; malformed lines (a pid that exited mid-scan can emit partial output)
 * are dropped.
 */
export function parseHezoProcessList(stdout: string): ContainerProcessInfo[] {
	const procs: ContainerProcessInfo[] = [];
	for (const line of stdout.split('\n')) {
		if (line.length === 0) continue;
		const parts = line.split('\t');
		if (parts.length < 5) continue;
		const [pidRaw, runIdRaw, sockRaw, ageRaw] = parts;
		const cmdline = parts.slice(4).join('\t');
		const pid = Number.parseInt(pidRaw, 10);
		const ageSecs = Number.parseInt(ageRaw, 10);
		if (!Number.isInteger(pid) || pid <= 0 || !Number.isInteger(ageSecs)) continue;
		procs.push({
			pid,
			runId: runIdRaw.length > 0 ? runIdRaw : null,
			hasHezoSock: sockRaw === '1',
			ageSecs: Math.max(0, ageSecs),
			cmdline,
		});
	}
	return procs;
}

/** Single-quote for `sh -c`, closing and reopening around any embedded quote. */
export function shellQuote(arg: string): string {
	return `'${arg.replaceAll("'", `'\\''`)}'`;
}

/**
 * Terminal columns the login PTY is opened at.
 *
 * A vendor CLI wraps its sign-in URL to the terminal width, and a wrapped URL
 * arrives interleaved with the spinner frames redrawn around it - Claude Code's
 * visible URL text comes back in four overlapping fragments at 80 columns. Wide
 * enough that nothing these CLIs print wraps at all, which is what lets the
 * parsers below read a line rather than reassemble one.
 */
const LOGIN_PTY_COLUMNS = 1000;

/** Per-flow file names under a login flow's own directory. */
export const LOGIN_STDIN_FIFO = 'in';
export const LOGIN_LOG_FILE = 'out';
export const LOGIN_EXIT_FILE = 'exit';

/**
 * Run a vendor CLI's own login command, with a PTY Hezo allocates itself.
 *
 * **The PTY is ours, never the transport's.** Two of the three CLIs are
 * full-screen TUIs that print nothing at all and hang forever on a pipe
 * (`claude setup-token` emits zero bytes and never exits without one), so a PTY
 * is required either way - and the two backends disagree about whether their
 * exec channel has one. Docker's is a raw pipe; Daytona's is a PTY that
 * redirects stderr to a file drained only when the channel closes, which would
 * deadlock a flow whose challenge went to stderr. Allocating it here makes the
 * flow behave identically on both, using only the exec triad and
 * {@link SandboxFiles} - the two seams that are the same on every backend by
 * rule.
 *
 * Streams are merged and teed to {@link LOGIN_LOG_FILE}, which the host polls
 * rather than streams, for the same reason: a file read is identical on both
 * backends where a byte channel is not.
 *
 * Stdin is a FIFO held open by a `sleep` for the flow's lifetime. Without a
 * writer the CLI reads EOF the instant it opens the pipe and abandons its
 * prompt; with one, {@link buildSubscriptionLoginCodeScript} can deliver the
 * operator's code minutes later.
 */
export function buildSubscriptionLoginScript(opts: {
	dir: string;
	argv: readonly string[];
	env?: Readonly<Record<string, string>>;
	holdSecs: number;
}): string {
	const { dir, argv, env = {}, holdSecs } = opts;
	if (!/^\/[A-Za-z0-9._/-]*$/.test(dir)) throw new Error(`unsafe dir: ${JSON.stringify(dir)}`);
	if (argv.length === 0) throw new Error('login argv is empty');
	if (!Number.isInteger(holdSecs) || holdSecs <= 0) throw new Error(`bad holdSecs: ${holdSecs}`);

	const d = shellQuote(dir);
	// `script` needs the command as one string; each argv element is quoted
	// individually so nothing in it can reach the outer shell.
	const inner = argv.map(shellQuote).join(' ');
	const envPrefix = Object.entries(env)
		.map(([k, v]) => {
			if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) throw new Error(`unsafe env name: ${k}`);
			return `${k}=${shellQuote(v)}`;
		})
		.join(' ');

	// Absolute paths throughout, and never a `cd`: `&` binds looser than `&&`, so
	// a `cd` at the head of the chain backgrounds with the first subshell and the
	// second one launches in whatever directory the exec happened to start in -
	// where it reads a FIFO and writes a log that are not this flow's.
	const fifo = shellQuote(`${dir}/${LOGIN_STDIN_FIFO}`);
	const log = shellQuote(`${dir}/${LOGIN_LOG_FILE}`);
	const exit = shellQuote(`${dir}/${LOGIN_EXIT_FILE}`);

	return (
		`mkdir -p ${d} && rm -f ${fifo} ${log} ${exit} && ` +
		`mkfifo -m 600 ${fifo} && : > ${log} && ` +
		// Braces keep the `&&` chain in front of the whole launch rather than only
		// the first background job.
		'{ ' +
		// Holds the write end open so the CLI never sees EOF while it waits.
		//
		// Both background subshells detach their own stdio (`>/dev/null 2>&1`)
		// **as well as** redirecting the commands inside them. Without the outer
		// redirect they inherit the launching exec's stdout and stderr, and an
		// exec does not complete while a child still holds its pipes open - so
		// the call that starts the flow never returns and the flow never begins.
		// The inner redirections still win for the commands they name.
		`( sleep ${holdSecs} > ${fifo} ) >/dev/null 2>&1 & ` +
		`( COLUMNS=${LOGIN_PTY_COLUMNS} ${envPrefix} ` +
		`script -qec ${shellQuote(inner)} /dev/null ` +
		`< ${fifo} > ${log} 2>&1; ` +
		// Written last and read as the flow's "process is gone" signal.
		`echo $? > ${exit} ) >/dev/null 2>&1 & ` +
		'echo started; }'
	);
}

/**
 * Deliver the operator's pasted code to a waiting login process.
 *
 * **Terminated with CR, never LF.** A vendor CLI's paste prompt is a full-screen
 * TUI reading a raw-mode terminal, where no line discipline translates one into
 * the other and only `\r` is the return key - an LF is delivered as an ordinary
 * character, so the code lands in the prompt's buffer and simply sits there
 * unsubmitted until the flow times out. Measured against claude-code 2.1.250:
 * the pasted text appears masked in the prompt and nothing else happens, where
 * a CR runs the token exchange. A CLI reading lines canonically instead is
 * unaffected, since `ICRNL` turns the CR back into its newline.
 */
export function buildSubscriptionLoginCodeScript(dir: string, code: string): string {
	if (!/^\/[A-Za-z0-9._/-]*$/.test(dir)) throw new Error(`unsafe dir: ${JSON.stringify(dir)}`);
	return `printf '%s\\r' ${shellQuote(code)} > ${shellQuote(`${dir}/${LOGIN_STDIN_FIFO}`)}`;
}

/**
 * Terminal control bytes, as **regex source** rather than literals.
 *
 * Written escaped and fed to `new RegExp` so the source file carries no literal
 * control character - which a linter rightly refuses, and which is invisible in
 * a diff. The regex engine resolves them identically.
 */
const ESC = '\\x1b';
const BEL = '\\x07';
/** OSC string terminator: either `ESC \` or a bare BEL. */
const ST = `${ESC}\\\\|${BEL}`;

/**
 * OSC 8 hyperlink targets, in the order they appear.
 *
 * The sequence is `ESC ] 8 ; <params> ; <uri> ST`, where ST is either `ESC \` or
 * BEL. Read in preference to the visible link text because a TUI redraw
 * rewrites that text and leaves the escape intact - Claude Code's authorize URL
 * survives here whole while its on-screen copy comes back in fragments.
 */
export function parseOsc8Links(raw: string): string[] {
	const links: string[] = [];
	for (const m of raw.matchAll(new RegExp(`${ESC}]8;[^;]*;([^${ESC}${BEL}]*)(?:${ST})`, 'g'))) {
		const uri = m[1];
		if (uri.length > 0) links.push(uri);
	}
	return links;
}

/**
 * Drop the escape sequences a PTY interleaves with a CLI's own output.
 *
 * Covers CSI (colour, cursor moves, erases), OSC (window title, and the
 * hyperlinks {@link parseOsc8Links} reads first), and the bare two-byte escapes
 * a full-screen redraw emits. Carriage returns become newlines so a redrawn line
 * is its own line to a line-oriented matcher rather than joining the one before.
 */
export function stripTerminalNoise(raw: string): string {
	return raw
		.replace(new RegExp(`${ESC}][^${ESC}${BEL}]*(?:${ST})`, 'g'), '')
		.replace(new RegExp(`${ESC}\\[[0-9;?]*[ -/]*[@-~]`, 'g'), '')
		.replace(new RegExp(`${ESC}[()][A-Za-z0-9]`, 'g'), '')
		.replace(new RegExp(`${ESC}[=><]`, 'g'), '')
		.replace(/\r/g, '\n');
}
