/**
 * Append-only run-log chunk storage (`heartbeat_run_log_chunks`). A run's log
 * is a sequence of ordered text chunks: the streaming flusher INSERTs only the
 * delta appended since the last successful flush, and readers concatenate with
 * `string_agg(content ORDER BY seq)`. INSERT-only writes leave no dead TOAST
 * copies behind, unlike the old whole-blob `UPDATE heartbeat_runs.log_text`
 * pattern that wrote O(n²) bytes over a run's lifetime.
 *
 * Every SQL surface that used to read `hr.log_text` now embeds the fragments
 * built here, keeping the wire shape (a `log_text` string) unchanged.
 */

import type { StorageBackend } from '../lib/db-info';
import { getSystemMeta, setSystemMeta } from '../lib/system-meta';
import { logger } from '../logger';
import type { Db, Queryable } from './database';

const log = logger.child('run-log-chunks');

/**
 * Upper bound on a single chunk row's content. A normal debounced flush is a
 * few KB; this only bites on pathological bursts, keeping any one row far
 * below the ~16MB single-protocol-message limit embedded PGlite can crash on
 * (see db/logical-backup.ts) and letting the byte-paged backup batch rows
 * sanely.
 */
export const MAX_RUN_LOG_CHUNK_CHARS = 1_000_000;

/**
 * SQL fragment: the run's full log text, concatenated from its chunks. The
 * COALESCE mirrors the old column's `NOT NULL DEFAULT ''` — a run with no
 * chunks reads as the empty string, never NULL.
 */
export function runLogTextSql(runIdExpr = 'hr.id'): string {
	return `(SELECT COALESCE(string_agg(c.content, '' ORDER BY c.seq), '')
		FROM heartbeat_run_log_chunks c WHERE c.run_id = ${runIdExpr})`;
}

/**
 * SQL fragment: the run's total log length in characters. `::int` keeps the
 * JSON serialization a number — a bare int8 SUM comes back as a string.
 */
export function runLogLengthSql(runIdExpr = 'hr.id'): string {
	return `COALESCE((SELECT SUM(length(c.content))::int
		FROM heartbeat_run_log_chunks c WHERE c.run_id = ${runIdExpr}), 0)`;
}

/**
 * SQL fragment: the run's stored (compressed, on-disk) log size in bytes,
 * summed over its chunks. The compaction pass filters on this — cheap, no
 * detoast of the content itself.
 */
export function runLogStoredBytesSql(runIdExpr = 'hr.id'): string {
	return `COALESCE((SELECT SUM(pg_column_size(c.content))::bigint
		FROM heartbeat_run_log_chunks c WHERE c.run_id = ${runIdExpr}), 0)`;
}

/** Read one run's full log text (concatenated chunks). */
export async function readRunLogText(q: Queryable, runId: string): Promise<string> {
	const r = await q.query<{ log_text: string }>(
		`SELECT COALESCE(string_agg(content, '' ORDER BY seq), '') AS log_text
		 FROM heartbeat_run_log_chunks WHERE run_id = $1`,
		[runId],
	);
	return r.rows[0]?.log_text ?? '';
}

/** The running token/cost snapshot a mid-run flush carries alongside its delta. */
export interface RunUsageSnapshot {
	inputTokens: number | null;
	outputTokens: number | null;
	costCents: number | null;
}

