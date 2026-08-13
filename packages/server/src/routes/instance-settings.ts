import {
	CONTAINER_DISK_GB_MAX,
	CONTAINER_DISK_GB_MIN,
	isTaskView,
	MAX_CHAT_HISTORY_SIZE_MAX,
	MAX_CHAT_HISTORY_SIZE_MIN,
	MAX_CONTAINER_MEMORY_GB_MAX,
	MAX_CONTAINER_MEMORY_GB_MIN,
	parseLocaleSettingsPatch,
	projectMemoryFitsBudget,
	RAM_CAP_PER_CONTAINER_GB_MAX,
	RAM_CAP_PER_CONTAINER_GB_MIN,
	TASK_VIEWS,
} from '@hezo/shared';
import { Hono } from 'hono';
import type { Db } from '../db/database';
import { err, ok } from '../lib/response';
import {
	clearMaxContainerMemoryGb,
	computeAutoMaxContainerMemoryGb,
	deleteSystemMeta,
	getDefaultContainerDiskGb,
	getDefaultRamCapPerContainerGb,
	getDefaultTaskView,
	getInstanceBaseUrl,
	getInstanceLocale,
	getMaxChatHistorySize,
	getMaxContainerMemoryGb,
	getMaxContainerMemoryGbSetting,
	INSTANCE_BASE_URL_KEY,
	instanceLocaleIsConfigured,
	normalizeBaseUrl,
	setDefaultContainerDiskGb,
	setDefaultRamCapPerContainerGb,
	setDefaultTaskView,
	setInstanceLocale,
	setMaxChatHistorySize,
	setMaxContainerMemoryGb,
	setSystemMeta,
} from '../lib/system-meta';
import type { Env } from '../lib/types';
import { requireAdminEquivalent, requireAdminEquivalentBearer } from '../middleware/auth';
import { adminPasswordIsSet } from '../services/password';
import type { ContainerEngine } from '../services/sandbox/types';

export const instanceSettingsRoutes = new Hono<Env>();

/**
 * The settings payload GET and PATCH both return. `max_container_memory_gb` is
 * the effective budget; `_is_set` distinguishes an explicit choice from the
 * computed default, and the host memory figures let the settings page render
 * the formula behind the automatic value.
 *
 * **The host memory figures are null when containers do not run on this host.**
 * They come from the engine rather than a probe here, so the page cannot render
 * a formula out of numbers that had no part in the budget - a managed backend's
 * fleet is bounded by the operator's spend, not by the machine Hezo is installed
 * on.
 *
 * There is deliberately no container *count* here. How many containers fit
 * depends on the mix of their sizes - a project may raise its own cap - so a
 * count would be a number that changes meaning as the fleet changes, which is
 * exactly why the budget replaced it.
 */
async function instanceSettingsPayload(db: Db, engine: ContainerEngine) {
	const explicitBudget = await getMaxContainerMemoryGbSetting(db);
	const hostMemory = engine.containerHostMemory();
	return {
		base_url: await getInstanceBaseUrl(db),
		max_chat_history_size: await getMaxChatHistorySize(db),
		max_container_memory_gb: await getMaxContainerMemoryGb(db, engine),
		max_container_memory_gb_is_set: explicitBudget !== null,
		max_container_memory_gb_computed_default: await computeAutoMaxContainerMemoryGb(db, engine),
		default_ram_cap_per_container_gb: await getDefaultRamCapPerContainerGb(db),
		default_container_disk_gb: await getDefaultContainerDiskGb(db),
		host_total_ram_bytes: hostMemory?.totalRamBytes ?? null,
		host_total_swap_bytes: hostMemory?.totalSwapBytes ?? null,
		default_task_view: await getDefaultTaskView(db),
		locale: await getInstanceLocale(db),
	};
}

