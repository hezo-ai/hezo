import {
	CONTAINER_IDLE_TIMEOUT_MIN_MAX,
	CONTAINER_IDLE_TIMEOUT_MIN_MIN,
	MAX_ACTIVE_CONTAINERS_MAX,
	MAX_ACTIVE_CONTAINERS_MIN,
	MAX_CHAT_HISTORY_SIZE_MAX,
	MAX_CHAT_HISTORY_SIZE_MIN,
	parseLocaleSettingsPatch,
	RAM_CAP_PER_CONTAINER_GB_MAX,
	RAM_CAP_PER_CONTAINER_GB_MIN,
} from '@hezo/shared';
import { Hono } from 'hono';
import type { Db } from '../db/database';
import { getHostMemory } from '../lib/host-memory';
import { err, ok } from '../lib/response';
import {
	clearMaxActiveContainers,
	computeAutoMaxActiveContainers,
	deleteSystemMeta,
	getContainerIdleTimeoutMin,
	getDefaultRamCapPerContainerGb,
	getInstanceBaseUrl,
	getInstanceLocale,
	getMaxActiveContainers,
	getMaxActiveContainersSetting,
	getMaxChatHistorySize,
	INSTANCE_BASE_URL_KEY,
	instanceLocaleIsConfigured,
	normalizeBaseUrl,
	setContainerIdleTimeoutMin,
	setDefaultRamCapPerContainerGb,
	setInstanceLocale,
	setMaxActiveContainers,
	setMaxChatHistorySize,
	setSystemMeta,
} from '../lib/system-meta';
import type { Env } from '../lib/types';
import { requireAdminEquivalent, requireAdminEquivalentBearer } from '../middleware/auth';
import { adminPasswordIsSet } from '../services/password';

export const instanceSettingsRoutes = new Hono<Env>();

/**
 * The settings payload GET and PATCH both return. `max_active_containers` is
 * the effective value; `_is_set` distinguishes an explicit choice from the
 * computed default, and the host memory figures let the settings page render
 * the formula behind the automatic value ("8 GB / 2 GB = 4").
 */
async function instanceSettingsPayload(db: Db) {
	const explicitMaxActive = await getMaxActiveContainersSetting(db);
	const { totalRamBytes, totalSwapBytes } = getHostMemory();
	return {
		base_url: await getInstanceBaseUrl(db),
		max_chat_history_size: await getMaxChatHistorySize(db),
		max_active_containers: await getMaxActiveContainers(db),
		max_active_containers_is_set: explicitMaxActive !== null,
		max_active_containers_computed_default: await computeAutoMaxActiveContainers(db),
		default_ram_cap_per_container_gb: await getDefaultRamCapPerContainerGb(db),
		container_idle_timeout_min: await getContainerIdleTimeoutMin(db),
		host_total_ram_bytes: totalRamBytes,
		host_total_swap_bytes: totalSwapBytes,
		locale: await getInstanceLocale(db),
	};
}

// Instance-wide settings. Readable by any authenticated principal (the same
// openness as GET /api/ai-providers); writes are superuser-only.
instanceSettingsRoutes.get('/instance-settings', async (c) => {
	return ok(c, await instanceSettingsPayload(c.get('db')));
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

/**
 * Validate an integer-range setting from the PATCH body: returns an error
 * message when invalid, or null when `value` is an in-range integer.
 */
function integerRangeError(field: string, value: unknown, min: number, max: number): string | null {
	if (typeof value !== 'number' || !Number.isInteger(value)) {
		return `${field} must be an integer`;
	}
	if (value < min || value > max) {
		return `${field} must be between ${min} and ${max}`;
	}
	return null;
}

instanceSettingsRoutes.patch('/instance-settings', async (c) => {
	const denied = requireAdminEquivalent(c);
	if (denied) return denied;

	const db = c.get('db');
	type PatchBody = {
		base_url?: unknown;
		max_chat_history_size?: unknown;
		max_active_containers?: unknown;
		default_ram_cap_per_container_gb?: unknown;
		container_idle_timeout_min?: unknown;
	};
	const body = await c.req.json<PatchBody>().catch(() => ({}) as PatchBody);

	const knownFields = [
		'base_url',
		'max_chat_history_size',
		'max_active_containers',
		'default_ram_cap_per_container_gb',
		'container_idle_timeout_min',
	] as const;
	if (!knownFields.some((f) => f in body)) {
		return err(c, 'INVALID_REQUEST', `one of ${knownFields.join(', ')} is required`, 400);
	}

	if ('max_chat_history_size' in body) {
		const invalid = integerRangeError(
			'max_chat_history_size',
			body.max_chat_history_size,
			MAX_CHAT_HISTORY_SIZE_MIN,
			MAX_CHAT_HISTORY_SIZE_MAX,
		);
		if (invalid) return err(c, 'INVALID_REQUEST', invalid, 400);
		await setMaxChatHistorySize(db, body.max_chat_history_size as number);
	}

	if ('max_active_containers' in body) {
		// null resets to the automatic (host-memory-computed) default.
		if (body.max_active_containers === null) {
			await clearMaxActiveContainers(db);
		} else {
			const invalid = integerRangeError(
				'max_active_containers',
				body.max_active_containers,
				MAX_ACTIVE_CONTAINERS_MIN,
				MAX_ACTIVE_CONTAINERS_MAX,
			);
			if (invalid) return err(c, 'INVALID_REQUEST', invalid, 400);
			await setMaxActiveContainers(db, body.max_active_containers as number);
		}
	}

	if ('default_ram_cap_per_container_gb' in body) {
		const invalid = integerRangeError(
			'default_ram_cap_per_container_gb',
			body.default_ram_cap_per_container_gb,
			RAM_CAP_PER_CONTAINER_GB_MIN,
			RAM_CAP_PER_CONTAINER_GB_MAX,
		);
		if (invalid) return err(c, 'INVALID_REQUEST', invalid, 400);
		await setDefaultRamCapPerContainerGb(db, body.default_ram_cap_per_container_gb as number);
	}

	if ('container_idle_timeout_min' in body) {
		const invalid = integerRangeError(
			'container_idle_timeout_min',
			body.container_idle_timeout_min,
			CONTAINER_IDLE_TIMEOUT_MIN_MIN,
			CONTAINER_IDLE_TIMEOUT_MIN_MAX,
		);
		if (invalid) return err(c, 'INVALID_REQUEST', invalid, 400);
		await setContainerIdleTimeoutMin(db, body.container_idle_timeout_min as number);
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
	return ok(c, await instanceSettingsPayload(c.get('db')));
});
