import { waitForBackground } from '../src/lib/background';

export async function safeClose(db: { close: () => Promise<void> }) {
	await waitForBackground();
	try {
		await db.close();
	} catch {
		// PGlite 0.2 can throw on close in some environments
	}
}

/**
 * A `BlobPart`/`BodyInit`-safe copy of some bytes.
 *
 * Node's `Buffer` is typed as `Buffer<ArrayBufferLike>`, and `ArrayBufferLike`
 * admits `SharedArrayBuffer`, which the DOM types will not accept as a
 * `BlobPart`. Every `new Blob([buf])` in the suite hits that, so the conversion
 * lives here rather than as a cast repeated at each call site - a cast would
 * also silence the next, genuine, mismatch.
 *
 * Copies rather than aliases: the caller's buffer is often reused, and a Blob
 * that shared its memory would see later writes.
 */
export function blobBytes(data: Uint8Array): ArrayBuffer {
	const out = new ArrayBuffer(data.byteLength);
	new Uint8Array(out).set(data);
	return out;
}
