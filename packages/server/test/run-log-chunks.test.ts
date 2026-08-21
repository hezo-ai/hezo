import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../src/db/database';
import {
	appendRunLogChunks,
	LEGACY_RUN_LOG_VACUUM_KEY,
	MAX_RUN_LOG_CHUNK_CHARS,
	readRunLogTail,
	readRunLogText,
	replaceRunLog,
	runLegacyRunLogVacuumOnce,
	runLogLengthSql,
	runLogStoredBytesSql,
	runLogTextSql,
} from '../src/db/run-log-chunks';
import { deleteSystemMeta, getSystemMeta } from '../src/lib/system-meta';
import { safeClose } from './helpers';
import { createTestDbWithMigrations } from './helpers/db';

let db: Db;
let teamId: string;
let memberId: string;

async function seedRun(): Promise<string> {
	const r = await db.query<{ id: string }>(
		`INSERT INTO heartbeat_runs (team_id, member_id, status)
		 VALUES ($1, $2, 'succeeded'::heartbeat_run_status) RETURNING id`,
		[teamId, memberId],
	);
	return r.rows[0].id;
}

beforeAll(async () => {
	db = await createTestDbWithMigrations();
	const team = await db.query<{ id: string }>(
		`INSERT INTO teams (name, slug) VALUES ('Chunks', 'chunks-test') RETURNING id`,
	);
	teamId = team.rows[0].id;
	const member = await db.query<{ id: string }>(
		`INSERT INTO members (team_id, member_type, display_name)
		 VALUES ($1, 'agent', 'Worker') RETURNING id`,
		[teamId],
	);
	memberId = member.rows[0].id;
});

afterAll(() => safeClose(db));

describe('appendRunLogChunks / readRunLogText', () => {
	it('appends deltas as sequential chunks and reads them back concatenated', async () => {
		const runId = await seedRun();
		await appendRunLogChunks(db, runId, 'first delta\n');
		await appendRunLogChunks(db, runId, 'second delta\n');
		await appendRunLogChunks(db, runId, ''); // empty append is a no-op

		expect(await readRunLogText(db, runId)).toBe('first delta\nsecond delta\n');
		const seqs = await db.query<{ seq: number }>(
			'SELECT seq FROM heartbeat_run_log_chunks WHERE run_id = $1 ORDER BY seq',
			[runId],
		);
		expect(seqs.rows.map((r) => r.seq)).toEqual([0, 1]);
	});

	it('splits an oversized delta at the chunk-size boundary', async () => {
		const runId = await seedRun();
		const oversized = 'a'.repeat(MAX_RUN_LOG_CHUNK_CHARS + 5);
		await appendRunLogChunks(db, runId, oversized);

		const chunks = await db.query<{ seq: number; len: number }>(
			`SELECT seq, length(content) AS len FROM heartbeat_run_log_chunks
			 WHERE run_id = $1 ORDER BY seq`,
			[runId],
		);
		expect(chunks.rows.map((r) => r.len)).toEqual([MAX_RUN_LOG_CHUNK_CHARS, 5]);
		expect(await readRunLogText(db, runId)).toBe(oversized);
	});

	it('reads an empty string for a run with no chunks', async () => {
		const runId = await seedRun();
		expect(await readRunLogText(db, runId)).toBe('');
	});
});

describe('SQL fragments', () => {
	it('runLogTextSql and runLogLengthSql compose into run queries', async () => {
		const runId = await seedRun();
		await appendRunLogChunks(db, runId, 'hello ');
		await appendRunLogChunks(db, runId, 'world');

		const r = await db.query<{ log_text: string; log_length: number; stored: string }>(
			`SELECT ${runLogTextSql('hr.id')} AS log_text,
			        ${runLogLengthSql('hr.id')} AS log_length,
			        ${runLogStoredBytesSql('hr.id')} AS stored
			 FROM heartbeat_runs hr WHERE hr.id = $1`,
			[runId],
		);
		expect(r.rows[0].log_text).toBe('hello world');
		expect(r.rows[0].log_length).toBe(11);
		expect(Number(r.rows[0].stored)).toBeGreaterThan(0);
	});

	it('reads empty text and zero length for a chunkless run', async () => {
		const runId = await seedRun();
		const r = await db.query<{ log_text: string; log_length: number }>(
			`SELECT ${runLogTextSql('hr.id')} AS log_text, ${runLogLengthSql('hr.id')} AS log_length
			 FROM heartbeat_runs hr WHERE hr.id = $1`,
			[runId],
		);
		expect(r.rows[0].log_text).toBe('');
		expect(r.rows[0].log_length).toBe(0);
	});
});

