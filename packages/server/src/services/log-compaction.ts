/**
 * Agent run-log maintenance — retention trimming of old runs' logs, and
 * rewriting the run-log tables so the space inside them goes back to the disk.
 * Run logs live in the append-only `heartbeat_run_log_chunks` table (one INSERT
 * per flush, concatenated on read — see src/db/run-log-chunks.ts), kept forever.
 * Compaction trims the logs of old, finished runs down to the part that still
 * matters (the agent's end-of-run summary and the trailing
 * `[done] … tokens=… cost=…` line, both at the *end* of the log), keeps the
 * command that launched the run and a clear "compacted" notice, and stamps
 * `log_compacted_at`.
 *
 * Deleting rows never shrinks a table's files: Postgres keeps the space for
 * later rows. Only a rewrite (`VACUUM FULL`) returns it to the disk, and it
 * locks the table while it runs. On the embedded backend a compaction pass
 * always ends with that rewrite — PGlite has no autovacuum daemon, so without
 * it the freed space (and the dead tuples the flusher's per-flush usage UPDATEs
 * on `heartbeat_runs` leave) would never even be reused. On external Postgres
 * autovacuum makes the space reusable, and the lock also stalls anything else
 * using that server, so the rewrite runs only as its own `reclaim` pass, which
 * an operator starts explicitly.
 *
 * The work is incremental: a manual trigger writes the `log_compaction:active`
 * marker, and the `log-compaction` cron job drains it a batch at a time, then
 * (where it applies) rewrites the tables, records the pass in
 * `log_compaction:last` and clears the marker. The marker doubles as the "pass
 * in progress" flag the DB panel disables its buttons on.
 */

import {
	type ActiveRunLogPass,
	DEFAULT_LOG_COMPACTION_RETENTION_DAYS,
	type FinishedRunLogPass,
	LOG_COMPACTION_RETENTION_MAX_DAYS,
	LOG_COMPACTION_RETENTION_MIN_DAYS,
	RunLogPassKind,
	RunLogPassPhase,
	type RunLogRewriteFailure,
	RunLogRewriteFailureReason,
	type RunLogUsageFigures,
} from '@hezo/shared';
import { runtimeConfig } from '../config/runtime';
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

/**
 * The run-log tables. The size readout sums them and a rewrite covers both:
 * the chunk table holds the logs, and `heartbeat_runs` holds the flusher's
 * dead row versions plus, on an instance that predates the chunk table, its
 * dropped `log_text` column's data, which stays on disk until a rewrite.
 */
const RUN_LOG_TABLES = ['heartbeat_run_log_chunks', 'heartbeat_runs'] as const;

const RUN_LOG_BYTES_SQL = `SELECT (${RUN_LOG_TABLES.map((t) => `pg_total_relation_size('${t}')`).join(' + ')})::bigint AS b`;

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
 * How a rewrite asks for a table without queueing for it. A `VACUUM FULL`
 * waiting for its exclusive lock makes every later reader and writer of that
 * table queue behind it, so the whole app stalls for as long as whatever holds
 * the table (a long report, a backup) runs. `SKIP_LOCKED` returns at once
 * instead; the attempt is repeated a few times, since agent runs touch these
 * tables constantly but only for milliseconds at a time.
 */
const REWRITE_ATTEMPTS = 5;
const REWRITE_RETRY_MS = 1000;

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

/**
 * The stored active marker: the wire shape plus the usage read just before a
 * rewrite. While the rewrite holds a table's lock, reading that table's size
 * (or counting its rows) would wait for it, so the panel is served these
 * figures instead.
 */
export type CompactionState = ActiveRunLogPass & {
	usage_before_rewrite: RunLogUsageFigures | null;
};

export type LastCompaction = FinishedRunLogPass;

