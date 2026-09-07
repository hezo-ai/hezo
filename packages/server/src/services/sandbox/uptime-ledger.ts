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
 * **The interval opens when provisioning starts, not when the container is
 * ready.** The build - image resolve, clone, package install - is the longest
 * phase of a cold start on a managed backend, and it is billed like any other
 * running minute. `upsertPoolMember` writes its `creating` member the moment the
 * engine returns an id, and the interval follows that write.
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
 */
export async function openUptimeInterval(db: Db, containerId: string): Promise<void> {
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
		     (project_id, container_id, memory_bytes, disk_ceiling_bytes, backend)
		 SELECT m.project_id, m.container_id, m.memory_bytes, m.disk_ceiling_bytes, $2
		   FROM container_pool_members m
		  WHERE m.container_id = $1
		 ON CONFLICT (container_id) WHERE ended_at IS NULL DO NOTHING`,
		[containerId, backend],
	);
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
