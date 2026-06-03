import type { PGlite } from '@electric-sql/pglite';
import {
	CommentContentType,
	ONBOARDING_INTAKE_SKIP_SIGNAL_TEXT,
	TaskPriority,
	TaskStatus,
	WakeupSource,
	wsRoom,
} from '@hezo/shared';
import { broadcastRowChange } from '../lib/broadcast';
import { recomputeDownstreamReadiness } from '../lib/dependencies';
import { terminalStatusParams } from '../lib/sql';
import { allocateTaskIdentifier } from '../lib/task-identifier';
import { logger } from '../logger';
import { findOpenLabeledTask, loadCaptainInternalContext } from './internal-intake';
import { recordStatusChange } from './task-events';
import { createWakeup } from './wakeup';
import type { WebSocketManager } from './ws';

const log = logger.child('onboarding-intake');

export const ONBOARDING_INTAKE_LABEL = 'onboarding-intake';
export const ONBOARDING_INTAKE_MARKER = '<!-- onboarding-intake -->';
export const ONBOARDING_INTAKE_TITLE = 'Set up your first project';

export const CAPTAIN_GREETING_TEXT = `Hi — I'm the Captain. I'll help you set up your first project from scratch.

Tell me what you're hoping to build: the problem you want to solve, who it's for, and anything you already know about scope or constraints. Once I have enough to work with I'll suggest a team template that fits and propose a project name + description for you to approve.`;

function buildTaskDescription(): string {
	return `${ONBOARDING_INTAKE_MARKER}

## Set up the first project

The admin is starting fresh. Use this ticket as a single conversation thread to learn what they want to build, propose the right team template, and propose the first project.

### Your task

1. **Discuss requirements.** Ask clarifying questions on this ticket until you understand goals, users, scope, and constraints. The admin may click "Skip questions" at any point — if they do, finalise a proposal based on what you have so far.
2. **Propose a team template AND a project.** When you have enough context (or when the admin asks you to finalise), call \`list_team_templates\` and pick the best-fit built-in or custom template. Post a single comment that:
   - Names the template and lists who would be on the team and why.
   - Proposes a project \`name\` and \`description\`.
   - @-mentions the admin and asks them to confirm before you file an approval.
3. **File the approval.** Once the admin confirms, call \`request_team_template_approval\` with the chosen \`template_id\`, this task's id, your rationale, AND the agreed \`project_name\` and \`project_description\`.
4. **Wait for the admin to approve in the inbox.** When they do, the server provisions the template agents AND creates the user project automatically. You'll then be woken to run a team coherence review on the new roster.
5. **Close.** The server posts a "Setup complete" comment on this ticket and closes it once provisioning + project creation finish. From there, you and the team can dive into the new project.`;
}

export interface OnboardingIntakeTask {
	task_id: string;
	task_identifier: string;
	project_slug: string;
	captain_greeting: string;
	captain_member_id: string;
	captain_title: string;
}

/**
 * Creates the single onboarding-intake task in the Internal project and
 * posts the Captain greeting comment. Idempotent — returns null if an open
 * intake task already exists.
 */
export async function createOnboardingIntakeTask(
	db: PGlite,
	teamId: string,
): Promise<{ taskId: string; captainMemberId: string } | null> {
	const ctx = await loadCaptainInternalContext(db, teamId);
	if (!ctx) {
		log.warn(`Cannot create onboarding intake for ${teamId}; missing Captain or Internal`);
		return null;
	}

	const existing = await findOpenLabeledTask(db, teamId, ONBOARDING_INTAKE_LABEL);
	if (existing) return null;

	const { number: taskNumber, identifier } = await allocateTaskIdentifier(
		db,
		ctx.internalProjectId,
	);

	const taskResult = await db.query<{ id: string }>(
		`INSERT INTO tasks (team_id, project_id, assignee_id, number, identifier,
		                     title, description, status, priority, labels)
		 VALUES ($1, $2, $3, $4, $5, $6, $7, $8::task_status, $9::task_priority, $10::jsonb)
		 RETURNING id`,
		[
			teamId,
			ctx.internalProjectId,
			ctx.captainMemberId,
			taskNumber,
			identifier,
			ONBOARDING_INTAKE_TITLE,
			buildTaskDescription(),
			TaskStatus.InProgress,
			TaskPriority.High,
			JSON.stringify([ONBOARDING_INTAKE_LABEL]),
		],
	);
	const taskId = taskResult.rows[0].id;

	await db.query(
		`INSERT INTO task_comments (task_id, author_member_id, content_type, content)
		 VALUES ($1, $2, $3::comment_content_type, $4::jsonb)`,
		[
			taskId,
			ctx.captainMemberId,
			CommentContentType.Text,
			JSON.stringify({ text: CAPTAIN_GREETING_TEXT }),
		],
	);

	return { taskId, captainMemberId: ctx.captainMemberId };
}

