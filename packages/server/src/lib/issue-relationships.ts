import type { PGlite } from '@electric-sql/pglite';
import { HeartbeatRunStatus, IssueStatus, WakeupStatus } from '@hezo/shared';

export const MAX_SUB_ISSUE_DEPTH = 2;

export const SUB_ISSUE_DEPTH_ERROR = `Sub-issues cannot be nested more than ${MAX_SUB_ISSUE_DEPTH} levels deep`;

export type Check = { ok: true } | { ok: false; message: string };

export async function assertChildDepthAllowed(
	db: PGlite,
	companyId: string,
	parentIssueId: string,
): Promise<Check> {
	const r = await db.query<{ id: string; grand_parent_id: string | null }>(
		`SELECT p.id, gp.parent_issue_id AS grand_parent_id
		 FROM issues p
		 LEFT JOIN issues gp ON gp.id = p.parent_issue_id
		 WHERE p.id = $1 AND p.company_id = $2`,
		[parentIssueId, companyId],
	);
	if (r.rows.length === 0) {
		return { ok: false, message: 'Parent issue not found' };
	}
	if (r.rows[0].grand_parent_id !== null) {
		return { ok: false, message: SUB_ISSUE_DEPTH_ERROR };
	}
	return { ok: true };
}

const OPEN_CHILD_STATUSES = [
	IssueStatus.Backlog,
	IssueStatus.InProgress,
	IssueStatus.Review,
	IssueStatus.Approved,
	IssueStatus.Blocked,
	IssueStatus.Done,
	IssueStatus.Cancelled,
];

export async function assertChildrenAllClosed(
	db: PGlite,
	companyId: string,
	issueId: string,
): Promise<Check> {
	const placeholders = OPEN_CHILD_STATUSES.map((_, i) => `$${i + 3}::issue_status`).join(', ');
	const r = await db.query<{ identifier: string; status: string }>(
		`SELECT identifier, status::text AS status
		 FROM issues
		 WHERE parent_issue_id = $1 AND company_id = $2 AND status IN (${placeholders})
		 ORDER BY created_at ASC
		 LIMIT 3`,
		[issueId, companyId, ...OPEN_CHILD_STATUSES],
	);
	if (r.rows.length === 0) return { ok: true };
	const blockers = r.rows.map((c) => `${c.identifier} (${c.status})`).join(', ');
	const plural = r.rows.length > 1 ? 's' : '';
	return {
		ok: false,
		message: `Cannot mark this ticket done/closed — sub-issue${plural} still open: ${blockers}. Sub-issues must reach 'closed' (Coach-reviewed) first.`,
	};
}

const ACTIVE_RUN_STATUSES = [HeartbeatRunStatus.Queued, HeartbeatRunStatus.Running];
const ACTIVE_WAKEUP_STATUSES = [WakeupStatus.Queued, WakeupStatus.Claimed, WakeupStatus.Deferred];
const PING_WAKEUP_SOURCES = ['mention', 'comment', 'reply'];

export async function assertNoOutstandingActivity(
	db: PGlite,
	issueId: string,
	callerMemberId: string | null,
): Promise<Check> {
	const runStatusOffset = 3;
	const runPlaceholders = ACTIVE_RUN_STATUSES.map(
		(_, i) => `$${i + runStatusOffset}::heartbeat_run_status`,
	).join(', ');
	const runs = await db.query<{ slug: string | null; status: string }>(
		`SELECT ma.slug, hr.status::text AS status
		 FROM heartbeat_runs hr
		 LEFT JOIN member_agents ma ON ma.id = hr.member_id
		 WHERE hr.issue_id = $1
		   AND ($2::uuid IS NULL OR hr.member_id != $2::uuid)
		   AND hr.status IN (${runPlaceholders})
		 LIMIT 1`,
		[issueId, callerMemberId, ...ACTIVE_RUN_STATUSES],
	);
	if (runs.rows.length > 0) {
		const who = runs.rows[0].slug ?? 'an agent';
		return {
			ok: false,
			message: `Cannot mark this ticket done — @${who} still has a ${runs.rows[0].status} run on it. Wait for the run to finish (or cancel it) first.`,
		};
	}

	const wakeupStatusOffset = 3 + PING_WAKEUP_SOURCES.length;
	const sourcePlaceholders = PING_WAKEUP_SOURCES.map((_, i) => `$${i + 3}::wakeup_source`).join(
		', ',
	);
	const wakeupPlaceholders = ACTIVE_WAKEUP_STATUSES.map(
		(_, i) => `$${i + wakeupStatusOffset}::wakeup_status`,
	).join(', ');
	const wakeups = await db.query<{ slug: string | null; status: string; source: string }>(
		`SELECT ma.slug, w.status::text AS status, w.source::text AS source
		 FROM agent_wakeup_requests w
		 LEFT JOIN member_agents ma ON ma.id = w.member_id
		 WHERE w.payload->>'issue_id' = $1
		   AND ($2::uuid IS NULL OR w.member_id != $2::uuid)
		   AND w.source IN (${sourcePlaceholders})
		   AND w.status IN (${wakeupPlaceholders})
		 LIMIT 1`,
		[issueId, callerMemberId, ...PING_WAKEUP_SOURCES, ...ACTIVE_WAKEUP_STATUSES],
	);
	if (wakeups.rows.length > 0) {
		const who = wakeups.rows[0].slug ?? 'an agent';
		return {
			ok: false,
			message: `Cannot mark this ticket done — @${who} has a pending ${wakeups.rows[0].source} wakeup on it. Wait for the run to finish first.`,
		};
	}

	return { ok: true };
}
