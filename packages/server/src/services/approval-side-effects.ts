import { createHash } from 'node:crypto';
import type { PGlite } from '@electric-sql/pglite';
import {
	AgentAdminStatus,
	ApprovalType,
	CAPTAIN_AGENT_SLUG,
	DocumentType,
	MemberType,
	TaskStatus,
	WakeupSource,
	wsRoom,
} from '@hezo/shared';
import { trackBackground } from '../lib/background';
import { broadcastRowChange } from '../lib/broadcast';
import { logger } from '../logger';
import { resolveProjectTaskPrefix } from '../routes/projects';
import {
	enqueueAgentSummaryTask,
	enqueueAgentTeamContextTask,
	enqueueTeamCoherenceReviewTask,
	enqueueTeamContextTaskForAllAgents,
	enqueueTeamSummaryTask,
} from './description-tasks';
import { upsertDocument } from './documents';
import {
	completeOnboardingIntakeAfterProvisioning,
	postOnboardingTemplateApprovedAck,
	postOnboardingTemplateDeniedNote,
} from './onboarding-intake';
import { createProjectWithPlanningTask } from './project-create';
import { recordStatusChange } from './task-events';
import { applyTemplateToTeam } from './team-template-apply';
import { createWakeup } from './wakeup';
import type { WebSocketManager } from './ws';

const log = logger.child('approval-side-effects');

export interface SideEffectBroadcast {
	table: string;
	op: 'INSERT' | 'UPDATE';
	row: Record<string, unknown>;
}

export async function applyApprovalDeniedSideEffect(
	db: PGlite,
	approval: Record<string, unknown>,
): Promise<SideEffectBroadcast[]> {
	if (approval.type !== ApprovalType.TeamTemplate) return [];
	const payload = approval.payload as Record<string, unknown>;
	const teamId = approval.team_id as string;
	const intakeTaskId = payload.task_id as string | undefined;
	if (!intakeTaskId) return [];
	const comment = await postOnboardingTemplateDeniedNote(
		db,
		teamId,
		intakeTaskId,
		(approval.resolution_note as string | null) ?? null,
	);
	if (!comment) return [];
	return [{ table: 'task_comments', op: 'INSERT', row: comment }];
}

