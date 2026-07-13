/**
 * Asset-blob backup/restore — the asset half of a Hezo "backup bundle", the
 * counterpart to `db/logical-backup.ts` for the database half. A bundle is a
 * directory:
 *
 *   hezo-<timestamp>/
 *     database.backup.gz          # db/logical-backup.ts output (omitted with --no-database)
 *     assets/<projectId>/<assetId>  # one file per blob (omitted with --no-assets)
 *     manifest.json               # written LAST — the completion marker
 *
 * Blobs use the same relative `<projectId>/<assetId>` layout the local driver
 * writes on disk and the S3 driver uses as its key, so a bundle round-trips
 * across backends unchanged — which is how an instance migrates its assets
 * between the local filesystem and S3-compatible object storage.
 *
 * Backup enumerates the authoritative `assets` table (the store may hold orphan
 * blobs whose rows are gone — those must not travel). Restore enumerates the
 * bundle's own `assets/` tree (the ground truth of what was captured, so an
 * assets-only bundle restores without freshly-loaded rows), verifying every
 * written blob's sha256+size against the target `assets` row when one exists.
 * Every blob is capped at `ATTACHMENT_MAX_BYTES` (10 MB), so a per-blob Buffer
 * is always safe; only aggregate size is unbounded, so copies run one blob at a
 * time with bounded concurrency.
 */

import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Db } from '../db/database';
import { logger } from '../logger';
import { AssetNotFoundError, type AssetStore } from './store';

const log = logger.child('asset-backup');

export const BUNDLE_KIND = 'hezo-backup-bundle';
export const BUNDLE_FORMAT_VERSION = 1;
export const BUNDLE_MANIFEST_NAME = 'manifest.json';
export const BUNDLE_DB_NAME = 'database.backup.gz';
export const BUNDLE_ASSETS_DIR = 'assets';

const ASSET_ENUM_PAGE_SIZE = 1000;
const ASSET_COPY_CONCURRENCY = 8;

export interface BundleManifestAssets {
	backend: AssetStore['kind'];
	count: number;
	totalBytes: number;
	/** `<projectId>/<assetId>` keys whose blob was absent at the source (dangling rows). */
	missing: string[];
}

export interface BundleManifest {
	kind: typeof BUNDLE_KIND;
	bundleFormatVersion: number;
	hezoVersion: string;
	createdAt: string;
	database: { file: string } | null;
	assets: BundleManifestAssets | null;
}

export interface AssetBackupSummary {
	count: number;
	bytes: number;
	/** `<projectId>/<assetId>` keys whose blob was missing at the source. */
	missing: string[];
}

export interface AssetRestoreSummary {
	count: number;
	bytes: number;
	/** Blobs whose sha256+size matched a row in the target `assets` table. */
	verified: number;
	/** Blobs written with no matching target row to verify against. */
	unverified: number;
}

interface AssetRow {
	id: string;
	project_id: string;
	content_type: string;
	sha256: string;
	byte_size: number | string;
}

interface BundleBlobRef {
	projectId: string;
	assetId: string;
}

/**
 * Run `fn` over `items` with at most `limit` in flight. A rejection propagates
 * (aborting the copy); other in-flight tasks settle but no new ones start.
 */
async function forEachConcurrent<T>(
	items: T[],
	limit: number,
	fn: (item: T) => Promise<void>,
): Promise<void> {
	let next = 0;
	const workerCount = Math.min(limit, items.length);
	const workers: Promise<void>[] = [];
	for (let i = 0; i < workerCount; i++) {
		workers.push(
			(async () => {
				for (;;) {
					const idx = next++;
					if (idx >= items.length) return;
					await fn(items[idx]);
				}
			})(),
		);
	}
	await Promise.all(workers);
}

/** Every `assets` row, paged, ordered stably. Read-only; caller ensures a quiescent DB. */
async function enumerateAssetRows(db: Db): Promise<AssetRow[]> {
	const rows: AssetRow[] = [];
	let offset = 0;
	for (;;) {
		const page = await db.query<AssetRow>(
			`SELECT id, project_id, content_type, sha256, byte_size FROM assets
			 ORDER BY project_id, id LIMIT $1 OFFSET $2`,
			[ASSET_ENUM_PAGE_SIZE, offset],
		);
		rows.push(...page.rows);
		if (page.rows.length < ASSET_ENUM_PAGE_SIZE) break;
		offset += page.rows.length;
	}
	return rows;
}

/** Walk `<bundleDir>/assets/<projectId>/<assetId>` into blob references. */
async function enumerateBundleBlobs(assetsRoot: string): Promise<BundleBlobRef[]> {
	if (!existsSync(assetsRoot)) return [];
	const refs: BundleBlobRef[] = [];
	for (const projectEntry of await readdir(assetsRoot, { withFileTypes: true })) {
		if (!projectEntry.isDirectory()) continue;
		const projectId = projectEntry.name;
		for (const assetEntry of await readdir(join(assetsRoot, projectId), { withFileTypes: true })) {
			if (assetEntry.isFile()) refs.push({ projectId, assetId: assetEntry.name });
		}
	}
	return refs;
}

/**
 * Copy every asset blob from `store` into `<bundleDir>/assets/<projectId>/<assetId>`.
 * A row whose blob is absent at the source (`AssetNotFoundError` — a dangling
 * row) is recorded in `missing` and skipped rather than aborting a large
 * backup; any other read failure (a 5xx / transport error) propagates.
 */
