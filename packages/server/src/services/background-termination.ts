/**
 * Claude Code's headless `--print` mode caps how long it waits for still-running
 * background tasks (a `run_in_background` job, a Workflow fan-out that hasn't
 * synthesized yet) and then FORCE-KILLS them, printing a diagnostic line like
 * "Background tasks still running after 600s; terminating." to its own output.
 * `CLAUDE_CODE_QUIET_ENV` sets `CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS=0` to lift
 * that ceiling, but an older CLI (or one that ignores the override) still
 * terminates the work — and the CLI then exits 0 with a NON-error `result`, so a
 * run that already wrote something earlier (e.g. a progress update) would be
 * counted a success even though its actual deliverable was killed mid-flight.
 * This is the runner-side backstop: detect the diagnostic so the run is failed.
 *
 * Matched only against the CLI's own diagnostic output — stderr, plus non-JSON
 * stdout lines. The stream-json events an agent's text rides in are JSON objects
 * (they start with `{`), so an agent that merely echoes this phrase in its
 * message can't trip the backstop.
 */
const BACKGROUND_TERMINATION_MARKER = /Background tasks still running after .*?terminating/i;

/**
 * Cap on how much of one unterminated line is held while scanning. A run's raw
 * transcript is a single stream-json line per event and can be hundreds of MB,
 * so the scanner must never grow with it.
 */
const MAX_PENDING_LINE_CHARS = 8192;
/** Retained across a truncation so a marker straddling the cut is still found. */
const RETAINED_TAIL_CHARS = 512;

/**
 * Line-oriented marker scan over one stream, fed incrementally.
 *
 * `skipJsonLines` reproduces the stdout rule: a line that starts with `{` is a
 * stream-json event carrying agent-authored text and can never trip the
 * backstop. Once a long line is classified as one, the rest of it is discarded
 * as it arrives rather than buffered.
 */
class MarkerLineScanner {
	private pending = '';
	private skippingLine = false;
	private found = false;

	constructor(private readonly skipJsonLines: boolean) {}

	push(text: string): void {
		if (this.found) return;
		let rest = text;
		for (;;) {
			const newline = rest.indexOf('\n');
			if (newline === -1) {
				this.appendPartial(rest);
				return;
			}
			this.appendPartial(rest.slice(0, newline));
			this.endLine();
			rest = rest.slice(newline + 1);
		}
	}

	/** Scan the trailing unterminated line and report the verdict. */
	finish(): boolean {
		this.endLine();
		return this.found;
	}

	private appendPartial(text: string): void {
		if (this.found || this.skippingLine || text.length === 0) return;
		this.pending += text;
		if (this.pending.length <= MAX_PENDING_LINE_CHARS) return;

		// Past the cap there is definitely a non-whitespace character to classify on.
		const leading = this.pending.trimStart();
		if (this.skipJsonLines && leading.startsWith('{')) {
			this.skippingLine = true;
			this.pending = '';
			return;
		}
		if (BACKGROUND_TERMINATION_MARKER.test(this.pending)) {
			this.found = true;
			this.pending = '';
			return;
		}
		this.pending = this.pending.slice(-RETAINED_TAIL_CHARS);
	}

	private endLine(): void {
		if (!this.found && !this.skippingLine) {
			const trimmed = this.pending.trim();
			const skippable = trimmed.length === 0 || (this.skipJsonLines && trimmed.startsWith('{'));
			if (!skippable && BACKGROUND_TERMINATION_MARKER.test(trimmed)) this.found = true;
		}
		this.pending = '';
		this.skippingLine = false;
	}
}

/**
 * Incremental form of the background-termination scan, fed from the same
 * per-chunk callback the log pipeline uses.
 *
 * The exec transport used to retain the run's entire raw stdout and stderr just
 * so this scan could run once at the end. That transcript is the full
 * stream-json stream — every tool result in full, strictly larger than the
 * (capped) rendered log and held alongside it — so on a busy instance it was the
 * dominant heap consumer. Nothing needs the bytes; only this verdict.
 */
export class BackgroundTerminationDetector {
	private readonly scanners = {
		stdout: new MarkerLineScanner(true),
		stderr: new MarkerLineScanner(false),
	};

	push(stream: 'stdout' | 'stderr', text: string): void {
		this.scanners[stream].push(text);
	}

	/** Flush both trailing lines and report whether the marker was seen. */
	finish(): boolean {
		// Both sides must flush — `||` would short-circuit and leave one unscanned.
		const stdout = this.scanners.stdout.finish();
		const stderr = this.scanners.stderr.finish();
		return stdout || stderr;
	}
}

/**
 * Whole-string form, for callers that already hold the complete output. Runs
 * through the same scanner as the streaming path so the two can't diverge.
 */
export function detectTerminatedBackgroundWork(stdout: string, stderr: string): boolean {
	const detector = new BackgroundTerminationDetector();
	detector.push('stdout', stdout);
	detector.push('stderr', stderr);
	return detector.finish();
}
