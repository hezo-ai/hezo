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

	it('returns null for non-image bytes', () => {
		expect(readImageDimensions(Buffer.from('not an image'))).toBeNull();
	});
});
