import { describe, expect, it } from 'vitest';
import { HEZO_VERSION, IS_PACKAGED_BUILD } from '../src/version';

describe('version constants', () => {
	it('exposes a non-empty version string', () => {
		expect(typeof HEZO_VERSION).toBe('string');
		expect(HEZO_VERSION.length).toBeGreaterThan(0);
	});

	it('IS_PACKAGED_BUILD reflects whether HEZO_VERSION env is set', () => {
		expect(IS_PACKAGED_BUILD).toBe(process.env.HEZO_VERSION !== undefined);
	});

	it('falls back to a dev version when the env define is absent', () => {
		// In the test runner (bun run / node) the build-time define is not present,
		// so the dev fallback path read the version off the server package.json.
		if (process.env.HEZO_VERSION === undefined) {
			expect(IS_PACKAGED_BUILD).toBe(false);
			expect(HEZO_VERSION).toMatch(/\d+\.\d+\.\d+/);
		}
	});
});
