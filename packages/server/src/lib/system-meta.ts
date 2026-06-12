import type { PGlite } from '@electric-sql/pglite';

/**
 * Instance-wide key-value settings stored in the `system_meta` table (the same
 * store the master-key canary lives in).
 */

export const INSTANCE_BASE_URL_KEY = 'instance_base_url';

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
