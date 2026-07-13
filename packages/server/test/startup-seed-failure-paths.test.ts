import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { waitForBackground } from '../src/lib/background';
import { getRunSocketDir } from '../src/services/workspace';
import { type HezoConfig, type StartupResult, startup } from '../src/startup';

// startup() must survive a failing built-ins seed and a failing default-team
// seed — both are logged and swallowed so a broken seed never bricks the boot.
// The two seeding modules are mocked (everything else in startup runs real) to
// force the error branches deterministically.

const state = vi.hoisted(() => ({
	seedBuiltinsError: null as Error | null,
	seedDefaultTeamError: null as Error | null,
}));

vi.mock('../src/db/seed.js', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../src/db/seed.js')>();
	return {
		...actual,
		seedBuiltins: vi.fn(async () => {
			if (state.seedBuiltinsError) throw state.seedBuiltinsError;
		}),
	};
});

vi.mock('../src/services/teams.js', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../src/services/teams.js')>();
	return {
		...actual,
		seedDefaultTeam: vi.fn(async () => {
			if (state.seedDefaultTeamError) throw state.seedDefaultTeamError;
		}),
	};
});

function makeConfig(dataDir: string): HezoConfig {
	return {
		port: 0,
		dataDir,
		webUrl: '',
		reset: false,
		open: false,
		logLevel: 'info',
		keepOldContainers: false,
		containerBindHost: '127.0.0.1',
		telemetry: { enabled: false, endpoint: 'https://example.invalid/telemetry' },
	};
}

describe('startup seed failure paths', () => {
	const tempDirs: string[] = [];
	let result: StartupResult | null = null;
	const savedEnv: Record<string, string | undefined> = {};

	beforeAll(() => {
		for (const key of ['HEZO_SKIP_DOCKER', 'HEZO_SKIP_PRICING_REFRESH']) {
			savedEnv[key] = process.env[key];
			process.env[key] = '1';
		}
	});

	afterAll(() => {
		for (const [key, value] of Object.entries(savedEnv)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		for (const dir of tempDirs) {
			rmSync(dir, { recursive: true, force: true });
			rmSync(getRunSocketDir(dir), { recursive: true, force: true });
		}
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		if (result) {
			result.jobManager.shutdown();
			await result.chatSessionManager.stop();
			await waitForBackground();
			await result.db.close().catch(() => undefined);
			result = null;
		}
	});

	it('treats a missing seed module as a packaged-build no-op (no error logged)', async () => {
		const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
		state.seedBuiltinsError = new Error("Cannot find module './agents-bundle.json'");
		state.seedDefaultTeamError = null;
		const dataDir = mkdtempSync(join(tmpdir(), 'hezo-seed-miss-'));
		tempDirs.push(dataDir);

		result = await startup(makeConfig(dataDir));

		// Startup completed and serves traffic despite the seed bailing out.
		const health = await result.app.request('/health');
		expect(health.status).toBe(200);
		// The module-missing branch is silent — no 'Seed failed' error line.
		expect(logSpy.mock.calls.some((c) => String(c[0]).includes('Seed failed'))).toBe(false);
	}, 60_000);

	it('logs and survives a real seed failure and a default-team seed failure', async () => {
		const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
		state.seedBuiltinsError = new Error('seed exploded');
		state.seedDefaultTeamError = new Error('team seed exploded');
		const dataDir = mkdtempSync(join(tmpdir(), 'hezo-seed-fail-'));
		tempDirs.push(dataDir);

		result = await startup(makeConfig(dataDir));

		// Both failures were logged, neither aborted the boot.
		expect(logSpy.mock.calls.some((c) => String(c[0]).includes('Seed failed:'))).toBe(true);
		expect(
			logSpy.mock.calls.some((c) => String(c[0]).includes('Failed to seed default team:')),
		).toBe(true);

		const health = await result.app.request('/health');
		expect(health.status).toBe(200);

		// The swallowed default-team failure is observable: no team was seeded.
		const teams = await result.db.query<{ c: number }>('SELECT COUNT(*)::int AS c FROM teams');
		expect(teams.rows[0].c).toBe(0);
	}, 60_000);
});
