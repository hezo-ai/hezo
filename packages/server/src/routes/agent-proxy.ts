import { AuthType, ProxyRejectionCode } from '@hezo/shared';
import type { Context } from 'hono';
import { Hono } from 'hono';
import type { Env } from '../lib/types';
import {
	type GrantedSecret,
	hostMatches,
	isBinaryContentType,
	loadGrantedSecrets,
	MAX_SUBSTITUTION_BYTES,
	substitute,
} from '../services/secret-proxy';

export const agentProxyRoutes = new Hono<Env>();

const HOP_BY_HOP_HEADERS = new Set([
	'connection',
	'keep-alive',
	'proxy-authenticate',
	'proxy-authorization',
	'te',
	'trailer',
	'transfer-encoding',
	'upgrade',
	'host',
	'content-length',
]);

function isStrippedRequestHeader(name: string): boolean {
	const lower = name.toLowerCase();
	if (HOP_BY_HOP_HEADERS.has(lower)) return true;
	if (lower.startsWith('hezo-') || lower.startsWith('x-hezo-')) return true;
	if (lower.startsWith('x-forwarded-')) return true;
	return false;
}

function isStrippedResponseHeader(name: string): boolean {
	const lower = name.toLowerCase();
	if (HOP_BY_HOP_HEADERS.has(lower)) return true;
	return false;
}

interface AuditFields {
	companyId: string;
	runId: string;
	memberId: string;
	secretIds: string[];
	targetHost: string;
	targetMethod: string;
	statusCode: number | null;
	rejectionCode: ProxyRejectionCode | null;
	requestBytes: number;
	responseBytes: number;
	durationMs: number;
}

async function writeAudit(c: Context<Env>, fields: AuditFields): Promise<void> {
	const db = c.get('db');
	try {
		await db.query(
			`INSERT INTO secret_proxy_audit
			   (company_id, run_id, member_id, secret_ids, target_host, target_method,
			    status_code, rejection_code, request_bytes, response_bytes, duration_ms)
			 VALUES ($1, $2, $3, $4::uuid[], $5, $6, $7, $8, $9, $10, $11)`,
			[
				fields.companyId,
				fields.runId,
				fields.memberId,
				fields.secretIds,
				fields.targetHost,
				fields.targetMethod,
				fields.statusCode,
				fields.rejectionCode,
				fields.requestBytes,
				fields.responseBytes,
				fields.durationMs,
			],
		);
	} catch {
		// Audit write must never break the proxy response — log loss is acceptable.
	}
}

