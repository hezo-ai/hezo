import { createHash } from 'node:crypto';
import type { ApprovalHandler, ApprovalSideEffectCtx, SideEffectBroadcast } from './types';

/** Persist an approved skill proposal into `skills` + a new `skill_revisions` row. */
export const skillProposalHandler: ApprovalHandler = {
	async applyApproved(ctx: ApprovalSideEffectCtx): Promise<SideEffectBroadcast[]> {
		const { db, approval, payload } = ctx;

		const slug = payload.skill_slug as string;
		const name = payload.skill_name as string;
		const content = payload.content as string;
		const contentHash = createHash('sha256').update(content).digest('hex');
		const requestedBy =
			(payload.requested_by as string) ?? (approval.requested_by_member_id as string) ?? null;

		// Skills are global. Write to DB (source of truth).
		const skillResult = await db.query<{ id: string }>(
			`INSERT INTO skills (name, slug, description, content, content_hash, created_by_member_id)
			 VALUES ($1, $2, $3, $4, $5, $6)
			 ON CONFLICT (slug) DO UPDATE SET
			   content = EXCLUDED.content,
			   content_hash = EXCLUDED.content_hash,
			   updated_at = now()
			 RETURNING id`,
			[name, slug, (payload.reason as string) ?? '', content, contentHash, requestedBy],
		);

		if (skillResult.rows[0]) {
			await db.query(
				`INSERT INTO skill_revisions (skill_id, revision_number, content, content_hash, change_summary, author_member_id)
				 VALUES ($1, (SELECT COALESCE(MAX(revision_number), 0) + 1 FROM skill_revisions WHERE skill_id = $1), $2, $3, 'Created via approval', $4)`,
				[skillResult.rows[0].id, content, contentHash, requestedBy],
			);
		}

		return [];
	},
};