export interface RunLogRewriteResult {
	/** How much the tables' files shrank; covers the tables rewritten before any failure. */
	diskBytesFreed: number;
	failure: RunLogRewriteFailure | null;
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
	const preserved = opts.preservedBytes ?? runtimeConfig().logCompaction.preservedBytes;
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
 * `database_bytes` is embedded-only; `run_log_bytes` is the on-disk footprint
 * of both run-log tables (main + TOAST + indexes + free space).
 */
export async function getDatabaseUsage(
	db: Db,
	backend: StorageBackend,
): Promise<RunLogUsageFigures> {
	const counted = await db.query<{ run_count: number }>(
		'SELECT COUNT(*)::bigint AS run_count FROM heartbeat_runs',
	);
	const runLogBytes = await scalarBytes(db, RUN_LOG_BYTES_SQL);
	let databaseBytes: number | null = null;
	if (backend === 'embedded') {
		databaseBytes = await scalarBytes(
			db,
			'SELECT pg_database_size(current_database())::bigint AS b',
		);
	}
	return {
		database_bytes: databaseBytes,
		run_log_bytes: runLogBytes,
		run_count: Number(counted.rows[0]?.run_count ?? 0),
	};
}

/** Run a single-column bigint size query. */
async function scalarBytes(db: Db, sql: string): Promise<number> {
	const r = await db.query<{ b: number }>(sql);
	return Number(r.rows[0]?.b ?? 0);
}

/** Old, finished, large-enough runs a compaction over this window would trim. */
async function countCompactableRuns(db: Db, olderThanDays: number): Promise<number> {
	const counted = await db.query<{ c: number }>(
		`SELECT COUNT(*)::bigint AS c FROM heartbeat_runs hr
		 WHERE hr.log_compacted_at IS NULL
		   AND hr.status IN ${TERMINAL_STATUS_SQL}
		   AND ${runLogStoredBytesSql('hr.id')} > $1
		   AND hr.created_at < now() - ($2 || ' days')::interval`,
		[TOAST_THRESHOLD_BYTES, String(olderThanDays)],
	);
	return Number(counted.rows[0]?.c ?? 0);
}

/**
 * What the panel shows when no pass is running: how many runs a compaction over
 * the window would trim, and how much free space a rewrite would give back.
 * Both scan the run-log tables, so this runs only when idle (never on the
 * polling path).
 */
export async function getCompactionEstimate(
	db: Db,
	olderThanDays: number,
): Promise<{ runCount: number; freeBytes: number }> {
	const runCount = await countCompactableRuns(db, olderThanDays);
	const freeBytes = await estimateRunLogFreeBytes(db);
	return { runCount, freeBytes };
}

/**
 * Storage constants of an 8 KB-page Postgres (both PGlite and a stock server),
 * for {@link estimateRunLogFreeBytes}. A row costs a 24-byte header, a 4-byte
 * line pointer and some alignment padding on top of its column data. A row
 * over the TOAST threshold keeps an 18-byte pointer in place of its widest
 * value and stores that value in the TOAST table, in chunks of 1996 data bytes
 * that each carry about 40 bytes of their own overhead.
 */
const PAGE_BYTES = 8192;
const PAGE_USABLE_BYTES = 8168;
const ROW_OVERHEAD_BYTES = 32;
const TOAST_TUPLE_THRESHOLD_BYTES = 2032;
const TOAST_POINTER_BYTES = 18;
const TOAST_CHUNK_DATA_BYTES = 1996;
const TOAST_CHUNK_OVERHEAD_BYTES = 40;

/**
 * Free space below this share of the tables' data is reported as 0. The model
 * below lands within 6% of the size a real rewrite produced (measured on
 * Postgres 16 over log chunks from 300 B to 12 KB, and over a mix of short
 * chunks and compacted ones), so a smaller figure may be space that is not
 * there.
 */
const FREE_SPACE_NOISE_FLOOR = 0.1;

/**
 * Estimated free space inside the run-log tables' data (heap and TOAST): what
 * their files hold beyond what their live rows need, which a rewrite gives back
 * to the disk. Indexes are left out, so a rewrite usually returns somewhat more.
 *
 * No built-in function reports free space (`pgstattuple` is an optional
 * extension), so this models the size of each table as rewritten from its live
 * rows' stored column sizes. `pg_column_size` reads a TOASTed value's stored
 * size without fetching it. Columns are listed from the catalog on every call,
 * so a column added later is counted, and a dropped column's data, still on
 * disk in old rows until a rewrite, counts as free.
 */
export async function estimateRunLogFreeBytes(db: Db): Promise<number> {
	let tableBytes = 0;
	let liveBytes = 0;
	for (const table of RUN_LOG_TABLES) {
		const measured = await estimateTableLiveBytes(db, table);
		tableBytes += measured.tableBytes;
		liveBytes += Math.min(measured.liveBytes, measured.tableBytes);
	}
	const freeBytes = tableBytes - liveBytes;
	return freeBytes < tableBytes * FREE_SPACE_NOISE_FLOOR ? 0 : freeBytes;
}

async function estimateTableLiveBytes(
	db: Db,
	table: (typeof RUN_LOG_TABLES)[number],
): Promise<{ tableBytes: number; liveBytes: number }> {
	// `format('%I')` quotes each column name the way Postgres itself does.
	const columns = await db.query<{ total: string; each: string }>(
		`SELECT string_agg(format('COALESCE(pg_column_size(%I), 0)', attname), ' + ' ORDER BY attnum) AS total,
		        string_agg(format('COALESCE(pg_column_size(%I), 0)', attname), ', ' ORDER BY attnum) AS each
		 FROM pg_attribute
		 WHERE attrelid = $1::regclass AND attnum > 0 AND NOT attisdropped`,
		[table],
	);
	const { total, each } = columns.rows[0];
	const toasted = `data + ${ROW_OVERHEAD_BYTES} > ${TOAST_TUPLE_THRESHOLD_BYTES}`;
	// Heap pages are modelled as losing half an average row each to the row that
	// did not fit; TOAST chunks are sized so four fill a page.
	const r = await db.query<{ table_bytes: number; live_bytes: number }>(
		`WITH per_row AS (
		   SELECT ${total} AS data, GREATEST(${each}) AS widest FROM ${table}
		 ), stored AS (
		   SELECT CASE WHEN ${toasted}
		               THEN data - widest + ${TOAST_POINTER_BYTES} + ${ROW_OVERHEAD_BYTES}
		               ELSE data + ${ROW_OVERHEAD_BYTES} END AS heap,
		          CASE WHEN ${toasted}
		               THEN widest + ceil(widest / ${TOAST_CHUNK_DATA_BYTES}.0) * ${TOAST_CHUNK_OVERHEAD_BYTES}
		               ELSE 0 END AS toast
		   FROM per_row
		 ), totals AS (
		   SELECT COALESCE(SUM(heap), 0) AS heap, COALESCE(SUM(toast), 0) AS toast, COUNT(*) AS n
		   FROM stored
		 )
		 SELECT pg_table_size('${table}')::bigint AS table_bytes,
		        ((CASE WHEN n = 0 THEN 0
		               ELSE ceil(heap / (${PAGE_USABLE_BYTES} - heap / n / 2.0)) END
		          + ceil(toast / ${PAGE_USABLE_BYTES}.0)) * ${PAGE_BYTES})::bigint AS live_bytes
		 FROM totals`,
	);
	return {
		tableBytes: Number(r.rows[0]?.table_bytes ?? 0),
		liveBytes: Number(r.rows[0]?.live_bytes ?? 0),
	};
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
	const limit = opts.limit ?? runtimeConfig().logCompaction.batch;
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
		const tail = await readRunLogTail(db, row.id, runtimeConfig().logCompaction.preservedBytes);
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

/**
 * The marker a release before `reclaim` passes wrote: always a compaction
 * mid-trim, with its trimmed total under `bytes_reclaimed`.
 */
interface PreKindActiveMarker {
	started_at: string;
	older_than_days: number;
	total: number;
	processed: number;
	bytes_reclaimed: number;
}

/**
 * The last-pass record a release before `reclaim` passes wrote. Its one number,
 * `bytes_reclaimed`, meant the disk the closing rewrite freed on the embedded
 * backend, and the log text trimmed on external Postgres, which never rewrote.
 */
interface PreKindLastRecord {
	finished_at: string;
	older_than_days: number;
	processed: number;
	bytes_reclaimed: number;
}

export async function getActiveCompaction(db: Db): Promise<CompactionState | null> {
	const raw = await readJson<CompactionState | PreKindActiveMarker>(db, LOG_COMPACTION_ACTIVE_KEY);
	if (!raw || 'kind' in raw) return raw;
	return {
		kind: RunLogPassKind.Compact,
		phase: RunLogPassPhase.Trimming,
		started_at: raw.started_at,
		older_than_days: raw.older_than_days,
		total: raw.total,
		processed: raw.processed,
		trimmed_bytes: raw.bytes_reclaimed,
		usage_before_rewrite: null,
	};
}

export async function getLastCompaction(
	db: Db,
	backend: StorageBackend,
): Promise<LastCompaction | null> {
	const raw = await readJson<LastCompaction | PreKindLastRecord>(db, LOG_COMPACTION_LAST_KEY);
	if (!raw || 'kind' in raw) return raw;
	const embedded = backend === 'embedded';
	return {
		kind: RunLogPassKind.Compact,
		finished_at: raw.finished_at,
		older_than_days: raw.older_than_days,
		processed: raw.processed,
		trimmed_bytes: embedded ? null : raw.bytes_reclaimed,
		disk_bytes_freed: embedded ? raw.bytes_reclaimed : null,
		rewrite_failure: null,
	};
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

async function writeActive(db: Db, state: CompactionState): Promise<void> {
	await setSystemMeta(db, LOG_COMPACTION_ACTIVE_KEY, JSON.stringify(state));
}

/**
 * Begin a compaction pass: record the window + backlog size in the active
 * marker. The caller must have verified no pass is already active.
 */
export async function startCompaction(
	db: Db,
	opts: { olderThanDays: number },
): Promise<CompactionState> {
	const state: CompactionState = {
		kind: RunLogPassKind.Compact,
		phase: RunLogPassPhase.Trimming,
		started_at: new Date().toISOString(),
		older_than_days: opts.olderThanDays,
		total: await countCompactableRuns(db, opts.olderThanDays),
		processed: 0,
		trimmed_bytes: 0,
		usage_before_rewrite: null,
	};
	await writeActive(db, state);
	return state;
}

/**
 * Begin a pass that only rewrites the run-log tables. The caller must have
 * verified no pass is already active.
 */
export async function startSpaceReclaim(
	db: Db,
	opts: { backend: StorageBackend },
): Promise<CompactionState> {
	const state: CompactionState = {
		kind: RunLogPassKind.Reclaim,
		phase: RunLogPassPhase.Rewriting,
		started_at: new Date().toISOString(),
		usage_before_rewrite: await getDatabaseUsage(db, opts.backend),
	};
	await writeActive(db, state);
	return state;
}

async function finishPass(
	db: Db,
	state: CompactionState,
	rewrite: RunLogRewriteResult | null,
): Promise<void> {
	const disk = {
		finished_at: new Date().toISOString(),
		disk_bytes_freed: rewrite ? rewrite.diskBytesFreed : null,
		rewrite_failure: rewrite ? rewrite.failure : null,
	};
	const last: LastCompaction =
		state.kind === RunLogPassKind.Compact
			? {
					kind: RunLogPassKind.Compact,
					older_than_days: state.older_than_days,
					processed: state.processed,
					trimmed_bytes: state.trimmed_bytes,
					...disk,
				}
			: { kind: RunLogPassKind.Reclaim, ...disk };
	await setSystemMeta(db, LOG_COMPACTION_LAST_KEY, JSON.stringify(last));
	await deleteSystemMeta(db, LOG_COMPACTION_ACTIVE_KEY);
	const trimmed =
		state.kind === RunLogPassKind.Compact
			? `${state.processed} run(s) compacted, ~${Math.round(state.trimmed_bytes / 1024)} KB of log text trimmed`
			: 'rewrite only';
	const freed = rewrite
		? `, ~${Math.round(rewrite.diskBytesFreed / 1024)} KB returned to disk`
		: '';
	log.info(`Run-log pass complete: ${trimmed}${freed}`);
}

async function relationFileNode(db: Db, table: string): Promise<number> {
	const r = await db.query<{ n: number }>(
		'SELECT pg_relation_filenode($1::regclass)::bigint AS n',
		[table],
	);
	return Number(r.rows[0]?.n);
}

function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

/** Log wording per failure reason. The panel words these itself, in the operator's language. */
const FAILURE_LOG_TEXT: Record<
	RunLogRewriteFailureReason,
	(failure: RunLogRewriteFailure) => string
> = {
	[RunLogRewriteFailureReason.Busy]: () => 'the table was in use on every attempt',
	[RunLogRewriteFailureReason.NotOwner]: () => "Hezo's database user does not own the table",
	[RunLogRewriteFailureReason.Failed]: (failure) => failure.message ?? 'Postgres refused it',
};

function describeFailure(failure: RunLogRewriteFailure): string {
	return FAILURE_LOG_TEXT[failure.reason](failure);
}

/**
 * Rewrite both run-log tables (`VACUUM FULL`) so the free space inside them
 * goes back to the disk, returning how much the files shrank. Each table is
 * locked while it is rewritten: agents cannot save run logs, and pages that
 * show runs wait, until it ends.
 *
 * `SKIP_LOCKED` reports a skipped table only as a notice, so success is read
 * from the table itself: a rewrite always gives it a new file. A table still
 * busy after every attempt, or a rewrite Postgres refuses, stops the pass and
 * is returned as its failure; the tables before it stay rewritten.
 */
export async function rewriteRunLogTables(
	db: Db,
	opts: { retryMs?: number } = {},
): Promise<RunLogRewriteResult> {
	const retryMs = opts.retryMs ?? REWRITE_RETRY_MS;
	const before = await scalarBytes(db, RUN_LOG_BYTES_SQL);
	let failure: RunLogRewriteFailure | null = null;
	for (const table of RUN_LOG_TABLES) {
		failure = await rewriteTable(db, table, retryMs);
		if (failure) break;
	}
	const after = await scalarBytes(db, RUN_LOG_BYTES_SQL);
	if (failure) log.warn(`Rewrite of ${failure.table} did not run: ${describeFailure(failure)}`);
	return { diskBytesFreed: Math.max(0, before - after), failure };
}

async function rewriteTable(
	db: Db,
	table: string,
	retryMs: number,
): Promise<RunLogRewriteFailure | null> {
	for (let attempt = 1; attempt <= REWRITE_ATTEMPTS; attempt++) {
		const fileBefore = await relationFileNode(db, table);
		try {
			await db.query(`VACUUM (FULL, ANALYZE, SKIP_LOCKED) ${table}`);
		} catch (err) {
			return { reason: RunLogRewriteFailureReason.Failed, table, message: errorMessage(err) };
		}
		if ((await relationFileNode(db, table)) !== fileBefore) return null;
		// Postgres also skips, with only a warning, a table the current user may
		// not vacuum, so a skip is only "busy" for a user that owns the table.
		if (!(await mayRewrite(db, table))) {
			return { reason: RunLogRewriteFailureReason.NotOwner, table, message: null };
		}
		if (attempt < REWRITE_ATTEMPTS) await new Promise((r) => setTimeout(r, retryMs));
	}
	return { reason: RunLogRewriteFailureReason.Busy, table, message: null };
}

/** Whether the current database user owns the table (directly or by role) or is a superuser. */
async function mayRewrite(db: Db, table: string): Promise<boolean> {
	const r = await db.query<{ allowed: boolean }>(
		`SELECT pg_has_role(c.relowner, 'USAGE') OR r.rolsuper AS allowed
		 FROM pg_class c, pg_roles r
		 WHERE c.oid = $1::regclass AND r.rolname = current_user`,
		[table],
	);
	return r.rows[0]?.allowed === true;
}

/**
 * One cron tick of the drain loop. No-op unless a pass is active. A compaction
 * trims up to `logCompaction.maxPerTick` rows this tick (updating the progress
 * marker after each batch), then yields — the next tick continues where it left
 * off. Once the backlog is drained, the embedded backend moves on to the
 * rewrite; external Postgres finishes there. A `reclaim` pass starts at the
 * rewrite. A rewrite interrupted by a restart runs again on the next tick,
 * which is safe: a second `VACUUM FULL` only rewrites the table once more.
 */
export async function runLogCompactionTick(
	db: Db,
	opts: {
		backend: StorageBackend;
		batchSize?: number;
		maxRunsPerTick?: number;
		rewriteRetryMs?: number;
	},
): Promise<void> {
	let state = await getActiveCompaction(db);
	if (!state) return;

	if (state.kind === RunLogPassKind.Compact && state.phase === RunLogPassPhase.Trimming) {
		const batchSize = opts.batchSize ?? runtimeConfig().logCompaction.batch;
		const maxRunsPerTick = opts.maxRunsPerTick ?? runtimeConfig().logCompaction.maxPerTick;
		let processedThisTick = 0;
		let drained = false;
		while (processedThisTick < maxRunsPerTick) {
			const { processed, bytesReclaimed } = await compactRunLogsBatch(db, {
				olderThanDays: state.older_than_days,
				limit: batchSize,
			});
			if (processed === 0) {
				drained = true;
				break;
			}
			processedThisTick += processed;
			state = {
				...state,
				processed: state.processed + processed,
				trimmed_bytes: state.trimmed_bytes + bytesReclaimed,
			};
			await writeActive(db, state);
		}
		if (!drained) return;
		if (opts.backend !== 'embedded') {
			await finishPass(db, state, null);
			return;
		}
		state = {
			...state,
			phase: RunLogPassPhase.Rewriting,
			usage_before_rewrite: await getDatabaseUsage(db, opts.backend),
		};
		await writeActive(db, state);
	}

	const rewrite = await rewriteRunLogTables(db, { retryMs: opts.rewriteRetryMs });
	await finishPass(db, state, rewrite);
}
