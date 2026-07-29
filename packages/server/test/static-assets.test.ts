import { afterEach, describe, expect, it } from 'vitest';
import { loadStaticBundle, resetStaticBundleCache } from '../src/static-assets';

// `static-bundle.json` ships as an empty stub `{}` in source/dev (written by
// scripts/ensure-bundles.ts so the literal import resolves). loadStaticBundle
// must treat that as "no bundle" and return null so the server falls back to
// reading packages/web/dist off disk. This is the only branch reachable in the
// source tree — the populated-bundle path only exists in the compiled binary,
// where bundle-static.ts has filled the JSON. Covered indirectly via the
// startup-serving fake-bundle tests.
describe('loadStaticBundle', () => {
	afterEach(() => resetStaticBundleCache());

	it('returns null when the embedded bundle is the empty stub', async () => {
		const result = await loadStaticBundle();
		expect(result).toBeNull();
	});

	// The absent-bundle verdict is memoized as well as the present one. This is
	// called on every non-API request, so without caching the negative, dev
	// re-attempted an import guaranteed to fail for the life of the process -
	// once per request forever.
	it('returns null deterministically on repeated calls', async () => {
		expect(await loadStaticBundle()).toBeNull();
		expect(await loadStaticBundle()).toBeNull();
		expect(await loadStaticBundle()).toBeNull();
	});

	it('re-resolves after the cache is reset', async () => {
		expect(await loadStaticBundle()).toBeNull();
		resetStaticBundleCache();
		expect(await loadStaticBundle()).toBeNull();
	});
});