export async function wakeCaptainForOnboardingIntake(
	db: PGlite,
	teamId: string,
	captainMemberId: string,
	taskId: string,
): Promise<void> {
	try {
		await createWakeup(db, captainMemberId, teamId, WakeupSource.Assignment, {
			task_id: taskId,
		});
	} catch (e) {
		log.error('Failed to wake Captain for onboarding intake:', e);
	}
}

async function buildIntakeResponse(
	db: PGlite,
	ctx: { captainMemberId: string },
	row: { id: string; identifier: string; project_slug: string },
): Promise<OnboardingIntakeTask> {
	const captainTitle = await db.query<{ title: string }>(
		'SELECT title FROM member_agents WHERE id = $1',
		[ctx.captainMemberId],
	);

	return {
		task_id: row.id,
		task_identifier: row.identifier,
		project_slug: row.project_slug,
		captain_greeting: CAPTAIN_GREETING_TEXT,
		captain_member_id: ctx.captainMemberId,
		captain_title: captainTitle.rows[0]?.title ?? 'Captain',
	};
}

/** Read-only — returns null when the onboarding ticket is closed or missing. */
export async function getOpenOnboardingIntakeTask(
	db: PGlite,
	teamId: string,
): Promise<OnboardingIntakeTask | null> {
	const ctx = await loadCaptainInternalContext(db, teamId);
	if (!ctx) return null;
	const row = await findOpenLabeledTask(db, teamId, ONBOARDING_INTAKE_LABEL);
	if (!row) return null;
	return buildIntakeResponse(db, ctx, row);
}

/** Returns the open onboarding-intake task, creating it if missing. */
export async function ensureOnboardingIntakeTask(
	db: PGlite,
	teamId: string,
	wsManager?: WebSocketManager,
): Promise<OnboardingIntakeTask | null> {
	const ctx = await loadCaptainInternalContext(db, teamId);
	if (!ctx) return null;

	let row = await findOpenLabeledTask(db, teamId, ONBOARDING_INTAKE_LABEL);
	let created: { taskId: string; captainMemberId: string } | null = null;
	if (!row) {
		created = await createOnboardingIntakeTask(db, teamId);
		row = await findOpenLabeledTask(db, teamId, ONBOARDING_INTAKE_LABEL);
		if (row && wsManager) {
			const taskFull = await db.query<Record<string, unknown>>(
				'SELECT * FROM tasks WHERE id = $1',
				[row.id],
			);
			if (taskFull.rows[0]) {
				broadcastRowChange(wsManager, wsRoom.team(teamId), 'tasks', 'INSERT', taskFull.rows[0]);
			}
		}
		if (created) {
			await wakeCaptainForOnboardingIntake(db, teamId, created.captainMemberId, created.taskId);
		}
	}

	if (!row) return null;
	return buildIntakeResponse(db, ctx, row);
}

export function buildOnboardingTemplateApprovedAckText(templateName: string): string {
	return `Thanks for approving the **${templateName}** team template. The agents are being provisioned and your project is being created — I'll post an update below when setup is complete.`;
}

export function buildOnboardingTemplateDeniedText(resolutionNote: string | null): string {
	const note = resolutionNote?.trim();
	if (note) {
		return `The admin declined the team template approval (${note}). Reply here if you'd like me to recommend a different structure.`;
	}
	return `The admin declined the team template approval. Reply here if you'd like me to recommend a different structure.`;
}

export function buildOnboardingProvisioningCompleteText(
	templateName: string,
	projectName: string | null,
	created: Array<{ title: string }>,
	skipped: Array<{ title: string }>,
): string {
	const lines: string[] = [
		`Setup is complete. The **${templateName}** template has been applied${projectName ? ` and the **${projectName}** project has been created` : ''}.`,
		'',
	];
	if (created.length > 0) {
		lines.push('**Added to the team:**');
		for (const agent of created) lines.push(`- ${agent.title}`);
		lines.push('');
	}
	if (skipped.length > 0) {
		lines.push('**Already on the team (unchanged):**');
		for (const agent of skipped) lines.push(`- ${agent.title}`);
		lines.push('');
	}
	if (created.length === 0 && skipped.length === 0) {
		lines.push('No new agent roles were required from this template.');
		lines.push('');
	}
	lines.push('You can review the team and the new project from the home screen.');
	return lines.join('\n');
}

