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
		memory_bytes: string | number | null;
		has_unpushed_commits: boolean;
		reserved_for_chat: boolean;
	}>(
		`SELECT container_id, state::text AS state, last_task_id, disk_used_bytes,
		        disk_ceiling_bytes, memory_bytes, has_unpushed_commits, reserved_for_chat
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
			// Null stays null rather than becoming zero: "never recorded" is a
			// distinct answer from any allocation, and the ladder recycles on it.
			memoryBytes: row.memory_bytes === null ? null : Number(row.memory_bytes),
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
	 * What this container was actually provisioned with. Recorded on the member
	 * rather than read from the settings at judgement time, so changing a setting
	 * afterwards cannot tell an existing container it has resources it was never
	 * given. Omitted on an upsert that is only moving state, which leaves both
	 * recorded figures alone.
	 */
	allocation: {
		/** Disk, in GB. */
		diskGb?: number;
		/** The memory cap this container was built to cover, in bytes. */
		memoryBytes?: number;
	} = {},
): Promise<void> {
	const ceiling = allocation.diskGb === undefined ? null : poolDiskCeilingBytes(allocation.diskGb);
	const memory = allocation.memoryBytes ?? null;
	await db.query(
		`INSERT INTO container_pool_members (project_id, container_id, state, disk_ceiling_bytes, memory_bytes)
		 VALUES ($1, $2, $3::container_pool_state, COALESCE($4, ${DEFAULT_DISK_CEILING_SQL}), $5)
		 ON CONFLICT (container_id) DO UPDATE
		    SET state = EXCLUDED.state, project_id = EXCLUDED.project_id,
		        disk_ceiling_bytes = COALESCE($4, container_pool_members.disk_ceiling_bytes),
		        memory_bytes = COALESCE($5, container_pool_members.memory_bytes),
		        updated_at = now()
		  WHERE container_pool_members.state IS DISTINCT FROM EXCLUDED.state
		     OR container_pool_members.project_id IS DISTINCT FROM EXCLUDED.project_id
		     OR container_pool_members.disk_ceiling_bytes IS DISTINCT FROM COALESCE($4, container_pool_members.disk_ceiling_bytes)
		     OR container_pool_members.memory_bytes IS DISTINCT FROM COALESCE($5, container_pool_members.memory_bytes)`,
		[projectId, containerId, state, ceiling, memory],
	);
}

/**
 * Move a member between states.
 *
 * `busy` is claimed rather than set: the `WHERE state = 'idle'` makes the
 * transition the point at which two concurrent acquires are resolved, so the
 * loser sees zero rows and picks again instead of both runs believing they own
 * the container. That is the one-run-per-container rule actually being enforced,
 * rather than merely decided by the ladder a moment earlier.
 *
 * `idle` and not merely "not busy", because `suspended` and `error` are equally
 * unclaimable and used to pass: a container the backend had just stopped was
 * handed straight to a run, which then died on its first call against a sandbox
 * that was not up. Every rung of the ladder already lands its member on `idle`
 * first - the resume rung starts it, the reuse rung re-decides anything not
 * running, and a freshly provisioned member is inserted `idle` - so this
 * narrows what can be claimed without narrowing what can be acquired.
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
		  WHERE container_id = $1 AND state = 'idle'
		  RETURNING container_id`,
		[containerId, lastTaskId],
	);
	return res.rows.length > 0;
}

/**
 * What a container was provisioned with, as its member row records it.
 *
 * Read from the row rather than recomputed from the settings: a container holds
 * the allocation it was built with until the pool replaces it, so the setting
 * describes the next container rather than this one.
 */
export interface ContainerAllocation {
	/** Null for a member whose allocation was never recorded. */
	memoryBytes: number | null;
	diskCeilingBytes: number;
}

