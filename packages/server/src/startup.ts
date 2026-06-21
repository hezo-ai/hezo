import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import type { PGlite } from '@electric-sql/pglite';
import { type Context, Hono } from 'hono';
import type { HezoConfig } from './cli';
import { logger } from './logger';

const log = logger.child('startup');

import { MasterKeyManager } from './crypto/master-key';
import { openPersistentDb } from './db/client';
import type { Migration } from './db/migrate';
import { BASE_SCHEMA } from './db/schema';
import { registerAuditObserver } from './events/audit-observer';
import { DomainEventBus } from './events/bus';
import { getInstanceBaseUrl } from './lib/system-meta';
import type { Env } from './lib/types';
import { generateLlmsTxt } from './mcp/llms-txt';
import { ONBOARDING_TOOLS } from './mcp/onboarding';
import { getToolDefs, handleMcpRequest, initMcpServer } from './mcp/server';
import { generateSkillFile } from './mcp/skill-file';
import { authMiddleware, requireProjectAccessMiddleware } from './middleware/auth';
import { agentApiRoutes } from './routes/agent-api';
import { agentConnectionsRoutes } from './routes/agent-connections';
import { agentTypesRoutes } from './routes/agent-types';
import { agentsRoutes } from './routes/agents';
import { aiProvidersRoutes } from './routes/ai-providers';
import { apiKeysRoutes } from './routes/api-keys';
import { approvalsRoutes } from './routes/approvals';
import { assetsRoutes, publicAssetsRoutes } from './routes/assets';
import { auditLogRoutes } from './routes/audit-log';
import { authRoutes } from './routes/auth';
import { ceoChatRoutes } from './routes/ceo-chat';
import { commentsRoutes } from './routes/comments';
import { costsRoutes } from './routes/costs';
import { executionLocksRoutes } from './routes/execution-locks';
import { healthRoutes } from './routes/health';
import { inboxRoutes } from './routes/inbox';
import { instanceSettingsRoutes } from './routes/instance-settings';
import { mcpConnectionsRoutes } from './routes/mcp-connections';
import { meRoutes } from './routes/me';
import { mentionsRoutes } from './routes/mentions';
import { modelPricingRoutes } from './routes/model-pricing';
import { oauthRoutes } from './routes/oauth';
import { preferencesRoutes } from './routes/preferences';
import { previewRoutes } from './routes/preview';
import { projectDocsRoutes } from './routes/project-docs';
import { projectsRoutes } from './routes/projects';
import { queuedWakeupsRoutes } from './routes/queued-wakeups';
import { reposRoutes } from './routes/repos';
import { searchRoutes } from './routes/search';
import { secretsRoutes } from './routes/secrets';
import { skillsRoutes } from './routes/skills';
import { tasksRoutes } from './routes/tasks';
import { teamTemplatesRoutes } from './routes/team-templates';
import { teamsRoutes } from './routes/teams';
import { uiStateRoutes } from './routes/ui-state';
import { updatesRoutes } from './routes/updates';
import { AuthChallengeStore } from './services/auth-challenges';
import { CeoSessionManager } from './services/ceo-session-manager';
import { ContainerLogStreamer } from './services/container-logs';
import { DockerClient } from './services/docker';
import { EgressProxy, loadOrCreateCA } from './services/egress';
import { ImageBuildTracker, setSharedImageBuildTracker } from './services/image-build-tracker';
import { pruneStaleBundledImages } from './services/image-registry';
import { JobManager } from './services/job-manager';
import { LogStreamBroker } from './services/log-stream-broker';
import { PricingService } from './services/pricing';
import { SshAgentServer } from './services/ssh-agent';
import { WebSocketManager } from './services/ws';
import { loadStaticBundle } from './static-assets';
import { HEZO_VERSION } from './version';

export type { HezoConfig };

export type MasterKeyState = 'unset' | 'locked' | 'unlocked';

export interface AppConfig {
	dataDir: string;
	webUrl: string;
}

