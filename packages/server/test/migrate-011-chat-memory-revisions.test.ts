import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDataPreservationHarness, type DataPreservationHarness } from './helpers/migrate';

const TARGET = '072_chat_memory_revisions.sql';

describe('072_chat_memory_revisions migration', () => {
	let h: DataPreservationHarness;
	let ceoMemberId: string;
	let otherMemberId: string;

	beforeAll(async () => {
		h = await createDataPreservationHarness();
		await h.applyUpToExclusive(TARGET);

		const team = await h.db.query<{ id: string }>(
			`INSERT INTO teams (name, slug) VALUES ('HQ', 'hq-team') RETURNING id`,
		);
		const teamId = team.rows[0].id;

		const mk = async (name: string, slug: string) => {
			const m = await h.db.query<{ id: string }>(
				`INSERT INTO members (team_id, member_type, display_name)
				 VALUES ($1, 'agent', $2) RETURNING id`,
				[teamId, name],
			);
			await h.db.query(`INSERT INTO member_agents (id, title, slug) VALUES ($1, $2, $3)`, [
				m.rows[0].id,
				name,
				slug,
			]);
			return m.rows[0].id;
		};
		ceoMemberId = await mk('CEO', 'ceo');
		otherMemberId = await mk('Coach', 'coach');

		// Pre-existing long-term memory that must survive the migration untouched.
		await h.db.query(`INSERT INTO chat_memories (member_id, content) VALUES ($1, $2)`, [
			ceoMemberId,
			'operator deploys on Tuesdays and wants a plan before provisioning',
		]);
		await h.db.query(`INSERT INTO chat_memories (member_id, content) VALUES ($1, $2)`, [
			otherMemberId,
			'coach memory',
		]);

		await h.applyTarget(TARGET);
	});
	afterAll(() => h.close());

	it('creates chat_memory_revisions', async () => {
		const tbl = await h.db.query<{ c: number }>(
			`SELECT COUNT(*)::int AS c FROM information_schema.tables
			 WHERE table_name = 'chat_memory_revisions'`,
		);
		expect(tbl.rows[0].c).toBe(1);
	});

	// The point of the migration: existing memory is the thing being protected, so
	// it must come through byte-for-byte.
	it('preserves every pre-existing chat memory verbatim', async () => {
		const mem = await h.db.query<{ member_id: string; content: string }>(
			`SELECT member_id, content FROM chat_memories ORDER BY content`,
		);
		expect(mem.rows).toHaveLength(2);
		const byMember = new Map(mem.rows.map((r) => [r.member_id, r.content]));
		expect(byMember.get(ceoMemberId)).toBe(
			'operator deploys on Tuesdays and wants a plan before provisioning',
		);
		expect(byMember.get(otherMemberId)).toBe('coach memory');
	});

	it('claims no history that never existed', async () => {
		// Prior contents were never recorded, so backfilling a revision would invent
		// one. An untouched instance simply has no revisions yet.
		const revs = await h.db.query<{ c: number }>(
			`SELECT COUNT(*)::int AS c FROM chat_memory_revisions`,
		);
		expect(revs.rows[0].c).toBe(0);
	});

	it('takes revisions after the migration, scoped per member', async () => {
		await h.db.query(
			`INSERT INTO chat_memory_revisions (member_id, revision_number, content, change_summary)
			 VALUES ($1, 1, 'the version this replaced', 'compaction')`,
			[ceoMemberId],
		);
		await h.db.query(
			`INSERT INTO chat_memory_revisions (member_id, revision_number, content)
			 VALUES ($1, 1, 'coach prior')`,
			[otherMemberId],
		);

		const ceo = await h.db.query<{ content: string; change_summary: string }>(
			`SELECT content, change_summary FROM chat_memory_revisions WHERE member_id = $1`,
			[ceoMemberId],
		);
		expect(ceo.rows).toHaveLength(1);
		expect(ceo.rows[0].content).toBe('the version this replaced');
		expect(ceo.rows[0].change_summary).toBe('compaction');

		// Revision numbers restart per member, so two agents can both be at rev 1.
		const other = await h.db.query<{ c: number }>(
			`SELECT COUNT(*)::int AS c FROM chat_memory_revisions WHERE member_id = $1`,
			[otherMemberId],
		);
		expect(other.rows[0].c).toBe(1);
	});

	it('rejects a duplicate revision number for one member', async () => {
		await expect(
			h.db.query(
				`INSERT INTO chat_memory_revisions (member_id, revision_number, content)
				 VALUES ($1, 1, 'clashing')`,
				[ceoMemberId],
			),
		).rejects.toThrow();
	});

	it('drops an agent revisions with the member', async () => {
		await h.db.query(`DELETE FROM members WHERE id = $1`, [otherMemberId]);
		const left = await h.db.query<{ c: number }>(
			`SELECT COUNT(*)::int AS c FROM chat_memory_revisions WHERE member_id = $1`,
			[otherMemberId],
		);
		expect(left.rows[0].c).toBe(0);
	});
});
