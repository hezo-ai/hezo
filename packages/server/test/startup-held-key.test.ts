import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AiProvider, deriveAuthKeyPair, deriveUnlockKey } from '@hezo/shared';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetRuntimeConfig, setRuntimeConfig } from '../src/config/runtime';
import { HeldMasterKeyError, MasterKeyManager } from '../src/crypto/master-key';
import { createMemoryDb } from '../src/db/client';
import type { PgliteDb } from '../src/db/drivers/pglite';
import { waitForBackground } from '../src/lib/background';
import { getInstanceBaseUrl, INSTANCE_BASE_URL_KEY, setSystemMeta } from '../src/lib/system-meta';
import { getAiProviderStatus, selectProviderConfig } from '../src/services/ai-provider-keys';
import { getSuperuserId } from '../src/services/superuser';
import { getRunSocketDir } from '../src/services/workspace';
import {
	type HezoConfig,
	resolveMasterKeyState,
	type StartupResult,
	startup,
} from '../src/startup';
import { testHezoConfig } from './helpers/config';

// A key held by the hosting control plane (`custodianMasterKey`): the instance
// enrolls it on a first boot, unlocks with it on every boot after, and has no
// gate for anyone to unlock it from, so any other outcome must stop startup.

const PHRASE_A =
	'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const PHRASE_B = 'legal winner thank year wave sausage worth useful legal winner thank yellow';
const ADDRESS = 'https://acme.app.hezo.ai';

function keyFor(phrase: string): { unlockKeyHex: string; publicKeyHex: string } {
	return {
		unlockKeyHex: deriveUnlockKey(phrase),
		publicKeyHex: deriveAuthKeyPair(phrase).publicKeyHex,
	};
}

describe('startup with a held master key', () => {
	const savedEnv: Record<string, string | undefined> = {};
	const dataDirs: string[] = [];
	let result: StartupResult | null = null;

	async function boot(dataDir: string, overrides: Partial<HezoConfig>): Promise<StartupResult> {
		const config = testHezoConfig(dataDir, {
			masterKeyHeld: true,
			webUrl: ADDRESS,
			...overrides,
		});
		setRuntimeConfig(config);
		result = await startup(config);
		return result;
	}

	async function shutdown(): Promise<void> {
		if (!result) return;
		// An unlocked boot starts the job manager off an untracked chain; stopping
		// before it has started would let the crons come up against a closed DB.
		const jm = result.jobManager as unknown as { started: boolean };
		await vi.waitFor(() => expect(jm.started).toBe(true), { timeout: 15_000 });
		result.jobManager.shutdown();
		await result.chatSessionManager.stop();
		await waitForBackground();
		await result.db.close().catch(() => undefined);
		result = null;
	}

	beforeAll(() => {
		for (const key of ['HEZO_SKIP_DOCKER']) {
			savedEnv[key] = process.env[key];
			process.env[key] = '1';
		}
	});

	afterEach(async () => {
		await shutdown();
		resetRuntimeConfig();
	});

	afterAll(() => {
		for (const [key, value] of Object.entries(savedEnv)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		for (const dir of dataDirs) {
			rmSync(dir, { recursive: true, force: true });
			rmSync(getRunSocketDir(dir), { recursive: true, force: true });
		}
	});

	function freshDataDir(): string {
		const dir = mkdtempSync(join(tmpdir(), 'hezo-held-key-'));
		dataDirs.push(dir);
		return dir;
	}

	// No setup screen exists to create the admin or capture the address, and the
	// SSO sign-in answers SETUP_REQUIRED while there is no admin.
	it('enrolls on a first boot, and creates the admin and stores the address itself', async () => {
		const booted = await boot(freshDataDir(), { masterKey: keyFor(PHRASE_A) });

		expect(booted.masterKeyState).toBe('unlocked');
		expect(await getSuperuserId(booted.db)).not.toBeNull();
		expect(await getInstanceBaseUrl(booted.db)).toBe(ADDRESS);
	}, 60_000);

	it('unlocks with it on every boot after, keeping an address the owner changed', async () => {
		const dataDir = freshDataDir();
		const first = await boot(dataDir, { masterKey: keyFor(PHRASE_A) });
		const admin = await getSuperuserId(first.db);
		await setSystemMeta(first.db, INSTANCE_BASE_URL_KEY, 'https://hezo.example.com');
		await shutdown();

		const again = await boot(dataDir, { masterKey: keyFor(PHRASE_A) });

		expect(again.masterKeyState).toBe('unlocked');
		expect(await getSuperuserId(again.db)).toBe(admin);
		expect(await getInstanceBaseUrl(again.db)).toBe('https://hezo.example.com');
	}, 120_000);

	// The setup screen's model step is gone on a hosted instance, so the boot is
	// what gives it a model, before the unlock hook sends the seeded brief to it.
	it('writes the model its control plane provides, and removes it once the plane stops', async () => {
		const dataDir = freshDataDir();
		const managedModel = {
			baseUrl: 'https://models.example/api',
			model: 'vendor/model',
			apiKey: 'sk-managed',
			requestHeaders: { 'x-session-id': 'tenant-1' },
		};
		const first = await boot(dataDir, { masterKey: keyFor(PHRASE_A), managedModel });
		expect(await getAiProviderStatus(first.db)).toEqual({
			configured: true,
			providers: [AiProvider.HezoCloud],
		});
		const selected = await selectProviderConfig(first.db, AiProvider.HezoCloud);
		expect(selected).toMatchObject({ label: 'Base AI model', defaultModel: 'vendor/model' });
		await shutdown();

		const again = await boot(dataDir, { masterKey: keyFor(PHRASE_A), managedModel: null });
		expect(await getAiProviderStatus(again.db)).toEqual({ configured: false, providers: [] });
	}, 120_000);
});

describe('resolving a held master key', () => {
	let db: PgliteDb;

	beforeEach(async () => {
		db = await createMemoryDb();
		await db.query(
			'CREATE TABLE IF NOT EXISTS system_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)',
		);
		await new MasterKeyManager().initialize(
			db,
			keyFor(PHRASE_A).unlockKeyHex,
			keyFor(PHRASE_A).publicKeyHex,
		);
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await db.close();
	});

	// Locked would wait at a gate nobody is shown.
	it('stops startup when the held key is not the one the database was enrolled with', async () => {
		await expect(
			resolveMasterKeyState(db, new MasterKeyManager(), keyFor(PHRASE_B), true),
		).rejects.toThrow(HeldMasterKeyError);
		await expect(
			resolveMasterKeyState(db, new MasterKeyManager(), keyFor(PHRASE_B), true),
		).rejects.toThrow(/came up locked/);
	});

	// The catch-all would report unset, which offers enrollment to whoever
	// reaches the instance first.
	it('stops startup, keeping the cause, when verifying the held key fails', async () => {
		const broken = new Error('canary unreadable');
		vi.spyOn(MasterKeyManager.prototype, 'initialize').mockRejectedValue(broken);

		const outcome = resolveMasterKeyState(db, new MasterKeyManager(), keyFor(PHRASE_A), true);

		await expect(outcome).rejects.toThrow(/verifying it failed/);
		await expect(outcome).rejects.toMatchObject({ cause: broken });
	});

	it('leaves a one-shot key on the behaviour it has always had', async () => {
		expect(await resolveMasterKeyState(db, new MasterKeyManager(), keyFor(PHRASE_B), false)).toBe(
			'locked',
		);
	});
});