export interface StartupResult {
	app: Hono<Env>;
	port: number;
	masterKeyState: MasterKeyState;
	jobManager: JobManager;
	ceoSessionManager: CeoSessionManager;
	wsManager: WebSocketManager;
	db: PGlite;
	docker: DockerClient;
	masterKeyManager: MasterKeyManager;
	logs: LogStreamBroker;
	containerLogStreamer: ContainerLogStreamer;
	sshAgentServer: SshAgentServer;
	egressProxy: EgressProxy;
}

export async function startup(config: HezoConfig): Promise<StartupResult> {
	mkdirSync(config.dataDir, { recursive: true });

	// `db` may be replaced by a fresh handle if migrations run against a copy and
	// swap it in, so it's a `let` — every consumer below uses the post-migration handle.
	let db = await openPersistentDb(config.dataDir, { reset: config.reset });

	await db.exec(BASE_SCHEMA);
	db = await runAvailableMigrations(db, config.dataDir);
	await runSeed(db);

	// Runtime model pricing: seed the table from the bundled snapshot if empty,
	// load it into memory, and (unless disabled) refresh from the live LiteLLM
	// feed in the background. Drives per-run cost across every runtime.
	const pricing = new PricingService(db);
	await pricing.init({ refresh: !process.env.HEZO_SKIP_PRICING_REFRESH });

	const masterKeyManager = new MasterKeyManager();
	const masterKeyState = await resolveMasterKeyState(db, masterKeyManager, config.masterKey);

	let docker: DockerClient;
	if (process.env.HEZO_SKIP_DOCKER) {
		const { createFakeDockerClient } = await import('./services/fake-docker.js');
		docker = createFakeDockerClient(db);
	} else {
		docker = new DockerClient();
		try {
			const outcome = await pruneStaleBundledImages(docker);
			if (outcome.removed.length > 0 || outcome.skipped.length > 0) {
				log.info(
					`bundled-image prune: kept=${outcome.kept.length} removed=${outcome.removed.length} skipped=${outcome.skipped.length}`,
				);
			}
		} catch (err) {
			log.error('bundled-image prune failed (continuing startup):', err);
		}
	}
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
	const sshAgentServer = new SshAgentServer({ db, masterKeyManager });
	await cleanupOrphanRunSockets(db, config.dataDir);
	const egressCA = await loadOrCreateCA(config.dataDir);
	const egressProxy = new EgressProxy({ db, masterKeyManager, ca: egressCA });
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
	});
	const ceoSessionManager = new CeoSessionManager({
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
	});

	const { seedDefaultTeam, ensureChatMemoryDoc } = await import('./services/teams.js');
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
		// Self-heal: instances created before the chatbox memory doc existed (or
		// where it was removed) get it back. Idempotent.
		await ensureChatMemoryDoc(db);
	} catch (err) {
		log.error('Failed to seed default team:', err);
	}

	masterKeyManager.onUnlock(() => {
		jobManager
			.reconcileOnStartup()
			.catch((err) => log.error('Startup reconciliation failed:', err))
			.finally(() => jobManager.start());
		ceoSessionManager
			.reconcileOnStartup()
			.catch((err) => log.error('CEO session reconciliation failed:', err))
			.finally(() => ceoSessionManager.start());
		// Initialize embedding model in background (downloads on first use)
		import('./services/embeddings').then(({ initializeEmbeddingModel }) => {
			const { join } = require('node:path') as typeof import('node:path');
			initializeEmbeddingModel(join(config.dataDir, 'models')).catch((err) =>
				log.error('Embedding model init failed:', err),
			);
		});
	});

	const app = buildApp(
		db,
		masterKeyManager,
		{
			dataDir: config.dataDir,
			webUrl: config.webUrl,
		},
		docker,
		wsManager,
		jobManager,
		logs,
		sshAgentServer,
		egressProxy,
		containerLogStreamer,
		events,
		ceoSessionManager,
		pricing,
	);

	return {
		app,
		port: config.port,
		masterKeyState,
		jobManager,
		ceoSessionManager,
		wsManager,
		db,
		docker,
		masterKeyManager,
		logs,
		containerLogStreamer,
		sshAgentServer,
		egressProxy,
	};
}

