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

/** A `tools/list` entry, as much of it as any test needs to assert on. */
export interface TestMcpTool {
	name: string;
	description?: string;
	annotations?: { readOnlyHint?: boolean };
}

const DEFAULT_TOOLS: TestMcpTool[] = [
	{ name: 'echo', description: 'Echoes the provided message back as the result.' },
];

interface StartOpts {
	tls?: { cert: string; key: string };
	/**
	 * Tools this server advertises. Defaults to the canned `echo` tool the
	 * substitution/wiring tests rely on; method-discovery tests pass their own
	 * catalog (including `annotations.readOnlyHint`) to drive classification.
	 */
	tools?: TestMcpTool[];
	/** Reject every request with this status — for probe-failure paths. */
	failWithStatus?: number;
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

			if (opts.failWithStatus) {
				const body = JSON.stringify({ error: 'test-forced failure' });
				res.writeHead(opts.failWithStatus, {
					'content-type': 'application/json',
					'content-length': Buffer.byteLength(body).toString(),
				});
				res.end(body);
				return;
			}

			const response = renderMcpResponse(parsed, opts.tools ?? DEFAULT_TOOLS);
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

function renderMcpResponse(parsed: unknown, tools: TestMcpTool[]): RenderedMcpResponse {
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
					tools: tools.map((t) => ({
						...t,
						inputSchema: {
							type: 'object',
							properties: { message: { type: 'string' } },
						},
					})),
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