/**
 * Append `text` to a run's log as one or more chunk rows (split at
 * `MAX_RUN_LOG_CHUNK_CHARS`), optionally stamping the run's running usage in
 * the same breath.
 *
 * **One statement, deliberately.** This runs on every debounced flush — twice a
 * second per live run — and used to be three statements (a `MAX(seq)` probe, an
 * INSERT per chunk, an `UPDATE heartbeat_runs`) wrapped in a transaction. Both
 * drivers serialize *every* transaction block process-wide (PGlite holds the
 * engine lock; the Postgres driver queues blocks through `txQueue` for parity),
 * so at ten concurrent runs that was ~20 globally-serialized transactions a
 * second sitting in front of every user request. A single statement is atomic on
 * its own, which is all the broker's exactly-once delta contract needs: on
 * failure nothing lands and the identical delta is re-sent.
 *
 * Sequence numbers still come from the stored maximum rather than an in-memory
 * counter, so appends survive a process restart; the single-writer-per-run
 * guarantee (the broker serializes flushes per stream) makes MAX+1 race-free.
 * Data-modifying CTEs run exactly once and to completion whether or not the
 * primary query reads them, so the INSERT happens even though the UPDATE is the
 * statement's visible result.
 */
export async function appendRunLogChunks(
	q: Queryable,
	runId: string,
	text: string,
	usage?: RunUsageSnapshot | null,
): Promise<void> {
	const chunks: string[] = [];
	for (let offset = 0; offset < text.length; offset += MAX_RUN_LOG_CHUNK_CHARS) {
		chunks.push(text.slice(offset, offset + MAX_RUN_LOG_CHUNK_CHARS));
	}
	if (chunks.length === 0 && !usage) return;

	const insertCte = `WITH base AS (
			SELECT COALESCE(MAX(seq), -1) + 1 AS start
			FROM heartbeat_run_log_chunks WHERE run_id = $1
		), ins AS (
			INSERT INTO heartbeat_run_log_chunks (run_id, seq, content)
			SELECT $1, base.start + (t.ord - 1)::int, t.content
			FROM base, unnest($2::text[]) WITH ORDINALITY AS t(content, ord)
		)`;
	const usageUpdate = `UPDATE heartbeat_runs
		 SET input_tokens = COALESCE($3, input_tokens),
		     output_tokens = COALESCE($4, output_tokens),
		     cost_cents = COALESCE($5, cost_cents),
		     usage_partial = true
		 WHERE id = $1`;

	if (chunks.length > 0 && usage) {
		await q.query(`${insertCte} ${usageUpdate}`, [
			runId,
			chunks,
			usage.inputTokens,
			usage.outputTokens,
			usage.costCents,
		]);
		return;
	}
	if (chunks.length > 0) {
		// `SELECT 1` keeps the CTE's shape without a second write.
		await q.query(`${insertCte} SELECT 1`, [runId, chunks]);
		return;
	}
	// Usage-only flush: a capped-but-dirty stream still reports its snapshot.
	await q.query(
		`UPDATE heartbeat_runs
		 SET input_tokens = COALESCE($2, input_tokens),
		     output_tokens = COALESCE($3, output_tokens),
		     cost_cents = COALESCE($4, cost_cents),
		     usage_partial = true
		 WHERE id = $1`,
		[runId, usage?.inputTokens ?? null, usage?.outputTokens ?? null, usage?.costCents ?? null],
	);
}

/**
 * The last `maxChars` characters of a run's log, plus its full length.
 *
 * Reads only the chunks it needs. Every caller that wants a tail — the
 * `get_run_log` tool, the task's latest-run view, the orphan detector's failure
 * excerpt — used to `string_agg` the whole log (up to the 10 MB cap) and then
 * `slice` the last few KB off it in JS, detoasting and shipping megabytes to
 * discard almost all of them.
 */
