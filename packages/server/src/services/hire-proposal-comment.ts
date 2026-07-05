import {
	ActionCommentKind,
	type ApprovalStatus,
	CommentContentType,
	WakeupSource,
} from '@hezo/shared';
import type { Db } from '../db/database';
import { broadcastCommentFamilyChange } from '../lib/broadcast';
import { logger } from '../logger';
import { createWakeup } from './wakeup';
import type { WebSocketManager } from './ws';

const log = logger.child('hire-proposal-comment');

/** Resolution carried in a hire-proposal comment's `chosen_option.status`. */
type HireResolution = typeof ApprovalStatus.Approved | typeof ApprovalStatus.Denied;

/**
 * The display snapshot stored in a hire-proposal action comment's `content`.
 * Mirrors the editable hire spec (the agent's full system prompt is intentionally
 * omitted — too long for the inline card; the admin reviews it on the hire page).
 */
function buildContentSnapshot(payload: Record<string, unknown>): Record<string, unknown> {
	return {
		title: payload.title,
		slug: payload.slug,
		role_description: payload.role_description ?? '',
		monthly_budget_cents: payload.monthly_budget_cents ?? 0,
		heartbeat_interval_min: payload.heartbeat_interval_min ?? null,
		touches_code: payload.touches_code ?? false,
	};
}

/**
 * Post a hire-proposal comment on the ticket that prompted the hire. Renders as an
 * `action` comment (`kind: 'hire_proposal'`) carrying the approval id, so the task
 * thread shows the pending proposal alongside the admin inbox — and flips to
 * hired/denied once the approval resolves. Modelled on the `setup_repo`
 * approval-linked action comment in `repo-setup.ts`.
 *
 * Idempotent per `(task, approval)`: a second call for the same proposal reuses the
 * existing comment rather than duplicating it.
 */
export async function insertHireProposalComment(
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
		[taskId, CommentContentType.Action, ActionCommentKind.HireProposal, approvalId],
	);
	if (existing.rows.length > 0) return null;

	const content = {
		kind: ActionCommentKind.HireProposal,
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

/**
 * Resolve the hire-proposal comment(s) for an approval (flip the rendering to
 * hired/denied via `chosen_option`) and queue the requesting agent to run again so
 * it can review the decision and resume setup. Runs for both approve and deny.
 *
 * The comment broadcast goes through `broadcastCommentFamilyChange` (which injects
 * `project_id`) rather than the approval side-effect path, because bare
 * `task_comments` rows carry no team/project key and never render live otherwise.
 *
 * Best-effort: a failure here must not roll back an already-applied approval (the
 * agent is already created), so the whole body is caught and logged.
 */
export async function resolveHireProposalCommentAndWake(
	db: Db,
	params: {
		approval: Record<string, unknown>;
		status: HireResolution;
		memberAgentSlug?: string | null;
		resolutionNote?: string | null;
	},
	wsManager?: WebSocketManager,
): Promise<void> {
	const { approval, status, memberAgentSlug, resolutionNote } = params;
	const approvalId = approval.id as string;
	const teamId = approval.team_id as string;
	const payload = (approval.payload ?? {}) as Record<string, unknown>;
	const taskId = typeof payload.task_id === 'string' ? payload.task_id : null;
	// No originating ticket → nothing to render or resume against.
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
		if (memberAgentSlug) chosen.member_agent_slug = memberAgentSlug;
		if (resolutionNote) chosen.resolution_note = resolutionNote;

		// Refresh the display snapshot from the (possibly admin-edited) final payload
		// so the resolved card shows the title/spec that was actually approved.
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
				ActionCommentKind.HireProposal,
				approvalId,
			],
		);
		if (projectId) {
			for (const row of updated.rows) {
				broadcastCommentFamilyChange(wsManager, teamId, projectId, 'task_comments', 'UPDATE', row);
			}
		}

		const targetMemberId = await resolveWakeTarget(
			db,
			approval.requested_by_member_id as string | null,
			taskId,
		);
		if (targetMemberId) {
			await createWakeup(
				db,
				targetMemberId,
				teamId,
				WakeupSource.Automation,
				{ task_id: taskId, approval_id: approvalId, reason: 'hire_resolved', status },
				`hire-resolved:${approvalId}`,
			);
		}
	} catch (e) {
		log.error('Failed to resolve hire-proposal comment / wake requester:', e);
	}
}

/**
 * Who to re-wake when a hire resolves: the agent that requested the hire (the CEO
 * in the onboarding flow), falling back to the ticket's assignee. Either must be an
 * agent — a human requester (REST onboard by a superuser) has nothing to resume.
 */
async function resolveWakeTarget(
	db: Db,
	requestedByMemberId: string | null,
	taskId: string,
): Promise<string | null> {
	if (requestedByMemberId && (await isAgent(db, requestedByMemberId))) {
		return requestedByMemberId;
	}
	const task = await db.query<{ assignee_id: string | null }>(
		'SELECT assignee_id FROM tasks WHERE id = $1',
		[taskId],
	);
	const assigneeId = task.rows[0]?.assignee_id ?? null;
	if (assigneeId && (await isAgent(db, assigneeId))) return assigneeId;
	return null;
}

async function isAgent(db: Db, memberId: string): Promise<boolean> {
	const r = await db.query('SELECT id FROM member_agents WHERE id = $1', [memberId]);
	return r.rows.length > 0;
}
