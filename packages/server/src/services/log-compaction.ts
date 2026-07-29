/**
 * Agent run-log compaction — retention trimming of old runs' logs. Run logs
 * live in the append-only `heartbeat_run_log_chunks` table (one INSERT per
 * flush, concatenated on read — see src/db/run-log-chunks.ts), kept forever.
 * Compaction trims the logs of old, finished runs down to the part that still
 * matters (the agent's end-of-run summary and the trailing
 * `[done] … tokens=… cost=…` line, both at the *end* of the log), keeps the
 * command that launched the run and a clear "compacted" notice, stamps
 * `log_compacted_at`, and — on the embedded backend — runs a `VACUUM (FULL)`
 * at the end of the pass so the on-disk size actually drops (compaction's
 * chunk DELETEs, and the flusher's small per-flush usage UPDATEs on
 * `heartbeat_runs`, leave dead tuples PGlite has no autovacuum daemon to
 * reuse).
 *
 * The work is incremental: a manual trigger writes the `log_compaction:active`
 * marker (with the chosen retention window), and the `log-compaction` cron job
 * drains the backlog a batch at a time, then reclaims space and clears the
 * marker. The marker doubles as the "compaction in progress" flag the DB panel
 * disables its button on.
 */

import {
	DEFAULT_LOG_COMPACTION_RETENTION_DAYS,
	LOG_COMPACTION_PRESERVED_TAIL_BYTES,
	LOG_COMPACTION_RETENTION_MAX_DAYS,
	LOG_COMPACTION_RETENTION_MIN_DAYS,
} from '@hezo/shared';
import type { Db } from '../db/database';
import {
	readRunLogTail,
	replaceRunLog,
	runLogLengthSql,
	runLogStoredBytesSql,
} from '../db/run-log-chunks';
import type { StorageBackend } from '../lib/db-info';
import { deleteSystemMeta, getSystemMeta, setSystemMeta } from '../lib/system-meta';
import { logger } from '../logger';

const log = logger.child('log-compaction');

export const LOG_COMPACTION_ACTIVE_KEY = 'log_compaction:active';
export const LOG_COMPACTION_LAST_KEY = 'log_compaction:last';

/** Rows compacted per batch. Each run commits on its own - see compactRunLogsBatch. */
const LOG_COMPACTION_BATCH = Number(process.env.HEZO_LOG_COMPACTION_BATCH ?? 50);
/** Upper bound on rows a single cron tick processes before yielding to the next. */
const LOG_COMPACTION_MAX_PER_TICK = Number(process.env.HEZO_LOG_COMPACTION_MAX_PER_TICK ?? 500);
/** Trailing bytes of each old log kept (summary + outcome). Deploy-time tunable. */
const PRESERVED_BYTES = Number(
	process.env.HEZO_LOG_COMPACTION_PRESERVED_BYTES ?? LOG_COMPACTION_PRESERVED_TAIL_BYTES,
);
/**
 * A log is worth compacting once its stored (compressed) size crosses Postgres's
 * ~2KB TOAST threshold — below that the whole log fits in line and trimming it
 * saves nothing worth a rewrite. Filtering on summed `pg_column_size` (the
 * stored size) rather than `length` avoids detoasting every chunk just to
 * decide.
 */
const TOAST_THRESHOLD_BYTES = 2000;

const TERMINAL_STATUS_SQL = "('succeeded','failed','cancelled','timed_out')";

/**
 * Clamp a requested retention window to the allowed range. Exported so the route
 * validates with the same bounds the drain enforces (a stale/out-of-range value
 * can never widen or invert the window).
 */
export function clampRetentionDays(value: number): number {
	if (!Number.isFinite(value)) return DEFAULT_LOG_COMPACTION_RETENTION_DAYS;
	return Math.min(
		LOG_COMPACTION_RETENTION_MAX_DAYS,
		Math.max(LOG_COMPACTION_RETENTION_MIN_DAYS, Math.round(value)),
	);
}

export interface CompactionState {
	/** ISO timestamp the pass started. */
	started_at: string;
	older_than_days: number;
	/** Runs that matched the window when the pass started (progress-bar denominator). */
	total: number;
	processed: number;
	/** Logical bytes trimmed so far (disk is returned by the VACUUM at the end). */
	bytes_reclaimed: number;
}

export interface LastCompaction {
	finished_at: string;
	older_than_days: number;
	processed: number;
	/** Actual on-disk bytes reclaimed (embedded, via VACUUM) or logical bytes trimmed. */
	bytes_reclaimed: number;
}

