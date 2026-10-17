import { ChatMessageRole, DEFAULT_TEAM_ID } from '@hezo/shared';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { resetRuntimeConfig, runtimeConfig, setRuntimeConfig } from '../src/config/runtime';
import type { SeedConfig } from '../src/config/types';
import type { Db } from '../src/db/database';
import {
	getInstanceLocale,
	getSystemMeta,
	setInstanceLocale,
	setSystemMeta,
} from '../src/lib/system-meta';
import { applySeedLocale, pendingSeedBrief, SEED_PROJECT_CONSUMED_KEY } from '../src/services/seed';
import { safeClose } from './helpers';
import { createUnsetTestApp, seedCeoWebConversation } from './helpers/app';

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

async function postHqChatMessage(db: Db, role: ChatMessageRole): Promise<void> {
	const conversationId = await seedCeoWebConversation(db);
	await db.query(
		`INSERT INTO chat_messages (conversation_id, role, channel, status, content)
		 VALUES ($1, $2, 'web', 'complete', 'Hello')`,
		[conversationId, role],
	);
}

describe('the seed consumer on a fresh instance', () => {
	let db: Db;

	beforeAll(async () => {
		({ db } = await createUnsetTestApp());
	});

	afterEach(async () => {
		resetRuntimeConfig();
		await db.query('DELETE FROM chat_messages');
		await db.query('DELETE FROM chat_conversations');
		await db.query('DELETE FROM projects WHERE is_internal = false');
		await db.query('DELETE FROM teams WHERE id <> $1', [DEFAULT_TEAM_ID]);
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

	describe('pendingSeedBrief', () => {
		it('offers nothing without a seeded brief', async () => {
			withSeed(null);
			expect(await pendingSeedBrief(db)).toBeNull();
			withSeed({ locale: SEED.locale });
			expect(await pendingSeedBrief(db)).toBeNull();
		});

		it('offers the brief on a fresh instance, without writing anything', async () => {
			withSeed(SEED);
			expect(await pendingSeedBrief(db)).toBe(BRIEF);
			// Offering is a read: asking twice offers it twice.
			expect(await pendingSeedBrief(db)).toBe(BRIEF);
			expect(await getSystemMeta(db, SEED_PROJECT_CONSUMED_KEY)).toBeNull();
			const tasks = await db.query<{ count: number }>('SELECT count(*)::int AS count FROM tasks');
			expect(tasks.rows[0].count).toBe(0);
		});

		it('stops offering once an earlier release turned the brief into an intake task', async () => {
			withSeed(SEED);
			await setSystemMeta(db, SEED_PROJECT_CONSUMED_KEY, new Date().toISOString());
			expect(await pendingSeedBrief(db)).toBeNull();
		});

		it('stops offering once a project exists', async () => {
			withSeed(SEED);
			const team = await db.query<{ id: string }>(
				`INSERT INTO teams (name, slug) VALUES ('Gym', 'gym') RETURNING id`,
			);
			await db.query(
				`INSERT INTO projects (team_id, name, slug, task_prefix) VALUES ($1, 'Gym', 'gym', 'GYM')`,
				[team.rows[0].id],
			);
			expect(await pendingSeedBrief(db)).toBeNull();
		});

		it('stops offering once the admin has written to the CEO', async () => {
			withSeed(SEED);
			// A CEO line alone is not the admin speaking.
			await postHqChatMessage(db, ChatMessageRole.Assistant);
			expect(await pendingSeedBrief(db)).toBe(BRIEF);
			await postHqChatMessage(db, ChatMessageRole.User);
			expect(await pendingSeedBrief(db)).toBeNull();
		});
	});
});
