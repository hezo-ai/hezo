import { ActionCommentKind, ApprovalType, ApprovalStatus as Status } from '@hezo/shared';
import type { Db } from '../db/database';
import {
	insertProposalComment,
	type ProposalCommentSpec,
	type ProposalResolution,
	resolveProposalCommentAndWake,
} from './proposal-comment';
import type { WebSocketManager } from './ws';

/**
 * A Captain/CEO goal suggestion, carried in the pending `approvals` row's payload.
 * It is NOT a goal — the real `goals` row is created only when the admin approves
 * (see the `goal_suggestion` approval handler). Mirrors the hire-proposal flow.
 */
export interface GoalSuggestionPayload {
	project_id: string;
	title: string;
	measurement?: string;
	actions?: string;
	check_frequency?: string;
	target_date?: string | null;
	task_id?: string | null;
}

/** Insert a pending `goal_suggestion` approval carrying the proposed goal fields. */
export async function insertGoalSuggestionApproval(
	db: Db,
	teamId: string,
	payload: GoalSuggestionPayload,
	requestedByMemberId: string | null,
): Promise<Record<string, unknown>> {
	const result = await db.query<Record<string, unknown>>(
		`INSERT INTO approvals (team_id, type, requested_by_member_id, payload, status)
		 VALUES ($1, $2::approval_type, $3, $4::jsonb, $5::approval_status)
		 RETURNING *`,
		[
			teamId,
			ApprovalType.GoalSuggestion,
			requestedByMemberId,
			JSON.stringify(payload),
			Status.Pending,
		],
	);
	return result.rows[0];
}

/** The display snapshot stored in a goal-suggestion action comment's `content`. */
function buildContentSnapshot(payload: Record<string, unknown>): Record<string, unknown> {
	return {
		title: payload.title ?? '',
		measurement: payload.measurement ?? '',
		actions: payload.actions ?? '',
		check_frequency: payload.check_frequency ?? 'daily',
		target_date: payload.target_date ?? null,
	};
}

/**
 * A goal suggestion as a proposal-style approval.
 *
 * No assignee fallback: every goal suggestion is filed by an agent through
 * `suggest_goal`, so a requester that is not an agent means there is nobody with
 * a suggestion to resume.
 */
const GOAL_SUGGESTION: ProposalCommentSpec = {
	kind: ActionCommentKind.GoalSuggestion,
	wakeReason: 'goal_suggestion_resolved',
	wakeKeyPrefix: 'goal-suggestion-resolved',
	snapshot: buildContentSnapshot,
	wakeTaskAssigneeWhenRequesterIsHuman: false,
};

/**
 * Post a goal-suggestion comment on the ticket that prompted it. Renders as an
 * `action` comment (`kind: 'goal_suggestion'`) carrying the approval id, so the
 * task thread shows the pending suggestion (with Approve/Deny) alongside the
 * project's Goals page — and flips to created/denied once the approval resolves.
 */
export async function insertGoalSuggestionComment(
	db: Db,
	params: {
		taskId: string;
		approvalId: string;
		payload: Record<string, unknown>;
		teamId: string;
		projectId: string;
	},
	wsManager?: WebSocketManager,
): Promise<Record<string, unknown> | null> {
	return insertProposalComment(db, GOAL_SUGGESTION, params, wsManager);
}

/**
 * Flip the goal-suggestion comment(s) for an approval to created/denied and re-wake
 * the suggesting agent so it can react.
 */
export async function resolveGoalSuggestionCommentAndWake(
	db: Db,
	params: {
		approval: Record<string, unknown>;
		status: ProposalResolution;
		goalId?: string | null;
		resolutionNote?: string | null;
	},
	wsManager?: WebSocketManager,
): Promise<void> {
	const { approval, status, goalId, resolutionNote } = params;
	return resolveProposalCommentAndWake(
		db,
		GOAL_SUGGESTION,
		{
			approval,
			status,
			chosenExtra: goalId ? { goal_id: goalId } : undefined,
			resolutionNote,
		},
		wsManager,
	);
}
