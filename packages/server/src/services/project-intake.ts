import {
	CEO_AGENT_SLUG,
	CommentContentType,
	PROJECT_INTAKE_LABEL,
	TaskPriority,
	TaskStatus,
	WakeupSource,
	wsRoom,
} from '@hezo/shared';
import type { Db } from '../db/database';
import { broadcastRowChange } from '../lib/broadcast';
import { recomputeDownstreamReadiness } from '../lib/dependencies';
import { terminalStatusParams, withTransaction } from '../lib/sql';
import { allocateTaskIdentifier } from '../lib/task-identifier';
import { logger } from '../logger';
import { loadCoordinationContext } from './internal-intake';
import { recordStatusChange } from './task-events';
import { createWakeup } from './wakeup';
import type { WebSocketManager } from './ws';

const log = logger.child('project-intake');

export const PROJECT_INTAKE_MARKER = '<!-- project-intake -->';

export interface CreateProjectIntakeInput {
	name: string;
	description: string;
	initialProjectPlan: string | null;
	/** The team-type the admin picked in the dialog — the CEO's baseline suggestion. */
	baselineTemplateId?: string;
	/** Set instead of baselineTemplateId when the admin chose to clone an existing team. */
	baselineSourceTeamId?: string;
	/** Display name of the baseline team type, for the conversation. */
	baselineTeamTypeName?: string;
}

export interface ProjectIntakeResult {
	intakeTaskId: string;
	intakeTaskIdentifier: string;
	/** The HQ project slug — where the intake conversation lives. */
	projectSlug: string;
	ceoMemberId: string;
}

function buildGreetingText(input: CreateProjectIntakeInput): string {
	const lines: string[] = [
		`Hi — I'm the CEO. Thanks for kicking off a new project.`,
		'',
		`Before we open it, I want to confirm we're standing up the right team for this work, clarify anything ambiguous in the brief, and lock in the final shape of the project.`,
		'',
		`Here's what you submitted:`,
		'',
		`**Name:** ${input.name}`,
	];
	if (input.baselineTeamTypeName) {
		lines.push(`**Suggested team type:** ${input.baselineTeamTypeName}`);
	}
	lines.push('**Description:**', '', input.description);
	if (input.initialProjectPlan) {
		lines.push(
			'',
			`I'll attach your project plan document as a separate comment below so I can refer back to it.`,
		);
	}
	lines.push(
		'',
		`Tell me anything you'd like me to know — users, constraints, deadlines, integrations — and whether the suggested team type fits. Once we're aligned and you give me the go-ahead, I'll create the project and its team.`,
	);
	return lines.join('\n');
}

function buildBaselineLine(input: CreateProjectIntakeInput): string {
	if (input.baselineSourceTeamId) {
		return `- **Baseline team type:** clone of "${input.baselineTeamTypeName ?? 'an existing team'}" (source_team_id: \`${input.baselineSourceTeamId}\`)`;
	}
	if (input.baselineTemplateId) {
		return `- **Baseline team type:** ${input.baselineTeamTypeName ?? 'template'} (template_id: \`${input.baselineTemplateId}\`)`;
	}
	return `- **Baseline team type:** Blank (Captain only)`;
}

function buildTaskDescription(input: CreateProjectIntakeInput): string {
	return `${PROJECT_INTAKE_MARKER}

## Open a new project

The admin submitted the Create Project form and chose to plan it with you. Use this ticket as the single conversation thread to confirm scope, check team fit, and finalise the project shape before you create it.

### Form data

- **Name:** ${input.name}
${buildBaselineLine(input)}
- **Has project plan doc:** ${input.initialProjectPlan ? 'yes — see comments below' : 'no'}

**Description:**

${input.description}

### Your task

1. **Clarify scope.** Ask anything you need to understand the problem, the users, integrations, and constraints. Put an active \`@admin\` in any comment where you need them to answer — without it the question reaches no inbox and the ticket stalls.
2. **Check team fit.** The admin's chosen team type above is your baseline. Call \`list_team_templates\` to review the built-in and saved team types, and recommend a different one if it fits the work better — the final call is the admin's.
3. **Get the go-ahead.** Post a short summary of the agreed shape (name, description, team type), @-mention the admin, and ask them to confirm. A plain reply approving it is all you need — this is a normal conversation, not an inbox approval.
4. **Create the project.** Once the admin approves in this thread, call \`create_project\` with the agreed \`name\`, \`description\`, and the chosen \`template_id\` (or \`source_team_id\`), passing this ticket's id as \`intake_task_id\`. That creates the project and its team, opens the Captain's planning ticket, and closes this ticket automatically.
5. **Set up the team, then start it.** \`create_project\` returns the new project's planning **and** coherence ticket identifiers. Because you created this project, the coherence/setup ticket does **not** start on its own: open it (the returned \`coherence_task_identifier\`) and rewrite its description with \`update_task\` to capture the concrete setup you agreed here — the exact roles to hire, any system-prompt rewrites, and the reporting structure — then call \`start_team_setup(project)\` to begin the setup run. If the admin decides not to proceed, close this ticket as cancelled with a brief note.`;
}

