import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDataPreservationHarness, type DataPreservationHarness } from './helpers/migrate';

const TARGET = '064_observed_message_sequence.sql';

describe('064_observed_message_sequence migration', () => {
	let h: DataPreservationHarness;
	const ids: Record<string, string> = {};

	beforeAll(async () => {
		h = await createDataPreservationHarness();
		await h.applyUpToExclusive(TARGET); // schema before 064

		// Three rows sharing one timestamp and one ordered after them. The tie is
		// the whole point: it is what `created_at` alone could not order, and it is
		// what a burst of messages produces on a real chat.
		const rows: [string, string, string][] = [
			['a', 'first', '2026-01-01 10:00:00Z'],
			['b', 'second', '2026-01-01 10:00:00Z'],
			['c', 'third', '2026-01-01 10:00:00Z'],
			['d', 'fourth', '2026-01-01 10:05:00Z'],
		];
		for (const [key, content, at] of rows) {
			const r = await h.db.query<{ id: string }>(
				`INSERT INTO chat_observed_messages
				   (channel, external_chat_id, sender_label, content, message_ts, created_at)
				 VALUES ('telegram'::chat_channel, '-1', 'Sender', $1, $2, $3::timestamptz)
				 RETURNING id`,
				[content, key, at],
			);
			ids[key] = r.rows[0].id;
		}

		await h.applyTarget(TARGET);
	});
	afterAll(() => h.close());

	it('adds the sequence column and its per-chat index', async () => {
		const col = await h.db.query<{ is_nullable: string; column_default: string | null }>(
			`SELECT is_nullable, column_default FROM information_schema.columns
			  WHERE table_name = 'chat_observed_messages' AND column_name = 'seq'`,
		);
		expect(col.rows.length).toBe(1);
		expect(col.rows[0].is_nullable).toBe('NO');
		expect(col.rows[0].column_default).toContain('nextval');

		const idx = await h.db.query<{ indexdef: string }>(
			`SELECT indexdef FROM pg_indexes WHERE indexname = 'idx_observed_messages_chat_seq'`,
		);
		expect(idx.rows.length).toBe(1);
		expect(idx.rows[0].indexdef.toLowerCase()).toContain('seq');
	});

	it('preserves every pre-existing row and its content', async () => {
		const kept = await h.db.query<{ id: string; content: string }>(
			`SELECT id, content FROM chat_observed_messages ORDER BY seq`,
		);
		expect(kept.rows.length).toBe(4);
		expect(kept.rows.map((r) => r.content).sort()).toEqual(['first', 'fourth', 'second', 'third']);
	});

	it('backfills a total order, with the later message last', async () => {
		const ordered = await h.db.query<{ id: string; seq: string }>(
			`SELECT id, seq::text AS seq FROM chat_observed_messages ORDER BY seq`,
		);
		// Every row got a distinct value - which `created_at` could not give, since
		// three of these four share one.
		const seqs = ordered.rows.map((r) => Number(r.seq));
		expect(new Set(seqs).size).toBe(4);
		// The unambiguously-newest row sorts last, so "keep the newest" is now a
		// question the data can answer.
		expect(ordered.rows.at(-1)?.id).toBe(ids.d);
	});

	it('hands a new row a value above every backfilled one', async () => {
		const before = await h.db.query<{ max: string }>(
			`SELECT MAX(seq)::text AS max FROM chat_observed_messages`,
		);
		const inserted = await h.db.query<{ seq: string }>(
			`INSERT INTO chat_observed_messages
			   (channel, external_chat_id, sender_label, content, message_ts)
			 VALUES ('telegram'::chat_channel, '-1', 'Sender', 'fifth', 'e')
			 RETURNING seq::text AS seq`,
		);
		expect(Number(inserted.rows[0].seq)).toBeGreaterThan(Number(before.rows[0].max));
	});
});
