import { CHAT_HISTORY_LIMIT_MAX, CHAT_HISTORY_LIMIT_MIN } from '@hezo/shared';
import { Hono } from 'hono';
import { err, ok } from '../lib/response';
import {
	deleteSystemMeta,
	getChatHistoryLimit,
	getInstanceBaseUrl,
	INSTANCE_BASE_URL_KEY,
	normalizeBaseUrl,
	setChatHistoryLimit,
	setSystemMeta,
} from '../lib/system-meta';
import type { Env } from '../lib/types';
import { requireAdminEquivalent } from '../middleware/auth';

export const instanceSettingsRoutes = new Hono<Env>();

// Instance-wide settings. Readable by any authenticated principal (the same
// openness as GET /api/ai-providers); writes are superuser-only.
instanceSettingsRoutes.get('/instance-settings', async (c) => {
	const db = c.get('db');
	const base_url = await getInstanceBaseUrl(db);
	const chat_history_limit = await getChatHistoryLimit(db);
	return ok(c, { base_url, chat_history_limit });
});

instanceSettingsRoutes.patch('/instance-settings', async (c) => {
	const denied = requireAdminEquivalent(c);
	if (denied) return denied;

	const db = c.get('db');
	const body = await c.req
		.json<{ base_url?: unknown; chat_history_limit?: unknown }>()
		.catch(() => ({}) as { base_url?: unknown; chat_history_limit?: unknown });

	if (!('base_url' in body) && !('chat_history_limit' in body)) {
		return err(c, 'INVALID_REQUEST', 'base_url or chat_history_limit is required', 400);
	}

	if ('chat_history_limit' in body) {
		const value = body.chat_history_limit;
		if (typeof value !== 'number' || !Number.isInteger(value)) {
			return err(c, 'INVALID_REQUEST', 'chat_history_limit must be an integer', 400);
		}
		if (value < CHAT_HISTORY_LIMIT_MIN || value > CHAT_HISTORY_LIMIT_MAX) {
			return err(
				c,
				'INVALID_REQUEST',
				`chat_history_limit must be between ${CHAT_HISTORY_LIMIT_MIN} and ${CHAT_HISTORY_LIMIT_MAX}`,
				400,
			);
		}
		await setChatHistoryLimit(db, value);
	}

	if ('base_url' in body) {
		if (body.base_url === null || body.base_url === '') {
			await deleteSystemMeta(db, INSTANCE_BASE_URL_KEY);
		} else if (typeof body.base_url !== 'string') {
			return err(c, 'INVALID_REQUEST', 'base_url must be a string or null', 400);
		} else {
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
		}
	}

	const base_url = await getInstanceBaseUrl(db);
	const chat_history_limit = await getChatHistoryLimit(db);
	return ok(c, { base_url, chat_history_limit });
});
