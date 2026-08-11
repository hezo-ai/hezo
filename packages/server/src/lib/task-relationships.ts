import {
	ACTIVE_WAKEUP_STATUSES,
	CommentContentType,
	HeartbeatRunStatus,
	TaskStatus,
	TERMINAL_TASK_STATUSES,
} from '@hezo/shared';
import type { Db } from '../db/database';
import { resolveTaskId } from './resolve';

export const MAX_SUB_TASK_DEPTH = 3;

export const SUB_TASK_DEPTH_ERROR = `Sub-tasks cannot be nested more than ${MAX_SUB_TASK_DEPTH} levels deep`;

export type Check = { ok: true } | { ok: false; message: string };

/**
 * How a proposed parent sits in the tree, and how tall the task being moved is.
 * Everything that needs to reason about hierarchy shape reads it from here, so
 * the recursive walks exist in exactly one place.
 */
export interface ParentPlacement {
	parentFound: boolean;
	parentProjectId: string | null;
	parentIdentifier: string | null;
	parentStatus: string | null;
	/** Edges from the tree root down to the proposed parent. */
	parentDepth: number;
	/** Edges from the moving task down to its deepest descendant (0 = leaf). */
	movingHeight: number;
	/** True when the proposed parent is the moving task or sits inside its sub-tree. */
	parentInMovingSubtree: boolean;
}

// One extra level beyond the cap so an over-deep tree is *measured* as over-deep
// rather than silently clamped to the legal maximum.
const TREE_WALK_LIMIT = MAX_SUB_TASK_DEPTH + 2;

/**
 * Measure both halves of a parent assignment in a single round trip: an ancestor
 * walk up from the proposed parent (its depth) and a descendant walk down from
 * the task being moved (its height, and whether the parent is inside it).
 *
 * `movingTaskId` is null on the create path, where no row exists yet: the
 * descendant CTE then seeds nothing, giving height 0 and no sub-tree overlap.
 *
 * Two things here look removable and are not. The `team_id` filter on the seed
 * *and* recursive term of both CTEs is load-bearing: `resolveTaskId` returns any
 * well-formed UUID unvalidated (only its identifier branch is team-scoped), so
 * without this a raw UUID naming another team's task would resolve and re-parent
 * across teams. And the depth cap on each recursion bounds the walk if data ever
 * went cyclic through a concurrent-write race, which an uncapped UNION ALL would
 * spin on. The descendant walk rides `idx_tasks_parent`; the ancestor walk rides
 * the primary key. Both are bounded to a handful of rows.
 */
export async function measureParentPlacement(
	db: Db,
	teamId: string,
	parentTaskId: string,
	movingTaskId: string | null,
): Promise<ParentPlacement> {
	const r = await db.query<{
		parent_found: number;
		parent_project_id: string | null;
		parent_identifier: string | null;
		parent_status: string | null;
		parent_depth: number | null;
		moving_height: number | null;
		parent_in_subtree: number;
	}>(
		`WITH RECURSIVE ancestors AS (
		   SELECT id, parent_task_id, project_id, identifier,
		          status::text AS status, 0 AS depth
		     FROM tasks WHERE id = $1::uuid AND team_id = $3
		   UNION ALL
		   SELECT p.id, p.parent_task_id, p.project_id, p.identifier,
		          p.status::text, a.depth + 1
		     FROM tasks p JOIN ancestors a ON a.parent_task_id = p.id
		    WHERE p.team_id = $3 AND a.depth < $4
		 ), descendants AS (
		   SELECT id, 0 AS height
		     FROM tasks WHERE id = $2::uuid AND team_id = $3
		   UNION ALL
		   SELECT c.id, d.height + 1
		     FROM tasks c JOIN descendants d ON c.parent_task_id = d.id
		    WHERE c.team_id = $3 AND d.height < $4
		 )
		 SELECT (SELECT count(*)::int  FROM ancestors WHERE depth = 0)       AS parent_found,
		        (SELECT project_id      FROM ancestors WHERE depth = 0)       AS parent_project_id,
		        (SELECT identifier      FROM ancestors WHERE depth = 0)       AS parent_identifier,
		        (SELECT status          FROM ancestors WHERE depth = 0)       AS parent_status,
		        (SELECT max(depth)      FROM ancestors)                       AS parent_depth,
		        (SELECT max(height)     FROM descendants)                     AS moving_height,
		        (SELECT count(*)::int   FROM descendants WHERE id = $1::uuid) AS parent_in_subtree`,
		[parentTaskId, movingTaskId, teamId, TREE_WALK_LIMIT],
	);
	const row = r.rows[0];
	return {
		parentFound: (row?.parent_found ?? 0) > 0,
		parentProjectId: row?.parent_project_id ?? null,
		parentIdentifier: row?.parent_identifier ?? null,
		parentStatus: row?.parent_status ?? null,
		parentDepth: row?.parent_depth ?? 0,
		movingHeight: row?.moving_height ?? 0,
		parentInMovingSubtree: (row?.parent_in_subtree ?? 0) > 0,
	};
}

