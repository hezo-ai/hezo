import { mkdirSync, readFileSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { API_BODY_MAX_BYTES, ATTACHMENT_MAX_BYTES } from '@hezo/shared';
import { type Context, Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { compress } from 'hono/compress';
import { LocalAssetStore } from './assets/drivers/local';
import { openAssetStorage } from './assets/open';
import type { AssetStore } from './assets/store';
import type { HezoConfig } from './cli';
import { watchPolicyFile } from './config/policy';
import type { Db } from './db/database';
import { logger } from './logger';

const log = logger.child('startup');

import { MasterKeyManager } from './crypto/master-key';
import type { Migration } from './db/migrate';
import { openDatabase } from './db/open';
import { BASE_SCHEMA } from './db/schema';
import { registerAuditObserver } from './events/audit-observer';
import { DomainEventBus } from './events/bus';
import type { AssetStorageInfo } from './lib/asset-storage-info';
import { trackBackground } from './lib/background';
import type { StorageInfo } from './lib/db-info';
import type { SandboxBackendInfo } from './lib/sandbox-backend-info';
import { ssoStatus } from './lib/sso-status';
import {
	getInstanceBaseUrl,
	getInstanceLocale,
	instanceLocaleIsConfigured,
} from './lib/system-meta';
import type { Env } from './lib/types';
import { generateLlmsTxt } from './mcp/llms-txt';
import { ONBOARDING_TOOLS } from './mcp/onboarding';
import { getToolDefs, handleMcpAssetUpload, handleMcpRequest, initMcpServer } from './mcp/server';
import { generateSkillFile } from './mcp/skill-file';
import { authMiddleware, requireProjectAccessMiddleware } from './middleware/auth';
import { agentHoursRoutes } from './routes/agent-hours';
import { agentTypesRoutes } from './routes/agent-types';
import { agentsRoutes } from './routes/agents';
import { aiProvidersRoutes } from './routes/ai-providers';
import { apiKeysRoutes } from './routes/api-keys';
import { approvalsRoutes } from './routes/approvals';
import { assetReviewRoutes } from './routes/asset-review';
import { buildAssetStorageInfoRoutes } from './routes/asset-storage-info';
import { assetsRoutes, publicAssetsRoutes } from './routes/assets';
import { auditLogRoutes } from './routes/audit-log';
import { authRoutes } from './routes/auth';
import { chatRoutes } from './routes/chat';
import { chatChannelRoutes } from './routes/chat-channels';
import { chatWebhookRoutes } from './routes/chat-webhooks';
import { commentsRoutes } from './routes/comments';
import { connectorsRoutes } from './routes/connectors';
import { containerHoursRoutes } from './routes/container-hours';
import { buildContainerRoutes } from './routes/containers';
import { costsRoutes } from './routes/costs';
import { customPromptRoutes } from './routes/custom-prompt';
import { buildDatabaseInfoRoutes } from './routes/database-info';
import { documentReviewRoutes } from './routes/document-review';
import { executionLocksRoutes } from './routes/execution-locks';
import { goalsRoutes } from './routes/goals';
import { healthRoutes } from './routes/health';
import { inboxRoutes } from './routes/inbox';
import { instanceSettingsRoutes } from './routes/instance-settings';
import { marketplaceRoutes } from './routes/marketplace';
import { meRoutes } from './routes/me';
import { mentionsRoutes } from './routes/mentions';
import { modelPricingRoutes } from './routes/model-pricing';
import { oauthRoutes } from './routes/oauth';
import { previewRoutes } from './routes/preview';
import { projectChatRoutes } from './routes/project-chat';
import { projectDocsRoutes } from './routes/project-docs';
import { projectsRoutes, publicProjectsRoutes } from './routes/projects';
import { queuedWakeupsRoutes } from './routes/queued-wakeups';
import { reposRoutes } from './routes/repos';
import { buildSandboxBackendInfoRoutes } from './routes/sandbox-backend-info';
import { searchRoutes } from './routes/search';
import { secretsRoutes } from './routes/secrets';
import { skillsRoutes } from './routes/skills';
import { tasksRoutes } from './routes/tasks';
import { teamTemplatesRoutes } from './routes/team-templates';
import { teamsRoutes } from './routes/teams';
import { uiStateRoutes } from './routes/ui-state';
import { buildUpdatesRoutes } from './routes/updates';
import { publicUsersRoutes, usersRoutes } from './routes/users';
import { AuthChallengeStore } from './services/auth-challenges';
import {
	backfillChatWebhookSecrets,
	buildChatChannelRegistry,
	buildInboundEventSink,
	type ChatChannelRegistry,
	wireManagerToChannels,
} from './services/chat-channels';
import { ChatSessionManager } from './services/chat-session-manager';
import { ContainerLogStreamer } from './services/container-logs';
import type { ContainerDeps } from './services/containers';
import { DockerClient } from './services/docker';
import { bindSecretsVaultToMasterKey, EgressProxy, loadOrCreateCA } from './services/egress';
import { ImageBuildTracker, setSharedImageBuildTracker } from './services/image-build-tracker';
import { JobManager } from './services/job-manager';
import { LogStreamBroker } from './services/log-stream-broker';
import { registerGenericOAuthRefresh } from './services/oauth/generic-refresh';
import { adminPasswordIsSet } from './services/password';
import { PricingService } from './services/pricing';
import {
	completeSandboxBackendOnUnlock,
	type StartupBackendResolution,
} from './services/sandbox/backend-store';
import { DOCKER_CONTAINER_HOST_ALIAS } from './services/sandbox/endpoints';
import { SandboxBackendHolder } from './services/sandbox/holder';
import { openSandboxBackend } from './services/sandbox/open';
import type { ContainerEngine } from './services/sandbox/types';
import { SshAgentServer } from './services/ssh-agent';
import { WebSocketManager } from './services/ws';
import { setStartupPhase } from './startup-progress';
import { loadStaticBundle } from './static-assets';
import { HEZO_VERSION } from './version';

export type { HezoConfig };

export type MasterKeyState = 'unset' | 'locked' | 'unlocked';

export interface AppConfig {
	dataDir: string;
	webUrl: string;
	/**
	 * Port the HTTP server listens on - the address the tunnel's `mcp` leg
	 * forwards to, so a container reaches Hezo on its own loopback without ever
	 * naming the host.
	 */
	serverPort?: number;
	/** A master key was configured at startup (env/CLI), so the instance auto-unlocks after a restart. */
	autoUnlock?: boolean;
	/**
	 * Pre-redacted storage metadata for the superuser settings endpoint. Never
	 * carries the raw connection URL — redaction happened at startup.
	 */
	storageInfo?: StorageInfo;
	/** Pre-redacted asset-storage metadata — same contract as `storageInfo`. */
	assetStorageInfo?: AssetStorageInfo;
	/**
	 * The live container-backend holder.
	 *
	 * A holder rather than the metadata it used to carry, because the backend is
	 * now switchable at runtime: the settings route reads *and re-points* it, so
	 * a snapshot taken at boot would go stale the moment an operator switched.
	 */
	sandboxHolder?: SandboxBackendHolder;
}

export interface StartupResult {
	app: Hono<Env>;
	port: number;
	masterKeyState: MasterKeyState;
	jobManager: JobManager;
	chatSessionManager: ChatSessionManager;
	wsManager: WebSocketManager;
	db: Db;
	assetStore: AssetStore;
	docker: ContainerEngine;
	masterKeyManager: MasterKeyManager;
	logs: LogStreamBroker;
	containerLogStreamer: ContainerLogStreamer;
	sshAgentServer: SshAgentServer;
	egressProxy: EgressProxy;
	/** Live reload of the deployer's pinned settings; closed on shutdown. */
	policyWatcher: { close: () => void };
}

export async function startup(config: HezoConfig): Promise<StartupResult> {
	mkdirSync(config.dataDir, { recursive: true });
	log.info(`Using data directory: ${config.dataDir}`);
	// Name the file, or say plainly that there is none: `--config` has no implicit
	// search, so an operator who wrote a config file and forgot the flag would
	// otherwise see a silently default-configured server.
	log.info(
		config.configPath
			? `Using config file: ${config.configPath}`
			: 'No config file (--config not given); using defaults plus any flags',
	);

	// Armed before anything slow, so a plan change landing during a long boot is
	// picked up rather than missed. A deployment changes what it pins while the
	// server runs, and restarting to apply it would kill in-flight agent runs -
	// which under an hours meter is billed container time thrown away.
	const policyWatcher = watchPolicyFile(config.policyFile);

	if (config.telemetry?.enabled) {
		log.info(
			'Anonymous usage telemetry is enabled - aggregate counts only (no names, content, or costs). Disable with --disable-telemetry, or `telemetry: { enabled: false }` in your config file.',
		);
	}

	// `db` may be replaced by a fresh handle if migrations run against a copy and
	// swap it in, so it's a `let` — every consumer below uses the post-migration handle.
	setStartupPhase('database');
	const opened = await openDatabase({
		dataDir: config.dataDir,
		databaseUrl: config.database.url,
		reset: config.reset,
	});
	let db = opened.db;
	// Pre-redacted display metadata (settings endpoint + logs). The raw
	// databaseUrl deliberately stops here — it is never handed to buildApp, so
	// no request handler can reach it.
	const storageInfo = opened.storage;

	// Embedded PGlite is single-process. Drop an advisory PID lock so the
	// `hezo backup` / `hezo restore` preflight refuses while this server is live
	// (opening a second cluster over the same pgdata files can corrupt them).
	// Overwrites any stale lock from a prior crash; removed on graceful exit.
	// External Postgres manages its own concurrency and needs no lock.
	if (storageInfo.backend === 'embedded') {
		const { writeInstanceLock } = await import('./db/instance-lock.js');
		writeInstanceLock(config.dataDir);
	}

	await db.exec(BASE_SCHEMA);
	// The detail callback keeps the loading screen naming the step in flight (the
	// pgdata copy, then each migration). Without it a multi-minute migration on a
	// large instance is indistinguishable from a hung server.
	setStartupPhase('migrations');
	db = await runAvailableMigrations(db, config.dataDir, (detail) =>
		setStartupPhase('migrations', detail),
	);
	setStartupPhase('seed');
	await runSeed(db);

	// One-time reclaim of the disk space the pre-chunk run-log write pattern
	// left behind (migration 041 drops `heartbeat_runs.log_text`, but the column
	// drop is metadata-only — the dead TOAST graveyard stays until a VACUUM FULL
	// rewrites the table). Marker-gated, embedded-only, and synchronous on
	// purpose: PGlite is single-connection, so running it in the background
	// would stall the first requests anyway. Can take a while on a multi-GB
	// table — once, on the first post-upgrade boot.
	try {
		const { runLegacyRunLogVacuumOnce } = await import('./db/run-log-chunks.js');
		await runLegacyRunLogVacuumOnce(db, storageInfo.backend, {
			// Fires only when the reclaim actually runs (marker-gated), so instances
			// that skip it never show the message.
			onStart: () =>
				setStartupPhase(
					'seed',
					'Reclaiming disk space from old run logs - one time only, can take a few minutes',
				),
		});
	} catch (err) {
		log.error('One-time legacy run-log reclaim failed (will retry next startup):', err);
	}

	// Asset blob storage: local filesystem by default, S3-compatible object
	// storage when configured. Like databaseUrl, the raw assetStorageUrl stops
	// here — only the pre-redacted info travels further.
	setStartupPhase('asset-storage');
	const { store: assetStore, info: assetStorageInfo } = await openAssetStorage({
		dataDir: config.dataDir,
		assetStorageUrl: config.assetStorage.url,
	});

	// Runtime model pricing: load the table into memory (migrations bake in a
	// catalog snapshot, so it's never empty) and, unless disabled, refresh from
	// the live pricepertoken.com catalog in the background. Drives per-run cost
	// across every runtime; the job manager re-refreshes daily.
	setStartupPhase('pricing');
	const pricing = new PricingService(db);
	await pricing.init({ refresh: !process.env.HEZO_SKIP_PRICING_REFRESH });

	// Register the single generic host-side OAuth refresh fn. It makes
	// `refreshExpiringTokens` real for any oauth_connection carrying token_url +
	// client_id in metadata (broker connections), refreshing the short-lived
	// access token from the durable refresh token + host-only client secret.
	registerGenericOAuthRefresh();

	const masterKeyManager = new MasterKeyManager();
	const masterKeyState = await resolveMasterKeyState(db, masterKeyManager, config.masterKey);

	// The backend is chosen here from the **stored setting**, which the launch
	// flag only seeds on a fresh instance - so an operator who switched from the
	// Containers page comes back on what they chose, not on what the command line
	// happens to say. It can change at runtime now, which is why everything below
	// receives `holder.engine` (a stable proxy) rather than the engine itself: a
	// captured reference would keep driving the backend they just left.
	//
	// Still no dynamic failover. A backend that cannot be reached aborts startup
	// exactly as before; the holder swaps *which* backend is current, never picks
	// a second one because the first is down.
	setStartupPhase('sandbox');
	let initialEngine: ContainerEngine;
	let sandboxBackendInfo: SandboxBackendInfo;
	// Set when the backend's credential is in the locked vault, so the open has
	// to wait for the unlock. Null on every other path, including Docker.
	let deferredBackend: StartupBackendResolution | null = null;
	if (process.env.HEZO_SKIP_DOCKER) {
		// The fake needs the db (it synthesizes agent output), which is why this
		// branch stays here rather than inside `openSandboxBackend`.
		const { createFakeDockerClient } = await import('./services/fake-docker.js');
		initialEngine = createFakeDockerClient(db);
		sandboxBackendInfo = { backend: 'docker', display: 'local Docker daemon' };
	} else {
		const { resolveStartupBackend } = await import('./services/sandbox/backend-store.js');
		const resolved = await resolveStartupBackend(db, masterKeyManager, {
			backend: config.containers.backend,
			daytonaApiKey: config.containers.daytona.apiKey,
			daytonaApiUrl: config.containers.daytona.apiUrl,
		});
		deferredBackend = resolved;
		if (resolved.deferred) {
			// The credential exists but only the vault has it, and an instance boots
			// locked by design. Holding a pending engine until the unlock is what lets
			// a managed backend survive a restart at all - the alternatives were
			// failing every boot, or quietly running on Docker instead.
			const { createPendingEngine, pendingUnlockMessage } = await import(
				'./services/sandbox/pending.js'
			);
			const { redactSandboxApiUrl } = await import('./lib/sandbox-backend-info.js');
			const { DEFAULT_DAYTONA_API_URL } = await import('./services/sandbox/daytona/client.js');
			const display = redactSandboxApiUrl(resolved.daytonaApiUrl || DEFAULT_DAYTONA_API_URL);
			initialEngine = createPendingEngine(pendingUnlockMessage(display));
			sandboxBackendInfo = { backend: resolved.backend, display };
			log.info(
				`Sandbox backend: ${resolved.backend} (${display}) - connecting once the instance is unlocked`,
			);
		} else {
			({ engine: initialEngine, info: sandboxBackendInfo } = await openSandboxBackend({
				backend: resolved.backend,
				daytonaApiKey: resolved.daytonaApiKey,
				daytonaApiUrl: resolved.daytonaApiUrl,
				// An operator who pinned a socket did so because discovery does not
				// reach their daemon; dropping it here would silently ignore the flag
				// and send them round the discovery loop it exists to bypass.
				dockerSocket: config.containers.dockerSocket,
			}));
		}
	}
	const { SandboxBackendHolder } = await import('./services/sandbox/holder.js');
	const sandboxHolder = new SandboxBackendHolder({
		engine: initialEngine,
		info: sandboxBackendInfo,
		dataDir: config.dataDir,
	});
	// Everything downstream takes the proxy. Nothing may capture `initialEngine`.
	const docker: ContainerEngine = sandboxHolder.engine;

	// Host-side setup, asked of whichever backend is in use. What it does is that
	// backend's business: the local daemon extracts its embedded build context and
	// refreshes images, a managed service has no host state and does nothing. This
	// used to be two `initialEngine instanceof DockerClient` branches - a capability
	// branch above the seam, which had already silently broken once when the holder
	// proxy made `instanceof` false and image setup stopped happening at all.
	//
	// Skipped only while the open is deferred: no backend is current then, so
	// there is no host to prepare, and the unlock that opens the real one prepares
	// it as part of the swap. That is a lifecycle question - "is a backend current
	// yet?" - and not the capability question - "which backend is this?" - that the
	// seam exists to forbid. Asking anyway is what exited the boot: the pending
	// engine throws from every member by design, and the caught error reads as a
	// fatal unreachable backend rather than the healthy locked instance it is.
	if (!deferredBackend?.deferred) await sandboxHolder.prepareHost();

	const wsManager = new WebSocketManager();
	const logs = new LogStreamBroker();
	logs.setWsManager(wsManager);
	// Tracks shared base-image builds and broadcasts progress to the global
	// `image-builds` room. Registered process-wide so the deduplicated build in
	// ensure-image.ts reaches it regardless of which project triggered it.
	const imageBuildTracker = new ImageBuildTracker();
	imageBuildTracker.setWsManager(wsManager);
	setSharedImageBuildTracker(imageBuildTracker);
	const containerLogStreamer = new ContainerLogStreamer();
	// The egress proxy and SSH bridge bind loopback, always: a container reaches
	// them through its own tunnel, whose host-side end dials them from this
	// process. Nothing outside the host ever needs a route to either, so there is
	// no interface to choose and none to firewall.
	const sshAgentServer = new SshAgentServer({ db, masterKeyManager });
	await cleanupOrphanRunSockets(db, config.dataDir);
	const egressCA = await loadOrCreateCA(config.dataDir);
	const egressProxy = new EgressProxy({
		db,
		masterKeyManager,
		ca: egressCA,
		authEnabled: config.egress.proxyAuth,
		allowPrivateTargets: config.egress.allowPrivateTargets,
		// Hezo's own MCP/asset endpoint as a container addresses it. Already in the
		// run's NO_PROXY, so it should never reach the proxy — but NO_PROXY is a
		// client-side convention, and a runtime that ignores it would otherwise have
		// its tool traffic refused by the destination guard.
		selfEndpoint: { host: DOCKER_CONTAINER_HOST_ALIAS, port: config.port },
	});
	// Decrypted secrets must never outlive the unlock that produced them.
	bindSecretsVaultToMasterKey(masterKeyManager);
	// Verify agent containers get a WRITABLE view of the data directory. Every
	// agent works on a bind mount of it, and a VM-backed runtime only shares the
	// host paths it was told to - Colima shares $HOME read-only by default - so an
	// otherwise healthy Docker setup can leave every run failing on its first
	// write, with an error that reads as a broken agent. Backgrounded and
	// non-fatal: the operator needs the web UI up to act on the guidance.
	//
	// Docker only, and deliberately: the check is about *bind mounts of a host
	// path*, which a managed backend has none of - its filesystem is the
	// sandbox's own. Running it there would boot a throwaway container on a paid
	const events = new DomainEventBus();
	const jobManager = new JobManager({
		db,
		docker,
		masterKeyManager,
		serverPort: config.port,
		dataDir: config.dataDir,
		wsManager,
		events,
		logs,
		containerLogStreamer,
		sshAgentServer,
		egressProxy,
		egressCAPath: egressCA.certPath,
		pricing,
		storageBackend: storageInfo.backend,
		telemetry: config.telemetry,
		autoInstallUpdates: config.updates.autoInstall,
	});
	const chatSessionManager = new ChatSessionManager({
		db,
		docker,
		masterKeyManager,
		serverPort: config.port,
		dataDir: config.dataDir,
		wsManager,
		events,
		logs,
		sshAgentServer,
		egressProxy,
		egressCAPath: egressCA.certPath,
		containerLogStreamer,
	});

	// External chat channel adapters (Telegram + Slack now, Discord later). The
	// registry is channel-agnostic; wiring the manager's delivery/close hooks routes
	// external replies + thread closes through the right adapter without any
	// platform branch. The sink is the reverse seam: socket-transport adapters
	// (Slack Socket Mode) push inbound events through it into the same ingest
	// functions the webhook route uses.
	const chatChannelRegistry = buildChatChannelRegistry({
		db,
		masterKeyManager,
		sink: buildInboundEventSink({ db, manager: chatSessionManager }),
	});
	wireManagerToChannels(chatSessionManager, chatChannelRegistry);

	setStartupPhase('workspace');
	// On a genuinely fresh instance (HQ not yet seeded) install the default skills
	// automatically — no opt-in. Must run before seedDefaultTeam creates HQ, so
	// "HQ absent" reads as "first boot". An existing instance is a no-op and keeps
	// the opt-in button on the Skills page.
	try {
		const { installDefaultSkillsIfFreshInstance } = await import('./db/default-skills.js');
		await installDefaultSkillsIfFreshInstance(db);
	} catch (err) {
		log.error('Failed to install default skills on fresh instance:', err);
	}
	const { seedDefaultTeam } = await import('./services/teams.js');
	try {
		await seedDefaultTeam({
			db,
			docker,
			wsManager,
			masterKeyManager,
			logs,
			containerLogStreamer,
			dataDir: config.dataDir,
			egressCAPath: egressCA.certPath,
		});
	} catch (err) {
		log.error('Failed to seed default team:', err);
	}

	// Before the app serves a request, and regardless of lock state: the API must
	// never show a run as `running` when the process driving it is gone. Both
	// halves below are raw SQL - the container-backend passes stay behind the
	// unlock hook, where a connected engine exists.
	setStartupPhase('workspace', 'Recovering runs interrupted by the last shutdown');
	try {
		await jobManager.reconcileDatabaseOnStartup();
		await chatSessionManager.reconcileDatabaseOnStartup();
	} catch (err) {
		log.error('Startup database reconciliation failed:', err);
	}

	function startUnlockedServices(): void {
		// The crons deliberately stay here rather than joining the repair above. A
		// locked instance dispatches nothing - dispatch needs the backend and the
		// provider credentials - and `MasterKeyManager` has no re-lock path, so no
		// run can go stale while locked. The boot repair closes the only gap;
		// starting the wakeup dispatcher against a pending engine would open a new
		// one.
		jobManager
			.reconcileContainersOnStartup()
			.catch((err) => log.error('Startup container reconciliation failed:', err))
			.finally(() => {
				jobManager.start();
				// Warm the HQ container as soon as the instance is unlocked so the CEO
				// chat and project creation are ready without waiting for first use.
				// Provisioning needs the master key, hence after unlock; fire-and-forget
				// so a slow image pull doesn't hold up the rest of startup.
				trackBackground(
					jobManager
						.ensureHqContainerRunning()
						.catch((err) => log.error('Failed to warm HQ container on startup:', err)),
				);
			});
		// Re-encode any legacy plaintext webhook secret (migration 050) before the
		// adapters come up. Needs the master key, which migrations at boot do not
		// have — this is the first moment it exists. Idempotent: a no-op once every
		// row is converted. Sequenced ahead of startAll() only for tidiness; reads
		// fall back to the legacy column, so the order is not load-bearing.
		trackBackground(
			backfillChatWebhookSecrets({ db, masterKeyManager })
				.then((n) => {
					if (n > 0) log.info(`Encrypted ${n} legacy chat webhook secret(s) at rest`);
				})
				.catch((err) => log.error('Failed to encrypt legacy chat webhook secrets:', err))
				.finally(() => {
					// Bring enabled external chat channels online (register webhooks / open
					// gateways). Needs the master key (bot tokens) — hence after unlock.
					trackBackground(
						chatChannelRegistry
							.startAll()
							.catch((err) => log.error('Failed to start chat channels:', err)),
					);
				}),
		);
	}

	masterKeyManager.onUnlock(() => {
		// Connecting the backend goes first, because everything in
		// `startUnlockedServices` drives the container engine and a deferred open is
		// still holding the pending one. Sequencing here is what keeps "deferred"
		// invisible downstream: the job manager, the chat manager and the HQ warm-up
		// each start against a real backend, exactly as they would have if the vault
		// had been readable at boot.
		const connected = deferredBackend
			? completeSandboxBackendOnUnlock(db, masterKeyManager, sandboxHolder, deferredBackend)
			: Promise.resolve();
		trackBackground(
			connected
				// Not fatal to the process - this is long past startup - but not
				// papered over either: the pending engine stays in place, so every
				// container operation reports this instead of running somewhere
				// unintended.
				.catch((err) => log.error('Failed to connect the container backend after unlock:', err))
				.then(startUnlockedServices),
		);
	});

	const app = buildApp(
		db,
		masterKeyManager,
		{
			dataDir: config.dataDir,
			webUrl: config.webUrl,
			serverPort: config.port,
			autoUnlock: config.masterKey !== undefined,
			storageInfo,
			assetStorageInfo,
			sandboxHolder,
		},
		docker,
		wsManager,
		jobManager,
		logs,
		sshAgentServer,
		egressProxy,
		containerLogStreamer,
		events,
		chatSessionManager,
		pricing,
		assetStore,
		chatChannelRegistry,
	);

	return {
		app,
		port: config.port,
		masterKeyState,
		jobManager,
		chatSessionManager,
		wsManager,
		db,
		assetStore,
		docker,
		masterKeyManager,
		logs,
		containerLogStreamer,
		sshAgentServer,
		egressProxy,
		policyWatcher,
	};
}

export function buildApp(
	db: Db,
	masterKeyManager: MasterKeyManager,
	config: AppConfig = { dataDir: '', webUrl: '' },
	docker: ContainerEngine = new DockerClient(),
	wsManager: WebSocketManager = new WebSocketManager(),
	jobManager?: JobManager,
	logs: LogStreamBroker = new LogStreamBroker(),
	sshAgentServer: SshAgentServer | null = null,
	egressProxy: EgressProxy | null = null,
	containerLogStreamer: ContainerLogStreamer = new ContainerLogStreamer(),
	events: DomainEventBus = new DomainEventBus(),
	chatSessionManager?: ChatSessionManager,
	pricing?: PricingService,
	assetStore?: AssetStore,
	chatChannelRegistry?: ChatChannelRegistry,
): Hono<Env> {
	const app = new Hono<Env>();
	const authChallenges = new AuthChallengeStore();
	// Blob storage for assets. Startup passes the store selected by
	// openAssetStorage; tests booting buildApp directly fall back to the local
	// filesystem driver under the test data dir.
	const assets = assetStore ?? new LocalAssetStore(config.dataDir);
	logs.setWsManager(wsManager);
	registerAuditObserver(events, db);

	app.onError((err, c) => {
		log.error(`Route error on ${c.req.method} ${c.req.path}:`, err);
		return c.text('Internal Server Error', 500);
	});

	// Compress text responses. Nothing was compressed before: every JSON payload
	// and every SPA asset shipped raw, which on a self-hosted instance reached
	// over a link the operator does not control. Hono's middleware honours
	// Accept-Encoding and skips responses that are already encoded, so
	// pre-compressed asset bodies (images, gzipped bundles) pass through
	// untouched. Streamed responses are not buffered to compress them.
	app.use('*', compress());

	// Ceiling on every request body the API accepts. Only the handful of upload
	// routes were capped, so a JSON body had no bound at all - one request could
	// ask the process to buffer arbitrarily much before a handler ever saw it.
	// Deliberately well above every per-route cap (see `API_BODY_MAX_BYTES`) so
	// it is a pure backstop and never the binding constraint: routes that police
	// their own size still answer with their own specific error, and a
	// legitimately-sized upload is never rejected for its multipart envelope.
	// `/mcp` and `/mcp/assets` sit outside `/api` - the agent surface is not
	// capped here.
	app.use(
		'/api/*',
		bodyLimit({
			maxSize: API_BODY_MAX_BYTES,
			onError: (c) =>
				c.json(
					{
						error: {
							code: 'TOO_LARGE',
							message: `Request body exceeds ${API_BODY_MAX_BYTES / (1024 * 1024)} MB`,
						},
					},
					413,
				),
		}),
	);

	app.use('*', async (c, next) => {
		c.set('db', db);
		c.set('assetStore', assets);
		c.set('masterKeyManager', masterKeyManager);
		c.set('authChallenges', authChallenges);
		c.set('docker', docker);
		c.set('wsManager', wsManager);
		c.set('events', events);
		if (jobManager) c.set('jobManager', jobManager);
		if (chatSessionManager) c.set('chatSessionManager', chatSessionManager);
		if (chatChannelRegistry) c.set('chatChannelRegistry', chatChannelRegistry);
		c.set('logs', logs);
		c.set('containerLogStreamer', containerLogStreamer);
		c.set('dataDir', config.dataDir);
		c.set('webUrl', config.webUrl);
		c.set('sshAgentServer', sshAgentServer);
		c.set('egressProxy', egressProxy);
		if (pricing) c.set('pricing', pricing);
		return next();
	});

	// Initialize MCP server. The container deps let the CEO's `create_project`
	// tool provision a container for a project it creates (the same way the
	// `POST /api/projects` route does).
	const mcpContainerDeps: ContainerDeps = {
		db,
		docker,
		dataDir: config.dataDir,
		wsManager,
		masterKeyManager,
		logs,
		containerLogStreamer,
		sshAgentServer,
		egressProxy,
		egressCAPath: egressProxy?.caCertPath ?? null,
	};
	initMcpServer(
		db,
		config.dataDir,
		masterKeyManager,
		wsManager,
		events,
		mcpContainerDeps,
		assets,
		config.serverPort,
	);

	// Public routes
	app.route('/', healthRoutes);

	// `/api/status` carries master-key state + version. `/` is left to the SPA
	// catch-all below (the compiled binary serves index.html there).
	const statusHandler = async (c: Context<Env>) => {
		// passwordSet tells the gate whether to show the login screen (true) or the
		// create-password flow (false). Only meaningful once unlocked; cheap enough
		// to always compute.
		const db = c.get('db');
		const passwordSet =
			masterKeyManager.getState() === 'unlocked' ? await adminPasswordIsSet(db) : false;
		// Locale rides on the public status payload because every pre-auth screen
		// (the language step, the master-key gate, the login form) has to render in
		// the operator's language before any credential exists. It is a display
		// preference, not sensitive. `configured` drives the onboarding gate.
		return c.json({
			masterKeyState: masterKeyManager.getState(),
			passwordSet,
			version: HEZO_VERSION,
			locale: await getInstanceLocale(db),
			localeConfigured: await instanceLocaleIsConfigured(db),
			...ssoStatus(),
		});
	};
	app.get('/api/status', statusHandler);

	// Agent manifest (public). Lists the onboarding tools first, then every MCP
	// tool, and explains how to connect and self-register.
	app.get('/SKILL.md', async (c) => {
		const baseUrl = (await getInstanceBaseUrl(c.get('db'))) ?? new URL(c.req.url).origin;
		const md = generateSkillFile([...ONBOARDING_TOOLS, ...getToolDefs()], { baseUrl });
		return c.text(md, 200, { 'Content-Type': 'text/markdown; charset=utf-8' });
	});

	// llms.txt (public) — minimal pointer to SKILL.md for the MCP API.
	app.get('/llms.txt', async (c) => {
		const baseUrl = (await getInstanceBaseUrl(c.get('db'))) ?? new URL(c.req.url).origin;
		return c.text(generateLlmsTxt({ baseUrl }), 200, {
			'Content-Type': 'text/markdown; charset=utf-8',
		});
	});

	// MCP endpoint (authenticated). Only JSON-RPC POST is supported; the
	// server does not offer an SSE event stream or session lifecycle, so
	// GET/DELETE return 405 per the MCP Streamable-HTTP transport spec.
	app.post('/mcp', (c) => handleMcpRequest(c));
	app.on(['GET', 'DELETE'], '/mcp', (c) => c.text('Method Not Allowed', 405, { Allow: 'POST' }));

	// Binary file upload on the MCP surface (multipart/form-data). JSON-RPC can't
	// carry a file, so external/agent callers POST here with the same bearer auth.
	app.post(
		'/mcp/assets',
		bodyLimit({
			maxSize: ATTACHMENT_MAX_BYTES,
			onError: (c) =>
				c.json({ error: { code: 'TOO_LARGE', message: 'Attachment exceeds 10 MB' } }, 413),
		}),
		(c) => handleMcpAssetUpload(c),
	);
	app.on(['GET', 'DELETE'], '/mcp/assets', (c) =>
		c.text('Method Not Allowed', 405, { Allow: 'POST' }),
	);

	// Auth routes (token endpoint is public, handled before auth middleware)
	app.route('/api', authRoutes);

	// Public signed-URL asset read endpoint (sig query is the credential, so it
	// must be reachable without a bearer token).
	app.route('/', publicAssetsRoutes);

	// Public signed-URL project-icon read endpoint — same rationale (rendered in
	// an <img>, so the sig query param is the credential). Mounted before the
	// /api/* auth + project-access middleware so it bypasses the bearer check.
	app.route('/', publicProjectsRoutes);

	// Public signed-URL agent-avatar read endpoint — same rationale as the
	// project icon. Mounted before the /api/* auth middleware.

	// Public signed-URL user-avatar read endpoint — same rationale as the
	// project icon. Mounted before the /api/* auth middleware.
	app.route('/', publicUsersRoutes);

	// Public inbound webhook surface for external chat channels. Mounted before the
	// /api/* bearer-auth middleware — inbound platform requests carry no Hezo token
	// and are authenticated by a per-channel shared secret in the URL/header.
	app.route('/', chatWebhookRoutes);

	// Auth middleware for all /api/* routes
	app.use('/api/*', authMiddleware);

	// Project-scoped routes: resolve :projectId (slug/UUID) → its project and
	// backing team, assert access once. Handlers read c.get('projectId') and
	// c.get('teamId'). The project slug is the public handle for every
	// project-addressed resource (tasks, agents, inbox, team settings, …); the
	// team is resolved from the project rather than named in the URL.
	app.use('/api/projects/:projectId/*', requireProjectAccessMiddleware);

	// CRUD routes
	app.route('/api', agentTypesRoutes);
	app.route('/api', teamTemplatesRoutes);
	app.route('/api', marketplaceRoutes);
	app.route('/api', teamsRoutes);
	app.route('/api', meRoutes);
	app.route('/api', usersRoutes);
	app.route('/api', agentsRoutes);
	app.route('/api', projectsRoutes);
	app.route('/api', buildContainerRoutes());
	app.route('/api', tasksRoutes);
	app.route('/api', goalsRoutes);
	app.route('/api', commentsRoutes);
	app.route('/api', assetsRoutes);
	app.route('/api', secretsRoutes);
	app.route('/api', approvalsRoutes);
	app.route('/api', inboxRoutes);
	app.route('/api', costsRoutes);
	app.route('/api', apiKeysRoutes);
	app.route('/api', skillsRoutes);
	app.route('/api', customPromptRoutes);
	app.route('/api', uiStateRoutes);
	app.route('/api', projectDocsRoutes);
	app.route('/api', documentReviewRoutes);
	app.route('/api', assetReviewRoutes);
	app.route('/api', mentionsRoutes);
	app.route('/api', aiProvidersRoutes);
	app.route('/api', instanceSettingsRoutes);
	// Storage metadata cards (General settings). Tests boot buildApp without
	// the infos — derive the local defaults so the endpoints stay truthful.
	app.route(
		'/api',
		buildDatabaseInfoRoutes(
			config.storageInfo ?? { backend: 'embedded', display: join(config.dataDir, 'pgdata') },
			config.dataDir,
		),
	);
	app.route(
		'/api',
		buildAssetStorageInfoRoutes(
			config.assetStorageInfo ?? { backend: 'local', display: join(config.dataDir, 'assets') },
		),
	);
	app.route(
		'/api',
		buildSandboxBackendInfoRoutes(
			config.sandboxHolder ??
				new SandboxBackendHolder({
					engine: docker,
					info: { backend: 'docker', display: 'local Docker daemon' },
					dataDir: config.dataDir,
				}),
		),
	);
	app.route('/api', modelPricingRoutes);
	app.route('/api', reposRoutes);
	app.route('/api', executionLocksRoutes);
	app.route('/api', queuedWakeupsRoutes);
	app.route('/api', auditLogRoutes);
	app.route('/api', agentHoursRoutes);
	app.route('/api', containerHoursRoutes);
	app.route('/api', connectorsRoutes);
	app.route('/api', oauthRoutes);
	app.route('/api', previewRoutes);
	app.route('/api', searchRoutes);
	app.route('/api', buildUpdatesRoutes({ autoUnlock: config.autoUnlock ?? false }));
	app.route('/api', chatRoutes);
	app.route('/api', projectChatRoutes);
	app.route('/api', chatChannelRoutes);

	// Frontend (SPA) serving. The compiled binary serves from the in-memory
	// bundle embedded at build time (`loadStaticBundle`); in dev that bundle is
	// absent, so we fall back to reading `packages/web/dist` off disk. Run the
	// vite dev server for hot-reload during development.
	const STATIC_MIME: Record<string, string> = {
		'.html': 'text/html; charset=utf-8',
		'.css': 'text/css; charset=utf-8',
		'.js': 'application/javascript; charset=utf-8',
		'.json': 'application/json; charset=utf-8',
		'.webmanifest': 'application/manifest+json; charset=utf-8',
		'.png': 'image/png',
		'.jpg': 'image/jpeg',
		'.svg': 'image/svg+xml',
		'.ico': 'image/x-icon',
		'.woff2': 'font/woff2',
	};
	const webDistDir = resolve(new URL('.', import.meta.url).pathname, '..', '..', 'web', 'dist');

	app.get('*', async (c) => {
		const urlPath = new URL(c.req.url).pathname;
		if (urlPath.startsWith('/api/')) {
			return c.text('Not found', 404);
		}
		const filePath = urlPath === '/' ? '/index.html' : urlPath;

		// In-memory bundle (compiled binary).
		const bundle = await loadStaticBundle();
		if (bundle) {
			const asset = bundle.get(filePath) ?? bundle.get('/index.html');
			if (!asset) return c.text('Not found', 404);
			return new Response(asset.body, { headers: { 'Content-Type': asset.type } });
		}

		// Filesystem fallback (dev / `bun run`). Read straight through rather than
		// stat-then-read: `existsSync` + `readFileSync` was two syscalls per
		// request for one file (three on the index fallback), and the stat told us
		// nothing the read does not. Reads stay uncached so a `vite build` during
		// dev is picked up on the next request.
		const fullPath = join(webDistDir, filePath);
		const body = readFileIfPresent(fullPath);
		if (body) {
			const ext = extname(fullPath).toLowerCase();
			return new Response(body, {
				headers: { 'Content-Type': STATIC_MIME[ext] || 'application/octet-stream' },
			});
		}
		// SPA fallback: any unmatched path renders the client-side router.
		const index = readFileIfPresent(join(webDistDir, 'index.html'));
		if (index) {
			return new Response(index, {
				headers: { 'Content-Type': 'text/html; charset=utf-8' },
			});
		}

		return c.text('Not found', 404);
	});

	return app;
}

/**
 * Read a file, or `null` when it is not there. Collapses the stat-then-read pair
 * the static fallback used to do into one syscall, and closes the window between
 * them (a file deleted after the `existsSync` threw out of the handler).
 * Anything other than "not present" still throws - a permissions or IO error is
 * a real fault and must not be reported to the browser as a 404.
 */
function readFileIfPresent(path: string): Buffer<ArrayBuffer> | null {
	try {
		return readFileSync(path);
	} catch (e) {
		const code = (e as NodeJS.ErrnoException).code;
		if (code === 'ENOENT' || code === 'ENOTDIR' || code === 'EISDIR') return null;
		throw e;
	}
}

async function cleanupOrphanRunSockets(_db: Db, dataDir: string): Promise<void> {
	const fs = await import('node:fs/promises');
	const { join } = await import('node:path');
	const { getRunSocketDir } = await import('./services/workspace.js');
	const socketDir = getRunSocketDir(dataDir);
	for (const entry of await fs.readdir(socketDir).catch(() => [])) {
		if (!entry.endsWith('.sock')) continue;
		await fs.rm(join(socketDir, entry), { force: true }).catch(() => undefined);
	}
}

async function loadMigrations(): Promise<Record<string, Migration> | null> {
	// Shared with the backup/restore CLI — bundled SQL (binary) or the source
	// tree (dev/tests), merged with code migrations into one sorted sequence.
	const { loadAllMigrations } = await import('./db/load-migrations.js');
	return loadAllMigrations();
}

async function runAvailableMigrations(
	db: Db,
	dataDir: string,
	onProgress?: (detail: string) => void,
): Promise<Db> {
	const migrations = await loadMigrations();
	if (!migrations) {
		log.warn('No migrations found. Run build:migrations or add migration files.');
		return db;
	}

	// External Postgres migrates IN PLACE under an advisory lock (there is no
	// datadir to copy-swap); the handle never changes.
	if (db.kind === 'postgres') {
		const { applyPendingMigrationsExternal } = await import('./db/migrate-external.js');
		await applyPendingMigrationsExternal(db, migrations, {
			backup: { dir: join(dataDir, 'backups'), version: HEZO_VERSION },
			onProgress,
		});
		return db;
	}

	// Embedded: migrate a copy and swap on success; on failure the original is
	// untouched (a downgraded binary can run against it as-is). Returns the live
	// handle to use, which is a fresh one after a successful swap.
	const { applyPendingMigrations } = await import('./db/migrate-runner.js');
	return applyPendingMigrations(db, dataDir, migrations, { onProgress });
}

async function runSeed(db: Db): Promise<void> {
	try {
		const { loadAgentRoles } = await import('./db/agent-roles.js');
		const { seedBuiltins } = await import('./db/seed.js');
		const roleDocs = await loadAgentRoles();
		await seedBuiltins(db, roleDocs);
	} catch (err) {
		if (
			err instanceof Error &&
			(err.message.includes('Cannot find module') || err.message.includes('Cannot find package'))
		) {
			return;
		}
		log.error('Seed failed:', err);
	}
	// Default global skills are NOT auto-seeded at boot — an existing instance
	// upgrading shouldn't have 15 skills materialize unasked. The operator installs
	// them from the global Skills page (a button offers the missing ones behind a
	// confirmation); see db/default-skills.ts and routes/skills.ts.
}

async function resolveMasterKeyState(
	db: Db,
	masterKeyManager: MasterKeyManager,
	masterKey?: { unlockKeyHex: string; publicKeyHex: string },
): Promise<MasterKeyState> {
	try {
		const state = await masterKeyManager.initialize(
			db,
			masterKey?.unlockKeyHex,
			masterKey?.publicKeyHex,
		);

		const messages: Record<string, string> = {
			unlocked: 'Master key verified. Server unlocked.',
			unset: 'No master key set. Set via web UI on first login.',
			locked: masterKey
				? 'Invalid master key provided. Server starting in locked state.'
				: 'Server starting in locked state. Provide master key to unlock.',
		};
		log.info(messages[state]);
		return state;
	} catch {
		log.warn('Master key module not available. Skipping key verification.');
		return 'unset';
	}
}