const COMPACTED_NOTICE = (date: string, hadCommand: boolean): string =>
	[
		'════════════════════════════════════════════════════════════',
		'  ⓘ THIS RUN LOG HAS BEEN COMPACTED',
		`  The full step-by-step output was trimmed on ${date} to reduce`,
		`  database size. Kept below:${hadCommand ? ' the command that launched this run,' : ''}`,
		hadCommand
			? "  and the final portion of the log (the run's summary and"
			: "  the final portion of the log (the run's summary and",
		'  outcome). The trimmed detail cannot be recovered.',
		'════════════════════════════════════════════════════════════',
	].join('\n');

/**
 * Build the compacted form of a run log: a clear "this log was compacted"
 * notice, the full agent CLI command that launched the run, then the trailing
 * slice of the original log (its summary + `[done]` line). Pure and
 * unit-testable. Returns the input unchanged when it is already at/under the
 * preserved size (nothing to trim), so it never grows a log.
 */
export function computeCompactedLog(
	logText: string,
	opts: {
		invocationCommand?: string | null;
		preservedBytes?: number;
		now?: Date;
		/**
		 * Length of the *whole* log when `logText` is only its tail. The batch
		 * reads a tail rather than the entire log (which reaches the 10 MB cap),
		 * so it must still be able to tell "already short enough" from "trimmed".
		 */
		originalLength?: number;
	} = {},
): string {
	const preserved = opts.preservedBytes ?? PRESERVED_BYTES;
	if ((opts.originalLength ?? logText.length) <= preserved) return logText;

	// Keep the trailing `preserved` chars, then advance past the first partial
	// line so the excerpt starts cleanly on a line boundary.
	let tail = logText.slice(logText.length - preserved);
	const firstNewline = tail.indexOf('\n');
	if (firstNewline >= 0 && firstNewline < tail.length - 1) {
		tail = tail.slice(firstNewline + 1);
	}

	const date = (opts.now ?? new Date()).toISOString().slice(0, 10);
	const command = opts.invocationCommand?.trim();
	const blocks = [COMPACTED_NOTICE(date, Boolean(command))];
	if (command) blocks.push(`$ ${command}`);
	blocks.push(tail);
	const compacted = blocks.join('\n\n');

	// Defensive: never grow a log (short logs with a long command). Only applies
	// when `logText` IS the whole log — when the caller passed a tail we already
	// know content was dropped, and returning it without the notice would present
	// a truncated log as if it were complete.
	if (opts.originalLength !== undefined) return compacted;
	return compacted.length < logText.length ? compacted : logText;
}

/**
 * Cheap database-usage figures for the DB panel — all metadata/counts, no
 * detoast, so it stays fast even while a pass polls it every couple seconds.
 * `databaseBytes` is embedded-only; `runLogDiskBytes` is the on-disk footprint
 * of the run tables — `heartbeat_runs` plus the log-chunk table (main + TOAST
 * + indexes + any bloat).
 */
export async function getDatabaseUsage(
	db: Db,
	backend: StorageBackend,
): Promise<{ databaseBytes: number | null; runLogDiskBytes: number; runCount: number }> {
	const counted = await db.query<{ run_count: string }>(
		'SELECT COUNT(*)::bigint AS run_count FROM heartbeat_runs',
	);
	const runLogDiskBytes = await scalarBytes(
		db,
		`SELECT (pg_total_relation_size('heartbeat_runs')
		       + pg_total_relation_size('heartbeat_run_log_chunks'))::bigint AS b`,
	);
	let databaseBytes: number | null = null;
	if (backend === 'embedded') {
		databaseBytes = await scalarBytes(
			db,
			'SELECT pg_database_size(current_database())::bigint AS b',
		);
	}
	return { databaseBytes, runLogDiskBytes, runCount: Number(counted.rows[0]?.run_count ?? 0) };
}

/** Run a single-column bigint size query, returning 0 if the function is unavailable. */
async function scalarBytes(db: Db, sql: string): Promise<number> {
	try {
		const r = await db.query<{ b: string }>(sql);
		return Number(r.rows[0]?.b ?? 0);
	} catch {
		return 0;
	}
}

/**
 * What a compaction pass over the given window would do: how many old runs get
 * trimmed, and how much disk it would reclaim. On the embedded backend the
 * reclaim is the chunk table's bloat (dead tuples from earlier compaction
 * DELETEs and any storage overhead) the pass's VACUUM returns, independent of
 * the window. On external Postgres nothing is VACUUMed (autovacuum reuses the
 * space), so it reports 0. The one full-table scan here runs only when idle
 * (never on the polling path).
 */
