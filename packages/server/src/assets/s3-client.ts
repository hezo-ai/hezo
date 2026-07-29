import { createHash } from 'node:crypto';
import { AwsClient } from 'aws4fetch';
import { asBodyBytes } from '../lib/bytes';
import type { ParsedAssetStorageUrl } from './url';

/**
 * Minimal S3 wire-protocol client — deliberately tiny. Hezo supports any
 * S3-*compatible* store (AWS S3, MinIO, R2, Spaces, B2, GCS interop, …) and
 * nothing provider-native, so the whole surface is five operations: PutObject,
 * GetObject, DeleteObject, ListObjectsV2, DeleteObjects. Requests are SigV4-
 * signed by `aws4fetch` over the runtime's own `fetch`, which keeps the
 * compiled binary lean and works identically under Bun (production) and Node
 * (vitest). Blobs are capped at ATTACHMENT_MAX_BYTES (10 MB), far below the
 * 5 GB single-PUT limit, so multipart upload is never needed.
 */

/** Per-request cap so a hung endpoint fails a request instead of wedging it. */
const REQUEST_TIMEOUT_MS = 30_000;

const DELETE_BATCH_MAX = 1000;

export class S3RequestError extends Error {
	constructor(
		readonly op: string,
		readonly status: number,
		detail: string,
	) {
		super(`S3 ${op} failed with HTTP ${status}${detail ? `: ${detail}` : ''}`);
		this.name = 'S3RequestError';
	}
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

/** First `<tag>…</tag>` text content, XML-unescaped; null when absent. */
function xmlText(xml: string, tag: string): string | null {
	const m = xml.match(new RegExp(`<${tag}>([^<]*)</${tag}>`));
	return m ? xmlUnescape(m[1]) : null;
}

function xmlTextAll(xml: string, tag: string): string[] {
	const out: string[] = [];
	for (const m of xml.matchAll(new RegExp(`<${tag}>([^<]*)</${tag}>`, 'g'))) {
		out.push(xmlUnescape(m[1]));
	}
	return out;
}

function encodeKey(key: string): string {
	return key.split('/').map(encodeURIComponent).join('/');
}

export interface ListPage {
	keys: string[];
	nextToken: string | null;
}

export class S3Client {
	private readonly aws: AwsClient;
	/** URL of the bucket root (no trailing slash), addressing style applied. */
	private readonly bucketUrl: string;

	constructor(options: ParsedAssetStorageUrl) {
		this.aws = new AwsClient({
			accessKeyId: options.accessKeyId,
			secretAccessKey: options.secretAccessKey,
			service: 's3',
			region: options.region,
			// aws4fetch retries 5xx responses up to 10 times by default. Retry
			// policy belongs to our callers (the startup preflight retries with
			// bounded backoff; request failures surface immediately) — implicit
			// retries would just mask outages and slow every failure down.
			retries: 0,
		});
		const scheme = options.tls ? 'https' : 'http';
		this.bucketUrl = options.pathStyle
			? `${scheme}://${options.endpoint}/${encodeURIComponent(options.bucket)}`
			: `${scheme}://${options.bucket}.${options.endpoint}`;
	}

	private async request(url: string, init: RequestInit): Promise<Response> {
		return this.aws.fetch(url, {
			...init,
			signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
		});
	}

	private async fail(op: string, res: Response): Promise<never> {
		const body = await res.text().catch(() => '');
		// Surface the provider's error code (<Code>AccessDenied</Code>, …) — the
		// most actionable part of an S3 error body — never the whole payload.
		const code = xmlText(body, 'Code');
		throw new S3RequestError(op, res.status, code ?? '');
	}

	async putObject(
		key: string,
		body: Buffer,
		contentType: string,
		meta: Record<string, string> = {},
	): Promise<void> {
		const headers: Record<string, string> = { 'content-type': contentType };
		for (const [name, value] of Object.entries(meta)) {
			headers[`x-amz-meta-${name}`] = value;
		}
		// Re-view the Buffer rather than copying it into a fresh ArrayBuffer: the
		// copy doubled peak memory for the duration of every upload, up to the
		// 10 MB attachment cap, per concurrent request. See `asBodyBytes`.
		const res = await this.request(`${this.bucketUrl}/${encodeKey(key)}`, {
			method: 'PUT',
			headers,
			body: asBodyBytes(body),
		});
		if (!res.ok) await this.fail('PutObject', res);
	}

	/** Returns the object bytes, or null when the key does not exist. */
	async getObject(key: string): Promise<Buffer | null> {
		const res = await this.request(`${this.bucketUrl}/${encodeKey(key)}`, {
			method: 'GET',
		});
		if (res.status === 404) {
			await res.arrayBuffer().catch(() => {});
			return null;
		}
		if (!res.ok) await this.fail('GetObject', res);
		return Buffer.from(await res.arrayBuffer());
	}

	/** Idempotent: S3 returns success for a key that never existed. */
	async deleteObject(key: string): Promise<void> {
		const res = await this.request(`${this.bucketUrl}/${encodeKey(key)}`, {
			method: 'DELETE',
		});
		if (!res.ok && res.status !== 404) await this.fail('DeleteObject', res);
	}

	/** One ListObjectsV2 page under `prefix`. */
	async listPage(
		prefix: string,
		opts: { maxKeys?: number; token?: string } = {},
	): Promise<ListPage> {
		const params = new URLSearchParams({ 'list-type': '2', prefix });
		if (opts.maxKeys !== undefined) params.set('max-keys', String(opts.maxKeys));
		if (opts.token) params.set('continuation-token', opts.token);
		const res = await this.request(`${this.bucketUrl}?${params}`, {
			method: 'GET',
		});
		if (!res.ok) await this.fail('ListObjectsV2', res);
		const xml = await res.text();
		return {
			keys: xmlTextAll(xml, 'Key'),
			nextToken:
				xmlText(xml, 'IsTruncated') === 'true' ? xmlText(xml, 'NextContinuationToken') : null,
		};
	}

	/** Every key under `prefix`, following continuation tokens to the end. */
	async listAllKeys(prefix: string): Promise<string[]> {
		const keys: string[] = [];
		let token: string | undefined;
		do {
			const page = await this.listPage(prefix, { token });
			keys.push(...page.keys);
			token = page.nextToken ?? undefined;
		} while (token);
		return keys;
	}

	/** Batch delete in chunks of 1000 (the DeleteObjects per-request cap). */
	async deleteObjects(keys: string[]): Promise<void> {
		for (let i = 0; i < keys.length; i += DELETE_BATCH_MAX) {
			const chunk = keys.slice(i, i + DELETE_BATCH_MAX);
			const body =
				'<?xml version="1.0" encoding="UTF-8"?>' +
				'<Delete xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Quiet>true</Quiet>' +
				chunk.map((k) => `<Object><Key>${xmlEscape(k)}</Key></Object>`).join('') +
				'</Delete>';
			const res = await this.request(`${this.bucketUrl}?delete`, {
				method: 'POST',
				headers: {
					'content-type': 'application/xml',
					// Required by the DeleteObjects API.
					'content-md5': createHash('md5').update(body).digest('base64'),
				},
				body,
			});
			if (!res.ok) await this.fail('DeleteObjects', res);
			// Quiet mode: the response only carries per-key <Error> entries.
			const xml = await res.text();
			const failed = xmlTextAll(xml, 'Key');
			if (failed.length > 0) {
				throw new S3RequestError(
					'DeleteObjects',
					res.status,
					`${failed.length} object(s) failed to delete (first: ${failed[0]})`,
				);
			}
		}
	}
}
