/**
 * Rendering a `ContainerEngine` exec into the single command string Daytona's
 * toolbox accepts.
 *
 * Everything here is pure and Daytona-specific by design: the differences it
 * papers over (no argv, no per-exec user, no stream separation) are properties
 * of that provider's API, so they are absorbed inside this adapter rather than
 * leaking into the engine seam. Keeping it separate from `engine.ts` is what
 * makes the three translations below testable without a live API.
 */

/**
 * Quote one argument for POSIX `sh`.
 *
 * Single quotes are the only form that suppresses every expansion, so the sole
 * case to handle is an embedded single quote: close, emit an escaped one,
 * reopen. Everything Hezo execs - argv from callers, `/proc` scan scripts,
 * agent command lines - goes through this, so nothing reaches the shell that
 * could be re-parsed as syntax.
 */
export function shellQuote(arg: string): string {
	return `'${arg.replaceAll("'", `'\\''`)}'`;
}

export interface DaytonaExecRender {
	/** Argv, as `ContainerEngine.execCreate` receives it. */
	cmd: string[];
	/** `KEY=value` entries. */
	env?: string[];
	/**
	 * The OS user Docker would have used. Daytona execs as **root** by default
	 * (our image sets no `USER`), so this renders as *deprivileging* - the
	 * inverse of the Docker path, where elevation is what has to be requested.
	 * Undefined or `root` therefore means "run as-is".
	 */
	user?: string;
	/**
	 * Absolute in-container path stderr is redirected to.
	 *
	 * Daytona merges stdout and stderr into one stream with no way to tell them
	 * apart - measured, not assumed: its `ExecuteResponse` carries `stdout` and
	 * `stderr` fields but both are always null, and `result` and the follow
	 * stream are both the interleaved combination. The split is load-bearing
	 * upstream (the agent stream-json parser routes on it, and a git exec parses
	 * stdout for shas while git writes progress to stderr), so it is recovered
	 * by sending stderr to a file and draining it separately.
	 */
	stderrPath: string;
}

/**
 * Wrap a shell script as the command string Daytona runs.
 *
 * Daytona hands `command` to a shell, so a bare script would work - but naming
 * `sh` pins *which* shell. Everything Hezo sends is POSIX sh (the shared
 * `/proc` scan scripts especially), and a provider-side default that changed to
 * something else would break them silently rather than loudly.
 */
export function asShellCommand(script: string): string {
	return `sh -c ${shellQuote(script)}`;
}

/**
 * Render an exec as a POSIX shell script.
 *
 * The order of the three wrappers matters. `runuser` is outermost so the target
 * user is adopted before anything else runs; `env` sits inside it so the
 * variables survive the environment reset `runuser` performs; and the stderr
 * redirect wraps the whole group so it captures the wrappers' own diagnostics
 * too (a failed `runuser` writes there, and losing that message would turn a
 * permissions problem into a silent empty failure).
 */
export function renderDaytonaExecScript(spec: DaytonaExecRender): string {
	const parts: string[] = [];
	if (spec.user && spec.user !== 'root') {
		parts.push('runuser', '-u', spec.user, '--');
	}
	if (spec.env && spec.env.length > 0) {
		parts.push('env', ...spec.env);
	}
	parts.push(...spec.cmd);
	const inner = parts.map(shellQuote).join(' ');
	return `{ ${inner} ; } 2>${shellQuote(spec.stderrPath)}`;
}

/** The exec script, wrapped ready to send. */
export function renderDaytonaExec(spec: DaytonaExecRender): string {
	return asShellCommand(renderDaytonaExecScript(spec));
}

/**
 * Read back (and delete) an exec's stderr file.
 *
 * `tail -c` bounds what a long run can hand back: an agent run lasting hours
 * can write an unbounded amount of stderr, and reading the whole file would
 * materialize it in the server process - the copy-instead-of-stream failure
 * AGENTS.md calls out. The tail is the useful part anyway, since that is where
 * a failure's message lands.
 */
export function renderStderrDrain(stderrPath: string, maxBytes: number): string {
	const p = shellQuote(stderrPath);
	return asShellCommand(`tail -c ${maxBytes} ${p} 2>/dev/null; rm -f ${p}`);
}
