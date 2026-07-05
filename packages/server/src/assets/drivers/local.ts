import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, renameSync, rmdirSync } from 'node:fs';
import { readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ATTACHMENT_MAX_BYTES } from '@hezo/shared';
import { logger } from '../../logger';
import {
	AssetNotFoundError,
	type AssetStore,
	AttachmentTooLargeError,
	type WriteAssetResult,
} from '../store';

const log = logger.child('asset-storage');

/**
 * Filesystem driver (the default when no `--asset-storage-url` is configured).
 * Blobs live at `<dataDir>/assets/<projectId>/<assetId>` — the same relative
 * `<projectId>/<assetId>` layout the S3 driver uses as its key, so moving an
 * instance between backends is a plain directory↔bucket sync.
 */
export class LocalAssetStore implements AssetStore {
	readonly kind = 'local' as const;

	constructor(private readonly dataDir: string) {
		relocateLegacyAssetBlobs(dataDir);
	}

	private projectDir(projectId: string): string {
		return join(this.dataDir, 'assets', projectId);
	}

	private assetPath(projectId: string, assetId: string): string {
		return join(this.projectDir(projectId), assetId);
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
		const diskPath = this.assetPath(projectId, assetId);
		mkdirSync(this.projectDir(projectId), { recursive: true });
		try {
			await writeFile(diskPath, buf);
		} catch (err) {
			await unlink(diskPath).catch(() => {});
			throw err;
		}
		return { byteSize: buf.byteLength, sha256 };
	}

	async read(projectId: string, assetId: string): Promise<Buffer> {
		try {
			return await readFile(this.assetPath(projectId, assetId));
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
				throw new AssetNotFoundError(projectId, assetId);
			}
			throw err;
		}
	}

	async delete(projectId: string, assetId: string): Promise<void> {
		await unlink(this.assetPath(projectId, assetId)).catch(() => {});
	}

	async deleteProjectAssets(projectId: string): Promise<void> {
		await rm(this.projectDir(projectId), { recursive: true, force: true });
	}

	async close(): Promise<void> {}
}

/**
 * One-time, idempotent relocation of blobs written by versions that stored
 * assets inside the project workspace tree
 * (`<dataDir>/teams/<teamId>/projects/<projectId>/assets/<assetId>`) to the
 * project-centric layout (`<dataDir>/assets/<projectId>/<assetId>`). Pure
 * same-filesystem renames keyed off the path segments — no DB, no copying.
 * Emptied legacy `assets/` dirs are removed so later scans find nothing;
 * the surrounding project dirs stay (they still hold workspace/worktrees).
 */
export function relocateLegacyAssetBlobs(dataDir: string): void {
	if (!dataDir) return;
	const teamsRoot = join(dataDir, 'teams');
	if (!existsSync(teamsRoot)) return;
	let moved = 0;
	for (const teamId of listDirs(teamsRoot)) {
		const projectsRoot = join(teamsRoot, teamId, 'projects');
		for (const projectId of listDirs(projectsRoot)) {
			const legacyDir = join(projectsRoot, projectId, 'assets');
			const entries = listFiles(legacyDir);
			if (entries.length === 0) {
				removeIfEmpty(legacyDir);
				continue;
			}
			const destDir = join(dataDir, 'assets', projectId);
			mkdirSync(destDir, { recursive: true });
			for (const assetId of entries) {
				try {
					renameSync(join(legacyDir, assetId), join(destDir, assetId));
					moved++;
				} catch (err) {
					log.error(`Failed to relocate legacy asset blob ${projectId}/${assetId}:`, err);
				}
			}
			removeIfEmpty(legacyDir);
		}
	}
	if (moved > 0) {
		log.info(`Relocated ${moved} asset blob(s) to ${join(dataDir, 'assets')}`);
	}
}

function listDirs(path: string): string[] {
	if (!existsSync(path)) return [];
	try {
		return readdirSync(path, { withFileTypes: true })
			.filter((e) => e.isDirectory())
			.map((e) => e.name);
	} catch {
		return [];
	}
}

function listFiles(path: string): string[] {
	if (!existsSync(path)) return [];
	try {
		return readdirSync(path, { withFileTypes: true })
			.filter((e) => e.isFile())
			.map((e) => e.name);
	} catch {
		return [];
	}
}

function removeIfEmpty(path: string): void {
	try {
		rmdirSync(path);
	} catch {
		// Not empty or already gone — either way, leave it.
	}
}