export async function readRunLogTail(
	q: Queryable,
	runId: string,
	maxChars: number,
): Promise<{ text: string; length: number; truncated: boolean }> {
	const total = await q.query<{ len: number }>(
		`SELECT COALESCE(SUM(length(content))::int, 0) AS len
		 FROM heartbeat_run_log_chunks WHERE run_id = $1`,
		[runId],
	);
	const length = Number(total.rows[0]?.len ?? 0);
	if (length === 0) return { text: '', length: 0, truncated: false };

	// Walk back from the newest chunk until the budget is covered. Chunks are a
	// few KB on a normal flush, so this is a handful of rows even for a big log;
	// the widening loop only matters for pathological chunk sizes.
	let limit = 32;
	for (;;) {
		const r = await q.query<{ content: string }>(
			`SELECT content FROM heartbeat_run_log_chunks
			 WHERE run_id = $1 ORDER BY seq DESC LIMIT $2`,
			[runId, limit],
		);
		const rows = r.rows;
		const read = rows.reduce((n, row) => n + row.content.length, 0);
		const reachedStart = rows.length < limit;
		if (read >= maxChars || reachedStart) {
			const text = rows
				.map((row) => row.content)
				.reverse()
				.join('');
			return {
				text: text.length > maxChars ? text.slice(text.length - maxChars) : text,
				length,
				truncated: length > maxChars,
			};
		}
		limit *= 4;
	}
}

/**
 * Replace a run's entire log with a single seq-0 chunk (compaction). Only ever
 * called for terminal runs, so no live flusher can collide with the sequence
 * reset. Run inside the caller's transaction so the delete+insert is atomic.
 */
export async function replaceRunLog(tx: Queryable, runId: string, content: string): Promise<void> {
	await tx.query('DELETE FROM heartbeat_run_log_chunks WHERE run_id = $1', [runId]);
	await tx.query('INSERT INTO heartbeat_run_log_chunks (run_id, seq, content) VALUES ($1, 0, $2)', [
		runId,
		content,
	]);
}

export const LEGACY_RUN_LOG_VACUUM_KEY = 'run_log_chunks:legacy_vacuum_done';

/**
 * One-time reclaim of the disk space the pre-chunk write pattern left behind.
 * Migration 041 drops `heartbeat_runs.log_text`, but a column drop is
 * metadata-only — the dead TOAST graveyard (routinely ~98% of the table's
 * on-disk size) stays until a VACUUM FULL rewrites the table. Runs once per
 * instance, marker-gated: on the embedded backend it VACUUMs `heartbeat_runs`
 * (with a plain-VACUUM fallback, same posture as reclaimRunLogSpace); on
 * external Postgres it only sets the marker — a VACUUM FULL takes an exclusive
 * lock the operator did not ask for, and autovacuum reuses the space. The
 * marker is set only after success so a failed attempt retries next boot.
 */
export async function runLegacyRunLogVacuumOnce(
	db: Db,
	backend: StorageBackend,
	options: {
		/**
		 * Called once the reclaim is committed to running (past the marker check,
		 * embedded only). Startup uses it to name the step on the loading screen -
		 * a VACUUM FULL over a multi-GB table would otherwise look like a hang.
		 */
		onStart?: () => void;
	} = {},
): Promise<void> {
	const done = await getSystemMeta(db, LEGACY_RUN_LOG_VACUUM_KEY);
	if (done !== null) return;
	if (backend === 'embedded') {
		options.onStart?.();
		const before = await relationBytes(db);
		try {
			await db.query('VACUUM (FULL, ANALYZE) heartbeat_runs');
		} catch (fullErr) {
			try {
				await db.query('VACUUM (ANALYZE) heartbeat_runs');
			} catch (plainErr) {
				log.warn('One-time legacy run-log VACUUM failed; will retry next startup', {
					fullError: fullErr instanceof Error ? fullErr.message : String(fullErr),
					plainError: plainErr instanceof Error ? plainErr.message : String(plainErr),
				});
				return;
			}
		}
		const after = await relationBytes(db);
		log.info(
			`One-time reclaim of legacy run-log space: freed ~${Math.max(0, Math.round((before - after) / 1024))} KB`,
		);
	}
	await setSystemMeta(db, LEGACY_RUN_LOG_VACUUM_KEY, new Date().toISOString());
}

async function relationBytes(db: Db): Promise<number> {
	try {
		const r = await db.query<{ b: string }>(
			`SELECT pg_total_relation_size('heartbeat_runs')::bigint AS b`,
		);
		return Number(r.rows[0]?.b ?? 0);
	} catch {
		return 0;
	}
}
