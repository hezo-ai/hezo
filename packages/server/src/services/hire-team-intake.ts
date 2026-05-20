import type { PGlite } from '@electric-sql/pglite';
import {
	AgentAdminStatus,
	CAPTAIN_AGENT_SLUG,
	CommentContentType,
	IssuePriority,
	IssueStatus,
	OPERATIONS_PROJECT_SLUG,
	TERMINAL_ISSUE_STATUSES,
	WakeupSource,
	wsRoom,
} from '@hezo/shared';
import { broadcastRowChange } from '../lib/broadcast';
import { recomputeDownstreamReadiness } from '../lib/dependencies';
import { allocateIssueIdentifier } from '../lib/issue-identifier';
import { terminalStatusParams } from '../lib/sql';
import { logger } from '../logger';
import { recordStatusChange } from './issue-events';
import { REQUIREMENTS_INTAKE_LABEL } from './requirements-intake';
import { createWakeup } from './wakeup';
import type { WebSocketManager } from './ws';

const log = logger.child('hire-team-intake');

export const HIRE_TEAM_INTAKE_LABEL = 'hire-team-intake';
export const HIRE_TEAM_INTAKE_MARKER = '<!-- hire-team-intake -->';
export const HIRE_TEAM_INTAKE_TITLE = 'Hire the team';

export const CAPTAIN_HIRE_TEAM_GREETING = `Your first project is set up. Next we need the right specialists on the team.

I'll recommend a team structure from our templates (for example **Startup** for software development work), explain who we'd add and why, then ask you to approve it in the inbox. Once approved, the agents are provisioned automatically.`;

export function buildTeamTemplateApprovedAckText(templateName: string): string {
	return `Thanks for approving the **${templateName}** team template in the inbox.

I'm setting up the team now — provisioning agents and loading their roles. This may take a little while; I'll post another update here once everyone is ready.`;
}