/**
 * Open a CEO-assisted project intake: a single conversation ticket in HQ,
 * assigned to the CEO, recording the form data and the admin's chosen team type
 * as a baseline. Nothing else is created up front — no team, no project, no
 * approval. The CEO scopes the work with the admin and, on their in-thread
 * go-ahead, creates the project + team itself via the `create_project` tool.
 */
export async function createProjectIntake(
	db: Db,
	input: CreateProjectIntakeInput,
	wsManager?: WebSocketManager,
): Promise<ProjectIntakeResult | null> {
	const ctx = await loadCoordinationContext(db);
	if (!ctx) {
		log.warn('Cannot create project intake; missing CEO or HQ project');
		return null;
	}

	const { intakeTaskId, intakeTaskIdentifier, projectSlug } = await withTransaction(
		db,
		async () => {
			const { number: taskNumber, identifier } = await allocateTaskIdentifier(db, ctx.hqProjectId);

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
					ctx.hqTeamId,
					ctx.hqProjectId,
					ctx.ceoMemberId,
					taskNumber,
					identifier,
					`Open new project: ${input.name}`,
					buildTaskDescription(input),
					TaskStatus.InProgress,
					TaskPriority.High,
					JSON.stringify([PROJECT_INTAKE_LABEL]),
				],
			);
			const intakeTaskId = taskResult.rows[0].id;
			const intakeTaskIdentifier = taskResult.rows[0].identifier;
			const projectSlug = taskResult.rows[0].project_slug;

			await db.query(
				`INSERT INTO task_comments (task_id, author_member_id, content_type, content)
			 VALUES ($1, $2, $3::comment_content_type, $4::jsonb)`,
				[
					intakeTaskId,
					ctx.ceoMemberId,
					CommentContentType.Text,
					JSON.stringify({ text: buildGreetingText(input) }),
				],
			);

			if (input.initialProjectPlan) {
				await db.query(
					`INSERT INTO task_comments (task_id, author_member_id, content_type, content)
				 VALUES ($1, $2, $3::comment_content_type, $4::jsonb)`,
					[
						intakeTaskId,
						ctx.ceoMemberId,
						CommentContentType.Text,
						JSON.stringify({
							text: `**Project plan attached to this intake:**\n\n${input.initialProjectPlan}`,
						}),
					],
				);
			}

			return { intakeTaskId, intakeTaskIdentifier, projectSlug };
		},
	);

	if (wsManager) {
		const taskRow = await db.query<Record<string, unknown>>('SELECT * FROM tasks WHERE id = $1', [
			intakeTaskId,
		]);
		if (taskRow.rows[0]) {
			broadcastRowChange(wsManager, wsRoom.team(ctx.hqTeamId), 'tasks', 'INSERT', taskRow.rows[0]);
		}
	}

	try {
		await createWakeup(db, ctx.ceoMemberId, ctx.hqTeamId, WakeupSource.Assignment, {
			task_id: intakeTaskId,
		});
	} catch (e) {
		log.error('Failed to wake CEO for project intake:', e);
	}

	return {
		intakeTaskId,
		intakeTaskIdentifier,
		projectSlug,
		ceoMemberId: ctx.ceoMemberId,
	};
}

export interface OpenProjectIntake {
	task_id: string;
	task_identifier: string;
	project_slug: string;
}

export interface OpenProjectIntakeForHome {
	task_id: string;
	task_identifier: string;
	/** The HQ project slug — where the intake conversation lives. */
	project_slug: string;
	greeting: string;
	ceo_member_id: string;
	ceo_title: string;
}

function extractCommentText(content: unknown): string {
	if (typeof content === 'string') {
		try {
			const parsed = JSON.parse(content) as { text?: unknown };
			return typeof parsed?.text === 'string' ? parsed.text : content;
		} catch {
			return content;
		}
	}
	if (content && typeof content === 'object' && 'text' in content) {
		const text = (content as { text?: unknown }).text;
		return typeof text === 'string' ? text : '';
	}
	return '';
}

