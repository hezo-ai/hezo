/**
 * Run-log maintenance on the Storage settings page: compacting old runs' logs,
 * and rewriting the run-log tables so the free space inside them goes back to
 * the disk. The wire shape of `GET /api/database-info/run-log-usage`, shared so
 * the server that writes it and the page that reads it cannot drift.
 */

/**
 * What a pass does. `compact` trims old runs' logs (and, on the embedded
 * database, then rewrites the tables); `reclaim` only rewrites the tables.
 */
export const RunLogPassKind = {
	Compact: 'compact',
	Reclaim: 'reclaim',
} as const;
export type RunLogPassKind = (typeof RunLogPassKind)[keyof typeof RunLogPassKind];

/**
 * Where an active pass is. `rewriting` means a `VACUUM FULL` holds a run-log
 * table's lock, so anything reading that table waits until it ends.
 */
export const RunLogPassPhase = {
	Trimming: 'trimming',
	Rewriting: 'rewriting',
} as const;
export type RunLogPassPhase = (typeof RunLogPassPhase)[keyof typeof RunLogPassPhase];

/**
 * Why a table was not rewritten. `busy`: another session held the table each
 * time the rewrite tried, and it does not queue for the lock. `not_owner`: the
 * database user Hezo connects as does not own the table, and Postgres lets only
 * the owner (or a superuser) rewrite it. `failed`: Postgres refused or aborted
 * the rewrite; its message is kept.
 */
export const RunLogRewriteFailureReason = {
	Busy: 'busy',
	NotOwner: 'not_owner',
	Failed: 'failed',
} as const;
export type RunLogRewriteFailureReason =
	(typeof RunLogRewriteFailureReason)[keyof typeof RunLogRewriteFailureReason];

export interface RunLogRewriteFailure {
	reason: RunLogRewriteFailureReason;
	/** The table that was not rewritten. Tables before it in the pass were. */
	table: string;
	/** Postgres's own message for a `failed` rewrite; null otherwise. */
	message: string | null;
}

/** Live size figures, all read from catalog metadata (no table scan). */
export interface RunLogUsageFigures {
	/** On-disk database size - embedded only; null for external Postgres. */
	database_bytes: number | null;
	/** On-disk size of both run-log tables, indexes and free space included. */
	run_log_bytes: number;
	run_count: number;
}

interface ActivePassBase {
	/** ISO timestamp the pass started. */
	started_at: string;
	phase: RunLogPassPhase;
}

export interface ActiveCompactPass extends ActivePassBase {
	kind: typeof RunLogPassKind.Compact;
	older_than_days: number;
	/** Runs that matched the window when the pass started (progress-bar denominator). */
	total: number;
	processed: number;
	/** Log text removed so far, counted in characters before compression - not disk space. */
	trimmed_bytes: number;
}

export interface ActiveReclaimPass extends ActivePassBase {
	kind: typeof RunLogPassKind.Reclaim;
}

/** The pass in progress; also the flag the page disables its buttons on. */
export type ActiveRunLogPass = ActiveCompactPass | ActiveReclaimPass;

interface FinishedPassBase {
	finished_at: string;
	/** How much the tables' files shrank in the rewrite; null when no rewrite ran. */
	disk_bytes_freed: number | null;
	/** Set when the rewrite stopped before rewriting every table. */
	rewrite_failure: RunLogRewriteFailure | null;
}

export interface FinishedCompactPass extends FinishedPassBase {
	kind: typeof RunLogPassKind.Compact;
	older_than_days: number;
	processed: number;
	/**
	 * Log text removed, counted in characters before compression. Null on a
	 * record from a release that kept only one number (the disk figure).
	 */
	trimmed_bytes: number | null;
}

export interface FinishedReclaimPass extends FinishedPassBase {
	kind: typeof RunLogPassKind.Reclaim;
}

export type FinishedRunLogPass = FinishedCompactPass | FinishedReclaimPass;

export interface RunLogUsage extends RunLogUsageFigures {
	backend: 'embedded' | 'external';
	/**
	 * Estimated free space inside the run-log tables that a rewrite would give
	 * back to the disk. 0 while a pass runs, and when the estimate is within its
	 * own error margin.
	 */
	free_bytes: number;
	/** Runs older than the window whose logs a compaction would trim. */
	compactable_run_count: number;
	older_than_days: number;
	compaction: ActiveRunLogPass | null;
	last: FinishedRunLogPass | null;
}
