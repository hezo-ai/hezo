import { createHash } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { ATTACHMENT_MAX_BYTES } from '@hezo/shared';
import { getAssetPath, getAssetsPath } from './workspace';

export interface WriteAssetResult {
	byteSize: number;
	sha256: string;
}

export class AttachmentTooLargeError extends Error {
	constructor() {
		super(`Attachment exceeds ${ATTACHMENT_MAX_BYTES} bytes`);
	}
}

export async function writeAsset(
	dataDir: string,
	teamSlug: string,
	projectSlug: string,
	assetId: string,
	source: Blob,
): Promise<WriteAssetResult> {
	if (source.size > ATTACHMENT_MAX_BYTES) {
		throw new AttachmentTooLargeError();
	}

	const buf = Buffer.from(await source.arrayBuffer());
	if (buf.byteLength > ATTACHMENT_MAX_BYTES) {
		throw new AttachmentTooLargeError();
	}

	const sha256 = createHash('sha256').update(buf).digest('hex');
	const diskPath = getAssetPath(dataDir, teamSlug, projectSlug, assetId);
	mkdirSync(dirname(diskPath), { recursive: true });

	try {
		await writeFile(diskPath, buf);
	} catch (err) {
		await unlink(diskPath).catch(() => {});
		throw err;
	}

	return { byteSize: buf.byteLength, sha256 };
}

export async function deleteAsset(
	dataDir: string,
	teamSlug: string,
	projectSlug: string,
	assetId: string,
): Promise<void> {
	const diskPath = getAssetPath(dataDir, teamSlug, projectSlug, assetId);
	await unlink(diskPath).catch(() => {});
}

export function assetExists(
	dataDir: string,
	teamSlug: string,
	projectSlug: string,
	assetId: string,
): boolean {
	return existsSync(getAssetPath(dataDir, teamSlug, projectSlug, assetId));
}

export { getAssetPath, getAssetsPath };
