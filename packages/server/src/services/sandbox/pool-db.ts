/**
 * The `container_pool_members` table, read and written.
 *
 * Separate from `pool.ts` so the allocation ladder there stays pure and directly
 * enumerable in tests; this file is the only place that knows the table's column
 * names.
 */

import type { Db } from '../../db/database';
import {
	POOL_DISK_CEILING_BYTES,
	type PoolCapacity,
	type PoolDecision,
	type PoolMember,
	type PoolMemberState,
	selectPoolMember,
} from './pool';

/**
 * Record whether a container is holding committed work that reached no durable
 * remote, which pins it against both suspend and destroy (`planIdleShutdown`
 * excludes it) until a later run gets the commits out.
 *
 * Pass `null` for "the check could not run" - the flag is then left exactly as it
 * was. That distinction is load-bearing in the clearing direction: treating an
 * unanswerable check as an all-clear would release a container that an earlier run
 * pinned for real, which is the failure the pin exists to prevent.
 *
 * `IS DISTINCT FROM` guards the write. Under MVCC a no-op UPDATE still leaves a
 * dead tuple, and this runs at the end of every run.
 */
export async function setPoolMemberUnpushedFlag(
	db: Db,
	containerId: string,
	hasUnpushedCommits: boolean | null,
): Promise<void> {
	if (hasUnpushedCommits === null) return;
	await db.query(
		`UPDATE container_pool_members
		    SET has_unpushed_commits = $2, updated_at = now()
		  WHERE container_id = $1
		    AND has_unpushed_commits IS DISTINCT FROM $2`,
		[containerId, hasUnpushedCommits],
	);
}

/**
 * Load a project's pool members in the shape the pure ladder reads.
 *
 * `atDiskCeiling` is derived here rather than stored: the ceiling is a policy
 * number that can change between releases, while `disk_used_bytes` is a
 * measurement. Storing the derived flag would freeze old rows at an old policy.
 */
export async function loadPoolMembers(db: Db, projectId: string): Promise<PoolMember[]> {
	const res = await db.query<{
		container_id: string;
		state: PoolMemberState | 'creating' | 'error';
		last_task_id: string | null;
		disk_used_bytes: string | number;
		has_unpushed_commits: boolean;
		reserved_for_chat: boolean;
	}>(
		`SELECT container_id, state::text AS state, last_task_id, disk_used_bytes,
		        has_unpushed_commits, reserved_for_chat
		   FROM container_pool_members
		  WHERE project_id = $1
		  ORDER BY created_at ASC`,
		[projectId],
	);
	const members: PoolMember[] = [];
	for (const row of res.rows) {
		// `creating` and `error` have no place in the ladder: one is not yet a
		// container and the other is not one any more. Both are excluded rather
		// than mapped, so a half-built member can never be handed to a run.
		if (row.state !== 'idle' && row.state !== 'busy' && row.state !== 'suspended') continue;
		members.push({
			id: row.container_id,
			state: row.state,
			lastTaskId: row.last_task_id,
			hasUnpushedCommits: row.has_unpushed_commits,
			atDiskCeiling: Number(row.disk_used_bytes) >= POOL_DISK_CEILING_BYTES,
			reservedForChat: row.reserved_for_chat,
		});
	}
	return members;
}

/**
 * Record a container as a member of a project's pool.
 *
 * Idempotent on `container_id`, which is the engine's own id and therefore
 * unique across every backend. Provisioning calls this after the container is
 * up, so a member never exists in a state no run could use - `creating` is for a
 * member the engine is still building, and the ladder skips it.
 */
export async function upsertPoolMember(
	db: Db,
	projectId: string,
	containerId: string,
	state: PoolMemberState,
): Promise<void> {
	await db.query(
		`INSERT INTO container_pool_members (project_id, container_id, state)
		 VALUES ($1, $2, $3::container_pool_state)
		 ON CONFLICT (container_id) DO UPDATE
		    SET state = EXCLUDED.state, project_id = EXCLUDED.project_id, updated_at = now()
		  WHERE container_pool_members.state IS DISTINCT FROM EXCLUDED.state
		     OR container_pool_members.project_id IS DISTINCT FROM EXCLUDED.project_id`,
		[projectId, containerId, state],
	);
}

/**
 * Move a member between states.
 *
 * `busy` is claimed rather than set: the `WHERE state <> 'busy'` makes the
 * transition the point at which two concurrent acquires are resolved, so the
 * loser sees zero rows and picks again instead of both runs believing they own
 * the container. That is the one-run-per-container rule actually being enforced,
 * rather than merely decided by the ladder a moment earlier.
 *
 * Returns whether the row moved.
 */
export async function claimPoolMember(
	db: Db,
	containerId: string,
	lastTaskId: string | null,
): Promise<boolean> {
	// RETURNING rather than a row count: the driver's QueryResult carries only
	// rows, and "did this row move" is exactly what decides the race.
	const res = await db.query<{ container_id: string }>(
		`UPDATE container_pool_members
		    SET state = 'busy', last_task_id = COALESCE($2, last_task_id), updated_at = now()
		  WHERE container_id = $1 AND state <> 'busy'
		  RETURNING container_id`,
		[containerId, lastTaskId],
	);
	return res.rows.length > 0;
}

