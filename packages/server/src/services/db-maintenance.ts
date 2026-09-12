/**
 * Periodic database housekeeping.
 *
 * Two jobs, both deliberately narrow. Neither touches a row the user would
 * recognise as theirs: run logs, cost entries and audit history are the user's
 * record and an instance may keep all of it forever - growth there is a
 * query-design problem (bounded projections, keyset pagination, indexes), never
 * a licence to prune. Reclamation of *that* data stays an explicit, operator-
 * triggered control on the Storage settings page.
 */

import { TERMINAL_WAKEUP_STATUSES } from '@hezo/shared';
import type { Db } from '../db/database';
import { logger } from '../logger';

const log = logger.child('db-maintenance');

/**
 * Tables whose statistics actually steer a plan we care about: the ones the hot
 * queries filter, sort and join on. Analyzing the whole database on a schedule
 * would cost far more than it buys, and most tables here never grow enough to
 * shift a plan.
 */
export const ANALYZE_TABLES = [
	'heartbeat_runs',
	'heartbeat_run_log_chunks',
	'tasks',
	'task_comments',
	'audit_log',
	'agent_wakeup_requests',
	'cost_entries',
] as const;

/**
 * Refresh planner statistics on the embedded backend.
 *
 * PGlite has no autovacuum and therefore no auto-ANALYZE. As an instance grows,
 * the planner keeps costing queries against statistics gathered when the tables
 * were small, and silently stops using the indexes that were added for them -
 * so the composite indexes in migration 047 quietly degrade to sequential scans
 * at exactly the size where they matter most. This reads nothing and deletes
 * nothing; it only tells the planner the truth about what is there.
 *
 * A no-op on external Postgres, where autovacuum already does this.
 */
export async function analyzeHotTables(db: Db): Promise<number> {
	if (db.kind !== 'pglite') return 0;
	let analyzed = 0;
	for (const table of ANALYZE_TABLES) {
		try {
			// Table names are from the const list above, never from input.
			await db.query(`ANALYZE ${table}`);
			analyzed++;
		} catch (e) {
			// A table missing on an older schema must not abort the rest of the pass.
			log.warn(`ANALYZE ${table} failed`, e);
		}
	}
	return analyzed;
}

/** Rows are kept this long so a recent dispatch is still debuggable. */
export const WAKEUP_RETENTION_DAYS = 7;

/** Rows per statement, so one DELETE can never turn into a long global-lock hold. */
const WAKEUP_SWEEP_BATCH = 5_000;

/**
 * Ceiling on what one pass will delete in total, across repeated batches.
 *
 * A single statement bounds the lock hold; this bounds the pass. One batch a
 * night cannot drain a backlog built at dispatch rate - a scheduler fault that
 * churns rows faster than the batch size outruns the sweep indefinitely, and the
 * table grows without bound while a working sweep runs every night. Draining in
 * batches until the table is clean keeps the lock hold unchanged and turns a
 * backlog into a few nights rather than never. Steady state exits on the first
 * short batch.
 */
const WAKEUP_SWEEP_MAX_PER_PASS = 100_000;

/**
 * Delete terminal `agent_wakeup_requests` rows older than the retention window.
 *
 * This is the *only* table swept automatically, and it qualifies on a specific
 * test: it is internal scheduler bookkeeping with no user-facing surface. No
 * page renders it, no export includes it, and nothing links to a wakeup - it
 * exists solely so the dispatcher can hand a run to an agent exactly once. That
 * makes it unlike every other growing table here, and the distinction is the
 * whole reason this function is allowed to exist while nothing prunes runs,
 * costs or audit entries.
 *
 * Deletes in statement-sized batches until the table is clean or the pass
 * ceiling is reached, so the write path is never held for an unbounded time and
 * a backlog still drains in a bounded number of nights.
 */
export async function sweepTerminalWakeups(
	db: Db,
	retentionDays: number = WAKEUP_RETENTION_DAYS,
): Promise<number> {
	let swept = 0;
	while (swept < WAKEUP_SWEEP_MAX_PER_PASS) {
		const batch = Math.min(WAKEUP_SWEEP_BATCH, WAKEUP_SWEEP_MAX_PER_PASS - swept);
		const res = await db.query<{ id: string }>(
			`DELETE FROM agent_wakeup_requests
			 WHERE id IN (
			   SELECT id FROM agent_wakeup_requests
			   WHERE status = ANY($1::wakeup_status[])
			     AND created_at < now() - ($2 || ' days')::interval
			   LIMIT $3
			 )
			 RETURNING id`,
			[[...TERMINAL_WAKEUP_STATUSES], String(retentionDays), batch],
		);
		swept += res.rows.length;
		// A short batch means the table is clean for this window; stop rather than
		// spending another round trip proving it.
		if (res.rows.length < batch) break;
	}
	return swept;
}
