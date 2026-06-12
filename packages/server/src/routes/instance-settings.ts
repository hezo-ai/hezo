import { Hono } from 'hono';
import { err, ok } from '../lib/response';
import {
	deleteSystemMeta,
	getInstanceBaseUrl,
	INSTANCE_BASE_URL_KEY,
	normalizeBaseUrl,
	setSystemMeta,
} from '../lib/system-meta';
import type { Env } from '../lib/types';
import { requireSuperuser } from '../middleware/auth';

export const instanceSettingsRoutes = new Hono<Env>();

// Instance-wide settings. Readable by any authenticated principal (the same
// openness as GET /api/ai-providers); writes are superuser-only.
instanceSettingsRoutes.get('/instance-settings', async (c) => {
	const base_url = await getInstanceBaseUrl(c.get('db'));
	return ok(c, { base_url });
});

instanceSettingsRoutes.patch('/instance-settings', async (c) => {
	const denied = requireSuperuser(c);
	if (denied) return denied;

	const db = c.get('db');
	const body = await c.req
		.json<{ base_url?: unknown }>()
		.catch(() => ({}) as { base_url?: unknown });

	if (!('base_url' in body)) {
		return err(c, 'INVALID_REQUEST', 'base_url is required', 400);
	}
	if (body.base_url === null || body.base_url === '') {
		await deleteSystemMeta(db, INSTANCE_BASE_URL_KEY);
		return ok(c, { base_url: null });
	}
	if (typeof body.base_url !== 'string') {
		return err(c, 'INVALID_REQUEST', 'base_url must be a string or null', 400);
	}
	const normalized = normalizeBaseUrl(body.base_url.trim());
	if (!normalized) {
		return err(
			c,
			'INVALID_REQUEST',
			'base_url must be an http(s) origin without path, query, or fragment',
			400,
		);
	}
	await setSystemMeta(db, INSTANCE_BASE_URL_KEY, normalized);
	return ok(c, { base_url: normalized });
});
