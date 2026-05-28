import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import type { PGlite } from '@electric-sql/pglite';
import { type Context, Hono } from 'hono';
import type { HezoConfig } from './cli';
import { logger } from './logger';

const log = logger.child('startup');

import { MasterKeyManager } from './crypto/master-key';
import { openPersistentDb } from './db/client';
import { BASE_SCHEMA } from './db/schema';
import type { Env } from './lib/types';
import { getToolDefs, handleMcpRequest, initMcpServer } from './mcp/server';
import { generateSkillFile } from './mcp/skill-file';
import { authMiddleware, requireTeamAccessMiddleware } from './middleware/auth';
import { agentApiRoutes } from './routes/agent-api';
import { agentTypesRoutes } from './routes/agent-types';
import { agentsRoutes } from './routes/agents';
import { aiProvidersRoutes } from './routes/ai-providers';
import { apiKeysRoutes } from './routes/api-keys';
import { approvalsRoutes } from './routes/approvals';
import { assetsRoutes, publicAssetsRoutes } from './routes/assets';
import { auditLogRoutes } from './routes/audit-log';
import { authRoutes } from './routes/auth';
import { commentsRoutes } from './routes/comments';
import { costsRoutes } from './routes/costs';
import { executionLocksRoutes } from './routes/execution-locks';
import { goalsRoutes } from './routes/goals';
import { healthRoutes } from './routes/health';
import { inboxRoutes } from './routes/inbox';
import { kbDocsRoutes } from './routes/kb-docs';
import { mcpConnectionsRoutes } from './routes/mcp-connections';
import { mentionsRoutes } from './routes/mentions';
import { oauthRoutes } from './routes/oauth';
import { preferencesRoutes } from './routes/preferences';
import { previewRoutes } from './routes/preview';
import { projectDocsRoutes } from './routes/project-docs';
import { projectsRoutes } from './routes/projects';
import { reposRoutes } from './routes/repos';
import { searchRoutes } from './routes/search';
import { secretsRoutes } from './routes/secrets';
import { skillsRoutes } from './routes/skills';
import { tasksRoutes } from './routes/tasks';
import { teamTemplatesRoutes } from './routes/team-templates';
import { teamsRoutes } from './routes/teams';
import { uiStateRoutes } from './routes/ui-state';
import { ContainerLogStreamer } from './services/container-logs';
import { DockerClient } from './services/docker';
import { EgressProxy, loadOrCreateCA } from './services/egress';
import { pruneStaleBundledImages } from './services/image-registry';
import { JobManager } from './services/job-manager';
import { LogStreamBroker } from './services/log-stream-broker';
import { SshAgentServer } from './services/ssh-agent';
import { WebSocketManager } from './services/ws';

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

	const db = await openPersistentDb(config.dataDir, { reset: config.reset });

	await db.exec(BASE_SCHEMA);
	await runAvailableMigrations(db);
	await runSeed(db);

	const masterKeyManager = new MasterKeyManager();
	const masterKeyState = await resolveMasterKeyState(db, masterKeyManager, config.masterKey);

	let docker: DockerClient;
	if (process.env.HEZO_SKIP_DOCKER) {
		const { createFakeDockerClient } = await import('./services/fake-docker.js');
		docker = createFakeDockerClient();
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
	const containerLogStreamer = new ContainerLogStreamer();
	const sshAgentServer = new SshAgentServer({ db, masterKeyManager });
	await cleanupOrphanRunSockets(db, config.dataDir);
	const egressCA = await loadOrCreateCA(config.dataDir);
	const egressProxy = new EgressProxy({ db, masterKeyManager, ca: egressCA });
	const jobManager = new JobManager({
		db,
		docker,
		masterKeyManager,
		serverPort: config.port,
		dataDir: config.dataDir,
		wsManager,
		logs,
		containerLogStreamer,
		sshAgentServer,
		egressProxy,
		egressCAPath: egressCA.certPath,
	});

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

	masterKeyManager.onUnlock(() => {
		jobManager
			.reconcileOnStartup()
			.catch((err) => log.error('Startup reconciliation failed:', err))
			.finally(() => jobManager.start());
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
	);

	return {
		app,
		port: config.port,
		masterKeyState,
		jobManager,
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
): Hono<Env> {
	const app = new Hono<Env>();
	logs.setWsManager(wsManager);

	app.onError((err, c) => {
		log.error(`Route error on ${c.req.method} ${c.req.path}:`, err);
		return c.text('Internal Server Error', 500);
	});

	app.use('*', async (c, next) => {
		c.set('db', db);
		c.set('masterKeyManager', masterKeyManager);
		c.set('docker', docker);
		c.set('wsManager', wsManager);
		if (jobManager) c.set('jobManager', jobManager);
		c.set('logs', logs);
		c.set('containerLogStreamer', containerLogStreamer);
		c.set('dataDir', config.dataDir);
		c.set('webUrl', config.webUrl);
		c.set('sshAgentServer', sshAgentServer);
		c.set('egressProxy', egressProxy);
		return next();
	});

	// Initialize MCP server
	initMcpServer(db, config.dataDir, masterKeyManager, wsManager);

	// Public routes
	app.route('/', healthRoutes);

	const statusHandler = (c: Context<Env>) =>
		c.json({ masterKeyState: masterKeyManager.getState(), version: '0.1.0' });
	app.get('/', statusHandler);
	app.get('/api/status', statusHandler);

	// Skill file (public)
	app.get('/skill.md', (c) => {
		const md = generateSkillFile(getToolDefs());
		return c.text(md, 200, { 'Content-Type': 'text/markdown' });
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

	// Team-scoped routes: resolve :teamId slug/UUID + assert access once.
	// Handlers read c.get('teamId') for the resolved UUID. Agent-api paths
	// derive teamId from the JWT, not the URL, so they are not covered here.
	app.use('/api/teams/:teamId/*', requireTeamAccessMiddleware);

	// Agent API routes
	app.route('/agent-api', agentApiRoutes);

	// CRUD routes
	app.route('/api', agentTypesRoutes);
	app.route('/api', teamTemplatesRoutes);
	app.route('/api', teamsRoutes);
	app.route('/api', agentsRoutes);
	app.route('/api', projectsRoutes);
	app.route('/api', goalsRoutes);
	app.route('/api', tasksRoutes);
	app.route('/api', commentsRoutes);
	app.route('/api', assetsRoutes);
	app.route('/api', secretsRoutes);
	app.route('/api', approvalsRoutes);
	app.route('/api', inboxRoutes);
	app.route('/api', costsRoutes);
	app.route('/api', apiKeysRoutes);
	app.route('/api', kbDocsRoutes);
	app.route('/api', skillsRoutes);
	app.route('/api', preferencesRoutes);
	app.route('/api', uiStateRoutes);
	app.route('/api', projectDocsRoutes);
	app.route('/api', mentionsRoutes);
	app.route('/api', aiProvidersRoutes);
	app.route('/api', reposRoutes);
	app.route('/api', executionLocksRoutes);
	app.route('/api', auditLogRoutes);
	app.route('/api', mcpConnectionsRoutes);
	app.route('/api', oauthRoutes);
	app.route('/api', previewRoutes);
	app.route('/api', searchRoutes);

	// Static file serving for compiled binary (frontend assets)
	const staticDir = resolve(new URL('.', import.meta.url).pathname, '..', 'static');
	if (existsSync(staticDir)) {
		const STATIC_MIME: Record<string, string> = {
			'.html': 'text/html',
			'.css': 'text/css',
			'.js': 'application/javascript',
			'.json': 'application/json',
			'.png': 'image/png',
			'.jpg': 'image/jpeg',
			'.svg': 'image/svg+xml',
			'.ico': 'image/x-icon',
			'.woff2': 'font/woff2',
		};

		app.get('*', async (c) => {
			const urlPath = new URL(c.req.url).pathname;

			if (urlPath.startsWith('/api/') || urlPath.startsWith('/agent-api/')) {
				return c.text('Not found', 404);
			}
			const filePath = urlPath === '/' ? '/index.html' : urlPath;
			const fullPath = join(staticDir, filePath);

			if (existsSync(fullPath)) {
				const ext = extname(fullPath).toLowerCase();
				const content = readFileSync(fullPath);
				return new Response(content, {
					headers: { 'Content-Type': STATIC_MIME[ext] || 'application/octet-stream' },
				});
			}

			// SPA fallback
			const indexPath = join(staticDir, 'index.html');
			if (existsSync(indexPath)) {
				const content = readFileSync(indexPath);
				return new Response(content, { headers: { 'Content-Type': 'text/html' } });
			}

			return c.text('Not found', 404);
		});
	}

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

async function runAvailableMigrations(db: PGlite): Promise<void> {
	try {
		const { runMigrations, loadBundledMigrations } = await import('./db/migrate.js');
		const migrations = await loadBundledMigrations();
		await runMigrations(db, migrations);
	} catch {
		try {
			const { runMigrations, loadFilesystemMigrations } = await import('./db/migrate.js');
			const migrationsDir = join(new URL('.', import.meta.url).pathname, '..', 'migrations');
			const migrations = await loadFilesystemMigrations(migrationsDir);
			await runMigrations(db, migrations);
		} catch {
			log.warn('No migrations found. Run build:migrations or add migration files.');
		}
	}
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
	masterKey?: string,
): Promise<MasterKeyState> {
	try {
		const state = await masterKeyManager.initialize(db, masterKey);

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
