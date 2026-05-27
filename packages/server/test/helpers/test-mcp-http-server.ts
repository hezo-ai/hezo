import { createServer, type Server as HttpServer, type IncomingMessage } from 'node:http';
import { createServer as createHttpsServer, type Server as HttpsServer } from 'node:https';

export interface RecordedRequest {
	method: string;
	url: string;
	headers: Record<string, string | string[] | undefined>;
	body: string;
	parsedBody: unknown;
}

export interface TestMcpServer {
	port: number;
	close(): Promise<void>;
	requests: RecordedRequest[];
	reset(): void;
}

interface StartOpts {
	tls?: { cert: string; key: string };
}

/**
 * Minimal MCP-shaped HTTP server for substitution / connection-wiring tests.
 *
 * Honours the JSON-RPC envelope: returns a valid initialize result so a
 * client can complete the handshake, and a tools/list / tools/call response
 * for the canned `echo` tool. Every received request is recorded so tests
 * can assert headers (e.g. that the egress proxy substituted a placeholder)
 * and bodies (e.g. that an agent invoked the right tool with the right
 * arguments).
 *
 * The server intentionally does not enforce auth: tests are responsible for
 * asserting that the expected secret-bearing header arrived.
 */
export async function startTestMcpHttpServer(opts: StartOpts = {}): Promise<TestMcpServer> {
	const requests: RecordedRequest[] = [];

	const handler = (req: IncomingMessage, res: import('node:http').ServerResponse): void => {
		const chunks: Buffer[] = [];
		req.on('data', (c) => chunks.push(c));
		req.on('end', () => {
			const bodyText = Buffer.concat(chunks).toString('utf8');
			let parsed: unknown = null;
			if (bodyText.length > 0) {
				try {
					parsed = JSON.parse(bodyText);
				} catch {
					parsed = bodyText;
				}
			}
			requests.push({
				method: req.method ?? 'GET',
				url: req.url ?? '',
				headers: req.headers as Record<string, string | string[] | undefined>,
				body: bodyText,
				parsedBody: parsed,
			});

			const response = renderMcpResponse(parsed);
			res.writeHead(response.status, {
				'content-type': 'application/json',
				'content-length': Buffer.byteLength(response.body).toString(),
			});
			res.end(response.body);
		});
	};

	let server: HttpServer | HttpsServer;
	if (opts.tls) {
		server = createHttpsServer({ cert: opts.tls.cert, key: opts.tls.key }, handler);
	} else {
		server = createServer(handler);
	}
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
	const port = (server.address() as { port: number }).port;

	return {
		port,
		requests,
		reset(): void {
			requests.length = 0;
		},
		async close(): Promise<void> {
			await new Promise<void>((resolve) => server.close(() => resolve()));
		},
	};
}

interface RenderedMcpResponse {
	status: number;
	body: string;
}

function renderMcpResponse(parsed: unknown): RenderedMcpResponse {
	if (!parsed || typeof parsed !== 'object') {
		return { status: 200, body: JSON.stringify({ ok: true }) };
	}
	const req = parsed as { id?: number | string; method?: string; params?: Record<string, unknown> };
	const id = req.id ?? null;

	if (req.method === 'initialize') {
		return {
			status: 200,
			body: JSON.stringify({
				jsonrpc: '2.0',
				id,
				result: {
					protocolVersion: '2024-11-05',
					capabilities: { tools: {} },
					serverInfo: { name: 'hezo-test-mcp', version: '0.0.0' },
				},
			}),
		};
	}

	if (req.method === 'tools/list') {
		return {
			status: 200,
			body: JSON.stringify({
				jsonrpc: '2.0',
				id,
				result: {
					tools: [
						{
							name: 'echo',
							description: 'Echoes the provided message back as the result.',
							inputSchema: {
								type: 'object',
								properties: { message: { type: 'string' } },
								required: ['message'],
							},
						},
					],
				},
			}),
		};
	}

	if (req.method === 'tools/call') {
		const callArgs = (req.params?.arguments ?? {}) as { message?: string };
		return {
			status: 200,
			body: JSON.stringify({
				jsonrpc: '2.0',
				id,
				result: {
					content: [{ type: 'text', text: `echo:${callArgs.message ?? ''}` }],
				},
			}),
		};
	}

	return { status: 200, body: JSON.stringify({ jsonrpc: '2.0', id, result: {} }) };
}
