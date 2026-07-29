import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DockerClient, type ExecLogChunk } from '../src/services/docker';
import { type DockerSockSim, startDockerSockSim } from './helpers/docker-sock-sim';

// The exec-attach and log-follow streams ride node:http (not fetch) so Bun's
// hardcoded ~5-minute idle fetch timeout can't sever a quiet run mid-flight
// (oven-sh/bun#5930). These tests drive the real DockerClient against a
// unix-socket docker simulator to pin the transport's contract: multiplexed
// streaming, buffered demux, error statuses, and abort semantics. The same
// contract is exercised on the production runtime in
// test/bun/docker-stream.bun.test.ts.

let sim: DockerSockSim;
let docker: DockerClient;

beforeAll(async () => {
	sim = await startDockerSockSim();
	docker = new DockerClient(sim.socketPath);
});

afterAll(async () => {
	await sim.close();
});

describe('execStart over node:http', () => {
	it('streams multiplexed chunks through onChunk and retains no transcript', async () => {
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
		// A streamed exec keeps nothing: an agent run's raw stream-json transcript
		// reaches hundreds of MB, so callers derive what they need from the chunks.
		expect(result).toEqual({ stdout: '', stderr: '' });
	});

	it('buffers and demuxes without onChunk', async () => {
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

	it('throws on a non-200 exec start', async () => {
		sim.onExecStart('exec-bad', { status: 409, body: 'container not running' });

		await expect(docker.execStart('exec-bad')).rejects.toThrow(
			/Docker execStart failed \(409\): container not running/,
		);
	});

	it('rejects with AbortError when the signal aborts mid-stream', async () => {
		sim.onExecStart('exec-hang', {
			frames: [{ stream: 'stdout', text: 'started' }],
			hangAfterFrames: true,
		});

		const ac = new AbortController();
		const seen: string[] = [];
		const pending = docker.execStart('exec-hang', {
			signal: ac.signal,
			onChunk: (c) => {
				seen.push(c.text);
				// Abort once the stream is demonstrably live.
				ac.abort();
			},
		});

		await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
		expect(seen).toEqual(['started']);
	});

	it('rejects immediately when the signal is already aborted', async () => {
		sim.onExecStart('exec-pre-aborted', { frames: [{ stream: 'stdout', text: 'never' }] });
		const ac = new AbortController();
		ac.abort();

		await expect(docker.execStart('exec-pre-aborted', { signal: ac.signal })).rejects.toMatchObject(
			{ name: 'AbortError' },
		);
	});
});

describe('containerLogs over node:http', () => {
	it('returns a streaming Response whose body carries the multiplexed log', async () => {
		sim.onContainerLogs('ctr-1', {
			frames: [{ stream: 'stdout', text: 'log line\n' }],
		});

		const res = await docker.containerLogs('ctr-1', { follow: false });

		expect(res).not.toBeNull();
		const raw = new Uint8Array(await res!.arrayBuffer());
		// 8-byte multiplex header then the payload.
		expect(raw[0]).toBe(1);
		expect(new TextDecoder().decode(raw.slice(8))).toBe('log line\n');
	});

	it('returns null for a missing container', async () => {
		const res = await docker.containerLogs('ctr-missing', { follow: false });
		expect(res).toBeNull();
	});
});
