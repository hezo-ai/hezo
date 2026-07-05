/**
 * Operator-actionable asset-storage failure: bad `--asset-storage-url`, an
 * unreachable endpoint, bad credentials, or a missing bucket. `index.ts`
 * prints the message verbatim and exits, so the message must carry the
 * guidance itself — and must never include the raw URL (it carries the access
 * key and secret); use the redacted form from `redactAssetStorageUrl`.
 */
export class AssetStorageError extends Error {
	constructor(message: string, options?: { cause?: unknown }) {
		super(message, options);
		this.name = 'AssetStorageError';
	}
}
