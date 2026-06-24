import type { PGlite } from '@electric-sql/pglite';
import { AuthType, DEFAULT_WEB_PORT } from '@hezo/shared';
import { app } from './app';
import { parseConfig, runRestore } from './cli';
import type { MasterKeyManager } from './crypto/master-key';
import { PgDataCorruptError } from './db/client';
import { DbNewerThanAppError, MigrationFailedError } from './db/migrate-errors';
import type { AuthInfo } from './lib/types';
import { logger, setLogLevel } from './logger';
import { canAuthAccessTeam, loadAdminAuth, verifyToken } from './middleware/auth';
import { getActiveRuntime, setActiveRuntime, shutdownRuntime } from './runtime-control';
import type { ContainerLogStreamer } from './services/container-logs';
import { setKeepOldContainers } from './services/containers';
import { DockerClient } from './services/docker';
import { evaluateDockerPreflight, formatDockerPreflightMessage } from './services/docker-preflight';
import { getSharedImageBuildTracker } from './services/image-build-tracker';
import type { LogStreamBroker } from './services/log-stream-broker';
import { formatPortInUseMessage, probePort } from './services/port-preflight';
import { isAutoUpdateEnabled } from './services/updater';
import type { WebSocketManager, WsData, WsSocket } from './services/ws';
import { handleWsSubscribe, handleWsUnsubscribe } from './services/ws-subscribe-handler';
import { type StartupResult, startup } from './startup';
import { runSupervisor } from './supervisor';

const log = logger.child('server');

interface HezoDevRuntime {
	shutdown: () => Promise<void>;
}

declare global {
	var __hezoDevRuntime: HezoDevRuntime | undefined;
	/**
	 * Set once the cold-start port preflight has run. Persists across `bun --hot`
	 * reloads (Bun preserves the global scope), so a reload — where our own
	 * already-running server legitimately holds the port — skips the re-probe
	 * instead of mistaking it for a conflict and exiting.
	 */
	var __hezoPortProbed: boolean | undefined;
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
	setActiveRuntime(result);
	globalThis.__hezoDevRuntime = {
		shutdown: async () => {
			serverReady = false;
			await shutdownRuntime(result);
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

// Self-update supervisor. A compiled binary with auto-update enabled runs as a
// thin supervisor that spawns the real server as a worker (HEZO_WORKER=1),
// applies staged updates between restarts, and otherwise propagates the worker's
// exit code. The worker re-enters this file with HEZO_WORKER set and skips this
// branch, running the server below. Dev (`bun run`, non-compiled) and the
// `restore` subcommand never reach here, so they never supervise. runSupervisor
// never returns.
if (!process.env.HEZO_WORKER && isAutoUpdateEnabled()) {
	await runSupervisor(config.dataDir);
}

setKeepOldContainers(config.keepOldContainers);

// Graceful shutdown on termination signals (the supervisor forwards these to the
// worker). Close the runtime cleanly, then exit 0 so the supervisor sees a
// normal — non-sentinel — code and exits too rather than relaunching.
for (const sig of ['SIGTERM', 'SIGINT'] as const) {
	process.on(sig, () => {
		void (async () => {
			const runtime = getActiveRuntime();
			if (runtime) {
				try {
					await shutdownRuntime(runtime);
				} catch (err) {
					log.error('Graceful shutdown error:', err);
				}
			}
			process.exit(0);
		})();
	});
}

// Port preflight: Bun binds the port itself from the default export below, so an
// already-taken port would otherwise surface as a bare `EADDRINUSE` crash. Probe
// it first and exit with guidance pointing at `--port`/`HEZO_PORT`. Guarded so it
// runs only on a cold start, never on a `bun --hot` reload (where the dev server
// keeps the port bound across reloads and a re-probe would falsely see a conflict).
if (!globalThis.__hezoPortProbed) {
	globalThis.__hezoPortProbed = true;
	const probe = await probePort(config.port);
	if (!probe.available && probe.code === 'EADDRINUSE') {
		log.error(`\n${formatPortInUseMessage(config.port)}\n`);
		process.exit(1);
	}
}

// Docker is a hard prerequisite — every agent runs in a per-project container.
// Detect a missing or unreachable daemon at launch and exit with actionable
// guidance (install link / start instructions) rather than booting a server
// that can't run a single agent. HEZO_SKIP_DOCKER swaps in the in-process fake
// docker for UI/dev work and tests, so the gate is skipped when it is set.
if (!process.env.HEZO_SKIP_DOCKER) {
	const availability = await evaluateDockerPreflight(new DockerClient());
	if (availability !== 'ok') {
		log.error(`\n${formatDockerPreflightMessage(availability)}\n`);
		process.exit(1);
	}
}

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
	const auth = await verifyToken(token, dbRef, mkmRef);
	// API keys authenticate the MCP endpoint only — not the realtime WebSocket.
	// The browser uses a user JWT here; external callers use MCP request/response.
	if (auth?.type === AuthType.ApiKey) return null;
	return auth;
}

async function validateAnonymous(): Promise<WsData['auth'] | null> {
	if (!mkmRef || !dbRef) return null;
	if (mkmRef.getState() !== 'unlocked') return null;
	return loadAdminAuth(dbRef);
}

async function canAccessTeam(auth: WsData['auth'], teamId: string): Promise<boolean> {
	if (!dbRef) return false;
	// By the time a socket subscribes, `open` has replaced the placeholder with a
	// validated AuthInfo; WsData widens it to a loose bag, so re-narrow here. The
	// team rule itself lives in one place — auth.ts:canAuthAccessTeam — shared with
	// REST, so connected agents (and cross-team CEO sessions) reach realtime rooms too.
	return canAuthAccessTeam(dbRef, auth as AuthInfo, teamId);
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
