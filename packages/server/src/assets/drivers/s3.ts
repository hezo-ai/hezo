import { createHash } from 'node:crypto';
import { ATTACHMENT_MAX_BYTES } from '@hezo/shared';
import { S3Client } from '../s3-client';
import {
	AssetNotFoundError,
	type AssetStore,
	AttachmentTooLargeError,
	type WriteAssetResult,
} from '../store';
import type { ParsedAssetStorageUrl } from '../url';

/**
 * S3-compatible object storage driver. Blobs live ONLY in the bucket — this
 * driver never touches the host filesystem. Keys are
 * `[prefix/]<projectId>/<assetId>`, the same relative layout the local driver
 * uses on disk, so moving an instance between backends is a plain
 * directory↔bucket sync.
 */
export class S3AssetStore implements AssetStore {
	readonly kind = 's3' as const;
	private readonly client: S3Client;
	private readonly prefix: string;

	constructor(options: ParsedAssetStorageUrl) {
		this.client = new S3Client(options);
		this.prefix = options.prefix;
	}

	private key(projectId: string, assetId: string): string {
		const rel = `${projectId}/${assetId}`;
		return this.prefix ? `${this.prefix}/${rel}` : rel;
	}

	private projectKeyPrefix(projectId: string): string {
		return this.prefix ? `${this.prefix}/${projectId}/` : `${projectId}/`;
	}

	async write(projectId: string, assetId: string, source: Blob): Promise<WriteAssetResult> {
		if (source.size > ATTACHMENT_MAX_BYTES) {
			throw new AttachmentTooLargeError();
		}
		const buf = Buffer.from(await source.arrayBuffer());
		if (buf.byteLength > ATTACHMENT_MAX_BYTES) {
			throw new AttachmentTooLargeError();
		}
		const sha256 = createHash('sha256').update(buf).digest('hex');
		await this.client.putObject(
			this.key(projectId, assetId),
			buf,
			source.type || 'application/octet-stream',
			{ sha256 },
		);
		return { byteSize: buf.byteLength, sha256 };
	}

	async read(projectId: string, assetId: string): Promise<Buffer> {
		const body = await this.client.getObject(this.key(projectId, assetId));
		if (body === null) throw new AssetNotFoundError(projectId, assetId);
		return body;
	}

	async delete(projectId: string, assetId: string): Promise<void> {
		await this.client.deleteObject(this.key(projectId, assetId));
	}

	async deleteProjectAssets(projectId: string): Promise<void> {
		// List-then-batch-delete under the project's key prefix. This also sweeps
		// orphaned blobs whose rows are gone (same net effect as the local
		// driver's directory removal).
		const keys = await this.client.listAllKeys(this.projectKeyPrefix(projectId));
		if (keys.length > 0) {
			await this.client.deleteObjects(keys);
		}
	}

	async close(): Promise<void> {}

	/**
	 * Connectivity + credentials + bucket preflight for startup: one
	 * ListObjectsV2 page proves the endpoint resolves, the signature is
	 * accepted, and the bucket exists — without touching any object.
	 */
	async preflight(): Promise<void> {
		await this.client.listPage(this.prefix ? `${this.prefix}/` : '', { maxKeys: 1 });
	}
}