export async function getCompactionEstimate(
	db: Db,
	backend: StorageBackend,
	olderThanDays: number,
): Promise<{ runCount: number; reclaimableBytes: number }> {
	const counted = await db.query<{ c: string }>(
		`SELECT COUNT(*)::bigint AS c FROM heartbeat_runs hr
		 WHERE hr.log_compacted_at IS NULL
		   AND hr.status IN ${TERMINAL_STATUS_SQL}
		   AND ${runLogStoredBytesSql('hr.id')} > $1
		   AND hr.created_at < now() - ($2 || ' days')::interval`,
		[TOAST_THRESHOLD_BYTES, String(olderThanDays)],
	);
	const runCount = Number(counted.rows[0]?.c ?? 0);

	let reclaimableBytes = 0;
	if (backend === 'embedded') {
		try {
			const bloat = await db.query<{ bloat: string }>(
				`SELECT GREATEST(0, pg_total_relation_size('heartbeat_run_log_chunks')
				               - COALESCE(SUM(pg_column_size(content)), 0))::bigint AS bloat
				 FROM heartbeat_run_log_chunks`,
			);
			reclaimableBytes = Number(bloat.rows[0]?.bloat ?? 0);
		} catch {
			reclaimableBytes = 0;
		}
	}
	return { runCount, reclaimableBytes };
}

/**
 * Compact one batch of the oldest eligible runs, in a single transaction.
 * Returns how many rows were compacted and the logical bytes trimmed. A
 * `processed` of 0 means the backlog for this window is drained.
 */
export async function compactRunLogsBatch(
	db: Db,
	opts: { olderThanDays: number; limit?: number },
): Promise<{ processed: number; bytesReclaimed: number }> {
	const limit = opts.limit ?? LOG_COMPACTION_BATCH;
	// Ids and sizes only. This used to select each candidate's full `log_text`,
	// so one batch materialized up to 50 x 10 MB in a single result set purely to
	// keep a 12 KB tail from each.
	const rows = await db.query<{
		id: string;
		log_length: number;
		invocation_command: string | null;
	}>(
		`SELECT hr.id, ${runLogLengthSql('hr.id')} AS log_length, hr.invocation_command
		 FROM heartbeat_runs hr
		 WHERE hr.log_compacted_at IS NULL
		   AND hr.status IN ${TERMINAL_STATUS_SQL}
		   AND ${runLogStoredBytesSql('hr.id')} > $1
		   AND hr.created_at < now() - ($2 || ' days')::interval
		 ORDER BY hr.created_at ASC
		 LIMIT $3`,
		[TOAST_THRESHOLD_BYTES, String(opts.olderThanDays), limit],
	);
	if (rows.rows.length === 0) return { processed: 0, bytesReclaimed: 0 };

	let bytesReclaimed = 0;
	// One transaction per run, not one across the batch. Every transaction block
	// serializes process-wide on both drivers, so wrapping fifty rewrites in one
	// meant an operator's compaction pass stalled every agent and every request
	// for its whole duration. Per-run commits are still atomic where it matters
	// (a run's delete+insert), and a failure part-way leaves the remaining runs
	// for the next pass rather than rolling back the work already done.
	for (const row of rows.rows) {
		const tail = await readRunLogTail(db, row.id, PRESERVED_BYTES);
		const compacted = computeCompactedLog(tail.text, {
			invocationCommand: row.invocation_command,
			originalLength: row.log_length,
		});
		bytesReclaimed += Math.max(0, row.log_length - compacted.length);
		await db.transaction(async (tx) => {
			await replaceRunLog(tx, row.id, compacted);
			await tx.query(`UPDATE heartbeat_runs SET log_compacted_at = now() WHERE id = $1`, [row.id]);
		});
	}
	return { processed: rows.rows.length, bytesReclaimed };
}

export async function getActiveCompaction(db: Db): Promise<CompactionState | null> {
	return readJson<CompactionState>(db, LOG_COMPACTION_ACTIVE_KEY);
}

export async function getLastCompaction(db: Db): Promise<LastCompaction | null> {
	return readJson<LastCompaction>(db, LOG_COMPACTION_LAST_KEY);
}

async function readJson<T>(db: Db, key: string): Promise<T | null> {
	const raw = await getSystemMeta(db, key);
	if (!raw) return null;
	try {
		return JSON.parse(raw) as T;
	} catch {
		return null;
	}
}

/**
 * Begin a compaction pass: record the window + backlog size in the active
 * marker. The caller must have verified no pass is already active.
 */
