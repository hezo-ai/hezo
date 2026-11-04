/**
 * The container-hours ledger: one row per **running stretch** of a container.
 *
 * Nothing measured container uptime before this. The Activity page's "Hours" is
 * per-agent run wall clock, which is a different quantity and wrong in both
 * directions for a bill - it sums concurrent runs that shared one container, and
 * it cannot see build time, warm-idle time, or the assistant chat's container at
 * all.
 *
 * **A row is a running stretch, not a container lifetime.** A managed backend
 * bills a started sandbox for vCPU + RAM + disk and a stopped one for reserved
 * disk only, so compute billing ends at every stop and a container that suspends
 * and resumes three times is four rows rather than one reopened.
 *
 * **A row covers the whole time the backend bills, not the time the container
 * is useful.** A managed backend bills creating, starting and stopping at the
 * running rate, so an interval starts at the instant the create, start or resume
 * request is sent - backdated, since the container id is only known once the
 * engine answers - and ends once the engine reports the stop or removal
 * *finished*, which every engine's lifecycle calls promise before they resolve.
 * A create whose answer never arrived is metered from a provisional row keyed by
 * the container's name until the container is found or proved never to have
 * existed (see {@link openProvisionalInterval}).
 *
 * **Backend-agnostic bookkeeping, above the seam.** No adapter writes it: what a
 * provider charges is that provider's business, but *when a container was up* is
 * the same question on every backend. The recorded `backend` is a label for
 * re-costing later, never something the ledger branches on.
 *
 * Every function here is idempotent, which is what lets the pool call them from
 * paths that legitimately overlap. The unique partial index on
 * `(container_id) WHERE ended_at IS NULL` is the enforcement - without it a
 * double-open would bill the same minutes twice.
 */

import type { ContainerUptimeEndReason } from '@hezo/shared';
import type { Db } from '../../db/database';
import { getSandboxBackendSetting } from './backend-store';

/**
 * Start billing a container, from the member row that already describes it.
 *
 * `INSERT ... SELECT` rather than a read followed by a write: the shape and
 * ownership live on the member, and re-deriving them at the call site is how
 * the ledger would come to disagree with the pool it describes.
 * A container with no member row inserts nothing, which is the honest answer -
 * the pool does not believe that container exists.
 *
 * `ON CONFLICT ... DO NOTHING` makes a second open a no-op rather than a second
 * interval, so provisioning's two upserts (`creating`, then `idle`) produce one
 * row, and so does a resume that races the status sync noticing the same resume.
 *
 * `startedAt` is when the start or create request was sent; omitted, the
 * interval starts now. Either way it never starts before the container's last
 * interval ended: a resume asked for while the previous stop was still
 * completing would otherwise bill the overlap twice.
 */
export async function openUptimeInterval(
	db: Db,
	containerId: string,
	startedAt?: Date,
): Promise<void> {
	// The stored setting rather than the holder's engine, for the reason
	// `template-resolver.ts` gives at its own read: the stored value is what
	// selects the backend at boot and what a runtime switch writes, so it is the
	// same answer the holder would give and it keeps every caller unchanged.
	const backend = await getSandboxBackendSetting(db);
	// `reserved_for_chat` stays on the ledger as recorded history from the era
	// of the pinned assistant container; nothing pins any more, so every new
	// interval records false and nothing reads the column.
	await db.query(
		`INSERT INTO container_uptime_entries
		     (project_id, container_id, memory_bytes, disk_ceiling_bytes, backend, started_at)
		 SELECT m.project_id, m.container_id, m.memory_bytes, m.disk_ceiling_bytes, $2,
		        GREATEST(COALESCE($3::timestamptz, now()),
		                 (SELECT max(e.ended_at) FROM container_uptime_entries e
		                   WHERE e.container_id = $1))
		   FROM container_pool_members m
		  WHERE m.container_id = $1
		 ON CONFLICT (container_id) WHERE ended_at IS NULL DO NOTHING`,
		[containerId, backend, startedAt ?? null],
	);
}

/**
 * Where a create request's interval is kept until the engine names the
 * container.
 *
 * The create call is the slowest lifecycle call on a managed backend and is
 * billed throughout, but the container id only exists once it answers. A
 * provisional row keyed by the container's **name** - which the caller chose and
 * every backend can be searched by - is opened before the call and re-keyed to
 * the id once it is known. A create that failed or never answered is then
 * settled by looking the name up: found, it is metered until removed; not found,
 * the row is dropped and nothing is billed.
 */
const PROVISIONAL_KEY_PREFIX = 'provisioning:';

export function provisionalContainerKey(containerName: string): string {
	return `${PROVISIONAL_KEY_PREFIX}${containerName}`;
}

/** The container name a provisional key stands for. */
export function containerNameFromProvisionalKey(key: string): string {
	return key.slice(PROVISIONAL_KEY_PREFIX.length);
}