/**
 * Create-path depth gate: may a brand new task be filed under `parentTaskId`?
 *
 * A thin caller of the shared rule below, so the depth arithmetic lives once. A
 * new task has no sub-tree, hence `movingTaskId: null` and `movingHeight` 0,
 * which reduces the predicate to `parentDepth <= 1` - exactly what this checked
 * before the rule was extracted.
 */
export async function assertChildDepthAllowed(
	db: Db,
	teamId: string,
	parentTaskId: string,
): Promise<Check> {
	const placement = await measureParentPlacement(db, teamId, parentTaskId, null);
	if (!placement.parentFound) {
		return { ok: false, message: 'Parent task not found' };
	}
	if (!depthFits(placement)) {
		return { ok: false, message: SUB_TASK_DEPTH_ERROR };
	}
	return { ok: true };
}

/**
 * The depth cap, stated once: the new parent's own depth, plus the edge being
 * created, plus however tall the moving sub-tree is, must fit under the cap.
 *
 * The create path always passes height 0, which is why it could historically get
 * away with only asking how deep the parent was. A *move* can carry children
 * along, so both halves matter.
 */
function depthFits(placement: ParentPlacement): boolean {
	return placement.parentDepth + 1 + placement.movingHeight <= MAX_SUB_TASK_DEPTH;
}

export type ParentCheckCode = 'NOT_FOUND' | 'INVALID_REQUEST';

export type ParentResolution =
	| { ok: true; parentTaskId: string | null; changed: boolean }
	| { ok: false; code: ParentCheckCode; message: string };

/** The task being moved, as both update surfaces already have it loaded. */
export interface ReparentSubject {
	taskId: string;
	projectId: string;
	currentParentTaskId: string | null;
	status: string;
}

/**
 * Validate a requested parent change and resolve it to a task id.
 *
 * The REST PATCH handler and the MCP `update_task` tool are two hand-written
 * implementations of the same update rules, so every hierarchy check lives here
 * and both call it. Returning the resolved id (rather than a bare `Check`) is
 * what lets the MCP side avoid writing an unresolved identifier to a uuid column.
 *
 * `rawParent` is null (or empty) to promote the task to top level. Callers pass
 * it only when the field was actually present in the request; `undefined` means
 * "leave the parent alone" and never reaches here.
 *
 * Checks run cheapest-first so a promotion costs zero queries and a no-op costs
 * one. Identity problems are reported before structural ones, because a parent
 * you cannot address makes "cycle" and "depth" meaningless; the cycle check
 * precedes the depth check because depth is nonsense inside a cycle; and the
 * status policy goes last so a reader meets structure first, then policy.
 */
