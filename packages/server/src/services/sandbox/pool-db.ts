/**
 * The `container_pool_members` table, read and written.
 *
 * Separate from `pool.ts` so the allocation ladder there stays pure and directly
 * enumerable in tests; this file is the only place that knows the table's column
 * names.
 */

import { DEFAULT_CONTAINER_DISK_GB, poolDiskCeilingBytes } from '@hezo/shared';
import type { Db } from '../../db/database';
import {
	type PoolCapacity,
	type PoolDecision,
	type PoolMember,
	type PoolMemberState,
	selectPoolMember,
} from './pool';

/**
 * Ceiling written for a member inserted without a stated disk size.
 *
 * A literal in SQL rather than a bind, because it is a column default in all but
 * name: the only rows that reach it are ones written by a path that does not know
 * the container's allocation, and they should read as "the default allocation"
 * rather than as zero (which would recycle instantly) or as unbounded.
 */
const DEFAULT_DISK_CEILING_SQL = String(poolDiskCeilingBytes(DEFAULT_CONTAINER_DISK_GB));

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
		disk_ceiling_bytes: string | number;
		has_unpushed_commits: boolean;
		reserved_for_chat: boolean;
	}>(
		`SELECT container_id, state::text AS state, last_task_id, disk_used_bytes,
		        disk_ceiling_bytes, has_unpushed_commits, reserved_for_chat
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
			// Against the ceiling recorded for *this* container, not a global one:
			// members can carry different allocations (a project override, or a
			// default that changed after some were provisioned).
			atDiskCeiling: Number(row.disk_used_bytes) >= Number(row.disk_ceiling_bytes),
			reservedForChat: row.reserved_for_chat,
		});
	}
	return members;
}

/**
 * Record a container as a member of a project's pool.
 *
 * Idempotent on `container_id`, which is the engine's own id and therefore
 * unique across every backend.
 *
 * Provisioning calls this **twice**: once as `creating` the moment the engine
 * returns an id, and again as `idle` once the container is set up. The early
 * write is what puts a container on the global Containers page while it is still
 * coming up - the pool member and `projects.container_id` are the only two things
 * the listing reads, and before this neither existed until provisioning had
 * finished, so the page that answers "what is running right now" could not see a
 * container that was starting, and its log had no row to be reached from.
 *
 * A `creating` member is never reachable by a run: `loadPoolMembers` above drops
 * every state outside the ladder, so the container becomes allocatable only on
 * the second call.
 */
export async function upsertPoolMember(
	db: Db,
	projectId: string,
	containerId: string,
	state: PoolMemberState | 'creating',
	/**
	 * Disk this container was actually provisioned with, in GB. Recorded on the
	 * member rather than read from the setting at judgement time, so raising the
	 * default afterwards cannot tell an existing container it may fill past what
	 * it really has. Omitted on an upsert that is only moving state, which leaves
	 * the recorded ceiling alone.
	 */
	diskGb?: number,
): Promise<void> {
	const ceiling = diskGb === undefined ? null : poolDiskCeilingBytes(diskGb);
	await db.query(
		`INSERT INTO container_pool_members (project_id, container_id, state, disk_ceiling_bytes)
		 VALUES ($1, $2, $3::container_pool_state, COALESCE($4, ${DEFAULT_DISK_CEILING_SQL}))
		 ON CONFLICT (container_id) DO UPDATE
		    SET state = EXCLUDED.state, project_id = EXCLUDED.project_id,
		        disk_ceiling_bytes = COALESCE($4, container_pool_members.disk_ceiling_bytes),
		        updated_at = now()
		  WHERE container_pool_members.state IS DISTINCT FROM EXCLUDED.state
		     OR container_pool_members.project_id IS DISTINCT FROM EXCLUDED.project_id
		     OR container_pool_members.disk_ceiling_bytes IS DISTINCT FROM COALESCE($4, container_pool_members.disk_ceiling_bytes)`,
		[projectId, containerId, state, ceiling],
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

/**
 * Return every claimed member to the pool at boot.
 *
 * `busy` means "a run holds this container", and boot has just failed every
 * in-flight run and will never reattach to one - so any claim still standing
 * belongs to the previous process and describes a run that no longer exists.
 *
 * Something has to clear it, because nothing else does: the ladder skips a busy
 * member, `planIdleShutdown` only ever touches idle ones, and its memory counts
 * against the instance budget for as long as the row says busy. A claim leaked
 * across a crash would therefore cost a container permanently.
 *
 * `suspended` is left alone for the same reason `releasePoolMember` leaves it
 * alone: an operator (or the idle pass) stopped that container deliberately, and
 * flipping it to idle would advertise a container that is not running.
 */
export async function reclaimBusyPoolMembers(db: Db): Promise<string[]> {
	const res = await db.query<{ container_id: string }>(
		`UPDATE container_pool_members
		    SET state = 'idle', last_released_at = now(), updated_at = now()
		  WHERE state = 'busy'
		 RETURNING container_id`,
	);
	return res.rows.map((r) => r.container_id);
}

/**
 * Every container id Hezo still references, instance-wide, across **both**
 * representations of a container.
 *
 * This is the orphan sweep's live set, and the union is the whole point: a
 * project owns several containers at once while `projects.container_id` names
 * only the most recently provisioned or resumed one, so a set built from
 * projects alone reads a busy run's container, a suspended member and a member
 * pinned for unpushed commits as unreferenced. Every pool state counts,
 * `suspended` most of all - that is the state a container the pool means to
 * resume sits in.
 *
 * Exported rather than inlined at the cron because the cron is where this was
 * wrong, and a query nothing can call is a query nothing can test.
 */
export async function listReferencedContainerIds(db: Db): Promise<Set<string>> {
	const res = await db.query<{ container_id: string }>(
		`SELECT container_id FROM projects WHERE container_id IS NOT NULL
		 UNION
		 SELECT container_id FROM container_pool_members`,
	);
	return new Set(res.rows.map((r) => r.container_id));
}

/**
 * One container, as an operator sees it on the global Containers page.
 *
 * Flat and pre-joined rather than a member row the caller enriches: the page's
 * whole job is to answer "what is this container, whose is it, and is anything
 * using it", and three of those four facts live in a different table from the
 * member.
 */
export interface ContainerListing {
	container_id: string;
	project_id: string;
	project_slug: string;
	project_name: string;
	/** Pool vocabulary, including the two states the ladder itself skips. */
	state: 'creating' | 'idle' | 'busy' | 'suspended' | 'error';
	reserved_for_chat: boolean;
	has_unpushed_commits: boolean;
	disk_used_bytes: number;
	disk_ceiling_bytes: number;
	/** Effective per-container cap: the project's override, else the instance default. */
	memory_limit_gib: number;
	last_task_id: string | null;
	last_task_identifier: string | null;
	/** The run currently executing on it, when one is. */
	run_id: string | null;
	last_error: string | null;
	/** The container's own last captured output, for a container that is not streaming. */
	last_logs: string | null;
	last_started_at: string | null;
	last_released_at: string | null;
	created_at: string | null;
}

/**
 * Every container this instance owns, one row each.
 *
 * **Unions both representations**, the same way `getActiveContainers`
 * (`services/run-concurrency.ts`) does and for the same reason: `container_pool_members`
 * is additive and `projects.container_*` is still written, so during provisioning a
 * container can be recorded in either place or both. A list built from the pool alone
 * would silently omit containers that exist - which on a page whose entire purpose is
 * "what is running right now" is the one failure that matters.
 *
 * A container with no member row has no pool state, so its state is derived from
 * `projects.container_status`. The mapping is stated rather than assumed: `running`
 * reads as `idle` because a legacy row cannot tell us whether a run holds it, and
 * calling it busy would misreport a container an operator may safely remove.
 *
 * `defaultMemoryGb` is passed in rather than read here so this file stays the one that
 * knows the table and nothing else - the instance default is a settings concern.
 */
export async function listAllContainers(
	db: Db,
	defaultMemoryGb: number,
): Promise<ContainerListing[]> {
	const res = await db.query<ContainerListingRow>(
		`${CONTAINER_LISTING_SQL} ORDER BY p.name ASC, m.created_at ASC NULLS LAST, c.container_id ASC`,
		[defaultMemoryGb],
	);
	return res.rows.map(toContainerListing);
}

/** One container by its engine id, or null when nothing references it. */
export async function getContainerListing(
	db: Db,
	defaultMemoryGb: number,
	containerId: string,
): Promise<ContainerListing | null> {
	const res = await db.query<ContainerListingRow>(
		`${CONTAINER_LISTING_SQL} AND c.container_id = $2`,
		[defaultMemoryGb, containerId],
	);
	return res.rows[0] ? toContainerListing(res.rows[0]) : null;
}

interface ContainerListingRow {
	container_id: string;
	project_id: string;
	project_slug: string;
	project_name: string;
	state: ContainerListing['state'];
	reserved_for_chat: boolean;
	has_unpushed_commits: boolean;
	disk_used_bytes: string | number;
	disk_ceiling_bytes: string | number;
	memory_limit_gib: string | number;
	last_task_id: string | null;
	last_task_identifier: string | null;
	run_id: string | null;
	last_error: string | null;
	last_logs: string | null;
	last_started_at: string | null;
	last_released_at: string | null;
	created_at: string | null;
}

/**
 * Shared body of the two listing reads, so "one row per container" is defined
 * once. `$1` is the instance default memory cap; the caller appends its own
 * ordering or its `container_id` predicate.
 */
const CONTAINER_LISTING_SQL = `
	SELECT c.container_id,
	       p.id   AS project_id,
	       p.slug AS project_slug,
	       p.name AS project_name,
	       COALESCE(
	         m.state::text,
	         CASE p.container_status::text
	           WHEN 'creating' THEN 'creating'
	           WHEN 'error'    THEN 'error'
	           WHEN 'running'  THEN 'idle'
	           ELSE 'suspended'
	         END
	       ) AS state,
	       COALESCE(m.reserved_for_chat, false)    AS reserved_for_chat,
	       COALESCE(m.has_unpushed_commits, false) AS has_unpushed_commits,
	       COALESCE(m.disk_used_bytes, 0)          AS disk_used_bytes,
	       COALESCE(m.disk_ceiling_bytes, ${DEFAULT_DISK_CEILING_SQL}) AS disk_ceiling_bytes,
	       COALESCE(p.memory_limit_gib, $1)        AS memory_limit_gib,
	       m.last_task_id,
	       t.identifier AS last_task_identifier,
	       r.id         AS run_id,
	       COALESCE(m.last_error, p.container_error) AS last_error,
	       COALESCE(m.last_logs, p.container_last_logs) AS last_logs,
	       m.last_started_at,
	       m.last_released_at,
	       m.created_at
	  FROM (
	         SELECT container_id, id AS project_id FROM projects WHERE container_id IS NOT NULL
	         UNION
	         SELECT container_id, project_id FROM container_pool_members
	       ) AS c
	  JOIN projects p ON p.id = c.project_id
	  LEFT JOIN container_pool_members m ON m.container_id = c.container_id
	  LEFT JOIN tasks t ON t.id = m.last_task_id
	  -- The run on it right now, if any. heartbeat_runs.container_id exists for
	  -- exactly this, and its index is partial on the running status.
	  LEFT JOIN LATERAL (
	         SELECT hr.id FROM heartbeat_runs hr
	          WHERE hr.container_id = c.container_id AND hr.status = 'running'
	          ORDER BY hr.started_at DESC LIMIT 1
	       ) AS r ON true
	 WHERE true`;

function toContainerListing(row: ContainerListingRow): ContainerListing {
	return {
		...row,
		disk_used_bytes: Number(row.disk_used_bytes),
		disk_ceiling_bytes: Number(row.disk_ceiling_bytes),
		memory_limit_gib: Number(row.memory_limit_gib),
	};
}

/**
 * Clear `projects.container_id` when, and only when, it names `containerId`.
 *
 * The project row still points at a single "the" container - the newest one
 * provisioned - while the pool holds several. Destroying a member the row
 * happens to name leaves it pointing at nothing, and the 1 Hz status sync reads
 * a container it cannot inspect as one that died: a spurious `error` on a
 * project whose other containers are fine.
 *
 * Conditional on the id so a concurrent provision that has already re-pointed
 * the row is never clobbered, and `IS DISTINCT FROM` keeps a no-op out of the
 * table - this runs per retired container.
 */
export async function clearProjectContainerIfNamed(
	db: Db,
	projectId: string,
	containerId: string,
): Promise<void> {
	await db.query(
		`UPDATE projects SET container_id = NULL, container_status = NULL
		  WHERE id = $1 AND container_id = $2`,
		[projectId, containerId],
	);
}

/** Every member of a project's pool, whatever its state - for teardown and reconciliation. */
export async function listPoolContainerIds(db: Db, projectId: string): Promise<string[]> {
	const res = await db.query<{ container_id: string }>(
		`SELECT container_id FROM container_pool_members WHERE project_id = $1`,
		[projectId],
	);
	return res.rows.map((r) => r.container_id);
}

/**
 * What became of a container: its last output, and the error that ended it.
 *
 * Both used to live on `projects` (`container_last_logs` / `container_error`),
 * one column each for what is now N containers - so whichever container stopped
 * last had its account attributed to every sibling. An operator opening one
 * container to find out why it died was reading another one's output. Migration
 * 051 moves the logs; the error follows here for the same reason.
 *
 * The two fields have deliberately different null semantics, matching the
 * `projects` write they replace:
 *
 * - `lastLogs === null` means "the capture came back empty", and leaves the
 *   previous snapshot alone - erasing it would delete the only account of the
 *   failure precisely when the container is least able to reproduce it.
 * - `lastError` is written as given, so `null` **clears** it. A container that
 *   stopped cleanly must not keep wearing a stale error.
 */
export async function setPoolMemberOutcome(
	db: Db,
	containerId: string,
	lastLogs: string | null,
	lastError: string | null,
): Promise<void> {
	await db.query(
		`UPDATE container_pool_members
		    SET last_logs = COALESCE($2, last_logs), last_error = $3, updated_at = now()
		  WHERE container_id = $1
		    AND (last_logs IS DISTINCT FROM COALESCE($2, last_logs)
		         OR last_error IS DISTINCT FROM $3)`,
		[containerId, lastLogs, lastError],
	);
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

/**
 * Pool members old enough to be worth checking against the engine, oldest first.
 *
 * `updated_at` rather than `created_at`: a member that just changed state is
 * mid-transition and reconciling it would race the thing that moved it. The age
 * floor is what keeps a container created moments ago from being judged missing
 * before the provider can answer for it.
 */
export async function listPoolMembersForReconcile(
	db: Db,
	minAgeSeconds: number,
	limit: number,
): Promise<Array<{ containerId: string; projectId: string; state: string }>> {
	const res = await db.query<{ container_id: string; project_id: string; state: string }>(
		`SELECT container_id, project_id, state::text AS state
		   FROM container_pool_members
		  WHERE updated_at < now() - ($1 * interval '1 second')
		  ORDER BY updated_at ASC
		  LIMIT $2`,
		[minAgeSeconds, limit],
	);
	return res.rows.map((r) => ({
		containerId: r.container_id,
		projectId: r.project_id,
		state: r.state,
	}));
}