/** Open a provisional interval for a create request about to be sent. */
export async function openProvisionalInterval(
	db: Db,
	args: {
		containerName: string;
		projectId: string;
		memoryBytes: number;
		diskCeilingBytes: number;
		startedAt: Date;
	},
): Promise<void> {
	const backend = await getSandboxBackendSetting(db);
	await db.query(
		`INSERT INTO container_uptime_entries
		     (project_id, container_id, memory_bytes, disk_ceiling_bytes, backend, started_at)
		 VALUES ($1, $2, $3, $4, $5, $6)
		 ON CONFLICT (container_id) WHERE ended_at IS NULL DO NOTHING`,
		[
			args.projectId,
			provisionalContainerKey(args.containerName),
			args.memoryBytes,
			args.diskCeilingBytes,
			backend,
			args.startedAt,
		],
	);
}

/**
 * Re-key a provisional interval to the container the create produced. Returns
 * whether one was there to re-key.
 *
 * Should the container somehow already be billing - an adopt that ran twice, or
 * an engine that hands back an id it has used before - the open interval it has
 * is kept and the provisional one dropped, so the container never bills twice.
 */
export async function adoptProvisionalInterval(
	db: Db,
	containerName: string,
	containerId: string,
): Promise<boolean> {
	const key = provisionalContainerKey(containerName);
	await db.query(
		`DELETE FROM container_uptime_entries
		  WHERE container_id = $1 AND ended_at IS NULL
		    AND EXISTS (SELECT 1 FROM container_uptime_entries o
		                 WHERE o.container_id = $2 AND o.ended_at IS NULL)`,
		[key, containerId],
	);
	const res = await db.query<{ id: string }>(
		`UPDATE container_uptime_entries SET container_id = $2
		  WHERE container_id = $1 AND ended_at IS NULL
		 RETURNING id`,
		[key, containerId],
	);
	return res.rows.length > 0;
}

/**
 * Drop a provisional interval for a create the engine has shown produced no
 * container. A row that only ever stood for a request is not a billed hour, so
 * removing it is not removing history.
 */
export async function discardProvisionalInterval(db: Db, containerName: string): Promise<void> {
	await db.query(
		`DELETE FROM container_uptime_entries WHERE container_id = $1 AND ended_at IS NULL`,
		[provisionalContainerKey(containerName)],
	);
}

/** An open interval the reconcile pass has to settle against the engine. */
export interface UnsettledInterval {
	/** The container id, or a provisional key when {@link provisional} is set. */
	containerId: string;
	provisional: boolean;
}

/**
 * Open intervals that no live pool member accounts for, oldest first.
 *
 * Two kinds, both left behind by a process that died mid-call: a provisional row
 * whose create never answered, and a real container's row whose member was
 * already dropped for a removal that never confirmed. Either would otherwise
 * bill to `now()` for ever. `minAgeSec` keeps a create or removal still in
 * flight in this process out of it. Served by `idx_container_uptime_open`.
 */
export async function listUnsettledIntervals(
	db: Db,
	minAgeSec: number,
	limit: number,
): Promise<UnsettledInterval[]> {
	const res = await db.query<{ container_id: string }>(
		`SELECT e.container_id FROM container_uptime_entries e
		  WHERE e.ended_at IS NULL
		    AND e.started_at < now() - ($1 * interval '1 second')
		    AND NOT EXISTS (SELECT 1 FROM container_pool_members m
		                     WHERE m.container_id = e.container_id)
		  ORDER BY e.started_at
		  LIMIT $2`,
		[minAgeSec, limit],
	);
	return res.rows.map((r) => ({
		containerId: r.container_id,
		provisional: r.container_id.startsWith(PROVISIONAL_KEY_PREFIX),
	}));
}

/**
 * Stop billing a container.
 *
 * Scoped to the open interval, so closing a container that is already closed
 * touches nothing rather than reopening or rewriting history - which matters
 * because several paths legitimately close the same container: the status sync's
 * running-to-stopped branch and the teardown that follows it both fire, and
 * whichever arrives second must not move the first one's `ended_at`.
 */
export async function closeUptimeInterval(
	db: Db,
	containerId: string,
	reason: ContainerUptimeEndReason,
): Promise<void> {
	await db.query(
		`UPDATE container_uptime_entries
		    SET ended_at = now(), end_reason = $2
		  WHERE container_id = $1 AND ended_at IS NULL`,
		[containerId, reason],
	);
}

/**
 * Close every open interval whose container the pool still describes.
 *
 * The set-based twin of {@link closeUptimeInterval}, for the one caller that
 * forgets the whole pool at once: a backend switch destroys every container the
 * outgoing backend was running, so every stretch they were billing ends with
 * them. Written here rather than at that call site so the ledger keeps its single
 * writer, and as one statement rather than a loop because the row count is the
 * fleet size.
 *
 * Left open, those intervals would bill to `now()` for ever, on containers that
 * no longer exist, on a backend this instance has stopped talking to.
 */
export async function closeUptimeIntervalsForMembers(
	db: Db,
	reason: ContainerUptimeEndReason,
): Promise<void> {
	await db.query(
		`UPDATE container_uptime_entries e
		    SET ended_at = now(), end_reason = $1
		  WHERE e.ended_at IS NULL
		    AND EXISTS (SELECT 1 FROM container_pool_members m
		                 WHERE m.container_id = e.container_id)`,
		[reason],
	);
}
