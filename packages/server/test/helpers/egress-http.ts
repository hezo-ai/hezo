import { connect } from 'node:net';

export interface RawProxyResponse {
	status: number;
	body: string;
}

/**
 * Send one plain-HTTP request through a run's egress proxy on a raw socket and
 * read the whole answer. Raw rather than `fetch`, so the request line, the
 * `Host` header and the framing are exactly what the test wrote - a proxy test
 * is about what the proxy does with a given wire shape.
 */
export function rawRequestThroughProxy(
	proxyPort: number,
	request: {
		method: string;
		/** Absolute-form URL, as a client sends to a forward proxy. */
		url: string;
		headers?: Record<string, string>;
		/** Already-framed body bytes; the caller sets Content-Length or Transfer-Encoding. */
		body?: string;
	},
): Promise<RawProxyResponse> {
	const host = new URL(request.url).host;
	const lines = [`${request.method} ${request.url} HTTP/1.1`, `Host: ${host}`, 'Connection: close'];
	for (const [name, value] of Object.entries(request.headers ?? {})) {
		lines.push(`${name}: ${value}`);
	}
	const text = `${lines.join('\r\n')}\r\n\r\n${request.body ?? ''}`;
	return new Promise((resolve, reject) => {
		const sock = connect({ host: '127.0.0.1', port: proxyPort });
		const chunks: Buffer[] = [];
		sock.on('connect', () => sock.write(text));
		sock.on('data', (c: Buffer) => chunks.push(c));
		sock.on('end', () => {
			const all = Buffer.concat(chunks).toString();
			const sep = all.indexOf('\r\n\r\n');
			const head = sep === -1 ? all : all.slice(0, sep);
			resolve({
				status: Number(head.split('\r\n')[0]?.split(' ')[1] ?? '0'),
				body: sep === -1 ? '' : all.slice(sep + 4),
			});
		});
		sock.on('error', reject);
		sock.setTimeout(20_000, () => sock.destroy(new Error('proxy fetch timed out')));
	});
}
