import { withTransaction } from '../lib/sql';
import { getSystemMeta, setSystemMeta } from '../lib/system-meta';
import { logger } from '../logger';
import { recordSkillRevisionIfChanged } from '../services/skill-revisions';
import type { Db } from './database';
import type { DefaultSkillDef } from './default-skills';

const log = logger.child('seed-default-skills');

/**
 * system_meta marker per shipped skill. The value is the sha256 of the shipped
 * content that was last actually applied to the row — or FOREIGN_MARKER when
 * the slug was already taken by a user-authored global skill at first seed.
 */
export const DEFAULT_SKILL_MARKER_PREFIX = 'default_skill_shipped_hash:';
export const FOREIGN_MARKER = 'foreign';

/**
 * Seed the shipped default global skills with hash-gated upgrade semantics.
 * Runs on every startup (after `seedBuiltins`, see `runSeed` in startup.ts) and
 * is idempotent. The state machine per skill:
 *
 * - never seeded, no global row  → insert, record shipped hash.
 * - never seeded, row exists     → user-authored slug: mark FOREIGN, never touch.
 * - marker FOREIGN               → skip forever.
 * - marker set, row gone         → user deleted (or re-scoped it to a project,
 *                                  which removes the global row): never resurrect.
 * - marker == row hash, new ship → pristine row: apply the update, snapshot the
 *                                  prior content as a revision, advance marker.
 * - marker != row hash           → user edited: hands off forever. The marker is
 *                                  deliberately NOT advanced, so the comparison
 *                                  persists across releases. (The gate is
 *                                  content-hash based — a name-only user edit
 *                                  does not protect against a shipped update.)
 *
 * Only name/description/content/content_hash/source_url are ever written on
 * update; tags, is_active, auto_load, and scope stay untouched — they belong to
 * the operator.
 */
export async function seedDefaultSkills(db: Db, skills: DefaultSkillDef[]): Promise<void> {
	for (const def of skills) {
		try {
			await withTransaction(db, () => seedOne(db, def));
		} catch (err) {
			// One broken skill must not block the rest (or startup) — same
			// log-and-continue posture as runSeed itself.
			log.error(`Failed to seed default skill '${def.slug}':`, err);
		}
	}
}

async function seedOne(db: Db, def: DefaultSkillDef): Promise<void> {
	const markerKey = DEFAULT_SKILL_MARKER_PREFIX + def.slug;
	const marker = await getSystemMeta(db, markerKey);
	if (marker === FOREIGN_MARKER) return;

	const existing = await db.query<{ id: string; content: string; content_hash: string }>(
		'SELECT id, content, content_hash FROM skills WHERE slug = $1 AND project_id IS NULL',
		[def.slug],
	);
	const row = existing.rows[0];

	if (marker === null) {
		if (row) {
			// A user-authored global skill already owns this slug — never clobber
			// it, and never reconsider (deleting it later must not summon ours).
			await setSystemMeta(db, markerKey, FOREIGN_MARKER);
			return;
		}
		await db.query(
			`INSERT INTO skills (name, slug, description, content, source_url, content_hash, tags, project_id, created_by_member_id)
			 VALUES ($1, $2, $3, $4, $5, $6, '[]'::jsonb, NULL, NULL)
			 ON CONFLICT (slug) WHERE project_id IS NULL DO NOTHING`,
			[def.name, def.slug, def.description, def.content, def.sourceUrl, def.contentHash],
		);
		await setSystemMeta(db, markerKey, def.contentHash);
		return;
	}

	// Marker records a previously applied ship. Row gone → the operator deleted
	// or re-scoped it; stay gone.
	if (!row) return;

	// User edited the content since the last applied ship → theirs forever.
	if (row.content_hash !== marker) return;

	// Pristine row, same shipped content → idempotent no-op.
	if (def.contentHash === marker) return;

	// Pristine row, new shipped content → apply the upgrade and keep the prior
	// version reachable through the skill's revision history.
	await db.query(
		`UPDATE skills
		 SET name = $2, description = $3, content = $4, content_hash = $5, source_url = $6, updated_at = now()
		 WHERE id = $1`,
		[row.id, def.name, def.description, def.content, def.contentHash, def.sourceUrl],
	);
	await recordSkillRevisionIfChanged(
		db,
		row.id,
		row.content,
		def.content,
		'Updated by Hezo upgrade',
		null,
	);
	await setSystemMeta(db, markerKey, def.contentHash);
}
