import { afterAll, beforeAll, expect, it } from 'vitest';
import type { Db } from '../src/db/database';
import { listAllContainers } from '../src/services/sandbox/pool-db';
import { createTestApp, createTestProject, createTestTeam } from './helpers/app';

/**
 * How a failed container reaches the operator, and why it is derived rather than
 * stored.
 *
 * `projects.container_status` is a leftover of the one-container-per-project
 * model and it **latches**: the sync loop writes `error` while nulling
 * `container_id`, after which the remove path - which clears the project row
 * only `WHERE container_id = $2` - can never name the container again. An
 * operator who removed the failed container was left with a permanent banner
 * pointing at a page that no longer listed anything, and the column gates
 * nothing anyway (`acquireRunContainer` never reads it, and the pool ladder
 * skips failed members, so the next run just creates a fresh container).
 *
 * So the project surface counts failed **pool members**, which are deleted with
 * their container and therefore need no clearing path at all.
 */

let ctx: Awaited<ReturnType<typeof createTestApp>>;
let db: Db;
let teamId: string;
let projectId: string;

beforeAll(async () => {
	ctx = await createTestApp();
	db = ctx.db;
	teamId = (await (await createTestTeam(db, { name: 'Error Surfacing' })).json()).data.id;
	const project = (await (await createTestProject(db, teamId, { name: 'Surfacing' })).json()).data;
	projectId = project.id;
});

afterAll(async () => {
	await ctx.db.close();
});

async function addMember(containerId: string, state: string, lastError: string | null) {
	await db.query(
		`INSERT INTO container_pool_members (project_id, container_id, state, last_error)
		 VALUES ($1, $2, $3::container_pool_state, $4)`,
		[projectId, containerId, state, lastError],
	);
}

async function failedCount(): Promise<number> {
	const res = await ctx.app.request('/api/projects', {
		headers: { Authorization: `Bearer ${ctx.token}` },
	});
	const rows = (await res.json()).data as Array<{ id: string; failed_container_count: number }>;
	return rows.find((r) => r.id === projectId)?.failed_container_count ?? -1;
}

it('counts only the pool members the ladder has given up on', async () => {
	expect(await failedCount()).toBe(0);

	// A usable member carrying its last run's error is not a broken container -
	// counting it would light the banner for every ordinary non-zero exit.
	await addMember('ok-with-history', 'idle', 'exited with code 137');
	expect(await failedCount()).toBe(0);

	await addMember('really-failed', 'error', 'provision threw');
	expect(await failedCount()).toBe(1);
});

it('stops counting as soon as the failed member is gone, with nothing to clear', async () => {
	// The whole point of deriving it. Removing the container deletes the member,
	// and the signal goes with it - no clearing path to forget, and no dependence
	// on the project row still naming that container.
	await db.query(`DELETE FROM container_pool_members WHERE container_id = 'really-failed'`);
	expect(await failedCount()).toBe(0);
});

it('does not report a stale project error against a live member', async () => {
	// The listing falls back to `projects.container_error` only when there is
	// genuinely no member row. A COALESCE let a healthy member with no error of
	// its own inherit whatever text the project still carried, which is how an
	// `Idle` container came to show a red error box from an earlier failure.
	await db.query(
		`UPDATE projects SET container_error = 'a failure that has since been cleared up' WHERE id = $1`,
		[projectId],
	);
	const listing = await listAllContainers(db);
	const live = listing.find((c) => c.container_id === 'ok-with-history');
	expect(live?.last_error).toBe('exited with code 137');

	await db.query(`UPDATE container_pool_members SET last_error = NULL WHERE container_id = $1`, [
		'ok-with-history',
	]);
	const after = await listAllContainers(db);
	expect(after.find((c) => c.container_id === 'ok-with-history')?.last_error).toBeNull();
});
