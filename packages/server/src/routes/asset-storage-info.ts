import { Hono } from 'hono';
import type { AssetStorageInfo } from '../lib/asset-storage-info';
import { ok } from '../lib/response';
import type { Env } from '../lib/types';
import { requireSuperuser } from '../middleware/auth';

/**
 * Asset-storage metadata for the General settings page. Superuser-only: even
 * redacted, the storage target (endpoint/bucket) is infrastructure detail —
 * the same posture as `GET /api/database-info`.
 *
 * The `AssetStorageInfo` handed to this factory is computed ONCE at startup
 * with the storage URL already redacted server-side (`redactAssetStorageUrl`);
 * the raw URL is never set on the request context, so no handler — this one or
 * any future one — can echo it to a client.
 */
export function buildAssetStorageInfoRoutes(info: AssetStorageInfo): Hono<Env> {
	const routes = new Hono<Env>();
	routes.get('/asset-storage-info', (c) => {
		const denied = requireSuperuser(c);
		if (denied) return denied;
		return ok(c, info);
	});
	return routes;
}
