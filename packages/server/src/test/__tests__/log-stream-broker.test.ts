import { WsMessageType } from '@hezo/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LogStreamBroker } from '../../services/log-stream-broker';
import { WebSocketManager } from '../../services/ws';

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
});
