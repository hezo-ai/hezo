import { AssetStorageError } from './errors';

/**
 * Parsed form of `--asset-storage-url` / the `assetStorage.url` config-file key:
 *
 *   s3://ACCESS_KEY_ID:SECRET_ACCESS_KEY@endpoint[:port]/bucket[/prefix]?region=…&pathStyle=…&tls=…
 *
 * One URL carries the whole configuration, mirroring `--database-url`.
 * Credentials live in the userinfo (percent-encode `/`, `+`, `@` in secrets).
 * `pathStyle` defaults to true for custom endpoints (MinIO, R2, …) and false
 * for `*.amazonaws.com`, where virtual-hosted addressing is the convention.
 */
export interface ParsedAssetStorageUrl {
	/** Endpoint host[:port] — no scheme. */
	endpoint: string;
	bucket: string;
	/** Key prefix inside the bucket, '' for none (no leading/trailing slash). */
	prefix: string;
	region: string;
	pathStyle: boolean;
	tls: boolean;
	accessKeyId: string;
	secretAccessKey: string;
}

function parseBoolParam(name: string, raw: string): boolean {
	const lower = raw.toLowerCase();
	if (lower === 'true' || lower === '1') return true;
	if (lower === 'false' || lower === '0') return false;
	throw new AssetStorageError(
		`Invalid asset storage URL: '${name}' must be true or false, got '${raw}'.`,
	);
}

export function parseAssetStorageUrl(raw: string): ParsedAssetStorageUrl {
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		throw new AssetStorageError(
			'Invalid asset storage URL: not a parseable URL. Expected s3://ACCESS_KEY:SECRET@endpoint/bucket[/prefix].',
		);
	}
	if (url.protocol !== 's3:') {
		throw new AssetStorageError(
			`Invalid asset storage URL: scheme must be s3:// (got '${url.protocol}//'). Any S3-compatible store (AWS S3, MinIO, R2, Spaces, B2, …) is addressed with the s3:// scheme.`,
		);
	}
	if (!url.host) {
		throw new AssetStorageError(
			'Invalid asset storage URL: missing endpoint host. Expected s3://ACCESS_KEY:SECRET@endpoint/bucket[/prefix].',
		);
	}
	if (!url.username || !url.password) {
		throw new AssetStorageError(
			'Invalid asset storage URL: missing credentials. Put the access key id and secret in the URL userinfo (s3://KEY:SECRET@…), percent-encoding any / + @ characters.',
		);
	}
	const segments = url.pathname.split('/').filter((s) => s.length > 0);
	if (segments.length === 0) {
		throw new AssetStorageError(
			'Invalid asset storage URL: missing bucket. Expected s3://ACCESS_KEY:SECRET@endpoint/bucket[/prefix].',
		);
	}
	const [bucket, ...prefixParts] = segments.map((s) => decodeURIComponent(s));

	const regionRaw = url.searchParams.get('region');
	const pathStyleRaw = url.searchParams.get('pathStyle');
	const tlsRaw = url.searchParams.get('tls');
	return {
		endpoint: url.host,
		bucket,
		prefix: prefixParts.join('/'),
		region: regionRaw && regionRaw.length > 0 ? regionRaw : 'us-east-1',
		pathStyle:
			pathStyleRaw !== null
				? parseBoolParam('pathStyle', pathStyleRaw)
				: !url.hostname.endsWith('.amazonaws.com'),
		tls: tlsRaw !== null ? parseBoolParam('tls', tlsRaw) : true,
		accessKeyId: decodeURIComponent(url.username),
		secretAccessKey: decodeURIComponent(url.password),
	};
}
