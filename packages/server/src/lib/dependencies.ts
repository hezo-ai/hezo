import type { PGlite } from '@electric-sql/pglite';
import { TERMINAL_ISSUE_STATUSES, WakeupSource, WakeupStatus } from '@hezo/shared';
import { logger } from '../logger';
import { createWakeup } from '../services/wakeup';

const log = logger.child('dependencies');

/**
 * Wakeup sources that auto-fire on system state changes and should respect
 * dependency gates. User-initiated and conversational sources (mentions,
 * comments, option/credential responses, automations) are not in this set —
 * humans or peers explicitly poking an agent reach it even on a blocked
 * ticket.
 */
export const GATED_WAKEUP_SOURCES: ReadonlySet<string> = new Set([
	WakeupSource.Assignment,
	WakeupSource.Heartbeat,
	WakeupSource.Timer,
]);

/**
 * Decide whether a wakeup targeting `issueId` should be parked in the
 * deferred state because the target ticket has open blockers. Returns false
 * when the source bypasses the gate, the wakeup has no specific issue
 * target, or the issue itself is already in a terminal status (post-hoc
 * runs like Coach review on Done must always proceed).
 */
export async function shouldDeferWakeupForBlockers(
	db: PGlite,
	source: string,
	issueId: string | null | undefined,
): Promise<boolean> {
	if (!GATED_WAKEUP_SOURCES.has(source)) return false;
	if (!issueId) return false;
	const statusRow = await db.query<{ status: string }>('SELECT status FROM issues WHERE id = $1', [
		issueId,
	]);
	const status = statusRow.rows[0]?.status;
	if (status && (TERMINAL_ISSUE_STATUSES as readonly string[]).includes(status)) return false;
	return hasOpenBlockers(db, issueId);
}

/**
 * True when `issueId` has at least one blocker whose status is not terminal.
 * A blocker is satisfied when the upstream issue reaches `done`, `closed`, or
 * `cancelled`. Anything else (backlog, in_progress, review, blocked) leaves
 * the downstream gated.
 */
export async function hasOpenBlockers(db: PGlite, issueId: string): Promise<boolean> {
	const terminalPlaceholders = TERMINAL_ISSUE_STATUSES.map(
		(_, i) => `$${i + 2}::issue_status`,
	).join(', ');
	const r = await db.query(
		`SELECT 1
		 FROM issue_dependencies d
		 JOIN issues b ON b.id = d.blocked_by_issue_id
		 WHERE d.issue_id = $1
		   AND b.status NOT IN (${terminalPlaceholders})
		 LIMIT 1`,
		[issueId, ...TERMINAL_ISSUE_STATUSES],
	);
	return r.rows.length > 0;
}

/**
 * True when adding an edge `issueId blocked_by blockerId` would create a
 * cycle in the existing dependency graph. Runs a recursive CTE that walks
 * the existing blockers of `blockerId`; if `issueId` appears in that chain
 * (or `blockerId === issueId`), the new edge would close the loop.
 */
export async function wouldCreateCycle(
	db: PGlite,
	issueId: string,
	blockerId: string,
): Promise<boolean> {
	if (issueId === blockerId) return true;
	const r = await db.query(
		`WITH RECURSIVE chain AS (
		   SELECT blocked_by_issue_id AS id FROM issue_dependencies WHERE issue_id = $1
		   UNION
		   SELECT d.blocked_by_issue_id FROM issue_dependencies d
		   JOIN chain c ON c.id = d.issue_id
		 )
		 SELECT 1 FROM chain WHERE id = $2 LIMIT 1`,
		[blockerId, issueId],
	);
	return r.rows.length > 0;
}

/**
 * Walk the downstream side of the dependency graph for `blockerIssueId` and
 * wake up any issue whose blockers are now all satisfied. Used on the three
 * unblock paths: a terminal-status transition, an explicit dependency
 * removal, and the side-effect of `triggerStatusAutomations`.
 *
 * For each newly-unblocked downstream issue, the deferred wakeup is flipped
 * back to `queued` if one exists; otherwise a fresh assignment-source wakeup
 * is enqueued with an idempotency key keyed on the downstream issue ID, so
 * concurrent unblock events don't fan out duplicate runs.
 */
export async function recomputeDownstreamReadiness(
	db: PGlite,
	blockerIssueId: string,
): Promise<void> {
	const downstream = await db.query<{ issue_id: string }>(
		'SELECT DISTINCT issue_id FROM issue_dependencies WHERE blocked_by_issue_id = $1',
		[blockerIssueId],
	);
	for (const row of downstream.rows) {
		await wakeIfReady(db, row.issue_id);
	}
}

/**
 * Wake the assignee for a single downstream issue if it no longer has any
 * open blockers. Splits out so callers that already know the issue ID (e.g.
 * REST `DELETE /dependencies/:depId`) don't pay for the downstream lookup.
 */
export async function wakeIfReady(db: PGlite, issueId: string): Promise<void> {
	if (await hasOpenBlockers(db, issueId)) return;

	const issue = await db.query<{ assignee_id: string | null; company_id: string }>(
		'SELECT assignee_id, company_id FROM issues WHERE id = $1',
		[issueId],
	);
	const row = issue.rows[0];
	if (!row || !row.assignee_id) return;

	const isAgent = await db.query('SELECT id FROM member_agents WHERE id = $1', [row.assignee_id]);
	if (isAgent.rows.length === 0) return;

	const flipped = await db.query<{ id: string }>(
		`UPDATE agent_wakeup_requests
		 SET status = $1::wakeup_status, claimed_at = NULL
		 WHERE member_id = $2
		   AND status = $3::wakeup_status
		   AND payload->>'issue_id' = $4
		   AND payload->>'reason' = 'blocked'
		 RETURNING id`,
		[WakeupStatus.Queued, row.assignee_id, WakeupStatus.Deferred, issueId],
	);

	if (flipped.rows.length > 0) return;

	try {
		await createWakeup(
			db,
			row.assignee_id,
			row.company_id,
			WakeupSource.Assignment,
			{ issue_id: issueId, reason: 'unblocked' },
			`unblock:${issueId}`,
		);
	} catch (e) {
		log.error('Failed to create unblock wakeup:', e);
	}
}
