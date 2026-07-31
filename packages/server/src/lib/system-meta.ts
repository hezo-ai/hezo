import {
	CONTAINER_IDLE_TIMEOUT_MIN_MAX,
	CONTAINER_IDLE_TIMEOUT_MIN_MIN,
	coerceLocaleSettings,
	computeDefaultMaxContainerMemoryGb,
	DEFAULT_CONTAINER_IDLE_TIMEOUT_MIN,
	DEFAULT_MAX_CHAT_HISTORY_SIZE,
	DEFAULT_MAX_CONTAINER_MEMORY_GB,
	DEFAULT_RAM_CAP_PER_CONTAINER_GB,
	type LocaleSettings,
	type LocaleSettingsPatch,
	MAX_CHAT_HISTORY_SIZE_MAX,
	MAX_CHAT_HISTORY_SIZE_MIN,
	MAX_CONTAINER_MEMORY_GB_MAX,
	MAX_CONTAINER_MEMORY_GB_MIN,
	RAM_CAP_PER_CONTAINER_GB_MAX,
	RAM_CAP_PER_CONTAINER_GB_MIN,
} from '@hezo/shared';
import type { Db } from '../db/database';
import { getHostMemory } from './host-memory';

/**
 * Instance-wide key-value settings stored in the `system_meta` table (the same
 * store the master-key canary lives in).
 */

export const INSTANCE_BASE_URL_KEY = 'instance_base_url';
export const MAX_CHAT_HISTORY_SIZE_KEY = 'max_chat_history_size';
/**
 * Total memory, in GB, all running containers may consume at once.
 *
 * This replaced `max_active_containers` (migration 050). A count only bounds
 * memory while every container is the same size, and `projects.memory_limit_gib`
 * exists so they are not - so the count is now *derived* from this budget and
 * the per-container cap rather than configured beside them.
 */
export const MAX_CONTAINER_MEMORY_GB_KEY = 'max_container_memory_gb';
export const RAM_CAP_PER_CONTAINER_KEY = 'default_ram_cap_per_container_gb';
export const CONTAINER_IDLE_TIMEOUT_KEY = 'container_idle_timeout_min';

/**
 * Locale keys. One key per axis rather than a single JSON blob, so a partial
 * update touches exactly the row it names and a corrupt value degrades only
 * that axis.
 */
export const LOCALE_KEYS: Record<keyof LocaleSettings, string> = {
	language: 'instance_language',
	date_format: 'instance_date_format',
	number_format: 'instance_number_format',
};

export async function getSystemMeta(db: Db, key: string): Promise<string | null> {
	const result = await db.query<{ value: string }>('SELECT value FROM system_meta WHERE key = $1', [
		key,
	]);
	return result.rows[0]?.value ?? null;
}

export async function setSystemMeta(db: Db, key: string, value: string): Promise<void> {
	await db.query(
		`INSERT INTO system_meta (key, value) VALUES ($1, $2)
		 ON CONFLICT (key) DO UPDATE SET value = $2`,
		[key, value],
	);
}

export async function deleteSystemMeta(db: Db, key: string): Promise<void> {
	await db.query('DELETE FROM system_meta WHERE key = $1', [key]);
}

/**
 * Clamp an arbitrary number to the allowed chat-history byte-cap range.
 * Exported so the settings route validates with the same bounds the reader
 * enforces.
 */
export function clampMaxChatHistorySize(value: number): number {
	if (!Number.isFinite(value)) return DEFAULT_MAX_CHAT_HISTORY_SIZE;
	return Math.min(
		MAX_CHAT_HISTORY_SIZE_MAX,
		Math.max(MAX_CHAT_HISTORY_SIZE_MIN, Math.round(value)),
	);
}

/**
 * The high-water byte cap for a chatbox's active message window: once the
 * window's combined content exceeds this, the chat agent compacts it into
 * long-term memory and all but the latest few messages are evicted. Falls back
 * to the default when unset or malformed, and clamps stored values to the
 * allowed range so a stale out-of-bounds row can never blow up a turn.
 */
export async function getMaxChatHistorySize(db: Db): Promise<number> {
	const raw = await getSystemMeta(db, MAX_CHAT_HISTORY_SIZE_KEY);
	if (raw === null) return DEFAULT_MAX_CHAT_HISTORY_SIZE;
	const parsed = Number.parseInt(raw, 10);
	if (Number.isNaN(parsed)) return DEFAULT_MAX_CHAT_HISTORY_SIZE;
	return clampMaxChatHistorySize(parsed);
}

