/**
 * Asset blob storage abstraction. Assets (task attachments and the project
 * assets library) are stored as immutable blobs keyed by `projectId/assetId` —
 * teams are 1:1 with projects, so nothing team-scoped appears in a key. Two
 * drivers exist: the local filesystem (default, `assets/drivers/local.ts`) and
 * S3-compatible object storage (`assets/drivers/s3.ts`). Application code must
 * only ever depend on this interface — the concrete driver types appear solely
 * in the open/startup plumbing under `src/assets/`.
 *
 * A blob's content never changes for a given asset id (overwriting an asset
 * path mints a new id), so drivers never need invalidation or versioning.
 */

import { ATTACHMENT_MAX_BYTES } from '@hezo/shared';

export interface WriteAssetResult {
	byteSize: number;
	sha256: string;
}

export class AttachmentTooLargeError extends Error {
	constructor() {
		super(`Attachment exceeds ${ATTACHMENT_MAX_BYTES} bytes`);
	}
}

/**
 * The blob does not exist in the store (local ENOENT / S3 NoSuchKey). Callers
 * map this to a 404; any other read failure is a transport/storage error and
 * must surface as a 5xx, never a fake "not found".
 */
export class AssetNotFoundError extends Error {
	constructor(projectId: string, assetId: string) {
		super(`Asset blob ${assetId} not found in project ${projectId}`);
	}
}

export interface AssetStore {
	readonly kind: 'local' | 's3';
	/**
	 * Store a blob. Enforces `ATTACHMENT_MAX_BYTES` (throws
	 * `AttachmentTooLargeError`) and returns the byte size + sha256 for the
	 * caller's `assets` row. Callers own DB-row cleanup ordering: write the blob
	 * first, then insert the row, and delete the blob if the insert fails.
	 */
	write(projectId: string, assetId: string, source: Blob): Promise<WriteAssetResult>;
	/** Read a blob in full (blobs are capped at `ATTACHMENT_MAX_BYTES`). Throws `AssetNotFoundError` when absent. */
	read(projectId: string, assetId: string): Promise<Buffer>;
	/** Best-effort, idempotent single-blob delete (the DB row is the source of truth). */
	delete(projectId: string, assetId: string): Promise<void>;
	/** Idempotent removal of every blob under the project — used by project deletion. */
	deleteProjectAssets(projectId: string): Promise<void>;
	close(): Promise<void>;
}
