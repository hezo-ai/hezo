import { AgentAdminStatus, CAPTAIN_AGENT_SLUG, WakeupSource, wsRoom } from '@hezo/shared';
import { trackBackground } from '../../lib/background';
import { broadcastRowChange } from '../../lib/broadcast';
import { toSlug, uniqueSlug } from '../../lib/slug';
import { logger } from '../../logger';
import { resolveProjectTaskPrefix } from '../../routes/projects';
import { type ProjectRow, provisionContainer } from '../containers';
import { enqueueTeamCoherenceReviewTask } from '../description-tasks';
import { createProjectWithPlanningTask } from '../project-create';
import {
	completeProjectIntakeAfterProvisioning,
	postProjectCreationApprovedAck,
	postProjectCreationDeniedNote,
} from '../project-intake';
import { createWakeup } from '../wakeup';
import type { ApprovalHandler, ApprovalSideEffectCtx, SideEffectBroadcast } from './types';

const log = logger.child('approval-handlers:project-creation');

/** Create a project (team, planning task, coherence gate, container) on approval. */
export const projectCreationHandler: ApprovalHandler = {
	async applyApproved(ctx: ApprovalSideEffectCtx): Promise<SideEffectBroadcast[]> {
		const { db, approval, payload, actorMemberId, wsManager, containerDeps, events } = ctx;
		const broadcasts: SideEffectBroadcast[] = [];

		const teamId = approval.team_id as string;
		const projectName = (payload.name as string | undefined)?.trim();
		const projectDescription = (payload.description as string | undefined)?.trim() ?? '';
		const proposedPrefix = (payload.task_prefix as string | undefined)?.trim();
		const initialPrd = (payload.initial_prd as string | null | undefined) ?? null;
		const intakeTaskId = payload.intake_task_id as string | undefined;

		if (!projectName) {
			throw new Error('project_creation approval payload missing name');
		}
		if (!intakeTaskId) {
			throw new Error('project_creation approval payload missing intake_task_id');
		}

		const captain = await db.query<{ id: string }>(
			`SELECT ma.id FROM member_agents ma
			 JOIN members m ON m.id = ma.id
			 WHERE m.team_id = $1 AND ma.slug = $3 AND ma.admin_status = $2::agent_admin_status
			 LIMIT 1`,
			[teamId, AgentAdminStatus.Enabled, CAPTAIN_AGENT_SLUG],
		);
		const captainMemberId = captain.rows[0]?.id;
		if (!captainMemberId) {
			throw new Error('Cannot create project on approval: no enabled Captain on team');
		}

		const prefixResult = await resolveProjectTaskPrefix(db, teamId, proposedPrefix, projectName);
		if (!prefixResult.ok) {
			throw new Error(`Cannot create project on approval: ${prefixResult.message}`);
		}

		const projectSlug = await uniqueSlug(toSlug(projectName), async (s) => {
			const r = await db.query('SELECT 1 FROM projects WHERE slug = $1', [s]);
			return r.rows.length > 0;
		});

		const { project, planningTask } = await createProjectWithPlanningTask(db, {
			teamId,
			captainMemberId,
			name: projectName,
			slug: projectSlug,
			taskPrefix: prefixResult.prefix,
			description: projectDescription,
			initialPrd,
			events,
			actorType: 'admin',
			actorMemberId,
		});

		if (wsManager) {
			broadcastRowChange(wsManager, wsRoom.team(teamId), 'projects', 'INSERT', project);
			broadcastRowChange(wsManager, wsRoom.team(teamId), 'tasks', 'INSERT', planningTask);
		}

		// The CEO first runs an initial coherence/setup pass on the new team's
		// roster; the Captain's planning task is blocked until that completes.
		const coherenceTaskId = await enqueueTeamCoherenceReviewTask(db, teamId, 'initial');
		if (coherenceTaskId) {
			await db.query(
				`INSERT INTO task_dependencies (task_id, blocked_by_task_id)
				 VALUES ($1, $2) ON CONFLICT DO NOTHING`,
				[planningTask.id, coherenceTaskId],
			);
		}

		await createWakeup(db, captainMemberId, teamId, WakeupSource.Assignment, {
			task_id: planningTask.id as string,
		});

		const ackComment = await postProjectCreationApprovedAck(db, intakeTaskId, projectName);
		if (ackComment) {
			broadcasts.push({ table: 'task_comments', op: 'INSERT', row: ackComment });
		}

		const completed = await completeProjectIntakeAfterProvisioning(
			db,
			intakeTaskId,
			projectName,
			project.slug as string,
			wsManager,
		);
		if (completed.summaryComment) {
			broadcasts.push({
				table: 'task_comments',
				op: 'INSERT',
				row: completed.summaryComment,
			});
		}
		if (completed.task) {
			broadcasts.push({ table: 'tasks', op: 'UPDATE', row: completed.task });
		}

		if (containerDeps) {
			const teamMeta = await db.query<{ slug: string }>('SELECT slug FROM teams WHERE id = $1', [
				teamId,
			]);
			const teamSlug = teamMeta.rows[0]?.slug;
			if (teamSlug) {
				trackBackground(
					provisionContainer(containerDeps, project as unknown as ProjectRow, teamSlug).catch(
						(error) => {
							log.error(`Failed to provision container for project ${project.slug}:`, error);
						},
					),
				);
			}
		}

		return broadcasts;
	},

	async applyDenied(ctx: ApprovalSideEffectCtx): Promise<SideEffectBroadcast[]> {
		const { db, payload, resolutionNote } = ctx;
		const intakeTaskId = payload.intake_task_id as string | undefined;
		if (!intakeTaskId) return [];
		const comment = await postProjectCreationDeniedNote(db, intakeTaskId, resolutionNote);
		if (!comment) return [];
		return [{ table: 'task_comments', op: 'INSERT', row: comment }];
	},
};
