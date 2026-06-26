import type { PGlite } from '@electric-sql/pglite';
import { HeartbeatRunStatus, TaskStatus, WakeupStatus } from '@hezo/shared';

export const MAX_SUB_TASK_DEPTH = 2;

export const SUB_TASK_DEPTH_ERROR = `Sub-tasks cannot be nested more than ${MAX_SUB_TASK_DEPTH} levels deep`;

export type Check = { ok: true } | { ok: false; message: string };

export async function assertChildDepthAllowed(
	db: PGlite,
	teamId: string,
	parentTaskId: string,
): Promise<Check> {
	const r = await db.query<{ id: string; grand_parent_id: string | null }>(
		`SELECT p.id, gp.parent_task_id AS grand_parent_id
		 FROM tasks p
		 LEFT JOIN tasks gp ON gp.id = p.parent_task_id
		 WHERE p.id = $1 AND p.team_id = $2`,
		[parentTaskId, teamId],
	);
	if (r.rows.length === 0) {
		return { ok: false, message: 'Parent task not found' };
	}
	if (r.rows[0].grand_parent_id !== null) {
		return { ok: false, message: SUB_TASK_DEPTH_ERROR };
	}
	return { ok: true };
}

// Sub-task statuses that still block the parent from being marked done. A parent
// can only be marked done once every sub-task has reached a terminal state —
// `done` (completed) or `cancelled` (abandoned). Both terminal statuses are
// intentionally absent: each is resolved and will never reopen on its own, so
// gating on them would strand the parent permanently. This mirrors
// `hasOpenBlockers` in dependencies.ts, where a terminal upstream satisfies a
// dependency.
const OPEN_CHILD_STATUSES = [
	TaskStatus.Backlog,
	TaskStatus.InProgress,
	TaskStatus.Review,
	TaskStatus.Blocked,
];

export async function assertChildrenAllClosed(
	db: PGlite,
	teamId: string,
	taskId: string,
): Promise<Check> {
	const placeholders = OPEN_CHILD_STATUSES.map((_, i) => `$${i + 3}::task_status`).join(', ');
	const r = await db.query<{ identifier: string; status: string }>(
		`SELECT identifier, status::text AS status
		 FROM tasks
		 WHERE parent_task_id = $1 AND team_id = $2 AND status IN (${placeholders})
		 ORDER BY created_at ASC
		 LIMIT 3`,
		[taskId, teamId, ...OPEN_CHILD_STATUSES],
	);
	if (r.rows.length === 0) return { ok: true };
	const blockers = r.rows.map((c) => `${c.identifier} (${c.status})`).join(', ');
	const plural = r.rows.length > 1 ? 's' : '';
	return {
		ok: false,
		message: `Cannot mark this ticket done — sub-task${plural} still open: ${blockers}. Sub-tasks must reach 'done' or 'cancelled' first.`,
	};
}

const ACTIVE_RUN_STATUSES = [HeartbeatRunStatus.Queued, HeartbeatRunStatus.Running];
const ACTIVE_WAKEUP_STATUSES = [WakeupStatus.Queued, WakeupStatus.Claimed, WakeupStatus.Deferred];
const PING_WAKEUP_SOURCES = ['mention', 'comment', 'reply'];

export async function assertNoOutstandingActivity(
	db: PGlite,
	taskId: string,
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
		 WHERE hr.task_id = $1
		   AND ($2::uuid IS NULL OR hr.member_id != $2::uuid)
		   AND hr.status IN (${runPlaceholders})
		 LIMIT 1`,
		[taskId, callerMemberId, ...ACTIVE_RUN_STATUSES],
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
		 WHERE w.payload->>'task_id' = $1
		   AND ($2::uuid IS NULL OR w.member_id != $2::uuid)
		   AND w.source IN (${sourcePlaceholders})
		   AND w.status IN (${wakeupPlaceholders})
		 LIMIT 1`,
		[taskId, callerMemberId, ...PING_WAKEUP_SOURCES, ...ACTIVE_WAKEUP_STATUSES],
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
