import { DocumentType } from '@hezo/shared';
import { upsertDocument } from '../documents';
import type { ApprovalHandler, ApprovalSideEffectCtx, SideEffectBroadcast } from './types';

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
			broadcasts.push({
				table: 'documents',
				op: 'UPDATE',
				row: doc as unknown as Record<string, unknown>,
			});
		}

		return broadcasts;
	},
};
