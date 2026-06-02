/**
 * In-memory frontend assets for the compiled binary.
 *
 * `scripts/bundle-static.ts` generates `static-bundle.json` (a `{ path: {type,
 * b64} }` map of `packages/web/dist`). A *literal* dynamic import lets
 * `bun build --compile` embed it into the binary's virtual FS, so the SPA is
 * served straight from memory with no temp-dir extraction. In dev the file is
 * absent — the import rejects and the server falls back to reading
 * `packages/web/dist` off disk.
 */

export interface StaticAsset {
	type: string;
	body: Blob;
}

let cache: Map<string, StaticAsset> | null = null;

export async function loadStaticBundle(): Promise<Map<string, StaticAsset> | null> {
	if (cache) return cache;
	let mod: { default: Record<string, { type: string; b64: string }> };
	try {
		mod = (await import('./static-bundle.json')) as {
			default: Record<string, { type: string; b64: string }>;
		};
	} catch {
		return null;
	}
	// An empty stub (written by `scripts/ensure-bundles.ts` so tsc/vite can
	// resolve the literal import) means the bundle was never generated — treat it
	// as absent so the caller falls back to reading `packages/web/dist` off disk.
	if (Object.keys(mod.default).length === 0) return null;
	const map = new Map<string, StaticAsset>();
	for (const [path, { type, b64 }] of Object.entries(mod.default)) {
		map.set(path, { type, body: new Blob([Buffer.from(b64, 'base64')], { type }) });
	}
	cache = map;
	return cache;
}
