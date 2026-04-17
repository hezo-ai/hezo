import type { PGlite } from '@electric-sql/pglite';
import {
	AgentAdminStatus,
	CommentContentType,
	IssuePriority,
	IssueStatus,
	TERMINAL_ISSUE_STATUSES,
	WakeupSource,
} from '@hezo/shared';
import { broadcastRowChange } from '../lib/broadcast';
import { logger } from '../logger';
import { createWakeup } from './wakeup';
import type { WebSocketManager } from './ws';

const log = logger.child('goal-tickets');

const GOAL_LABEL = 'goal-update';

export type GoalChangeReason = 'created' | 'updated';

interface CompanyContext {
	ceoMemberId: string;
	operationsProjectId: string;
	issuePrefix: string;
}

async function loadCompanyContext(db: PGlite, companyId: string): Promise<CompanyContext | null> {
	const ceo = await db.query<{ id: string }>(
		`SELECT ma.id FROM member_agents ma
		 JOIN members m ON m.id = ma.id
		 WHERE m.company_id = $1 AND ma.slug = 'ceo' AND ma.admin_status = $2::agent_admin_status
		 LIMIT 1`,
		[companyId, AgentAdminStatus.Enabled],
	);
	const ops = await db.query<{ id: string }>(
		`SELECT id FROM projects
		 WHERE company_id = $1 AND is_internal = true AND slug = 'operations'
		 LIMIT 1`,
		[companyId],
	);
	const company = await db.query<{ issue_prefix: string }>(
		'SELECT issue_prefix FROM companies WHERE id = $1',
		[companyId],
	);
	if (!ceo.rows[0] || !ops.rows[0] || !company.rows[0]) return null;
	return {
		ceoMemberId: ceo.rows[0].id,
		operationsProjectId: ops.rows[0].id,
		issuePrefix: company.rows[0].issue_prefix,
	};
}

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
	companyId: string,
	goalId: string,
	reason: GoalChangeReason,
	wsManager?: WebSocketManager,
): Promise<string | null> {
	const ctx = await loadCompanyContext(db, companyId);
	if (!ctx) {
		log.warn(`Cannot enqueue goal review for ${goalId}; missing CEO or Operations project`);
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
		 WHERE g.id = $1 AND g.company_id = $2`,
		[goalId, companyId],
	);
	const goal = goalResult.rows[0];
	if (!goal) {
		log.warn(`Cannot enqueue goal review; goal ${goalId} not found for company ${companyId}`);
		return null;
	}

	const targetProjectId = goal.project_id ?? ctx.operationsProjectId;
	const scopeLabel = goal.project_name ? `Project: ${goal.project_name}` : 'Company-wide';

	const terminalPlaceholders = TERMINAL_ISSUE_STATUSES.map(
		(_, i) => `$${i + 2}::issue_status`,
	).join(', ');
	const existingResult = await db.query<{ id: string }>(
		`SELECT id FROM issues
		 WHERE company_id = $1
		   AND labels @> '["${GOAL_LABEL}"]'::jsonb
		   AND status NOT IN (${terminalPlaceholders})
		   AND description LIKE '%goal=${goalId}%'
		 LIMIT 1`,
		[companyId, ...TERMINAL_ISSUE_STATUSES],
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
			await createWakeup(db, ctx.ceoMemberId, companyId, WakeupSource.Comment, {
				issue_id: existingIssueId,
				goal_id: goalId,
			});
		} catch (e) {
			log.error('Failed to wake CEO for goal update (dedup path):', e);
		}
		return existingIssueId;
	}

	const numberResult = await db.query<{ number: number }>(
		'SELECT next_issue_number($1) AS number',
		[companyId],
	);
	const issueNumber = numberResult.rows[0].number;
	const identifier = `${ctx.issuePrefix}-${issueNumber}`;

	const issueResult = await db.query<Record<string, unknown>>(
		`INSERT INTO issues (company_id, project_id, assignee_id, number, identifier,
		                     title, description, status, priority, labels)
		 VALUES ($1, $2, $3, $4, $5, $6, $7, $8::issue_status, $9::issue_priority, $10::jsonb)
		 RETURNING *`,
		[
			companyId,
			targetProjectId,
			ctx.ceoMemberId,
			issueNumber,
			identifier,
			`Review plans for goal: "${goal.title}"`,
			buildGoalBody(goalId, goal.title, goal.description, scopeLabel, reason),
			IssueStatus.Open,
			IssuePriority.Medium,
			JSON.stringify([GOAL_LABEL]),
		],
	);
	const issue = issueResult.rows[0];

	if (wsManager) {
		broadcastRowChange(wsManager, `company:${companyId}`, 'issues', 'INSERT', issue);
	}

	try {
		await createWakeup(db, ctx.ceoMemberId, companyId, WakeupSource.Assignment, {
			issue_id: issue.id,
			goal_id: goalId,
		});
	} catch (e) {
		log.error('Failed to wake CEO for goal review:', e);
	}

	return issue.id as string;
}
