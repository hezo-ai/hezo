import { describe, expect, it } from 'vitest';
import { DockerBinaryFrameDecoder } from '../src/services/sandbox/tunnel/docker-frames-binary';

/** Docker's `[stream u8][0][0][0][len u32be][payload]`. */
function frame(stream: 1 | 2, payload: Uint8Array): Uint8Array {
	const out = new Uint8Array(8 + payload.byteLength);
	out[0] = stream;
	new DataView(out.buffer).setUint32(4, payload.byteLength, false);
	out.set(payload, 8);
	return out;
}

const text = (s: string) => new TextEncoder().encode(s);
const decode = (p: Uint8Array) => new TextDecoder().decode(p);

/**
 * This decoder exists because the run-log one decodes to *text*. A tunnel
 * carries arbitrary binary, and a TextDecoder replaces every invalid sequence
 * with U+FFFD - silently corrupting the payload rather than failing.
 */
describe('DockerBinaryFrameDecoder', () => {
	it('separates stdout from stderr', () => {
		const decoder = new DockerBinaryFrameDecoder();
		const frames = decoder.push(
			new Uint8Array([...frame(1, text('out')), ...frame(2, text('err'))]),
		);
		expect(frames.map((f) => [f.stream, decode(f.payload)])).toEqual([
			['stdout', 'out'],
			['stderr', 'err'],
		]);
	});

	it('carries bytes that are not valid UTF-8 through untouched', () => {
		// The reason this decoder is not the text one: 0xff is invalid UTF-8, and
		// a TextDecoder would turn it into U+FFFD without complaining.
		const binary = new Uint8Array([0x00, 0xff, 0xfe, 0x80, 0x7f]);
		const [decoded] = new DockerBinaryFrameDecoder().push(frame(1, binary));
		expect([...decoded.payload]).toEqual([...binary]);
	});

	it('reassembles a frame split byte by byte', () => {
		const wire = frame(1, text('across chunks'));
		const decoder = new DockerBinaryFrameDecoder();
		const out = [];
		for (const byte of wire) out.push(...decoder.push(new Uint8Array([byte])));
		expect(out).toHaveLength(1);
		expect(decode(out[0].payload)).toBe('across chunks');
		expect(decoder.pending).toBe(0);
	});

	it('holds a partial frame rather than yielding it', () => {
		const wire = frame(1, text('incomplete'));
		const decoder = new DockerBinaryFrameDecoder();
		expect(decoder.push(wire.slice(0, wire.byteLength - 2))).toEqual([]);
		expect(decoder.pending).toBeGreaterThan(0);
		expect(decoder.push(wire.slice(-2))).toHaveLength(1);
	});

	it('yields payloads that do not alias the internal buffer', () => {
		const decoder = new DockerBinaryFrameDecoder();
		const [first] = decoder.push(frame(1, text('AAAA')));
		decoder.push(frame(1, text('BBBB')));
		expect(decode(first.payload)).toBe('AAAA');
	});

	it('handles a payload larger than 2^15, where a signed read would go wrong', () => {
		const big = new Uint8Array(70_000).fill(7);
		const [decoded] = new DockerBinaryFrameDecoder().push(frame(1, big));
		expect(decoded.payload.byteLength).toBe(70_000);
	});

	it('handles an empty frame', () => {
		const [decoded] = new DockerBinaryFrameDecoder().push(frame(1, new Uint8Array(0)));
		expect(decoded.payload.byteLength).toBe(0);
	});
});
