import { describe, expect, it } from 'vitest';
import { AssetStorageError } from '../src/assets/errors';
import { parseAssetStorageUrl } from '../src/assets/url';
import { redactAssetStorageUrl } from '../src/lib/asset-storage-info';

describe('parseAssetStorageUrl', () => {
	it('parses a full URL with prefix and explicit params', () => {
		const parsed = parseAssetStorageUrl(
			's3://AKID:SECRET@minio.internal:9000/hezo/prod-assets?region=eu-west-1&pathStyle=true&tls=false',
		);
		expect(parsed).toEqual({
			endpoint: 'minio.internal:9000',
			bucket: 'hezo',
			prefix: 'prod-assets',
			region: 'eu-west-1',
			pathStyle: true,
			tls: false,
			accessKeyId: 'AKID',
			secretAccessKey: 'SECRET',
		});
	});

	it('defaults region, tls, and pathStyle (true for custom endpoints)', () => {
		const parsed = parseAssetStorageUrl('s3://k:s@storage.example.com/bucket');
		expect(parsed.region).toBe('us-east-1');
		expect(parsed.tls).toBe(true);
		expect(parsed.pathStyle).toBe(true);
		expect(parsed.prefix).toBe('');
	});

	it('defaults to virtual-hosted addressing on amazonaws.com endpoints', () => {
		const parsed = parseAssetStorageUrl('s3://k:s@s3.us-west-2.amazonaws.com/bucket');
		expect(parsed.pathStyle).toBe(false);
		expect(parsed.region).toBe('us-east-1');
	});

	it('percent-decodes credentials and multi-segment prefixes', () => {
		const parsed = parseAssetStorageUrl('s3://key%2Fid:se%2Bcr%40t@host:9000/b/deep/prefix');
		expect(parsed.accessKeyId).toBe('key/id');
		expect(parsed.secretAccessKey).toBe('se+cr@t');
		expect(parsed.prefix).toBe('deep/prefix');
	});

	it.each([
		['not a url', 'not a parseable URL'],
		['postgres://k:s@host/bucket', 'scheme must be s3://'],
		['s3:///bucket', 'missing endpoint host'],
		['s3://host/bucket', 'missing credentials'],
		['s3://k:s@host', 'missing bucket'],
		['s3://k:s@host/bucket?pathStyle=maybe', 'must be true or false'],
	])('rejects %s', (raw, messagePart) => {
		expect(() => parseAssetStorageUrl(raw)).toThrowError(AssetStorageError);
		expect(() => parseAssetStorageUrl(raw)).toThrowError(new RegExp(messagePart));
	});

	it('never echoes the credentials in a rejection message', () => {
		try {
			parseAssetStorageUrl('s3://k:supersecret@host/bucket?pathStyle=nope');
			expect.unreachable();
		} catch (err) {
			expect((err as Error).message).not.toContain('supersecret');
		}
	});
});

describe('redactAssetStorageUrl', () => {
	it('occludes credentials and keeps endpoint, bucket/prefix, and whitelisted params', () => {
		const redacted = redactAssetStorageUrl(
			's3://AKID:SECRET@minio.internal:9000/hezo/prod?region=eu-west-1&pathStyle=true&tls=false&secretParam=x',
		);
		expect(redacted).toBe(
			's3://••••:••••@minio.internal:9000/hezo/prod?region=eu-west-1&pathStyle=true&tls=false',
		);
		expect(redacted).not.toContain('AKID');
		expect(redacted).not.toContain('SECRET');
		expect(redacted).not.toContain('secretParam');
	});

	it('fully occludes malformed or non-s3 input', () => {
		expect(redactAssetStorageUrl('complete garbage')).toBe('••••');
		expect(redactAssetStorageUrl('postgres://user:pass@host/db')).toBe('••••');
	});
});