async function loadAgentTitlesBySlugs(
	db: PGlite,
	teamId: string,
	slugs: string[],
): Promise<Array<{ title: string; slug: string }>> {
	if (slugs.length === 0) return [];
	const result = await db.query<{ title: string; slug: string }>(
		`SELECT ma.title, ma.slug
		 FROM member_agents ma
		 JOIN members m ON m.id = ma.id
		 WHERE m.team_id = $1 AND ma.slug = ANY($2::text[])
		 ORDER BY ma.title`,
		[teamId, slugs],
	);
	return result.rows;
}

export interface OnboardingProvisioningCompleteResult {
	summaryComment: Record<string, unknown> | null;
	task: Record<string, unknown> | null;
}

/**
 * Posts a final "setup complete" comment on the onboarding ticket and closes it.
 * Called by the approval side-effect once template provisioning + project creation
 * finish.
 */
export async function completeOnboardingIntakeAfterProvisioning(
	db: PGlite,
	teamId: string,
	intakeTaskId: string,
	templateName: string,
	projectName: string | null,
	createdSlugs: string[],
	skippedSlugs: string[],
	wsManager?: WebSocketManager,
): Promise<OnboardingProvisioningCompleteResult> {
	const ctx = await loadCaptainInternalContext(db, teamId);
	if (!ctx) {
		log.warn(`Cannot complete onboarding intake for ${teamId}; missing Captain`);
		return { summaryComment: null, task: null };
	}

	const ts = terminalStatusParams(4);
	const openTask = await db.query<{ id: string; status: string }>(
		`SELECT id, status::text AS status FROM tasks
		 WHERE id = $1 AND team_id = $2 AND labels @> $3::jsonb
		   AND status NOT IN (${ts.placeholders})
		 LIMIT 1`,
		[intakeTaskId, teamId, JSON.stringify([ONBOARDING_INTAKE_LABEL]), ...ts.values],
	);
	if (!openTask.rows[0]) {
		return { summaryComment: null, task: null };
	}

	const created = await loadAgentTitlesBySlugs(db, teamId, createdSlugs);
	const skipped = await loadAgentTitlesBySlugs(db, teamId, skippedSlugs);

	const summaryCommentResult = await db.query<Record<string, unknown>>(
		`INSERT INTO task_comments (task_id, author_member_id, content_type, content)
		 VALUES ($1, $2, $3::comment_content_type, $4::jsonb)
		 RETURNING *`,
		[
			intakeTaskId,
			ctx.captainMemberId,
			CommentContentType.Text,
			JSON.stringify({
				text: buildOnboardingProvisioningCompleteText(templateName, projectName, created, skipped),
			}),
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
			log.error('Failed to recompute downstream readiness after onboarding close:', e);
		}
	}

	return { summaryComment, task };
}

/** Captain ack comment when the admin approves the template in the inbox. */
export async function postOnboardingTemplateApprovedAck(
	db: PGlite,
	teamId: string,
	intakeTaskId: string,
	templateName: string,
): Promise<Record<string, unknown> | null> {
	const ctx = await loadCaptainInternalContext(db, teamId);
	if (!ctx) return null;

	const task = await db.query<{ id: string }>(
		`SELECT id FROM tasks
		 WHERE id = $1 AND team_id = $2 AND labels @> $3::jsonb
		 LIMIT 1`,
		[intakeTaskId, teamId, JSON.stringify([ONBOARDING_INTAKE_LABEL])],
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
			JSON.stringify({ text: buildOnboardingTemplateApprovedAckText(templateName) }),
		],
	);
	return commentResult.rows[0] ?? null;
}

/** Captain note when the admin denies the template approval. */
export async function postOnboardingTemplateDeniedNote(
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
		[intakeTaskId, teamId, JSON.stringify([ONBOARDING_INTAKE_LABEL])],
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
			JSON.stringify({ text: buildOnboardingTemplateDeniedText(resolutionNote) }),
		],
	);
	return commentResult.rows[0] ?? null;
}

/**
 * Posts a system comment + wakes Captain when the admin chooses to skip further
 * questions during the chat flow. Captain should then move directly to the
 * template + project proposal step.
 */
export async function postSkipQuestionsSignal(
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
		[intakeTaskId, teamId, JSON.stringify([ONBOARDING_INTAKE_LABEL])],
	);
	if (!task.rows[0]) return null;

	const commentResult = await db.query<Record<string, unknown>>(
		`INSERT INTO task_comments (task_id, author_member_id, content_type, content)
		 VALUES ($1, NULL, $2::comment_content_type, $3::jsonb)
		 RETURNING *`,
		[
			intakeTaskId,
			CommentContentType.System,
			JSON.stringify({ text: ONBOARDING_INTAKE_SKIP_SIGNAL_TEXT }),
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
