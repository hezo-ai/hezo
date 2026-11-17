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

import { ACTIVE_HEARTBEAT_RUN_STATUSES, TERMINAL_TASK_STATUSES } from '@hezo/shared';
import type { Db } from '../../db/database';
import { type RepoLoc, removeWorktreesWhere } from '../git';
import type { GitExecutor } from '../git-executor';
import { CONTAINER_WORKTREES_ROOT } from '../workspace';
import type { SandboxFiles } from './files';

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
 * It asks for the **open** identifiers, not for every task. Both answer the same
 * question - an identifier is reclaimable unless a task is still live on it -
 * but the sets grow differently: open tasks are bounded by what a team can have
 * in flight, while all tasks grows forever. Loading the latter on the run-prep
 * path meant every run on a mature project paid for its whole task history.
 *
 * Absence therefore covers two cases at once, both reclaimable: a task that has
 * finished, and an identifier with no task row at all - a leftover from a
 * crashed run or a deleted task, which nothing will ever come back for.
 *
 * A finished task with a run still in flight is kept too: runs on closed tasks
 * are routine (a Coach review, a reply), and on a backend that shares `/worktrees`
 * across a project's containers another container's sweep would otherwise delete
 * the folder that run is working in. Active runs are few, so the second arm is a
 * short read on the run-status index.
 */
export async function resolveReclaimableTasks(
	db: Db,
	projectId: string,
): Promise<(taskIdentifier: string) => boolean> {
	const rows = await db.query<{ identifier: string }>(
		`SELECT identifier FROM tasks
		  WHERE project_id = $1 AND status <> ALL($2::task_status[])
		 UNION
		 SELECT t.identifier FROM heartbeat_runs r
		   JOIN tasks t ON t.id = r.task_id
		  WHERE t.project_id = $1 AND r.status = ANY($3::heartbeat_run_status[])`,
		[projectId, TERMINAL_TASK_STATUSES, ACTIVE_HEARTBEAT_RUN_STATUSES],
	);
	const stillOpen = new Set(rows.rows.map((t) => t.identifier));
	return (taskIdentifier: string) => !stillOpen.has(taskIdentifier);
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
	 * worktree `prepare_repos` just created, while the agent is about to work in it.
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

/**
 * Remove the whole task folder (`/worktrees/<identifier>`) of every finished task
 * in this container: its worktrees, and whatever else a run left there - scratch
 * files, a dependency install, a clone the agent made itself. A run's working
 * directory is its task folder, so these accumulate for every task the container
 * ever served, and on a managed sandbox nothing else removes them: the task-close
 * teardown is a host delete that only reaches a bind mount.
 *
 * Through the file seam, so it works on every backend. Bounded per pass like the
 * worktree sweep. Outside the git lock: a finished task with no run in flight has
 * no git work in progress, and any admin entry its worktree leaves behind in a
 * clone is pruned by the next worktree sweep.
 */
export async function removeFinishedTaskFolders(
	db: Db,
	worktrees: SandboxFiles,
	projectId: string,
	currentTaskIdentifier: string | null,
	limit: number = MAX_WORKTREE_REMOVALS_PER_PASS,
): Promise<WorktreeGcResult> {
	const names = (await worktrees.list('.')).filter(
		(name) => name !== currentTaskIdentifier && !name.startsWith('.'),
	);
	if (names.length === 0) return { removed: [], deferred: false };
	const reclaimable = await resolveReclaimableTasks(db, projectId);
	const removed: string[] = [];
	for (const name of names) {
		if (!reclaimable(name)) continue;
		if (removed.length >= limit) return { removed, deferred: true };
		await worktrees.removeDir(name);
		removed.push(name);
	}
	return { removed, deferred: false };
}
