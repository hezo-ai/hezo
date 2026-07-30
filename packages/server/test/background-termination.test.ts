import { describe, expect, it } from 'vitest';
import {
	BackgroundTerminationDetector,
	detectTerminatedBackgroundWork,
} from '../src/services/background-termination';

const DIAGNOSTIC = 'Background tasks still running after 600s; terminating.';

describe('detectTerminatedBackgroundWork', () => {
	it('matches the CLI diagnostic on stderr', () => {
		expect(
			detectTerminatedBackgroundWork(
				'done',
				'Background tasks still running after 600s; terminating. Set CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS=0 to wait indefinitely.',
			),
		).toBe(true);
	});

	it('matches a bare non-JSON diagnostic line on stdout', () => {
		expect(
			detectTerminatedBackgroundWork(
				'{"type":"result","subtype":"success"}\nBackground tasks still running after 30s; terminating.\n',
				'',
			),
		).toBe(true);
	});

	it('ignores the phrase when it rides inside a stream-json stdout event', () => {
		const line = JSON.stringify({
			type: 'assistant',
			message: {
				content: [{ type: 'text', text: DIAGNOSTIC }],
			},
		});
		expect(detectTerminatedBackgroundWork(`${line}\n`, '')).toBe(false);
	});

	it('returns false for ordinary output', () => {
		expect(detectTerminatedBackgroundWork('all done\n', '')).toBe(false);
	});
});

/**
 * The runner feeds this from the exec chunk callback, so the same output split
 * at arbitrary byte boundaries must reach the same verdict as the whole-string
 * form — and must do so without the transcript ever being retained.
 */
describe('BackgroundTerminationDetector (incremental)', () => {
	const feed = (chunks: Array<['stdout' | 'stderr', string]>): boolean => {
		const detector = new BackgroundTerminationDetector();
		for (const [stream, text] of chunks) detector.push(stream, text);
		return detector.finish();
	};

	it('detects a diagnostic split across chunk boundaries', () => {
		expect(
			feed([
				['stdout', 'Background tasks still ru'],
				['stdout', 'nning after 600s; terminating.\n'],
			]),
		).toBe(true);
	});

	it('detects a diagnostic split mid-word on stderr', () => {
		expect(
			feed([
				['stderr', 'Background tasks still running after 6'],
				['stderr', '00s; terminating.'],
			]),
		).toBe(true);
	});

	it('detects a trailing diagnostic with no closing newline', () => {
		expect(feed([['stdout', `${DIAGNOSTIC}`]])).toBe(true);
	});

	it('still ignores a stream-json event delivered one character at a time', () => {
		const line = `${JSON.stringify({ type: 'assistant', text: DIAGNOSTIC })}\n`;
		expect(feed([...line].map((ch) => ['stdout', ch] as ['stdout', string]))).toBe(false);
	});

	it('interleaved stdout and stderr do not contaminate each other', () => {
		// Half the phrase on each stream must NOT match: the scanners are separate.
		expect(
			feed([
				['stdout', 'Background tasks still running '],
				['stderr', 'after 600s; terminating.'],
			]),
		).toBe(false);
	});

	it('agrees with the whole-string form on the same content', () => {
		const stdout = `{"type":"system"}\nsome noise\n${DIAGNOSTIC}\n`;
		const whole = detectTerminatedBackgroundWork(stdout, '');
		const chunked = feed(
			stdout.match(/[\s\S]{1,7}/g)?.map((c) => ['stdout', c] as ['stdout', string]) ?? [],
		);
		expect(chunked).toBe(whole);
		expect(chunked).toBe(true);
	});

	// The reason this class exists: a run's stream-json line can be hundreds of
	// MB. Scanning must stay bounded, and a huge JSON event must not match even
	// though it contains the phrase.
	it('stays bounded on a very long stream-json line carrying the phrase', () => {
		const detector = new BackgroundTerminationDetector();
		detector.push('stdout', `{"type":"assistant","text":"${DIAGNOSTIC} `);
		for (let i = 0; i < 500; i++) detector.push('stdout', 'x'.repeat(4096));
		detector.push('stdout', '"}\n');
		expect(detector.finish()).toBe(false);
	});

	it('still finds a diagnostic that follows a very long non-JSON line', () => {
		const detector = new BackgroundTerminationDetector();
		for (let i = 0; i < 200; i++) detector.push('stdout', 'y'.repeat(4096));
		detector.push('stdout', `\n${DIAGNOSTIC}\n`);
		expect(detector.finish()).toBe(true);
	});
});
