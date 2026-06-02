import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { vector } from '@electric-sql/pglite/vector';
import { logger } from '../logger';

const log = logger.child('pglite-assets');

export interface PgliteAssetInjection {
	wasmModule: WebAssembly.Module;
	fsBundle: Blob;
	vectorExtension: typeof vector;
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
 * `postgres.data` / the pgvector bundle via `new URL(..., import.meta.url)`,
 * which `bun build --compile` does not embed.
 *
 * Returns `null` in dev / tests (assets not generated) — callers then let
 * PGlite resolve them from `node_modules` as usual.
 */
export async function loadPgliteAssets(dataDir: string): Promise<PgliteAssetInjection | null> {
	let postgresWasm: Buffer;
	let postgresData: Buffer;
	let vectorTarball: Buffer;
	try {
		[postgresWasm, postgresData, vectorTarball] = await Promise.all([
			readEmbedded(() => import('../generated/pglite/postgres.wasm', { with: { type: 'file' } })),
			readEmbedded(() => import('../generated/pglite/postgres.data', { with: { type: 'file' } })),
			readEmbedded(() => import('../generated/pglite/vector.tar.gz', { with: { type: 'file' } })),
		]);
	} catch {
		return null;
	}

	// The vector extension loader reads its bundlePath via `fs`, so it must be a
	// real file URL — extract the embedded tarball into the data dir once.
	const vectorDir = join(dataDir, '.pglite');
	const vectorPath = join(vectorDir, 'vector.tar.gz');
	await mkdir(vectorDir, { recursive: true });
	if (!existsSync(vectorPath)) {
		await writeFile(vectorPath, vectorTarball);
	}
	const vectorUrl = pathToFileURL(vectorPath);
	const vectorExtension = {
		name: 'pgvector',
		setup: async (_pg: unknown, emscriptenOpts: unknown) => ({
			emscriptenOpts,
			bundlePath: vectorUrl,
		}),
	} as unknown as typeof vector;

	log.info('Using embedded PGlite runtime assets');
	return {
		wasmModule: await WebAssembly.compile(postgresWasm),
		fsBundle: new Blob([postgresData as BlobPart]),
		vectorExtension,
	};
}
