import {
	MAX_CHAT_HISTORY_SIZE_MAX,
	MAX_CHAT_HISTORY_SIZE_MIN,
	parseLocaleSettingsPatch,
} from '@hezo/shared';
import { Hono } from 'hono';
import { err, ok } from '../lib/response';
import {
	deleteSystemMeta,
	getInstanceBaseUrl,
	getInstanceLocale,
	getMaxChatHistorySize,
	INSTANCE_BASE_URL_KEY,
	instanceLocaleIsConfigured,
	normalizeBaseUrl,
	setInstanceLocale,
	setMaxChatHistorySize,
	setSystemMeta,
} from '../lib/system-meta';
import type { Env } from '../lib/types';
import { requireAdminEquivalent, requireAdminEquivalentBearer } from '../middleware/auth';
import { adminPasswordIsSet } from '../services/password';

export const instanceSettingsRoutes = new Hono<Env>();

// Instance-wide settings. Readable by any authenticated principal (the same
// openness as GET /api/ai-providers); writes are superuser-only.
instanceSettingsRoutes.get('/instance-settings', async (c) => {
	const db = c.get('db');
	const base_url = await getInstanceBaseUrl(db);
	const max_chat_history_size = await getMaxChatHistorySize(db);
	const locale = await getInstanceLocale(db);
	return ok(c, { base_url, max_chat_history_size, locale });
});

/**
 * The instance display locale — the one endpoint both the onboarding language
 * screen and the Settings dialog call, so the write path is identical wherever
 * it is edited from.
 *
 * Authorization is conditional because the onboarding screen runs before any
 * credential exists. While the instance is uninitialized this is open — the
 * same window in which `POST /api/auth/setup` already lets anyone claim the
 * instance outright, so it grants nothing new, and it is what lets the language
 * choice survive a mid-onboarding page refresh. Once an admin password is
 * enrolled it is superuser-only, like every other instance setting.
 *
 * Listed in `PUBLIC_PATHS`, so `authMiddleware` never ran and the bearer is
 * resolved here (the self-authenticating idiom `POST /api/auth/password` uses).
 *
 * Deliberately a narrow route rather than folding locale into the general
 * PATCH: that one also writes `base_url`, which must never be publicly
 * writable.
 */
instanceSettingsRoutes.patch('/instance-settings/locale', async (c) => {
	const db = c.get('db');

	if (await adminPasswordIsSet(db)) {
		const denied = await requireAdminEquivalentBearer(c);
		if (denied) return denied;
	}

	const body = await c.req.json<unknown>().catch(() => null);
	const parsed = parseLocaleSettingsPatch(body);
	if (!parsed.ok) return err(c, 'INVALID_REQUEST', parsed.error, 400);

	const locale = await setInstanceLocale(db, parsed.value);
	return ok(c, { locale, configured: await instanceLocaleIsConfigured(db) });
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

	// Locale is echoed so GET and PATCH return the same shape, but it is not
	// writable here — PATCH /instance-settings/locale is its single write path.
	const base_url = await getInstanceBaseUrl(db);
	const max_chat_history_size = await getMaxChatHistorySize(db);
	const locale = await getInstanceLocale(db);
	return ok(c, { base_url, max_chat_history_size, locale });
});
