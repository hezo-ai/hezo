import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { HEZO_VERSION, IS_PACKAGED_BUILD } from '../src/version';

const PACKAGES = resolve(__dirname, '../../../packages');

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

// The release script bumps a hand-listed set of manifests. A package missing
// from that list keeps the version it was created at through every release
// that follows, which nothing else notices.
describe('workspace versions', () => {
	const manifests = readdirSync(PACKAGES, { withFileTypes: true })
		.filter((e) => e.isDirectory())
		.map((e) => ({
			name: e.name,
			pkg: JSON.parse(readFileSync(resolve(PACKAGES, e.name, 'package.json'), 'utf8')) as {
				version?: string;
			},
		}));

	it('every workspace package rides the same version', () => {
		expect(manifests.length).toBeGreaterThan(1);
		const versions = new Map(manifests.map((m) => [m.name, m.pkg.version]));
		const expected = versions.get('server');
		for (const [name, version] of versions) {
			expect(version, `packages/${name} is not on the release version`).toBe(expected);
		}
	});

	it('the release script bumps every one of them', () => {
		const script = readFileSync(resolve(PACKAGES, '../scripts/release.ts'), 'utf8');
		for (const { name } of manifests) {
			expect(script, `packages/${name} is not in PACKAGE_PATHS`).toContain(`'packages/${name}'`);
		}
	});
});
