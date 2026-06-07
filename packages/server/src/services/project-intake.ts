import type { PGlite } from '@electric-sql/pglite';
import {
	ApprovalStatus,
	ApprovalType,
	CommentContentType,
	PROJECT_INTAKE_LABEL,
	PROJECT_INTAKE_SKIP_SIGNAL_TEXT,
	TaskPriority,
	TaskStatus,
	WakeupSource,
	wsRoom,
} from '@hezo/shared';
import { broadcastRowChange } from '../lib/broadcast';
import { recomputeDownstreamReadiness } from '../lib/dependencies';
import { terminalStatusParams, withTransaction } from '../lib/sql';
import { allocateTaskIdentifier } from '../lib/task-identifier';
import { logger } from '../logger';
import { loadCaptainInternalContext } from './internal-intake';
import { recordStatusChange } from './task-events';
import { createWakeup } from './wakeup';
import type { WebSocketManager } from './ws';

const log = logger.child('project-intake');

export const PROJECT_INTAKE_MARKER = '<!-- project-intake -->';

export interface ProjectIntakePayload {
	name: string;
	description: string;
	task_prefix: string;
	initial_prd: string | null;
	intake_task_id?: string;
}

export interface CreateProjectIntakeInput {
	name: string;
	description: string;
	taskPrefix: string;
	initialPrd: string | null;
}

export interface ProjectIntakeResult {
	intakeTaskId: string;
	intakeTaskIdentifier: string;
	projectSlug: string;
	approvalId: string;
	captainMemberId: string;
}

function buildGreetingText(input: CreateProjectIntakeInput): string {
	const lines: string[] = [
		`Hi — I'm the Captain. Thanks for kicking off a new project.`,
		'',
		`Before we open it, I want to confirm we have the right people on the team for this work, clarify anything ambiguous in the brief, and lock in the final shape of the project.`,
		'',
		`Here's what you submitted:`,
		'',
		`**Name:** ${input.name}`,
		`**Task prefix:** ${input.taskPrefix}`,
		`**Description:**`,
		'',
		input.description,
	];
	if (input.initialPrd) {
		lines.push(
			'',
			`I'll attach your requirements document as a separate comment below so I can refer back to it.`,
		);
	}
	lines.push(
		'',
		`Tell me anything you'd like me to know — users, constraints, deadlines, integrations. Once I'm satisfied the team can deliver it, I'll ask the admin to approve creating the project. If you'd rather move fast, click "Skip questions" and I'll finalise with what we have.`,
	);
	return lines.join('\n');
}

function buildTaskDescription(input: CreateProjectIntakeInput, approvalId: string): string {
	return `${PROJECT_INTAKE_MARKER}

Approval ID: \`${approvalId}\`

## Open a new project

The admin submitted the Create Project form. Use this ticket as the single conversation thread to confirm scope, check team fit, and finalise the project shape before it's created.

### Form data

- **Name:** ${input.name}
- **Task prefix:** ${input.taskPrefix}
- **Has requirements doc:** ${input.initialPrd ? 'yes — see comments below' : 'no'}

**Description:**

${input.description}

### Your task

1. **Clarify scope.** Ask anything you need to understand the problem, the users, integrations, and constraints. The admin may click "Skip questions" — when they do, finalise with what you have.
2. **Check team fit.** Use \`list_agents\` / \`get_agent_system_prompt\` to assess whether the current roster covers the work. If there are gaps, open a hire via the standard hire flow before finalising this approval.
3. **Refine the proposal.** Use \`update_project_creation_proposal\` to update the payload as the conversation evolves (name, description, task_prefix, initial_prd).
4. **Ask for admin approval.** Post a summary comment, @-mention the admin, and ask them to approve the pending \`project_creation\` approval in the inbox.
5. **Wait.** On approval, the server creates the project and the planning task, wakes you on the planning task, and closes this ticket automatically.`;
}

