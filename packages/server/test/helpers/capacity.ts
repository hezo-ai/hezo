import { chatContainerReservationGb } from '@hezo/shared';
import type { Db } from '../../src/db/database';
import {
	deleteSystemMeta,
	getDefaultRamCapPerContainerGb,
	MAX_CONTAINER_MEMORY_GB_KEY,
	setSystemMeta,
} from '../../src/lib/system-meta';

/**
 * Capacity-test seeding. A project with a container free to take the run is
 * never capacity-blocked, so "at capacity" scenarios need the budget consumed
 * by OTHER projects' running containers: this creates a filler team+project
 * pair whose container reads Running.
 */
export async function seedRunningContainerProject(db: Db, slug: string): Promise<string> {
	const team = await db.query<{ id: string }>(
		`INSERT INTO teams (name, slug) VALUES ($1, $1) RETURNING id`,
		[slug],
	);
	const project = await db.query<{ id: string }>(
		`INSERT INTO projects (team_id, name, slug, task_prefix, container_id, container_status, container_last_started_at)
		 VALUES ($1, $2, $2, upper(left($2, 3)), 'cid-' || $2, 'running', now()) RETURNING id`,
		[team.rows[0].id, slug],
	);
	return project.rows[0].id;
}

/**
 * Give the instance room for exactly `containers` default-sized TASK containers.
 *
 * Capacity is a memory budget, not a count - a count could not bound memory once
 * a project may raise its own per-container cap. Tests still think in whole
 * containers, so the conversion lives here rather than at ten call sites, and
 * "room for N" keeps meaning the same thing it always did.
 *
 * The setting is the **total**, so the chat reservation is added on top of the N
 * the caller asked for. Without it every caller silently lost a container: a
 * budget of `1 * capGb` reserves the lot for the chat and admits no task run at
 * all, so a test setting capacity to 1 and expecting a slot to free saw it stay
 * blocked forever.
 */
export async function setContainerCapacityForTest(db: Db, containers: number): Promise<void> {
	const capGb = await getDefaultRamCapPerContainerGb(db);
	const totalGb = containers * capGb + chatContainerReservationGb(capGb);
	await setSystemMeta(db, MAX_CONTAINER_MEMORY_GB_KEY, String(totalGb));
}

/** Remove the explicit budget — the host-memory-computed default applies again. */
export async function clearContainerCapacityForTest(db: Db): Promise<void> {
	await deleteSystemMeta(db, MAX_CONTAINER_MEMORY_GB_KEY);
}

/** Delete a filler project seeded by {@link seedRunningContainerProject}. */
export async function removeSeededContainerProject(db: Db, slug: string): Promise<void> {
	await db.query(`DELETE FROM teams WHERE slug = $1`, [slug]);
}