/**
 * The single open project-intake conversation surfaced on the home/welcome view,
 * enriched with the CEO's opening greeting and identity. All intakes live in HQ.
 */
export async function getOpenProjectIntakeForHome(
	db: Db,
): Promise<OpenProjectIntakeForHome | null> {
	const open = await getOpenProjectIntakeTasks(db);
	const first = open[0];
	if (!first) return null;

	const ceo = await db.query<{ id: string; title: string }>(
		`SELECT id, title FROM member_agents WHERE slug = $1 LIMIT 1`,
		[CEO_AGENT_SLUG],
	);
	const greetingRow = await db.query<{ content: unknown }>(
		`SELECT content FROM task_comments
		 WHERE task_id = $1 AND content_type = 'text'::comment_content_type
		 ORDER BY created_at ASC LIMIT 1`,
		[first.task_id],
	);

	return {
		task_id: first.task_id,
		task_identifier: first.task_identifier,
		project_slug: first.project_slug,
		greeting: extractCommentText(greetingRow.rows[0]?.content),
		ceo_member_id: ceo.rows[0]?.id ?? '',
		ceo_title: ceo.rows[0]?.title ?? 'CEO',
	};
}

/** All open project-intake conversations, instance-wide (they all live in HQ). */
export async function getOpenProjectIntakeTasks(db: Db): Promise<OpenProjectIntake[]> {
	const ts = terminalStatusParams(2);
	const result = await db.query<{
		task_id: string;
		task_identifier: string;
		project_slug: string;
	}>(
		`SELECT i.id AS task_id,
		        i.identifier AS task_identifier,
		        p.slug AS project_slug
		 FROM tasks i
		 JOIN projects p ON p.id = i.project_id
		 WHERE i.labels @> $1::jsonb
		   AND i.status NOT IN (${ts.placeholders})
		 ORDER BY i.created_at ASC`,
		[JSON.stringify([PROJECT_INTAKE_LABEL]), ...ts.values],
	);
	return result.rows;
}

function buildProvisioningCompleteText(projectName: string, projectSlug: string): string {
	return `Setup complete. The **${projectName}** project has been created and a planning task is ready in [${projectSlug}](/projects/${projectSlug}). I'll start drafting the execution plan there.`;
}

/**
 * Close an intake conversation once its project has been created: post a final
 * "setup complete" comment and move the ticket to Done. Idempotent — a no-op if
 * the ticket is already terminal. Called by the CEO's `create_project` tool.
 */
export async function completeProjectIntakeAfterProvisioning(
	db: Db,
	intakeTaskId: string,
	projectName: string,
	projectSlug: string,
	wsManager?: WebSocketManager,
): Promise<{
	summaryComment: Record<string, unknown> | null;
	task: Record<string, unknown> | null;
}> {
	const ctx = await loadCoordinationContext(db);
	if (!ctx) {
		log.warn('Cannot complete project intake; missing CEO or HQ project');
		return { summaryComment: null, task: null };
	}

	const ts = terminalStatusParams(3);
	const openTask = await db.query<{ id: string; status: string }>(
		`SELECT id, status::text AS status FROM tasks
		 WHERE id = $1 AND labels @> $2::jsonb
		   AND status NOT IN (${ts.placeholders})
		 LIMIT 1`,
		[intakeTaskId, JSON.stringify([PROJECT_INTAKE_LABEL]), ...ts.values],
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
			ctx.ceoMemberId,
			CommentContentType.Text,
			JSON.stringify({ text: buildProvisioningCompleteText(projectName, projectSlug) }),
		],
	);
	const summaryComment = summaryCommentResult.rows[0] ?? null;

	const oldStatus = openTask.rows[0].status;
	const taskUpdate = await db.query<Record<string, unknown>>(
		`UPDATE tasks SET status = $1::task_status, updated_at = now()
		 WHERE id = $2
		 RETURNING *`,
		[TaskStatus.Done, intakeTaskId],
	);
	const task = taskUpdate.rows[0] ?? null;

	if (task) {
		await recordStatusChange(
			db,
			ctx.hqTeamId,
			intakeTaskId,
			oldStatus,
			TaskStatus.Done,
			ctx.ceoMemberId,
			null,
			wsManager,
		);
		try {
			await recomputeDownstreamReadiness(
				db,
				ctx.hqTeamId,
				intakeTaskId,
				ctx.ceoMemberId,
				wsManager,
			);
		} catch (e) {
			log.error('Failed to recompute downstream readiness after project intake close:', e);
		}
	}

	return { summaryComment, task };
}
