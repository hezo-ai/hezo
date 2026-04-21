import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { type HezoConfig, startup } from '../../startup';

function makeTempDir(): string {
	return mkdtempSync(join(tmpdir(), 'hezo-test-'));
}

function baseConfig(overrides: Partial<HezoConfig> = {}): HezoConfig {
	return {
		port: 0,
		dataDir: overrides.dataDir ?? makeTempDir(),
		connectUrl: 'https://connect.test',
		reset: false,
		open: false,
		...overrides,
	};
}

describe('startup', () => {
	const tempDirs: string[] = [];

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
		expect(body).toHaveProperty('version', '0.1.0');
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
