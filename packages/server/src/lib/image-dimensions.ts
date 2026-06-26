/**
 * Read the pixel dimensions of a raster image from its header bytes — no image
 * library. Used to defensively enforce the project-icon size cap server-side
 * (the client already downscales, but the server must not trust the client).
 *
 * Supports the formats the client can emit after normalization: PNG, JPEG,
 * GIF, and WebP (VP8/VP8L/VP8X). Returns `null` when the bytes aren't a
 * recognized/parseable image of those types.
 */
export interface ImageDimensions {
	width: number;
	height: number;
}

export function readImageDimensions(buf: Buffer): ImageDimensions | null {
	return readPng(buf) ?? readGif(buf) ?? readWebp(buf) ?? readJpeg(buf);
}

function readPng(buf: Buffer): ImageDimensions | null {
	// 8-byte signature, then an IHDR chunk whose data starts at offset 16:
	// width (4 bytes BE) and height (4 bytes BE).
	if (buf.length < 24) return null;
	const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
	for (let i = 0; i < sig.length; i++) {
		if (buf[i] !== sig[i]) return null;
	}
	if (buf.toString('ascii', 12, 16) !== 'IHDR') return null;
	return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

function readGif(buf: Buffer): ImageDimensions | null {
	// "GIF87a"/"GIF89a", then logical screen width/height as LE uint16.
	if (buf.length < 10) return null;
	const header = buf.toString('ascii', 0, 6);
	if (header !== 'GIF87a' && header !== 'GIF89a') return null;
	return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
}

function readWebp(buf: Buffer): ImageDimensions | null {
	// RIFF container: "RIFF" .... "WEBP" then a VP8/VP8L/VP8X chunk.
	if (buf.length < 30) return null;
	if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WEBP') {
		return null;
	}
	const format = buf.toString('ascii', 12, 16);
	if (format === 'VP8 ') {
		// Lossy: dimensions live after the 3-byte start code at offset 23/25.
		return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
	}
	if (format === 'VP8L') {
		// Lossless: 14-bit width/height packed after a 1-byte signature at 21.
		const bits = buf.readUInt32LE(21);
		return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
	}
	if (format === 'VP8X') {
		// Extended: 24-bit (width-1)/(height-1) at offsets 24 and 27.
		const width = 1 + (buf[24] | (buf[25] << 8) | (buf[26] << 16));
		const height = 1 + (buf[27] | (buf[28] << 8) | (buf[29] << 16));
		return { width, height };
	}
	return null;
}

function readJpeg(buf: Buffer): ImageDimensions | null {
	// SOI marker, then a sequence of marker segments; the SOFn frame header
	// carries height/width as BE uint16 at segment offsets 5 and 7.
	if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
	let offset = 2;
	while (offset + 9 < buf.length) {
		if (buf[offset] !== 0xff) {
			offset++;
			continue;
		}
		const marker = buf[offset + 1];
		// SOF0..SOF15 (excluding DHT=0xc4, DAC=0xcc, RSTn) carry the frame size.
		const isSof =
			marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
		if (isSof) {
			return { width: buf.readUInt16BE(offset + 7), height: buf.readUInt16BE(offset + 5) };
		}
		// Skip this segment using its length field (BE uint16, includes itself).
		const segLen = buf.readUInt16BE(offset + 2);
		if (segLen < 2) return null;
		offset += 2 + segLen;
	}
	return null;
}
