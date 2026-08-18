import { existsSync } from 'node:fs';
import { AuthType, WsClientAction } from '@hezo/shared';
import { app } from './app';
import { AssetStorageError } from './assets/errors';
import { resolveConfig, runBackup, runRestore, runUninstall, runVersion } from './cli';
import { setRuntimeConfig } from './config/runtime';
import type { HezoConfig } from './config/types';
import type { MasterKeyManager } from './crypto/master-key';
import { PgDataCorruptError } from './db/client';
import type { Db } from './db/database';
import {
	DbNewerThanAppError,
	ExternalDbError,
	ExternalMigrationFailedError,
	MigrationFailedError,
} from './db/migrate-errors';
import { promptDockerDesktopInstall } from './lib/docker-desktop-prompt';
import { browserAvailable, openBrowser } from './lib/open-browser';
import type { AuthInfo } from './lib/types';
import { setupWorkerUnlockHandoff } from './lib/unlock-handoff';
import { logger, setLogLevel } from './logger';
import { canAuthAccessTeam, verifyToken } from './middleware/auth';
import { getActiveRuntime, setActiveRuntime, shutdownRuntime } from './runtime-control';
import type { ContainerLogStreamer } from './services/container-logs';
import { setKeepOldContainers } from './services/containers';
import { getSharedImageBuildTracker } from './services/image-build-tracker';
import type { LogStreamBroker } from './services/log-stream-broker';
import { formatPortInUseMessage, probePort } from './services/port-preflight';
import { DockerNotInstalledError, SandboxBackendError } from './services/sandbox/errors';
import { isAutoUpdateEnabled } from './services/updater';
import type { WebSocketManager, WsData, WsSocket } from './services/ws';
import {
	handleWsPing,
	handleWsSubscribe,
	handleWsUnsubscribe,
} from './services/ws-subscribe-handler';
import { type StartupResult, startup } from './startup';
import { clearStartupFailure, readStartupFailure, recordStartupFailure } from './startup-failure';
import { getStartupProgress, markStartupError, setStartupPhase } from './startup-progress';
import { serveStartupRequest } from './startup-serving';
import { loadStaticBundle } from './static-assets';
import { runSupervisor } from './supervisor';
import { HEZO_VERSION } from './version';

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

// `hezo --version` / `hezo version` prints the version and exits before any
// server startup.
if (runVersion()) {
	process.exit(0);
}

// `hezo backup` / `hezo restore <backup>` run and exit before any server startup.
if (await runBackup()) {
	process.exit(0);
}
if (await runRestore()) {
	process.exit(0);
}

// `hezo uninstall` removes the data directory (ACL-aware) and exits before startup.
if (await runUninstall()) {
	process.exit(0);
}

// A bad config file or flag is operator error, not a crash: print what is wrong
// and exit. Without this the throw reaches the uncaughtException handler and the
// operator gets a stack trace through `/$bunfs/root/hezo` above the one line that
// actually tells them which key to fix.
const config = ((): HezoConfig => {
	try {
		return resolveConfig();
	} catch (err) {
		console.error(`\n${err instanceof Error ? err.message : String(err)}\n`);
		process.exit(1);
	}
})();
// Publish it before anything reads config back through `runtimeConfig()`. Service
// modules were imported above (via `./app`), so they must read it lazily, not at
// module scope — see config/runtime.ts.
setRuntimeConfig(config);
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

setKeepOldContainers(config.containers.keepOld);

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

// The container backend's preflight is deliberately NOT here.
//
// A daemon check at this point can only read the launch flag - the database is
// not open yet - but the backend actually in use comes from the **stored**
// setting, which the flag merely seeds (`resolveStartupBackend`). Gating here
// therefore failed an instance switched to a managed backend from the Containers
// page: it exited 1 on the next restart, printing Docker install guidance for a
// backend it would never use.
//
// `openSandboxBackend` inside `startup()` is the single preflight for whichever
// backend is selected, and it carries the same install/start guidance. It throws
// `SandboxBackendError`, which the catch below turns into the same fatal exit.
//
// It also owns **socket resolution** for Docker-compatible runtimes (Colima,
// Rancher Desktop, OrbStack, rootless): walking the candidate sockets and
// recording the winner has to happen before any `DockerClient` is used, and the
// Docker branch of that preflight is the first place that is both after the
// backend is known and before an engine is handed out.

