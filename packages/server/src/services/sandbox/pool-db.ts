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
 * Whether any container in this project is pinned by unpushed work. Surfaced so a
 * project whose commits are stranded reads as such rather than looking healthy
 * while a container quietly carries the only copy.
 */
export async function projectHasStrandedCommits(db: Db, projectId: string): Promise<boolean> {
	const res = await db.query<{ pinned: boolean }>(
		`SELECT EXISTS (
		   SELECT 1 FROM container_pool_members
		    WHERE project_id = $1 AND has_unpushed_commits
		 ) AS pinned`,
		[projectId],
	);
	return res.rows[0]?.pinned ?? false;
}
