import { createServer, type Server } from 'node:http';
import { Hono } from 'hono';

/**
 * In-process S3-compatible object store for tests (the `github-sim.ts`
 * pattern): a Hono app bridged through a real `node:http` server on port 0,
 * with objects in a Map. Implements exactly the wire surface the thin
 * `S3Client` speaks — path-style PutObject / GetObject / DeleteObject /
 * ListObjectsV2 (with continuation-token pagination) / batch DeleteObjects —
 * so the S3 driver and conformance suites run everywhere with no Docker or
 * external MinIO.
 *
 * Auth is checked shallowly: the Authorization header must be SigV4-shaped and
 * carry the seeded access key id (catches signing/credential wiring bugs
 * without reimplementing SigV4 verification).
 */

export interface S3SimObject {
	body: Buffer;
	contentType: string;
	meta: Record<string, string>;
}

export type S3SimOp = 'put' | 'get' | 'delete' | 'list' | 'batch-delete';

export interface S3Sim {
	baseUrl: string;
	accessKeyId: string;
	secretAccessKey: string;
	bucket: string;
	/** Key → object. Inspect/seed directly. */
	objects: Map<string, S3SimObject>;
	/** Full `s3://…?tls=false&pathStyle=true` URL for `--asset-storage-url`. */
	storeUrl(prefix?: string): string;
	/** Make the next request of the given op fail with a 500 InternalError. */
	failNext(op: S3SimOp): void;
	destroy(): Promise<void>;
}

function xmlEscape(value: string): string {
	return value
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&apos;');
}

function xmlUnescape(value: string): string {
	return value
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&quot;/g, '"')
		.replace(/&apos;/g, "'")
		.replace(/&amp;/g, '&');
}

function errorXml(code: string, message: string): string {
	return `<?xml version="1.0" encoding="UTF-8"?><Error><Code>${code}</Code><Message>${xmlEscape(message)}</Message></Error>`;
}

export interface S3SimOptions {
	/**
	 * Server-side page-size cap for ListObjectsV2 — set it small (e.g. 2) to
	 * force continuation-token pagination in tests.
	 */
	pageSize?: number;
	bucket?: string;
}