export async function setMaxChatHistorySize(db: Db, value: number): Promise<number> {
	const clamped = clampMaxChatHistorySize(value);
	await setSystemMeta(db, MAX_CHAT_HISTORY_SIZE_KEY, String(clamped));
	return clamped;
}

/**
 * Clamp to the allowed max-active-containers range. Exported so the settings
 * route validates with the same bounds the reader enforces.
 */
export function clampMaxContainerMemoryGb(value: number): number {
	if (!Number.isFinite(value)) return DEFAULT_MAX_CONTAINER_MEMORY_GB;
	return Math.min(
		MAX_CONTAINER_MEMORY_GB_MAX,
		Math.max(MAX_CONTAINER_MEMORY_GB_MIN, Math.round(value)),
	);
}

/**
 * The automatic memory budget for this host: total virtual memory (RAM + swap)
 * less the system reserve and one container's worth held for the CEO chat. Used
 * whenever the operator has not explicitly set a budget.
 */
export async function computeAutoMaxContainerMemoryGb(db: Db): Promise<number> {
	const ramCapGb = await getDefaultRamCapPerContainerGb(db);
	const { totalRamBytes, totalSwapBytes } = getHostMemory();
	return computeDefaultMaxContainerMemoryGb(totalRamBytes, totalSwapBytes, ramCapGb);
}

/**
 * The explicitly stored max-active-containers value, or null when the operator
 * has never set one (→ the computed default applies).
 */
export async function getMaxContainerMemoryGbSetting(db: Db): Promise<number | null> {
	const raw = await getSystemMeta(db, MAX_CONTAINER_MEMORY_GB_KEY);
	if (raw === null) return null;
	const parsed = Number.parseInt(raw, 10);
	if (Number.isNaN(parsed)) return null;
	return clampMaxContainerMemoryGb(parsed);
}

/**
 * The effective instance-wide cap on simultaneously active (running) project
 * containers — the operator's main bound on memory, since every container is
 * memory-capped and total demand never exceeds `N × cap`. An explicitly stored
 * value wins; otherwise the default is computed from host memory and the
 * per-container ram cap. Malformed stored values degrade to the computed
 * default so a stale row can never wedge dispatch.
 */
export async function getMaxContainerMemoryGb(db: Db): Promise<number> {
	return (await getMaxContainerMemoryGbSetting(db)) ?? computeAutoMaxContainerMemoryGb(db);
}

export async function setMaxContainerMemoryGb(db: Db, value: number): Promise<number> {
	const clamped = clampMaxContainerMemoryGb(value);
	await setSystemMeta(db, MAX_CONTAINER_MEMORY_GB_KEY, String(clamped));
	return clamped;
}

/** Clear the explicit value — the computed (auto) default applies again. */
export async function clearMaxContainerMemoryGb(db: Db): Promise<void> {
	await deleteSystemMeta(db, MAX_CONTAINER_MEMORY_GB_KEY);
}

/**
 * Clamp to the allowed per-container ram-cap range (GB). Exported so the
 * settings route validates with the same bounds the reader enforces.
 */
export function clampRamCapPerContainerGb(value: number): number {
	if (!Number.isFinite(value)) return DEFAULT_RAM_CAP_PER_CONTAINER_GB;
	return Math.min(
		RAM_CAP_PER_CONTAINER_GB_MAX,
		Math.max(RAM_CAP_PER_CONTAINER_GB_MIN, Math.round(value)),
	);
}

/**
 * The instance-wide default memory cap per project container, in GB. Applied
 * as the Docker cgroup limit to every container without a per-project
 * override, and used as the divisor of the automatic max-active-containers
 * default. Falls back to 2 when unset or malformed.
 */
export async function getDefaultRamCapPerContainerGb(db: Db): Promise<number> {
	const raw = await getSystemMeta(db, RAM_CAP_PER_CONTAINER_KEY);
	if (raw === null) return DEFAULT_RAM_CAP_PER_CONTAINER_GB;
	const parsed = Number.parseInt(raw, 10);
	if (Number.isNaN(parsed)) return DEFAULT_RAM_CAP_PER_CONTAINER_GB;
	return clampRamCapPerContainerGb(parsed);
}

export async function setDefaultRamCapPerContainerGb(db: Db, value: number): Promise<number> {
	const clamped = clampRamCapPerContainerGb(value);
	await setSystemMeta(db, RAM_CAP_PER_CONTAINER_KEY, String(clamped));
	return clamped;
}

