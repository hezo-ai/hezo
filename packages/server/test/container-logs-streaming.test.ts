import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ContainerLogStreamer } from '../src/services/container-logs';
import { LogStreamBroker } from '../src/services/log-stream-broker';
import type { ContainerEngine } from '../src/services/sandbox/types';
import { WebSocketManager } from '../src/services/ws';

// Exercises the docker multiplexed-frame parsing loop in startStreaming, which
// the existing container-logs.test.ts never reaches (it always closes the
// stream immediately). Docker stream framing: 8-byte header per frame —
// byte[0] = stream type (1 stdout, 2 stderr), bytes[4..7] = big-endian payload
// length, followed by that many payload bytes.

function frame(stream: 'stdout' | 'stderr', text: string): Uint8Array {
	const payload = new TextEncoder().encode(text);
	const header = new Uint8Array(8);
	header[0] = stream === 'stderr' ? 2 : 1;
	const len = payload.length;
	header[4] = (len >> 24) & 0xff;
	header[5] = (len >> 16) & 0xff;
	header[6] = (len >> 8) & 0xff;
	header[7] = len & 0xff;
	const out = new Uint8Array(8 + len);
	out.set(header);
	out.set(payload, 8);
	return out;
}

/** A docker client whose containerLogs streams the given byte chunks then closes. */
function streamingDocker(chunks: Uint8Array[]): ContainerEngine {
	return {
		containerLogs: async () =>
			new Response(
				new ReadableStream({
					start(c) {
						for (const ch of chunks) c.enqueue(ch);
						c.close();
					},
				}),
			),
	} as unknown as ContainerEngine;
}

// Keyed on the container, not its project: a project holds several containers
// and a project-keyed stream merged their output into one.
const streamId = (containerId: string) => `container:${containerId}`;

