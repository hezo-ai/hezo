import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AssetStorageError } from '../src/assets/errors';
import { openAssetStorage } from '../src/assets/open';
import { createS3Sim, type S3Sim } from './helpers/s3-sim';

describe('openAssetStorage', () => {
	let dataDir: string;
	let sim: S3Sim;

	beforeAll(async () => {
		dataDir = mkdtempSync(join(tmpdir(), 'hezo-asset-open-'));
		sim = await createS3Sim();
	});
	afterAll(async () => {
		rmSync(dataDir, { recursive: true, force: true });
		await sim.destroy();
	});

	it('selects the local driver when no URL is configured', async () => {
		const { store, info } = await openAssetStorage({ dataDir });
		expect(store.kind).toBe('local');
		expect(info).toEqual({ backend: 'local', display: join(dataDir, 'assets') });
		await store.close();
	});

	it('rejects a non-s3 scheme with an operator-actionable error', async () => {
		await expect(
			openAssetStorage({ dataDir, assetStorageUrl: 'gs://k:s@host/bucket' }),
		).rejects.toThrowError(/scheme must be s3:\/\//);
	});

	it('opens the S3 driver after a successful preflight and redacts the info display', async () => {
		const { store, info } = await openAssetStorage({
			dataDir,
			assetStorageUrl: sim.storeUrl('preflight-prefix'),
		});
		expect(store.kind).toBe('s3');
		expect(info.backend).toBe('s3');
		expect(info.display).toContain('••••:••••@');
		expect(info.display).toContain(`/${sim.bucket}/preflight-prefix`);
		expect(info.display).not.toContain(sim.secretAccessKey);
		await store.close();
	});

	it('retries the preflight, then fails with a redacted AssetStorageError', async () => {
		// A closed port: connection refused on every attempt.
		const url = `s3://k:very-secret@127.0.0.1:1/bucket?tls=false&pathStyle=true`;
		const start = Date.now();
		try {
			await openAssetStorage({ dataDir, assetStorageUrl: url, retryDelaysMs: [10, 10] });
			expect.unreachable();
		} catch (err) {
			expect(err).toBeInstanceOf(AssetStorageError);
			const message = (err as Error).message;
			expect(message).toContain('••••:••••@127.0.0.1:1');
			expect(message).not.toContain('very-secret');
			expect(message).toContain('--asset-storage-url');
		}
		// Both injected retry delays elapsed (bounded retry, no long default backoff).
		expect(Date.now() - start).toBeGreaterThanOrEqual(20);
	});

	it('recovers when the endpoint comes back within the retry budget', async () => {
		sim.failNext('list');
		const { store } = await openAssetStorage({
			dataDir,
			assetStorageUrl: sim.storeUrl(),
			retryDelaysMs: [10, 10],
		});
		expect(store.kind).toBe('s3');
		await store.close();
	});
});
