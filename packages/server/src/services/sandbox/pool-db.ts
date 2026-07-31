/**
 * The `container_pool_members` table, read and written.
 *
 * Separate from `pool.ts` so the allocation ladder there stays pure and directly
 * enumerable in tests; this file is the only place that knows the table's column
 * names.
 */

import type { Db } from '../../db/database';

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
