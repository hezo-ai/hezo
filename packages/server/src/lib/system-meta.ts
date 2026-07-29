import {
	coerceLocaleSettings,
	DEFAULT_MAX_CHAT_HISTORY_SIZE,
	type LocaleSettings,
	type LocaleSettingsPatch,
	MAX_CHAT_HISTORY_SIZE_MAX,
	MAX_CHAT_HISTORY_SIZE_MIN,
} from '@hezo/shared';
import type { Db } from '../db/database';

/**
 * Instance-wide key-value settings stored in the `system_meta` table (the same
 * store the master-key canary lives in).
 */

export const INSTANCE_BASE_URL_KEY = 'instance_base_url';
export const MAX_CHAT_HISTORY_SIZE_KEY = 'max_chat_history_size';

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
