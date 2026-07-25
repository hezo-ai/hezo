import {
	ActionCommentKind,
	type ApprovalStatus,
	ApprovalType,
	CommentContentType,
	ApprovalStatus as Status,
	WakeupSource,
} from '@hezo/shared';
import type { Db } from '../db/database';
import { broadcastCommentFamilyChange } from '../lib/broadcast';
import { logger } from '../logger';
import { createWakeup } from './wakeup';
import type { WebSocketManager } from './ws';

const log = logger.child('goal-suggestion');

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
 * Post a goal-suggestion comment on the ticket that prompted it. Renders as an
 * `action` comment (`kind: 'goal_suggestion'`) carrying the approval id, so the
 * task thread shows the pending suggestion (with Approve/Deny) alongside the
 * project's Goals page — and flips to created/denied once the approval resolves.
 * Idempotent per `(task, approval)`.
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
	const { taskId, approvalId, payload, teamId, projectId } = params;

	const existing = await db.query<{ id: string }>(
		`SELECT id FROM task_comments
		 WHERE task_id = $1
		   AND content_type = $2::comment_content_type
		   AND content->>'kind' = $3
		   AND content->>'approval_id' = $4
		 LIMIT 1`,
		[taskId, CommentContentType.Action, ActionCommentKind.GoalSuggestion, approvalId],
	);
	if (existing.rows.length > 0) return null;

	const content = {
		kind: ActionCommentKind.GoalSuggestion,
		approval_id: approvalId,
		...buildContentSnapshot(payload),
	};
	const inserted = await db.query<Record<string, unknown>>(
		`INSERT INTO task_comments (task_id, content_type, content)
		 VALUES ($1, $2::comment_content_type, $3::jsonb)
		 RETURNING *`,
		[taskId, CommentContentType.Action, JSON.stringify(content)],
	);
	const row = inserted.rows[0] ?? null;
	if (row) {
		broadcastCommentFamilyChange(wsManager, teamId, projectId, 'task_comments', 'INSERT', row);
	}
	return row;
}

type GoalResolution = typeof ApprovalStatus.Approved | typeof ApprovalStatus.Denied;

/**
 * Flip the goal-suggestion comment(s) for an approval to created/denied and re-wake
 * the suggesting agent so it can react. Best-effort: a failure here must not roll
 * back an already-created goal.
 */
export async function resolveGoalSuggestionCommentAndWake(
	db: Db,
	params: {
		approval: Record<string, unknown>;
		status: GoalResolution;
		goalId?: string | null;
		resolutionNote?: string | null;
	},
	wsManager?: WebSocketManager,
): Promise<void> {
	const { approval, status, goalId, resolutionNote } = params;
	const approvalId = approval.id as string;
	const teamId = approval.team_id as string;
	const payload = (approval.payload ?? {}) as Record<string, unknown>;
	const taskId = typeof payload.task_id === 'string' ? payload.task_id : null;
	if (!taskId) return;

	try {
		const project = await db.query<{ project_id: string }>(
			'SELECT project_id FROM tasks WHERE id = $1',
			[taskId],
		);
		const projectId = project.rows[0]?.project_id ?? null;

		const chosen: Record<string, unknown> = {
			status,
			resolved_at: new Date().toISOString(),
		};
		if (goalId) chosen.goal_id = goalId;
		if (resolutionNote) chosen.resolution_note = resolutionNote;

		const contentPatch = buildContentSnapshot(payload);

		const updated = await db.query<Record<string, unknown>>(
			`UPDATE task_comments
			 SET content = content || $1::jsonb,
			     chosen_option = $2::jsonb
			 WHERE content_type = $3::comment_content_type
			   AND content->>'kind' = $4
			   AND content->>'approval_id' = $5
			   AND chosen_option IS NULL
			 RETURNING *`,
			[
				JSON.stringify(contentPatch),
				JSON.stringify(chosen),
				CommentContentType.Action,
				ActionCommentKind.GoalSuggestion,
				approvalId,
			],
		);
		if (projectId) {
			for (const row of updated.rows) {
				broadcastCommentFamilyChange(wsManager, teamId, projectId, 'task_comments', 'UPDATE', row);
			}
		}

		const requestedBy = approval.requested_by_member_id as string | null;
		if (requestedBy) {
			const isAgent = await db.query('SELECT id FROM member_agents WHERE id = $1', [requestedBy]);
			if (isAgent.rows.length > 0) {
				await createWakeup(
					db,
					requestedBy,
					teamId,
					WakeupSource.Automation,
					{ task_id: taskId, approval_id: approvalId, reason: 'goal_suggestion_resolved', status },
					`goal-suggestion-resolved:${approvalId}`,
				);
			}
		}
	} catch (e) {
		log.error('Failed to resolve goal-suggestion comment / wake requester:', e);
	}
}