export function buildProvisioningCompleteText(
	templateName: string,
	created: Array<{ title: string }>,
	skipped: Array<{ title: string }>,
): string {
	const lines: string[] = [
		`Team setup is complete. The **${templateName}** template has been applied.`,
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
	lines.push(
		'You can review the team on the home screen and continue to **Start project** when you are ready.',
	);
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

export interface HireTeamProvisioningCompleteResult {
	summaryComment: Record<string, unknown> | null;
	issue: Record<string, unknown> | null;
}

/**
 * After template provisioning finishes: Captain confirms on the hire-team ticket and closes it.
 */
export async function completeHireTeamIntakeAfterProvisioning(
	db: PGlite,
	teamId: string,
	hireIssueId: string,
	templateName: string,
	createdSlugs: string[],
	skippedSlugs: string[],
	wsManager?: WebSocketManager,
): Promise<HireTeamProvisioningCompleteResult> {
	const ctx = await loadTeamContext(db, teamId);
	if (!ctx) {
		log.warn(`Cannot complete hire-team intake for ${teamId}; missing Captain`);
		return { summaryComment: null, issue: null };
	}

	const ts = terminalStatusParams(4);
	const openIssue = await db.query<{ id: string; status: string }>(
		`SELECT id, status::text AS status FROM issues
		 WHERE id = $1 AND team_id = $2 AND labels @> $3::jsonb
		   AND status NOT IN (${ts.placeholders})
		 LIMIT 1`,
		[hireIssueId, teamId, JSON.stringify([HIRE_TEAM_INTAKE_LABEL]), ...ts.values],
	);
	if (!openIssue.rows[0]) {
		return { summaryComment: null, issue: null };
	}

	const created = await loadAgentTitlesBySlugs(db, teamId, createdSlugs);
	const skipped = await loadAgentTitlesBySlugs(db, teamId, skippedSlugs);

	const summaryCommentResult = await db.query<Record<string, unknown>>(
		`INSERT INTO issue_comments (issue_id, author_member_id, content_type, content)
		 VALUES ($1, $2, $3::comment_content_type, $4::jsonb)
		 RETURNING *`,
		[
			hireIssueId,
			ctx.captainMemberId,
			CommentContentType.Text,
			JSON.stringify({
				text: buildProvisioningCompleteText(templateName, created, skipped),
			}),
		],
	);
	const summaryComment = summaryCommentResult.rows[0] ?? null;

	const oldStatus = openIssue.rows[0].status;
	const issueUpdate = await db.query<Record<string, unknown>>(
		`UPDATE issues SET status = $1::issue_status, updated_at = now()
		 WHERE id = $2 AND team_id = $3
		 RETURNING *`,
		[IssueStatus.Done, hireIssueId, teamId],
	);
	const issue = issueUpdate.rows[0] ?? null;

	if (issue) {
		await recordStatusChange(
			db,
			teamId,
			hireIssueId,
			oldStatus,
			IssueStatus.Done,
			ctx.captainMemberId,
			wsManager,
		);
		try {
			await recomputeDownstreamReadiness(db, teamId, hireIssueId, ctx.captainMemberId, wsManager);
		} catch (e) {
			log.error('Failed to recompute downstream readiness after hire-team close:', e);
		}
	}

	return { summaryComment, issue };
}

function buildIssueDescription(): string {
	return `${HIRE_TEAM_INTAKE_MARKER}

## Hire the team

Requirements intake is complete and the board has a first user-facing project. Your job is to propose and provision the delivery team.

### Your task

1. Review the closed **Discuss requirements** ticket and the board's first project (\`list_projects\` — skip internal Operations).
2. Call \`list_team_templates\` and pick the best-fit built-in or custom template (e.g. **Startup** for software development).
3. Post a comment summarising the recommended template, roles to add, and reporting structure. @-mention the board and ask them to confirm.
4. When the board agrees, call \`request_team_template_approval\` with the chosen \`template_id\`, this issue's id, and a short rationale. The board must approve the pending **team_template** approval in the inbox.
5. When the board approves the template in the inbox, agents are provisioned automatically. The server posts setup updates here and closes this ticket when provisioning finishes so the board can move on to **Start project** on the home screen.`;
}

interface TeamContext {
	captainMemberId: string;
	operationsProjectId: string;
}

async function loadTeamContext(db: PGlite, teamId: string): Promise<TeamContext | null> {
	const captain = await db.query<{ id: string }>(
		`SELECT ma.id FROM member_agents ma
		 JOIN members m ON m.id = ma.id
		 WHERE m.team_id = $1 AND ma.slug = $3 AND ma.admin_status = $2::agent_admin_status
		 LIMIT 1`,
		[teamId, AgentAdminStatus.Enabled, CAPTAIN_AGENT_SLUG],
	);
	const ops = await db.query<{ id: string }>(
		`SELECT id FROM projects
		 WHERE team_id = $1 AND is_internal = true AND slug = $2
		 LIMIT 1`,
		[teamId, OPERATIONS_PROJECT_SLUG],
	);
	if (!captain.rows[0] || !ops.rows[0]) return null;
	return {
		captainMemberId: captain.rows[0].id,
		operationsProjectId: ops.rows[0].id,
	};
}

async function findOpenHireTeamIssue(
	db: PGlite,
	teamId: string,
): Promise<{
	id: string;
	identifier: string;
	project_slug: string;
} | null> {
	const terminalPlaceholders = TERMINAL_ISSUE_STATUSES.map(
		(_, i) => `$${i + 3}::issue_status`,
	).join(', ');
	const result = await db.query<{ id: string; identifier: string; project_slug: string }>(
		`SELECT i.id, i.identifier, p.slug AS project_slug
		 FROM issues i
		 JOIN projects p ON p.id = i.project_id
		 WHERE i.team_id = $1
		   AND i.labels @> $2::jsonb
		   AND i.status NOT IN (${terminalPlaceholders})
		 ORDER BY i.created_at ASC
		 LIMIT 1`,
		[teamId, JSON.stringify([HIRE_TEAM_INTAKE_LABEL]), ...TERMINAL_ISSUE_STATUSES],
	);
	return result.rows[0] ?? null;
}

export async function createHireTeamIntakeIssue(
	db: PGlite,
	teamId: string,
): Promise<{ issueId: string; captainMemberId: string } | null> {
	const ctx = await loadTeamContext(db, teamId);
	if (!ctx) {
		log.warn(`Cannot create hire-team intake for ${teamId}; missing Captain or Operations`);
		return null;
	}

	const existing = await findOpenHireTeamIssue(db, teamId);
	if (existing) return null;

	const { number: issueNumber, identifier } = await allocateIssueIdentifier(
		db,
		ctx.operationsProjectId,
	);

	const issueResult = await db.query<{ id: string }>(
		`INSERT INTO issues (team_id, project_id, assignee_id, number, identifier,
		                     title, description, status, priority, labels)
		 VALUES ($1, $2, $3, $4, $5, $6, $7, $8::issue_status, $9::issue_priority, $10::jsonb)
		 RETURNING id`,
		[
			teamId,
			ctx.operationsProjectId,
			ctx.captainMemberId,
			issueNumber,
			identifier,
			HIRE_TEAM_INTAKE_TITLE,
			buildIssueDescription(),
			IssueStatus.InProgress,
			IssuePriority.High,
			JSON.stringify([HIRE_TEAM_INTAKE_LABEL]),
		],
	);
	const issueId = issueResult.rows[0].id;

	await db.query(
		`INSERT INTO issue_comments (issue_id, author_member_id, content_type, content)
		 VALUES ($1, $2, $3::comment_content_type, $4::jsonb)`,
		[
			issueId,
			ctx.captainMemberId,
			CommentContentType.Text,
			JSON.stringify({ text: CAPTAIN_HIRE_TEAM_GREETING }),
		],
	);

	return { issueId, captainMemberId: ctx.captainMemberId };
}

/**
 * Post a Captain comment on the hire-team intake issue when the board approves the template.
 */
export async function postHireTeamTemplateApprovedAck(
	db: PGlite,
	teamId: string,
	hireIssueId: string,
	templateName: string,
): Promise<Record<string, unknown> | null> {
	const ctx = await loadTeamContext(db, teamId);
	if (!ctx) {
		log.warn(`Cannot post template-approved ack for team ${teamId}; missing Captain`);
		return null;
	}

	const issue = await db.query<{ id: string }>(
		`SELECT id FROM issues
		 WHERE id = $1 AND team_id = $2 AND labels @> $3::jsonb
		 LIMIT 1`,
		[hireIssueId, teamId, JSON.stringify([HIRE_TEAM_INTAKE_LABEL])],
	);
	if (!issue.rows[0]) {
		log.warn(`Cannot post template-approved ack; hire-team issue ${hireIssueId} not found`);
		return null;
	}

	const commentResult = await db.query<Record<string, unknown>>(
		`INSERT INTO issue_comments (issue_id, author_member_id, content_type, content)
		 VALUES ($1, $2, $3::comment_content_type, $4::jsonb)
		 RETURNING *`,
		[
			hireIssueId,
			ctx.captainMemberId,
			CommentContentType.Text,
			JSON.stringify({ text: buildTeamTemplateApprovedAckText(templateName) }),
		],
	);
	return commentResult.rows[0] ?? null;
}

export async function wakeCaptainForHireTeamIntake(
	db: PGlite,
	teamId: string,
	captainMemberId: string,
	issueId: string,
): Promise<void> {
	try {
		await createWakeup(db, captainMemberId, teamId, WakeupSource.Assignment, {
			issue_id: issueId,
		});
	} catch (e) {
		log.error('Failed to wake Captain for hire-team intake:', e);
	}
}

export interface HireTeamIntakeIssue {
	issue_id: string;
	issue_identifier: string;
	project_slug: string;
	captain_greeting: string;
	captain_member_id: string;
	captain_title: string;
}

async function buildIntakeResponse(
	db: PGlite,
	ctx: TeamContext,
	row: { id: string; identifier: string; project_slug: string },
): Promise<HireTeamIntakeIssue> {
	const captainTitle = await db.query<{ title: string }>(
		'SELECT title FROM member_agents WHERE id = $1',
		[ctx.captainMemberId],
	);

	return {
		issue_id: row.id,
		issue_identifier: row.identifier,
		project_slug: row.project_slug,
		captain_greeting: CAPTAIN_HIRE_TEAM_GREETING,
		captain_member_id: ctx.captainMemberId,
		captain_title: captainTitle.rows[0]?.title ?? 'Captain',
	};
}

export async function getOpenHireTeamIntakeIssue(
	db: PGlite,
	teamId: string,
): Promise<HireTeamIntakeIssue | null> {
	const ctx = await loadTeamContext(db, teamId);
	if (!ctx) return null;
	const row = await findOpenHireTeamIssue(db, teamId);
	if (!row) return null;
	return buildIntakeResponse(db, ctx, row);
}

/**
 * When requirements intake completes, open the hire-team ticket (idempotent).
 */
export async function onRequirementsIntakeCompleted(
	db: PGlite,
	teamId: string,
	issueId: string,
	wsManager?: WebSocketManager,
): Promise<void> {
	const issue = await db.query<{ labels: unknown }>(
		'SELECT labels FROM issues WHERE id = $1 AND team_id = $2',
		[issueId, teamId],
	);
	const labels = Array.isArray(issue.rows[0]?.labels) ? issue.rows[0].labels : [];
	if (!labels.includes(REQUIREMENTS_INTAKE_LABEL)) return;

	const created = await createHireTeamIntakeIssue(db, teamId);
	if (!created) return;

	const row = await findOpenHireTeamIssue(db, teamId);
	if (row && wsManager) {
		const issueFull = await db.query<Record<string, unknown>>(
			'SELECT * FROM issues WHERE id = $1',
			[row.id],
		);
		if (issueFull.rows[0]) {
			broadcastRowChange(wsManager, wsRoom.team(teamId), 'issues', 'INSERT', issueFull.rows[0]);
		}
	}

	await wakeCaptainForHireTeamIntake(db, teamId, created.captainMemberId, created.issueId);
}
