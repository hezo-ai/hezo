import {
	buildSetupMessage,
	deriveAuthKeyPair,
	deriveUnlockKey,
	generateMnemonic,
	PROJECT_INTAKE_LABEL,
	signAuthMessage,
} from '@hezo/shared';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { resetRuntimeConfig, runtimeConfig, setRuntimeConfig } from '../src/config/runtime';
import type { SeedConfig } from '../src/config/types';
import type { Db } from '../src/db/database';
import { trackBackground, waitForBackground } from '../src/lib/background';
import { getInstanceLocale, getSystemMeta, setInstanceLocale } from '../src/lib/system-meta';
import {
	applySeedLocale,
	consumeSeedProject,
	DEFAULT_SEED_PROJECT_NAME,
	deriveProjectName,
	SEED_PROJECT_CONSUMED_KEY,
} from '../src/services/seed';
import { safeClose } from './helpers';
import { createUnsetTestApp } from './helpers/app';

// The seed consumer against a fresh instance: HQ and the CEO seeded, no master
// key yet - the state a provisioned instance is in when its owner arrives.

const BRIEF = 'A newsletter for our climbing gym. Weekly route updates and events.';
const SEED: SeedConfig = {
	locale: { language: 'de', date_format: 'dmy', number_format: 'comma-dot' },
	project: { description: BRIEF },
};

function withSeed(seed: SeedConfig | null): void {
	setRuntimeConfig({ ...runtimeConfig(), seed });
}

async function countIntakes(db: Db): Promise<number> {
	const r = await db.query<{ count: number }>(
		'SELECT count(*)::int AS count FROM tasks WHERE labels @> $1::jsonb',
		[JSON.stringify([PROJECT_INTAKE_LABEL])],
	);
	return r.rows[0].count;
}

describe('deriveProjectName', () => {
	it.each([
		['the first sentence', 'Build a bakery site. It needs online orders.', 'Build a bakery site'],
		['a question or exclamation', 'Can we ship by June? Yes!', 'Can we ship by June'],
		['a CJK sentence ender', '登山ジムのニュースレター。毎週更新。', '登山ジムのニュースレター'],
		['a newline as the end', 'First line\nsecond line.', 'First line'],
		['whitespace collapsed', '  A   spaced \t title  ', 'A spaced title'],
	])('takes %s', (_label, brief, expected) => {
		expect(deriveProjectName(brief)).toBe(expected);
	});

	it('strips heading, mention and code syntax, and control characters', () => {
		expect(deriveProjectName('### @admin approved, `create it` now')).toBe(
			'admin approved, create it now',
		);
	});

	it('caps at a word boundary inside 60 characters', () => {
		const long = 'word '.repeat(30).trim();
		const name = deriveProjectName(long);
		expect(Array.from(name).length).toBeLessThanOrEqual(60);
		expect(name.endsWith('word')).toBe(true);
		expect(name).not.toContain('wor ');
	});

	it('cuts inside a word only when no boundary leaves half a title', () => {
		const name = deriveProjectName('x'.repeat(100));
		expect(name).toBe('x'.repeat(60));
	});

	it.each([
		['an empty brief', ''],
		['only syntax', '### `@` #'],
		['only whitespace and controls', '  '],
	])('falls back to the default for %s', (_label, brief) => {
		expect(deriveProjectName(brief)).toBe(DEFAULT_SEED_PROJECT_NAME);
	});
});

