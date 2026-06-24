import {
	AgentAdminStatus,
	DEFAULT_HEARTBEAT_INTERVAL_MIN,
	DocumentType,
	MemberType,
	TaskStatus,
} from '@hezo/shared';
import { trackBackground } from '../../lib/background';
import { logger } from '../../logger';
import { enqueueTeamCoherenceReviewTask } from '../description-tasks';
import { upsertDocument } from '../documents';
import { recordStatusChange } from '../task-events';
import type { ApprovalHandler, ApprovalSideEffectCtx, SideEffectBroadcast } from './types';

const log = logger.child('approval-handlers:hire');

/** Materialise an approved agent hire: member + agent rows, system prompt, task close. */
export const hireHandler: ApprovalHandler = {
	async applyApproved(ctx: ApprovalSideEffectCtx): Promise<SideEffectBroadcast[]> {
		const { db, approval, payload, actorMemberId, wsManager } = ctx;
		const broadcasts: SideEffectBroadcast[] = [];

		const teamId = approval.team_id as string;
		const title = (payload.title as string)?.trim();
		const slug = payload.slug as string;
		if (!title || !slug) {
			throw new Error('hire approval payload missing title/slug');
		}

		const slugCheck = await db.query(
			`SELECT ma.id FROM member_agents ma
			 JOIN members m ON m.id = ma.id
			 WHERE m.team_id = $1 AND ma.slug = $2`,
			[teamId, slug],
		);
		if (slugCheck.rows.length > 0) {
			throw new Error(`cannot materialise hire: slug '${slug}' already exists in this team`);
		}

		const memberResult = await db.query<{ id: string }>(
			`INSERT INTO members (team_id, member_type, display_name)
			 VALUES ($1, $2, $3) RETURNING id`,
			[teamId, MemberType.Agent, title],
		);
		const memberId = memberResult.rows[0].id;

		await db.query(
			`INSERT INTO member_agents (id, title, slug, role_description,
			                            default_effort, heartbeat_interval_min,
			                            daily_budget_cents, weekly_budget_cents, monthly_budget_cents,
			                            touches_code, admin_status)
			 VALUES ($1, $2, $3, $4, $5::agent_effort, $6, $7, $8, $9, $10, $11::agent_admin_status)`,
			[
				memberId,
				title,
				slug,
				(payload.role_description as string) ?? '',
				(payload.default_effort as string) ?? 'medium',
				(payload.heartbeat_interval_min as number) ?? DEFAULT_HEARTBEAT_INTERVAL_MIN,
				(payload.daily_budget_cents as number) ?? 0,
				(payload.weekly_budget_cents as number) ?? 0,
				(payload.monthly_budget_cents as number) ?? 3000,
				(payload.touches_code as boolean) ?? false,
				AgentAdminStatus.Enabled,
			],
		);

		const promptDoc = await upsertDocument(db, undefined, {
			scope: {
				type: DocumentType.AgentSystemPrompt,
				teamId,
				memberAgentId: memberId,
			},
			content: (payload.system_prompt as string) ?? '',
			changeSummary: 'Initial system prompt',
			authorMemberId: (approval.requested_by_member_id as string) ?? null,
		});
		broadcasts.push({
			table: 'documents',
			op: 'INSERT',
			row: promptDoc as unknown as Record<string, unknown>,
		});

		if (payload.task_id) {
			const taskId = payload.task_id as string;
			const prior = await db.query<{ status: string }>('SELECT status FROM tasks WHERE id = $1', [
				taskId,
			]);
			const oldStatus = prior.rows[0]?.status;
			const taskUpdate = await db.query<Record<string, unknown>>(
				`UPDATE tasks SET status = $1::task_status, updated_at = now()
				 WHERE id = $2 RETURNING *`,
				[TaskStatus.Done, taskId],
			);
			if (taskUpdate.rows[0]) {
				broadcasts.push({ table: 'tasks', op: 'UPDATE', row: taskUpdate.rows[0] });
				if (oldStatus) {
					await recordStatusChange(
						db,
						teamId,
						taskId,
						oldStatus,
						TaskStatus.Done,
						actorMemberId,
						null,
						wsManager,
					);
				}
			}
		}

		const newAgent = await db.query<Record<string, unknown>>(
			`SELECT m.id, m.team_id, m.display_name, m.created_at,
			        ma.agent_type_id, ma.title, ma.slug, ma.role_description, ma.summary,
			        ma.default_effort, ma.heartbeat_interval_min,
			        ma.daily_budget_cents, ma.weekly_budget_cents, ma.monthly_budget_cents,
			        ma.touches_code, ma.runtime_status, ma.admin_status,
			        ma.last_heartbeat_at, ma.reports_to, ma.mcp_servers, ma.updated_at
			 FROM members m JOIN member_agents ma ON ma.id = m.id WHERE m.id = $1`,
			[memberId],
		);
		if (newAgent.rows[0]) {
			broadcasts.push({ table: 'member_agents', op: 'INSERT', row: newAgent.rows[0] });
		}

		trackBackground(
			enqueueTeamCoherenceReviewTask(db, teamId, 'agent_hired').catch((e) =>
				log.error('Failed to enqueue team coherence review after hire:', e),
			),
		);

		return broadcasts;
	},
};
