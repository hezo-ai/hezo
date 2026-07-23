import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../src/db/database';
import {
	appendRunLogChunks,
	LEGACY_RUN_LOG_VACUUM_KEY,
	MAX_RUN_LOG_CHUNK_CHARS,
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
