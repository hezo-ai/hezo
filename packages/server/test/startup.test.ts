import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { type HezoConfig, startup } from '../src/startup';
import { HEZO_VERSION } from '../src/version';
import { testHezoConfig } from './helpers/config';

function makeTempDir(): string {
	return mkdtempSync(join(tmpdir(), 'hezo-test-'));
}

function baseConfig(overrides: Partial<HezoConfig> = {}): HezoConfig {
	return testHezoConfig(overrides.dataDir ?? makeTempDir(), overrides);
}

describe('startup', () => {
	const tempDirs: string[] = [];

	// Run the production startup() path against the in-process fake Docker so
	// seeding HQ doesn't try (and fail) to reach a real Docker socket — which
	// would otherwise log a swallowed "Failed to provision container" error.
	// These tests assert master-key state / status / --reset / data-dir only,
	// none of which exercise containers. Save+restore so the flag can't leak to
	// the real-Docker integration files if vitest reuses this worker process.
	let prevSkipDocker: string | undefined;
	beforeAll(() => {
		prevSkipDocker = process.env.HEZO_SKIP_DOCKER;
		process.env.HEZO_SKIP_DOCKER = '1';
	});
	afterAll(() => {
		if (prevSkipDocker === undefined) delete process.env.HEZO_SKIP_DOCKER;
		else process.env.HEZO_SKIP_DOCKER = prevSkipDocker;
	});

	afterEach(() => {
		for (const dir of tempDirs) {
			rmSync(dir, { recursive: true, force: true });
		}
		tempDirs.length = 0;
	});

	it('starts successfully and returns an app with health endpoint', async () => {
		const config = baseConfig();
		tempDirs.push(config.dataDir);

		const result = await startup(config);

		expect(result.app).toBeDefined();
		expect(result.port).toBe(0);
		expect(['unset', 'locked', 'unlocked']).toContain(result.masterKeyState);

		const res = await result.app.request('/health');
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ ok: true });
	});

	it('returns status endpoint with masterKeyState and version', async () => {
		const config = baseConfig();
		tempDirs.push(config.dataDir);

		const result = await startup(config);

		const res = await result.app.request('/api/status');
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body).toHaveProperty('masterKeyState');
		// Assert against the live version source, not a literal — otherwise this
		// breaks on every release bump (the status endpoint returns HEZO_VERSION).
		expect(body).toHaveProperty('version', HEZO_VERSION);
		expect(body.version).toMatch(/^\d+\.\d+\.\d+/);
	});

	it('handles --reset flag with a fresh data directory', async () => {
		const config = baseConfig({ reset: true });
		tempDirs.push(config.dataDir);

		const result = await startup(config);

		expect(result.app).toBeDefined();
		const res = await result.app.request('/health');
		expect(res.status).toBe(200);
	});

	it('creates the data directory if it does not exist', async () => {
		const dataDir = join(tmpdir(), `hezo-test-${Date.now()}-nonexistent`);
		tempDirs.push(dataDir);
		const config = baseConfig({ dataDir });

		expect(existsSync(dataDir)).toBe(false);
		await startup(config);
		expect(existsSync(dataDir)).toBe(true);
	});
});
