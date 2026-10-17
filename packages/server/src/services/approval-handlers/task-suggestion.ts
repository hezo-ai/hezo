import {
	ApprovalStatus,
	AuditActorType,
	CAPTAIN_AGENT_SLUG,
	isRepeatingCadence,
	TASK_SUGGESTION_CADENCE_RULES,
} from '@hezo/shared';
import { terminalStatusParams } from '../../lib/sql';
import { logger } from '../../logger';
import { PLANNING_TASK_LABEL } from '../project-create';
import {
	resolveTaskSuggestionCommentAndWake,
	type TaskSuggestionPayload,
} from '../task-suggestion';
import { createTask } from '../tasks';
import type { ApprovalHandler, ApprovalSideEffectCtx, SideEffectBroadcast } from './types';

const log = logger.child('approval-handlers:task-suggestion');

/**
 * Materialise an approved task suggestion: create the task for the project's
 * Captain, then flip the card to "created" and re-wake the CEO. A repeating
 * choice becomes the task's standing-task rules. While the project's planning
 * task is still open the new task waits on it, so the Captain's plan sees every
 * approved task before any of them runs. Denial flips the card and re-wakes too.
 * The task is credited to the approving admin, falling back to the CEO.
 */
export const taskSuggestionHandler: ApprovalHandler = {
	async applyApproved(ctx: ApprovalSideEffectCtx): Promise<SideEffectBroadcast[]> {
		const { db, approval, payload, actorMemberId, wsManager, events } = ctx;
		const teamId = approval.team_id as string;
		const p = payload as unknown as TaskSuggestionPayload;

		let created: { id: string; identifier: string; blockedByIdentifier: string | null } | null =
			null;
		try {
			const captain = await db.query<{ id: string }>(
				`SELECT ma.id FROM member_agents ma JOIN members m ON m.id = ma.id
				 WHERE m.team_id = $1 AND ma.slug = $2`,
				[teamId, CAPTAIN_AGENT_SLUG],
			);
			if (!captain.rows[0]) throw new Error('the project has no Captain');

			const terminal = terminalStatusParams(3);
			const planning = await db.query<{ id: string; identifier: string }>(
				`SELECT id, identifier FROM tasks
				 WHERE project_id = $1 AND labels @> $2::jsonb
				   AND status NOT IN (${terminal.placeholders})
				 ORDER BY created_at ASC LIMIT 1`,
				[p.project_id, JSON.stringify([PLANNING_TASK_LABEL]), ...terminal.values],
			);
			const blocker = planning.rows[0] ?? null;

			const creditedTo = actorMemberId ?? (approval.requested_by_member_id as string | null);
			const task = await createTask(
				db,
				teamId,
				{
					project_id: p.project_id,
					title: p.title,
					description: p.description,
					assignee_id: captain.rows[0].id,
					rules: isRepeatingCadence(p.cadence)
						? TASK_SUGGESTION_CADENCE_RULES[p.cadence]
						: undefined,
					blocked_by_task_ids: blocker ? [blocker.id] : undefined,
				},
				{
					actorType: actorMemberId ? AuditActorType.Admin : AuditActorType.System,
					actorMemberId: creditedTo,
				},
				wsManager,
				events,
			);
			created = {
				id: task.id,
				identifier: task.identifier,
				blockedByIdentifier: blocker?.identifier ?? null,
			};
		} catch (e) {
			// A task that can't be created (the project gone between suggest and
			// approve, no Captain) must not wedge the approval: log and resolve.
			log.error('Failed to create task from approved suggestion:', e);
		}

		await resolveTaskSuggestionCommentAndWake(
			db,
			{ approval, status: ApprovalStatus.Approved, created },
			wsManager,
		);
		return [];
	},

	async applyDenied(ctx: ApprovalSideEffectCtx): Promise<SideEffectBroadcast[]> {
		const { db, approval, resolutionNote, wsManager } = ctx;
		await resolveTaskSuggestionCommentAndWake(
			db,
			{ approval, status: ApprovalStatus.Denied, resolutionNote },
			wsManager,
		);
		return [];
	},
};
