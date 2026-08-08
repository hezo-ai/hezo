import { describe, expect, it } from 'vitest';
import {
	decodeWindowCredit,
	encodeFrame,
	encodeOpen,
	encodeWindow,
	FrameDecoder,
	FrameType,
	HEADER_BYTES,
	isTunnelTarget,
	MAX_PAYLOAD_BYTES,
	TUNNEL_PREAMBLE,
} from '../src/services/sandbox/tunnel/protocol';

const bytes = (...v: number[]) => new Uint8Array(v);
const text = (s: string) => new TextEncoder().encode(s);
const decode = (p: Uint8Array) => new TextDecoder().decode(p);

describe('frame encoding', () => {
	it('lays out the header as [u8 type][u32 streamId][u32 len] big-endian', () => {
		const frame = encodeFrame(FrameType.Data, 0x01020304, bytes(0xaa, 0xbb));
		expect([...frame.slice(0, HEADER_BYTES)]).toEqual([2, 1, 2, 3, 4, 0, 0, 0, 2]);
		expect([...frame.slice(HEADER_BYTES)]).toEqual([0xaa, 0xbb]);
	});

	it('refuses a payload past the cap', () => {
		// A single enormous write would monopolise the shared channel.
		expect(() => encodeFrame(FrameType.Data, 1, new Uint8Array(MAX_PAYLOAD_BYTES + 1))).toThrow(
			/exceeds/,
		);
	});

	it('round-trips a window credit', () => {
		expect(decodeWindowCredit(encodeWindow(7, 65_536).slice(HEADER_BYTES))).toBe(65_536);
	});

	it('rejects a window payload that is not exactly 4 bytes', () => {
		expect(() => decodeWindowCredit(bytes(1, 2, 3))).toThrow(/4 bytes/);
	});
});

/**
 * An OPEN frame names a target *key*, never a host and port. There is no public
 * endpoint to attack either way, but this is what stops a compromised agent
 * using the tunnel to reach the operator's LAN.
 */
describe('tunnel targets', () => {
	it('accepts only the three known keys', () => {
		for (const ok of ['proxy', 'mcp', 'ssh']) expect(isTunnelTarget(ok)).toBe(true);
		for (const no of ['127.0.0.1:22', 'localhost', 'http', '', 'PROXY', '../proxy']) {
			expect(isTunnelTarget(no)).toBe(false);
		}
	});

	it('carries the key as the OPEN payload', () => {
		expect(decode(encodeOpen(3, 'ssh').slice(HEADER_BYTES))).toBe('ssh');
	});
});

describe('FrameDecoder', () => {
	it('decodes a whole frame', () => {
		const [frame] = new FrameDecoder().push(encodeFrame(FrameType.Data, 9, text('hello')));
		expect(frame.type).toBe(FrameType.Data);
		expect(frame.streamId).toBe(9);
		expect(decode(frame.payload)).toBe('hello');
	});

	it('reassembles a frame split across chunks, byte by byte', () => {
		// A byte channel delivers arbitrary chunks; anything assuming chunk
		// boundaries are frame boundaries works in a test and corrupts under load.
		const wire = encodeFrame(FrameType.Data, 1, text('split me up'));
		const decoder = new FrameDecoder();
		const out = [];
		for (const byte of wire) out.push(...decoder.push(bytes(byte)));
		expect(out).toHaveLength(1);
		expect(decode(out[0].payload)).toBe('split me up');
		expect(decoder.pending).toBe(0);
	});

	it('decodes several frames arriving in one chunk', () => {
		const wire = new Uint8Array([
			...encodeOpen(1, 'mcp'),
			...encodeFrame(FrameType.Data, 1, text('a')),
			...encodeFrame(FrameType.Close, 1),
		]);
		const frames = new FrameDecoder().push(wire);
		expect(frames.map((f) => f.type)).toEqual([FrameType.Open, FrameType.Data, FrameType.Close]);
	});

	it('holds a partial frame rather than yielding it', () => {
		const wire = encodeFrame(FrameType.Data, 1, text('incomplete'));
		const decoder = new FrameDecoder();
		expect(decoder.push(wire.slice(0, wire.byteLength - 1))).toEqual([]);
		expect(decoder.pending).toBeGreaterThan(0);
		expect(decoder.push(wire.slice(-1))).toHaveLength(1);
		expect(decoder.pending).toBe(0);
	});

	it('holds a partial header', () => {
		const decoder = new FrameDecoder();
		expect(decoder.push(bytes(FrameType.Data, 0, 0))).toEqual([]);
		expect(decoder.pending).toBe(3);
	});

	it('yields payloads that do not alias the internal buffer', () => {
		// A subarray into the decoder's buffer would be silently overwritten by
		// the next push - a corruption that only appears under load.
		const decoder = new FrameDecoder();
		const [first] = decoder.push(encodeFrame(FrameType.Data, 1, text('AAAA')));
		decoder.push(encodeFrame(FrameType.Data, 2, text('BBBB')));
		expect(decode(first.payload)).toBe('AAAA');
	});

	it('handles an empty payload', () => {
		const [frame] = new FrameDecoder().push(encodeFrame(FrameType.Close, 4));
		expect(frame.payload.byteLength).toBe(0);
	});

	it('carries a full-size payload', () => {
		const big = new Uint8Array(MAX_PAYLOAD_BYTES).fill(0x5a);
		const [frame] = new FrameDecoder().push(encodeFrame(FrameType.Data, 1, big));
		expect(frame.payload.byteLength).toBe(MAX_PAYLOAD_BYTES);
	});

	it('fails loudly on an unknown frame type', () => {
		// The channel is authenticated end to end, so malformed input means the
		// peer is broken or the stream desynchronised. Continuing to parse would
		// produce garbage streams rather than recover.
		expect(() => new FrameDecoder().push(bytes(99, 0, 0, 0, 1, 0, 0, 0, 0))).toThrow(
			/unknown frame type/,
		);
	});

	it('fails loudly on a length past the cap rather than pre-allocating', () => {
		const header = new Uint8Array(HEADER_BYTES);
		const view = new DataView(header.buffer);
		view.setUint8(0, FrameType.Data);
		view.setUint32(1, 1, false);
		view.setUint32(5, 0xffffffff, false);
		expect(() => new FrameDecoder().push(header)).toThrow(/exceeds/);
	});
});

