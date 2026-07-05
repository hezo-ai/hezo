/**
 * Storage metadata shown on the General settings page, and the server-side
 * redaction that makes it safe. The plaintext database URL must never exist in
 * client-side memory: `redactDatabaseUrl` runs on the server, once, at
 * startup — request handlers only ever see the pre-redacted `StorageInfo`, so
 * no route can leak the credentials even by mistake.
 */

export type StorageBackend = 'embedded' | 'external';

export interface StorageInfo {
	backend: StorageBackend;
	/** Pgdata path (embedded) or the pre-redacted connection URL (external). */
	display: string;
	/** External only: Postgres server version string from the preflight. */
	server_version?: string;
}

const OCCLUDED = '••••';

/**
 * Query params can carry secrets too (`password=`, `sslpassword=`,
 * `options=`), so everything but this whitelist is dropped from the display
 * form rather than occluded per-param.
 */
const KEPT_QUERY_PARAMS = new Set(['sslmode']);

/**
 * Reduce a connection URL to a display-safe form: scheme + host + port +
 * database name survive; username and password are occluded; query params are
 * dropped except the whitelist. Anything that isn't an authority-form
 * `postgres://`/`postgresql://` URL with a host returns fully occluded — an
 * opaque or malformed string may hold credentials in an unknown layout, so no
 * fragment of it is ever echoed.
 */
export function redactDatabaseUrl(raw: string): string {
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		return OCCLUDED;
	}
	if ((url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') || !url.host) {
		return OCCLUDED;
	}
	const auth = url.username || url.password ? `${OCCLUDED}:${OCCLUDED}@` : '';
	const kept = [...url.searchParams].filter(([key]) => KEPT_QUERY_PARAMS.has(key.toLowerCase()));
	const query = kept.length
		? `?${kept.map(([key, value]) => `${key}=${encodeURIComponent(value)}`).join('&')}`
		: '';
	return `${url.protocol}//${auth}${url.host}${url.pathname}${query}`;
}