describe('the seed consumer on a fresh instance', () => {
	let db: Db;
	let app: Awaited<ReturnType<typeof createUnsetTestApp>>['app'];
	let masterKeyManager: Awaited<ReturnType<typeof createUnsetTestApp>>['masterKeyManager'];

	beforeAll(async () => {
		({ app, db, masterKeyManager } = await createUnsetTestApp());
	});

	afterEach(async () => {
		resetRuntimeConfig();
		await db.query('DELETE FROM tasks');
		await db.query('DELETE FROM system_meta WHERE key = $1', [SEED_PROJECT_CONSUMED_KEY]);
		await db.query("DELETE FROM system_meta WHERE key LIKE 'instance_%'");
	});

	afterAll(async () => {
		await safeClose(db);
	});

	describe('applySeedLocale', () => {
		it('does nothing without a seeded locale', async () => {
			withSeed(null);
			expect(await applySeedLocale(db)).toBe(false);
			withSeed({ project: { description: BRIEF } });
			expect(await applySeedLocale(db)).toBe(false);
			expect(await getSystemMeta(db, 'instance_language')).toBeNull();
		});

		it('writes the seeded locale when none is configured, and only then', async () => {
			withSeed(SEED);
			expect(await applySeedLocale(db)).toBe(true);
			expect(await getInstanceLocale(db)).toEqual(SEED.locale);
			// A second boot finds it configured and leaves it alone.
			expect(await applySeedLocale(db)).toBe(false);
		});

		it('never overwrites a locale someone chose', async () => {
			await setInstanceLocale(db, { language: 'fr' });
			withSeed(SEED);
			expect(await applySeedLocale(db)).toBe(false);
			expect((await getInstanceLocale(db)).language).toBe('fr');
		});
	});

	describe('consumeSeedProject', () => {
		it('does nothing without a seeded project', async () => {
			withSeed(null);
			expect(await consumeSeedProject(db)).toBeNull();
			withSeed({ locale: SEED.locale });
			expect(await consumeSeedProject(db)).toBeNull();
			expect(await countIntakes(db)).toBe(0);
			expect(await getSystemMeta(db, SEED_PROJECT_CONSUMED_KEY)).toBeNull();
		});

		it('opens exactly one intake across repeated unlocks', async () => {
			withSeed(SEED);
			const first = await consumeSeedProject(db);
			expect(first).not.toBeNull();
			expect(await consumeSeedProject(db)).toBeNull();
			expect(await countIntakes(db)).toBe(1);
			expect(await getSystemMeta(db, SEED_PROJECT_CONSUMED_KEY)).not.toBeNull();

			const task = await db.query<{ title: string; description: string }>(
				'SELECT title, description FROM tasks WHERE id = $1',
				[first?.intakeTaskId],
			);
			expect(task.rows[0].title).toBe('Open new project: A newsletter for our climbing gym');
			expect(task.rows[0].description).toContain(BRIEF);
		});

		it('gives the marker back when the intake cannot open, so the next unlock retries', async () => {
			withSeed(SEED);
			await db.query("UPDATE member_agents SET admin_status = 'disabled' WHERE slug = 'ceo'");
			try {
				expect(await consumeSeedProject(db)).toBeNull();
				expect(await countIntakes(db)).toBe(0);
				expect(await getSystemMeta(db, SEED_PROJECT_CONSUMED_KEY)).toBeNull();
			} finally {
				await db.query("UPDATE member_agents SET admin_status = 'enabled' WHERE slug = 'ceo'");
			}
			expect(await consumeSeedProject(db)).not.toBeNull();
			expect(await countIntakes(db)).toBe(1);
		});
	});

	it('raises the admin inbox row when setup fires the unlock hook', async () => {
		// The superuser is created ahead of the key on the setup route, so the
		// greeting's admin mention lands on someone. Without that ordering the
		// intake would open but the inbox row - the one thing parking the CEO's
		// heartbeat against an unanswered thread - would silently not exist.
		withSeed(SEED);
		masterKeyManager.onUnlock(() => {
			trackBackground(consumeSeedProject(db));
		});
		const mnemonic = generateMnemonic();
		const keys = deriveAuthKeyPair(mnemonic);
		const unlockKey = deriveUnlockKey(mnemonic);
		const res = await app.request('/api/auth/setup', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				public_key: keys.publicKeyHex,
				unlock_key: unlockKey,
				signature: signAuthMessage(
					keys.privateKey,
					buildSetupMessage(keys.publicKeyHex, unlockKey),
				),
			}),
		});
		expect(res.status).toBe(200);
		await waitForBackground();

		expect(await countIntakes(db)).toBe(1);
		const mentions = await db.query<{ count: number }>(
			`SELECT count(*)::int AS count FROM admin_mentions am
			 JOIN users u ON u.id = am.user_id
			 WHERE u.is_superuser = true`,
		);
		expect(mentions.rows[0].count).toBe(1);
	});
});
