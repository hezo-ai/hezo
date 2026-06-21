import type { PGlite } from '@electric-sql/pglite';
import { AuthType, DEFAULT_WEB_PORT } from '@hezo/shared';
import { app } from './app';
import { parseConfig, runRestore } from './cli';
import type { MasterKeyManager } from './crypto/master-key';
import { PgDataCorruptError } from './db/client';
import { DbNewerThanAppError, MigrationFailedError } from './db/migrate-errors';
import { logger, setLogLevel } from './logger';
import { loadAdminAuth, verifyToken } from './middleware/auth';
import type { ContainerLogStreamer } from './services/container-logs';
import { setKeepOldContainers } from './services/containers';
import { getSharedImageBuildTracker } from './services/image-build-tracker';
import type { LogStreamBroker } from './services/log-stream-broker';
import type { WebSocketManager, WsData, WsSocket } from './services/ws';
import { handleWsSubscribe, handleWsUnsubscribe } from './services/ws-subscribe-handler';
import { type StartupResult, startup } from './startup';

const log = logger.child('server');

interface HezoDevRuntime {
	shutdown: () => Promise<void>;
}

declare global {
	var __hezoDevRuntime: HezoDevRuntime | undefined;
}

async function shutdownPreviousRuntime(): Promise<void> {
	const prev = globalThis.__hezoDevRuntime;
	if (!prev) return;
	globalThis.__hezoDevRuntime = undefined;
	try {
		await prev.shutdown();
	} catch (err) {
		log.warn('Previous runtime shutdown error (continuing):', err);
	}
}

function registerRuntime(result: StartupResult): void {
	globalThis.__hezoDevRuntime = {
		shutdown: async () => {
			serverReady = false;
			result.jobManager.shutdown();
			await result.ceoSessionManager.stop();
			await result.egressProxy.releaseAll();
			await result.sshAgentServer.releaseAll();
			await result.db.close();
		},
	};
}

if (import.meta.hot) {
	import.meta.hot.dispose(() => {
		void shutdownPreviousRuntime();
	});
}

process.on('unhandledRejection', (reason) => {
	log.error('unhandledRejection', reason);
});
process.on('uncaughtException', (err) => {
	log.error('uncaughtException', err);
});

interface WsConnectionData extends WsData {
	_token?: string;
}

// `hezo restore <backup>` runs and exits before any server startup.
if (await runRestore()) {
	process.exit(0);
}

const config = parseConfig();
setLogLevel(config.logLevel);
setKeepOldContainers(config.keepOldContainers);

/** Bumped on each module load so stale async startup completions are ignored after HMR. */
let startupGeneration = 0;
const thisStartupGeneration = ++startupGeneration;

let serverReady = false;
let serveFetch: (
	req: Request,
	server: Bun.Server<WsConnectionData>,
) => Response | Promise<Response> = app.fetch as typeof serveFetch;
let wsManager: WebSocketManager | null = null;
let dbRef: PGlite | null = null;
let mkmRef: MasterKeyManager | null = null;
let dockerRef: import('./services/docker').DockerClient | null = null;
let logsRef: LogStreamBroker | null = null;
let containerLogStreamerRef: ContainerLogStreamer | null = null;

async function validateToken(token: string): Promise<WsData['auth'] | null> {
	if (!mkmRef || !dbRef) return null;
	return verifyToken(token, dbRef, mkmRef);
}

async function validateAnonymous(): Promise<WsData['auth'] | null> {
	if (!mkmRef || !dbRef) return null;
	if (mkmRef.getState() !== 'unlocked') return null;
	return loadAdminAuth(dbRef);
}

