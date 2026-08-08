import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LocalAssetStore } from '../src/assets/drivers/local';
import { S3AssetStore } from '../src/assets/drivers/s3';
import { AssetNotFoundError, type AssetStore, AttachmentTooLargeError } from '../src/assets/store';
import { parseAssetStorageUrl } from '../src/assets/url';
import { blobBytes } from './helpers';
import { createS3Sim, type S3Sim } from './helpers/s3-sim';

/**
 * Driver conformance contract: every `AssetStore` driver must behave
 * identically through the interface. A behavior difference between drivers is
 * a bug in the driver, not in this suite. The local and sim-backed S3 legs
 * always run; an extra leg against a real S3-compatible endpoint runs when
 * HEZO_TEST_ASSET_STORAGE_URL is set (the CI `test-s3` MinIO job).
 */

interface DriverHarness {
	store: AssetStore;
	cleanup: () => Promise<void>;
}

type DriverFactory = () => Promise<DriverHarness>;

const drivers: Array<[string, DriverFactory]> = [
	[
		'local',
		async () => {
			const dataDir = mkdtempSync(join(tmpdir(), 'hezo-asset-conformance-'));
			return {
				store: new LocalAssetStore(dataDir),
				cleanup: async () => rmSync(dataDir, { recursive: true, force: true }),
			};
		},
	],
	[
		's3 (sim)',
		async () => {
			// pageSize 2 forces ListObjectsV2 pagination through deleteProjectAssets.
			const sim = await createS3Sim({ pageSize: 2 });
			const store = new S3AssetStore(parseAssetStorageUrl(sim.storeUrl('team-prefix')));
			return { store, cleanup: () => sim.destroy() };
		},
	],
];

// Optional real-endpoint leg (e.g. MinIO in CI): a run-scoped prefix keeps
// concurrent runs from colliding, and the tests delete what they create.
if (process.env.HEZO_TEST_ASSET_STORAGE_URL) {
	drivers.push([
		's3 (external)',
		async () => {
			const base = new URL(process.env.HEZO_TEST_ASSET_STORAGE_URL as string);
			base.pathname = `${base.pathname.replace(/\/$/, '')}/conformance-${randomUUID()}`;
			const store = new S3AssetStore(parseAssetStorageUrl(base.toString()));
			return { store, cleanup: async () => {} };
		},
	]);
}

function blob(bytes: Buffer, type = 'application/octet-stream'): Blob {
	const ab = new ArrayBuffer(bytes.byteLength);
	new Uint8Array(ab).set(bytes);
	return new Blob([ab], { type });
}

describe.each(drivers)('AssetStore conformance: %s', (_name, factory) => {
	let h: DriverHarness;
	const projectId = randomUUID();

	beforeAll(async () => {
		h = await factory();
	});
	afterAll(async () => {
		await h.cleanup();
	});

	it('writes and reads a blob back byte-identical, reporting size and sha256', async () => {
		const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02, 0xff]);
		const assetId = randomUUID();
		const result = await h.store.write(projectId, assetId, blob(bytes, 'image/png'));
		expect(result.byteSize).toBe(bytes.byteLength);
		expect(result.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));

		const read = await h.store.read(projectId, assetId);
		expect(Buffer.compare(read, bytes)).toBe(0);
	});

	it('rejects a blob over the attachment cap and persists nothing', async () => {
		const assetId = randomUUID();
		const big = Buffer.alloc(10 * 1024 * 1024 + 1, 1);
		await expect(h.store.write(projectId, assetId, blob(big))).rejects.toBeInstanceOf(
			AttachmentTooLargeError,
		);
		await expect(h.store.read(projectId, assetId)).rejects.toBeInstanceOf(AssetNotFoundError);
	});

	it('throws AssetNotFoundError for a missing blob', async () => {
		await expect(h.store.read(projectId, randomUUID())).rejects.toBeInstanceOf(AssetNotFoundError);
	});

	it('delete is idempotent and removes the blob', async () => {
		const assetId = randomUUID();
		await h.store.write(projectId, assetId, blob(Buffer.from('bye')));
		await h.store.delete(projectId, assetId);
		await h.store.delete(projectId, assetId);
		await expect(h.store.read(projectId, assetId)).rejects.toBeInstanceOf(AssetNotFoundError);
	});

	it('deleteProjectAssets removes every blob in the project and only that project', async () => {
		// More blobs than the sim's list page size, so the S3 leg must paginate.
		const doomed = Array.from({ length: 5 }, () => randomUUID());
		for (const id of doomed) {
			await h.store.write(projectId, id, blob(Buffer.from(`doomed-${id}`)));
		}
		const otherProject = randomUUID();
		const survivor = randomUUID();
		await h.store.write(otherProject, survivor, blob(Buffer.from('survivor')));

		await h.store.deleteProjectAssets(projectId);

		for (const id of doomed) {
			await expect(h.store.read(projectId, id)).rejects.toBeInstanceOf(AssetNotFoundError);
		}
		const kept = await h.store.read(otherProject, survivor);
		expect(kept.toString('utf-8')).toBe('survivor');
		await h.store.deleteProjectAssets(otherProject);
	});

	it('deleteProjectAssets on a project with no blobs is a no-op', async () => {
		await h.store.deleteProjectAssets(randomUUID());
	});
});
