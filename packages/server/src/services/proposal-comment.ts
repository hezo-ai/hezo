import { type ApprovalStatus, CommentContentType, WakeupSource } from '@hezo/shared';
import type { Db } from '../db/database';
import { broadcastCommentFamilyChange } from '../lib/broadcast';
import { logger } from '../logger';
import { createWakeup } from './wakeup';
import type { WebSocketManager } from './ws';

const log = logger.child('proposal-comment');

/** How a proposal-style approval was settled, as carried in `chosen_option.status`. */
export type ProposalResolution = typeof ApprovalStatus.Approved | typeof ApprovalStatus.Denied;

/**
 * What distinguishes one proposal-style approval from another.
 *
 * A proposal an agent files - a hire, a goal suggestion - is mirrored as an
 * `action` comment on the originating ticket so the thread shows it beside the
 * admin inbox, then flipped in place when the admin decides, and the agent that
 * filed it is woken to act on the decision. Everything about that is identical
 * across kinds; this record is the difference.
 */
export interface ProposalCommentSpec {
	/** The `action` comment kind, and the key both queries match on. */
	kind: string;
	/** `payload.reason` on the resolution wake; the run list reads it as the label. */
	wakeReason: string;
	/** Idempotency-key prefix for that wake, keyed by approval id. */
	wakeKeyPrefix: string;
	/**
	 * The display snapshot stored in the comment's `content`, projected from the
	 * approval payload. Re-projected on resolution so the settled card shows the
	 * spec that was actually approved, not the one first proposed.
	 */
	snapshot: (payload: Record<string, unknown>) => Record<string, unknown>;
	/**
	 * Fall back to the ticket's assignee when the requester is a human rather than
	 * an agent. True only where the proposal has a human entry point: the hire form
	 * is filed by a superuser but its ticket is the CEO's, and the CEO is who has
	 * something to resume.
	 */
	wakeTaskAssigneeWhenRequesterIsHuman: boolean;
}

/**
 * Post the proposal's `action` comment on the ticket that prompted it.
 *
 * Idempotent per `(task, approval)`: a second call for the same proposal reuses
 * the existing comment rather than duplicating it.
 */
export async function insertProposalComment(
	db: Db,
	spec: ProposalCommentSpec,
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
		[taskId, CommentContentType.Action, spec.kind, approvalId],
	);
	if (existing.rows.length > 0) return null;

	const content = {
		kind: spec.kind,
		approval_id: approvalId,
		...spec.snapshot(payload),
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
 * Flip the proposal's comment(s) to the admin's decision and wake the agent that
 * filed it, so it can act on the answer. Runs for both approve and deny.
 *
 * The wake goes out on `approval_resolved`, which the dispatch suppressions in
 * `no-work-backoff.ts` are exempt from. On the generic `automation` source they
 * were entitled to discard it, and an agent parked on its own proposal is
 * precisely the state both suppressions read as "nothing has changed".
 *
 * The comment broadcast goes through `broadcastCommentFamilyChange` (which
 * injects `project_id`) rather than the approval side-effect path, because bare
 * `task_comments` rows carry no team/project key and never render live otherwise.
 *
 * Best-effort: a failure here must not roll back an already-applied approval (the
 * agent, or the goal, is already created), so the whole body is caught and logged.
 */
export async function resolveProposalCommentAndWake(
	db: Db,
	spec: ProposalCommentSpec,
	params: {
		approval: Record<string, unknown>;
		status: ProposalResolution;
		/** Extra fields merged into `chosen_option`, e.g. the created agent or goal. */
		chosenExtra?: Record<string, unknown>;
		resolutionNote?: string | null;
	},
	wsManager?: WebSocketManager,
): Promise<void> {
	const { approval, status, chosenExtra, resolutionNote } = params;
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
			...(chosenExtra ?? {}),
		};
		if (resolutionNote) chosen.resolution_note = resolutionNote;

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
				JSON.stringify(spec.snapshot(payload)),
				JSON.stringify(chosen),
				CommentContentType.Action,
				spec.kind,
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
			spec,
			approval.requested_by_member_id as string | null,
			taskId,
		);
		if (targetMemberId) {
			await createWakeup(
				db,
				targetMemberId,
				teamId,
				WakeupSource.ApprovalResolved,
				{ task_id: taskId, approval_id: approvalId, reason: spec.wakeReason, status },
				`${spec.wakeKeyPrefix}:${approvalId}`,
			);
		}
	} catch (e) {
		log.error(`Failed to resolve ${spec.kind} comment / wake requester:`, e);
	}
}

/**
 * Who to wake when a proposal resolves: the agent that filed it, falling back
 * where the spec allows to the ticket's assignee. Either must be an agent - a
 * human requester has nothing to resume.
 */
async function resolveWakeTarget(
	db: Db,
	spec: ProposalCommentSpec,
	requestedByMemberId: string | null,
	taskId: string,
): Promise<string | null> {
	if (requestedByMemberId && (await isAgent(db, requestedByMemberId))) {
		return requestedByMemberId;
	}
	if (!spec.wakeTaskAssigneeWhenRequesterIsHuman) return null;
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
