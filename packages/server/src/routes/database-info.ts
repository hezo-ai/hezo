import { Hono } from 'hono';
import { measureSuperseded, pruneSuperseded } from '../db/superseded';
import type { StorageInfo } from '../lib/db-info';
import { err, ok } from '../lib/response';
import type { Env } from '../lib/types';
import { logger } from '../logger';
import { requireSuperuser } from '../middleware/auth';

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

	return routes;
}