agentProxyRoutes.all('/proxy/*', async (c) => {
	const auth = c.get('auth');
	if (auth.type !== AuthType.Agent) {
		return c.json({ error: { code: 'UNAUTHORIZED', message: 'Agent token required' } }, 401);
	}

	const startedAt = Date.now();

	const fullUrl = new URL(c.req.url);
	const PREFIX = '/agent-api/proxy/';
	const prefixIdx = fullUrl.pathname.indexOf(PREFIX);
	if (prefixIdx === -1) {
		return c.json(
			{ error: { code: ProxyRejectionCode.InvalidTarget, message: 'Invalid proxy path' } },
			400,
		);
	}
	const rawTarget = fullUrl.pathname.slice(prefixIdx + PREFIX.length) + fullUrl.search;

	if (rawTarget.length === 0) {
		return c.json(
			{ error: { code: ProxyRejectionCode.InvalidTarget, message: 'Missing target URL' } },
			400,
		);
	}

	let parsed: URL;
	try {
		parsed = new URL(rawTarget);
	} catch {
		return c.json(
			{ error: { code: ProxyRejectionCode.InvalidTarget, message: 'Invalid target URL' } },
			400,
		);
	}
	if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
		return c.json(
			{ error: { code: ProxyRejectionCode.InvalidTarget, message: 'Unsupported scheme' } },
			400,
		);
	}

	const auditBase = {
		companyId: auth.companyId,
		runId: auth.runId,
		memberId: auth.memberId,
		targetHost: parsed.hostname.toLowerCase(),
		targetMethod: c.req.method,
	};

	const db = c.get('db');
	const masterKeyManager = c.get('masterKeyManager');
	const granted = await loadGrantedSecrets(db, masterKeyManager, auth.memberId);

	const referencedById = new Map<string, GrantedSecret>();
	const ungrantedNames = new Set<string>();
	const collect = (res: ReturnType<typeof substitute>) => {
		for (const r of res.referenced) referencedById.set(r.id, r);
		for (const u of res.ungrantedNames) ungrantedNames.add(u);
	};

	const urlSub = substitute(rawTarget, granted);
	collect(urlSub);
	let substitutedTarget: URL;
	try {
		substitutedTarget = new URL(urlSub.output);
	} catch {
		await writeAudit(c, {
			...auditBase,
			secretIds: [],
			statusCode: null,
			rejectionCode: ProxyRejectionCode.InvalidTarget,
			requestBytes: 0,
			responseBytes: 0,
			durationMs: Date.now() - startedAt,
		});
		return c.json(
			{ error: { code: ProxyRejectionCode.InvalidTarget, message: 'Invalid target URL' } },
			400,
		);
	}

	const outboundHeaders = new Headers();
	for (const [name, value] of c.req.raw.headers.entries()) {
		if (isStrippedRequestHeader(name)) continue;
		const sub = substitute(value, granted);
		collect(sub);
		outboundHeaders.set(name, sub.output);
	}
	outboundHeaders.set('host', substitutedTarget.host);
	outboundHeaders.set('via', '1.1 hezo-proxy');

	const contentLengthHeader = c.req.header('content-length');
	const contentType = c.req.header('content-type');
	const hasBody = c.req.method !== 'GET' && c.req.method !== 'HEAD';
	let outboundBody: BodyInit | undefined;
	let requestBytes = 0;

	if (hasBody) {
		if (contentLengthHeader) {
			const parsedLen = Number.parseInt(contentLengthHeader, 10);
			if (Number.isFinite(parsedLen) && parsedLen > MAX_SUBSTITUTION_BYTES) {
				await writeAudit(c, {
					...auditBase,
					secretIds: [],
					statusCode: null,
					rejectionCode: ProxyRejectionCode.BodyTooLarge,
					requestBytes: parsedLen,
					responseBytes: 0,
					durationMs: Date.now() - startedAt,
				});
				return c.json(
					{ error: { code: ProxyRejectionCode.BodyTooLarge, message: 'Request body too large' } },
					413,
				);
			}
		}

		const rawBody = new Uint8Array(await c.req.arrayBuffer());
		requestBytes = rawBody.byteLength;
		if (requestBytes > MAX_SUBSTITUTION_BYTES) {
			await writeAudit(c, {
				...auditBase,
				secretIds: [],
				statusCode: null,
				rejectionCode: ProxyRejectionCode.BodyTooLarge,
				requestBytes,
				responseBytes: 0,
				durationMs: Date.now() - startedAt,
			});
			return c.json(
				{ error: { code: ProxyRejectionCode.BodyTooLarge, message: 'Request body too large' } },
				413,
			);
		}

		if (isBinaryContentType(contentType)) {
			outboundBody = rawBody;
		} else if (rawBody.byteLength === 0) {
			outboundBody = undefined;
		} else {
			const text = new TextDecoder('utf-8').decode(rawBody);
			const sub = substitute(text, granted);
			collect(sub);
			const encoded = new TextEncoder().encode(sub.output);
			outboundBody = encoded;
			requestBytes = encoded.byteLength;
			outboundHeaders.set('content-length', String(encoded.byteLength));
		}
	}

	if (ungrantedNames.size > 0) {
		await writeAudit(c, {
			...auditBase,
			secretIds: Array.from(referencedById.keys()),
			statusCode: null,
			rejectionCode: ProxyRejectionCode.UngrantedSecret,
			requestBytes,
			responseBytes: 0,
			durationMs: Date.now() - startedAt,
		});
		return c.json(
			{
				error: {
					code: ProxyRejectionCode.UngrantedSecret,
					message: 'Request references a secret that is not granted to this agent',
				},
			},
			400,
		);
	}

	const referenced = Array.from(referencedById.values());
	const targetHost = substitutedTarget.hostname.toLowerCase();
	for (const secret of referenced) {
		if (!hostMatches(targetHost, secret.hostAllowlist)) {
			await writeAudit(c, {
				...auditBase,
				targetHost,
				secretIds: referenced.map((s) => s.id),
				statusCode: null,
				rejectionCode: ProxyRejectionCode.HostNotAllowed,
				requestBytes,
				responseBytes: 0,
				durationMs: Date.now() - startedAt,
			});
			return c.json(
				{
					error: {
						code: ProxyRejectionCode.HostNotAllowed,
						message: 'Target host is not on the allowlist for the referenced secret',
					},
				},
				403,
			);
		}
	}

	let upstream: Response;
	try {
		upstream = await fetch(substitutedTarget, {
			method: c.req.method,
			headers: outboundHeaders,
			body: outboundBody,
			redirect: 'manual',
		});
	} catch (err) {
		const message = err instanceof Error ? err.message : 'Upstream fetch failed';
		await writeAudit(c, {
			...auditBase,
			targetHost,
			secretIds: referenced.map((s) => s.id),
			statusCode: null,
			rejectionCode: null,
			requestBytes,
			responseBytes: 0,
			durationMs: Date.now() - startedAt,
		});
		return c.json({ error: { code: 'UPSTREAM_ERROR', message } }, 502);
	}

	const responseHeaders = new Headers();
	for (const [name, value] of upstream.headers.entries()) {
		if (isStrippedResponseHeader(name)) continue;
		responseHeaders.set(name, value);
	}
	responseHeaders.set('via', '1.1 hezo-proxy');

	let responseBytes = 0;
	let outBody: ReadableStream<Uint8Array> | null = null;
	if (upstream.body) {
		const counted = new TransformStream<Uint8Array, Uint8Array>({
			transform(chunk, controller) {
				responseBytes += chunk.byteLength;
				controller.enqueue(chunk);
			},
			flush: async () => {
				await writeAudit(c, {
					...auditBase,
					targetHost,
					secretIds: referenced.map((s) => s.id),
					statusCode: upstream.status,
					rejectionCode: null,
					requestBytes,
					responseBytes,
					durationMs: Date.now() - startedAt,
				});
			},
		});
		outBody = upstream.body.pipeThrough(counted);
	} else {
		await writeAudit(c, {
			...auditBase,
			targetHost,
			secretIds: referenced.map((s) => s.id),
			statusCode: upstream.status,
			rejectionCode: null,
			requestBytes,
			responseBytes: 0,
			durationMs: Date.now() - startedAt,
		});
	}

	return new Response(outBody, {
		status: upstream.status,
		statusText: upstream.statusText,
		headers: responseHeaders,
	});
});