export async function createProjectIntake(
	db: PGlite,
	teamId: string,
	input: CreateProjectIntakeInput,
	wsManager?: WebSocketManager,
): Promise<ProjectIntakeResult | null> {
	const ctx = await loadCaptainInternalContext(db, teamId);
	if (!ctx) {
		log.warn(`Cannot create project intake for ${teamId}; missing Captain or Internal`);
		return null;
	}

	const payload: ProjectIntakePayload = {
		name: input.name,
		description: input.description,
		task_prefix: input.taskPrefix,
		initial_prd: input.initialPrd,
	};

	const { intakeTaskId, intakeTaskIdentifier, approvalId, projectSlug } = await withTransaction(
		db,
		async () => {
			const approvalResult = await db.query<{ id: string }>(
				`INSERT INTO approvals (team_id, type, status, payload)
			 VALUES ($1, $2::approval_type, $3::approval_status, $4::jsonb)
			 RETURNING id`,
				[teamId, ApprovalType.ProjectCreation, ApprovalStatus.Pending, JSON.stringify(payload)],
			);
			const approvalId = approvalResult.rows[0].id;

			const { number: taskNumber, identifier } = await allocateTaskIdentifier(
				db,
				ctx.internalProjectId,
			);

			const taskResult = await db.query<{ id: string; identifier: string; project_slug: string }>(
				`WITH inserted AS (
			   INSERT INTO tasks (team_id, project_id, assignee_id, number, identifier,
			                      title, description, status, priority, labels)
			   VALUES ($1, $2, $3, $4, $5, $6, $7, $8::task_status, $9::task_priority, $10::jsonb)
			   RETURNING id, identifier, project_id
			 )
			 SELECT inserted.id, inserted.identifier, p.slug AS project_slug
			 FROM inserted JOIN projects p ON p.id = inserted.project_id`,
				[
					teamId,
					ctx.internalProjectId,
					ctx.captainMemberId,
					taskNumber,
					identifier,
					`Open new project: ${input.name}`,
					buildTaskDescription(input, approvalId),
					TaskStatus.InProgress,
					TaskPriority.High,
					JSON.stringify([PROJECT_INTAKE_LABEL]),
				],
			);
			const intakeTaskId = taskResult.rows[0].id;
			const intakeTaskIdentifier = taskResult.rows[0].identifier;
			const projectSlug = taskResult.rows[0].project_slug;

			await db.query(
				`UPDATE approvals
			 SET payload = payload || $1::jsonb
			 WHERE id = $2`,
				[JSON.stringify({ intake_task_id: intakeTaskId }), approvalId],
			);

			await db.query(
				`INSERT INTO task_comments (task_id, author_member_id, content_type, content)
			 VALUES ($1, $2, $3::comment_content_type, $4::jsonb)`,
				[
					intakeTaskId,
					ctx.captainMemberId,
					CommentContentType.Text,
					JSON.stringify({ text: buildGreetingText(input) }),
				],
			);

			if (input.initialPrd) {
				await db.query(
					`INSERT INTO task_comments (task_id, author_member_id, content_type, content)
				 VALUES ($1, $2, $3::comment_content_type, $4::jsonb)`,
					[
						intakeTaskId,
						ctx.captainMemberId,
						CommentContentType.Text,
						JSON.stringify({
							text: `**Requirements document attached to this intake:**\n\n${input.initialPrd}`,
						}),
					],
				);
			}

			return { intakeTaskId, intakeTaskIdentifier, approvalId, projectSlug };
		},
	);

	if (wsManager) {
		const taskRow = await db.query<Record<string, unknown>>('SELECT * FROM tasks WHERE id = $1', [
			intakeTaskId,
		]);
		if (taskRow.rows[0]) {
			broadcastRowChange(wsManager, wsRoom.team(teamId), 'tasks', 'INSERT', taskRow.rows[0]);
		}
	}

	try {
		await createWakeup(db, ctx.captainMemberId, teamId, WakeupSource.Assignment, {
			task_id: intakeTaskId,
		});
	} catch (e) {
		log.error('Failed to wake Captain for project intake:', e);
	}

	return {
		intakeTaskId,
		intakeTaskIdentifier,
		projectSlug,
		approvalId,
		captainMemberId: ctx.captainMemberId,
	};
}

