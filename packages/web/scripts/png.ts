/**
 * Minimal PNG reader, plus the inspections the icon pipeline needs.
 *
 * Shared by `generate-icons.ts` (which verifies each bitmap before writing it)
 * and `test/pwa-icons.test.ts` (which verifies the committed ones), so both
 * enforce the same invariants. Same split as `scripts/coverage/lcov.ts`: pure
 * transforms live beside the script, and the test imports them.
 *
 * No image library is installed and none is added for this - `node:zlib` covers
 * the only hard part (inflating IDAT). Roughly 90 lines against a dependency
 * that would pull a platform-specific native binary into a repo that
 * cross-compiles six targets.
 *
 * Scoped to what Chromium's screenshot encoder emits: 8-bit non-interlaced, in
 * either RGB (colour type 2) or RGBA (colour type 6) - it drops the alpha channel
 * whenever a render turns out fully opaque, which the full-bleed variants are.
 * Both decode to RGBA here so callers see one shape. Anything else throws rather
 * than being silently mis-decoded.
 *
 * `packages/server/src/lib/image-dimensions.ts` reads PNG headers too, but it is
 * deliberately header-only for the icon-upload size cap and is left alone.
 */

import { inflateSync } from 'node:zlib';

const SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

export interface DecodedPng {
	width: number;
	height: number;
	/** Row-major RGBA, 4 bytes per pixel. */
	rgba: Buffer;
}

export function decodePng(buf: Buffer | Uint8Array): DecodedPng {
	const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
	if (!b.subarray(0, 8).equals(SIGNATURE)) throw new Error('not a PNG');

	const width = b.readUInt32BE(16);
	const height = b.readUInt32BE(20);
	const bitDepth = b[24];
	const colorType = b[25];
	const interlace = b[28];
	if (bitDepth !== 8 || (colorType !== 6 && colorType !== 2) || interlace !== 0) {
		throw new Error(
			`unsupported PNG (depth ${bitDepth}, colour type ${colorType}, interlace ${interlace}); expected 8-bit RGB or RGBA, non-interlaced`,
		);
	}
	const channels = colorType === 6 ? 4 : 3;

	const idat: Buffer[] = [];
	let off = 8;
	while (off < b.length) {
		const len = b.readUInt32BE(off);
		const type = b.toString('ascii', off + 4, off + 8);
		if (type === 'IDAT') idat.push(b.subarray(off + 8, off + 8 + len));
		if (type === 'IEND') break;
		off += 12 + len;
	}
	if (idat.length === 0) throw new Error('PNG has no IDAT chunk');

	const raw = inflateSync(Buffer.concat(idat));
	const bpp = channels;
	const stride = width * bpp;
	// Un-filter in the source channel count, then widen to RGBA below.
	const planar = Buffer.alloc(height * stride);

	let p = 0;
	for (let y = 0; y < height; y++) {
		const filter = raw[p++];
		const row = raw.subarray(p, p + stride);
		p += stride;
		const cur = planar.subarray(y * stride, (y + 1) * stride);
		const prev = y > 0 ? planar.subarray((y - 1) * stride, y * stride) : null;
		for (let x = 0; x < stride; x++) {
			const a = x >= bpp ? cur[x - bpp] : 0;
			const up = prev ? prev[x] : 0;
			const ul = prev && x >= bpp ? prev[x - bpp] : 0;
			let v = row[x];
			switch (filter) {
				case 0:
					break;
				case 1:
					v += a;
					break;
				case 2:
					v += up;
					break;
				case 3:
					v += (a + up) >> 1;
					break;
				case 4: {
					const est = a + up - ul;
					const da = Math.abs(est - a);
					const db = Math.abs(est - up);
					const dc = Math.abs(est - ul);
					v += da <= db && da <= dc ? a : db <= dc ? up : ul;
					break;
				}
				default:
					throw new Error(`unknown PNG filter type ${filter} on row ${y}`);
			}
			cur[x] = v & 0xff;
		}
	}

	if (channels === 4) return { width, height, rgba: planar };

	const rgba = Buffer.alloc(width * height * 4);
	for (let i = 0, o = 0; i < planar.length; i += 3, o += 4) {
		rgba[o] = planar[i];
		rgba[o + 1] = planar[i + 1];
		rgba[o + 2] = planar[i + 2];
		rgba[o + 3] = 255;
	}
	return { width, height, rgba };
}

export type Rgba = [number, number, number, number];

export function pixelAt(img: DecodedPng, x: number, y: number): Rgba {
	const i = (y * img.width + x) * 4;
	return [img.rgba[i], img.rgba[i + 1], img.rgba[i + 2], img.rgba[i + 3]];
}

/** Bounding box of every pixel with any alpha. A truncated render fails to reach the edges. */
export function opaqueBounds(img: DecodedPng): { x0: number; y0: number; x1: number; y1: number } {
	let x0 = img.width;
	let y0 = img.height;
	let x1 = -1;
	let y1 = -1;
	for (let y = 0; y < img.height; y++) {
		for (let x = 0; x < img.width; x++) {
			if (img.rgba[(y * img.width + x) * 4 + 3] > 0) {
				if (x < x0) x0 = x;
				if (y < y0) y0 = y;
				if (x > x1) x1 = x;
				if (y > y1) y1 = y;
			}
		}
	}
	return { x0, y0, x1, y1 };
}

export function minAlpha(img: DecodedPng): number {
	let m = 255;
	for (let i = 3; i < img.rgba.length; i += 4) if (img.rgba[i] < m) m = img.rgba[i];
	return m;
}

export function corners(img: DecodedPng): { tl: Rgba; tr: Rgba; bl: Rgba; br: Rgba } {
	const w = img.width - 1;
	const h = img.height - 1;
	return {
		tl: pixelAt(img, 0, 0),
		tr: pixelAt(img, w, 0),
		bl: pixelAt(img, 0, h),
		br: pixelAt(img, w, h),
	};
}

/**
 * Furthest distance from centre of any white mark pixel, as a fraction of the canvas.
 *
 * The mark is white and the plate is brand red (G = 0x3B = 59), so a high green
 * channel isolates the mark without needing to know the exact anti-aliased edge
 * colours. Compared against Android's 0.4 safe-circle budget.
 */
export function markReach(img: DecodedPng, greenThreshold = 128): number {
	const c = (img.width - 1) / 2;
	let max = 0;
	for (let y = 0; y < img.height; y++) {
		for (let x = 0; x < img.width; x++) {
			const i = (y * img.width + x) * 4;
			if (img.rgba[i + 3] > 8 && img.rgba[i + 1] > greenThreshold) {
				const d = Math.hypot(x - c, y - c);
				if (d > max) max = d;
			}
		}
	}
	return max / img.width;
}

/** Fraction of the canvas carrying any alpha. Guards against an all-transparent emit. */
export function opaqueCoverage(img: DecodedPng): number {
	let n = 0;
	for (let i = 3; i < img.rgba.length; i += 4) if (img.rgba[i] > 8) n++;
	return n / (img.width * img.height);
}
