import { DEFAULT_LOG_COMPACTION_RETENTION_DAYS } from '@hezo/shared';
import { Hono } from 'hono';
import { measureSuperseded, pruneSuperseded } from '../db/superseded';
import type { StorageInfo } from '../lib/db-info';
import { err, ok } from '../lib/response';
import type { Env } from '../lib/types';
import { logger } from '../logger';
import { requireSuperuser } from '../middleware/auth';
import {
	clampRetentionDays,
	getActiveCompaction,
	getCompactionEstimate,
	getDatabaseUsage,
	getLastCompaction,
	startCompaction,
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

	// Live database-usage figures + run-log compaction status. `run_log_bytes` is
	// the on-disk footprint of the run-logs table (main + TOAST + bloat);
	// `database_bytes` is embedded-only. `reclaimable_bytes` / `compactable_run_count`
	// reflect the requested window and are computed only when idle (they scan the
	// table, so the polling path skips them). `compaction` is the active pass
	// (also the "in progress" flag the DB panel disables its button on).
	routes.get('/database-info/run-log-usage', async (c) => {
		const denied = requireSuperuser(c);
		if (denied) return denied;
		const db = c.get('db');
		const olderThanDays = clampRetentionDays(
			Number(c.req.query('older_than_days') ?? DEFAULT_LOG_COMPACTION_RETENTION_DAYS),
		);
		const [usage, compaction, last] = await Promise.all([
			getDatabaseUsage(db, info.backend),
			getActiveCompaction(db),
			getLastCompaction(db),
		]);
		// Skip the table-scanning estimate while a pass is running — the UI shows
		// live progress then, not the reclaimable preview.
		const estimate = compaction
			? { runCount: 0, reclaimableBytes: 0 }
			: await getCompactionEstimate(db, info.backend, olderThanDays);
		return ok(c, {
			backend: info.backend,
			database_bytes: usage.databaseBytes,
			run_log_bytes: usage.runLogDiskBytes,
			run_count: usage.runCount,
			reclaimable_bytes: estimate.reclaimableBytes,
			compactable_run_count: estimate.runCount,
			older_than_days: olderThanDays,
			compaction,
			last,
		});
	});

	// Start a compaction pass over runs older than the chosen window: trims their
	// verbose logs to the meaningful tail (keeping the launch command + a
	// compacted marker) and, once the embedded backend is drained, VACUUMs to
	// reclaim disk (including the dead-tuple bloat, across all runs). Runs in the
	// background a batch at a time — this returns as soon as the pass is recorded.
	// 409 if one is already running.
	routes.post('/database-info/compact-run-logs', async (c) => {
		const denied = requireSuperuser(c);
		if (denied) return denied;
		const db = c.get('db');
		if (await getActiveCompaction(db)) {
			return err(c, 'ALREADY_RUNNING', 'A log compaction is already in progress.', 409);
		}
		const body = (await c.req.json().catch(() => ({}))) as { older_than_days?: unknown };
		const olderThanDays = clampRetentionDays(
			Number(body.older_than_days ?? DEFAULT_LOG_COMPACTION_RETENTION_DAYS),
		);
		const state = await startCompaction(db, { olderThanDays, backend: info.backend });
		// Start draining immediately rather than waiting for the next cron tick;
		// guarded so it never overlaps the scheduled drain.
		c.get('jobManager')?.kickLogCompaction();
		return ok(c, state, 201);
	});

	return routes;
}
