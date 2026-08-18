import { join } from 'node:path';
import { type AssetStorageInfo, redactAssetStorageUrl } from '../lib/asset-storage-info';
import { logger } from '../logger';
import { LocalAssetStore } from './drivers/local';
import { AssetStorageError } from './errors';
import type { AssetStore } from './store';
import { parseAssetStorageUrl } from './url';

const log = logger.child('asset-storage');

/** Preflight retry backoff — a briefly-restarting endpoint shouldn't kill startup. */
const CONNECT_RETRY_DELAYS_MS = [2000, 4000];

export interface OpenAssetStorageOptions {
	dataDir: string;
	/**
	 * S3-compatible storage URL. Omitted → asset blobs on the local filesystem
	 * under `<dataDir>/assets` (the default; unchanged for existing installs).
	 */
	assetStorageUrl?: string;
	/** Test hook: overrides the preflight retry backoff. */
	retryDelaysMs?: number[];
}

export interface OpenedAssetStorage {
	store: AssetStore;
	/** Pre-redacted metadata, safe to expose to the settings endpoint. */
	info: AssetStorageInfo;
}

/**
 * Select and open the asset blob store — the single place a driver is
 * constructed at startup (mirrors `openDatabase`). Application code depends
 * only on the `AssetStore` interface; the raw URL stops here, redacted into
 * `info` before anything else sees it.
 */
export async function openAssetStorage(
	options: OpenAssetStorageOptions,
): Promise<OpenedAssetStorage> {
	if (!options.assetStorageUrl) {
		// Constructing the local driver also relocates blobs from the legacy
		// per-team layout (pre-abstraction versions) into `<dataDir>/assets`.
		const store = new LocalAssetStore(options.dataDir);
		return {
			store,
			info: { backend: 'local', display: join(options.dataDir, 'assets') },
		};
	}

	const parsed = parseAssetStorageUrl(options.assetStorageUrl);
	const redacted = redactAssetStorageUrl(options.assetStorageUrl);
	// Load the S3 driver (and its aws4fetch dependency) only when configured.
	const { S3AssetStore } = await import('./drivers/s3');
	const store = new S3AssetStore(parsed);

	const delays = options.retryDelaysMs ?? CONNECT_RETRY_DELAYS_MS;
	for (let attempt = 0; ; attempt++) {
		try {
			await store.preflight();
			break;
		} catch (err) {
			if (attempt < delays.length) {
				log.warn(
					`Asset storage preflight failed (attempt ${attempt + 1}/${delays.length + 1}), retrying in ${delays[attempt]}ms...`,
				);
				await new Promise((resolve) => setTimeout(resolve, delays[attempt]));
				continue;
			}
			const detail = err instanceof Error ? err.message : String(err);
			throw new AssetStorageError(
				`Cannot reach the configured asset storage at ${redacted}: ${detail}\n` +
					'Check the endpoint, credentials, bucket name, and pathStyle/tls parameters in ' +
					'--asset-storage-url or the `assetStorage.url` config-file key, and that the bucket exists. ' +
					'Omit the option to store assets on the local filesystem.',
				{ cause: err },
			);
		}
	}

	log.info(`Asset storage: S3-compatible (${redacted})`);
	return { store, info: { backend: 's3', display: redacted } };
}
