/**
 * POSIX signal numbers a container process can plausibly die on.
 *
 * Name-keyed so an unnamed number renders as itself rather than being guessed
 * at, and a table rather than a switch so a new entry is one row.
 */
const SIGNAL_NAMES: Record<number, string> = {
	1: 'SIGHUP',
	2: 'SIGINT',
	3: 'SIGQUIT',
	4: 'SIGILL',
	6: 'SIGABRT',
	8: 'SIGFPE',
	9: 'SIGKILL',
	11: 'SIGSEGV',
	13: 'SIGPIPE',
	14: 'SIGALRM',
	15: 'SIGTERM',
	24: 'SIGXCPU',
	25: 'SIGXFSZ',
	31: 'SIGSYS',
};

/** Highest signal number the `128 + N` convention can encode. */
const MAX_SIGNAL = 64;

/**
 * The signal behind a shell's `128 + N` exit convention, or null for an
 * ordinary exit code.
 *
 * 128 itself is excluded: it is not a signal, and a program is free to exit
 * with it.
 */
export function signalFromExitCode(
	exitCode: number | null | undefined,
): { number: number; name: string } | null {
	if (typeof exitCode !== 'number' || !Number.isInteger(exitCode)) return null;
	const signal = exitCode - 128;
	if (signal < 1 || signal > MAX_SIGNAL) return null;
	return { number: signal, name: SIGNAL_NAMES[signal] ?? `signal ${signal}` };
}

/**
 * The run-row sentence for a process a signal destroyed, or null when the exit
 * code is an ordinary one.
 *
 * A SIGKILL nobody asked for is the kernel out-of-memory killer in all but the
 * rarest case, so the memory cap the container was provisioned with is named
 * alongside it: without the figure the reader still has to go looking for the
 * one setting that would have prevented it. Hedged rather than asserted,
 * because a program may exit 137 of its own accord.
 */
export function describeSignalExit(
	exitCode: number | null | undefined,
	opts: { memoryLimitGib: number },
): string | null {
	const signal = signalFromExitCode(exitCode);
	if (!signal) return null;
	if (signal.number === 9) {
		return (
			`run was killed by SIGKILL (exit ${exitCode}) - almost always the kernel out-of-memory ` +
			`killer, and this container is capped at ${opts.memoryLimitGib} GiB of RAM. Raise the cap ` +
			`on the project's Containers page, or make the run use less memory.`
		);
	}
	return (
		`run was killed by ${signal.name} (exit ${exitCode}) - the agent process was terminated by ` +
		'a signal, so it never reported a result.'
	);
}
