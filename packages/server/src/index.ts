import { createHash } from 'node:crypto';
import type { PGlite } from '@electric-sql/pglite';
import { verify } from 'hono/jwt';
import { app } from './app';
import { parseArgs } from './cli';
import type { MasterKeyManager } from './crypto/master-key';
import type { WebSocketManager, WsData, WsSocket } from './services/ws';
import { startup } from './startup';

interface WsConnectionData extends WsData {
	_token?: string;
}

const config = parseArgs();
let serveFetch: (
	req: Request,
	server: Bun.Server<WsConnectionData>,
) => Response | Promise<Response> = app.fetch as typeof serveFetch;
let wsManager: WebSocketManager | null = null;
let dbRef: PGlite | null = null;
let mkmRef: MasterKeyManager | null = null;

async function validateToken(token: string): Promise<WsData['auth'] | null> {
	if (!mkmRef || !dbRef || mkmRef.getState() !== 'unlocked') return null;

	if (token.startsWith('hezo_')) {
		const prefix = token.slice(5, 13);
		const result = await dbRef.query<{ id: string; company_id: string; key_hash: string }>(
			'SELECT id, company_id, key_hash FROM api_keys WHERE prefix = $1',
			[prefix],
		);
		if (result.rows.length === 0) return null;
		const tokenHash = createHash('sha256').update(token).digest('hex');
		if (tokenHash !== result.rows[0].key_hash) return null;
		return { type: 'api_key', companyId: result.rows[0].company_id };
	}

	try {
		const jwtKey = await mkmRef.getJwtKey();
		const secret = jwtKey.toString('base64');
		const payload = await verify(token, secret, 'HS256');
		if (payload.member_id && payload.company_id) {
			return {
				type: 'agent',
				memberId: payload.member_id as string,
				companyId: payload.company_id as string,
			};
		}
		if (payload.user_id) {
			return { type: 'board', userId: payload.user_id as string };
		}
		return null;
	} catch {
		return null;
	}
}

startup(config)
	.then((result) => {
		serveFetch = result.app.fetch as unknown as typeof serveFetch;
		wsManager = result.wsManager;
		dbRef = result.db;
		mkmRef = result.masterKeyManager;
		const url = `http://localhost:${result.port}`;
		console.log(`Hezo server running at ${url} [${result.masterKeyState}]`);
		if (!config.noOpen) {
			Bun.spawn(['open', 'http://localhost:5173']);
		}
	})
	.catch((err) => {
		console.error('Startup failed, serving minimal app:', err);
		console.log(`Hezo server (minimal) starting on port ${config.port}...`);
	});

export default {
	port: config.port,
	fetch: (req: Request, server: Bun.Server<WsConnectionData>) => {
		const url = new URL(req.url);
		if (url.pathname === '/ws') {
			const token = url.searchParams.get('token') || req.headers.get('Authorization')?.slice(7);
			if (!token) {
				return new Response('Missing auth token', { status: 401 });
			}
			const upgraded = server.upgrade(req, {
				data: { auth: { type: 'pending' }, rooms: new Set<string>(), _token: token },
			});
			return upgraded ? undefined : new Response('WebSocket upgrade failed', { status: 500 });
		}
		return serveFetch(req, server);
	},
	websocket: {
		async open(ws: Bun.ServerWebSocket<WsConnectionData>) {
			if (!wsManager) {
				ws.close(1011, 'Server not ready');
				return;
			}
			const token = ws.data._token;
			if (!token) {
				ws.close(1008, 'No token');
				return;
			}
			delete ws.data._token;

			const auth = await validateToken(token);
			if (!auth) {
				ws.close(1008, 'Invalid auth');
				return;
			}
			ws.data.auth = auth;
			ws.data.rooms = new Set<string>();
		},
		close(ws: Bun.ServerWebSocket<WsConnectionData>) {
			wsManager?.unsubscribeAll(ws as unknown as WsSocket);
		},
		message(ws: Bun.ServerWebSocket<WsConnectionData>, msg: string | Buffer) {
			if (!wsManager) return;
			try {
				const data = JSON.parse(typeof msg === 'string' ? msg : msg.toString());
				if (data.action === 'subscribe' && typeof data.room === 'string') {
					wsManager.subscribe(ws as unknown as WsSocket, data.room);
				} else if (data.action === 'unsubscribe' && typeof data.room === 'string') {
					wsManager.unsubscribe(ws as unknown as WsSocket, data.room);
				}
			} catch {
				// ignore malformed messages
			}
		},
	},
};
