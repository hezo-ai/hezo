import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDataPreservationHarness, type DataPreservationHarness } from './helpers/migrate';

const TARGET = '050_container_memory_budget.sql';

/**
 * Capacity moves from a container count to a memory budget.
 *
 * The interesting part is the carry-forward, not the key rename: an operator who
 * deliberately capped the fleet expressed that in containers, and dropping the
 * key would silently hand their instance the computed default instead. N
 * containers at the effective per-container cap is N x cap GB, so their intent
 * survives the change of unit.
 */
describe('050_container_memory_budget migration', () => {
	let h: DataPreservationHarness;

	const meta = async (key: string): Promise<string | null> => {
		const r = await h.db.query<{ value: string }>(`SELECT value FROM system_meta WHERE key = $1`, [
			key,
		]);
		return r.rows[0]?.value ?? null;
	};

	beforeAll(async () => {
		h = await createDataPreservationHarness();
		await h.applyUpToExclusive(TARGET);
		await h.db.query(
			`INSERT INTO system_meta (key, value) VALUES
			   ('max_active_containers', '3'),
			   ('default_ram_cap_per_container_gb', '4'),
			   ('instance_locale', 'de')`,
		);
		await h.applyTarget(TARGET);
	});
	afterAll(() => h.close());

	it('converts an explicit container count into the equivalent memory budget', async () => {
		// 3 containers x 4 GB each is the same fleet, expressed in the new unit.
		expect(await meta('max_container_memory_gb')).toBe('12');
	});

	it('removes the superseded key so no stale number looks authoritative', async () => {
		expect(await meta('max_active_containers')).toBeNull();
	});

	it('leaves the per-container cap and unrelated settings untouched', async () => {
		expect(await meta('default_ram_cap_per_container_gb')).toBe('4');
		expect(await meta('instance_locale')).toBe('de');
	});
});

describe('050_container_memory_budget migration on an instance that never set a cap', () => {
	let h: DataPreservationHarness;

	beforeAll(async () => {
		h = await createDataPreservationHarness();
		await h.applyUpToExclusive(TARGET);
		await h.db.query(`INSERT INTO system_meta (key, value) VALUES ('instance_locale', 'fr')`);
		await h.applyTarget(TARGET);
	});
	afterAll(() => h.close());

	it('writes no budget, so the computed default keeps applying', async () => {
		// Storing one here would freeze today's host memory into the settings
		// table, so an instance that later gains RAM would never notice.
		const r = await h.db.query<{ n: number }>(
			`SELECT count(*)::int AS n FROM system_meta WHERE key = 'max_container_memory_gb'`,
		);
		expect(r.rows[0].n).toBe(0);
	});

	it('preserves the settings that were there', async () => {
		const r = await h.db.query<{ value: string }>(
			`SELECT value FROM system_meta WHERE key = 'instance_locale'`,
		);
		expect(r.rows[0].value).toBe('fr');
	});
});