// Instance-wide settings. Readable by any authenticated principal (the same
// openness as GET /api/ai-providers); writes are superuser-only.
instanceSettingsRoutes.get('/instance-settings', async (c) => {
	return ok(c, await instanceSettingsPayload(c.get('db'), c.get('docker')));
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
 * Reject a budget that some project's per-container cap could never fit into.
 *
 * Checked against the projects that actually carry an override plus the
 * inherited default, so the operator learns immediately rather than watching a
 * project's runs queue forever with nothing naming the cause.
 */
async function budgetTooSmallError(db: Db, budgetGb: number): Promise<string | null> {
	const defaultCap = await getDefaultRamCapPerContainerGb(db);
	if (!projectMemoryFitsBudget(defaultCap, budgetGb)) {
		return (
			`a budget of ${budgetGb} GB is below the ${defaultCap} GB default per-container cap, ` +
			`so no container could ever start. Lower default_ram_cap_per_container_gb first.`
		);
	}
	const worst = await db.query<{ slug: string; memory_limit_gib: number }>(
		`SELECT slug, memory_limit_gib FROM projects
		  WHERE memory_limit_gib IS NOT NULL AND memory_limit_gib > $1
		  ORDER BY memory_limit_gib DESC LIMIT 1`,
		[budgetGb],
	);
	const row = worst.rows[0];
	if (!row) return null;
	return (
		`a budget of ${budgetGb} GB is below project "${row.slug}"'s ${row.memory_limit_gib} GB ` +
		`per-container cap, so that project could never start a container. Lower its memory ` +
		`limit first.`
	);
}

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
		max_container_memory_gb?: unknown;
		default_ram_cap_per_container_gb?: unknown;
		default_container_disk_gb?: unknown;
		default_task_view?: unknown;
	};
	const body = await c.req.json<PatchBody>().catch(() => ({}) as PatchBody);

	const knownFields = [
		'base_url',
		'max_chat_history_size',
		'max_container_memory_gb',
		'default_ram_cap_per_container_gb',
		'default_container_disk_gb',
		'default_task_view',
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

	if ('max_container_memory_gb' in body) {
		// null resets to the automatic (host-memory-computed) default.
		if (body.max_container_memory_gb === null) {
			await clearMaxContainerMemoryGb(db);
		} else {
			const invalid = integerRangeError(
				'max_container_memory_gb',
				body.max_container_memory_gb,
				MAX_CONTAINER_MEMORY_GB_MIN,
				MAX_CONTAINER_MEMORY_GB_MAX,
			);
			if (invalid) return err(c, 'INVALID_REQUEST', invalid, 400);
			// Admission check: a budget below some project's per-container cap would
			// leave that project permanently unschedulable - its container could
			// never fit, so its runs would queue forever with nothing saying why.
			// Refuse here, where the operator can act on it.
			const conflict = await budgetTooSmallError(db, body.max_container_memory_gb as number);
			if (conflict) return err(c, 'INVALID_REQUEST', conflict, 400);
			await setMaxContainerMemoryGb(db, body.max_container_memory_gb as number);
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
		// The same admission rule from the other side: raising the inherited cap
		// above the budget would make every project that inherits it unschedulable.
		const cap = body.default_ram_cap_per_container_gb as number;
		const budget = await getMaxContainerMemoryGb(db, c.get('docker'));
		if (!projectMemoryFitsBudget(cap, budget)) {
			return err(
				c,
				'INVALID_REQUEST',
				`default_ram_cap_per_container_gb of ${cap} GB exceeds the instance memory budget of ` +
					`${budget} GB - a container that size could never start. Raise ` +
					`max_container_memory_gb first.`,
				400,
			);
		}
		await setDefaultRamCapPerContainerGb(db, cap);
	}

	if ('default_container_disk_gb' in body) {
		const invalid = integerRangeError(
			'default_container_disk_gb',
			body.default_container_disk_gb,
			CONTAINER_DISK_GB_MIN,
			CONTAINER_DISK_GB_MAX,
		);
		if (invalid) return err(c, 'INVALID_REQUEST', invalid, 400);
		// No budget cross-check to make: unlike memory, disk is not pooled by Hezo.
		// What bounds it is the provider account's own quota, which Hezo cannot see -
		// so the honest place for that limit is the provider's docs page and the
		// failure it produces at provision time, not a check here that would be
		// guessing.
		await setDefaultContainerDiskGb(db, body.default_container_disk_gb as number);
	}

	if ('default_task_view' in body) {
		if (!isTaskView(body.default_task_view)) {
			return err(
				c,
				'INVALID_REQUEST',
				`default_task_view must be one of ${TASK_VIEWS.join(', ')}`,
				400,
			);
		}
		await setDefaultTaskView(db, body.default_task_view);
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
	return ok(c, await instanceSettingsPayload(c.get('db'), c.get('docker')));
});
