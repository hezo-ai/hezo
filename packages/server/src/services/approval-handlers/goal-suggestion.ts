import { ApprovalStatus } from '@hezo/shared';
import { logger } from '../../logger';
import {
	type GoalSuggestionPayload,
	resolveGoalSuggestionCommentAndWake,
} from '../goal-suggestion';
import { createGoal } from '../goals';
import type { ApprovalHandler, ApprovalSideEffectCtx, SideEffectBroadcast } from './types';

const log = logger.child('approval-handlers:goal-suggestion');

/**
 * Materialise an approved goal suggestion: create the real `goals` row from the
 * suggestion payload, then flip the suggestion comment to "created" and re-wake the
 * suggesting agent. Denial flips the comment to "denied" and re-wakes too. The goal
 * is credited to the approving admin (the actor), falling back to the suggester.
 */
export const goalSuggestionHandler: ApprovalHandler = {
	async applyApproved(ctx: ApprovalSideEffectCtx): Promise<SideEffectBroadcast[]> {
		const { db, approval, payload, actorMemberId, wsManager } = ctx;
		const teamId = approval.team_id as string;
		const p = payload as unknown as GoalSuggestionPayload;

		let goalId: string | null = null;
		try {
			const goal = await createGoal(
				db,
				teamId,
				{
					project_id: p.project_id,
					title: p.title,
					measurement: p.measurement,
					actions: p.actions,
					check_frequency: p.check_frequency,
					target_date: p.target_date ?? null,
				},
				{ actorMemberId: actorMemberId ?? (approval.requested_by_member_id as string | null) },
				wsManager,
			);
			// createGoal already broadcasts the new goals row to the team room, so the
			// Goals page and suggestions list update live without a second broadcast.
			goalId = goal.id;
		} catch (e) {
			// A goal that can't be created (e.g. project deleted between suggest and
			// approve) must not wedge the approval — log and still resolve the comment.
			log.error('Failed to create goal from approved suggestion:', e);
		}

		await resolveGoalSuggestionCommentAndWake(
			db,
			{ approval, status: ApprovalStatus.Approved, goalId },
			wsManager,
		);
		return [];
	},

	async applyDenied(ctx: ApprovalSideEffectCtx): Promise<SideEffectBroadcast[]> {
		const { db, approval, resolutionNote, wsManager } = ctx;
		await resolveGoalSuggestionCommentAndWake(
			db,
			{ approval, status: ApprovalStatus.Denied, resolutionNote },
			wsManager,
		);
		return [];
	},
};