export async function createS3Sim(options: S3SimOptions = {}): Promise<S3Sim> {
	const accessKeyId = 'sim-access-key';
	const secretAccessKey = 'sim-secret-key';
	const bucket = options.bucket ?? 'hezo-test';
	const pageSize = options.pageSize ?? 1000;
	const objects = new Map<string, S3SimObject>();
	const failures = new Set<S3SimOp>();

	const failIfArmed = (op: S3SimOp): boolean => {
		if (!failures.has(op)) return false;
		failures.delete(op);
		return true;
	};

	const app = new Hono();

	app.all('*', async (c) => {
		const auth = c.req.header('Authorization') ?? '';
		if (!auth.startsWith('AWS4-HMAC-SHA256 ') || !auth.includes(`Credential=${accessKeyId}/`)) {
			return c.body(errorXml('SignatureDoesNotMatch', 'Bad or missing SigV4 authorization'), 403, {
				'Content-Type': 'application/xml',
			});
		}

		const url = new URL(c.req.url);
		const segments = url.pathname.split('/').filter((s) => s.length > 0);
		const [reqBucket, ...keyParts] = segments.map(decodeURIComponent);
		if (reqBucket !== bucket) {
			return c.body(errorXml('NoSuchBucket', `Bucket '${reqBucket ?? ''}' does not exist`), 404, {
				'Content-Type': 'application/xml',
			});
		}

		// Bucket-level operations.
		if (keyParts.length === 0) {
			if (c.req.method === 'GET' && url.searchParams.get('list-type') === '2') {
				if (failIfArmed('list')) {
					return c.body(errorXml('InternalError', 'injected failure'), 500, {
						'Content-Type': 'application/xml',
					});
				}
				const prefix = url.searchParams.get('prefix') ?? '';
				const maxKeysParam = Number(url.searchParams.get('max-keys') ?? '1000');
				const limit = Math.min(Number.isFinite(maxKeysParam) ? maxKeysParam : 1000, pageSize);
				const token = url.searchParams.get('continuation-token');
				const all = [...objects.keys()].filter((k) => k.startsWith(prefix)).sort();
				const start = token ? Number(Buffer.from(token, 'base64').toString('utf-8')) : 0;
				const page = all.slice(start, start + limit);
				const truncated = start + page.length < all.length;
				const nextToken = truncated
					? Buffer.from(String(start + page.length), 'utf-8').toString('base64')
					: null;
				const xml =
					'<?xml version="1.0" encoding="UTF-8"?><ListBucketResult>' +
					`<IsTruncated>${truncated}</IsTruncated>` +
					(nextToken
						? `<NextContinuationToken>${xmlEscape(nextToken)}</NextContinuationToken>`
						: '') +
					page.map((k) => `<Contents><Key>${xmlEscape(k)}</Key></Contents>`).join('') +
					'</ListBucketResult>';
				return c.body(xml, 200, { 'Content-Type': 'application/xml' });
			}
			if (c.req.method === 'POST' && url.searchParams.has('delete')) {
				if (failIfArmed('batch-delete')) {
					return c.body(errorXml('InternalError', 'injected failure'), 500, {
						'Content-Type': 'application/xml',
					});
				}
				if (!c.req.header('content-md5')) {
					return c.body(errorXml('InvalidRequest', 'Missing required header: Content-MD5'), 400, {
						'Content-Type': 'application/xml',
					});
				}
				const body = await c.req.text();
				for (const m of body.matchAll(/<Key>([^<]*)<\/Key>/g)) {
					objects.delete(xmlUnescape(m[1]));
				}
				return c.body('<?xml version="1.0" encoding="UTF-8"?><DeleteResult></DeleteResult>', 200, {
					'Content-Type': 'application/xml',
				});
			}
			return c.body(errorXml('NotImplemented', `${c.req.method} on bucket`), 501, {
				'Content-Type': 'application/xml',
			});
		}

		// Object-level operations.
		const key = keyParts.join('/');
		if (c.req.method === 'PUT') {
			if (failIfArmed('put')) {
				return c.body(errorXml('InternalError', 'injected failure'), 500, {
					'Content-Type': 'application/xml',
				});
			}
			const meta: Record<string, string> = {};
			for (const [name, value] of Object.entries(c.req.header())) {
				if (name.toLowerCase().startsWith('x-amz-meta-')) {
					meta[name.toLowerCase().slice('x-amz-meta-'.length)] = value;
				}
			}
			objects.set(key, {
				body: Buffer.from(await c.req.arrayBuffer()),
				contentType: c.req.header('content-type') ?? 'application/octet-stream',
				meta,
			});
			return c.body(null, 200);
		}
		if (c.req.method === 'GET' || c.req.method === 'HEAD') {
			if (failIfArmed('get')) {
				return c.body(errorXml('InternalError', 'injected failure'), 500, {
					'Content-Type': 'application/xml',
				});
			}
			const found = objects.get(key);
			if (!found) {
				return c.body(errorXml('NoSuchKey', 'The specified key does not exist.'), 404, {
					'Content-Type': 'application/xml',
				});
			}
			const headers: Record<string, string> = {
				'Content-Type': found.contentType,
				'Content-Length': String(found.body.byteLength),
			};
			for (const [name, value] of Object.entries(found.meta)) {
				headers[`x-amz-meta-${name}`] = value;
			}
			if (c.req.method === 'HEAD') return c.body(null, 200, headers);
			const ab = new ArrayBuffer(found.body.byteLength);
			new Uint8Array(ab).set(found.body);
			return c.body(ab, 200, headers);
		}
		if (c.req.method === 'DELETE') {
			if (failIfArmed('delete')) {
				return c.body(errorXml('InternalError', 'injected failure'), 500, {
					'Content-Type': 'application/xml',
				});
			}
			objects.delete(key);
			return c.body(null, 204);
		}
		return c.body(errorXml('NotImplemented', `${c.req.method} on object`), 501, {
			'Content-Type': 'application/xml',
		});
	});

	const server: Server = createServer(async (req, res) => {
		const url = `http://localhost${req.url}`;
		const headers = new Headers();
		for (const [key, value] of Object.entries(req.headers)) {
			if (value) headers.set(key, Array.isArray(value) ? value.join(', ') : value);
		}

		const chunks: Buffer[] = [];
		for await (const chunk of req) chunks.push(chunk);
		const body = chunks.length > 0 ? Buffer.concat(chunks) : undefined;

		const response = await app.fetch(
			new Request(url, {
				method: req.method,
				headers,
				body: body && req.method !== 'GET' && req.method !== 'HEAD' ? body : undefined,
			}),
		);

		res.writeHead(response.status, Object.fromEntries(response.headers.entries()));
		const responseBody = await response.arrayBuffer();
		res.end(Buffer.from(responseBody));
	});

	await new Promise<void>((resolve) => server.listen(0, resolve));
	const addr = server.address();
	const port = typeof addr === 'object' && addr ? addr.port : 0;

	return {
		baseUrl: `http://localhost:${port}`,
		accessKeyId,
		secretAccessKey,
		bucket,
		objects,
		storeUrl(prefix?: string) {
			const path = prefix ? `/${bucket}/${prefix}` : `/${bucket}`;
			return `s3://${accessKeyId}:${secretAccessKey}@localhost:${port}${path}?tls=false&pathStyle=true`;
		},
		failNext(op) {
			failures.add(op);
		},
		async destroy() {
			await new Promise<void>((resolve) => server.close(() => resolve()));
		},
	};
}
