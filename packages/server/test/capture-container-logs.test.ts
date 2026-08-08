import { describe, expect, it } from 'vitest';
import { captureContainerLogs } from '../src/services/containers';
import type { ContainerEngine } from '../src/services/sandbox/types';
import { blobBytes } from './helpers';

const NUL = String.fromCharCode(0);

// Wrap a payload in a single Docker multiplexed-stream frame: a 1-byte stream
// type, three padding bytes, and a big-endian 4-byte length, followed by the
// payload. This mirrors the framing `captureContainerLogs` demultiplexes.
function frame(streamType: 1 | 2, payload: Uint8Array): Uint8Array {
	const out = new Uint8Array(8 + payload.length);
	out[0] = streamType;
	out[4] = (payload.length >>> 24) & 0xff;
	out[5] = (payload.length >>> 16) & 0xff;
	out[6] = (payload.length >>> 8) & 0xff;
	out[7] = payload.length & 0xff;
	out.set(payload, 8);
	return out;
}

function dockerReturning(bytes: Uint8Array): ContainerEngine {
	return {
		containerLogs: async () => new Response(blobBytes(bytes)),
	} as unknown as ContainerEngine;
}

describe('captureContainerLogs NUL handling', () => {
	it('strips NUL bytes so the tail can be persisted to a Postgres text column', async () => {
		// Container output carrying a raw 0x00 (binary noise) — Postgres would reject
		// this on the container_last_logs write if it survived the decode.
		const payload = new TextEncoder().encode(`hello${NUL}world`);
		const docker = dockerReturning(frame(1, payload));

		const result = await captureContainerLogs(docker, 'ctr-1', 'proj');

		expect(result).toBe('helloworld');
		expect(result?.includes(NUL)).toBe(false);
	});

	it('leaves NUL-free output untouched across stdout and stderr frames', async () => {
		const stdout = frame(1, new TextEncoder().encode('out line\n'));
		const stderr = frame(2, new TextEncoder().encode('err line\n'));
		const combined = new Uint8Array(stdout.length + stderr.length);
		combined.set(stdout, 0);
		combined.set(stderr, stdout.length);

		const result = await captureContainerLogs(dockerReturning(combined), 'ctr-2');

		expect(result).toBe('out line\nerr line\n');
	});
});
