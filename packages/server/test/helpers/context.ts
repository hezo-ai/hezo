import { rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { Hono } from 'hono';
import type { MasterKeyManager } from '../../src/crypto/master-key';
import type { Db } from '../../src/db/database';
import type { Env } from '../../src/lib/types';
import { safeClose } from '../helpers';
import { createTestApp } from './app';

export interface ServerTestContext {
	db: Db;
	app: Hono<Env>;
	server: Server;
	baseUrl: string;
	port: number;
	token: string;
	mnemonic: string;
	unlockKeyHex: string;
	masterKeyManager: MasterKeyManager;
	dataDir: string;
	/** The seeded admin's plaintext password (verifier enrolled in createTestApp). */
	password: string;
	/** Salt for the seeded admin's password verifier. */
	passwordSalt: string;
}

/** One request as it arrived on the wire, before the app saw it. */
export interface ObservedRequest {
	method: string;
	url: string;
	headers: Headers;
	/** Decoded as UTF-8. Empty for a body-less request. */
	body: string;
}

export interface ServedTestApp {
	server: Server;
	port: number;
	baseUrl: string;
}

/**
 * Put a Hono app on a real loopback socket.
 *
 * `app.request(...)` covers almost every suite; this is for the ones where
 * something *outside this process* has to reach the app over TCP - a container
 * dialling back through its run tunnel being the case that made it worth
 * extracting.
 *
 * `onRequest` observes each request after its body is read and before the app
 * handles it. That callback is the only place a test can prove a container
 * really reached Hezo: the agent-CLI conformance suite watches for the MCP
 * client's `initialize`/`tools/list` arriving here, which is exactly the
 * evidence a run that silently lost its tunnel does not produce.
 *
 * `onResponse` observes the same request again once the app has answered,
 * carrying the status. **Both exist because they answer different questions and
 * one cannot replace the other.** "It arrived" is what survives a handler that
 * hangs or crashes - an after-only hook records nothing there, and the failure
 * reads as "the container never reached Hezo", which is the opposite of the
 * truth. "It arrived *and* was answered 2xx" is what separates a client that
 * reached the endpoint from one that reached it and was rejected.
 */
export async function serveTestApp(
	app: Hono<Env>,
	opts: {
		onRequest?: (req: ObservedRequest) => void;
		onResponse?: (req: ObservedRequest, status: number) => void;
	} = {},
): Promise<ServedTestApp> {
	const server = createServer(async (req, res) => {
		const url = `http://localhost${req.url}`;
		const headers = new Headers();
		for (const [key, value] of Object.entries(req.headers)) {
			if (value) headers.set(key, Array.isArray(value) ? value.join(', ') : value);
		}

		const chunks: Buffer[] = [];
		for await (const chunk of req) chunks.push(chunk);
		const body = chunks.length > 0 ? Buffer.concat(chunks) : undefined;

		const observed: ObservedRequest = {
			method: req.method ?? 'GET',
			url: req.url ?? '/',
			headers,
			body: body ? body.toString('utf8') : '',
		};

		if (opts.onRequest) {
			try {
				opts.onRequest(observed);
			} catch {
				// An observer is diagnostics; it must never change what the app sees.
			}
		}

		const response = await app.fetch(
			new Request(url, {
				method: req.method,
				headers,
				body: body && req.method !== 'GET' && req.method !== 'HEAD' ? body : undefined,
			}),
		);

		if (opts.onResponse) {
			try {
				opts.onResponse(observed, response.status);
			} catch {
				// Same rule as onRequest: an observer never changes what the client sees.
			}
		}

		res.writeHead(response.status, Object.fromEntries(response.headers.entries()));
		const responseBody = await response.arrayBuffer();
		res.end(Buffer.from(responseBody));
	});

	await new Promise<void>((resolve) => server.listen(0, resolve));
	const addr = server.address();
	const port = typeof addr === 'object' && addr ? addr.port : 0;
	return { server, port, baseUrl: `http://localhost:${port}` };
}

export async function createTestContext(): Promise<ServerTestContext> {
	const {
		app,
		db,
		token,
		mnemonic,
		unlockKeyHex,
		masterKeyManager,
		dataDir,
		password,
		passwordSalt,
	} = await createTestApp();

	const { server, port, baseUrl } = await serveTestApp(app);

	return {
		db,
		app,
		server,
		baseUrl,
		port,
		token,
		mnemonic,
		unlockKeyHex,
		masterKeyManager,
		dataDir,
		password,
		passwordSalt,
	};
}

export async function destroyTestContext(ctx: ServerTestContext): Promise<void> {
	await new Promise<void>((resolve) => ctx.server.close(() => resolve()));
	await safeClose(ctx.db);
	rmSync(ctx.dataDir, { recursive: true, force: true });
}
