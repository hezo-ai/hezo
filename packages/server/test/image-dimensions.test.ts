import { describe, expect, it } from 'vitest';
import { readImageDimensions } from '../src/lib/image-dimensions';

function png(width: number, height: number): Buffer {
	const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
	const ihdr = Buffer.alloc(25);
	ihdr.writeUInt32BE(13, 0);
	ihdr.write('IHDR', 4, 'ascii');
	ihdr.writeUInt32BE(width, 8);
	ihdr.writeUInt32BE(height, 12);
	return Buffer.concat([sig, ihdr]);
}

function gif(width: number, height: number): Buffer {
	const buf = Buffer.alloc(10);
	buf.write('GIF89a', 0, 'ascii');
	buf.writeUInt16LE(width, 6);
	buf.writeUInt16LE(height, 8);
	return buf;
}

function jpeg(width: number, height: number): Buffer {
	// SOI + an SOF0 segment carrying height/width.
	const soi = Buffer.from([0xff, 0xd8]);
	const sof = Buffer.alloc(11);
	sof[0] = 0xff;
	sof[1] = 0xc0; // SOF0
	sof.writeUInt16BE(11 - 2, 2); // segment length
	sof[4] = 8; // precision
	sof.writeUInt16BE(height, 5);
	sof.writeUInt16BE(width, 7);
	return Buffer.concat([soi, sof]);
}

function webpHeader(format: string): Buffer {
	const buf = Buffer.alloc(30);
	buf.write('RIFF', 0, 'ascii');
	buf.write('WEBP', 8, 'ascii');
	buf.write(format, 12, 'ascii');
	return buf;
}

function webpVp8(width: number, height: number): Buffer {
	const buf = webpHeader('VP8 ');
	buf.writeUInt16LE(width & 0x3fff, 26);
	buf.writeUInt16LE(height & 0x3fff, 28);
	return buf;
}

function webpVp8l(width: number, height: number): Buffer {
	const buf = webpHeader('VP8L');
	// 14-bit (width-1) then 14-bit (height-1) packed little-endian at offset 21.
	const bits = (width - 1) | ((height - 1) << 14);
	buf.writeUInt32LE(bits >>> 0, 21);
	return buf;
}

function webpVp8x(width: number, height: number): Buffer {
	const buf = webpHeader('VP8X');
	const w = width - 1;
	const h = height - 1;
	buf[24] = w & 0xff;
	buf[25] = (w >> 8) & 0xff;
	buf[26] = (w >> 16) & 0xff;
	buf[27] = h & 0xff;
	buf[28] = (h >> 8) & 0xff;
	buf[29] = (h >> 16) & 0xff;
	return buf;
}

describe('readImageDimensions', () => {
	it('reads PNG dimensions', () => {
		expect(readImageDimensions(png(512, 256))).toEqual({ width: 512, height: 256 });
	});

	it('reads GIF dimensions', () => {
		expect(readImageDimensions(gif(48, 64))).toEqual({ width: 48, height: 64 });
	});

	it('reads JPEG dimensions', () => {
		expect(readImageDimensions(jpeg(100, 200))).toEqual({ width: 100, height: 200 });
	});

	it('reads lossy WebP (VP8) dimensions', () => {
		expect(readImageDimensions(webpVp8(120, 90))).toEqual({ width: 120, height: 90 });
	});

	it('reads lossless WebP (VP8L) dimensions', () => {
		expect(readImageDimensions(webpVp8l(300, 200))).toEqual({ width: 300, height: 200 });
	});

	it('reads extended WebP (VP8X) dimensions', () => {
		expect(readImageDimensions(webpVp8x(1024, 768))).toEqual({ width: 1024, height: 768 });
	});

	it('skips a JPEG APP0 segment before reaching the SOF frame', () => {
		const soi = Buffer.from([0xff, 0xd8]);
		const app0 = Buffer.alloc(6);
		app0[0] = 0xff;
		app0[1] = 0xe0; // APP0
		app0.writeUInt16BE(4, 2); // segment length covering itself + 2 payload bytes
		const sof = Buffer.alloc(11);
		sof[0] = 0xff;
		sof[1] = 0xc2; // SOF2 (progressive) — still a frame header
		sof.writeUInt16BE(9, 2);
		sof.writeUInt16BE(64, 5); // height
		sof.writeUInt16BE(128, 7); // width
		expect(readImageDimensions(Buffer.concat([soi, app0, sof]))).toEqual({
			width: 128,
			height: 64,
		});
	});

	it('returns null for non-image bytes', () => {
		expect(readImageDimensions(Buffer.from('not an image'))).toBeNull();
	});

	it('returns null for buffers too short to parse', () => {
		expect(readImageDimensions(Buffer.alloc(0))).toBeNull();
		expect(readImageDimensions(Buffer.from([0x89, 0x50]))).toBeNull();
	});

	it('returns null for a RIFF container that is not WEBP', () => {
		const buf = Buffer.alloc(30);
		buf.write('RIFF', 0, 'ascii');
		buf.write('AVI ', 8, 'ascii');
		expect(readImageDimensions(buf)).toBeNull();
	});

	it('returns null for a WebP with an unrecognized chunk format', () => {
		expect(readImageDimensions(webpHeader('XXXX'))).toBeNull();
	});

	it('returns null for a JPEG with a malformed (too-small) segment length', () => {
		const soi = Buffer.from([0xff, 0xd8]);
		const bad = Buffer.alloc(12);
		bad[0] = 0xff;
		bad[1] = 0xe0; // APP0
		bad.writeUInt16BE(1, 2); // segLen < 2 → bail
		expect(readImageDimensions(Buffer.concat([soi, bad]))).toBeNull();
	});
});
