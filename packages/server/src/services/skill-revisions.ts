import { createHash } from 'node:crypto';
import type { SkillRecord, SkillRevisionRecord } from '@hezo/shared';
import type { Db } from '../db/database';
import { withTransaction } from '../lib/sql';

// Skill revisions mirror the document/agent-prompt revision model (see
// `services/documents.ts`): every time a skill's content changes we snapshot the
// *prior* content, so the revision list is the history of past versions and the
// current content lives only on the `skills` row. Restore re-snapshots the
// current content and then sets the skill back to the chosen revision. Skills are
// instance-global and admin-managed, so there is no project/team scope here.

/**
 * Record a snapshot of `priorContent` as the next revision of a skill — but only
 * when it actually differs from `newContent`. Call this *after* writing the new
 * content, passing the content that was there before the write. A no-op on first
 * creation (the caller passes `null` when the skill did not previously exist).
 */
export async function recordSkillRevisionIfChanged(
	db: Db,
	skillId: string,
	priorContent: string | null,
	newContent: string,
	changeSummary: string,
	authorMemberId: string | null,
): Promise<void> {
	if (priorContent === null || priorContent === newContent) return;
	await recordSkillRevision(db, skillId, priorContent, changeSummary, authorMemberId);
}

async function recordSkillRevision(
	db: Db,
	skillId: string,
	content: string,
	changeSummary: string,
	authorMemberId: string | null,
): Promise<number> {
	const next = await db.query<{ rev: number }>(
		'SELECT COALESCE(MAX(revision_number), 0)::int + 1 AS rev FROM skill_revisions WHERE skill_id = $1',
		[skillId],
	);
	const revisionNumber = next.rows[0].rev;
	const hash = createHash('sha256').update(content).digest('hex');
	await db.query(
		`INSERT INTO skill_revisions (skill_id, revision_number, content, content_hash, change_summary, author_member_id)
		 VALUES ($1, $2, $3, $4, $5, $6)`,
		[skillId, revisionNumber, content, hash, changeSummary, authorMemberId],
	);
	return revisionNumber;
}

export async function listSkillRevisions(db: Db, skillId: string): Promise<SkillRevisionRecord[]> {
	const result = await db.query<SkillRevisionRecord>(
		`SELECT r.id, r.revision_number, r.content, r.change_summary, r.created_at,
		        COALESCE(ma.title, m.display_name) AS author_name,
		        CASE WHEN ma.id IS NOT NULL THEN 'agent' ELSE 'admin' END AS author_type
		 FROM skill_revisions r
		 LEFT JOIN members m ON m.id = r.author_member_id
		 LEFT JOIN member_agents ma ON ma.id = r.author_member_id
		 WHERE r.skill_id = $1
		 ORDER BY r.revision_number DESC`,
		[skillId],
	);
	return result.rows;
}

/**
 * Restore a skill to an earlier revision: snapshot the current content as a new
 * revision, then overwrite the skill with the chosen revision's content. Returns
 * the updated skill row, or `null` if the skill or revision does not exist.
 */
export async function restoreSkillRevision(
	db: Db,
	skillId: string,
	revisionNumber: number,
	restoredByMemberId: string | null,
): Promise<SkillRecord | null> {
	const skill = await db.query<{ content: string }>('SELECT content FROM skills WHERE id = $1', [
		skillId,
	]);
	if (skill.rows.length === 0) return null;
	const target = await db.query<{ content: string }>(
		'SELECT content FROM skill_revisions WHERE skill_id = $1 AND revision_number = $2',
		[skillId, revisionNumber],
	);
	if (target.rows.length === 0) return null;

	return await withTransaction(db, async () => {
		await recordSkillRevision(
			db,
			skillId,
			skill.rows[0].content,
			`Restored to revision ${revisionNumber}`,
			restoredByMemberId,
		);
		const hash = createHash('sha256').update(target.rows[0].content).digest('hex');
		const updated = await db.query<SkillRecord>(
			`UPDATE skills
			 SET content = $1, content_hash = $2, updated_at = now()
			 WHERE id = $3
			 RETURNING *`,
			[target.rows[0].content, hash, skillId],
		);
		return updated.rows[0];
	});
}
