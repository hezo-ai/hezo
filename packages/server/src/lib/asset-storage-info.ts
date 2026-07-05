/**
 * Asset-storage metadata shown on the General settings page, and the
 * server-side redaction that makes it safe. The plaintext asset storage URL
 * must never exist in client-side memory: `redactAssetStorageUrl` runs on the
 * server, once, at startup — request handlers only ever see the pre-redacted
 * `AssetStorageInfo`, so no route can leak the credentials even by mistake.
 * (Same posture as `StorageInfo` / `redactDatabaseUrl` in `db-info.ts`.)
 */

export type AssetStorageBackend = 'local' | 's3';

export interface AssetStorageInfo {
	backend: AssetStorageBackend;
	/** Local assets dir (local) or the pre-redacted storage URL (s3). */
	display: string;
}

const OCCLUDED = '••••';

/** Non-secret connection parameters worth showing back to the operator. */
const KEPT_QUERY_PARAMS = new Set(['region', 'pathstyle', 'tls']);

/**
 * Reduce an asset storage URL to a display-safe form: scheme + endpoint +
 * bucket/prefix survive; the access key and secret are occluded; query params
 * are dropped except the whitelist. Anything that isn't an authority-form
 * `s3://` URL with a host returns fully occluded — a malformed string may
 * hold credentials in an unknown layout, so no fragment of it is ever echoed.
 */
export function redactAssetStorageUrl(raw: string): string {
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		return OCCLUDED;
	}
	if (url.protocol !== 's3:' || !url.host) {
		return OCCLUDED;
	}
	const auth = url.username || url.password ? `${OCCLUDED}:${OCCLUDED}@` : '';
	const kept = [...url.searchParams].filter(([key]) => KEPT_QUERY_PARAMS.has(key.toLowerCase()));
	const query = kept.length
		? `?${kept.map(([key, value]) => `${key}=${encodeURIComponent(value)}`).join('&')}`
		: '';
	return `${url.protocol}//${auth}${url.host}${url.pathname}${query}`;
}
