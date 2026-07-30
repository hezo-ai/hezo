import type { Db } from '../../src/db/database';
import {
	deleteSystemMeta,
	MAX_ACTIVE_CONTAINERS_KEY,
	setSystemMeta,
} from '../../src/lib/system-meta';

/**
 * Capacity-test seeding for the container-count concurrency model. A project
 * whose own container is running is never capacity-blocked, so "at capacity"
 * scenarios need the limit consumed by OTHER projects' running containers:
 * this creates a filler team+project pair whose container reads Running.
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

/** Set the instance-wide active-container limit (system_meta). */
export async function setMaxActiveContainersForTest(db: Db, limit: number): Promise<void> {
	await setSystemMeta(db, MAX_ACTIVE_CONTAINERS_KEY, String(limit));
}

/** Remove the explicit limit — the host-memory-computed default applies again. */
export async function clearMaxActiveContainersForTest(db: Db): Promise<void> {
	await deleteSystemMeta(db, MAX_ACTIVE_CONTAINERS_KEY);
}

/** Delete a filler project seeded by {@link seedRunningContainerProject}. */
export async function removeSeededContainerProject(db: Db, slug: string): Promise<void> {
	await db.query(`DELETE FROM teams WHERE slug = $1`, [slug]);
}
