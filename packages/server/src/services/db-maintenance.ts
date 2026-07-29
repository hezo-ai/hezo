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

/** Ceiling per pass, so one tick can never turn into a long global-lock hold. */
const WAKEUP_SWEEP_LIMIT = 5_000;

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
 * Bounded by `WAKEUP_SWEEP_LIMIT` per pass; a backlog simply drains over several
 * ticks rather than one pass holding the write path for an unbounded time.
 */
export async function sweepTerminalWakeups(
	db: Db,
	retentionDays: number = WAKEUP_RETENTION_DAYS,
): Promise<number> {
	const res = await db.query<{ id: string }>(
		`DELETE FROM agent_wakeup_requests
		 WHERE id IN (
		   SELECT id FROM agent_wakeup_requests
		   WHERE status = ANY($1::wakeup_status[])
		     AND created_at < now() - ($2 || ' days')::interval
		   LIMIT $3
		 )
		 RETURNING id`,
		[[...TERMINAL_WAKEUP_STATUSES], String(retentionDays), WAKEUP_SWEEP_LIMIT],
	);
	return res.rows.length;
}
