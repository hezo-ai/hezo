import { ChatMessageRole } from '@hezo/shared';
import { runtimeConfig } from '../config/runtime';
import type { Db } from '../db/database';
import { getSystemMeta, instanceLocaleIsConfigured, setInstanceLocale } from '../lib/system-meta';
import { logger } from '../logger';

const log = logger.child('seed');

/**
 * What the `seed` block of the config file turns into, and when.
 *
 * A provisioner that stands an instance up on someone's behalf writes the
 * language they chose and the brief they typed into the config file (H24).
 * This module is the one consumer of that block: the locale lands in
 * `system_meta` at boot, once, and the brief is offered on the home screen's
 * CEO chat until the admin sends it, creates a first project, or writes to the
 * CEO first. Both read the config inside the function, never at module scope,
 * and both are no-ops on an instance whose file carries no `seed`.
 */

/**
 * The `system_meta` marker an earlier release wrote when it opened a CEO intake
 * task for the seeded brief. Read only: an instance that already turned its
 * brief into that task is not offered the brief a second time.
 */
export const SEED_PROJECT_CONSUMED_KEY = 'seed_project:consumed';

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
 * The seeded brief, while it is still worth offering; otherwise null.
 *
 * The home screen's CEO chat offers it as a one-tap first message. It stops
 * being offered once any of these holds: an earlier release already opened an
 * intake task for it, a project exists, or the admin has written in an HQ
 * conversation. No marker is written: the conditions are the record.
 *
 * Read on the CEO chat's default-thread fetch. The checks run cheapest first
 * and only while a brief is configured; the project check settles it for good
 * once the first project exists, so the message check needs no index of its own.
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