/** Bumped on each module load so stale async startup completions are ignored after HMR. */
let startupGeneration = 0;
const thisStartupGeneration = ++startupGeneration;

let serverReady = false;
/**
 * Why the previous boot died, if it died fatally. Read ONCE here, before
 * `startup()` runs, so it describes the last boot rather than this one; the
 * pre-ready handler serves it on /api/status so a restart loop explains itself
 * instead of looking like a boot that never finishes.
 */
const previousStartupFailure = readStartupFailure(config.dataDir);
if (previousStartupFailure) {
	log.warn(
		`Previous start failed during "${previousStartupFailure.phase}" on ${previousStartupFailure.version}: ${previousStartupFailure.message}`,
	);
}
let serveFetch: (
	req: Request,
	server: Bun.Server<WsConnectionData>,
) => Response | Promise<Response> = app.fetch as typeof serveFetch;
let wsManager: WebSocketManager | null = null;
let dbRef: Db | null = null;
let mkmRef: MasterKeyManager | null = null;
let dockerRef: import('./services/sandbox/types').ContainerEngine | null = null;
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

async function canAccessTeam(auth: WsData['auth'], teamId: string): Promise<boolean> {
	if (!dbRef) return false;
	// By the time a socket subscribes, `open` has replaced the placeholder with a
	// validated AuthInfo; WsData widens it to a loose bag, so re-narrow here. The
	// team rule itself lives in one place — auth.ts:canAuthAccessTeam — shared with
	// REST, so connected agents (and cross-team CEO sessions) reach realtime rooms too.
	return canAuthAccessTeam(dbRef, auth as AuthInfo, teamId);
}

