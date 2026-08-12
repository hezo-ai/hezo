import { CONTAINER_RECLAIM_MIN_IDLE_SEC, ContainerStatus, HeartbeatRunStatus } from '@hezo/shared';
import type { Db } from '../db/database';
import { getDefaultRamCapPerContainerGb, getMaxContainerMemoryGb } from '../lib/system-meta';

import type { ContainerEngine } from './sandbox/types';

/**
 * DB-backed concurrency checks — the single source of truth for the two run
 * rules: at most one active (queued/running) agent run per task, and no more
 * simultaneously RUNNING container memory across the instance than
 * `max_container_memory_gb` (system_meta; default derived from the engine's own
 * memory answer). A budget rather than a container count, because
 * `projects.memory_limit_gib` exists so containers are not all the same size —
 * see {@link ActiveContainers.usedMemoryGb}.
 * Shared by the scheduler (`JobManager`, which layers its in-memory dispatch
 * guards on top) and the stateless run-now route.
 *
 * `isTaskBusyInDb` is the only home for the one-run-per-task rule; call it
 * directly rather than reaching for a lookalike. `lib/reassign-guard.ts` and the
 * `has_active_run` flag in `routes/tasks.ts` run task-scoped checks over the same
 * rows for assignee-lock / badge purposes, but neither answers this question:
 * the guard exempts the caller and the incoming assignee by design, so a claim
 * path built on it would let a second run queue behind the first.
 */

export async function isTaskBusyInDb(db: Db, taskId: string): Promise<boolean> {
	const active = await db.query(
		`SELECT 1 FROM heartbeat_runs
		 WHERE task_id = $1
		   AND status IN ($2::heartbeat_run_status, $3::heartbeat_run_status)
		 LIMIT 1`,
		[taskId, HeartbeatRunStatus.Queued, HeartbeatRunStatus.Running],
	);
	return active.rows.length > 0;
}

export interface ActiveContainers {
	/**
	 * Ceiling on total task-run container memory, in GB - the operator's setting,
	 * else the automatic default the engine's own memory answer produces.
	 */
	budgetGb: number;
	/**
	 * Memory every running container has been promised, in GB, instance-wide.
	 *
	 * Summed from what each container was actually provisioned with
	 * (`container_pool_members.memory_bytes`, falling back to its project's
	 * `memory_limit_gib` or the instance default where that was never recorded)
	 * rather than counted. A count bounds memory only while every container is the
	 * same size, and the per-project override exists precisely so they are not:
	 * under a count, one project raising its cap to 4 GB silently doubles its share
	 * of a host sized for 2 GB containers.
	 *
	 * There is deliberately no container *count* here, derived or otherwise. How
	 * many containers fit depends on the mix of their sizes, so the number is not
	 * stable enough to mean anything to an operator or to gate on.
	 *
	 * Excludes the container reserved for the assistant chat, which the budget
	 * holds back up front rather than charging as it is used - see the query.
	 */
	usedMemoryGb: number;
	/**
	 * Projects that can serve another run **without starting a container**.
	 *
	 * Not the same question as "has a running container", which is what this used
	 * to answer. A project at one container per run is only free if one of its
	 * containers is actually idle; a project whose single container is busy needs
	 * a second one and must be gated like any other new start.
	 */
	projectsWithSpareContainer: Set<string>;
	/**
	 * Per project, how much of {@link usedMemoryGb} is held by idle members that
	 * have sat idle long enough for another project to reclaim them, in GB.
	 *
	 * Keyed by project rather than summed because the figure is only meaningful
	 * relative to who is asking: a project cannot reclaim from itself, and its own
	 * idle members are already offered to it through the pool's reuse rung. Read it
	 * with {@link reclaimableForOthers}.
	 *
	 * A container is pinned to its project for life - it is built around that
	 * project's workspace mount, clone and git identity - so this memory is
	 * reachable only by retiring the container, never by handing it over. Charging
	 * it as free would over-subscribe the host; ignoring it entirely wedges the
	 * instance, which is what it used to do.
	 */
	reclaimableMemoryGbByProject: Map<string, number>;
}

/** What {@link ActiveContainers.reclaimableMemoryGbByProject} offers a project other than its own. */
export function reclaimableForOthers(
	active: Pick<ActiveContainers, 'reclaimableMemoryGbByProject'>,
	projectId: string | null,
): number {
	let total = 0;
	for (const [id, gb] of active.reclaimableMemoryGbByProject) {
		if (id !== projectId) total += gb;
	}
	return total;
}

/**
 * Read the instance-wide container ceiling alongside what is already running.
 *
 * The count unions **both** representations of a container, keyed on the engine's
 * own id so a row present in each is counted once. `container_pool_members` is
 * additive (migration 049) and `projects.container_*` stays authoritative until
 * every lifecycle call site has moved over, so during that window a container may
 * be recorded in either place or both. Reading one alone would under-count, and
 * under-counting a capacity gate over-subscribes the host.
 */
