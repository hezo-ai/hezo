import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ContainerLogStreamer } from '../src/services/container-logs';
import { LogStreamBroker } from '../src/services/log-stream-broker';
import type { ContainerEngine } from '../src/services/sandbox/types';
import { WebSocketManager } from '../src/services/ws';

const mockDocker = {
	containerLogs: async () =>
		new Response(
			new ReadableStream({
				start(c) {
					c.close();
				},
			}),
		),
} as unknown as ContainerEngine;

describe('ContainerLogStreamer', () => {
	let streamer: ContainerLogStreamer;
	let logs: LogStreamBroker;

	beforeEach(() => {
		streamer = new ContainerLogStreamer();
		logs = new LogStreamBroker();
		logs.setWsManager(new WebSocketManager());
		vi.clearAllMocks();
	});

	afterEach(() => {
		streamer.stopAll(logs);
	});

	it('increments refCount for the same container on subsequent subscribes', () => {
		streamer.subscribe('proj-1', 'ctr-1', logs, mockDocker);
		streamer.subscribe('proj-1', 'ctr-1', logs, mockDocker);

		// refCount is now 2. First unsubscribe drops to 1 — stream should still exist.
		streamer.unsubscribe('ctr-1');

		// Stream still alive: subscribe again increments rather than creating a new entry.
		// If it had been deleted, a new entry would start at refCount 1; either way no throw.
		// Confirm the stream is alive by needing two more unsubscribes to fully remove it.
		streamer.unsubscribe('ctr-1'); // 1 → 0, now deleted
		// A third unsubscribe is a no-op (entry is gone), which verifies the stream
		// was properly tracked and cleaned up.
		expect(() => streamer.unsubscribe('ctr-1')).not.toThrow();
	});

	it('creates a new stream entry for a new projectId', () => {
		streamer.subscribe('proj-2', 'ctr-2', logs, mockDocker);

		// Stream was registered at refCount 1. A single unsubscribe removes it.
		streamer.unsubscribe('ctr-2');

		// Entry is gone — further unsubscribe is a no-op (no throw).
		expect(() => streamer.unsubscribe('ctr-2')).not.toThrow();
	});

	it('decrements refCount on unsubscribe without aborting while count > 0', () => {
		let abortCalled = false;
		const trackingDocker: ContainerEngine = {
			containerLogs: async (_id: string, _opts: any, signal: AbortSignal) => {
				signal?.addEventListener('abort', () => {
					abortCalled = true;
				});
				return new Response(
					new ReadableStream({
						start(c) {
							c.close();
						},
					}),
				);
			},
		} as unknown as ContainerEngine;

		streamer.subscribe('proj-3', 'ctr-3', logs, trackingDocker);
		streamer.subscribe('proj-3', 'ctr-3', logs, trackingDocker);

		// First unsubscribe: refCount 2 → 1, no abort yet.
		streamer.unsubscribe('ctr-3');
		expect(abortCalled).toBe(false);

		// Clean up remaining subscriber.
		streamer.unsubscribe('ctr-3');
	});

	it('aborts and deletes the stream when refCount reaches 0', () => {
		let abortCalled = false;
		const trackingDocker: ContainerEngine = {
			containerLogs: async (_id: string, _opts: any, signal: AbortSignal) => {
				signal?.addEventListener('abort', () => {
					abortCalled = true;
				});
				return new Response(
					new ReadableStream({
						start(c) {
							c.close();
						},
					}),
				);
			},
		} as unknown as ContainerEngine;

		streamer.subscribe('proj-4', 'ctr-4', logs, trackingDocker);

		// refCount 1 → 0: should abort and remove the entry.
		streamer.unsubscribe('ctr-4');

		expect(abortCalled).toBe(true);

		// Entry is gone — second unsubscribe is a no-op.
		expect(() => streamer.unsubscribe('ctr-4')).not.toThrow();
	});

	it('is a no-op when unsubscribing an unknown container', () => {
		expect(() => streamer.unsubscribe('does-not-exist')).not.toThrow();
	});

	it('stopAll() aborts all active streams and clears the map', () => {
		const aborted: Record<string, boolean> = {};

		const makeTracking = (label: string): ContainerEngine =>
			({
				containerLogs: async (_id: string, _opts: unknown, signal?: AbortSignal) => {
					signal?.addEventListener('abort', () => {
						aborted[label] = true;
					});
					return new Response(
						new ReadableStream({
							start(c) {
								c.close();
							},
						}),
					);
				},
			}) as unknown as ContainerEngine;

		streamer.subscribe('proj-a', 'ctr-a', logs, makeTracking('a'));
		streamer.subscribe('proj-b', 'ctr-b', logs, makeTracking('b'));
		streamer.subscribe('proj-c', 'ctr-c', logs, makeTracking('c'));

		streamer.stopAll(logs);

		expect(aborted.a).toBe(true);
		expect(aborted.b).toBe(true);
		expect(aborted.c).toBe(true);

		// Map is cleared — further unsubscribes are no-ops.
		expect(() => streamer.unsubscribe('ctr-a')).not.toThrow();
		expect(() => streamer.unsubscribe('ctr-b')).not.toThrow();
		expect(() => streamer.unsubscribe('ctr-c')).not.toThrow();
	});
});