export async function applyApprovalSideEffect(
	db: PGlite,
	approval: Record<string, unknown>,
	dataDir: string,
	actorMemberId: string | null,
	wsManager?: WebSocketManager,
): Promise<SideEffectBroadcast[]> {
	const payload = approval.payload as Record<string, unknown>;
	const broadcasts: SideEffectBroadcast[] = [];
	switch (approval.type) {
		case ApprovalType.Hire: {
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
				                            monthly_budget_cents, touches_code, admin_status)
				 VALUES ($1, $2, $3, $4, $5::agent_effort, $6, $7, $8, $9::agent_admin_status)`,
				[
					memberId,
					title,
					slug,
					(payload.role_description as string) ?? '',
					(payload.default_effort as string) ?? 'medium',
					(payload.heartbeat_interval_min as number) ?? 60,
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
							wsManager,
						);
					}
				}
			}

			const newAgent = await db.query<Record<string, unknown>>(
				`SELECT m.id, m.team_id, m.display_name, m.created_at,
				        ma.agent_type_id, ma.title, ma.slug, ma.role_description, ma.summary,
				        ma.default_effort, ma.heartbeat_interval_min,
				        ma.monthly_budget_cents, ma.budget_used_cents, ma.touches_code,
				        ma.budget_reset_at, ma.runtime_status, ma.admin_status,
				        ma.last_heartbeat_at, ma.reports_to, ma.mcp_servers, ma.updated_at
				 FROM members m JOIN member_agents ma ON ma.id = m.id WHERE m.id = $1`,
				[memberId],
			);
			if (newAgent.rows[0]) {
				broadcasts.push({ table: 'member_agents', op: 'INSERT', row: newAgent.rows[0] });
			}

			trackBackground(
				enqueueAgentSummaryTask(db, teamId, memberId, 'created').catch((e) =>
					log.error('Failed to enqueue agent summary task:', e),
				),
			);
			trackBackground(
				enqueueTeamSummaryTask(db, teamId, 'agent_added').catch((e) =>
					log.error('Failed to enqueue team summary task:', e),
				),
			);
			trackBackground(
				enqueueAgentTeamContextTask(db, teamId, memberId, 'initial').catch((e) =>
					log.error('Failed to enqueue team_context task for new agent:', e),
				),
			);
			trackBackground(
				enqueueTeamContextTaskForAllAgents(db, teamId, 'agent_added', memberId).catch((e) =>
					log.error('Failed to fan out team_context tasks for existing agents:', e),
				),
			);
			trackBackground(
				enqueueTeamCoherenceReviewTask(db, teamId, 'agent_hired').catch((e) =>
					log.error('Failed to enqueue team coherence review after hire:', e),
				),
			);
			break;
		}
		case ApprovalType.KbUpdate: {
			const slug = payload.slug as string;
			const requestedBy = (approval.requested_by_member_id as string) ?? null;
			const doc = await upsertDocument(db, undefined, {
				scope: {
					type: DocumentType.KbDoc,
					teamId: approval.team_id as string,
					slug,
				},
				title: typeof payload.title === 'string' ? payload.title : undefined,
				content: typeof payload.content === 'string' ? payload.content : '',
				changeSummary: (payload.change_summary as string) ?? '',
				authorMemberId: requestedBy,
			});
			broadcasts.push({
				table: 'documents',
				op: 'UPDATE',
				row: doc as unknown as Record<string, unknown>,
			});
			break;
		}
		case ApprovalType.Strategy: {
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
			break;
		}
		case ApprovalType.TeamTemplate: {
			const teamId = approval.team_id as string;
			const templateId = payload.template_id as string;
			if (!templateId) {
				throw new Error('team_template approval payload missing template_id');
			}

			const intakeTaskId = payload.task_id as string | undefined;
			const templateName =
				(typeof payload.template_name === 'string' && payload.template_name.trim()) ||
				'team template';
			const projectName = (payload.project_name as string | null | undefined)?.trim() || null;
			const projectDescription =
				(payload.project_description as string | null | undefined)?.trim() ?? '';

			const apply = await applyTemplateToTeam(db, teamId, templateId, { dataDir, wsManager });

			if (intakeTaskId) {
				const ackComment = await postOnboardingTemplateApprovedAck(
					db,
					teamId,
					intakeTaskId,
					templateName,
				);
				if (ackComment) {
					broadcasts.push({ table: 'task_comments', op: 'INSERT', row: ackComment });
				}
			}

			for (const slug of apply.created_slugs) {
				const agentRow = await db.query<{ id: string }>(
					`SELECT ma.id FROM member_agents ma
					 JOIN members m ON m.id = ma.id
					 WHERE m.team_id = $1 AND ma.slug = $2`,
					[teamId, slug],
				);
				const memberId = agentRow.rows[0]?.id;
				if (memberId) {
					trackBackground(
						enqueueAgentSummaryTask(db, teamId, memberId, 'created').catch((e) =>
							log.error('Failed to enqueue agent summary after template provision:', e),
						),
					);
					const newAgent = await db.query<Record<string, unknown>>(
						`SELECT m.id, m.team_id, m.display_name, m.created_at,
						        ma.agent_type_id, ma.title, ma.slug, ma.role_description, ma.summary,
						        ma.default_effort, ma.heartbeat_interval_min,
						        ma.monthly_budget_cents, ma.budget_used_cents, ma.touches_code,
						        ma.budget_reset_at, ma.runtime_status, ma.admin_status,
						        ma.last_heartbeat_at, ma.reports_to, ma.mcp_servers, ma.updated_at
						 FROM members m JOIN member_agents ma ON ma.id = m.id WHERE m.id = $1`,
						[memberId],
					);
					if (newAgent.rows[0]) {
						broadcasts.push({
							table: 'member_agents',
							op: 'INSERT',
							row: newAgent.rows[0],
						});
					}
				}
			}

			trackBackground(
				enqueueTeamSummaryTask(db, teamId, 'agent_added').catch((e) =>
					log.error('Failed to enqueue team summary after template provision:', e),
				),
			);

			if (projectName) {
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

				const projectSlug = projectName
					.toLowerCase()
					.replace(/[^a-z0-9]+/g, '-')
					.replace(/^-|-$/g, '');
				const prefixResult = await resolveProjectTaskPrefix(db, teamId, undefined, projectName);
				if (!prefixResult.ok) {
					throw new Error(`Cannot create project on approval: ${prefixResult.message}`);
				}

				const { project, planningTask, deferCaptainPlanningWake } =
					await createProjectWithPlanningTask(db, {
						teamId,
						captainMemberId,
						name: projectName,
						slug: projectSlug,
						taskPrefix: prefixResult.prefix,
						description: projectDescription,
						createPlanningTask: true,
					});

				broadcastRowChange(wsManager, wsRoom.team(teamId), 'projects', 'INSERT', project);
				if (!planningTask) {
					throw new Error('Expected planning task for approval-driven project creation');
				}
				broadcastRowChange(wsManager, wsRoom.team(teamId), 'tasks', 'INSERT', planningTask);

				if (!deferCaptainPlanningWake) {
					await createWakeup(db, captainMemberId, teamId, WakeupSource.Assignment, {
						task_id: planningTask.id as string,
					});
				}
			}

			if (intakeTaskId) {
				const completed = await completeOnboardingIntakeAfterProvisioning(
					db,
					teamId,
					intakeTaskId,
					templateName,
					projectName,
					apply.created_slugs,
					apply.skipped_slugs,
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
			}
			break;
		}
		case ApprovalType.SkillProposal: {
			const teamId = approval.team_id as string;
			const slug = payload.skill_slug as string;
			const name = payload.skill_name as string;
			const content = payload.content as string;
			const contentHash = createHash('sha256').update(content).digest('hex');
			const requestedBy =
				(payload.requested_by as string) ?? (approval.requested_by_member_id as string) ?? null;

			// Write to DB (source of truth)
			const skillResult = await db.query<{ id: string }>(
				`INSERT INTO skills (team_id, name, slug, description, content, content_hash, created_by_member_id)
				 VALUES ($1, $2, $3, $4, $5, $6, $7)
				 ON CONFLICT (team_id, slug) DO UPDATE SET
				   content = EXCLUDED.content,
				   content_hash = EXCLUDED.content_hash,
				   updated_at = now()
				 RETURNING id`,
				[teamId, name, slug, (payload.reason as string) ?? '', content, contentHash, requestedBy],
			);

			if (skillResult.rows[0]) {
				await db.query(
					`INSERT INTO skill_revisions (skill_id, revision_number, content, content_hash, change_summary, author_member_id)
					 VALUES ($1, (SELECT COALESCE(MAX(revision_number), 0) + 1 FROM skill_revisions WHERE skill_id = $1), $2, $3, 'Created via approval', $4)`,
					[skillResult.rows[0].id, content, contentHash, requestedBy],
				);
			}
			break;
		}
	}
	return broadcasts;
}
