import { createHash } from 'node:crypto';
import { recordSkillRevisionIfChanged } from '../skill-revisions';
import type { ApprovalHandler, ApprovalSideEffectCtx, SideEffectBroadcast } from './types';

/** Persist an approved skill proposal into `skills`, snapshotting any prior content. */
export const skillProposalHandler: ApprovalHandler = {
	async applyApproved(ctx: ApprovalSideEffectCtx): Promise<SideEffectBroadcast[]> {
		const { db, approval, payload } = ctx;

		const slug = payload.skill_slug as string;
		const name = payload.skill_name as string;
		const content = payload.content as string;
		const contentHash = createHash('sha256').update(content).digest('hex');
		const requestedBy =
			(payload.requested_by as string) ?? (approval.requested_by_member_id as string) ?? null;

		// The proposer chose the scope: 'global' (project_id null, shared with every
		// project) or 'project' (default) — private to the approval's project. A team
		// backs exactly one project (1:1), so resolve it from the approval's team.
		let targetProjectId: string | null = null;
		if (payload.scope !== 'global') {
			const proj = await db.query<{ id: string }>('SELECT id FROM projects WHERE team_id = $1', [
				approval.team_id as string,
			]);
			targetProjectId = proj.rows[0]?.id ?? null;
		}

		// Write to DB (source of truth). Upsert against the scope's partial index.
		const prior = await db.query<{ content: string }>(
			'SELECT content FROM skills WHERE slug = $1 AND project_id IS NOT DISTINCT FROM $2',
			[slug, targetProjectId],
		);
		const conflictTarget = targetProjectId
			? '(project_id, slug) WHERE project_id IS NOT NULL'
			: '(slug) WHERE project_id IS NULL';
		const skillResult = await db.query<{ id: string }>(
			`INSERT INTO skills (name, slug, description, content, content_hash, created_by_member_id, project_id)
			 VALUES ($1, $2, $3, $4, $5, $6, $7)
			 ON CONFLICT ${conflictTarget} DO UPDATE SET
			   content = EXCLUDED.content,
			   content_hash = EXCLUDED.content_hash,
			   updated_at = now()
			 RETURNING id`,
			[
				name,
				slug,
				(payload.reason as string) ?? '',
				content,
				contentHash,
				requestedBy,
				targetProjectId,
			],
		);

		if (skillResult.rows[0]) {
			await recordSkillRevisionIfChanged(
				db,
				skillResult.rows[0].id,
				prior.rows[0]?.content ?? null,
				content,
				'Updated via approval',
				requestedBy,
			);
		}

		return [];
	},
};