export async function dumpAssetBlobs(
	db: Db,
	store: AssetStore,
	bundleDir: string,
): Promise<AssetBackupSummary> {
	const rows = await enumerateAssetRows(db);
	const assetsRoot = join(bundleDir, BUNDLE_ASSETS_DIR);
	const preparedDirs = new Set<string>();
	const missing: string[] = [];
	let count = 0;
	let bytes = 0;

	await forEachConcurrent(rows, ASSET_COPY_CONCURRENCY, async (row) => {
		let buf: Buffer;
		try {
			buf = await store.read(row.project_id, row.id);
		} catch (err) {
			if (err instanceof AssetNotFoundError) {
				missing.push(`${row.project_id}/${row.id}`);
				log.warn(`Asset blob ${row.project_id}/${row.id} missing at source; skipping.`);
				return;
			}
			throw err;
		}
		const projectDir = join(assetsRoot, row.project_id);
		if (!preparedDirs.has(projectDir)) {
			await mkdir(projectDir, { recursive: true });
			preparedDirs.add(projectDir);
		}
		await writeFile(join(projectDir, row.id), buf);
		count += 1;
		bytes += buf.byteLength;
	});

	return { count, bytes, missing };
}

/**
 * Write every blob in the bundle's `assets/` tree into `store`. Each write
 * recomputes the sha256, which is asserted against the target `assets` row when
 * one exists (a genuine end-to-end integrity check); a mismatch throws. Blobs
 * with no matching row are written unverified unless `strict` is set, which
 * requires every restored blob to be verifiable. Writes are idempotent by
 * `(projectId, assetId)`, so a partial restore is safe to re-run.
 */
export async function restoreAssetBlobs(
	db: Db,
	store: AssetStore,
	bundleDir: string,
	options: { strict?: boolean } = {},
): Promise<AssetRestoreSummary> {
	const assetsRoot = join(bundleDir, BUNDLE_ASSETS_DIR);
	const blobs = await enumerateBundleBlobs(assetsRoot);
	const rowsById = new Map<string, AssetRow>();
	for (const row of await enumerateAssetRows(db)) rowsById.set(row.id, row);

	let count = 0;
	let bytes = 0;
	let verified = 0;
	let unverified = 0;

	await forEachConcurrent(blobs, ASSET_COPY_CONCURRENCY, async ({ projectId, assetId }) => {
		const buf = await readFile(join(assetsRoot, projectId, assetId));
		const row = rowsById.get(assetId);
		const contentType = row?.content_type || 'application/octet-stream';
		const result = await store.write(projectId, assetId, new Blob([buf], { type: contentType }));
		if (row) {
			if (result.sha256 !== row.sha256 || result.byteSize !== Number(row.byte_size)) {
				throw new Error(
					`Asset ${projectId}/${assetId} failed its integrity check after restore ` +
						`(expected sha256 ${row.sha256} / ${row.byte_size} bytes, ` +
						`got ${result.sha256} / ${result.byteSize} bytes). The backup may be corrupt.`,
				);
			}
			verified += 1;
		} else {
			if (options.strict) {
				throw new Error(
					`Asset ${projectId}/${assetId} has no matching row in the target database, so it ` +
						`cannot be integrity-checked. Restore the database half too, or drop --strict-assets.`,
				);
			}
			unverified += 1;
		}
		count += 1;
		bytes += buf.byteLength;
	});

	return { count, bytes, verified, unverified };
}

/** Write the manifest — the LAST step of a backup, so a half-written bundle has none. */
export async function writeBundleManifest(
	bundleDir: string,
	manifest: BundleManifest,
): Promise<void> {
	await mkdir(bundleDir, { recursive: true });
	await writeFile(join(bundleDir, BUNDLE_MANIFEST_NAME), `${JSON.stringify(manifest, null, 2)}\n`);
}

/** Read + validate a bundle manifest; throws an operator-actionable error otherwise. */
export async function readBundleManifest(bundleDir: string): Promise<BundleManifest> {
	const manifestPath = join(bundleDir, BUNDLE_MANIFEST_NAME);
	let raw: string;
	try {
		raw = await readFile(manifestPath, 'utf8');
	} catch {
		throw new Error(
			`${bundleDir} is not a Hezo backup bundle (no ${BUNDLE_MANIFEST_NAME}). ` +
				`Point restore at a "hezo backup" bundle directory or a .backup.gz file.`,
		);
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		throw new Error(`Corrupt backup bundle: ${BUNDLE_MANIFEST_NAME} is not valid JSON.`);
	}
	const manifest = parsed as Partial<BundleManifest>;
	if (manifest.kind !== BUNDLE_KIND || typeof manifest.bundleFormatVersion !== 'number') {
		throw new Error(`${bundleDir} is not a Hezo backup bundle (unexpected manifest contents).`);
	}
	if (manifest.bundleFormatVersion !== BUNDLE_FORMAT_VERSION) {
		throw new Error(
			`This backup bundle uses format v${manifest.bundleFormatVersion}; this Hezo build reads ` +
				`v${BUNDLE_FORMAT_VERSION}. Restore it with a matching Hezo version.`,
		);
	}
	return manifest as BundleManifest;
}

/** True when the backup path is a directory (a bundle) rather than a single file. */
export async function isBundleDir(path: string): Promise<boolean> {
	try {
		return (await stat(path)).isDirectory();
	} catch {
		return false;
	}
}
