import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDataPreservationHarness, type DataPreservationHarness } from './helpers/migrate';

const TARGET = '041_run_log_chunks.sql';

describe('041_run_log_chunks migration', () => {
	let h: DataPreservationHarness;
	let teamId: string;
	let memberId: string;
	let loggedRunId: string;
	let emptyRunId: string;
	let compactedRunId: string;

	const LOGGED_TEXT = 'verbose log line 1\nverbose log line 2\n[done] succeeded';
	const COMPACTED_TEXT = '[log compacted]\n[done] succeeded';

	beforeAll(async () => {
		h = await createDataPreservationHarness();
		await h.applyUpToExclusive(TARGET); // schema at 040

		const team = await h.db.query<{ id: string }>(
			`INSERT INTO teams (name, slug) VALUES ('Acme', 'acme') RETURNING id`,
		);
		teamId = team.rows[0].id;
		const member = await h.db.query<{ id: string }>(
			`INSERT INTO members (team_id, member_type, display_name)
			 VALUES ($1, 'agent', 'Worker') RETURNING id`,
			[teamId],
		);
		memberId = member.rows[0].id;

		const logged = await h.db.query<{ id: string }>(
			`INSERT INTO heartbeat_runs (team_id, member_id, status, log_text, finished_at)
			 VALUES ($1, $2, 'succeeded'::heartbeat_run_status, $3, now()) RETURNING id`,
			[teamId, memberId, LOGGED_TEXT],
		);
		loggedRunId = logged.rows[0].id;

		const empty = await h.db.query<{ id: string }>(
			`INSERT INTO heartbeat_runs (team_id, member_id, status)
			 VALUES ($1, $2, 'queued'::heartbeat_run_status) RETURNING id`,
			[teamId, memberId],
		);
		emptyRunId = empty.rows[0].id;

		const compacted = await h.db.query<{ id: string }>(
			`INSERT INTO heartbeat_runs (team_id, member_id, status, log_text, finished_at, log_compacted_at)
			 VALUES ($1, $2, 'failed'::heartbeat_run_status, $3, now(), now()) RETURNING id`,
			[teamId, memberId, COMPACTED_TEXT],
		);
		compactedRunId = compacted.rows[0].id;

		await h.applyTarget(TARGET);
	});
	afterAll(() => h.close());

	it('creates the chunk table with the composite primary key', async () => {
		const cols = await h.db.query<{ column_name: string }>(
			`SELECT column_name FROM information_schema.columns
			 WHERE table_name = 'heartbeat_run_log_chunks' ORDER BY column_name`,
		);
		expect(cols.rows.map((r) => r.column_name)).toEqual(['content', 'created_at', 'run_id', 'seq']);
	});

	it('carries every non-empty legacy log over as a single seq-0 chunk', async () => {
		const chunk = await h.db.query<{ seq: number; content: string }>(
			`SELECT seq, content FROM heartbeat_run_log_chunks WHERE run_id = $1`,
			[loggedRunId],
		);
		expect(chunk.rows).toHaveLength(1);
		expect(chunk.rows[0].seq).toBe(0);
		expect(chunk.rows[0].content).toBe(LOGGED_TEXT);

		const compactedChunk = await h.db.query<{ content: string }>(
			`SELECT content FROM heartbeat_run_log_chunks WHERE run_id = $1`,
			[compactedRunId],
		);
		expect(compactedChunk.rows).toHaveLength(1);
		expect(compactedChunk.rows[0].content).toBe(COMPACTED_TEXT);
	});

	it('creates no chunk row for a run with an empty legacy log', async () => {
		const none = await h.db.query(`SELECT 1 FROM heartbeat_run_log_chunks WHERE run_id = $1`, [
			emptyRunId,
		]);
		expect(none.rows).toHaveLength(0);
	});

	it('drops the log_text column from heartbeat_runs', async () => {
		const cols = await h.db.query<{ c: number }>(
			`SELECT COUNT(*)::int AS c FROM information_schema.columns
			 WHERE table_name = 'heartbeat_runs' AND column_name = 'log_text'`,
		);
		expect(cols.rows[0].c).toBe(0);
	});

	it('preserves the run rows themselves (status, compaction stamp intact)', async () => {
		const rows = await h.db.query<{ id: string; status: string; log_compacted_at: string | null }>(
			`SELECT id, status, log_compacted_at FROM heartbeat_runs WHERE team_id = $1 ORDER BY created_at`,
			[teamId],
		);
		expect(rows.rows).toHaveLength(3);
		expect(rows.rows.map((r) => r.id)).toEqual([loggedRunId, emptyRunId, compactedRunId]);
		expect(rows.rows[0].log_compacted_at).toBeNull();
		expect(rows.rows[2].log_compacted_at).not.toBeNull();
	});

	it('reads a run log back by concatenating chunks in seq order', async () => {
		await h.db.query(
			`INSERT INTO heartbeat_run_log_chunks (run_id, seq, content) VALUES ($1, 1, $2)`,
			[loggedRunId, '\nlater delta'],
		);
		const text = await h.db.query<{ log_text: string }>(
			`SELECT COALESCE(string_agg(content, '' ORDER BY seq), '') AS log_text
			 FROM heartbeat_run_log_chunks WHERE run_id = $1`,
			[loggedRunId],
		);
		expect(text.rows[0].log_text).toBe(`${LOGGED_TEXT}\nlater delta`);
	});

	it('cascades chunk deletion when the run row is deleted', async () => {
		await h.db.query(`DELETE FROM heartbeat_runs WHERE id = $1`, [compactedRunId]);
		const gone = await h.db.query(`SELECT 1 FROM heartbeat_run_log_chunks WHERE run_id = $1`, [
			compactedRunId,
		]);
		expect(gone.rows).toHaveLength(0);
	});
});
