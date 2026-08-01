/**
 * Reclaiming the worktrees of finished tasks.
 *
 * Worktrees are deliberately not deleted at the end of a run - the wakeup model
 * gives a task many runs, and reusing its worktree is the common case rather than
 * an optimization. The cost is that a container which serves twenty tasks
 * accumulates twenty worktrees and their `node_modules`.
 *
 * On the operator's own Docker daemon `/worktrees` is a bind mount with the whole
 * host disk behind it, so that only ever cost disk. A managed sandbox has a few GB
 * total, which makes this **mandatory rather than housekeeping**: package caches
 * cannot be moved onto the shared store (it is an object store - no rename, no
 * chmod), so pruning finished tasks is the only lever on that budget.
 *
 * The policy is one line and lives here rather than at each call site: a worktree
 * may be reclaimed when its task is terminal or no longer exists. Committed work
 * survives on the `hezo/<identifier>` branch ref either way, and an in-flight task
 * is never touched.
 */

import { TERMINAL_TASK_STATUSES } from '@hezo/shared';
import type { Db } from '../../db/database';
import { type RepoLoc, removeWorktreesWhere } from '../git';
import type { GitExecutor } from '../git-executor';
import { CONTAINER_WORKTREES_ROOT } from '../workspace';

/**
 * Removals per repo per automatic pass. Bounded so a container carrying a long
 * backlog of finished tasks pays a predictable cost on each run rather than
 * stalling one run to clear all of them; what is left is picked up next time.
 * The admin action is unbounded - a human asked for it and is waiting on it.
 */
export const MAX_WORKTREE_REMOVALS_PER_PASS = 10;

export interface WorktreeGcResult {
	/** Task identifiers whose worktree was removed, across every repo swept. */
	removed: string[];
	/** True when a per-repo cap stopped the pass early, so more remain for next time. */
	deferred: boolean;
}

/**
 * Whether a task identifier's worktree may be reclaimed, for every task in a
 * project. Resolved in one query rather than per worktree: the sweep runs on the
 * run-prep path, so it must not cost a round trip per directory.
 *
 * An identifier with no task row is reclaimable - it is a leftover from a
 * crashed run or a deleted task, and nothing will ever come back for it.
 */
export async function resolveReclaimableTasks(
	db: Db,
	projectId: string,
): Promise<(taskIdentifier: string) => boolean> {
	const rows = await db.query<{ identifier: string; status: string }>(
		'SELECT identifier, status FROM tasks WHERE project_id = $1',
		[projectId],
	);
	const statusByIdentifier = new Map(rows.rows.map((t) => [t.identifier, t.status]));
	const terminal: readonly string[] = TERMINAL_TASK_STATUSES;
	return (taskIdentifier: string) => {
		const status = statusByIdentifier.get(taskIdentifier);
		return status === undefined || terminal.includes(status);
	};
}

/**
 * Sweep every prepared clone's worktrees, removing those whose task is finished.
 *
 * Best-effort by construction: a git failure inside `removeWorktreesWhere` leaves
 * the worktree in place and the next pass retries it. The caller decides whether a
 * throw here should surface - on the run-prep path it must not, since failing a run
 * over reclaimed disk would be worse than the disk.
 */
export async function collectFinishedWorktrees(
	db: Db,
	executor: GitExecutor,
	projectId: string,
	clones: RepoLoc[],
	limit: number | undefined = MAX_WORKTREE_REMOVALS_PER_PASS,
	worktreesRoot: string = CONTAINER_WORKTREES_ROOT,
	/**
	 * The task the calling run is *for*, never reclaimed however terminal it is.
	 *
	 * Runs on closed tasks are routine, not exotic: the explicit-`task_id` wakeup
	 * path (mentions, comments, coach triggers) carries no status filter, and the
	 * Coach exists to review completed work. Without this the pass deletes the
	 * worktree run prep just created and set as the run's working directory, and
	 * the agent execs into a directory that is no longer there.
	 */
	currentTaskIdentifier: string | null = null,
): Promise<WorktreeGcResult> {
	if (clones.length === 0) return { removed: [], deferred: false };
	const reclaimable = await resolveReclaimableTasks(db, projectId);
	const isReclaimable = (taskIdentifier: string): boolean =>
		taskIdentifier !== currentTaskIdentifier && reclaimable(taskIdentifier);

	const removed: string[] = [];
	let deferred = false;
	for (const repo of clones) {
		const swept = await removeWorktreesWhere(executor, repo, worktreesRoot, isReclaimable, limit);
		removed.push(...swept);
		// The cap is per repo, so a repo that filled it may well have more.
		if (limit !== undefined && swept.length >= limit) deferred = true;
	}
	return { removed: Array.from(new Set(removed)), deferred };
}
