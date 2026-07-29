import { describe, expect, it } from 'vitest';
import {
	DockerFrameDecoder,
	type DockerStream,
	demuxDockerStream,
} from '../src/services/docker-frames';

/** Build one Docker multiplexed frame: type byte, 3 reserved, 4-byte BE length. */
function frame(stream: DockerStream, payload: Uint8Array | string): Uint8Array {
	const body = typeof payload === 'string' ? new TextEncoder().encode(payload) : payload;
	const out = new Uint8Array(8 + body.length);
	out[0] = stream === 'stderr' ? 2 : 1;
	out[4] = (body.length >>> 24) & 0xff;
	out[5] = (body.length >>> 16) & 0xff;
	out[6] = (body.length >>> 8) & 0xff;
	out[7] = body.length & 0xff;
	out.set(body, 8);
	return out;
}

function concat(...parts: Uint8Array[]): Uint8Array {
	const total = parts.reduce((n, p) => n + p.length, 0);
	const out = new Uint8Array(total);
	let at = 0;
	for (const p of parts) {
		out.set(p, at);
		at += p.length;
	}
	return out;
}

function drain(decoder: DockerFrameDecoder): Array<{ stream: DockerStream; text: string }> {
	const out: Array<{ stream: DockerStream; text: string }> = [];
	for (let f = decoder.next(); f !== null; f = decoder.next()) out.push(f);
	return out;
}

describe('DockerFrameDecoder', () => {
	it('decodes whole frames and tags each stream', () => {
		const decoder = new DockerFrameDecoder();
		decoder.push(
			concat(frame('stdout', 'hello '), frame('stderr', 'oops'), frame('stdout', 'world')),
		);
		expect(drain(decoder)).toEqual([
			{ stream: 'stdout', text: 'hello ' },
			{ stream: 'stderr', text: 'oops' },
			{ stream: 'stdout', text: 'world' },
		]);
	});

	it('holds back a partial frame until the rest arrives', () => {
		const decoder = new DockerFrameDecoder();
		const whole = frame('stdout', 'split payload');
		decoder.push(whole.subarray(0, 5));
		expect(drain(decoder)).toEqual([]);
		decoder.push(whole.subarray(5, 12));
		expect(drain(decoder)).toEqual([]);
		decoder.push(whole.subarray(12));
		expect(drain(decoder)).toEqual([{ stream: 'stdout', text: 'split payload' }]);
	});

	// The reason the decoder exists: byte-at-a-time delivery must not be
	// quadratic, and must not lose or duplicate a byte.
	it('reassembles correctly when fed one byte at a time', () => {
		const decoder = new DockerFrameDecoder();
		const raw = concat(frame('stdout', 'abc'), frame('stderr', 'de'), frame('stdout', 'fghij'));
		const seen: Array<{ stream: DockerStream; text: string }> = [];
		for (const byte of raw) {
			decoder.push(new Uint8Array([byte]));
			seen.push(...drain(decoder));
		}
		expect(seen).toEqual([
			{ stream: 'stdout', text: 'abc' },
			{ stream: 'stderr', text: 'de' },
			{ stream: 'stdout', text: 'fghij' },
		]);
	});

	// Frame boundaries land mid-codepoint on arbitrary container output. A
	// per-frame decode() would emit replacement characters here.
	it('joins a multi-byte codepoint split across two frames', () => {
		const bytes = new TextEncoder().encode('café ☕');
		const decoder = new DockerFrameDecoder();
		// Cut inside the two-byte 'é' (index 3..4) and again inside the coffee cup.
		decoder.push(concat(frame('stdout', bytes.subarray(0, 4)), frame('stdout', bytes.subarray(4))));
		const text = drain(decoder)
			.map((f) => f.text)
			.join('');
		expect(text).toBe('café ☕');
		expect(text).not.toContain('�');
	});

	it('keeps stdout and stderr decoder state separate', () => {
		const utf8 = new TextEncoder().encode('é');
		const decoder = new DockerFrameDecoder();
		decoder.push(
			concat(
				frame('stdout', utf8.subarray(0, 1)),
				frame('stderr', 'plain'),
				frame('stdout', utf8.subarray(1)),
			),
		);
		expect(drain(decoder)).toEqual([
			{ stream: 'stderr', text: 'plain' },
			{ stream: 'stdout', text: 'é' },
		]);
	});

	it('strips NUL bytes, which Postgres text columns reject', () => {
		const decoder = new DockerFrameDecoder();
		decoder.push(frame('stdout', new Uint8Array([0x61, 0x00, 0x62])));
		expect(drain(decoder)).toEqual([{ stream: 'stdout', text: 'ab' }]);
	});

	it('handles a frame larger than the initial buffer capacity', () => {
		const big = 'z'.repeat(300_000);
		const decoder = new DockerFrameDecoder();
		const raw = frame('stdout', big);
		// Deliver in 64KB slices, as a socket would.
		for (let at = 0; at < raw.length; at += 65_536) {
			decoder.push(raw.subarray(at, at + 65_536));
		}
		const frames = drain(decoder);
		expect(frames.length).toBe(1);
		expect(frames[0].text).toBe(big);
	});

	it('skips frames that decode to nothing rather than emitting empty ones', () => {
		const utf8 = new TextEncoder().encode('é');
		const decoder = new DockerFrameDecoder();
		decoder.push(
			concat(
				// Leading byte of a two-byte codepoint: consumed and held, no content yet.
				frame('stdout', utf8.subarray(0, 1)),
				// A zero-length frame, which Docker does emit.
				frame('stdout', new Uint8Array(0)),
				frame('stdout', utf8.subarray(1)),
				frame('stdout', 'after'),
			),
		);
		expect(drain(decoder)).toEqual([
			{ stream: 'stdout', text: 'é' },
			{ stream: 'stdout', text: 'after' },
		]);
	});

	it('flush surfaces a trailing partial codepoint instead of dropping it', () => {
		const decoder = new DockerFrameDecoder();
		decoder.push(frame('stdout', new TextEncoder().encode('é').subarray(0, 1)));
		expect(drain(decoder)).toEqual([]);
		const flushed = decoder.flush();
		expect(flushed.length).toBe(1);
		expect(flushed[0].stream).toBe('stdout');
	});
});

describe('demuxDockerStream', () => {
	it('splits a fully-buffered stream into its two sides', () => {
		const raw = concat(
			frame('stdout', 'out1\n'),
			frame('stderr', 'err1\n'),
			frame('stdout', 'out2\n'),
		);
		expect(demuxDockerStream(raw)).toEqual({ stdout: 'out1\nout2\n', stderr: 'err1\n' });
	});

	it('ignores a truncated trailing frame', () => {
		const whole = frame('stdout', 'complete');
		const partial = frame('stdout', 'truncated').subarray(0, 10);
		expect(demuxDockerStream(concat(whole, partial))).toEqual({ stdout: 'complete', stderr: '' });
	});

	it('returns empty output for an empty stream', () => {
		expect(demuxDockerStream(new Uint8Array(0))).toEqual({ stdout: '', stderr: '' });
	});
});