/**
 * Hand a container back after a run.
 *
 * The task is recorded even when the run failed: affinity is about which
 * worktree and `node_modules` are already built, which a failed run leaves just
 * as warm as a successful one.
 */
export async function releasePoolMember(
	db: Db,
	containerId: string,
	lastTaskId: string | null,
): Promise<void> {
	await db.query(
		`UPDATE container_pool_members
		    SET state = 'idle', last_task_id = COALESCE($2, last_task_id),
		        last_released_at = now(), updated_at = now()
		  WHERE container_id = $1 AND state <> 'suspended'`,
		[containerId, lastTaskId],
	);
}

/** Record a member's engine state after a lifecycle call the pool did not initiate. */
export async function setPoolMemberState(
	db: Db,
	containerId: string,
	state: PoolMemberState | 'error',
): Promise<void> {
	await db.query(
		`UPDATE container_pool_members
		    SET state = $2::container_pool_state, updated_at = now()
		  WHERE container_id = $1 AND state IS DISTINCT FROM $2::container_pool_state`,
		[containerId, state],
	);
}

/** Drop a member once its container is gone. Best-effort: a missing row is fine. */
export async function removePoolMember(db: Db, containerId: string): Promise<void> {
	await db.query(`DELETE FROM container_pool_members WHERE container_id = $1`, [containerId]);
}

/** Every member of a project's pool, whatever its state - for teardown and reconciliation. */
export async function listPoolContainerIds(db: Db, projectId: string): Promise<string[]> {
	const res = await db.query<{ container_id: string }>(
		`SELECT container_id FROM container_pool_members WHERE project_id = $1`,
		[projectId],
	);
	return res.rows.map((r) => r.container_id);
}

/** Record a member's measured disk use, which decides whether it is recycled rather than reused. */
export async function setPoolMemberDiskUsage(
	db: Db,
	containerId: string,
	bytes: number,
): Promise<void> {
	await db.query(
		`UPDATE container_pool_members
		    SET disk_used_bytes = $2, updated_at = now()
		  WHERE container_id = $1 AND disk_used_bytes IS DISTINCT FROM $2`,
		[containerId, bytes],
	);
}

/**
 * Which container a run in this project should get, decided against live state.
 *
 * The thin DB shell around {@link selectPoolMember}: it loads the members and the
 * capacity and hands both to the pure ladder, which is where every rule actually
 * lives. Keeping the decision in one place is what stops the acquire path and the
 * capacity gate from drifting into two different answers to the same question.
 */
export async function decidePoolAcquisition(
	db: Db,
	projectId: string,
	taskId: string | null,
	capacity: PoolCapacity,
): Promise<PoolDecision> {
	return selectPoolMember(taskId, await loadPoolMembers(db, projectId), capacity);
}

/**
 * Mark (or release) the chat's pinned container, which `selectPoolMember` will
 * never hand to a task run and `planIdleShutdown` will never stop.
 *
 * Chat is exempt from the container cap because a queued task run is invisible and
 * harmless while a queued chat turn is a person watching a spinner; the memory
 * budget reserves for it up front instead. Reserving the member is the other half
 * of that: without it a task run could take the container out from under a live
 * chat session, which is the same interruption by a different route.
 */
export async function setPoolMemberChatReservation(
	db: Db,
	containerId: string,
	reserved: boolean,
): Promise<void> {
	await db.query(
		`UPDATE container_pool_members
		    SET reserved_for_chat = $2, updated_at = now()
		  WHERE container_id = $1
		    AND reserved_for_chat IS DISTINCT FROM $2`,
		[containerId, reserved],
	);
}

/**
 * SQL predicate: does this project hold committed work that reached no durable
 * remote?
 *
 * Exported as a fragment because it is asked in two shapes - on its own, and as
 * a column of the project list - and two hand-written spellings of one predicate
 * is how they end up disagreeing about whether a project is at risk.
 *
 * `projectAlias` is the alias of `projects` in the surrounding query.
 */
export function strandedCommitsExistsSql(projectAlias: string): string {
	return `EXISTS (
		SELECT 1 FROM container_pool_members scm
		 WHERE scm.project_id = ${projectAlias}.id AND scm.has_unpushed_commits
	)`;
}

/**
 * Whether any container in this project is pinned by unpushed work. Surfaced so a
 * project whose commits are stranded reads as such rather than looking healthy
 * while a container quietly carries the only copy.
 */
export async function projectHasStrandedCommits(db: Db, projectId: string): Promise<boolean> {
	const res = await db.query<{ pinned: boolean }>(
		`SELECT ${strandedCommitsExistsSql('p')} AS pinned FROM projects p WHERE p.id = $1`,
		[projectId],
	);
	return res.rows[0]?.pinned ?? false;
}
