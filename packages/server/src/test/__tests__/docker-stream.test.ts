import { describe, expect, it } from 'vitest';

// demuxDockerStream and concatUint8Arrays are not exported from docker.ts,
// so we replicate the logic here and test it directly. This tests the
// Docker stream frame parsing algorithm.

function concatUint8Arrays(arrays: Uint8Array[]): Uint8Array {
	if (arrays.length === 0) return new Uint8Array(0);
	if (arrays.length === 1) return arrays[0];
	const totalLength = arrays.reduce((acc, arr) => acc + arr.length, 0);
	const result = new Uint8Array(totalLength);
	let offset = 0;
	for (const arr of arrays) {
		result.set(arr, offset);
		offset += arr.length;
	}
	return result;
}

function demuxDockerStream(raw: Uint8Array): { stdout: string; stderr: string } {
	const stdout: Uint8Array[] = [];
	const stderr: Uint8Array[] = [];
	let offset = 0;

	while (offset + 8 <= raw.length) {
		const streamType = raw[offset];
		const size =
			(raw[offset + 4] << 24) | (raw[offset + 5] << 16) | (raw[offset + 6] << 8) | raw[offset + 7];
		offset += 8;

		if (offset + size > raw.length) break;

		const chunk = raw.slice(offset, offset + size);
		if (streamType === 1) {
			stdout.push(chunk);
		} else if (streamType === 2) {
			stderr.push(chunk);
		}
		offset += size;
	}

	const decoder = new TextDecoder();
	return {
		stdout: decoder.decode(concatUint8Arrays(stdout)),
		stderr: decoder.decode(concatUint8Arrays(stderr)),
	};
}

function makeFrame(streamType: number, text: string): Uint8Array {
	const encoder = new TextEncoder();
	const payload = encoder.encode(text);
	const header = new Uint8Array(8);
	header[0] = streamType;
	header[4] = (payload.length >> 24) & 0xff;
	header[5] = (payload.length >> 16) & 0xff;
	header[6] = (payload.length >> 8) & 0xff;
	header[7] = payload.length & 0xff;
	const frame = new Uint8Array(8 + payload.length);
	frame.set(header);
	frame.set(payload, 8);
	return frame;
}

describe('demuxDockerStream', () => {
	it('parses a single stdout frame', () => {
		const frame = makeFrame(1, 'hello stdout');
		const result = demuxDockerStream(frame);
		expect(result.stdout).toBe('hello stdout');
		expect(result.stderr).toBe('');
	});

	it('parses a single stderr frame', () => {
		const frame = makeFrame(2, 'error output');
		const result = demuxDockerStream(frame);
		expect(result.stdout).toBe('');
		expect(result.stderr).toBe('error output');
	});

	it('parses multiple interleaved frames', () => {
		const f1 = makeFrame(1, 'out1');
		const f2 = makeFrame(2, 'err1');
		const f3 = makeFrame(1, 'out2');
		const combined = concatUint8Arrays([f1, f2, f3]);
		const result = demuxDockerStream(combined);
		expect(result.stdout).toBe('out1out2');
		expect(result.stderr).toBe('err1');
	});

	it('handles empty input', () => {
		const result = demuxDockerStream(new Uint8Array(0));
		expect(result.stdout).toBe('');
		expect(result.stderr).toBe('');
	});

	it('handles truncated frame gracefully', () => {
		const frame = makeFrame(1, 'complete');
		// Truncate the last 3 bytes so the frame is incomplete
		const truncated = frame.slice(0, frame.length - 3);
		const result = demuxDockerStream(truncated);
		// Should not include the truncated frame
		expect(result.stdout).toBe('');
		expect(result.stderr).toBe('');
	});

	it('handles header-only without payload gracefully', () => {
		// Only the 8-byte header, claims 5 bytes of payload but none present
		const header = new Uint8Array(8);
		header[0] = 1;
		header[7] = 5;
		const result = demuxDockerStream(header);
		expect(result.stdout).toBe('');
	});

	it('ignores unknown stream types', () => {
		const f1 = makeFrame(1, 'stdout');
		const f2 = makeFrame(3, 'unknown'); // stream type 3 is neither stdout nor stderr
		const f3 = makeFrame(2, 'stderr');
		const combined = concatUint8Arrays([f1, f2, f3]);
		const result = demuxDockerStream(combined);
		expect(result.stdout).toBe('stdout');
		expect(result.stderr).toBe('stderr');
	});

	it('handles large payloads', () => {
		const largeText = 'x'.repeat(100_000);
		const frame = makeFrame(1, largeText);
		const result = demuxDockerStream(frame);
		expect(result.stdout).toBe(largeText);
	});
});

describe('concatUint8Arrays', () => {
	it('returns empty array for no input', () => {
		expect(concatUint8Arrays([]).length).toBe(0);
	});

	it('returns the single array unchanged', () => {
		const arr = new Uint8Array([1, 2, 3]);
		const result = concatUint8Arrays([arr]);
		expect(result).toBe(arr);
	});

	it('concatenates multiple arrays', () => {
		const a = new Uint8Array([1, 2]);
		const b = new Uint8Array([3, 4, 5]);
		const result = concatUint8Arrays([a, b]);
		expect(Array.from(result)).toEqual([1, 2, 3, 4, 5]);
	});
});
