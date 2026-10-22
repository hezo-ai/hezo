import { request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import { Readable } from 'node:stream';
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib';
import { runtimeConfig } from '../../config/runtime';
import { logger } from '../../logger';
import { HEZO_VERSION } from '../../version';
import {
	BlockedEgressTargetError,
	isBlockedEgressAddress,
	resolveGuardedAddress,
} from './net-guard';

const log = logger.child('guarded-fetch');

/**
 * `fetch` for a URL that came from outside the operator's own configuration.
 *
 * The egress proxy guards what an agent reaches from inside its container. This
 * guards what the **server** reaches on an agent's behalf: a skill file URL, a
 * connector's MCP endpoint, the OAuth metadata a connector's server points at.
 * The server runs on the host, so an unguarded `fetch` there is a server-side
 * request forgery primitive: `http://169.254.169.254/...` answers with the
 * cloud provider's instance metadata, which on a provisioned box carries the
 * boot document and every credential in it, and a private address reaches
 * whatever else shares the host's network.
 *
 * It applies the proxy's own rule (`isBlockedEgressAddress`) and its own way of
 * applying it: resolve, refuse a blocked address, then dial the address that was
 * checked, with the original name as TLS `servername` and `Host`. See
 * `resolveGuardedAddress` for why that is not a `lookup` option. A redirect is
 * followed by hand and every hop is checked the same way, because a public URL
 * that answers `302 Location: http://169.254.169.254/` is the first thing an
 * attacker tries.
 *
 * The operator switch that lets the proxy reach private targets
 * (`egress.allowPrivateTargets`) lets this through too, as a plain `fetch`: a
 * self-hoster whose MCP server lives on their LAN needs both or neither.
 *
 * It speaks the subset of `fetch` its callers use: any method, a body of any
 * `BodyInit` the platform can buffer, `signal`, and `redirect` (`follow`,
 * `manual`, `error`). The response body streams.
 */
export const guardedFetch: GuardedFetch = createGuardedFetch();

export type GuardedFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/**
 * {@link guardedFetch} under another blocking rule. Production uses the one
 * above; a test passes a rule that leaves one loopback address reachable, since
 * every server a test can start is on loopback.
 */
export function createGuardedFetch(
	isBlocked: (address: string) => boolean = isBlockedEgressAddress,
): GuardedFetch {
	return (input, init) => fetchGuarded(input, init, isBlocked);
}

async function fetchGuarded(
	input: string | URL | Request,
	init: RequestInit | undefined,
	isBlocked: (address: string) => boolean,
): Promise<Response> {
	if (runtimeConfig().egress.allowPrivateTargets) return fetch(input, init);

	// The platform normalises every input shape (headers, body encoding and its
	// content type, signal, redirect mode) so the dial below handles one.
	const request = new Request(input, init);
	const signal = request.signal;
	let url = new URL(request.url);
	let method = request.method;
	const headers = new Headers(request.headers);
	let body: Uint8Array | null =
		request.body === null ? null : new Uint8Array(await request.arrayBuffer());

	for (let hop = 0; ; hop++) {
		if (url.protocol !== 'http:' && url.protocol !== 'https:') {
			throw new TypeError(`fetch failed: unsupported scheme ${url.protocol}`);
		}
		let address: string;
		try {
			address = await resolveGuardedAddress(url.hostname, isBlocked);
		} catch (e) {
			if (e instanceof BlockedEgressTargetError) {
				log.warn('server-side fetch to a private or loopback target refused', {
					host: url.hostname,
					hop,
				});
			}
			throw e;
		}
		const response = await dial(url, address, method, headers, body, signal);
		const location = response.headers.get('location');
		if (!REDIRECT_STATUSES.has(response.status) || location === null) {
			return withUrl(response, url, hop > 0);
		}
		if (request.redirect === 'manual') return withUrl(response, url, hop > 0);
		await response.body?.cancel();
		if (request.redirect === 'error') {
			throw new TypeError(`fetch failed: redirect to ${location} not allowed`);
		}
		if (hop + 1 >= MAX_REDIRECTS) throw new TypeError('fetch failed: too many redirects');

		const next = new URL(location, url);
		// The method and body rewrite follows the Fetch standard's redirect rules:
		// 303 always becomes a bodiless GET, and so does a POST answered 301 or 302.
		if (
			(response.status === 303 && method !== 'GET' && method !== 'HEAD') ||
			((response.status === 301 || response.status === 302) && method === 'POST')
		) {
			method = 'GET';
			body = null;
			for (const name of REQUEST_BODY_HEADERS) headers.delete(name);
		}
		// A credential meant for one origin never follows a redirect to another.
		if (next.origin !== url.origin) headers.delete('authorization');
		url = next;
	}
}

/** The Fetch standard's ceiling on redirects followed for one request. */
const MAX_REDIRECTS = 20;

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/** Headers that describe a request body, dropped with the body on a GET rewrite. */
const REQUEST_BODY_HEADERS = [
	'content-encoding',
	'content-language',
	'content-location',
	'content-type',
	'content-length',
];

/** Statuses whose response never carries a body. */
const NULL_BODY_STATUSES = new Set([204, 205, 304]);

function abortReason(signal: AbortSignal): unknown {
	return signal.reason instanceof Error
		? signal.reason
		: new DOMException('This operation was aborted', 'AbortError');
}

/**
 * One request to the already-checked `address`, answered as a web `Response`.
 * Shaped like `DockerClient.requestStream`, including where the abort handler is
 * detached (on the response's `close`, never the request's, which Bun emits
 * early).
 */
function dial(
	url: URL,
	address: string,
	method: string,
	headers: Headers,
	body: Uint8Array | null,
	signal: AbortSignal,
): Promise<Response> {
	return new Promise<Response>((resolve, reject) => {
		if (signal.aborted) {
			reject(abortReason(signal));
			return;
		}
		const tls = url.protocol === 'https:';
		const out: Record<string, string> = {};
		headers.forEach((value, name) => {
			out[name] = value;
		});
		// The address is what is dialled, so the name has to be put back where the
		// server reads it.
		out.host = url.host;
		out['accept-encoding'] ??= 'gzip, deflate, br';
		out['user-agent'] ??= `hezo/${HEZO_VERSION}`;
		if (body !== null) out['content-length'] = String(body.byteLength);
		const hostname = url.hostname.replace(/^\[|\]$/g, '');

		let detachAbort: (() => void) | undefined;
		const req = (tls ? httpsRequest : httpRequest)(
			{
				host: address,
				port: url.port === '' ? (tls ? 443 : 80) : Number(url.port),
				method,
				path: `${url.pathname}${url.search}`,
				headers: out,
				// TLS validates against the name, not the address it resolved to. SNI
				// carries no IP literal.
				...(tls && isIP(hostname) === 0 ? { servername: hostname } : {}),
			},
			(res) => {
				res.on('close', () => detachAbort?.());
				try {
					resolve(toResponse(res, method));
				} catch (e) {
					res.destroy();
					reject(e);
				}
			},
		);
		req.on('error', (err) => reject(err));
		const onAbort = () => req.destroy(abortReason(signal) as Error);
		signal.addEventListener('abort', onAbort, { once: true });
		detachAbort = () => signal.removeEventListener('abort', onAbort);
		req.end(body ?? undefined);
	});
}

function toResponse(res: IncomingMessage, method: string): Response {
	const status = res.statusCode ?? 0;
	if (status < 200 || status > 599) {
		throw new TypeError(`fetch failed: invalid status ${status}`);
	}
	const headers = new Headers();
	for (const [name, value] of Object.entries(res.headers)) {
		if (typeof value === 'string') headers.set(name, value);
		else if (Array.isArray(value)) for (const v of value) headers.append(name, v);
	}
	if (method === 'HEAD' || NULL_BODY_STATUSES.has(status)) {
		res.resume();
		return new Response(null, { status, statusText: res.statusMessage, headers });
	}
	// `fetch` hands back a decoded body, so this does too. The length on the wire
	// no longer describes it once decoded.
	const decoder = decoderFor(headers.get('content-encoding'));
	let stream: Readable = res;
	if (decoder) {
		stream = res.pipe(decoder);
		res.on('error', (e) => decoder.destroy(e));
		headers.delete('content-encoding');
		headers.delete('content-length');
	}
	return new Response(Readable.toWeb(stream) as unknown as ReadableStream<Uint8Array>, {
		status,
		statusText: res.statusMessage,
		headers,
	});
}

function decoderFor(encoding: string | null) {
	switch (encoding?.trim().toLowerCase()) {
		case 'gzip':
		case 'x-gzip':
			return createGunzip();
		case 'deflate':
			return createInflate();
		case 'br':
			return createBrotliDecompress();
		default:
			return null;
	}
}

/** `Response.url` and `redirected` are read-only on a constructed response. */
function withUrl(response: Response, url: URL, redirected: boolean): Response {
	Object.defineProperty(response, 'url', { value: url.toString() });
	Object.defineProperty(response, 'redirected', { value: redirected });
	return response;
}
