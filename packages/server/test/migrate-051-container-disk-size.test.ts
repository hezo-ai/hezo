import { DEFAULT_CONTAINER_DISK_GB, poolDiskCeilingBytes } from '@hezo/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDataPreservationHarness, type DataPreservationHarness } from './helpers/migrate';

const TARGET = '051_container_disk_size.sql';

/**
 * The container disk allocation becomes a setting, and the pool's recycle
 * threshold moves from a shared constant onto each member.
 *
 * The preservation claim that matters is the second one. An existing member was
 * provisioned with the old allocation and has been judged against a flat 2 GB;
 * backfilling it to a ceiling derived from the *new* default would tell a
 * container that really only has the old disk that it may fill much further, and
 * the run that discovered otherwise would fail partway through. So the migration
 * must carry those members forward at the threshold they already had, not at the
 * one new containers will get.
 */
describe('051_container_disk_size migration', () => {
	let h: DataPreservationHarness;
	let projectId: string;
	let memberId: string;

	beforeAll(async () => {
		h = await createDataPreservationHarness();
		await h.applyUpToExclusive(TARGET);

		const team = await h.db.query<{ id: string }>(
			`INSERT INTO teams (name, slug) VALUES ('Acme', 'acme') RETURNING id`,
		);
		const project = await h.db.query<{ id: string }>(
			`INSERT INTO projects (team_id, name, slug, task_prefix, memory_limit_gib)
			 VALUES ($1, 'Web', 'web', 'WEB', 4) RETURNING id`,
			[team.rows[0].id],
		);
		projectId = project.rows[0].id;

		// A member at the schema *before* the column exists, carrying real usage.
		const member = await h.db.query<{ id: string }>(
			`INSERT INTO container_pool_members (project_id, container_id, state, disk_used_bytes)
			 VALUES ($1, 'ctr-existing', 'idle'::container_pool_state, 1073741824) RETURNING id`,
			[projectId],
		);
		memberId = member.rows[0].id;

		await h.applyTarget(TARGET);
	});
	afterAll(() => h.close());

	it('adds the per-project override, defaulting to inherit', async () => {
		const row = await h.db.query<{ container_disk_gb: number | null }>(
			'SELECT container_disk_gb FROM projects WHERE id = $1',
			[projectId],
		);
		expect(row.rows.length).toBe(1);
		// NULL, not the default value: a project that never chose one must keep
		// following the instance setting when the operator changes it.
		expect(row.rows[0].container_disk_gb).toBeNull();
	});

	it('accepts an override and refuses one below the floor', async () => {
		await h.db.query('UPDATE projects SET container_disk_gb = 8 WHERE id = $1', [projectId]);
		const row = await h.db.query<{ container_disk_gb: number }>(
			'SELECT container_disk_gb FROM projects WHERE id = $1',
			[projectId],
		);
		expect(row.rows[0].container_disk_gb).toBe(8);

		await expect(
			h.db.query('UPDATE projects SET container_disk_gb = 1 WHERE id = $1', [projectId]),
		).rejects.toThrow();
		// The rejected write left the accepted one intact.
		const after = await h.db.query<{ container_disk_gb: number }>(
			'SELECT container_disk_gb FROM projects WHERE id = $1',
			[projectId],
		);
		expect(after.rows[0].container_disk_gb).toBe(8);
	});

	it('preserves the pre-existing member, its usage, and the ceiling it was judged against', async () => {
		const row = await h.db.query<{
			container_id: string;
			disk_used_bytes: string;
			disk_ceiling_bytes: string;
		}>(
			'SELECT container_id, disk_used_bytes, disk_ceiling_bytes FROM container_pool_members WHERE id = $1',
			[memberId],
		);
		expect(row.rows.length).toBe(1);
		expect(row.rows[0].container_id).toBe('ctr-existing');
		expect(Number(row.rows[0].disk_used_bytes)).toBe(1073741824);
		// The flat 2 GB it was provisioned under - deliberately NOT the ceiling a
		// newly-created container would get from the new 3 GB default.
		expect(Number(row.rows[0].disk_ceiling_bytes)).toBe(2 * 1024 ** 3);
	});

	it('leaves the new default meaningfully below the allocation', async () => {
		// The property the ceiling exists for: a container is recycled with room to
		// spare, so a run never discovers the wall partway through.
		const ceiling = poolDiskCeilingBytes(DEFAULT_CONTAINER_DISK_GB);
		expect(ceiling).toBeLessThan(DEFAULT_CONTAINER_DISK_GB * 1024 ** 3);
		expect(ceiling).toBeGreaterThan(0);
	});
});
