import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDataPreservationHarness, type DataPreservationHarness } from './helpers/migrate';

const TARGET = '033_agent_icons.sql';

describe('033_agent_icons migration', () => {
	let h: DataPreservationHarness;
	let memberId: string;

	beforeAll(async () => {
		h = await createDataPreservationHarness();
		await h.applyUpToExclusive(TARGET);

		const team = await h.db.query<{ id: string }>(
			`INSERT INTO teams (name, slug) VALUES ('Acme', 'acme') RETURNING id`,
		);
		const member = await h.db.query<{ id: string }>(
			`INSERT INTO members (team_id, member_type, display_name)
			 VALUES ($1, 'agent', 'Engineer') RETURNING id`,
			[team.rows[0].id],
		);
		memberId = member.rows[0].id;
		await h.db.query(
			`INSERT INTO member_agents (id, title, slug) VALUES ($1, 'Engineer', 'engineer')`,
			[memberId],
		);

		await h.applyTarget(TARGET);
	});
	afterAll(() => h.close());

	it('creates the agent_icons table with the icon columns', async () => {
		const cols = await h.db.query<{ column_name: string }>(
			`SELECT column_name FROM information_schema.columns WHERE table_name = 'agent_icons'`,
		);
		const names = cols.rows.map((r) => r.column_name).sort();
		expect(names).toEqual(
			['byte_size', 'content_type', 'data', 'height', 'member_id', 'updated_at', 'width'].sort(),
		);
	});

	it('preserves pre-existing agent rows', async () => {
		const kept = await h.db.query(`SELECT 1 FROM member_agents WHERE id = $1`, [memberId]);
		expect(kept.rows.length).toBe(1);
	});

	it('stores and reads back icon bytes 1:1 with an agent', async () => {
		const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x01, 0x02, 0x03]);
		await h.db.query(
			`INSERT INTO agent_icons (member_id, content_type, data, byte_size, width, height)
			 VALUES ($1, 'image/png', $2, $3, 512, 512)`,
			[memberId, bytes, bytes.byteLength],
		);
		const r = await h.db.query<{ data: Uint8Array; content_type: string }>(
			`SELECT data, content_type FROM agent_icons WHERE member_id = $1`,
			[memberId],
		);
		expect(r.rows[0].content_type).toBe('image/png');
		expect(Buffer.from(r.rows[0].data).equals(bytes)).toBe(true);
	});

	it('cascades icon deletion when the agent is removed', async () => {
		await h.db.query(`DELETE FROM members WHERE id = $1`, [memberId]);
		const r = await h.db.query(`SELECT 1 FROM agent_icons WHERE member_id = $1`, [memberId]);
		expect(r.rows.length).toBe(0);
	});
});
