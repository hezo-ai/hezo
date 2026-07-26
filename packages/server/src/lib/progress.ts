/**
 * Terminal progress reporting for the long-running CLI subcommands.
 *
 * A restore of a real instance spends most of its wall time inside two silent
 * loops - inserting millions of rows and copying thousands of asset blobs -
 * during which the operator cannot tell a slow restore from a hung one. The
 * engines (`db/logical-backup.ts`, `assets/blob-backup.ts`) stay free of
 * terminal concerns: they emit `ProgressState` values through an optional
 * callback, and the CLI owns rendering.
 *
 * Rendering adapts to the output stream. On a TTY a single line is rewritten in
 * place, so a minutes-long phase occupies one row. When output is a pipe or a
 * log file (systemd, Docker, CI) the same information is appended as ordinary
 * lines, throttled so a long restore adds a handful of lines rather than
 * thousands.
 *
 * Two shapes of phase:
 *
 * - **Announcement** (no `done`/`bytes`/`ratio`) - a step whose duration can't
 *   be measured from outside, e.g. a blocking `gunzip`. Printed as a terminated
 *   line, so anything the step itself logs (migration lines during the schema
 *   replay) starts on a clean row.
 * - **Counter** - a step with a running count. Rewritten in place until the
 *   phase changes; the final state of each phase is always flushed.
 */

export interface ProgressState {
	/** Stable phase id; a change ends the previous phase's line. */
	phase: string;
	/** Human-readable phase label, e.g. "Loading rows". */
	label: string;
	/** Units completed so far. */
	done?: number;
	/** Total units, when known up front. */
	total?: number;
	/** Unit noun for `done`/`total`, e.g. "rows" or "files". */
	unit?: string;
	/** Bytes processed so far, shown alongside the unit counts. */
	bytes?: number;
	/** Extra context - the table or file currently being processed. */
	detail?: string;
	/**
	 * Explicit 0..1 completion for a phase whose progress isn't expressed by
	 * `done`/`total` (e.g. rows parsed out of a known input length).
	 */
	ratio?: number;
}

export type ProgressCallback = (state: ProgressState) => void;

export interface ProgressReporter {
	report: ProgressCallback;
	/** Flush and end the active line. Safe to call repeatedly. */
	finish: () => void;
	/** Print a standalone line without losing the current phase's last state. */
	note: (line: string) => void;
}

export interface ProgressWriteStream {
	write(chunk: string): unknown;
	isTTY?: boolean;
	columns?: number;
}

export interface ProgressReporterOptions {
	write: (chunk: string) => void;
	isTty?: boolean;
	columns?: number;
	/** Minimum ms between re-renders within one phase. */
	throttleMs?: number;
	now?: () => number;
}

/** Re-render at most ~8x/second on a TTY - smooth without burning the terminal. */
const TTY_THROTTLE_MS = 120;
/** One appended line every few seconds keeps a piped log readable. */
const PIPE_THROTTLE_MS = 5_000;
/** An ETA computed off the first moment of a phase is noise. */
const ETA_MIN_ELAPSED_MS = 3_000;
const DEFAULT_COLUMNS = 80;
/** ANSI erase-to-end-of-line, so a shorter re-render leaves no stale tail. */
const CLEAR_TO_EOL = '\u001b[K';

const COUNT_FORMAT = new Intl.NumberFormat('en-US');

export function formatCount(n: number): string {
	if (!Number.isFinite(n)) return '0';
	return COUNT_FORMAT.format(Math.round(n));
}

const BYTE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];

export function formatBytes(n: number): string {
	if (!Number.isFinite(n) || n <= 0) return '0 B';
	let value = n;
	let unit = 0;
	while (value >= 1024 && unit < BYTE_UNITS.length - 1) {
		value /= 1024;
		unit += 1;
	}
	const digits = unit === 0 ? 0 : value < 10 ? 1 : 0;
	return `${value.toFixed(digits)} ${BYTE_UNITS[unit]}`;
}

export function formatDuration(ms: number): string {
	if (!Number.isFinite(ms) || ms <= 0) return '0s';
	const totalSeconds = Math.round(ms / 1000);
	if (totalSeconds < 60) return `${totalSeconds}s`;
	const minutes = Math.floor(totalSeconds / 60);
	if (minutes < 60) return `${minutes}m ${String(totalSeconds % 60).padStart(2, '0')}s`;
	const hours = Math.floor(minutes / 60);
	return `${hours}h ${String(minutes % 60).padStart(2, '0')}m`;
}

/** Completion of a state as 0..1, or undefined when it can't be known. */
export function progressRatio(state: ProgressState): number | undefined {
	if (state.ratio !== undefined && Number.isFinite(state.ratio)) {
		return Math.min(1, Math.max(0, state.ratio));
	}
	if (state.total !== undefined && state.total > 0 && state.done !== undefined) {
		return Math.min(1, Math.max(0, state.done / state.total));
	}
	return undefined;
}