/** The recorded allocation of a member the caller already holds, or null when the row is gone. */
export async function readPoolMemberAllocation(
	db: Db,
	containerId: string,
): Promise<ContainerAllocation | null> {
	const res = await db.query<{
		memory_bytes: string | number | null;
		disk_ceiling_bytes: string | number;
	}>(
		'SELECT memory_bytes, disk_ceiling_bytes FROM container_pool_members WHERE container_id = $1',
		[containerId],
	);
	const row = res.rows[0];
	if (!row) return null;
	return {
		memoryBytes: row.memory_bytes === null ? null : Number(row.memory_bytes),
		diskCeilingBytes: Number(row.disk_ceiling_bytes),
	};
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
	/**
	 * The memory cap this container was provisioned to cover, in bytes - what it
	 * actually has, not what the project's cap says today. The two diverge from the
	 * moment the cap is changed until the pool replaces the container, and reporting
	 * the setting there described a container that did not exist.
	 *
	 * Null for a container whose allocation was never recorded.
	 */
	memory_bytes: number | null;
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
 * **Deliberately not filtered by `projects.archived_at`.** Archiving tears the
 * project's containers down, so an archived project has nothing to list and drops
 * off this page because it genuinely holds no container. Filtering instead would
 * hide one that still exists on the engine and still counts against the instance
 * memory budget - the exact failure this page exists to make visible.
 */
export async function listAllContainers(db: Db): Promise<ContainerListing[]> {
	const res = await db.query<ContainerListingRow>(
		`${CONTAINER_LISTING_SQL} ORDER BY p.name ASC, m.created_at ASC NULLS LAST, c.container_id ASC`,
	);
	return res.rows.map(toContainerListing);
}

/** One container by its engine id, or null when nothing references it. */
export async function getContainerListing(
	db: Db,
	containerId: string,
): Promise<ContainerListing | null> {
	const res = await db.query<ContainerListingRow>(
		`${CONTAINER_LISTING_SQL} AND c.container_id = $1`,
		[containerId],
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
	memory_bytes: string | number | null;
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
 * once. The caller appends its own ordering or its `container_id` predicate.
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
	       -- Deliberately not the project's cap. A container holds the allocation it
	       -- was built with until the pool replaces it, so reading the setting here
	       -- reported a size no container had for as long as the two disagreed.
	       m.memory_bytes,
	       m.last_task_id,
	       t.identifier AS last_task_identifier,
	       r.id         AS run_id,
	       -- Falls back to the project's own columns only when there is genuinely
	       -- no member row (a legacy container predating the pool). A COALESCE
	       -- would instead let a *live* member with no error inherit whatever
	       -- stale text the project still carried, which is how a healthy Idle
	       -- container came to show a red error box from a previous failure.
	       CASE WHEN m.container_id IS NULL THEN p.container_error ELSE m.last_error END AS last_error,
	       CASE WHEN m.container_id IS NULL THEN p.container_last_logs ELSE m.last_logs END AS last_logs,
	       m.last_started_at,
	       m.last_released_at,
	       m.created_at
	  FROM (
	         SELECT container_id, id AS project_id FROM projects WHERE container_id IS NOT NULL
	         UNION
	         SELECT container_id, project_id FROM container_pool_members
	         UNION
	         -- A provision that has not been given an engine id yet. Both arms above
	         -- are keyed on one, and there is a real window before it exists - on a
	         -- managed backend the sandbox build is the longest part of a cold start.
	         -- Without this the page an operator is sent to during provisioning is
	         -- empty. Suppressed the moment a real member row appears, so the
	         -- placeholder is never listed beside the container it stood in for.
	         SELECT 'provisioning:' || p.id, p.id
	           FROM projects p
	          WHERE p.container_status = 'creating'::container_status
	            AND p.container_id IS NULL
	            AND NOT EXISTS (
	                  SELECT 1 FROM container_pool_members m
	                   WHERE m.project_id = p.id AND m.state = 'creating'
	                )
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
		memory_bytes: row.memory_bytes === null ? null : Number(row.memory_bytes),
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
		`UPDATE projects
		    SET container_id = NULL, container_status = NULL,
		        container_error = NULL, container_last_logs = NULL
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
	requiredMemoryBytes: number,
): Promise<PoolDecision> {
	return selectPoolMember(
		taskId,
		await loadPoolMembers(db, projectId),
		capacity,
		requiredMemoryBytes,
	);
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

export interface PoolMemberForReconcile {
	containerId: string;
	projectId: string;
	projectSlug: string;
	teamId: string;
	state: string;
	/**
	 * Null for a member whose allocation was never recorded - a container from
	 * before the column existed, or one adopted from outside the pool. Carried
	 * here so the reconcile pass can learn it from the engine round trip it is
	 * already making, rather than asking every member every tick.
	 */
	memoryBytes: number | null;
}

/**
 * Pool members old enough to be worth checking against the engine, oldest first.
 *
 * `updated_at` rather than `created_at`: a member that just changed state is
 * mid-transition and reconciling it would race the thing that moved it. The age
 * floor is what keeps a container created moments ago from being judged missing
 * before the provider can answer for it.
 *
 * The project's slug and team come along because what the caller does with a
 * dead member is fail the runs it was carrying, which is addressed by project -
 * and looking each one up per member would turn one query into a fan-out.
 */
export async function listPoolMembersForReconcile(
	db: Db,
	minAgeSeconds: number,
	limit: number,
): Promise<PoolMemberForReconcile[]> {
	const res = await db.query<{
		container_id: string;
		project_id: string;
		project_slug: string;
		team_id: string;
		state: string;
		memory_bytes: string | number | null;
	}>(
		`SELECT m.container_id, m.project_id, p.slug AS project_slug, p.team_id,
		        m.state::text AS state, m.memory_bytes
		   FROM container_pool_members m
		   JOIN projects p ON p.id = m.project_id
		  WHERE m.updated_at < now() - ($1 * interval '1 second')
		  ORDER BY m.updated_at ASC
		  LIMIT $2`,
		[minAgeSeconds, limit],
	);
	return res.rows.map((r) => ({
		containerId: r.container_id,
		projectId: r.project_id,
		projectSlug: r.project_slug,
		teamId: r.team_id,
		state: r.state,
		memoryBytes: r.memory_bytes === null ? null : Number(r.memory_bytes),
	}));
}

/**
 * Record what a container turned out to have been provisioned with, for a member
 * that never had it recorded.
 *
 * Only ever fills a gap: `memory_bytes IS NULL` is in the predicate, so a
 * recorded allocation is never overwritten by a reading. What the pool records
 * is the guarantee the caller asked for, and a backend whose unit is coarser
 * reports the larger figure it rounded up to - letting that replace a known
 * value would tell the ladder a container was built to a cap nobody set.
 *
 * A member left NULL reads as "cannot prove it covers the cap" and is recycled
 * on the next acquire, which stays the right answer for a backend that could not
 * say.
 */
export async function recordPoolMemberMemoryIfUnknown(
	db: Db,
	containerId: string,
	memoryBytes: number | null,
): Promise<void> {
	if (memoryBytes === null) return;
	await db.query(
		`UPDATE container_pool_members
		    SET memory_bytes = $2, updated_at = now()
		  WHERE container_id = $1 AND memory_bytes IS NULL`,
		[containerId, memoryBytes],
	);
}
