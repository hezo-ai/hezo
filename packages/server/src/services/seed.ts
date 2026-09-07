import { runtimeConfig } from '../config/runtime';
import type { Db } from '../db/database';
import {
	deleteSystemMeta,
	getInstanceLocale,
	instanceLocaleIsConfigured,
	setInstanceLocale,
} from '../lib/system-meta';
import { logger } from '../logger';
import { createProjectIntake, type ProjectIntakeResult } from './project-intake';
import type { WebSocketManager } from './ws';

const log = logger.child('seed');

/**
 * What the `seed` block of the config file turns into, and when.
 *
 * A provisioner that stands an instance up on someone's behalf writes the
 * language they chose and the brief they typed into the config file (H24).
 * This module is the one consumer of that block: the locale lands in
 * `system_meta` at boot, the brief opens a CEO intake at the first unlock, and
 * each happens once. Both read the config inside the function, never at module
 * scope, and both are no-ops on an instance whose file carries no `seed`.
 */

/**
 * The `system_meta` marker that says the seeded brief has been turned into an
 * intake. Present means done; its value is when. Lives in the tenant's own
 * database, so it survives a restart and a rebuilt host, and goes with the
 * database when that is wiped - which is the one case a seed applies again.
 */
export const SEED_PROJECT_CONSUMED_KEY = 'seed_project:consumed';

/** The title a seeded intake falls back to when the brief yields no usable sentence. */
export const DEFAULT_SEED_PROJECT_NAME = 'New project';

/** Longest derived project name, in code points. A title, not a slug. */
export const SEED_PROJECT_NAME_MAX_CHARS = 60;

/** Sentence enders, Latin and CJK; a newline ends a sentence too. */
const SENTENCE_END = /[.!?。！？\n\r]/;

/**
 * Characters a brief's first sentence must not carry into a task title: the
 * Markdown and mention syntax the CEO acts on (`#`, `@`, backticks) and every
 * control character. Stripped rather than refused, since the title is only a
 * placeholder the CEO replaces.
 */
function isTitleSafe(char: string): boolean {
	const code = char.codePointAt(0) ?? 0;
	if (code < 0x20 || code === 0x7f) return false;
	return char !== '#' && char !== '@' && char !== '`';
}

/**
 * A placeholder project name from a brief: its first sentence, stripped of
 * anything that would read as syntax in a title, capped at a word boundary.
 *
 * Only ever a ticket title and the bold text in the greeting. The seeded task
 * body tells the CEO to propose a real name the admin confirms, because a
 * derived one is not fit to become a slug: `toSlug` drops every non-ASCII
 * letter, so a German sentence loses its umlauts and a Japanese one slugs to
 * nothing at all.
 */
export function deriveProjectName(description: string): string {
	const firstSentence = description.trim().split(SENTENCE_END)[0] ?? '';
	const cleaned = Array.from(firstSentence)
		.filter(isTitleSafe)
		.join('')
		.replace(/\s+/g, ' ')
		.trim();
	if (cleaned.length === 0) return DEFAULT_SEED_PROJECT_NAME;

	const chars = Array.from(cleaned);
	if (chars.length <= SEED_PROJECT_NAME_MAX_CHARS) return cleaned;
	const capped = chars.slice(0, SEED_PROJECT_NAME_MAX_CHARS).join('');
	const lastSpace = capped.lastIndexOf(' ');
	// Cut at the last word boundary inside the cap, unless that leaves too
	// little to read as a title; then a mid-word cut is the lesser harm.
	const atWord = lastSpace >= SEED_PROJECT_NAME_MAX_CHARS / 2 ? capped.slice(0, lastSpace) : capped;
	return atWord.trim();
}

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
 * Open the CEO intake for the seeded brief, once.
 *
 * Registered on the master-key unlock hook, which fires at the first setup and
 * again at every later unlock. The marker is written first, as a conditional
 * insert, and only the caller that inserted it proceeds: two unlocks, or two
 * processes against one database, cannot open two intakes. The intake needs
 * only HQ and an enabled CEO, both seeded at boot before any key exists, so
 * the brief is waiting on the home screen by the time setup completes.
 *
 * A failure gives the marker back: `createProjectIntake` answers null when
 * the CEO or HQ is missing, and either that or a thrown error deletes the
 * marker and logs, so the next unlock tries again - one attempt per unlock,
 * visible in the log, and no second mechanism.
 *
 * Returns the intake it opened, or null when there was nothing to do.
 */
export async function consumeSeedProject(
	db: Db,
	wsManager?: WebSocketManager,
): Promise<ProjectIntakeResult | null> {
	const seed = runtimeConfig().seed;
	if (!seed?.project) return null;

	const claimed = await db.query<{ key: string }>(
		`INSERT INTO system_meta (key, value) VALUES ($1, $2)
		 ON CONFLICT (key) DO NOTHING
		 RETURNING key`,
		[SEED_PROJECT_CONSUMED_KEY, new Date().toISOString()],
	);
	if (claimed.rows.length === 0) return null;

	const { description } = seed.project;
	let intake: ProjectIntakeResult | null;
	try {
		// The instance locale is what the seed (or the setup request) wrote, and
		// it is the language the admin reads: the CEO is asked to answer in it.
		const { language } = await getInstanceLocale(db);
		intake = await createProjectIntake(
			db,
			{
				origin: 'seed',
				name: deriveProjectName(description),
				description,
				initialProjectPlan: null,
				adminLanguage: language,
			},
			wsManager,
		);
	} catch (err) {
		await deleteSystemMeta(db, SEED_PROJECT_CONSUMED_KEY);
		throw err;
	}
	if (!intake) {
		await deleteSystemMeta(db, SEED_PROJECT_CONSUMED_KEY);
		log.error(
			'The seeded project brief could not open its intake (no enabled CEO or HQ project); it will be tried again at the next unlock',
		);
		return null;
	}
	log.info(`Opened the seeded project intake ${intake.intakeTaskIdentifier}`);
	return intake;
}
