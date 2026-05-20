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
import { allocateIssueIdentifier } from '../lib/issue-identifier';
import { logger } from '../logger';
import { createWakeup } from './wakeup';
import type { WebSocketManager } from './ws';

const log = logger.child('requirements-intake');

export const REQUIREMENTS_INTAKE_LABEL = 'requirements-intake';
export const REQUIREMENTS_INTAKE_MARKER = '<!-- requirements-intake -->';

export const REQUIREMENTS_INTAKE_TITLE = 'Discuss requirements for your first project';

export const CAPTAIN_GREETING_TEXT = `Hi — I'm the Captain for your team. I'd like to understand what you're looking to achieve so we can shape your first project together.

What's on your mind? Share the problem you want to solve, who it's for, and anything you already know about scope or constraints.`;

function buildIssueDescription(): string {
	return `${REQUIREMENTS_INTAKE_MARKER}

## Gather requirements for the first project

The board is starting fresh. Use this ticket as a conversation thread to learn what they want to build before any user-facing project exists.

### Your task

1. Read the board's messages on this ticket and ask clarifying questions until you understand goals, users, scope, and constraints.
2. When requirements are clear enough, create their first project via \`create_project\` with a solid name and description (and an initial PRD in project docs if they provided detail). Confirm with the board in a comment before creating if anything is ambiguous.
3. Do not create duplicate projects — check existing projects first.
4. After the first project exists and the board is oriented, post a short summary comment and move this issue to **done**.`;
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

async function findOpenIntakeIssue(
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
		[teamId, JSON.stringify([REQUIREMENTS_INTAKE_LABEL]), ...TERMINAL_ISSUE_STATUSES],
	);
	return result.rows[0] ?? null;
}

/**
 * Creates the Operations requirements-intake issue and Captain greeting comment.
 * Idempotent: returns null if an open intake issue already exists.
 */
export async function createRequirementsIntakeIssue(
	db: PGlite,
	teamId: string,
): Promise<{ issueId: string; captainMemberId: string } | null> {
	const ctx = await loadTeamContext(db, teamId);
	if (!ctx) {
		log.warn(`Cannot create requirements intake for ${teamId}; missing Captain or Operations`);
		return null;
	}

	const existing = await findOpenIntakeIssue(db, teamId);
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
			REQUIREMENTS_INTAKE_TITLE,
			buildIssueDescription(),
			IssueStatus.InProgress,
			IssuePriority.High,
			JSON.stringify([REQUIREMENTS_INTAKE_LABEL]),
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
			JSON.stringify({ text: CAPTAIN_GREETING_TEXT }),
		],
	);

	return { issueId, captainMemberId: ctx.captainMemberId };
}

export async function wakeCaptainForRequirementsIntake(
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
		log.error('Failed to wake Captain for requirements intake:', e);
	}
}

export interface RequirementsIntakeIssue {
	issue_id: string;
	issue_identifier: string;
	project_slug: string;
	captain_greeting: string;
	captain_member_id: string;
	captain_title: string;
}

/**
 * Returns the open requirements-intake issue, creating it if missing (e.g. legacy teams).
 */
async function buildIntakeResponse(
	db: PGlite,
	_teamId: string,
	ctx: TeamContext,
	row: { id: string; identifier: string; project_slug: string },
): Promise<RequirementsIntakeIssue> {
	const captainTitle = await db.query<{ title: string }>(
		'SELECT title FROM member_agents WHERE id = $1',
		[ctx.captainMemberId],
	);

	return {
		issue_id: row.id,
		issue_identifier: row.identifier,
		project_slug: row.project_slug,
		captain_greeting: CAPTAIN_GREETING_TEXT,
		captain_member_id: ctx.captainMemberId,
		captain_title: captainTitle.rows[0]?.title ?? 'Captain',
	};
}

/** Read-only: returns null when the discuss-requirements ticket is closed or missing. */
export async function getOpenRequirementsIntakeIssue(
	db: PGlite,
	teamId: string,
): Promise<RequirementsIntakeIssue | null> {
	const ctx = await loadTeamContext(db, teamId);
	if (!ctx) return null;
	const row = await findOpenIntakeIssue(db, teamId);
	if (!row) return null;
	return buildIntakeResponse(db, teamId, ctx, row);
}

/**
 * Returns the open requirements-intake issue, creating it if missing (e.g. legacy teams).
 */
export async function ensureRequirementsIntakeIssue(
	db: PGlite,
	teamId: string,
	wsManager?: WebSocketManager,
): Promise<RequirementsIntakeIssue | null> {
	const ctx = await loadTeamContext(db, teamId);
	if (!ctx) return null;

	let row = await findOpenIntakeIssue(db, teamId);
	if (!row) {
		const created = await createRequirementsIntakeIssue(db, teamId);
		if (!created) {
			row = await findOpenIntakeIssue(db, teamId);
		} else {
			row = await findOpenIntakeIssue(db, teamId);
			if (row && wsManager) {
				const issueFull = await db.query<Record<string, unknown>>(
					'SELECT * FROM issues WHERE id = $1',
					[row.id],
				);
				if (issueFull.rows[0]) {
					broadcastRowChange(wsManager, wsRoom.team(teamId), 'issues', 'INSERT', issueFull.rows[0]);
				}
			}
			if (created) {
				await wakeCaptainForRequirementsIntake(
					db,
					teamId,
					created.captainMemberId,
					created.issueId,
				);
			}
		}
	}

	if (!row) return null;
	return buildIntakeResponse(db, teamId, ctx, row);
}