export async function startCompaction(
	db: Db,
	opts: { olderThanDays: number; backend: StorageBackend },
): Promise<CompactionState> {
	const { runCount } = await getCompactionEstimate(db, opts.backend, opts.olderThanDays);
	const state: CompactionState = {
		started_at: new Date().toISOString(),
		older_than_days: opts.olderThanDays,
		total: runCount,
		processed: 0,
		bytes_reclaimed: 0,
	};
	await setSystemMeta(db, LOG_COMPACTION_ACTIVE_KEY, JSON.stringify(state));
	return state;
}

async function finishCompaction(db: Db, state: CompactionState): Promise<void> {
	const last: LastCompaction = {
		finished_at: new Date().toISOString(),
		older_than_days: state.older_than_days,
		processed: state.processed,
		bytes_reclaimed: state.bytes_reclaimed,
	};
	await setSystemMeta(db, LOG_COMPACTION_LAST_KEY, JSON.stringify(last));
	await deleteSystemMeta(db, LOG_COMPACTION_ACTIVE_KEY);
	log.info(
		`Compaction complete: ${state.processed} run(s), ~${Math.round(state.bytes_reclaimed / 1024)} KB reclaimed`,
	);
}

function runLogTableSize(db: Db): Promise<number> {
	return scalarBytes(
		db,
		`SELECT (pg_total_relation_size('heartbeat_runs')
		       + pg_total_relation_size('heartbeat_run_log_chunks'))::bigint AS b`,
	);
}

/**
 * Reclaim the disk freed by trimming logs (and the dead-tuple bloat around it).
 * On the embedded database a `VACUUM (FULL)` rewrites the tables and returns
 * space to the OS so the DB size actually drops; on external Postgres it is left
 * to autovacuum (a VACUUM FULL there takes a heavy lock the operator did not ask
 * for). Both run-log tables are vacuumed: the chunk table (compaction's chunk
 * DELETEs) and `heartbeat_runs` itself (the flusher's per-flush usage UPDATEs).
 * Returns the on-disk bytes actually freed. Best-effort: a VACUUM failure is
 * logged, not fatal — the logs are already trimmed.
 */
export async function reclaimRunLogSpace(db: Db, backend: StorageBackend): Promise<number> {
	if (backend !== 'embedded') return 0;
	const before = await runLogTableSize(db);
	for (const table of ['heartbeat_run_log_chunks', 'heartbeat_runs']) {
		try {
			await db.query(`VACUUM (FULL, ANALYZE) ${table}`);
		} catch (fullErr) {
			try {
				await db.query(`VACUUM (ANALYZE) ${table}`);
			} catch (plainErr) {
				log.warn(`VACUUM of ${table} after compaction failed; space stays unreclaimed`, {
					fullError: fullErr instanceof Error ? fullErr.message : String(fullErr),
					plainError: plainErr instanceof Error ? plainErr.message : String(plainErr),
				});
			}
		}
	}
	const after = await runLogTableSize(db);
	return Math.max(0, before - after);
}

/**
 * One cron tick of the drain loop. No-op unless a pass is active. Processes up
 * to `LOG_COMPACTION_MAX_PER_TICK` rows this tick (updating the progress marker
 * after each batch), then yields — the next tick continues where it left off.
 * When a batch drains the backlog, reclaims space (recording the real on-disk
 * bytes freed) and clears the marker.
 */
export async function runLogCompactionTick(
	db: Db,
	opts: { backend: StorageBackend; batchSize?: number; maxRunsPerTick?: number },
): Promise<void> {
	let state = await getActiveCompaction(db);
	if (!state) return;

	const batchSize = opts.batchSize ?? LOG_COMPACTION_BATCH;
	const maxRunsPerTick = opts.maxRunsPerTick ?? LOG_COMPACTION_MAX_PER_TICK;
	let processedThisTick = 0;

	while (processedThisTick < maxRunsPerTick) {
		const { processed, bytesReclaimed } = await compactRunLogsBatch(db, {
			olderThanDays: state.older_than_days,
			limit: batchSize,
		});
		if (processed === 0) {
			const freed = await reclaimRunLogSpace(db, opts.backend);
			// On embedded the VACUUM delta is the true disk reclaim (it captures the
			// dead-tuple bloat, far larger than the trimmed live text); on external
			// there is no VACUUM, so the logical trim total stands.
			const finalReclaimed = opts.backend === 'embedded' ? freed : state.bytes_reclaimed;
			await finishCompaction(db, { ...state, bytes_reclaimed: finalReclaimed });
			return;
		}
		processedThisTick += processed;
		state = {
			...state,
			processed: state.processed + processed,
			bytes_reclaimed: state.bytes_reclaimed + bytesReclaimed,
		};
		await setSystemMeta(db, LOG_COMPACTION_ACTIVE_KEY, JSON.stringify(state));
	}
}