/** Linear extrapolation from the phase's own elapsed time; undefined when unusable. */
function estimateRemainingMs(ratio: number | undefined, elapsedMs: number): number | undefined {
	if (ratio === undefined || ratio <= 0 || ratio >= 1) return undefined;
	if (elapsedMs < ETA_MIN_ELAPSED_MS) return undefined;
	return (elapsedMs * (1 - ratio)) / ratio;
}

/** Trim to `columns` so an over-wide line can still be rewritten in place. */
export function truncateLine(line: string, columns: number): string {
	if (columns <= 1 || line.length <= columns) return line;
	return `${line.slice(0, Math.max(1, columns - 1))}…`;
}

export function formatProgressLine(state: ProgressState, elapsedMs: number): string {
	const parts: string[] = [state.label];
	const ratio = progressRatio(state);
	if (ratio !== undefined) parts.push(`${Math.floor(ratio * 100)}%`);
	if (state.done !== undefined) {
		const unit = state.unit ? ` ${state.unit}` : '';
		parts.push(
			state.total !== undefined
				? `${formatCount(state.done)}/${formatCount(state.total)}${unit}`
				: `${formatCount(state.done)}${unit}`,
		);
	}
	if (state.bytes !== undefined) parts.push(formatBytes(state.bytes));
	if (state.detail) parts.push(state.detail);
	if (elapsedMs >= 1_000) parts.push(formatDuration(elapsedMs));
	const remaining = estimateRemainingMs(ratio, elapsedMs);
	if (remaining !== undefined) parts.push(`~${formatDuration(remaining)} left`);
	return parts.join(' · ');
}

/** True when the state carries a running measure (vs a one-shot announcement). */
function isCounterState(state: ProgressState): boolean {
	return state.done !== undefined || state.bytes !== undefined || state.ratio !== undefined;
}

export function createProgressReporter(options: ProgressReporterOptions): ProgressReporter {
	const isTty = options.isTty === true;
	const now = options.now ?? (() => Date.now());
	const throttleMs = options.throttleMs ?? (isTty ? TTY_THROTTLE_MS : PIPE_THROTTLE_MS);
	const columns = Math.max(20, options.columns || DEFAULT_COLUMNS);

	let phase: string | null = null;
	let phaseStartedAt = 0;
	/** Latest state not yet rendered (throttled away) - flushed before the phase ends. */
	let pending: ProgressState | null = null;
	let lastRenderAt = 0;
	/** A TTY line is on screen without its terminating newline. */
	let lineOpen = false;

	const render = (state: ProgressState): void => {
		const line = truncateLine(formatProgressLine(state, now() - phaseStartedAt), columns - 1);
		if (isTty) {
			// \r returns to column 0, CLEAR_TO_EOL wipes the tail of a longer previous line.
			options.write(`\r${line}${CLEAR_TO_EOL}`);
			lineOpen = true;
		} else {
			options.write(`${line}\n`);
		}
		lastRenderAt = now();
		pending = null;
	};

	const endPhase = (): void => {
		if (pending) render(pending);
		if (lineOpen) {
			options.write('\n');
			lineOpen = false;
		}
		phase = null;
	};

	return {
		report(state: ProgressState): void {
			if (state.phase !== phase) {
				endPhase();
				phase = state.phase;
				phaseStartedAt = now();
				lastRenderAt = 0;
				render(state);
			} else {
				const ratio = progressRatio(state);
				const complete = ratio !== undefined && ratio >= 1;
				if (!complete && now() - lastRenderAt < throttleMs) {
					pending = state;
					return;
				}
				render(state);
			}
			// An announcement never stays open: whatever the step logs next starts
			// on its own row.
			if (!isCounterState(state) && lineOpen) {
				options.write('\n');
				lineOpen = false;
			}
		},
		finish(): void {
			endPhase();
		},
		note(line: string): void {
			endPhase();
			options.write(`${line}\n`);
		},
	};
}

/** A reporter that renders nothing - for tests and non-interactive callers. */
export function createNullProgressReporter(): ProgressReporter {
	return { report: () => {}, finish: () => {}, note: () => {} };
}

/**
 * Reporter bound to a process stream (stdout by default). Silent under vitest
 * (`NODE_ENV=test`), where raw stream writes would fight the test reporter -
 * the rendering itself is covered by unit tests against an injected stream.
 */
export function createStreamProgressReporter(
	stream: ProgressWriteStream = process.stdout,
	env: NodeJS.ProcessEnv = process.env,
): ProgressReporter {
	if (env.NODE_ENV === 'test') return createNullProgressReporter();
	return createProgressReporter({
		write: (chunk) => {
			stream.write(chunk);
		},
		isTty: stream.isTTY === true,
		columns: stream.columns,
	});
}
