/**
 * Hand a Node `Buffer` to a web API that wants `BodyInit`, without copying it.
 *
 * `Response`/`fetch` accept an `ArrayBufferView`, but TypeScript types a Node
 * Buffer as `Buffer<ArrayBufferLike>` - and `ArrayBufferLike` admits
 * `SharedArrayBuffer`, which `BodyInit` does not. The usual workaround is to
 * allocate a fresh `ArrayBuffer` and copy the bytes into it, which typechecks
 * and doubles peak memory for every payload; on the asset paths that meant a
 * second full copy of a file up to the 10 MB attachment cap, per concurrent
 * request, purely to satisfy a type.
 *
 * A Buffer produced by `readFile`/`Buffer.from`/`Buffer.concat` is always backed
 * by a real `ArrayBuffer`, never a shared one, so re-viewing it over its own
 * `byteOffset`/`byteLength` is both accurate and free. The offset matters: a
 * Buffer is a window into a shared allocation pool, so viewing `buf.buffer`
 * whole would send unrelated memory.
 */
export function asBodyBytes(buf: Buffer): Uint8Array<ArrayBuffer> {
	return new Uint8Array(buf.buffer as ArrayBuffer, buf.byteOffset, buf.byteLength);
}
