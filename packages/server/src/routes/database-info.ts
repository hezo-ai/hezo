import { Hono } from 'hono';
import type { StorageInfo } from '../lib/db-info';
import { ok } from '../lib/response';
import type { Env } from '../lib/types';
import { requireSuperuser } from '../middleware/auth';

/**
 * Storage metadata for the General settings page. Superuser-only: even
 * redacted, the connection target (host/port/database) is infrastructure
 * detail — the same posture as the updates download/apply routes.
 *
 * The `StorageInfo` handed to this factory is computed ONCE at startup with
 * the connection URL already redacted server-side (`redactDatabaseUrl`); the
 * raw URL is never set on the request context, so no handler — this one or
 * any future one — can echo it to a client.
 */
export function buildDatabaseInfoRoutes(info: StorageInfo): Hono<Env> {
	const routes = new Hono<Env>();
	routes.get('/database-info', (c) => {
		const denied = requireSuperuser(c);
		if (denied) return denied;
		return ok(c, info);
	});
	return routes;
}
