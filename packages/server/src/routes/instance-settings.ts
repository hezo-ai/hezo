import { MAX_CHAT_HISTORY_SIZE_MAX, MAX_CHAT_HISTORY_SIZE_MIN } from '@hezo/shared';
import { Hono } from 'hono';
import { err, ok } from '../lib/response';
import {
	deleteSystemMeta,
	getInstanceBaseUrl,
	getMaxChatHistorySize,
	INSTANCE_BASE_URL_KEY,
	normalizeBaseUrl,
	setMaxChatHistorySize,
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
	const max_chat_history_size = await getMaxChatHistorySize(db);
	return ok(c, { base_url, max_chat_history_size });
});

instanceSettingsRoutes.patch('/instance-settings', async (c) => {
	const denied = requireAdminEquivalent(c);
	if (denied) return denied;

	const db = c.get('db');
	const body = await c.req
		.json<{ base_url?: unknown; max_chat_history_size?: unknown }>()
		.catch(() => ({}) as { base_url?: unknown; max_chat_history_size?: unknown });

	if (!('base_url' in body) && !('max_chat_history_size' in body)) {
		return err(c, 'INVALID_REQUEST', 'base_url or max_chat_history_size is required', 400);
	}

	if ('max_chat_history_size' in body) {
		const value = body.max_chat_history_size;
		if (typeof value !== 'number' || !Number.isInteger(value)) {
			return err(c, 'INVALID_REQUEST', 'max_chat_history_size must be an integer', 400);
		}
		if (value < MAX_CHAT_HISTORY_SIZE_MIN || value > MAX_CHAT_HISTORY_SIZE_MAX) {
			return err(
				c,
				'INVALID_REQUEST',
				`max_chat_history_size must be between ${MAX_CHAT_HISTORY_SIZE_MIN} and ${MAX_CHAT_HISTORY_SIZE_MAX}`,
				400,
			);
		}
		await setMaxChatHistorySize(db, value);
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
	const max_chat_history_size = await getMaxChatHistorySize(db);
	return ok(c, { base_url, max_chat_history_size });
});
