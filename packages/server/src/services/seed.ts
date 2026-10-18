import { ChatChannel, ChatMessageRole } from '@hezo/shared';
import { runtimeConfig } from '../config/runtime';
import type { Db } from '../db/database';
import {
	deleteSystemMeta,
	getSystemMeta,
	instanceLocaleIsConfigured,
	setInstanceLocale,
	setSystemMeta,
} from '../lib/system-meta';
import { logger } from '../logger';
import type { ChatSessionManager } from './chat-session-manager';
import { getSuperuserId } from './superuser';

const log = logger.child('seed');

/**
 * What the `seed` block of the config file turns into, and when.
 *
 * A provisioner that stands an instance up on someone's behalf writes the
 * language they chose and the brief they typed into the config file (H24).
 * This module is the one consumer of that block: the locale lands in
 * `system_meta` at boot, once, and the brief is sent to the CEO chat as the
 * admin's first message as soon as the CEO can answer it. Both read the config
 * inside the function, never at module scope, and both are no-ops on an
 * instance whose file carries no `seed`.
 */

/**
 * The `system_meta` marker that claims the seeded brief, so it reaches the CEO
 * once. An earlier release wrote the same key when it turned the brief into an
 * intake task, and an instance carrying it from then is not sent the brief again.
 */
export const SEED_PROJECT_CONSUMED_KEY = 'seed_project:consumed';

/** The claim's value while a send is under way; a finished send stamps the time. */
export const SEED_BRIEF_SENDING = 'sending';

/**
 * What the CEO is told, for its first reply only, about the message that opens
 * the chat. Never stored: the admin's message is the brief exactly as typed.
 */
export const SEED_BRIEF_CONTEXT =
	'The admin wrote this first message on the Hezo website when signing up, before this instance existed. It names no project and no team. Treat it as a new project request: propose a project name and a team.';

/**
 * Write the seeded locale into `system_meta`, once.
 *
 * Runs at boot, after the default team is seeded and before the app serves a
 * request, so `/api/status` reports `localeConfigured: true` from the first
 * call and every browser adopts the instance's language instead of its own.
 * Never overwrites a locale someone chose: "configured" is the same predicate
 * the settings page reads, so a language saved from the gate or from Settings
 * wins over the file for the life of the instance.
 *
 * Returns whether it wrote anything.
 */
export async function applySeedLocale(db: Db): Promise<boolean> {
	const seed = runtimeConfig().seed;
	if (!seed?.locale) return false;
	if (await instanceLocaleIsConfigured(db)) return false;
	await setInstanceLocale(db, seed.locale);
	log.info(`Applied the seeded locale (${seed.locale.language})`);
	return true;
}

/**
 * The seeded brief, while it is still worth sending; otherwise null.
 *
 * It stops being worth sending once any of these holds: it was already sent
 * (the claim marker), a project exists, or the admin has written in an HQ
 * conversation.
 *
 * The checks run cheapest first and only while a brief is configured; the
 * project check settles it for good once the first project exists, so the
 * message check needs no index of its own.
 */
export async function pendingSeedBrief(db: Db): Promise<string | null> {
	const brief = runtimeConfig().seed?.project?.description;
	if (!brief) return null;
	if ((await getSystemMeta(db, SEED_PROJECT_CONSUMED_KEY)) !== null) return null;
	const r = await db.query<{ settled: boolean }>(
		`SELECT EXISTS (SELECT 1 FROM projects WHERE is_internal = false)
		     OR EXISTS (
		          SELECT 1 FROM chat_messages m
		          JOIN chat_conversations c ON c.id = m.conversation_id
		          JOIN projects p ON p.id = c.project_id
		          WHERE p.is_internal = true AND m.role = $1
		        ) AS settled`,
		[ChatMessageRole.User],
	);
	return r.rows[0]?.settled ? null : brief;
}

/**
 * Send the seeded brief to the CEO chat as the admin's first message, once.
 *
 * Called when a model credential is stored and when the instance unlocks: the
 * CEO can answer only once a credential exists, and on a hosted box the admin
 * adds one after unlocking. Waits, sending nothing, while the CEO cannot start
 * a turn, because the chat stores a message before it checks the credential.
 * The marker claim makes concurrent callers send it once; a send that throws
 * gives the claim back, so the next trigger tries again, and a process that
 * dies mid-send leaves it marked as sending for the next boot to release.
 *
 * Returns whether it sent the brief.
 */
export async function deliverSeedBrief(
	db: Db,
	manager: Pick<ChatSessionManager, 'ceoTurnBlocker' | 'sendTurn'>,
): Promise<boolean> {
	const brief = await pendingSeedBrief(db);
	if (!brief) return false;
	if (await manager.ceoTurnBlocker()) return false;

	const claimed = await db.query<{ key: string }>(
		`INSERT INTO system_meta (key, value) VALUES ($1, $2)
		 ON CONFLICT (key) DO NOTHING
		 RETURNING key`,
		[SEED_PROJECT_CONSUMED_KEY, SEED_BRIEF_SENDING],
	);
	if (claimed.rows.length === 0) return false;

	try {
		await manager.sendTurn({
			text: brief,
			channel: ChatChannel.Web,
			authorUserId: await getSuperuserId(db),
			injectedContext: SEED_BRIEF_CONTEXT,
		});
	} catch (err) {
		await deleteSystemMeta(db, SEED_PROJECT_CONSUMED_KEY);
		throw err;
	}
	await setSystemMeta(db, SEED_PROJECT_CONSUMED_KEY, new Date().toISOString());
	log.info('Sent the seeded brief to the CEO chat');
	return true;
}

/**
 * Release a claim a process left mid-send. Runs at boot, before anything can
 * send, so a claim still marked as sending belongs to a process that died
 * between the claim and the message. When the message was stored first, the
 * admin-message check in `pendingSeedBrief` still stops a second send.
 *
 * Returns whether it released one.
 */
export async function releaseInterruptedSeedBrief(db: Db): Promise<boolean> {
	const r = await db.query<{ key: string }>(
		'DELETE FROM system_meta WHERE key = $1 AND value = $2 RETURNING key',
		[SEED_PROJECT_CONSUMED_KEY, SEED_BRIEF_SENDING],
	);
	if (r.rows.length === 0) return false;
	log.warn('Released a seeded-brief send that a previous run left unfinished');
	return true;
}
