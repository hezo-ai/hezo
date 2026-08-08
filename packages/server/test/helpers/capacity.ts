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
 * Give the instance room for exactly `containers` default-sized containers.
 *
 * Capacity is a memory budget, not a count - a count could not bound memory once
 * a project may raise its own per-container cap. Tests still think in whole
 * containers, so the conversion lives here rather than at ten call sites, and
 * "room for N" keeps meaning the same thing it always did.
 */
export async function setContainerCapacityForTest(db: Db, containers: number): Promise<void> {
	const capGb = await getDefaultRamCapPerContainerGb(db);
	await setSystemMeta(db, MAX_CONTAINER_MEMORY_GB_KEY, String(containers * capGb));
}

/** Remove the explicit budget — the host-memory-computed default applies again. */
export async function clearContainerCapacityForTest(db: Db): Promise<void> {
	await deleteSystemMeta(db, MAX_CONTAINER_MEMORY_GB_KEY);
}

/** Delete a filler project seeded by {@link seedRunningContainerProject}. */
export async function removeSeededContainerProject(db: Db, slug: string): Promise<void> {
	await db.query(`DELETE FROM teams WHERE slug = $1`, [slug]);
}
