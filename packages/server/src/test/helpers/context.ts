import { createServer, type Server } from 'node:http';
import type { Hono } from 'hono';
import type { PGlite } from '@electric-sql/pglite';
import type { MasterKeyManager } from '../../crypto/master-key';
import { createTestApp } from './app';
import { safeClose } from '../helpers';

export interface ServerTestContext {
	db: PGlite;
	app: Hono;
	server: Server;
	baseUrl: string;
	port: number;
	token: string;
	masterKeyHex: string;
	masterKeyManager: MasterKeyManager;
}

export async function createTestContext(): Promise<ServerTestContext> {
	const { app, db, token, masterKeyHex, masterKeyManager } = await createTestApp();

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

	return { db, app, server, baseUrl, port, token, masterKeyHex, masterKeyManager };
}

export async function destroyTestContext(ctx: ServerTestContext): Promise<void> {
	await new Promise<void>((resolve) => ctx.server.close(() => resolve()));
	await safeClose(ctx.db);
}
