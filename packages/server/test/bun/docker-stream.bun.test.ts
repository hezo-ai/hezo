import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { DockerClient } from '../../src/services/docker';
import type { ContainerEngine, ExecLogChunk } from '../../src/services/sandbox/types';
import { type DockerSockSim, startDockerSockSim } from '../helpers/docker-sock-sim';

// Runtime tier: the exec-attach / log-follow streams ride node:http over the
// docker unix socket specifically because Bun's fetch enforces a hardcoded
// ~5-minute idle timeout (oven-sh/bun#5930) that severed quiet agent runs
// with "The operation timed out.". A Node-only (vitest) pass says nothing
// about whether Bun's node:http honours socketPath, streams IncomingMessage
// through Readable.toWeb, or propagates req.destroy(err) into the web body —
// so the transport contract is pinned here on the production runtime too.

let sim: DockerSockSim;
let docker: ContainerEngine;

beforeAll(async () => {
	sim = await startDockerSockSim();
	docker = new DockerClient(sim.socketPath);
});

afterAll(async () => {
	await sim.close();
});

describe('execStart over node:http (Bun runtime)', () => {
	test('streams multiplexed chunks through onChunk and retains no transcript', async () => {
		sim.onExecStart('exec-stream', {
			frames: [
				{ stream: 'stdout', text: 'hello ' },
				{ stream: 'stderr', text: 'warn!' },
				{ stream: 'stdout', text: 'world', delayMs: 20 },
			],
		});

		const chunks: ExecLogChunk[] = [];
		const result = await docker.execStart('exec-stream', {
			onChunk: (c) => {
				chunks.push(c);
			},
		});

		expect(chunks).toEqual([
			{ stream: 'stdout', text: 'hello ' },
			{ stream: 'stderr', text: 'warn!' },
			{ stream: 'stdout', text: 'world' },
		]);
		// A streamed exec keeps nothing — see ExecStartOpts.onChunk.
		expect(result).toEqual({ stdout: '', stderr: '' });
	});

	test('buffers and demuxes without onChunk', async () => {
		sim.onExecStart('exec-buffered', {
			frames: [
				{ stream: 'stdout', text: 'out' },
				{ stream: 'stderr', text: 'err' },
			],
		});

		const result = await docker.execStart('exec-buffered');

		expect(result.stdout).toBe('out');
		expect(result.stderr).toBe('err');
	});

	test('throws on a non-200 exec start', async () => {
		sim.onExecStart('exec-bad', { status: 409, body: 'container not running' });

		expect(docker.execStart('exec-bad')).rejects.toThrow(
			'Docker execStart failed (409): container not running',
		);
	});

	test('rejects with AbortError when the signal aborts mid-stream', async () => {
		sim.onExecStart('exec-hang', {
			frames: [{ stream: 'stdout', text: 'started' }],
			hangAfterFrames: true,
		});

		const ac = new AbortController();
		const seen: string[] = [];
		let caught: unknown;
		try {
			await docker.execStart('exec-hang', {
				signal: ac.signal,
				onChunk: (c) => {
					seen.push(c.text);
					ac.abort();
				},
			});
		} catch (e) {
			caught = e;
		}

		expect((caught as Error)?.name).toBe('AbortError');
		expect(seen).toEqual(['started']);
	});

	test('rejects immediately when the signal is already aborted', async () => {
		sim.onExecStart('exec-pre-aborted', { frames: [{ stream: 'stdout', text: 'never' }] });
		const ac = new AbortController();
		ac.abort();

		let caught: unknown;
		try {
			await docker.execStart('exec-pre-aborted', { signal: ac.signal });
		} catch (e) {
			caught = e;
		}
		expect((caught as Error)?.name).toBe('AbortError');
	});

	test('buffered read (no onChunk) aborts a hung exec at the deadline instead of hanging', async () => {
		// No onChunk → the buffered branch (await res.arrayBuffer()). This is the
		// git-fetch prep path that hung indefinitely in production: the exec stream
		// stays open-but-silent, and under Bun destroying the node:http request does
		// not reject the pending web-body read, so the declared timeout was silently
		// ineffective. The read must now settle at the deadline, not run forever.
		sim.onExecStart('exec-hang-buffered', {
			frames: [{ stream: 'stdout', text: 'partial' }],
			hangAfterFrames: true,
		});

		const started = Date.now();
		let caught: unknown;
		try {
			await docker.execStart('exec-hang-buffered', { signal: AbortSignal.timeout(150) });
		} catch (e) {
			caught = e;
		}
		const elapsed = Date.now() - started;

		expect(caught).toBeDefined();
		expect(elapsed).toBeLessThan(2000);
	});
});

describe('containerLogs over node:http (Bun runtime)', () => {
	test('returns a streaming Response whose body carries the multiplexed log', async () => {
		sim.onContainerLogs('ctr-1', {
			frames: [{ stream: 'stdout', text: 'log line\n' }],
		});

		const res = await docker.containerLogs('ctr-1', { follow: false });

		expect(res).not.toBeNull();
		const raw = new Uint8Array(await res!.arrayBuffer());
		expect(raw[0]).toBe(1);
		expect(new TextDecoder().decode(raw.slice(8))).toBe('log line\n');
	});

	test('returns null for a missing container', async () => {
		const res = await docker.containerLogs('ctr-missing', { follow: false });
		expect(res).toBeNull();
	});
});
