import { WsMessageType } from '@hezo/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ProvisioningLogBroadcaster } from '../../services/provisioning-logs';
import type { WebSocketManager } from '../../services/ws';

describe('ProvisioningLogBroadcaster', () => {
	let broadcaster: ProvisioningLogBroadcaster;
	let wsManager: { broadcast: ReturnType<typeof vi.fn> };

	beforeEach(() => {
		broadcaster = new ProvisioningLogBroadcaster();
		wsManager = { broadcast: vi.fn() };
		broadcaster.setWsManager(wsManager as unknown as WebSocketManager);
	});

	it('buffers and broadcasts each line to the container-logs room', () => {
		broadcaster.emit('p1', 'stdout', 'line-a\nline-b');

		expect(wsManager.broadcast).toHaveBeenCalledTimes(2);
		expect(wsManager.broadcast).toHaveBeenNthCalledWith(1, 'container-logs:p1', {
			type: WsMessageType.ContainerLog,
			projectId: 'p1',
			stream: 'stdout',
			text: 'line-a',
		});
		expect(wsManager.broadcast).toHaveBeenNthCalledWith(2, 'container-logs:p1', {
			type: WsMessageType.ContainerLog,
			projectId: 'p1',
			stream: 'stdout',
			text: 'line-b',
		});
	});

	it('skips empty lines from trailing newlines', () => {
		broadcaster.emit('p1', 'stderr', 'only-line\n');
		expect(wsManager.broadcast).toHaveBeenCalledTimes(1);
		expect(wsManager.broadcast).toHaveBeenCalledWith(
			'container-logs:p1',
			expect.objectContaining({ text: 'only-line', stream: 'stderr' }),
		);
	});

	it('replays buffered lines to a joining socket', () => {
		broadcaster.emit('p1', 'stdout', 'one');
		broadcaster.emit('p1', 'stderr', 'two');

		const send = vi.fn();
		broadcaster.replay('p1', send);

		expect(send).toHaveBeenCalledTimes(2);
		expect(send).toHaveBeenNthCalledWith(1, {
			type: WsMessageType.ContainerLog,
			projectId: 'p1',
			stream: 'stdout',
			text: 'one',
		});
		expect(send).toHaveBeenNthCalledWith(2, {
			type: WsMessageType.ContainerLog,
			projectId: 'p1',
			stream: 'stderr',
			text: 'two',
		});
	});

	it('replay is a no-op when nothing is buffered', () => {
		const send = vi.fn();
		broadcaster.replay('unknown', send);
		expect(send).not.toHaveBeenCalled();
	});

	it('clear drops the buffer so further replays send nothing', () => {
		broadcaster.emit('p1', 'stdout', 'one');
		broadcaster.clear('p1');

		const send = vi.fn();
		broadcaster.replay('p1', send);
		expect(send).not.toHaveBeenCalled();
	});

	it('caps the buffer at the maximum line count', () => {
		for (let i = 0; i < 600; i++) {
			broadcaster.emit('p1', 'stdout', `line-${i}`);
		}

		const send = vi.fn();
		broadcaster.replay('p1', send);
		expect(send).toHaveBeenCalledTimes(500);
		expect(send.mock.calls[0][0]).toMatchObject({ text: 'line-100' });
		expect(send.mock.calls[499][0]).toMatchObject({ text: 'line-599' });
	});

	it('does not throw when no wsManager has been set', () => {
		const bare = new ProvisioningLogBroadcaster();
		expect(() => bare.emit('p1', 'stdout', 'line')).not.toThrow();

		const send = vi.fn();
		bare.replay('p1', send);
		expect(send).toHaveBeenCalledTimes(1);
	});
});