describe('ContainerLogStreamer — frame parsing', () => {
	let streamer: ContainerLogStreamer;
	let logs: LogStreamBroker;

	beforeEach(() => {
		streamer = new ContainerLogStreamer();
		logs = new LogStreamBroker();
		logs.setWsManager(new WebSocketManager());
	});

	afterEach(() => {
		streamer.stopAll(logs);
	});

	it('parses complete frames and emits stdout/stderr lines into the broker', async () => {
		const docker = streamingDocker([
			frame('stdout', 'hello world\n'),
			frame('stderr', 'a warning\n'),
		]);
		streamer.subscribe('p1', 'c1', logs, docker);

		await vi.waitFor(() => {
			const text = logs.getLogText(streamId('c1'));
			expect(text).toContain('hello world');
			expect(text).toContain('a warning');
		});
	});

	it('reassembles a frame whose header and payload arrive in separate reads', async () => {
		const whole = frame('stdout', 'split across reads\n');
		// Split mid-payload: first chunk carries the header + a few payload bytes.
		const docker = streamingDocker([whole.slice(0, 11), whole.slice(11)]);
		streamer.subscribe('p2', 'c2', logs, docker);

		await vi.waitFor(() => {
			expect(logs.getLogText(streamId('c2'))).toContain('split across reads');
		});
	});

	it('handles multiple frames concatenated into a single read', async () => {
		const a = frame('stdout', 'line-A\n');
		const b = frame('stdout', 'line-B\n');
		const combined = new Uint8Array(a.length + b.length);
		combined.set(a);
		combined.set(b, a.length);
		const docker = streamingDocker([combined]);
		streamer.subscribe('p3', 'c3', logs, docker);

		await vi.waitFor(() => {
			const text = logs.getLogText(streamId('c3'));
			expect(text).toContain('line-A');
			expect(text).toContain('line-B');
		});
	});

	it('returns early without throwing when containerLogs yields null', async () => {
		const docker = { containerLogs: async () => null } as unknown as ContainerEngine;
		streamer.subscribe('p4', 'c4', logs, docker);
		// Give the async startStreaming a tick; nothing should be emitted.
		await new Promise((r) => setTimeout(r, 10));
		expect(logs.getLogText(streamId('c4'))).toBe('');
	});

	it('returns early when the response has no readable body', async () => {
		const docker = {
			containerLogs: async () => new Response(null),
		} as unknown as ContainerEngine;
		streamer.subscribe('p5', 'c5', logs, docker);
		await new Promise((r) => setTimeout(r, 10));
		expect(logs.getLogText(streamId('c5'))).toBe('');
	});

	it('swallows an AbortError raised mid-stream without rejecting', async () => {
		const docker = {
			containerLogs: async (_id: string, _opts: unknown, signal?: AbortSignal) =>
				new Response(
					new ReadableStream({
						async pull(c) {
							// Emit one frame, then abort and surface an AbortError on the next read.
							c.enqueue(frame('stdout', 'before abort\n'));
							await new Promise((r) => setTimeout(r, 5));
							if (signal?.aborted) {
								const e = new Error('aborted');
								e.name = 'AbortError';
								c.error(e);
							}
						},
					}),
				),
		} as unknown as ContainerEngine;

		streamer.subscribe('p6', 'c6', logs, docker);
		await vi.waitFor(() => {
			expect(logs.getLogText(streamId('c6'))).toContain('before abort');
		});
		// Aborting triggers the AbortError path in the reader loop's catch.
		streamer.unsubscribe('c6');
		// No unhandled rejection / throw escapes; a follow-up unsubscribe is a no-op.
		expect(() => streamer.unsubscribe('c6')).not.toThrow();
	});

	it('keeps the container log when startStreaming rejects (containerLogs throws)', async () => {
		const docker = {
			containerLogs: async () => {
				throw new Error('docker exploded');
			},
		} as unknown as ContainerEngine;

		streamer.subscribe('p8', 'c8', logs, docker);
		// The .catch drops the *follow* attempt, not the container's log. Ending the
		// broker stream here is what used to erase a provisioning trace over an
		// engine that could not be followed - which is every managed backend, where
		// there is no container log to follow in the first place.
		await vi.waitFor(() => {
			expect(streamer.isFollowing('c8')).toBe(false);
		});
		expect(logs.isActive(streamId('c8'))).toBe(true);
		logs.emit(streamId('c8'), 'stdout', 'still writable\n');
		expect(logs.getLogText(streamId('c8'))).toContain('still writable');
		expect(() => streamer.unsubscribe('c8')).not.toThrow();
	});

	it('emits a replace-snapshot via buildSnapshot when the room is replayed', async () => {
		const docker = streamingDocker([frame('stdout', 'snapshot line\n')]);
		streamer.subscribe('p9', 'c9', logs, docker);
		await vi.waitFor(() => {
			expect(logs.getLogText(streamId('c9'))).toContain('snapshot line');
		});

		const sent: unknown[] = [];
		logs.replay('container-logs:c9', (payload) => sent.push(payload));
		expect(sent.length).toBe(1);
		const snap = sent[0] as {
			containerId: string;
			projectId: string;
			replace: boolean;
			text: string;
			stream: string;
		};
		// The container identifies the stream; the project rides along so a client
		// can link back to it.
		expect(snap.containerId).toBe('c9');
		expect(snap.projectId).toBe('p9');
		expect(snap.replace).toBe(true);
		expect(snap.stream).toBe('stdout');
		expect(snap.text).toContain('snapshot line');
	});

	it('deletes the stream entry from the streamer once the source closes', async () => {
		const docker = streamingDocker([frame('stdout', 'done\n')]);
		streamer.subscribe('p7', 'c7', logs, docker);
		await vi.waitFor(() => {
			expect(logs.getLogText(streamId('c7'))).toContain('done');
		});
		// After the source stream completes, startStreaming's finally deletes the
		// entry, so a subsequent unsubscribe is a no-op rather than a double-abort.
		await new Promise((r) => setTimeout(r, 10));
		expect(() => streamer.unsubscribe('c7')).not.toThrow();
	});
});
