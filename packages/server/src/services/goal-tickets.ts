import type { PGlite } from '@electric-sql/pglite';
import { CommentContentType, IssuePriority, IssueStatus, WakeupSource, wsRoom } from '@hezo/shared';
import { broadcastRowChange } from '../lib/broadcast';
import { allocateIssueIdentifier } from '../lib/issue-identifier';
import { terminalStatusParams } from '../lib/sql';
import { logger } from '../logger';
import { isTeamExecutionStarted } from './onboarding';
import { loadCaptainOpsContext } from './operations-intake';
import { createWakeup } from './wakeup';
import type { WebSocketManager } from './ws';

const log = logger.child('goal-tickets');

const GOAL_LABEL = 'goal-update';

export type GoalChangeReason = 'created' | 'updated';

function buildGoalBody(
	goalId: string,
	title: string,
	description: string,
	scopeLabel: string,
	reason: GoalChangeReason,
): string {
	return `<!-- goal=${goalId} -->

## Plan review triggered by goal ${reason === 'created' ? 'creation' : 'update'}

The following goal has been ${reason === 'created' ? 'added' : 'changed'}. Re-read it and confirm the current plan still serves it — open follow-up tickets where plans drift.

### Goal: ${title}

_Scope: ${scopeLabel}_

${description || '_(no description provided)_'}

### Your task

1. Re-read the goal above and consider whether any active project plans need updating to serve it.
2. Review the relevant projects' current open issues, sprint plans, and docs. For each project whose direction has drifted, open a ticket for the responsible agent with a clear call-to-action.
3. If no changes are needed, post a short comment on this issue summarising why the current plan already covers the goal.
4. Move this issue to **done** once you have opened any required follow-ups or confirmed no action is needed.`;
}

export async function enqueueGoalReviewTask(
	db: PGlite,
	teamId: string,
	goalId: string,
	reason: GoalChangeReason,
	wsManager?: WebSocketManager,
): Promise<string | null> {
	if (!(await isTeamExecutionStarted(db, teamId))) {
		log.info(`Deferring goal review for ${goalId} until project execution is confirmed`);
		return null;
	}

	const ctx = await loadCaptainOpsContext(db, teamId);
	if (!ctx) {
		log.warn(`Cannot enqueue goal review for ${goalId}; missing Captain or Operations project`);
		return null;
	}

	const goalResult = await db.query<{
		title: string;
		description: string;
		project_id: string | null;
		project_name: string | null;
	}>(
		`SELECT g.title, g.description, g.project_id,
		        (SELECT name FROM projects p WHERE p.id = g.project_id) AS project_name
		 FROM goals g
		 WHERE g.id = $1 AND g.team_id = $2`,
		[goalId, teamId],
	);
	const goal = goalResult.rows[0];
	if (!goal) {
		log.warn(`Cannot enqueue goal review; goal ${goalId} not found for team ${teamId}`);
		return null;
	}

	const targetProjectId = goal.project_id ?? ctx.operationsProjectId;
	const scopeLabel = goal.project_name ? `Project: ${goal.project_name}` : 'Team-wide';

	const ts = terminalStatusParams(2);
	const existingResult = await db.query<{ id: string }>(
		`SELECT id FROM issues
		 WHERE team_id = $1
		   AND labels @> '["${GOAL_LABEL}"]'::jsonb
		   AND status NOT IN (${ts.placeholders})
		   AND description LIKE '%goal=${goalId}%'
		 LIMIT 1`,
		[teamId, ...ts.values],
	);

	if (existingResult.rows[0]) {
		const existingIssueId = existingResult.rows[0].id;
		await db.query(
			`INSERT INTO issue_comments (issue_id, content_type, content)
			 VALUES ($1, $2::comment_content_type, $3::jsonb)`,
			[
				existingIssueId,
				CommentContentType.System,
				JSON.stringify({
					text: `Goal "${goal.title}" was ${reason === 'created' ? 'recreated' : 'updated again'}. Please re-read and re-evaluate.`,
				}),
			],
		);
		try {
			await createWakeup(db, ctx.captainMemberId, teamId, WakeupSource.Comment, {
				issue_id: existingIssueId,
				goal_id: goalId,
			});
		} catch (e) {
			log.error('Failed to wake Captain for goal update (dedup path):', e);
		}
		return existingIssueId;
	}

	const { number: issueNumber, identifier } = await allocateIssueIdentifier(db, targetProjectId);

	const issueResult = await db.query<Record<string, unknown>>(
		`INSERT INTO issues (team_id, project_id, assignee_id, number, identifier,
		                     title, description, status, priority, labels)
		 VALUES ($1, $2, $3, $4, $5, $6, $7, $8::issue_status, $9::issue_priority, $10::jsonb)
		 RETURNING *`,
		[
			teamId,
			targetProjectId,
			ctx.captainMemberId,
			issueNumber,
			identifier,
			`Review plans for goal: "${goal.title}"`,
			buildGoalBody(goalId, goal.title, goal.description, scopeLabel, reason),
			IssueStatus.Backlog,
			IssuePriority.Medium,
			JSON.stringify([GOAL_LABEL]),
		],
	);
	const issue = issueResult.rows[0];

	if (wsManager) {
		broadcastRowChange(wsManager, wsRoom.team(teamId), 'issues', 'INSERT', issue);
	}

	try {
		await createWakeup(db, ctx.captainMemberId, teamId, WakeupSource.Assignment, {
			issue_id: issue.id,
			goal_id: goalId,
		});
	} catch (e) {
		log.error('Failed to wake Captain for goal review:', e);
	}

	return issue.id as string;
}
