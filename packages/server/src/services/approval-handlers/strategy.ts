import { DocumentType } from '@hezo/shared';
import { logger } from '../../logger';
import { upsertDocument } from '../documents';
import type { ApprovalHandler, ApprovalSideEffectCtx, SideEffectBroadcast } from './types';

const log = logger.child('approvals');

/** Apply an approved strategy action — today only the `update_prd` document write. */
export const strategyHandler: ApprovalHandler = {
	async applyApproved(ctx: ApprovalSideEffectCtx): Promise<SideEffectBroadcast[]> {
		const { db, approval, payload } = ctx;
		const broadcasts: SideEffectBroadcast[] = [];

		if (
			typeof payload.action === 'string' &&
			payload.action === 'update_prd' &&
			typeof payload.filename === 'string' &&
			typeof payload.content === 'string' &&
			typeof payload.project_id === 'string'
		) {
			const requestedBy = (approval.requested_by_member_id as string) ?? null;
			const doc = await upsertDocument(db, undefined, {
				scope: {
					type: DocumentType.ProjectDoc,
					teamId: approval.team_id as string,
					projectId: payload.project_id,
					slug: payload.filename,
				},
				content: payload.content,
				authorMemberId: requestedBy,
			});
			// The doc was archived between the agent filing this approval and the
			// admin resolving it. An archived doc is read-only, so the write is
			// dropped rather than resurrecting retired content. Not an exception:
			// `applyApproved` runs after the approval row is already `approved`
			// (see approval-resolve.ts), so throwing here would leave a resolved
			// but unapplied approval and a 500.
			if (doc.status === 'archived') {
				log.warn(
					`Approval ${approval.id as string}: skipped update_prd write - '${payload.filename}' is archived; restore it and re-file the change.`,
				);
				return broadcasts;
			}
			broadcasts.push({
				table: 'documents',
				op: 'UPDATE',
				row: doc.row as unknown as Record<string, unknown>,
			});
		}

		return broadcasts;
	},
};
