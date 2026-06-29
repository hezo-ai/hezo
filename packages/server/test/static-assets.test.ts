import { describe, expect, it } from 'vitest';
import { loadStaticBundle } from '../src/static-assets';

// `static-bundle.json` ships as an empty stub `{}` in source/dev (written by
// scripts/ensure-bundles.ts so the literal import resolves). loadStaticBundle
// must treat that as "no bundle" and return null so the server falls back to
// reading packages/web/dist off disk. This is the only branch reachable in the
// source tree — the populated-bundle path only exists in the compiled binary,
// where bundle-static.ts has filled the JSON. Covered indirectly via the
// startup-serving fake-bundle tests.
describe('loadStaticBundle', () => {
	it('returns null when the embedded bundle is the empty stub', async () => {
		const result = await loadStaticBundle();
		expect(result).toBeNull();
	});

	it('returns null deterministically on repeated calls (empty stub is not cached)', async () => {
		const a = await loadStaticBundle();
		const b = await loadStaticBundle();
		expect(a).toBeNull();
		expect(b).toBeNull();
	});
});