export interface OpenProjectIntake {
	task_id: string;
	task_identifier: string;
	project_slug: string;
	approval_id: string;
}

export async function getOpenProjectIntakeTasks(
	db: PGlite,
	teamId: string,
): Promise<OpenProjectIntake[]> {
	const ts = terminalStatusParams(3);
	const result = await db.query<{
		task_id: string;
		task_identifier: string;
		project_slug: string;
		approval_id: string;
	}>(
		`SELECT i.id AS task_id,
		        i.identifier AS task_identifier,
		        p.slug AS project_slug,
		        a.id AS approval_id
		 FROM tasks i
		 JOIN projects p ON p.id = i.project_id
		 JOIN approvals a ON a.team_id = i.team_id
		                   AND a.type = 'project_creation'
		                   AND a.status = 'pending'
		                   AND a.payload->>'intake_task_id' = i.id::text
		 WHERE i.team_id = $1
		   AND i.labels @> $2::jsonb
		   AND i.status NOT IN (${ts.placeholders})
		 ORDER BY i.created_at ASC`,
		[teamId, JSON.stringify([PROJECT_INTAKE_LABEL]), ...ts.values],
	);
	return result.rows;
}

function buildProvisioningCompleteText(projectName: string, projectSlug: string): string {
	return `Setup complete. The **${projectName}** project has been created and a planning task is ready in [${projectSlug}](/projects/${projectSlug}). I'll start drafting the execution plan there.`;
}

export async function completeProjectIntakeAfterProvisioning(
	db: PGlite,
	teamId: string,
	intakeTaskId: string,
	projectName: string,
	projectSlug: string,
	wsManager?: WebSocketManager,
): Promise<{
	summaryComment: Record<string, unknown> | null;
	task: Record<string, unknown> | null;
}> {
	const ctx = await loadCaptainInternalContext(db, teamId);
	if (!ctx) {
		log.warn(`Cannot complete project intake for ${teamId}; missing Captain`);
		return { summaryComment: null, task: null };
	}

	const ts = terminalStatusParams(4);
	const openTask = await db.query<{ id: string; status: string }>(
		`SELECT id, status::text AS status FROM tasks
		 WHERE id = $1 AND team_id = $2 AND labels @> $3::jsonb
		   AND status NOT IN (${ts.placeholders})
		 LIMIT 1`,
		[intakeTaskId, teamId, JSON.stringify([PROJECT_INTAKE_LABEL]), ...ts.values],
	);
	if (!openTask.rows[0]) {
		return { summaryComment: null, task: null };
	}

	const summaryCommentResult = await db.query<Record<string, unknown>>(
		`INSERT INTO task_comments (task_id, author_member_id, content_type, content)
		 VALUES ($1, $2, $3::comment_content_type, $4::jsonb)
		 RETURNING *`,
		[
			intakeTaskId,
			ctx.captainMemberId,
			CommentContentType.Text,
			JSON.stringify({ text: buildProvisioningCompleteText(projectName, projectSlug) }),
		],
	);
	const summaryComment = summaryCommentResult.rows[0] ?? null;

	const oldStatus = openTask.rows[0].status;
	const taskUpdate = await db.query<Record<string, unknown>>(
		`UPDATE tasks SET status = $1::task_status, updated_at = now()
		 WHERE id = $2 AND team_id = $3
		 RETURNING *`,
		[TaskStatus.Done, intakeTaskId, teamId],
	);
	const task = taskUpdate.rows[0] ?? null;

	if (task) {
		await recordStatusChange(
			db,
			teamId,
			intakeTaskId,
			oldStatus,
			TaskStatus.Done,
			ctx.captainMemberId,
			wsManager,
		);
		try {
			await recomputeDownstreamReadiness(db, teamId, intakeTaskId, ctx.captainMemberId, wsManager);
		} catch (e) {
			log.error('Failed to recompute downstream readiness after project intake close:', e);
		}
	}

	return { summaryComment, task };
}

