import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChatMessageRole, deriveAuthKeyPair, deriveUnlockKey } from '@hezo/shared';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { resetRuntimeConfig, setRuntimeConfig } from '../src/config/runtime';
import type { SeedConfig } from '../src/config/types';
import { encrypt } from '../src/crypto/encryption';
import type { Db } from '../src/db/database';
import { waitForBackground } from '../src/lib/background';
import {
	getInstanceLocale,
	getSystemMeta,
	setInstanceLocale,
	setSystemMeta,
} from '../src/lib/system-meta';
import {
	pendingSeedBrief,
	SEED_BRIEF_SENDING,
	SEED_PROJECT_CONSUMED_KEY,
} from '../src/services/seed';
import { getRunSocketDir } from '../src/services/workspace';
import { type HezoConfig, type StartupResult, startup } from '../src/startup';
import { testHezoConfig } from './helpers/config';

// Drives the production startup() path with a `seed` block, the way a
// provisioned instance boots. Route tests build the app without startup(), so
// this is the only proof that the locale is wired to the workspace phase, and
// that an unlock - a CLI master key enrolls and unlocks in one boot, firing the
// hook exactly as the setup route does - sends the brief to the CEO chat only
// once a model credential exists.

const PHRASE =
	'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const MASTER_KEY = {
	unlockKeyHex: deriveUnlockKey(PHRASE),
	publicKeyHex: deriveAuthKeyPair(PHRASE).publicKeyHex,
};

const BRIEF = 'Ein Newsletter für unsere Kletterhalle. Wöchentliche Routen und Events.';
const SEED: SeedConfig = {
	locale: { language: 'de', date_format: 'dmy', number_format: 'comma-dot' },
	project: { description: BRIEF },
};

async function countTasks(db: Db): Promise<number> {
	const r = await db.query<{ count: number }>('SELECT count(*)::int AS count FROM tasks');
	return r.rows[0].count;
}

/** What the admin has said in any chat, oldest first. */
async function adminMessages(db: Db): Promise<string[]> {
	const r = await db.query<{ content: string }>(
		'SELECT content FROM chat_messages WHERE role = $1 ORDER BY created_at',
		[ChatMessageRole.User],
	);
	return r.rows.map((row) => row.content);
}

