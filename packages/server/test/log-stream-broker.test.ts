import { WsMessageType } from '@hezo/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CappedLogBuffer } from '../src/services/log-buffer';
import { LogStreamBroker } from '../src/services/log-stream-broker';
import { WebSocketManager } from '../src/services/ws';

function makeRunConfig(
	runId: string,
	projectId: string,
	onFlush?: (text: string) => Promise<void>,
) {
	return {
		streamId: `run:${runId}`,
		room: `project-runs:${projectId}`,
		buildMessage: (line: { stream: 'stdout' | 'stderr'; text: string }) => ({
			type: WsMessageType.RunLog,
			projectId,
			runId,
			taskId: null as string | null,
			stream: line.stream,
			text: line.text,
		}),
		buildSnapshot: (text: string) => ({
			type: WsMessageType.RunLog,
			projectId,
			runId,
			taskId: null as string | null,
			stream: 'stdout' as const,
			text,
			replace: true,
		}),
		onFlush,
	};
}

function makeContainerConfig(projectId: string, streamId = `container:${projectId}`) {
	return {
		streamId,
		room: `container-logs:${projectId}`,
		buildMessage: (line: { stream: 'stdout' | 'stderr'; text: string }) => ({
			type: WsMessageType.ContainerLog,
			projectId,
			stream: line.stream,
			text: line.text,
		}),
		buildSnapshot: (text: string) => ({
			type: WsMessageType.ContainerLog,
			projectId,
			stream: 'stdout' as const,
			text,
			replace: true,
		}),
	};
}