export async function postProjectCreationApprovedAck(
	db: PGlite,
	teamId: string,
	intakeTaskId: string,
	projectName: string,
): Promise<Record<string, unknown> | null> {
	const ctx = await loadCaptainInternalContext(db, teamId);
	if (!ctx) return null;

	const task = await db.query<{ id: string }>(
		`SELECT id FROM tasks
		 WHERE id = $1 AND team_id = $2 AND labels @> $3::jsonb
		 LIMIT 1`,
		[intakeTaskId, teamId, JSON.stringify([PROJECT_INTAKE_LABEL])],
	);
	if (!task.rows[0]) return null;

	const commentResult = await db.query<Record<string, unknown>>(
		`INSERT INTO task_comments (task_id, author_member_id, content_type, content)
		 VALUES ($1, $2, $3::comment_content_type, $4::jsonb)
		 RETURNING *`,
		[
			intakeTaskId,
			ctx.captainMemberId,
			CommentContentType.Text,
			JSON.stringify({
				text: `Thanks for approving — the **${projectName}** project is being created and the container is spinning up. I'll post a final note here when it's ready.`,
			}),
		],
	);
	return commentResult.rows[0] ?? null;
}

export async function postProjectCreationDeniedNote(
	db: PGlite,
	teamId: string,
	intakeTaskId: string,
	resolutionNote: string | null,
): Promise<Record<string, unknown> | null> {
	const ctx = await loadCaptainInternalContext(db, teamId);
	if (!ctx) return null;

	const task = await db.query<{ id: string }>(
		`SELECT id FROM tasks
		 WHERE id = $1 AND team_id = $2 AND labels @> $3::jsonb
		 LIMIT 1`,
		[intakeTaskId, teamId, JSON.stringify([PROJECT_INTAKE_LABEL])],
	);
	if (!task.rows[0]) return null;

	const note = resolutionNote?.trim();
	const text = note
		? `The admin declined the project creation approval (${note}). Reply here if you'd like me to revise the proposal.`
		: `The admin declined the project creation approval. Reply here if you'd like me to revise the proposal.`;

	const commentResult = await db.query<Record<string, unknown>>(
		`INSERT INTO task_comments (task_id, author_member_id, content_type, content)
		 VALUES ($1, $2, $3::comment_content_type, $4::jsonb)
		 RETURNING *`,
		[intakeTaskId, ctx.captainMemberId, CommentContentType.Text, JSON.stringify({ text })],
	);
	return commentResult.rows[0] ?? null;
}

export async function postSkipQuestionsSignalForProjectIntake(
	db: PGlite,
	teamId: string,
	intakeTaskId: string,
): Promise<Record<string, unknown> | null> {
	const ctx = await loadCaptainInternalContext(db, teamId);
	if (!ctx) return null;

	const task = await db.query<{ id: string }>(
		`SELECT id FROM tasks
		 WHERE id = $1 AND team_id = $2 AND labels @> $3::jsonb
		 LIMIT 1`,
		[intakeTaskId, teamId, JSON.stringify([PROJECT_INTAKE_LABEL])],
	);
	if (!task.rows[0]) return null;

	const commentResult = await db.query<Record<string, unknown>>(
		`INSERT INTO task_comments (task_id, author_member_id, content_type, content)
		 VALUES ($1, NULL, $2::comment_content_type, $3::jsonb)
		 RETURNING *`,
		[
			intakeTaskId,
			CommentContentType.System,
			JSON.stringify({ text: PROJECT_INTAKE_SKIP_SIGNAL_TEXT }),
		],
	);
	const comment = commentResult.rows[0] ?? null;

	try {
		await createWakeup(db, ctx.captainMemberId, teamId, WakeupSource.Reply, {
			task_id: intakeTaskId,
			comment_id: comment ? (comment.id as string) : undefined,
		});
	} catch (e) {
		log.error('Failed to wake Captain for skip-questions signal:', e);
	}

	return comment;
}
