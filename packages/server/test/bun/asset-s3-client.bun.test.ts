import { describe, expect, it } from 'bun:test';
import { S3Client } from '../../src/assets/s3-client';
import { parseAssetStorageUrl } from '../../src/assets/url';
import { createS3Sim } from '../helpers/s3-sim';

/**
 * Production runs the S3 client on Bun, but vitest exercises it under Node —
 * and the client rides each runtime's own `fetch` + `crypto.subtle` (SigV4
 * signing via aws4fetch). This smoke test proves sign → PUT → GET → list →
 * batch-delete round-trips on the real Bun runtime, mirroring the
 * database-pg-driver precedent for runtime-sensitive code.
 */
describe('S3 client under Bun', () => {
	it('signs and round-trips put/get/list/delete against the sim', async () => {
		const sim = await createS3Sim({ pageSize: 2 });
		try {
			const client = new S3Client(parseAssetStorageUrl(sim.storeUrl('bun-smoke')));
			const bytes = Buffer.from('bun-native bytes');

			await client.putObject('bun-smoke/p1/a1', bytes, 'text/plain', { sha256: 'abc' });
			const got = await client.getObject('bun-smoke/p1/a1');
			expect(got).not.toBeNull();
			expect(Buffer.compare(got as Buffer, bytes)).toBe(0);
			expect(await client.getObject('bun-smoke/p1/missing')).toBeNull();

			await client.putObject('bun-smoke/p1/a2', bytes, 'text/plain');
			await client.putObject('bun-smoke/p1/a3', bytes, 'text/plain');
			const keys = await client.listAllKeys('bun-smoke/p1/');
			expect(keys.sort()).toEqual(['bun-smoke/p1/a1', 'bun-smoke/p1/a2', 'bun-smoke/p1/a3']);

			await client.deleteObjects(keys);
			expect(await client.listAllKeys('bun-smoke/p1/')).toEqual([]);
		} finally {
			await sim.destroy();
		}
	});
});
