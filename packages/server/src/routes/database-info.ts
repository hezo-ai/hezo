import {
	type ActiveRunLogPass,
	DEFAULT_LOG_COMPACTION_RETENTION_DAYS,
	type RunLogUsage,
} from '@hezo/shared';
import { Hono } from 'hono';
import { measureSuperseded, pruneSuperseded } from '../db/superseded';
import type { StorageInfo } from '../lib/db-info';
import { err, ok } from '../lib/response';
import type { Env } from '../lib/types';
import { logger } from '../logger';
import { requireSuperuser } from '../middleware/auth';
import {
	type CompactionState,
	clampRetentionDays,
	getActiveCompaction,
	getCompactionEstimate,
	getDatabaseUsage,
	getLastCompaction,
	startCompaction,
	startSpaceReclaim,
} from '../services/log-compaction';

const log = logger.child('database-info');

/**
 * Storage metadata for the General settings page, plus maintenance of the
 * pre-migration snapshots the embedded DB leaves behind. Superuser-only: even
 * redacted, the connection target (host/port/database) is infrastructure
 * detail — the same posture as the updates download/apply routes — and pruning
 * permanently deletes data.
 *
 * The `StorageInfo` handed to this factory is computed ONCE at startup with
 * the connection URL already redacted server-side (`redactDatabaseUrl`); the
 * raw URL is never set on the request context, so no handler — this one or
 * any future one — can echo it to a client. `dataDir` is where the embedded
 * cluster and its `pgdata.superseded.*` snapshots live.
 */
export function buildDatabaseInfoRoutes(info: StorageInfo, dataDir: string): Hono<Env> {
	const routes = new Hono<Env>();

	routes.get('/database-info', (c) => {
		const denied = requireSuperuser(c);
		if (denied) return denied;
		return ok(c, info);
	});

	// On-disk size of the retained pre-migration snapshots (`pgdata.superseded.*`).
	// Embedded-only: external Postgres migrates in place and produces none, so it
	// always reports zero and the UI hides the prune control.
	routes.get('/database-info/superseded', async (c) => {
		const denied = requireSuperuser(c);
		if (denied) return denied;
		if (info.backend === 'external') return ok(c, { count: 0, bytes: 0 });
		return ok(c, await measureSuperseded(dataDir));
	});

	// Reclaim disk by deleting ALL superseded snapshots. Destructive and
	// irreversible — the current database is untouched, but no rollback to a
	// prior version remains.
	routes.post('/database-info/prune-superseded', async (c) => {
		const denied = requireSuperuser(c);
		if (denied) return denied;
		if (info.backend === 'external') {
			return err(c, 'UNSUPPORTED', 'Snapshots only exist for the embedded database.', 409);
		}
		try {
			const result = await pruneSuperseded(dataDir, 0);
			return ok(c, { removed: result.removed, freed_bytes: result.bytes });
		} catch (e) {
			log.error(`Failed to prune superseded snapshots: ${e instanceof Error ? e.message : e}`);
			return err(c, 'PRUNE_FAILED', 'Failed to prune old database snapshots.', 500);
		}
	});

	// Live database-usage figures + run-log maintenance status. `run_log_bytes` is
	// the on-disk footprint of both run-log tables (main + TOAST + indexes + free
	// space); `database_bytes` is embedded-only. `free_bytes` /
	// `compactable_run_count` reflect the requested window and are computed only
	// when idle (they scan the tables, so the polling path skips them).
	// `compaction` is the active pass (also the "in progress" flag the DB panel
	// disables its buttons on).
	routes.get('/database-info/run-log-usage', async (c) => {
		const denied = requireSuperuser(c);
		if (denied) return denied;
		const db = c.get('db');
		const olderThanDays = clampRetentionDays(
			Number(c.req.query('older_than_days') ?? DEFAULT_LOG_COMPACTION_RETENTION_DAYS),
		);
		const [active, last] = await Promise.all([
			getActiveCompaction(db),
			getLastCompaction(db, info.backend),
		]);
		// While a rewrite holds a run-log table's lock, reading its size would wait
		// for the whole rewrite, so the figures read just before it are served.
		const usage = active?.usage_before_rewrite ?? (await getDatabaseUsage(db, info.backend));
		const estimate = active
			? { runCount: 0, freeBytes: 0 }
			: await getCompactionEstimate(db, olderThanDays);
		const body: RunLogUsage = {
			backend: info.backend,
			...usage,
			free_bytes: estimate.freeBytes,
			compactable_run_count: estimate.runCount,
			older_than_days: olderThanDays,
			compaction: active ? toWirePass(active) : null,
			last,
		};
		return ok(c, body);
	});

	// Start a compaction pass over runs older than the chosen window: trims their
	// verbose logs to the meaningful tail (keeping the launch command + a
	// compacted marker) and, on the embedded backend, then rewrites the run-log
	// tables to return the space to disk. Runs in the background a batch at a
	// time — this returns as soon as the pass is recorded. 409 if a pass is
	// already running.
	routes.post('/database-info/compact-run-logs', async (c) => {
		const denied = requireSuperuser(c);
		if (denied) return denied;
		const db = c.get('db');
		if (await getActiveCompaction(db)) {
			return err(c, 'ALREADY_RUNNING', 'A run-log pass is already in progress.', 409);
		}
		const body = (await c.req.json().catch(() => ({}))) as { older_than_days?: unknown };
		const olderThanDays = clampRetentionDays(
			Number(body.older_than_days ?? DEFAULT_LOG_COMPACTION_RETENTION_DAYS),
		);
		const state = await startCompaction(db, { olderThanDays });
		// Start draining immediately rather than waiting for the next cron tick;
		// guarded so it never overlaps the scheduled drain.
		c.get('jobManager')?.kickLogCompaction();
		return ok(c, toWirePass(state), 201);
	});

	// Start a pass that only rewrites the run-log tables (VACUUM FULL), returning
	// the free space inside them to the disk. Each table is locked while it is
	// rewritten, which is why this is its own operator action. Runs in the
	// background; 409 if a pass is already running.
	routes.post('/database-info/reclaim-run-log-space', async (c) => {
		const denied = requireSuperuser(c);
		if (denied) return denied;
		const db = c.get('db');
		if (await getActiveCompaction(db)) {
			return err(c, 'ALREADY_RUNNING', 'A run-log pass is already in progress.', 409);
		}
		const state = await startSpaceReclaim(db, { backend: info.backend });
		c.get('jobManager')?.kickLogCompaction();
		return ok(c, toWirePass(state), 201);
	});

	return routes;
}

/** The active pass as the panel sees it, without the server-side usage snapshot. */
function toWirePass(state: CompactionState): ActiveRunLogPass {
	const { usage_before_rewrite: _, ...pass } = state;
	return pass;
}
