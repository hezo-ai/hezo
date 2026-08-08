import { describe, expect, it } from 'vitest';
import { tarSingleFile, untarFirstFile } from '../src/services/sandbox/tar';

/**
 * The tar codec behind Docker's file transport.
 *
 * Docker's only bulk file endpoints speak tar, and a malformed header is the
 * classic way to produce an archive the daemon rejects as corrupt with a message
 * that names nothing useful. The checksum in particular has to be computed with
 * its own field read as spaces and then written back into it - getting that
 * wrong yields an archive every tool refuses.
 */
describe('tarSingleFile', () => {
	it('round-trips a file through its own reader', () => {
		const contents = new TextEncoder().encode('hello-from-hezo\n');
		const entry = untarFirstFile(tarSingleFile('prompt.txt', contents));
		expect(entry?.name).toBe('prompt.txt');
		expect(new TextDecoder().decode(entry?.contents)).toBe('hello-from-hezo\n');
	});

	it('writes a checksum computed over the header with its own field blanked', () => {
		// The rule every tar reader validates against. Recomputing it here rather
		// than pinning a magic number means a change to any other header field is
		// caught too.
		const archive = tarSingleFile('x', new Uint8Array([1, 2, 3]));
		const header = archive.subarray(0, 512);
		const stored = Number.parseInt(
			new TextDecoder().decode(header.subarray(148, 156)).replace(/\0.*$/, '').trim(),
			8,
		);
		const recomputed = header.reduce(
			(sum, byte, i) => sum + (i >= 148 && i < 156 ? 0x20 : byte),
			0,
		);
		expect(stored).toBe(recomputed);
	});

	it('pads content to a 512-byte boundary and ends with two zero blocks', () => {
		// 3 bytes of content still occupies a whole block, and the two trailing
		// zero blocks are what tell a reader the archive ended rather than was
		// truncated.
		const archive = tarSingleFile('x', new Uint8Array([1, 2, 3]));
		expect(archive.length).toBe(512 * 4);
		expect(archive.subarray(512 * 2).every((b) => b === 0)).toBe(true);
	});

	it('carries a payload that spans several blocks intact', () => {
		const big = new Uint8Array(512 * 3 + 7).map((_, i) => i % 251);
		const entry = untarFirstFile(tarSingleFile('big.bin', big));
		expect(entry?.contents.length).toBe(big.length);
		expect(Array.from(entry?.contents ?? [])).toEqual(Array.from(big));
	});

	it('records the requested mode, which is part of the file contract', () => {
		// A credential file staged at 0600 that arrived 0644 would be a silent
		// widening, so the mode is asserted in the header rather than trusted.
		const header = tarSingleFile('cred', new Uint8Array([0]), 0o600).subarray(0, 512);
		const mode = new TextDecoder().decode(header.subarray(100, 108)).replace(/\0.*$/, '').trim();
		expect(Number.parseInt(mode, 8)).toBe(0o600);
	});

	it('refuses a name too long for the header rather than truncating it', () => {
		// Truncation would write the file to the wrong path, which is worse than
		// failing: nothing downstream would notice.
		expect(() => tarSingleFile('a'.repeat(101), new Uint8Array())).toThrow(/exceeds/);
	});

	it('is deterministic, so identical content produces identical bytes', () => {
		const a = tarSingleFile('x', new TextEncoder().encode('same'));
		const b = tarSingleFile('x', new TextEncoder().encode('same'));
		expect(Array.from(a)).toEqual(Array.from(b));
	});
});

describe('untarFirstFile', () => {
	it('returns null for an empty archive', () => {
		expect(untarFirstFile(new Uint8Array(1024))).toBeNull();
	});

	it('returns null rather than mis-reading a directory entry as content', () => {
		const archive = tarSingleFile('dir', new Uint8Array());
		archive[156] = 0x35; // typeflag '5' = directory
		expect(untarFirstFile(archive)).toBeNull();
	});
});
