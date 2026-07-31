import { Hono } from 'hono';
import { ok } from '../lib/response';
import type { SandboxBackendInfo } from '../lib/sandbox-backend-info';
import type { Env } from '../lib/types';
import { requireSuperuser } from '../middleware/auth';

/**
 * Sandbox-backend metadata for the General settings page. Superuser-only: even
 * redacted, the provider endpoint is infrastructure detail - the same posture
 * as `GET /api/database-info` and `GET /api/asset-storage-info`.
 *
 * Read-only by design. The backend is deployment configuration, chosen once at
 * startup and never changed at runtime, so there is nothing here to PATCH.
 *
 * The `SandboxBackendInfo` handed to this factory is computed ONCE at startup
 * with the endpoint already redacted server-side (`redactSandboxApiUrl`); the
 * API key is never set on the request context, so no handler - this one or any
 * future one - can echo it to a client.
 */
export function buildSandboxBackendInfoRoutes(info: SandboxBackendInfo): Hono<Env> {
	const routes = new Hono<Env>();
	routes.get('/sandbox-backend-info', (c) => {
		const denied = requireSuperuser(c);
		if (denied) return denied;
		return ok(c, info);
	});
	return routes;
}