void (async () => {
	await shutdownPreviousRuntime();

	try {
		const result = await startup(config);
		if (thisStartupGeneration !== startupGeneration) {
			log.warn('Ignoring stale startup completion after reload');
			await result.assetStore.close();
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
		setStartupPhase('ready');
		// This boot got through, so a breadcrumb from an earlier failure is stale —
		// drop it rather than warn about a problem that is now fixed.
		clearStartupFailure(config.dataDir);
		// Update-restart unlock handoff: in a supervised worker, keep the
		// supervisor's in-memory copy of the unlock key current and, on a locked
		// boot right after an update install, ask for it back so the instance
		// comes up unlocked. No-op without an IPC channel (dev, plain binary).
		setupWorkerUnlockHandoff({ db: result.db, masterKeyManager: result.masterKeyManager });
		const url = `http://localhost:${result.port}`;
		log.info(`Hezo server running at ${url} [${result.masterKeyState}]`);
		if (config.open) {
			// In dev the SPA is served by Vite (config.webUrl); the compiled
			// binary serves it from the server port. Prefer the configured web URL.
			const target = config.webUrl || url;
			const decision = browserAvailable({
				platform: process.platform,
				env: process.env,
				hasDockerEnv: existsSync('/.dockerenv'),
			});
			if (decision.available) {
				log.info(`Opening ${target} in your browser…`);
				openBrowser(target);
			} else {
				log.info(`Not opening a browser (${decision.reason}). Visit ${target}`);
			}
		}
	} catch (err) {
		if (thisStartupGeneration !== startupGeneration) return;
		// Fatal, operator-actionable database conditions: the binary can't
		// proceed. Print the guidance and exit rather than limping along in
		// minimal mode.
		if (
			err instanceof DbNewerThanAppError ||
			err instanceof MigrationFailedError ||
			err instanceof ExternalDbError ||
			err instanceof ExternalMigrationFailedError ||
			err instanceof AssetStorageError ||
			err instanceof SandboxBackendError
		) {
			log.error(`\n${err.message}\n`);
			// Under `Restart=always` this exit is immediately undone, so without a
			// breadcrumb the operator sees only the boot screen looping. Leave the
			// reason for the next boot to surface on /api/status.
			recordStartupFailure(config.dataDir, {
				message: err.message,
				phase: getStartupProgress().phase,
				version: HEZO_VERSION,
			});
			// One failure gets more than a printed message: no container runtime at
			// all, on Windows. The binary is normally launched from Explorer there and
			// owns its console window, so `process.exit(1)` closes the window the
			// guidance was just printed to and the operator sees a flash of black and
			// nothing else. Hold the exit open on a dialog that explains why a
			// container runtime is required, and open the Store listing if they accept.
			if (err instanceof DockerNotInstalledError) {
				await promptDockerDesktopInstall({
					platform: process.platform,
					autoOpenEnabled: config.open,
					desktopSession: browserAvailable({
						platform: process.platform,
						env: process.env,
						hasDockerEnv: existsSync('/.dockerenv'),
					}).available,
				});
			}
			process.exit(1);
		}
		if (err instanceof PgDataCorruptError) {
			log.error(`\n${err.message}\n`);
		} else {
			log.error('Startup failed, serving minimal app:', err);
		}
		markStartupError(err instanceof Error ? err.message : 'Unexpected startup error');
		log.info(`Hezo server (minimal) starting on port ${config.port}...`);
	}
})();

export default {
	port: config.port,
	// Bun's default idleTimeout is 10s, measured between writes on the socket.
	// Handlers that legitimately work for a while before producing their first
	// byte (GitHub API round-trips, container queries, big uploads) get their
	// connection severed mid-request at the default — the client sees a bare
	// "Failed to fetch" while the server keeps working. 120s is deliberate
	// headroom, not a license for slow routes: anything that can outlive it
	// (cloning, provisioning) must run in the background, not in the handler.
	idleTimeout: 120,
	fetch: (req: Request, server: Bun.Server<WsConnectionData>) => {
		const url = new URL(req.url);
		if (!serverReady) {
			return serveStartupRequest(req, {
				progress: getStartupProgress(),
				loadBundle: loadStaticBundle,
				lastFailure: previousStartupFailure,
			});
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
		// Inbound frames are only `subscribe`/`unsubscribe` control messages, so a
		// tight cap costs nothing and stops a hostile client buying server memory.
		maxPayloadLength: 64 * 1024,
		// Log rooms push hard: ten concurrent verbose runs against one tab on a slow
		// link will outrun the socket, and Bun buffers without bound by default. Cut
		// a socket loose once it falls this far behind rather than growing its queue
		// forever — the client reconnects (ReconnectingWebSocket), re-subscribes on
		// open, and is re-seeded from the room snapshot, so the recovery is the
		// existing reconnect path rather than a special case.
		backpressureLimit: 8 * 1024 * 1024,
		closeOnBackpressureLimit: true,
		async open(ws: Bun.ServerWebSocket<WsConnectionData>) {
			if (!wsManager) {
				ws.close(1011, 'Server not ready');
				return;
			}
			const token = ws.data._token;
			delete ws.data._token;

			// No anonymous sockets: a valid session token is required, same as REST.
			const auth = token ? await validateToken(token) : null;
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
			let data: { action?: unknown; room?: unknown };
			try {
				data = JSON.parse(typeof msg === 'string' ? msg : msg.toString());
			} catch {
				return; // ignore malformed messages
			}
			// Answered before the subsystem guards below: a liveness probe must not go
			// unanswered just because some other ref hasn't been wired up yet, or the
			// client would read the silence as a dead socket and redial a healthy one.
			if (data.action === WsClientAction.Ping) {
				handleWsPing(ws as unknown as WsSocket, {
					sendToSocket: (_s, payload) => ws.send(JSON.stringify(payload)),
				});
				return;
			}
			if (!wsManager || !containerLogStreamerRef) return;
			try {
				if (data.action === WsClientAction.Subscribe && typeof data.room === 'string') {
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
				} else if (data.action === WsClientAction.Unsubscribe && typeof data.room === 'string') {
					handleWsUnsubscribe(ws as unknown as WsSocket, data.room, {
						wsManager,
						containerLogStreamer: containerLogStreamerRef,
						logs: logsRef,
					});
				}
			} catch {
				// a failed subscribe must not take the socket down with it
			}
		},
	},
};