describe('replaceRunLog', () => {
	it('replaces all chunks with a single seq-0 chunk', async () => {
		const runId = await seedRun();
		await appendRunLogChunks(db, runId, 'one\n');
		await appendRunLogChunks(db, runId, 'two\n');
		await db.transaction((tx) => replaceRunLog(tx, runId, '[compacted]\n'));

		const chunks = await db.query<{ seq: number; content: string }>(
			'SELECT seq, content FROM heartbeat_run_log_chunks WHERE run_id = $1 ORDER BY seq',
			[runId],
		);
		expect(chunks.rows).toHaveLength(1);
		expect(chunks.rows[0].seq).toBe(0);
		expect(chunks.rows[0].content).toBe('[compacted]\n');
	});

	it('appends continue after a replace (seq resumes past 0)', async () => {
		const runId = await seedRun();
		await appendRunLogChunks(db, runId, 'log\n');
		await db.transaction((tx) => replaceRunLog(tx, runId, 'compacted\n'));
		await appendRunLogChunks(db, runId, 'more\n');
		expect(await readRunLogText(db, runId)).toBe('compacted\nmore\n');
	});
});

describe('runLegacyRunLogVacuumOnce', () => {
	it('embedded: vacuums once, sets the marker, and never re-runs', async () => {
		await deleteSystemMeta(db, LEGACY_RUN_LOG_VACUUM_KEY);
		let vacuums = 0;
		const origQuery = db.query.bind(db);
		// biome-ignore lint/suspicious/noExplicitAny: test-only spy
		(db as any).query = (sql: string, params?: unknown[]) => {
			if (sql.startsWith('VACUUM')) vacuums += 1;
			return origQuery(sql, params);
		};
		try {
			await runLegacyRunLogVacuumOnce(db, 'embedded');
			expect(vacuums).toBe(1);
			expect(await getSystemMeta(db, LEGACY_RUN_LOG_VACUUM_KEY)).not.toBeNull();

			await runLegacyRunLogVacuumOnce(db, 'embedded');
			expect(vacuums).toBe(1); // marker short-circuits
		} finally {
			// biome-ignore lint/suspicious/noExplicitAny: test-only spy
			(db as any).query = origQuery;
		}
	});

	it('external: sets the marker without vacuuming', async () => {
		await deleteSystemMeta(db, LEGACY_RUN_LOG_VACUUM_KEY);
		let vacuums = 0;
		const origQuery = db.query.bind(db);
		// biome-ignore lint/suspicious/noExplicitAny: test-only spy
		(db as any).query = (sql: string, params?: unknown[]) => {
			if (sql.startsWith('VACUUM')) vacuums += 1;
			return origQuery(sql, params);
		};
		try {
			await runLegacyRunLogVacuumOnce(db, 'external');
			expect(vacuums).toBe(0);
			expect(await getSystemMeta(db, LEGACY_RUN_LOG_VACUUM_KEY)).not.toBeNull();
		} finally {
			// biome-ignore lint/suspicious/noExplicitAny: test-only spy
			(db as any).query = origQuery;
		}
	});
});