export async function getActiveContainers(
	db: Db,
	engine: Pick<ContainerEngine, 'containerHostMemory'>,
): Promise<ActiveContainers> {
	const [budgetGb, defaultCapGb, running, spare, reclaimable] = await Promise.all([
		getMaxContainerMemoryGb(db, engine),
		getDefaultRamCapPerContainerGb(db),
		db.query<{ project_id: string; memory_bytes: string | number | null }>(
			// The UNION is keyed on the engine's own container id so a container
			// recorded in both representations is counted once; the project it
			// belongs to is carried through because that is where its memory cap
			// lives.
			//
			// A member reserved for the assistant chat is left out: the budget is a
			// *task-run* budget, and the automatic default already holds one
			// container's worth back for chat. Counting it here as well reserved the
			// same memory twice, so an instance sized for three containers dispatched
			// two whenever the chat was open.
			//
			// The allocation is joined on afterwards rather than selected inside the
			// UNION: adding a column that is null on one arm and a figure on the other
			// would stop a container recorded in both places deduplicating, and
			// counting one container twice is the same defect in the other direction.
			`SELECT r.project_id, m.memory_bytes
			   FROM (
			     SELECT id AS project_id, container_id FROM projects
			      WHERE container_id IS NOT NULL AND container_status = $1::container_status
			        AND NOT EXISTS (
			          SELECT 1 FROM container_pool_members m
			           WHERE m.container_id = projects.container_id AND m.reserved_for_chat
			        )
			     UNION
			     SELECT project_id, container_id FROM container_pool_members
			      WHERE state IN ('creating', 'idle', 'busy') AND NOT reserved_for_chat
			   ) AS r
			   LEFT JOIN container_pool_members m ON m.container_id = r.container_id`,
			[ContainerStatus.Running],
		),
		db.query<{ project_id: string }>(
			// A project is spare-capable if it has an idle pool member a run may
			// take - never one that is busy, reserved for the chat, or out of disk -
			// or, while the pool is not yet populated for it, a running container of
			// its own, which is today's one-container-per-project behaviour.
			// Each member is judged against its own recorded ceiling rather than a
			// global constant - the allocation is a setting now, and a project may
			// override it, so two idle members can legitimately have different room.
			`SELECT project_id FROM container_pool_members
			  WHERE state = 'idle' AND NOT reserved_for_chat AND disk_used_bytes < disk_ceiling_bytes
			 UNION
			 SELECT id AS project_id FROM projects
			  WHERE container_status = $1::container_status
			    AND NOT EXISTS (
			      SELECT 1 FROM container_pool_members m WHERE m.project_id = projects.id
			    )`,
			[ContainerStatus.Running],
		),
		db.query<{ project_id: string; memory_bytes: string | number | null }>(
			// The subset of the running count that another project could get back by
			// retiring it. Pool members only: the legacy `projects.container_*` arm
			// records no state, so a container known only there cannot be shown to be
			// idle, and retiring one on a guess would kill a live run.
			//
			// The chat's pinned member is excluded here as it is above - it is not in
			// `usedMemoryGb`, so retiring it frees nothing against the budget and only
			// interrupts somebody's session.
			//
			// Served by `idx_container_pool_members_idle`.
			`SELECT project_id, memory_bytes FROM container_pool_members
			  WHERE state = 'idle' AND NOT reserved_for_chat
			    AND last_released_at <= now() - ($1 * interval '1 second')`,
			[CONTAINER_RECLAIM_MIN_IDLE_SEC],
		),
	]);
	// One query for the overrides rather than one per container: the set of
	// distinct projects here is small, and a per-row lookup would make this gate
	// cost grow with the fleet it is gating.
	const overrides = await loadProjectMemoryCaps(
		db,
		new Set([...running.rows, ...reclaimable.rows].map((r) => r.project_id)),
	);
	let usedMemoryGb = 0;
	for (const row of running.rows) {
		// What the container was actually built to hold, where that is recorded. A
		// container keeps its allocation until the pool replaces it, so between a cap
		// being changed and its containers being recycled the setting describes
		// something that is not running - and charging the *new* figure for a
		// container still holding the old one under-counts whenever the cap was
		// lowered, which is the direction that over-subscribes the host. The cap is
		// the fallback for a container whose allocation was never recorded.
		usedMemoryGb +=
			row.memory_bytes === null
				? (overrides.get(row.project_id) ?? defaultCapGb)
				: Number(row.memory_bytes) / 1024 ** 3;
	}
	// Resolved exactly as `usedMemoryGb` above, and it has to be: this is a subset
	// of that figure, so a different fallback would let a project reclaim more or
	// less than retiring the container actually gives back.
	const reclaimableMemoryGbByProject = new Map<string, number>();
	for (const row of reclaimable.rows) {
		const gb =
			row.memory_bytes === null
				? (overrides.get(row.project_id) ?? defaultCapGb)
				: Number(row.memory_bytes) / 1024 ** 3;
		reclaimableMemoryGbByProject.set(
			row.project_id,
			(reclaimableMemoryGbByProject.get(row.project_id) ?? 0) + gb,
		);
	}

	return {
		budgetGb,
		usedMemoryGb,
		projectsWithSpareContainer: new Set(spare.rows.map((r) => r.project_id)),
		reclaimableMemoryGbByProject,
	};
}

