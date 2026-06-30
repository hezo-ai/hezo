import type { PGlite } from '@electric-sql/pglite';
import {
	DEFAULT_MAX_CHAT_HISTORY_SIZE,
	MAX_CHAT_HISTORY_SIZE_MAX,
	MAX_CHAT_HISTORY_SIZE_MIN,
} from '@hezo/shared';

/**
 * Instance-wide key-value settings stored in the `system_meta` table (the same
 * store the master-key canary lives in).
 */

export const INSTANCE_BASE_URL_KEY = 'instance_base_url';
export const MAX_CHAT_HISTORY_SIZE_KEY = 'max_chat_history_size';

export async function getSystemMeta(db: PGlite, key: string): Promise<string | null> {
	const result = await db.query<{ value: string }>('SELECT value FROM system_meta WHERE key = $1', [
		key,
	]);
	return result.rows[0]?.value ?? null;
}

export async function setSystemMeta(db: PGlite, key: string, value: string): Promise<void> {
	await db.query(
		`INSERT INTO system_meta (key, value) VALUES ($1, $2)
		 ON CONFLICT (key) DO UPDATE SET value = $2`,
		[key, value],
	);
}

export async function deleteSystemMeta(db: PGlite, key: string): Promise<void> {
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
export async function getMaxChatHistorySize(db: PGlite): Promise<number> {
	const raw = await getSystemMeta(db, MAX_CHAT_HISTORY_SIZE_KEY);
	if (raw === null) return DEFAULT_MAX_CHAT_HISTORY_SIZE;
	const parsed = Number.parseInt(raw, 10);
	if (Number.isNaN(parsed)) return DEFAULT_MAX_CHAT_HISTORY_SIZE;
	return clampMaxChatHistorySize(parsed);
}

export async function setMaxChatHistorySize(db: PGlite, value: number): Promise<number> {
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
export function getInstanceBaseUrl(db: PGlite): Promise<string | null> {
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
