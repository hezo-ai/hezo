import { createServer, type Server } from 'node:http';
import { Hono } from 'hono';

export interface ProxyUpstreamSim {
	baseUrl: string;
	host: string;
	port: number;
	destroy(): Promise<void>;
}

/**
 * Tiny upstream simulator used by agent-proxy tests. Exposes:
 *   POST /echo    — returns method, received headers, and body verbatim
 *   GET  /stream  — chunked text response across multiple writes
 *   GET  /binary  — application/octet-stream payload
 *   POST /large   — reports the request body size
 *   GET  /500     — returns 500 with a body that includes the input query
 */
export async function createProxyUpstreamSim(): Promise<ProxyUpstreamSim> {
	const app = new Hono();

	app.post('/echo', async (c) => {
		const headers: Record<string, string> = {};
		for (const [k, v] of c.req.raw.headers.entries()) {
			headers[k.toLowerCase()] = v;
		}
		const buf = new Uint8Array(await c.req.arrayBuffer());
		const text = new TextDecoder('utf-8').decode(buf);
		return c.json({ method: c.req.method, headers, body: text });
	});

	app.get('/echo', (c) => {
		const headers: Record<string, string> = {};
		for (const [k, v] of c.req.raw.headers.entries()) {
			headers[k.toLowerCase()] = v;
		}
		return c.json({ method: c.req.method, headers, body: '' });
	});

	app.get('/stream', () => {
		const stream = new ReadableStream<Uint8Array>({
			async start(controller) {
				const enc = new TextEncoder();
				controller.enqueue(enc.encode('chunk-1;'));
				await new Promise((r) => setTimeout(r, 10));
				controller.enqueue(enc.encode('chunk-2;'));
				await new Promise((r) => setTimeout(r, 10));
				controller.enqueue(enc.encode('chunk-3;'));
				controller.close();
			},
		});
		return new Response(stream, {
			status: 200,
			headers: { 'Content-Type': 'text/plain' },
		});
	});

	app.get('/binary', () => {
		const buf = new Uint8Array([0, 1, 2, 3, 0xff, 0xfe, 0xfd]);
		return new Response(buf, {
			status: 200,
			headers: { 'Content-Type': 'application/octet-stream' },
		});
	});

	app.post('/large', async (c) => {
		const buf = new Uint8Array(await c.req.arrayBuffer());
		return c.json({ size: buf.byteLength });
	});

	app.get('/leak', (c) => {
		const echo = c.req.query('echo') ?? '';
		return c.text(`leaked:${echo}`, 500);
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
		const reader = response.body?.getReader();
		if (!reader) {
			res.end();
			return;
		}
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			res.write(Buffer.from(value));
		}
		res.end();
	});

	await new Promise<void>((resolve) => server.listen(0, resolve));
	const addr = server.address();
	const port = typeof addr === 'object' && addr ? addr.port : 0;
	const baseUrl = `http://localhost:${port}`;

	return {
		baseUrl,
		host: `localhost:${port}`,
		port,
		async destroy() {
			await new Promise<void>((resolve) => server.close(() => resolve()));
		},
	};
}