/**
 * Clamp to the allowed container idle-timeout range (minutes). 0 is a valid
 * value meaning "never stop" (always-on containers).
 */
export function clampContainerIdleTimeoutMin(value: number): number {
	if (!Number.isFinite(value)) return DEFAULT_CONTAINER_IDLE_TIMEOUT_MIN;
	return Math.min(
		CONTAINER_IDLE_TIMEOUT_MIN_MAX,
		Math.max(CONTAINER_IDLE_TIMEOUT_MIN_MIN, Math.round(value)),
	);
}

/**
 * Minutes a project's container may sit without activity (agent runs, assistant
 * chat) before the idle-stop cron stops it; containers restart on demand.
 * 0 = never stop. Falls back to the default when unset or malformed.
 */
export async function getContainerIdleTimeoutMin(db: Db): Promise<number> {
	const raw = await getSystemMeta(db, CONTAINER_IDLE_TIMEOUT_KEY);
	if (raw === null) return DEFAULT_CONTAINER_IDLE_TIMEOUT_MIN;
	const parsed = Number.parseInt(raw, 10);
	if (Number.isNaN(parsed)) return DEFAULT_CONTAINER_IDLE_TIMEOUT_MIN;
	return clampContainerIdleTimeoutMin(parsed);
}

export async function setContainerIdleTimeoutMin(db: Db, value: number): Promise<number> {
	const clamped = clampContainerIdleTimeoutMin(value);
	await setSystemMeta(db, CONTAINER_IDLE_TIMEOUT_KEY, String(clamped));
	return clamped;
}

/**
 * The public base URL of this instance (e.g. `https://hezo.example.com`),
 * captured from the first authenticated request during setup and editable in
 * global settings. Used to build absolute links for external channels
 * (Telegram, …); null until captured or configured.
 */
export function getInstanceBaseUrl(db: Db): Promise<string | null> {
	return getSystemMeta(db, INSTANCE_BASE_URL_KEY);
}

/**
 * Validates and normalizes a base URL to a bare http(s) origin. Rejects
 * anything with a path, query, fragment, or credentials — entity paths are
 * appended verbatim, so a path prefix would silently break every link.
 * Returns null when invalid.
 */
export function normalizeBaseUrl(raw: string): string | null {
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		return null;
	}
	if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
	if (url.pathname !== '' && url.pathname !== '/') return null;
	if (url.search !== '' || url.hash !== '') return null;
	if (url.username !== '' || url.password !== '') return null;
	return url.origin;
}

/**
 * The instance's display locale — language plus the date and money formats.
 * Global by design: one instance renders in one language, chosen during
 * onboarding and editable afterwards in global settings.
 *
 * Readable and writable before the master key exists. The master key encrypts
 * the `secrets` vault, not the database, and `system_meta` is where the
 * master-key canary itself lives — so the onboarding screen that runs ahead of
 * the vault can persist the operator's choice immediately rather than buffering
 * it somewhere that a page refresh would drop.
 *
 * A missing or corrupt row degrades to the default rather than throwing, so one
 * bad value can't break every rendered date on the instance.
 */
export async function getInstanceLocale(db: Db): Promise<LocaleSettings> {
	const entries = await Promise.all(
		Object.entries(LOCALE_KEYS).map(async ([field, key]) => [field, await getSystemMeta(db, key)]),
	);
	return coerceLocaleSettings(Object.fromEntries(entries.filter(([, value]) => value !== null)));
}

/** Apply a validated partial locale update. Absent fields are left alone. */
export async function setInstanceLocale(
	db: Db,
	patch: LocaleSettingsPatch,
): Promise<LocaleSettings> {
	for (const [field, key] of Object.entries(LOCALE_KEYS)) {
		const value = patch[field as keyof LocaleSettingsPatch];
		if (value !== undefined) await setSystemMeta(db, key, value);
	}
	return getInstanceLocale(db);
}

/**
 * Whether the operator has explicitly chosen a locale. Drives the onboarding
 * gate: an instance that has never been asked shows the language screen, and
 * one that has does not ask again. Distinct from "the locale equals the
 * default", which an operator may legitimately have chosen.
 */
export async function instanceLocaleIsConfigured(db: Db): Promise<boolean> {
	return (await getSystemMeta(db, LOCALE_KEYS.language)) !== null;
}