describe('LogStreamBroker', () => {
	let broker: LogStreamBroker;
	let wsManager: WebSocketManager;

	beforeEach(() => {
		broker = new LogStreamBroker();
		wsManager = new WebSocketManager();
		broker.setWsManager(wsManager);
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it('broadcasts each non-empty line to subscribers of its room', () => {
		const received: Array<Record<string, unknown>> = [];
		const ws = {
			data: { auth: { type: 'test' }, rooms: new Set<string>() },
			send(msg: string) {
				received.push(JSON.parse(msg));
			},
		};
		wsManager.subscribe(ws, 'project-runs:p1');

		broker.begin(makeRunConfig('r1', 'p1'));
		broker.emit('run:r1', 'stdout', 'hello\nworld\n');

		expect(received).toHaveLength(2);
		expect(received[0]).toMatchObject({ runId: 'r1', stream: 'stdout', text: 'hello' });
		expect(received[1]).toMatchObject({ runId: 'r1', stream: 'stdout', text: 'world' });
	});

	it('replays one snapshot per stream registered to a room with the full buffered text', () => {
		broker.begin(makeContainerConfig('p1', 'container:p1'));
		broker.begin(makeContainerConfig('p1', 'provision:p1'));
		broker.emit('container:p1', 'stdout', 'live line\n');
		broker.emit('provision:p1', 'stderr', 'prov line\n');

		const replayed: Array<{ replace?: boolean; text?: string }> = [];
		broker.replay('container-logs:p1', (p) =>
			replayed.push(p as { replace?: boolean; text?: string }),
		);

		expect(replayed).toHaveLength(2);
		for (const msg of replayed) {
			expect(msg.replace).toBe(true);
		}
		const texts = replayed.map((m) => m.text);
		expect(texts).toEqual(expect.arrayContaining(['live line\n', '[stderr] prov line\n']));
	});

	it('persists each emit on its own line and collapses carriage-return redraws', () => {
		broker.begin(makeContainerConfig('p1'));
		// Provisioning emits discrete lines without trailing newlines...
		broker.emit('container:p1', 'stdout', '→ Preparing workspace');
		broker.emit('container:p1', 'stdout', '→ Resolving image');
		// ...and image-build output arrives with carriage-return progress spam.
		broker.emit('container:p1', 'stderr', '(Reading database 5%\r(Reading database 100%');

		const replayed: Array<{ text?: string }> = [];
		broker.replay('container-logs:p1', (p) => replayed.push(p as { text?: string }));
		expect(replayed).toHaveLength(1);
		// Each line is separated (no glued "→ …→ …"), the [stderr] tag sits at the
		// start of its own line so it can be stripped, and the redraw collapsed.
		expect(replayed[0].text).toBe(
			'→ Preparing workspace\n→ Resolving image\n[stderr] (Reading database 100%\n',
		);
	});

	it('does not bleed snapshots across streams in different rooms', () => {
		broker.begin(makeRunConfig('r1', 'p1'));
		broker.begin(makeRunConfig('r2', 'p2'));
		broker.emit('run:r1', 'stdout', 'p1-only\n');

		const p1Lines: Array<{ text?: string }> = [];
		const p2Lines: Array<{ text?: string }> = [];
		broker.replay('project-runs:p1', (p) => p1Lines.push(p as { text?: string }));
		broker.replay('project-runs:p2', (p) => p2Lines.push(p as { text?: string }));

		expect(p1Lines).toHaveLength(1);
		expect(p1Lines[0].text).toBe('p1-only\n');
		expect(p2Lines).toHaveLength(1);
		expect(p2Lines[0].text).toBe('');
	});

	it('debounces onFlush calls and invokes them with the accumulated text', async () => {
		vi.useFakeTimers();
		const onFlush = vi.fn(async (_text: string) => {});

		broker.begin(makeRunConfig('r1', 'p1', onFlush));
		broker.emit('run:r1', 'stdout', 'first\n');
		broker.emit('run:r1', 'stdout', 'second\n');

		expect(onFlush).not.toHaveBeenCalled();

		await vi.advanceTimersByTimeAsync(500);
		expect(onFlush).toHaveBeenCalledTimes(1);
		expect(onFlush).toHaveBeenCalledWith(expect.stringContaining('first'));
		expect(onFlush.mock.calls[0][0]).toContain('second');
	});

	it('flushes a pending dirty buffer on end()', async () => {
		vi.useFakeTimers();
		const onFlush = vi.fn(async (_text: string) => {});

		broker.begin(makeRunConfig('r1', 'p1', onFlush));
		broker.emit('run:r1', 'stdout', 'unflushed\n');

		await broker.end('run:r1');
		expect(onFlush).toHaveBeenCalledTimes(1);
		expect(onFlush).toHaveBeenCalledWith(expect.stringContaining('unflushed'));
		expect(broker.isActive('run:r1')).toBe(false);
	});

	it('end() on an unknown streamId is a no-op', async () => {
		await expect(broker.end('run:nope')).resolves.toBeUndefined();
	});

	it('tags stderr lines with the [stderr] prefix in the persisted text', async () => {
		const onFlush = vi.fn(async (_text: string) => {});
		broker.begin(makeRunConfig('r1', 'p1', onFlush));
		broker.emit('run:r1', 'stderr', 'bad\n');
		await broker.end('run:r1');
		expect(onFlush).toHaveBeenCalledWith(expect.stringContaining('[stderr] bad'));
	});

	it('drops further lines once the byte cap is reached', () => {
		broker.begin({
			...makeRunConfig('r1', 'p1'),
			capBytes: 10,
		});
		broker.emit('run:r1', 'stdout', '1234567890\n');
		broker.emit('run:r1', 'stdout', 'this should not broadcast\n');

		const replayed: Array<{ text?: string }> = [];
		broker.replay('project-runs:p1', (p) => replayed.push(p as { text?: string }));
		expect(replayed).toHaveLength(1);
		expect(replayed[0].text).toContain('1234567890');
		expect(replayed[0].text).not.toContain('this should not broadcast');
	});

	it('replay after end() yields nothing', async () => {
		broker.begin(makeRunConfig('r1', 'p1'));
		broker.emit('run:r1', 'stdout', 'gone\n');
		await broker.end('run:r1');

		const replayed: unknown[] = [];
		broker.replay('project-runs:p1', (p) => replayed.push(p));
		expect(replayed).toHaveLength(0);
	});

	describe('delta flushing', () => {
		it('each flush receives only the text appended since the last successful flush', async () => {
			vi.useFakeTimers();
			const flushes: string[] = [];
			broker.begin(makeRunConfig('r1', 'p1', async (delta) => void flushes.push(delta)));

			broker.emit('run:r1', 'stdout', 'first\n');
			await vi.advanceTimersByTimeAsync(500);
			broker.emit('run:r1', 'stdout', 'second\n');
			await vi.advanceTimersByTimeAsync(500);

			expect(flushes).toEqual(['first\n', 'second\n']);
		});

		it('re-sends the identical delta after a failed flush, exactly once after success', async () => {
			vi.useFakeTimers();
			const flushes: string[] = [];
			let fail = true;
			broker.begin(
				makeRunConfig('r1', 'p1', async (delta) => {
					flushes.push(delta);
					if (fail) throw new Error('db down');
				}),
			);

			broker.emit('run:r1', 'stdout', 'tail\n');
			await vi.advanceTimersByTimeAsync(500);
			expect(flushes).toEqual(['tail\n']);

			// The failure re-marked the stream dirty; the retry re-sends the same
			// delta (the offset never advanced), and success settles it for good.
			fail = false;
			await vi.advanceTimersByTimeAsync(500);
			expect(flushes).toEqual(['tail\n', 'tail\n']);

			await vi.advanceTimersByTimeAsync(1000);
			expect(flushes).toHaveLength(2);
		});

		it('end() after a successful periodic flush sends only the remainder', async () => {
			vi.useFakeTimers();
			const flushes: string[] = [];
			broker.begin(makeRunConfig('r1', 'p1', async (delta) => void flushes.push(delta)));

			broker.emit('run:r1', 'stdout', 'persisted\n');
			await vi.advanceTimersByTimeAsync(500);
			broker.emit('run:r1', 'stdout', 'remainder\n');
			await broker.end('run:r1');

			expect(flushes).toEqual(['persisted\n', 'remainder\n']);
		});

		it('serializes overlapping flushes so a slow flush never duplicates content', async () => {
			vi.useFakeTimers();
			const flushes: string[] = [];
			let release: (() => void) | null = null;
			broker.begin(
				makeRunConfig('r1', 'p1', async (delta) => {
					flushes.push(delta);
					await new Promise<void>((resolve) => {
						release = resolve;
					});
				}),
			);

			broker.emit('run:r1', 'stdout', 'one\n');
			await vi.advanceTimersByTimeAsync(500); // first flush starts, blocks in onFlush

			broker.emit('run:r1', 'stdout', 'two\n');
			await vi.advanceTimersByTimeAsync(500); // second flush chains behind the first
			expect(flushes).toEqual(['one\n']);

			const releaseFirst = release as unknown as () => void;
			release = null;
			releaseFirst(); // unblock the first flush; the chained one now runs
			await vi.advanceTimersByTimeAsync(0);
			expect(flushes).toEqual(['one\n', 'two\n']);

			(release as unknown as () => void)();
			await broker.end('run:r1');
			// Nothing new appended after 'two' — end() has no remainder to send.
			expect(flushes).toEqual(['one\n', 'two\n']);
		});

		it('a capped stream still invokes onFlush with an empty delta', async () => {
			vi.useFakeTimers();
			const flushes: string[] = [];
			broker.begin({
				...makeRunConfig('r1', 'p1', async (delta) => void flushes.push(delta)),
				capBytes: 10,
			});

			broker.emit('run:r1', 'stdout', '1234567890\n');
			await vi.advanceTimersByTimeAsync(500);
			expect(flushes).toHaveLength(1);
			expect(flushes[0]).toContain('truncated');

			// Emits after the cap append nothing, but the flush cadence must keep
			// firing — the run's usage snapshot rides the same callback.
			broker.emit('run:r1', 'stdout', 'dropped\n');
			await vi.advanceTimersByTimeAsync(500);
			expect(flushes).toHaveLength(2);
			expect(flushes[1]).toBe('');
		});
	});
});

describe('CappedLogBuffer prefix stability', () => {
	// The broker's delta flushing slices new text off by a persisted character
	// offset, which is only sound if every earlier toString() result is a strict
	// prefix of every later one — including across the truncation transition.
	it('every toString() result is a prefix of every later one, through truncation', () => {
		const buffer = new CappedLogBuffer(20);
		const snapshots: string[] = [buffer.toString()];

		buffer.append('stdout', 'one');
		snapshots.push(buffer.toString());
		buffer.append('stderr', 'two');
		snapshots.push(buffer.toString());
		buffer.append('stdout', 'x'.repeat(50)); // crosses the cap → truncation marker
		snapshots.push(buffer.toString());
		buffer.append('stdout', 'after-cap-noop');
		snapshots.push(buffer.toString());

		expect(buffer.isTruncated).toBe(true);
		for (let i = 1; i < snapshots.length; i++) {
			expect(snapshots[i].startsWith(snapshots[i - 1])).toBe(true);
		}
		// After the cap the text is frozen entirely.
		expect(snapshots[snapshots.length - 1]).toBe(snapshots[snapshots.length - 2]);
	});
});
