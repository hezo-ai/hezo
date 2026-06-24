import { readFile } from 'node:fs/promises';
import { logger } from '../logger';

const log = logger.child('pglite-assets');

export interface PgliteAssetInjection {
	wasmModule: WebAssembly.Module;
	fsBundle: Blob;
}

/** Read an embedded asset's bytes. A literal `import ... with { type: 'file' }`
 *  resolves to the file's path inside the binary's virtual FS (`/$bunfs/...`);
 *  in dev the file is absent and the import rejects. */
async function readEmbedded(load: () => Promise<{ default: string }>): Promise<Buffer> {
	const { default: path } = await load();
	return readFile(path);
}

/**
 * Embedded PGlite runtime assets, fed to PGlite from memory so the compiled
 * binary is self-contained. PGlite normally loads `postgres.wasm` /
 * `postgres.data` via `new URL(..., import.meta.url)`, which `bun build --compile`
 * does not embed.
 *
 * Returns `null` in dev / tests (assets not generated) — callers then let
 * PGlite resolve them from `node_modules` as usual.
 */
export async function loadPgliteAssets(): Promise<PgliteAssetInjection | null> {
	let postgresWasm: Buffer;
	let postgresData: Buffer;
	try {
		[postgresWasm, postgresData] = await Promise.all([
			readEmbedded(() => import('../generated/pglite/postgres.wasm', { with: { type: 'file' } })),
			readEmbedded(() => import('../generated/pglite/postgres.data', { with: { type: 'file' } })),
		]);
	} catch {
		return null;
	}

	log.info('Using embedded PGlite runtime assets');
	return {
		wasmModule: await WebAssembly.compile(postgresWasm as BufferSource),
		fsBundle: new Blob([postgresData as BlobPart]),
	};
}
