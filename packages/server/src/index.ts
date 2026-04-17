import type { PGlite } from '@electric-sql/pglite';
import { AuthType } from '@hezo/shared';
import { app } from './app';
import { parseArgs } from './cli';
import type { MasterKeyManager } from './crypto/master-key';
import { logger } from './logger';
import { verifyToken } from './middleware/auth';
import { ContainerLogStreamer } from './services/container-logs';
import type { LogStreamBroker } from './services/log-stream-broker';
import type { WebSocketManager, WsData, WsSocket } from './services/ws';
import { handleWsSubscribe, handleWsUnsubscribe } from './services/ws-subscribe-handler';
import { startup } from './startup';

const log = logger.child('server');

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
let dockerRef: import('./services/docker').DockerClient | null = null;
let logsRef: LogStreamBroker | null = null;
const containerLogStreamer = new ContainerLogStreamer();

async function validateToken(token: string): Promise<WsData['auth'] | null> {
	if (!mkmRef || !dbRef) return null;
	return verifyToken(token, dbRef, mkmRef);
}

async function canAccessCompany(auth: WsData['auth'], companyId: string): Promise<boolean> {
	if (auth.type === AuthType.ApiKey || auth.type === AuthType.Agent) {
		return auth.companyId === companyId;
	}
	if (auth.type === AuthType.Board) {
		if (auth.isSuperuser) return true;
		if (!dbRef) return false;
		const result = await dbRef.query(
			'SELECT m.id FROM members m JOIN member_users mu ON mu.id = m.id WHERE mu.user_id = $1 AND m.company_id = $2',
			[auth.userId, companyId],
		);
		return result.rows.length > 0;
	}
	return false;
}

startup(config)
	.then((result) => {
		serveFetch = result.app.fetch as unknown as typeof serveFetch;
		wsManager = result.wsManager;
		dbRef = result.db;
		mkmRef = result.masterKeyManager;
		dockerRef = result.docker;
		logsRef = result.logs;
		const url = `http://localhost:${result.port}`;
		log.info(`Hezo server running at ${url} [${result.masterKeyState}]`);
		if (!config.noOpen) {
			Bun.spawn(['open', 'http://localhost:5173']);
		}
	})
	.catch((err) => {
		log.error('Startup failed, serving minimal app:', err);
		log.info(`Hezo server (minimal) starting on port ${config.port}...`);
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
			if (wsManager) {
				for (const room of ws.data.rooms) {
					const logsMatch = room.match(/^container-logs:(.+)$/);
					if (logsMatch) {
						wsManager.unsubscribe(ws as unknown as WsSocket, room);
						if (wsManager.getRoomSize(room) === 0) {
							containerLogStreamer.unsubscribe(logsMatch[1], logsRef ?? undefined);
						}
					}
				}
				wsManager.unsubscribeAll(ws as unknown as WsSocket);
			}
		},
		async message(ws: Bun.ServerWebSocket<WsConnectionData>, msg: string | Buffer) {
			if (!wsManager) return;
			try {
				const data = JSON.parse(typeof msg === 'string' ? msg : msg.toString());
				if (data.action === 'subscribe' && typeof data.room === 'string') {
					await handleWsSubscribe(ws as unknown as WsSocket, data.room, {
						db: dbRef,
						wsManager,
						docker: dockerRef,
						containerLogStreamer,
						logs: logsRef,
						canAccessCompany,
						sendToSocket: (_s, payload) => ws.send(JSON.stringify(payload)),
					});
				} else if (data.action === 'unsubscribe' && typeof data.room === 'string') {
					handleWsUnsubscribe(ws as unknown as WsSocket, data.room, {
						wsManager,
						containerLogStreamer,
						logs: logsRef,
					});
				}
			} catch {
				// ignore malformed messages
			}
		},
	},
};
