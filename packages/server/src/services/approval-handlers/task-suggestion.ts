import {
	ApprovalStatus,
	AuditActorType,
	CAPTAIN_AGENT_SLUG,
	isRepeatingCadence,
	TASK_SUGGESTION_CADENCE_RULES,
} from '@hezo/shared';
import { terminalStatusParams } from '../../lib/sql';
import { PLANNING_TASK_LABEL } from '../project-create';
import {
	resolveTaskSuggestionCommentAndWake,
	type TaskSuggestionPayload,
} from '../task-suggestion';
import { CreateTaskError, createTask } from '../tasks';
import {
	type ApprovalHandler,
	type ApprovalSideEffectCtx,
	ApprovalSideEffectError,
	type SideEffectBroadcast,
} from './types';

/**
 * Materialise an approved task suggestion: create the task for the project's
 * Captain, then flip the card to "created" and re-wake the CEO. A repeating
 * choice becomes the task's standing-task rules. While the project's planning
 * task is still open the new task waits on it, so the Captain's plan sees every
 * approved task before any of them runs. Denial flips the card and re-wakes too.
 * The task is credited to the approving admin or API key. Only a person or an
 * API key may approve. When no task can be created, the handler throws
 * {@link ApprovalSideEffectError} and the suggestion stays pending.
 */
export const taskSuggestionHandler: ApprovalHandler = {
	async applyApproved(ctx: ApprovalSideEffectCtx): Promise<SideEffectBroadcast[]> {
		const { db, approval, payload, actorMemberId, wsManager, events } = ctx;
		const teamId = approval.team_id as string;
		const p = payload as unknown as TaskSuggestionPayload;

		// A suggestion is the admin's to approve: an agent resolving it, the CEO
		// included, creates nothing and leaves it pending.
		const apiKeyId = (approval.resolved_by_api_key_id as string | null) ?? null;
		if (!approval.resolved_by_user_id && !apiKeyId) {
			throw new ApprovalSideEffectError(
				'Only the admin can approve a task suggestion, so no task was created.',
			);
		}

		// The project and the suggestions task must be this team's: the payload is
		// read, never trusted to name where the task lands.
		const scope = await db.query<{ captain_id: string | null }>(
			`SELECT (SELECT ma.id FROM member_agents ma JOIN members m ON m.id = ma.id
			         WHERE m.team_id = p.team_id AND ma.slug = $4) AS captain_id
			   FROM projects p
			  WHERE p.id = $1 AND p.team_id = $2 AND p.is_internal = false
			    AND EXISTS (SELECT 1 FROM tasks t WHERE t.id = $3 AND t.project_id = p.id)`,
			[p.project_id, teamId, p.task_id, CAPTAIN_AGENT_SLUG],
		);
		if (!scope.rows[0]) {
			throw new ApprovalSideEffectError(
				'This suggestion names a project or task outside its team, so no task was created.',
			);
		}
		const captainId = scope.rows[0].captain_id;
		if (!captainId) {
			throw new ApprovalSideEffectError('The project has no Captain, so no task was created.');
		}

		const terminal = terminalStatusParams(3);
		const planning = await db.query<{ id: string; identifier: string }>(
			`SELECT id, identifier FROM tasks
			 WHERE project_id = $1 AND labels @> $2::jsonb
			   AND status NOT IN (${terminal.placeholders})
			 ORDER BY created_at ASC LIMIT 1`,
			[p.project_id, JSON.stringify([PLANNING_TASK_LABEL]), ...terminal.values],
		);
		const blocker = planning.rows[0] ?? null;

		let task: Awaited<ReturnType<typeof createTask>>;
		try {
			task = await createTask(
				db,
				teamId,
				{
					project_id: p.project_id,
					title: p.title,
					description: p.description,
					assignee_id: captainId,
					rules: isRepeatingCadence(p.cadence)
						? TASK_SUGGESTION_CADENCE_RULES[p.cadence]
						: undefined,
					blocked_by_task_ids: blocker ? [blocker.id] : undefined,
				},
				// Credited to whoever approved it: the admin's member, or the API key.
				actorMemberId
					? { actorType: AuditActorType.Admin, actorMemberId }
					: apiKeyId
						? { actorType: AuditActorType.ApiKey, actorMemberId: null, actorApiKeyId: apiKeyId }
						: { actorType: AuditActorType.Admin, actorMemberId: null },
				wsManager,
				events,
			);
		} catch (e) {
			// createTask writes in one transaction, so a refusal left nothing behind.
			if (e instanceof CreateTaskError) {
				throw new ApprovalSideEffectError(`The task could not be created: ${e.message}`);
			}
			throw e;
		}

		await resolveTaskSuggestionCommentAndWake(
			db,
			{
				approval,
				status: ApprovalStatus.Approved,
				created: {
					id: task.id,
					identifier: task.identifier,
					blockedByIdentifier: blocker?.identifier ?? null,
				},
			},
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