export async function resolveParentAssignment(
	db: Db,
	teamId: string,
	subject: ReparentSubject,
	rawParent: string | null,
): Promise<ParentResolution> {
	const trimmed = rawParent?.trim() ?? '';
	if (trimmed === '') {
		// Promotion needs no lookup at all: the new depth is 0 so the cap cannot be
		// breached, there is no parent to cycle through, and no parent status to
		// weigh. The sub-tree comes along and is already known to fit.
		return { ok: true, parentTaskId: null, changed: subject.currentParentTaskId !== null };
	}

	const parentTaskId = await resolveTaskId(db, teamId, trimmed);
	if (!parentTaskId) {
		return { ok: false, code: 'NOT_FOUND', message: `Parent task not found: ${trimmed}` };
	}
	if (parentTaskId === subject.taskId) {
		// Subsumed by the sub-tree check below, but caught here for a clearer
		// message and one fewer query.
		return { ok: false, code: 'INVALID_REQUEST', message: 'A task cannot be its own parent' };
	}
	if (parentTaskId === subject.currentParentTaskId) {
		return { ok: true, parentTaskId, changed: false };
	}

	const placement = await measureParentPlacement(db, teamId, parentTaskId, subject.taskId);
	if (!placement.parentFound) {
		// Also the cross-team case: `resolveTaskId` waves UUIDs through, and the
		// team filter inside the walk is what turns a foreign id into not-found.
		return { ok: false, code: 'NOT_FOUND', message: `Parent task not found: ${trimmed}` };
	}
	if (placement.parentProjectId !== subject.projectId) {
		return {
			ok: false,
			code: 'INVALID_REQUEST',
			message: 'Parent task must be in the same project',
		};
	}
	if (placement.parentInMovingSubtree) {
		return {
			ok: false,
			code: 'INVALID_REQUEST',
			message: `Cannot nest a task under ${placement.parentIdentifier}, which is one of its own sub-tasks`,
		};
	}
	if (!depthFits(placement)) {
		return { ok: false, code: 'INVALID_REQUEST', message: SUB_TASK_DEPTH_ERROR };
	}
	// A done or cancelled parent is guaranteed by `assertChildrenAllClosed` to
	// have no open children. Letting a move break that produces a state the write
	// path cannot otherwise reach: a later close would wake the parent's assignee
	// on a finished task, Coach has already reviewed the parent and would never
	// see the new work, and the work goes missing from every open-sub-tasks view.
	// Scoped to the mover's own status because that is exactly what the close gate
	// enforces - direct children only, not the whole sub-tree.
	//
	// Deliberately not applied on the create path: filing a follow-up sub-task
	// under a closed parent works today and agents rely on it. Moving possibly
	// in-flight work (which may carry an active run and a branch) somewhere it
	// stops being visible is the different risk this guards.
	const terminal = TERMINAL_TASK_STATUSES as readonly string[];
	if (
		placement.parentStatus !== null &&
		terminal.includes(placement.parentStatus) &&
		!terminal.includes(subject.status)
	) {
		return {
			ok: false,
			code: 'INVALID_REQUEST',
			message: `Cannot nest an open task under ${placement.parentIdentifier}, which is already ${placement.parentStatus}. Re-open it first, or pick a different parent.`,
		};
	}

	return { ok: true, parentTaskId, changed: true };
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
	db: Db,
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
		message: `Cannot mark this task done — sub-task${plural} still open: ${blockers}. Sub-tasks must reach 'done' or 'cancelled' first.`,
	};
}

const ACTIVE_RUN_STATUSES = [HeartbeatRunStatus.Queued, HeartbeatRunStatus.Running];
// ACTIVE_WAKEUP_STATUSES now lives in @hezo/shared beside the enum, paired with
// TERMINAL_WAKEUP_STATUSES that the maintenance sweep deletes on. The two must
// agree about `deferred`, so they cannot be two separate lists.
const PING_WAKEUP_SOURCES = ['mention', 'comment', 'reply'];

export async function assertNoOutstandingActivity(
	db: Db,
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
			message: `Cannot mark this task done — @${who} still has a ${runs.rows[0].status} run on it. Wait for the run to finish (or cancel it) first.`,
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
			message: `Cannot mark this task done — @${who} has a pending ${wakeups.rows[0].source} wakeup on it. Wait for the run to finish first.`,
		};
	}

	return { ok: true };
}

// An active `@admin` mention is a question parked on a human; the ticket is not
// done while it has no answer. "Answered" is computed from the comment
// timeline: a human text comment on the same task posted after the mention
// comment (humans post with author_member_id NULL; the content-type filter
// keeps NULL-author system/run comments from counting as replies). read_at is
// deliberately ignored — reading is not answering. Enforced for agent callers
// only: a human closing a ticket is itself the human's decision.
export async function assertNoUnansweredAdminMentions(db: Db, taskId: string): Promise<Check> {
	const r = await db.query<{ public_id: string }>(
		`SELECT tc.public_id
		 FROM admin_mentions am
		 JOIN task_comments tc ON tc.id = am.comment_id
		 WHERE am.task_id = $1
		   AND NOT EXISTS (
		     SELECT 1 FROM task_comments reply
		     WHERE reply.task_id = am.task_id
		       AND reply.content_type = $2::comment_content_type
		       AND reply.author_member_id IS NULL
		       AND reply.created_at > tc.created_at
		   )
		 ORDER BY tc.created_at ASC
		 LIMIT 1`,
		[taskId, CommentContentType.Text],
	);
	if (r.rows.length === 0) return { ok: true };
	return {
		ok: false,
		message: `Cannot mark this task done — an @admin question on it (comment ${r.rows[0].public_id}) has not been answered by a human yet. Keep the task in_progress or move it to review and end your turn; the admin's reply on this task wakes you automatically. Ask before closing — never mark a task done while an @admin ask is still open.`,
	};
}
