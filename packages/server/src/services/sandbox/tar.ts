/**
 * A single-file tar writer and reader.
 *
 * Docker's only bulk file transport is `PUT`/`GET /containers/{id}/archive`,
 * which speaks tar. That is the transport `SandboxFiles` uses on Docker rather
 * than reaching for the bind mount, because a host-filesystem fast path is one
 * that works everywhere except the cases the seam exists for - a daemon over
 * TCP, a rootless daemon in its own namespace, a managed backend.
 *
 * Deliberately not a tar library. Hezo writes and reads exactly one regular file
 * per call, and the format for that case is small enough to own outright: a
 * 512-byte header, the content padded to a 512-byte boundary, and two zero
 * blocks to end the archive. Owning it keeps a dependency out of the
 * single-binary build and keeps the failure modes ours.
 */

const BLOCK = 512;
const NAME_MAX = 100;

function writeString(block: Uint8Array, offset: number, value: string, length: number): void {
	const bytes = new TextEncoder().encode(value);
	if (bytes.length > length) {
		throw new Error(`tar field too long (${bytes.length} > ${length}): ${value}`);
	}
	block.set(bytes, offset);
}

/** Octal, NUL-terminated, zero-padded - the format every numeric tar field uses. */
function writeOctal(block: Uint8Array, offset: number, value: number, length: number): void {
	const text = value.toString(8).padStart(length - 1, '0');
	writeString(block, offset, text, length - 1);
}

/**
 * Build a one-entry tar archive for a regular file.
 *
 * `name` is the path *inside* the archive, which Docker resolves relative to the
 * `path` query parameter of the upload.
 */
export function tarSingleFile(name: string, contents: Uint8Array, mode = 0o644): Uint8Array {
	if (new TextEncoder().encode(name).length > NAME_MAX) {
		// The long-name (PAX/GNU) extensions exist, but no Hezo artefact path comes
		// close to 100 bytes relative to its directory, so a clear failure beats
		// carrying an encoder nothing exercises.
		throw new Error(`tar entry name exceeds ${NAME_MAX} bytes: ${name}`);
	}
	const header = new Uint8Array(BLOCK);
	writeString(header, 0, name, NAME_MAX);
	writeOctal(header, 100, mode & 0o7777, 8);
	writeOctal(header, 108, 0, 8); // uid
	writeOctal(header, 116, 0, 8); // gid
	writeOctal(header, 124, contents.length, 12);
	writeOctal(header, 136, 0, 12); // mtime - deterministic, so identical content tars identically
	header[156] = 0x30; // typeflag '0' = regular file
	writeString(header, 257, 'ustar', 6);
	header[263] = 0x30;
	header[264] = 0x30; // version "00"

	// The checksum is computed with its own field read as spaces, then written
	// back into it in the canonical layout: **six octal digits, a NUL, then a
	// space**. Writing seven digits (the shape every other numeric field uses)
	// puts the NUL over the last digit and yields a value no reader agrees with -
	// which is the classic way to produce an archive every tool calls corrupt.
	header.fill(0x20, 148, 156);
	let sum = 0;
	for (const byte of header) sum += byte;
	writeString(header, 148, sum.toString(8).padStart(6, '0'), 6);
	header[154] = 0;
	header[155] = 0x20;

	const padded = Math.ceil(contents.length / BLOCK) * BLOCK;
	const out = new Uint8Array(BLOCK + padded + BLOCK * 2);
	out.set(header, 0);
	out.set(contents, BLOCK);
	return out;
}

/**
 * Extract the first regular file from a tar archive.
 *
 * Returns null for an archive with no regular-file entry, which is how a
 * directory-only or empty response reads.
 */
export function untarFirstFile(archive: Uint8Array): { name: string; contents: Uint8Array } | null {
	let offset = 0;
	while (offset + BLOCK <= archive.length) {
		const header = archive.subarray(offset, offset + BLOCK);
		// Two consecutive zero blocks end the archive; one is enough to stop on.
		if (header.every((b) => b === 0)) return null;

		const rawName = header.subarray(0, NAME_MAX);
		const nulIdx = rawName.indexOf(0);
		const name = new TextDecoder().decode(nulIdx === -1 ? rawName : rawName.subarray(0, nulIdx));
		const sizeText = new TextDecoder()
			.decode(header.subarray(124, 136))
			.replace(/\0.*$/, '')
			.trim();
		const size = Number.parseInt(sizeText, 8) || 0;
		const typeflag = header[156];

		const dataStart = offset + BLOCK;
		// '0' and NUL both mean a regular file; anything else (directory, link) is
		// skipped rather than mis-read as content.
		if (typeflag === 0x30 || typeflag === 0) {
			return { name, contents: archive.subarray(dataStart, dataStart + size) };
		}
		offset = dataStart + Math.ceil(size / BLOCK) * BLOCK;
	}
	return null;
}
