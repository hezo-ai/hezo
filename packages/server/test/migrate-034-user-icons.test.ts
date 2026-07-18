import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDataPreservationHarness, type DataPreservationHarness } from './helpers/migrate';

const TARGET = '034_user_icons.sql';

describe('034_user_icons migration', () => {
	let h: DataPreservationHarness;
	let userId: string;

	beforeAll(async () => {
		h = await createDataPreservationHarness();
		await h.applyUpToExclusive(TARGET);

		const user = await h.db.query<{ id: string }>(
			`INSERT INTO users (display_name, is_superuser) VALUES ('Admin', true) RETURNING id`,
		);
		userId = user.rows[0].id;

		await h.applyTarget(TARGET);
	});
	afterAll(() => h.close());

	it('creates the user_icons table with the icon columns', async () => {
		const cols = await h.db.query<{ column_name: string }>(
			`SELECT column_name FROM information_schema.columns WHERE table_name = 'user_icons'`,
		);
		const names = cols.rows.map((r) => r.column_name).sort();
		expect(names).toEqual(
			['byte_size', 'content_type', 'data', 'height', 'updated_at', 'user_id', 'width'].sort(),
		);
	});

	it('preserves pre-existing user rows', async () => {
		const kept = await h.db.query(`SELECT 1 FROM users WHERE id = $1`, [userId]);
		expect(kept.rows.length).toBe(1);
	});

	it('stores and reads back icon bytes 1:1 with a user', async () => {
		const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x01, 0x02, 0x03]);
		await h.db.query(
			`INSERT INTO user_icons (user_id, content_type, data, byte_size, width, height)
			 VALUES ($1, 'image/png', $2, $3, 512, 512)`,
			[userId, bytes, bytes.byteLength],
		);
		const r = await h.db.query<{ data: Uint8Array; content_type: string }>(
			`SELECT data, content_type FROM user_icons WHERE user_id = $1`,
			[userId],
		);
		expect(r.rows[0].content_type).toBe('image/png');
		expect(Buffer.from(r.rows[0].data).equals(bytes)).toBe(true);
	});

	it('cascades icon deletion when the user is removed', async () => {
		await h.db.query(`DELETE FROM users WHERE id = $1`, [userId]);
		const r = await h.db.query(`SELECT 1 FROM user_icons WHERE user_id = $1`, [userId]);
		expect(r.rows.length).toBe(0);
	});
});