/**
 * Skipping whatever the transport put on the channel before the client spoke.
 *
 * Docker's exec hijack carries the command's stdout and nothing else, but a
 * provider may only offer a PTY - and a PTY is attached to a shell, which echoes
 * what was typed into it and prints a prompt. Measured on Daytona: 97 bytes of
 * `stty raw -echo\r\n\e[?2004l\r\e[?2004hroot@…:/workspace# ` arrive ahead of the
 * first frame, and fed to the decoder they parse as a header - "raw " read as a
 * length field gives 1918990112 - so the tunnel tore itself down before carrying
 * a byte.
 */
describe('preamble sync', () => {
	// The exact prologue measured from the live Daytona PTY.
	const PTY_NOISE = text(
		'stty raw -echo\r\n\u001b[?2004l\r\u001b[?2004hroot@89838e4d:/workspace# \u001b[?2004l\r\n',
	);
	const preamble = () => TUNNEL_PREAMBLE;

	it('discards shell noise ahead of the marker and decodes the frames after it', () => {
		const decoder = new FrameDecoder({ expectPreamble: true });
		const frame = encodeOpen(1, 'mcp');
		const frames = decoder.push(new Uint8Array([...PTY_NOISE, ...preamble(), ...frame]));
		expect(frames).toHaveLength(1);
		expect(decode(frames[0].payload)).toBe('mcp');
	});

	it('waits rather than failing while the marker has not arrived', () => {
		// A PTY delivers its prologue over several reads; a partial one is an
		// ordinary short read, not a desync.
		const decoder = new FrameDecoder({ expectPreamble: true });
		expect(decoder.push(PTY_NOISE)).toEqual([]);
		expect(decoder.isSynced).toBe(false);
		expect(decoder.push(new Uint8Array([...preamble(), ...encodeOpen(3, 'ssh')]))).toHaveLength(1);
		expect(decoder.isSynced).toBe(true);
	});

	it('finds a marker split across two chunks', () => {
		const decoder = new FrameDecoder({ expectPreamble: true });
		const p = preamble();
		const half = Math.floor(p.length / 2);
		decoder.push(new Uint8Array([...PTY_NOISE, ...p.slice(0, half)]));
		const frames = decoder.push(new Uint8Array([...p.slice(half), ...encodeOpen(5, 'proxy')]));
		expect(frames).toHaveLength(1);
		expect(decode(frames[0].payload)).toBe('proxy');
	});

	it('keeps the pre-sync buffer bounded while it scans', () => {
		// A channel that never syncs must not grow a buffer forever. Kept under the
		// scan cap so this measures the trimming rather than the give-up throw.
		const decoder = new FrameDecoder({ expectPreamble: true });
		for (let i = 0; i < 10; i++) decoder.push(new Uint8Array(4096));
		expect(decoder.pending).toBeLessThan(TUNNEL_PREAMBLE.byteLength);
	});

	it('names the likely cause once far too much noise has gone by', () => {
		// Past the cap the client is not coming - an image without `hezo-tunnel`,
		// most likely - and the bytes are that command's error output. An operator
		// needs to be told which, not "unknown frame type".
		const decoder = new FrameDecoder({ expectPreamble: true });
		expect(() => {
			for (let i = 0; i < 40; i++) decoder.push(new Uint8Array(4096).fill(0x41));
		}).toThrow(/never announced itself/);
	});

	it('does not expect a preamble unless asked, so the round trip stays testable', () => {
		const decoder = new FrameDecoder();
		expect(decoder.isSynced).toBe(true);
		expect(decoder.push(encodeOpen(1, 'mcp'))).toHaveLength(1);
	});
});
