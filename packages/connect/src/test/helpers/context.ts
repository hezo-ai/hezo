import { createServer, type Server } from 'node:http';
import type { Hono } from 'hono';
import type { ConnectConfig } from '../../config';
import { createApp } from '../../app';
import type { FetchFn } from '../../providers/github';

export interface ConnectTestContext {
	app: Hono;
	server: Server;
	baseUrl: string;
	port: number;
}

export function defaultTestConfig(overrides?: Partial<ConnectConfig>): ConnectConfig {
	return {
		port: 0,
		mode: 'self_hosted',
		stateSigningKey: 'test-signing-key',
		github: { clientId: 'test-id', clientSecret: 'test-secret' },
		...overrides,
	};
}

export async function createTestContext(
	config?: ConnectConfig,
	fetchFn?: FetchFn,
): Promise<ConnectTestContext> {
	const resolvedConfig = config ?? defaultTestConfig();
	const app = createApp(resolvedConfig, fetchFn);

	const server = createServer(async (req, res) => {
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
	const baseUrl = `http://localhost:${port}`;

	return { app, server, baseUrl, port };
}

export async function destroyTestContext(ctx: ConnectTestContext): Promise<void> {
	await new Promise<void>((resolve) => ctx.server.close(() => resolve()));
}