async function canAccessTeam(auth: WsData['auth'], teamId: string): Promise<boolean> {
	if (auth.type === AuthType.ApiKey || auth.type === AuthType.Agent) {
		return auth.teamId === teamId;
	}
	if (auth.type === AuthType.Admin) {
		if (auth.isSuperuser) return true;
		if (!dbRef) return false;
		const result = await dbRef.query(
			'SELECT m.id FROM members m JOIN member_users mu ON mu.id = m.id WHERE mu.user_id = $1 AND m.team_id = $2',
			[auth.userId, teamId],
		);
		return result.rows.length > 0;
	}
	return false;
}

function startingResponse(): Response {
	return Response.json(
		{ error: { code: 'STARTING', message: 'Server is starting — retry in a moment' } },
		{ status: 503 },
	);
}

void (async () => {
	await shutdownPreviousRuntime();

	try {
		const result = await startup(config);
		if (thisStartupGeneration !== startupGeneration) {
			log.warn('Ignoring stale startup completion after reload');
			await result.db.close();
			return;
		}
		registerRuntime(result);
		serveFetch = result.app.fetch as unknown as typeof serveFetch;
		wsManager = result.wsManager;
		dbRef = result.db;
		mkmRef = result.masterKeyManager;
		dockerRef = result.docker;
		logsRef = result.logs;
		containerLogStreamerRef = result.containerLogStreamer;
		serverReady = true;
		const url = `http://localhost:${result.port}`;
		log.info(`Hezo server running at ${url} [${result.masterKeyState}]`);
		if (config.open) {
			Bun.spawn(['open', `http://localhost:${DEFAULT_WEB_PORT}`]);
		}
	} catch (err) {
		if (thisStartupGeneration !== startupGeneration) return;
		// Fatal, operator-actionable migration conditions: the DB is fine but the
		// binary can't proceed. Print the guidance and exit rather than limping
		// along in minimal mode.
		if (err instanceof DbNewerThanAppError || err instanceof MigrationFailedError) {
			log.error(`\n${err.message}\n`);
			process.exit(1);
		}
		if (err instanceof PgDataCorruptError) {
			log.error(`\n${err.message}\n`);
		} else {
			log.error('Startup failed, serving minimal app:', err);
		}
		log.info(`Hezo server (minimal) starting on port ${config.port}...`);
	}
})();

export default {
	port: config.port,
	fetch: (req: Request, server: Bun.Server<WsConnectionData>) => {
		const url = new URL(req.url);
		if (!serverReady && url.pathname !== '/health') {
			return startingResponse();
		}
		if (url.pathname === '/ws') {
			const token =
				url.searchParams.get('token') || req.headers.get('Authorization')?.slice(7) || '';
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
			delete ws.data._token;

			const auth = token ? await validateToken(token) : await validateAnonymous();
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
						if (wsManager.getRoomSize(room) === 0 && containerLogStreamerRef) {
							containerLogStreamerRef.unsubscribe(logsMatch[1], logsRef ?? undefined);
						}
					}
				}
				wsManager.unsubscribeAll(ws as unknown as WsSocket);
			}
		},
		async message(ws: Bun.ServerWebSocket<WsConnectionData>, msg: string | Buffer) {
			if (!wsManager || !containerLogStreamerRef) return;
			try {
				const data = JSON.parse(typeof msg === 'string' ? msg : msg.toString());
				if (data.action === 'subscribe' && typeof data.room === 'string') {
					await handleWsSubscribe(ws as unknown as WsSocket, data.room, {
						db: dbRef,
						wsManager,
						docker: dockerRef,
						containerLogStreamer: containerLogStreamerRef,
						logs: logsRef,
						imageBuildTracker: getSharedImageBuildTracker(),
						canAccessTeam,
						sendToSocket: (_s, payload) => ws.send(JSON.stringify(payload)),
					});
				} else if (data.action === 'unsubscribe' && typeof data.room === 'string') {
					handleWsUnsubscribe(ws as unknown as WsSocket, data.room, {
						wsManager,
						containerLogStreamer: containerLogStreamerRef,
						logs: logsRef,
					});
				}
			} catch {
				// ignore malformed messages
			}
		},
	},
};