describe('startup with a seed block', () => {
	const savedEnv: Record<string, string | undefined> = {};
	const dataDirs: string[] = [];
	let result: StartupResult | null = null;

	function freshDataDir(): string {
		const dir = mkdtempSync(join(tmpdir(), 'hezo-seed-boot-'));
		dataDirs.push(dir);
		return dir;
	}

	// startup() reads the seed through runtimeConfig(), as index.ts publishes it.
	async function boot(dataDir: string, overrides: Partial<HezoConfig>): Promise<StartupResult> {
		const config = testHezoConfig(dataDir, overrides);
		setRuntimeConfig(config);
		result = await startup(config);
		return result;
	}

	/**
	 * The unlock's work runs off the job manager's start, an untracked chain, so
	 * wait for that start and then for the background work it queued.
	 */
	async function settleUnlock(booted: StartupResult): Promise<void> {
		const jm = booted.jobManager as unknown as { started: boolean };
		await vi.waitFor(() => expect(jm.started).toBe(true), { timeout: 15_000 });
		await waitForBackground();
	}

	async function shutdown(): Promise<void> {
		if (!result) return;
		// An unlocked boot starts the job manager off an untracked chain; stopping
		// before it has started would let the crons come up against a closed DB.
		if (result.masterKeyManager.getState() === 'unlocked') {
			const jm = result.jobManager as unknown as { started: boolean };
			await vi.waitFor(() => expect(jm.started).toBe(true), { timeout: 15_000 });
		}
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

	it('applies the locale at boot, and sends nothing at unlock while no model is connected', async () => {
		const dataDir = freshDataDir();
		const first = await boot(dataDir, { masterKey: MASTER_KEY, seed: SEED });
		expect(first.masterKeyState).toBe('unlocked');

		// The locale is there before the first request: /api/status reports it
		// configured, which is what makes every browser adopt it.
		const status = await first.app.request('/api/status');
		const body = (await status.json()) as {
			localeConfigured: boolean;
			locale: { language: string };
		};
		expect(body.localeConfigured).toBe(true);
		expect(body.locale.language).toBe('de');

		// The CEO cannot answer yet, so the unlock sends nothing and claims nothing:
		// no task, no message, no marker. The brief waits for a model.
		await waitForBackground();
		await settleUnlock(first);
		expect(await countTasks(first.db)).toBe(0);
		expect(await adminMessages(first.db)).toEqual([]);
		expect(await getSystemMeta(first.db, SEED_PROJECT_CONSUMED_KEY)).toBeNull();
		expect(await pendingSeedBrief(first.db)).toBe(BRIEF);
		await shutdown();

		// The same instance restarted and unlocked again, seed still in the file.
		const second = await boot(dataDir, { masterKey: MASTER_KEY, seed: SEED });
		expect(second.masterKeyState).toBe('unlocked');
		await settleUnlock(second);
		expect(await adminMessages(second.db)).toEqual([]);
		expect(await pendingSeedBrief(second.db)).toBe(BRIEF);
	}, 120_000);

	it('sends the brief at unlock when a model is already connected, once across restarts', async () => {
		const dataDir = freshDataDir();
		const first = await boot(dataDir, { masterKey: MASTER_KEY, seed: SEED });
		await settleUnlock(first);
		const key = first.masterKeyManager.getKey();
		if (!key) throw new Error('master key unavailable');
		// A model added while the instance was up, then a restart before the brief
		// went out: the unlock is what sends it.
		await first.db.query(
			`INSERT INTO ai_provider_configs (provider, auth_method, label, encrypted_credential, is_default, status, default_model)
			 VALUES ('anthropic', 'api_key', 'test', $1, true, 'verified', 'claude-sonnet-4-6')`,
			[encrypt('sk-ant-test', key)],
		);
		await shutdown();

		const second = await boot(dataDir, { masterKey: MASTER_KEY, seed: SEED });
		await vi.waitFor(async () => expect(await adminMessages(second.db)).toEqual([BRIEF]), {
			timeout: 15_000,
		});
		expect(await getSystemMeta(second.db, SEED_PROJECT_CONSUMED_KEY)).not.toBeNull();
		await shutdown();

		const third = await boot(dataDir, { masterKey: MASTER_KEY, seed: SEED });
		await settleUnlock(third);
		expect(await adminMessages(third.db)).toEqual([BRIEF]);
	}, 180_000);

	it('sends the brief after a restart when the last run stopped mid-send', async () => {
		const dataDir = freshDataDir();
		const first = await boot(dataDir, { masterKey: MASTER_KEY, seed: SEED });
		await settleUnlock(first);
		const key = first.masterKeyManager.getKey();
		if (!key) throw new Error('master key unavailable');
		await first.db.query(
			`INSERT INTO ai_provider_configs (provider, auth_method, label, encrypted_credential, is_default, status, default_model)
			 VALUES ('anthropic', 'api_key', 'test', $1, true, 'verified', 'claude-sonnet-4-6')`,
			[encrypt('sk-ant-test', key)],
		);
		// The claim a run took just before it died, with no message stored.
		await setSystemMeta(first.db, SEED_PROJECT_CONSUMED_KEY, SEED_BRIEF_SENDING);
		await shutdown();

		const second = await boot(dataDir, { masterKey: MASTER_KEY, seed: SEED });
		await vi.waitFor(async () => expect(await adminMessages(second.db)).toEqual([BRIEF]), {
			timeout: 15_000,
		});
		expect(await getSystemMeta(second.db, SEED_PROJECT_CONSUMED_KEY)).not.toBe(SEED_BRIEF_SENDING);
	}, 120_000);

	it('opens nothing and configures nothing when the file carries no seed', async () => {
		const booted = await boot(freshDataDir(), { masterKey: MASTER_KEY });
		expect(booted.masterKeyState).toBe('unlocked');
		await waitForBackground();
		expect(await countTasks(booted.db)).toBe(0);
		expect(await pendingSeedBrief(booted.db)).toBeNull();
		const status = await booted.app.request('/api/status');
		expect(((await status.json()) as { localeConfigured: boolean }).localeConfigured).toBe(false);
	}, 60_000);

	it('leaves a locale someone already chose alone', async () => {
		const dataDir = freshDataDir();
		const plain = await boot(dataDir, {});
		await setInstanceLocale(plain.db, { language: 'fr' });
		await shutdown();

		const seeded = await boot(dataDir, { seed: { locale: SEED.locale } });
		expect((await getInstanceLocale(seeded.db)).language).toBe('fr');
	}, 120_000);
});
