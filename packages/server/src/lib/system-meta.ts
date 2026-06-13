import type { PGlite } from '@electric-sql/pglite';
import {
	CHAT_HISTORY_LIMIT_MAX,
	CHAT_HISTORY_LIMIT_MIN,
	DEFAULT_CHAT_HISTORY_LIMIT,
} from '@hezo/shared';

/**
 * Instance-wide key-value settings stored in the `system_meta` table (the same
 * store the master-key canary lives in).
 */

export const INSTANCE_BASE_URL_KEY = 'instance_base_url';
export const CHAT_HISTORY_LIMIT_KEY = 'chat_history_limit';

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
 * Clamp an arbitrary number to the allowed chat-history-window range. Exported
 * so the settings route validates with the same bounds the reader enforces.
 */
export function clampChatHistoryLimit(value: number): number {
	if (!Number.isFinite(value)) return DEFAULT_CHAT_HISTORY_LIMIT;
	return Math.min(CHAT_HISTORY_LIMIT_MAX, Math.max(CHAT_HISTORY_LIMIT_MIN, Math.round(value)));
}

/**
 * How many recent chatbox messages to replay into each turn's prompt. Falls
 * back to the default when unset or malformed, and clamps stored values to the
 * allowed range so a stale out-of-bounds row can never blow up a turn.
 */
export async function getChatHistoryLimit(db: PGlite): Promise<number> {
	const raw = await getSystemMeta(db, CHAT_HISTORY_LIMIT_KEY);
	if (raw === null) return DEFAULT_CHAT_HISTORY_LIMIT;
	const parsed = Number.parseInt(raw, 10);
	if (Number.isNaN(parsed)) return DEFAULT_CHAT_HISTORY_LIMIT;
	return clampChatHistoryLimit(parsed);
}

export async function setChatHistoryLimit(db: PGlite, value: number): Promise<number> {
	const clamped = clampChatHistoryLimit(value);
	await setSystemMeta(db, CHAT_HISTORY_LIMIT_KEY, String(clamped));
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
