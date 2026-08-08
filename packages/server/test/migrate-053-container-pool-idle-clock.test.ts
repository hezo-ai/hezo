import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDataPreservationHarness, type DataPreservationHarness } from './helpers/migrate';

const TARGET = '053_container_pool_idle_clock.sql';

interface Seeded {
	projectId: string;
	/** Released a while ago - the ordinary case, and the one that must not be rewritten. */
	released: string;
	/** Provisioned but never released, so its stamp is NULL and has to be invented. */
	neverReleased: string;
}

/**
 * The migration exists to make `last_released_at` a dependable clock. Two things
 * have to be true afterwards and neither is "the column changed": a member that
 * already carried a release stamp must still carry *that* stamp (the clock is
 * what decides which container gets retired, so silently resetting one would
 * hand the idle sweeper a wrong answer), and a member that never carried one
 * must come out with a usable figure rather than a NULL the new scans cannot
 * index.
 */
describe('053_container_pool_idle_clock migration', () => {
	let h: DataPreservationHarness;
	let seeded: Seeded;
	let releasedAt: Date;

	beforeAll(async () => {
		h = await createDataPreservationHarness();
		await h.applyUpToExclusive(TARGET);

		const team = await h.db.query<{ id: string }>(
			`INSERT INTO teams (name, slug) VALUES ($1, $1) RETURNING id`,
			['team-idle-clock'],
		);
		const project = await h.db.query<{ id: string }>(
			`INSERT INTO projects (team_id, name, slug, task_prefix)
			 VALUES ($1, $2, $2, $3) RETURNING id`,
			[team.rows[0].id, 'idle-clock', 'IDL'],
		);
		const projectId = project.rows[0].id;

		releasedAt = new Date(Date.now() - 90 * 60 * 1000);
		const member = async (
			containerId: string,
			state: string,
			lastReleasedAt: Date | null,
		): Promise<string> => {
			const res = await h.db.query<{ id: string }>(
				`INSERT INTO container_pool_members (project_id, container_id, state, last_released_at)
				 VALUES ($1, $2, $3::container_pool_state, $4) RETURNING id`,
				[projectId, containerId, state, lastReleasedAt],
			);
			return res.rows[0].id;
		};

		seeded = {
			projectId,
			released: await member('ctr-released', 'idle', releasedAt),
			neverReleased: await member('ctr-never-released', 'idle', null),
		};

		await h.applyTarget(TARGET);
	});
	afterAll(() => h.close());

	it('preserves both pre-existing members and the release stamp one already had', async () => {
		const rows = await h.db.query<{ id: string; container_id: string; last_released_at: Date }>(
			`SELECT id, container_id, last_released_at FROM container_pool_members
			  WHERE project_id = $1 ORDER BY container_id`,
			[seeded.projectId],
		);
		expect(rows.rows.map((r) => r.container_id)).toEqual(['ctr-never-released', 'ctr-released']);

		const released = rows.rows.find((r) => r.id === seeded.released);
		expect(released).toBeDefined();
		// To the second: the column is TIMESTAMPTZ and the driver round-trips it,
		// but the point of the assertion is that the backfill did not touch a row
		// that already had a stamp.
		expect(new Date(released?.last_released_at ?? 0).getTime()).toBeCloseTo(
			releasedAt.getTime(),
			-3,
		);
	});

	it('backfills a missing stamp from the member creation time', async () => {
		const row = await h.db.query<{ last_released_at: Date; created_at: Date }>(
			`SELECT last_released_at, created_at FROM container_pool_members WHERE id = $1`,
			[seeded.neverReleased],
		);
		const { last_released_at, created_at } = row.rows[0];
		expect(last_released_at).not.toBeNull();
		expect(new Date(last_released_at).getTime()).toBe(new Date(created_at).getTime());
	});

	it('makes the clock total, so the idle scans never meet a NULL', async () => {
		const nullable = await h.db.query<{ is_nullable: string; column_default: string | null }>(
			`SELECT is_nullable, column_default FROM information_schema.columns
			  WHERE table_name = 'container_pool_members' AND column_name = 'last_released_at'`,
		);
		expect(nullable.rows[0].is_nullable).toBe('NO');
		expect(nullable.rows[0].column_default).toContain('now()');

		// A new member inserted the way `upsertPoolMember` does - without naming
		// the column - still satisfies the constraint.
		const inserted = await h.db.query<{ last_released_at: Date }>(
			`INSERT INTO container_pool_members (project_id, container_id, state)
			 VALUES ($1, $2, 'creating'::container_pool_state) RETURNING last_released_at`,
			[seeded.projectId, 'ctr-fresh'],
		);
		expect(inserted.rows[0].last_released_at).not.toBeNull();
	});

	it('indexes the columns the idle sweep and the reclaim scan actually order by', async () => {
		const idx = await h.db.query<{ indexdef: string }>(
			`SELECT indexdef FROM pg_indexes
			  WHERE tablename = 'container_pool_members'
			    AND indexname = 'idx_container_pool_members_idle'`,
		);
		expect(idx.rows).toHaveLength(1);
		expect(idx.rows[0].indexdef).toContain('state');
		expect(idx.rows[0].indexdef).toContain('last_released_at');
		expect(idx.rows[0].indexdef).toContain('reserved_for_chat');
	});
});