describe('appendRunLogChunks usage stamping', () => {
	// The flush is one statement so it is atomic without a transaction — every
	// transaction block serializes process-wide on both drivers, and this runs
	// twice a second per live run.
	it('appends the delta and stamps the running usage in a single statement', async () => {
		const runId = await seedRun();
		await appendRunLogChunks(db, runId, 'streaming\n', {
			inputTokens: 120,
			outputTokens: 34,
			costCents: 7,
		});

		expect(await readRunLogText(db, runId)).toBe('streaming\n');
		const row = await db.query<{
			input_tokens: number;
			output_tokens: number;
			cost_cents: number;
			usage_partial: boolean;
		}>(
			'SELECT input_tokens, output_tokens, cost_cents, usage_partial FROM heartbeat_runs WHERE id = $1',
			[runId],
		);
		expect(row.rows[0]).toMatchObject({
			input_tokens: 120,
			output_tokens: 34,
			cost_cents: 7,
			usage_partial: true,
		});
	});

	// A capped-but-dirty stream still flushes so its usage snapshot keeps landing.
	it('stamps usage with no delta, and leaves the log untouched', async () => {
		const runId = await seedRun();
		await appendRunLogChunks(db, runId, 'only line\n');
		await appendRunLogChunks(db, runId, '', { inputTokens: 5, outputTokens: 6, costCents: 1 });

		expect(await readRunLogText(db, runId)).toBe('only line\n');
		const row = await db.query<{ input_tokens: number; usage_partial: boolean }>(
			'SELECT input_tokens, usage_partial FROM heartbeat_runs WHERE id = $1',
			[runId],
		);
		expect(row.rows[0]).toMatchObject({ input_tokens: 5, usage_partial: true });
	});

	it('stamps the cache split alongside the running usage', async () => {
		const runId = await seedRun();
		await appendRunLogChunks(db, runId, 'streaming\n', {
			inputTokens: 9000,
			outputTokens: 120,
			costCents: 4,
			cacheReadTokens: 7500,
			cacheCreationTokens: 400,
		});
		const row = await db.query<{
			input_tokens: string | number;
			cache_read_tokens: string | number | null;
			cache_creation_tokens: string | number | null;
			usage_partial: boolean;
		}>(
			`SELECT input_tokens, cache_read_tokens, cache_creation_tokens, usage_partial
			 FROM heartbeat_runs WHERE id = $1`,
			[runId],
		);
		// The whole reason the split is flushed rather than only stamped at the end:
		// a run killed mid-flight keeps an auditable cost instead of a bare sum.
		expect(Number(row.rows[0].input_tokens)).toBe(9000);
		expect(Number(row.rows[0].cache_read_tokens)).toBe(7500);
		expect(Number(row.rows[0].cache_creation_tokens)).toBe(400);
		expect(row.rows[0].usage_partial).toBe(true);
	});

	it('leaves an already-stamped split alone when a later flush carries none', async () => {
		const runId = await seedRun();
		await appendRunLogChunks(db, runId, 'a\n', {
			inputTokens: 100,
			outputTokens: 10,
			costCents: 1,
			cacheReadTokens: 60,
			cacheCreationTokens: 5,
		});
		// A runtime that stops reporting a split must not erase the one already
		// recorded - that is what the COALESCE in the statement is for.
		await appendRunLogChunks(db, runId, 'b\n', {
			inputTokens: 200,
			outputTokens: 20,
			costCents: 2,
		});
		const row = await db.query<{
			input_tokens: string | number;
			cache_read_tokens: string | number | null;
		}>(`SELECT input_tokens, cache_read_tokens FROM heartbeat_runs WHERE id = $1`, [runId]);
		expect(Number(row.rows[0].input_tokens)).toBe(200);
		expect(Number(row.rows[0].cache_read_tokens)).toBe(60);
	});

	it('keeps seq monotonic across many appends, including oversized ones', async () => {
		const runId = await seedRun();
		await appendRunLogChunks(db, runId, 'a\n');
		await appendRunLogChunks(db, runId, 'b'.repeat(MAX_RUN_LOG_CHUNK_CHARS + 10));
		await appendRunLogChunks(db, runId, 'c\n', {
			inputTokens: 1,
			outputTokens: 1,
			costCents: 0,
		});

		const seqs = await db.query<{ seq: number }>(
			'SELECT seq FROM heartbeat_run_log_chunks WHERE run_id = $1 ORDER BY seq',
			[runId],
		);
		expect(seqs.rows.map((r) => r.seq)).toEqual([0, 1, 2, 3]);
		const text = await readRunLogText(db, runId);
		expect(text.startsWith('a\n')).toBe(true);
		expect(text.endsWith('c\n')).toBe(true);
	});
});

describe('readRunLogTail', () => {
	it('returns only the tail, with the full length alongside', async () => {
		const runId = await seedRun();
		for (let i = 0; i < 200; i++) await appendRunLogChunks(db, runId, `line ${i}\n`);
		const whole = await readRunLogText(db, runId);

		const tail = await readRunLogTail(db, runId, 50);
		expect(tail.text).toBe(whole.slice(whole.length - 50));
		expect(tail.length).toBe(whole.length);
		expect(tail.truncated).toBe(true);
	});

	it('returns the whole log, untruncated, when it fits the budget', async () => {
		const runId = await seedRun();
		await appendRunLogChunks(db, runId, 'short\n');

		const tail = await readRunLogTail(db, runId, 1_000);
		expect(tail).toEqual({ text: 'short\n', length: 6, truncated: false });
	});

	it('reports an empty log without reading chunks', async () => {
		const runId = await seedRun();
		expect(await readRunLogTail(db, runId, 100)).toEqual({
			text: '',
			length: 0,
			truncated: false,
		});
	});

	// The widening loop only matters when the tail budget spans more chunks than
	// the first page reads; many small chunks is exactly that case.
	it('widens its read until the budget is covered across many small chunks', async () => {
		const runId = await seedRun();
		for (let i = 0; i < 300; i++) await appendRunLogChunks(db, runId, 'x'.repeat(20));
		const whole = await readRunLogText(db, runId);

		const tail = await readRunLogTail(db, runId, 4_000);
		expect(tail.text).toBe(whole.slice(whole.length - 4_000));
		expect(tail.length).toBe(whole.length);
	});
});
