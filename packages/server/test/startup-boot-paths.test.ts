import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deriveAuthKeyPair, deriveUnlockKey } from '@hezo/shared';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { waitForBackground } from '../src/lib/background';
import { setLogLevel } from '../src/logger';
import { getRunSocketDir } from '../src/services/workspace';
import { type HezoConfig, type StartupResult, startup } from '../src/startup';

// Drives the production startup() path (fake Docker via HEZO_SKIP_DOCKER) through
// the branches the smoke tests in startup.test.ts don't reach: a CLI master key
// (enroll + auto-unlock + the onUnlock job-manager bootstrap), the locked states
// against an already-enrolled database, the telemetry startup notice, orphan
// run-socket cleanup, and the public agent-facing routes buildApp mounts.

const PHRASE_A =
	'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const PHRASE_B = 'legal winner thank year wave sausage worth useful legal winner thank yellow';

function masterKeyFor(phrase: string): { unlockKeyHex: string; publicKeyHex: string } {
	return {
		unlockKeyHex: deriveUnlockKey(phrase),
		publicKeyHex: deriveAuthKeyPair(phrase).publicKeyHex,
	};
}

function baseConfig(dataDir: string, overrides: Partial<HezoConfig> = {}): HezoConfig {
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
		...overrides,
	};
}

describe('startup boot paths (master key, routes, socket cleanup)', () => {
	// One enrolled data dir shared across the sequential tests below.
	let dataDir: string;
	let result: StartupResult | null = null;
	const savedEnv: Record<string, string | undefined> = {};

	beforeAll(() => {
		for (const key of ['HEZO_SKIP_DOCKER', 'HEZO_SKIP_PRICING_REFRESH']) {
			savedEnv[key] = process.env[key];
			process.env[key] = '1';
		}
		dataDir = mkdtempSync(join(tmpdir(), 'hezo-boot-paths-'));
	});

	afterAll(() => {
		for (const [key, value] of Object.entries(savedEnv)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		rmSync(dataDir, { recursive: true, force: true });
		rmSync(getRunSocketDir(dataDir), { recursive: true, force: true });
	});

	afterEach(async () => {
		setLogLevel('warn');
		vi.restoreAllMocks();
		if (result) {
			result.jobManager.shutdown();
			await result.ceoSessionManager.stop();
			await waitForBackground();
			await result.db.close().catch(() => undefined);
			result = null;
		}
	});

	it('enrolls + unlocks from a CLI master key, cleans orphan run sockets, and starts the job manager', async () => {
		// Capture the (info-level) telemetry notice without polluting the test log.
		setLogLevel('info');
		const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

		// Pre-seed an orphan run socket + an unrelated file in the run-socket dir.
		const socketDir = getRunSocketDir(dataDir);
		mkdirSync(socketDir, { recursive: true });
		writeFileSync(join(socketDir, 'orphan.sock'), '');
		writeFileSync(join(socketDir, 'keep.txt'), 'not a socket');

		result = await startup(
			baseConfig(dataDir, {
				masterKey: masterKeyFor(PHRASE_A),
				telemetry: { enabled: true, endpoint: 'https://example.invalid/telemetry' },
			}),
		);

		// Fresh DB + CLI mnemonic → fully enrolled and unlocked.
		expect(result.masterKeyState).toBe('unlocked');
		expect(result.masterKeyManager.getState()).toBe('unlocked');

		// Telemetry-enabled startup notice was logged.
		expect(logSpy.mock.calls.some((c) => String(c[0]).includes('usage telemetry is enabled'))).toBe(
			true,
		);

		// Orphan *.sock removed; non-socket files left alone.
		expect(existsSync(join(socketDir, 'orphan.sock'))).toBe(false);
		expect(existsSync(join(socketDir, 'keep.txt'))).toBe(true);

		// The unlock callback bootstraps the job manager (reconcile → start).
		const jm = result.jobManager as unknown as { started: boolean };
		await vi.waitFor(() => expect(jm.started).toBe(true), { timeout: 15_000 });

		// /api/status on an unlocked instance computes passwordSet (false — no admin yet).
		const status = await result.app.request('/api/status');
		expect(status.status).toBe(200);
		const statusBody = (await status.json()) as { masterKeyState: string; passwordSet: boolean };
		expect(statusBody.masterKeyState).toBe('unlocked');
		expect(statusBody.passwordSet).toBe(false);

		// Public agent-manifest routes.
		const skill = await result.app.request('/SKILL.md');
		expect(skill.status).toBe(200);
		expect(skill.headers.get('Content-Type')).toContain('text/markdown');
		expect(await skill.text()).toContain('# ');

		const llms = await result.app.request('/llms.txt');
		expect(llms.status).toBe(200);
		expect(await llms.text()).toContain('SKILL.md');

		// MCP transport only supports JSON-RPC POST.
		for (const [path, method] of [
			['/mcp', 'GET'],
			['/mcp', 'DELETE'],
			['/mcp/assets', 'GET'],
			['/mcp/assets', 'DELETE'],
		] as const) {
			const res = await result.app.request(path, { method });
			expect(res.status, `${method} ${path}`).toBe(405);
			expect(res.headers.get('Allow')).toBe('POST');
		}

		// SPA catch-all: no embedded bundle in source runs; packages/web/dist may or
		// may not be built in this checkout — both terminal branches are legitimate.
		const root = await result.app.request('/');
		expect([200, 404]).toContain(root.status);
		if (root.status === 200) {
			expect(root.headers.get('Content-Type')).toContain('text/html');
		} else {
			expect(await root.text()).toBe('Not found');
		}
	}, 60_000);

	it('boots locked when a different master key is supplied against the enrolled database', async () => {
		result = await startup(baseConfig(dataDir, { masterKey: masterKeyFor(PHRASE_B) }));
		expect(result.masterKeyState).toBe('locked');

		// Locked instance: /api/status reports locked and skips the password lookup.
		const status = await result.app.request('/api/status');
		const body = (await status.json()) as { masterKeyState: string; passwordSet: boolean };
		expect(body.masterKeyState).toBe('locked');
		expect(body.passwordSet).toBe(false);
	}, 60_000);

	it('boots locked when no master key is supplied against the enrolled database', async () => {
		result = await startup(baseConfig(dataDir));
		expect(result.masterKeyState).toBe('locked');
		expect(result.masterKeyManager.getState()).toBe('locked');
	}, 60_000);
});
