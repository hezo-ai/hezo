import type { PGlite } from '@electric-sql/pglite';
import {
	IssueStatus,
	TERMINAL_ISSUE_STATUSES,
	WakeupSource,
	WakeupStatus,
	wsRoom,
} from '@hezo/shared';
import { logger } from '../logger';
import { recordStatusChange } from '../services/issue-events';
import { createWakeup } from '../services/wakeup';
import type { WebSocketManager } from '../services/ws';
import { broadcastRowChange } from './broadcast';

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
 * reconcile each downstream's status against its current blocker state, then
 * wake any that just became unblocked. Used on both directions of upstream
 * status transitions (terminal entry/exit) and on direct dependency
 * mutations.
 *
 * For each downstream issue whose blockers just cleared, `wakeIfReady`
 * flips an existing deferred wakeup back to `queued` if one exists;
 * otherwise it enqueues a fresh assignment-source wakeup with an
 * idempotency key keyed on the downstream issue ID, so concurrent unblock
 * events don't fan out duplicate runs.
 */
export async function recomputeDownstreamReadiness(
	db: PGlite,
	companyId: string,
	blockerIssueId: string,
	actorMemberId: string | null,
	wsManager: WebSocketManager | undefined,
): Promise<void> {
	const downstream = await db.query<{ issue_id: string }>(
		'SELECT DISTINCT issue_id FROM issue_dependencies WHERE blocked_by_issue_id = $1',
		[blockerIssueId],
	);
	for (const row of downstream.rows) {
		const newStatus = await reconcileBlockedStatus(
			db,
			companyId,
			row.issue_id,
			actorMemberId,
			wsManager,
		);
		if (newStatus === IssueStatus.Backlog || newStatus === null) {
			await wakeIfReady(db, row.issue_id);
		}
	}
}

/**
 * Coerce a requested status against the blocked-derivation invariant.
 * Terminal targets pass through unchanged. For non-terminal targets: if
 * the issue has any open blocker, the target collapses to `blocked`;
 * if no open blockers remain and the caller asked for `blocked`, the
 * target collapses to `backlog` (since `blocked` is purely derived).
 */
export async function coerceTargetStatusForBlockers(
	db: PGlite,
	issueId: string,
	requested: string,
): Promise<string> {
	if ((TERMINAL_ISSUE_STATUSES as readonly string[]).includes(requested)) return requested;
	const blocked = await hasOpenBlockers(db, issueId);
	if (blocked) return IssueStatus.Blocked;
	if (requested === IssueStatus.Blocked) return IssueStatus.Backlog;
	return requested;
}

/**
 * Reconcile an issue's stored status against its current blocker state.
 * Terminal issues are never touched. Returns the new status when changed,
 * or null when no update was needed.
 */
export async function reconcileBlockedStatus(
	db: PGlite,
	companyId: string,
	issueId: string,
	actorMemberId: string | null,
	wsManager: WebSocketManager | undefined,
): Promise<string | null> {
	const r = await db.query<{ status: string }>('SELECT status FROM issues WHERE id = $1', [
		issueId,
	]);
	const current = r.rows[0]?.status;
	if (!current) return null;
	if ((TERMINAL_ISSUE_STATUSES as readonly string[]).includes(current)) return null;

	const blocked = await hasOpenBlockers(db, issueId);
	let target: string | null = null;
	if (blocked && current !== IssueStatus.Blocked) target = IssueStatus.Blocked;
	else if (!blocked && current === IssueStatus.Blocked) target = IssueStatus.Backlog;
	if (!target) return null;

	const updated = await db.query<Record<string, unknown>>(
		'UPDATE issues SET status = $1::issue_status, updated_at = NOW() WHERE id = $2 RETURNING *',
		[target, issueId],
	);
	const row = updated.rows[0];
	if (!row) return null;

	await recordStatusChange(db, companyId, issueId, current, target, actorMemberId, wsManager);
	broadcastRowChange(wsManager, wsRoom.company(companyId), 'issues', 'UPDATE', row);
	return target;
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