/** Per-project memory caps for the given projects; absent means "inherits the default". */
async function loadProjectMemoryCaps(
	db: Db,
	projectIds: ReadonlySet<string>,
): Promise<Map<string, number>> {
	if (projectIds.size === 0) return new Map();
	const res = await db.query<{ id: string; memory_limit_gib: number | null }>(
		`SELECT id, memory_limit_gib FROM projects WHERE id = ANY($1::uuid[])`,
		[[...projectIds]],
	);
	const out = new Map<string, number>();
	for (const row of res.rows) {
		if (row.memory_limit_gib !== null) out.set(row.id, Number(row.memory_limit_gib));
	}
	return out;
}

/**
 * What one more container in **each** of these projects would consume, summed.
 *
 * Two queries whatever the list length, rather than the one-to-two per project a
 * loop over {@link projectContainerMemoryGb} costs. The caller is the dispatch
 * gate charging for lazy starts already in flight: a small list today, but a
 * gate whose cost grows with what it is gating is the wrong shape regardless.
 * A project listed twice is charged twice, which is correct - two in-flight
 * starts in one project are two containers.
 */
export async function sumProjectContainerMemoryGb(
	db: Db,
	projectIds: readonly string[],
): Promise<number> {
	if (projectIds.length === 0) return 0;
	const overrides = await loadProjectMemoryCaps(db, new Set(projectIds));
	const fallback = await getDefaultRamCapPerContainerGb(db);
	let total = 0;
	for (const id of projectIds) total += overrides.get(id) ?? fallback;
	return total;
}

/**
 * This project's per-container memory cap, in GB: the project's override, else
 * the instance default.
 *
 * Two meanings, one figure - what one more container here would consume against
 * the capacity budget, and the ceiling a container is actually provisioned with.
 */
export async function projectContainerMemoryGb(db: Db, projectId: string): Promise<number> {
	const res = await db.query<{ memory_limit_gib: number | null }>(
		`SELECT memory_limit_gib FROM projects WHERE id = $1`,
		[projectId],
	);
	return res.rows[0]?.memory_limit_gib ?? (await getDefaultRamCapPerContainerGb(db));
}

/**
 * Stateless container-capacity gate (route-side mirror of the scheduler's
 * in-memory-guarded check): would running in `projectId` need a container start
 * that exceeds the cap?
 *
 * The old shortcut - "a project whose container is already up is never blocked" -
 * is gone. It was only ever true at one container per project: with a pool, a
 * project whose containers are all busy needs a *new* one, and waving it through
 * would let concurrent runs in one project walk straight past the cap. What
 * replaces it is the narrower and still-correct claim that a project with a
 * container genuinely free to take the run consumes no new slot.
 *
 * Reclaimable memory counts as headroom here, and must: the acquire path can now
 * retire another project's idle container to make room, but it never gets the
 * chance if this gate skips the dispatch first. Gating on the raw budget alone is
 * what let one busy project's idle containers wedge every other project on the
 * instance.
 */
export async function isContainerCapacityBlockedInDb(
	db: Db,
	engine: Pick<ContainerEngine, 'containerHostMemory'>,
	projectId: string,
): Promise<boolean> {
	const active = await getActiveContainers(db, engine);
	if (active.projectsWithSpareContainer.has(projectId)) return false;
	const headroomGb = active.budgetGb + reclaimableForOthers(active, projectId);
	return active.usedMemoryGb + (await projectContainerMemoryGb(db, projectId)) > headroomGb;
}

/**
 * Active (queued/running) runs inside one project. Not a capacity input — the
 * cap is instance-wide — but the repo routes gate destructive git operations
 * (reset, re-clone) on the project being quiet, and the idle-stop recheck uses
 * the same figure.
 */
export async function countActiveRunsInProject(db: Db, projectId: string): Promise<number> {
	const row = await db.query<{ active: number }>(
		`SELECT count(*)::int AS active FROM heartbeat_runs r
		 JOIN tasks t ON t.id = r.task_id
		 WHERE t.project_id = $1
		   AND r.status IN ($2::heartbeat_run_status, $3::heartbeat_run_status)`,
		[projectId, HeartbeatRunStatus.Queued, HeartbeatRunStatus.Running],
	);
	return row.rows[0]?.active ?? 0;
}

/**
 * Member ids with an active (queued/running) run anywhere in the project — the
 * set whose per-agent dispatch slot is taken. The stateless run-now route uses
 * this to mirror `JobManager.isAgentBusyInProject` minus its in-memory guard.
 */
export async function getBusyAgentIdsInProject(db: Db, projectId: string): Promise<Set<string>> {
	const res = await db.query<{ member_id: string }>(
		`SELECT DISTINCT hr.member_id FROM heartbeat_runs hr
		 JOIN tasks t ON t.id = hr.task_id
		 WHERE t.project_id = $1
		   AND hr.status IN ($2::heartbeat_run_status, $3::heartbeat_run_status)`,
		[projectId, HeartbeatRunStatus.Queued, HeartbeatRunStatus.Running],
	);
	return new Set(res.rows.map((r) => r.member_id));
}