export function buildApp(
	db: PGlite,
	masterKeyManager: MasterKeyManager,
	config: AppConfig = { dataDir: '', webUrl: '' },
	docker: DockerClient = new DockerClient(),
	wsManager: WebSocketManager = new WebSocketManager(),
	jobManager?: JobManager,
	logs: LogStreamBroker = new LogStreamBroker(),
	sshAgentServer: SshAgentServer | null = null,
	egressProxy: EgressProxy | null = null,
	containerLogStreamer: ContainerLogStreamer = new ContainerLogStreamer(),
	events: DomainEventBus = new DomainEventBus(),
	ceoSessionManager?: CeoSessionManager,
	pricing?: PricingService,
): Hono<Env> {
	const app = new Hono<Env>();
	const authChallenges = new AuthChallengeStore();
	logs.setWsManager(wsManager);
	registerAuditObserver(events, db);

	app.onError((err, c) => {
		log.error(`Route error on ${c.req.method} ${c.req.path}:`, err);
		return c.text('Internal Server Error', 500);
	});

	app.use('*', async (c, next) => {
		c.set('db', db);
		c.set('masterKeyManager', masterKeyManager);
		c.set('authChallenges', authChallenges);
		c.set('docker', docker);
		c.set('wsManager', wsManager);
		c.set('events', events);
		if (jobManager) c.set('jobManager', jobManager);
		if (ceoSessionManager) c.set('ceoSessionManager', ceoSessionManager);
		c.set('logs', logs);
		c.set('containerLogStreamer', containerLogStreamer);
		c.set('dataDir', config.dataDir);
		c.set('webUrl', config.webUrl);
		c.set('sshAgentServer', sshAgentServer);
		c.set('egressProxy', egressProxy);
		if (pricing) c.set('pricing', pricing);
		return next();
	});

	// Initialize MCP server
	initMcpServer(db, config.dataDir, masterKeyManager, wsManager, events);

	// Public routes
	app.route('/', healthRoutes);

	// `/api/status` carries master-key state + version. `/` is left to the SPA
	// catch-all below (the compiled binary serves index.html there).
	const statusHandler = (c: Context<Env>) =>
		c.json({ masterKeyState: masterKeyManager.getState(), version: HEZO_VERSION });
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

	// Auth routes (token endpoint is public, handled before auth middleware)
	app.route('/api', authRoutes);

	// Public signed-URL asset read endpoint (sig query is the credential, so it
	// must be reachable without a bearer token).
	app.route('/', publicAssetsRoutes);

	// Auth middleware for all /api/* and /agent-api/* routes
	app.use('/api/*', authMiddleware);
	app.use('/agent-api/*', authMiddleware);

	// Project-scoped routes: resolve :projectId (slug/UUID) → its project and
	// backing team, assert access once. Handlers read c.get('projectId') and
	// c.get('teamId'). The project slug is the public handle for every
	// project-addressed resource (tasks, agents, inbox, team settings, …); the
	// team is resolved from the project rather than named in the URL.
	app.use('/api/projects/:projectId/*', requireProjectAccessMiddleware);

	// Agent API routes
	app.route('/agent-api', agentApiRoutes);

	// CRUD routes
	app.route('/api', agentTypesRoutes);
	app.route('/api', teamTemplatesRoutes);
	app.route('/api', teamsRoutes);
	app.route('/api', meRoutes);
	app.route('/api', agentsRoutes);
	app.route('/api', projectsRoutes);
	app.route('/api', tasksRoutes);
	app.route('/api', commentsRoutes);
	app.route('/api', assetsRoutes);
	app.route('/api', secretsRoutes);
	app.route('/api', approvalsRoutes);
	app.route('/api', inboxRoutes);
	app.route('/api', costsRoutes);
	app.route('/api', apiKeysRoutes);
	app.route('/api', agentConnectionsRoutes);
	app.route('/api', skillsRoutes);
	app.route('/api', preferencesRoutes);
	app.route('/api', uiStateRoutes);
	app.route('/api', projectDocsRoutes);
	app.route('/api', mentionsRoutes);
	app.route('/api', aiProvidersRoutes);
	app.route('/api', instanceSettingsRoutes);
	app.route('/api', modelPricingRoutes);
	app.route('/api', reposRoutes);
	app.route('/api', executionLocksRoutes);
	app.route('/api', queuedWakeupsRoutes);
	app.route('/api', auditLogRoutes);
	app.route('/api', mcpConnectionsRoutes);
	app.route('/api', oauthRoutes);
	app.route('/api', previewRoutes);
	app.route('/api', searchRoutes);
	app.route('/api', updatesRoutes);
	app.route('/api', ceoChatRoutes);

	// Frontend (SPA) serving. The compiled binary serves from the in-memory
	// bundle embedded at build time (`loadStaticBundle`); in dev that bundle is
	// absent, so we fall back to reading `packages/web/dist` off disk. Run the
	// vite dev server for hot-reload during development.
	const STATIC_MIME: Record<string, string> = {
		'.html': 'text/html; charset=utf-8',
		'.css': 'text/css; charset=utf-8',
		'.js': 'application/javascript; charset=utf-8',
		'.json': 'application/json; charset=utf-8',
		'.png': 'image/png',
		'.jpg': 'image/jpeg',
		'.svg': 'image/svg+xml',
		'.ico': 'image/x-icon',
		'.woff2': 'font/woff2',
	};
	const webDistDir = resolve(new URL('.', import.meta.url).pathname, '..', '..', 'web', 'dist');

	app.get('*', async (c) => {
		const urlPath = new URL(c.req.url).pathname;
		if (urlPath.startsWith('/api/') || urlPath.startsWith('/agent-api/')) {
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

		// Filesystem fallback (dev / `bun run`).
		if (existsSync(webDistDir)) {
			const fullPath = join(webDistDir, filePath);
			if (existsSync(fullPath)) {
				const ext = extname(fullPath).toLowerCase();
				return new Response(readFileSync(fullPath), {
					headers: { 'Content-Type': STATIC_MIME[ext] || 'application/octet-stream' },
				});
			}
			const indexPath = join(webDistDir, 'index.html');
			if (existsSync(indexPath)) {
				return new Response(readFileSync(indexPath), {
					headers: { 'Content-Type': 'text/html; charset=utf-8' },
				});
			}
		}

		return c.text('Not found', 404);
	});

	return app;
}

async function cleanupOrphanRunSockets(_db: PGlite, dataDir: string): Promise<void> {
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
	const { loadBundledMigrations, loadFilesystemMigrations } = await import('./db/migrate.js');
	const { codeMigrations } = await import('./db/migrations/code/index.js');

	let sql: Record<string, string> | null = null;
	try {
		sql = await loadBundledMigrations();
	} catch {
		// Dev (`bun run`): the bundle isn't generated — read from the source tree.
		// `HEZO_MIGRATIONS_DIR` lets tests point startup at synthetic migrations.
		try {
			const migrationsDir =
				process.env.HEZO_MIGRATIONS_DIR ??
				join(new URL('.', import.meta.url).pathname, '..', 'migrations');
			sql = await loadFilesystemMigrations(migrationsDir);
		} catch {
			sql = null;
		}
	}
	if (!sql) return null;

	// SQL migrations + code migrations share one ordered sequence (the runner
	// sorts by name). Code migrations travel through the TS module graph.
	return { ...sql, ...codeMigrations };
}

async function runAvailableMigrations(db: PGlite, dataDir: string): Promise<PGlite> {
	const migrations = await loadMigrations();
	if (!migrations) {
		log.warn('No migrations found. Run build:migrations or add migration files.');
		return db;
	}

	// Migrate a copy and swap on success; on failure the original is untouched
	// (a downgraded binary can run against it as-is). Returns the live handle to
	// use, which is a fresh one after a successful swap.
	const { applyPendingMigrations } = await import('./db/migrate-runner.js');
	return applyPendingMigrations(db, dataDir, migrations);
}

async function runSeed(db: PGlite): Promise<void> {
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
}

async function resolveMasterKeyState(
	db: PGlite,
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
