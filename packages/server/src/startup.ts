import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import type { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite/vector';
import { type Context, Hono } from 'hono';
import type { HezoConfig } from './cli';
import { logger } from './logger';

const log = logger.child('startup');

import { MasterKeyManager } from './crypto/master-key';
import { BASE_SCHEMA } from './db/schema';
import type { Env } from './lib/types';
import { getToolDefs, handleMcpRequest, initMcpServer } from './mcp/server';
import { generateSkillFile } from './mcp/skill-file';
import { authMiddleware } from './middleware/auth';
import { agentApiRoutes } from './routes/agent-api';
import { agentTypesRoutes } from './routes/agent-types';
import { agentsRoutes } from './routes/agents';
import { aiProvidersRoutes } from './routes/ai-providers';
import { apiKeysRoutes } from './routes/api-keys';
import { approvalsRoutes } from './routes/approvals';
import { auditLogRoutes } from './routes/audit-log';
import { authRoutes } from './routes/auth';
import { commentsRoutes } from './routes/comments';
import { companiesRoutes } from './routes/companies';
import { companyTypesRoutes } from './routes/company-types';
import { costsRoutes } from './routes/costs';
import { executionLocksRoutes } from './routes/execution-locks';
import { goalsRoutes } from './routes/goals';
import { healthRoutes } from './routes/health';
import { issuesRoutes } from './routes/issues';
import { kbDocsRoutes } from './routes/kb-docs';
import { mcpConnectionsRoutes } from './routes/mcp-connections';
import { mentionsRoutes } from './routes/mentions';
import { preferencesRoutes } from './routes/preferences';
import { previewRoutes } from './routes/preview';
import { projectDocsRoutes } from './routes/project-docs';
import { projectsRoutes } from './routes/projects';
import { reposRoutes } from './routes/repos';
import { searchRoutes } from './routes/search';
import { secretsRoutes } from './routes/secrets';
import { skillsRoutes } from './routes/skills';
import { uiStateRoutes } from './routes/ui-state';
import { DockerClient } from './services/docker';
import { EgressProxy, loadOrCreateCA } from './services/egress';
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
	sshAgentServer: SshAgentServer;
	egressProxy: EgressProxy;
}

export async function startup(config: HezoConfig): Promise<StartupResult> {
	const pgDataPath = join(config.dataDir, 'pgdata');

	if (config.reset) {
		rmSync(pgDataPath, { recursive: true, force: true });
	}

	mkdirSync(config.dataDir, { recursive: true });

	const { PGlite } = await import('@electric-sql/pglite');
	let db: InstanceType<typeof PGlite>;

	try {
		const { NodeFS } = await import('@electric-sql/pglite/nodefs');
		db = new PGlite({ fs: new NodeFS(pgDataPath), extensions: { vector } });
	} catch {
		db = new PGlite({ extensions: { vector } });
	}

	await db.exec(BASE_SCHEMA);
	await runAvailableMigrations(db);
	await runSeed(db);

	const masterKeyManager = new MasterKeyManager();
	const masterKeyState = await resolveMasterKeyState(db, masterKeyManager, config.masterKey);

	let docker: DockerClient;
	if (process.env.HEZO_SKIP_DOCKER) {
		const { createFakeDockerClient } = await import('./test/helpers/fake-docker.js');
		docker = createFakeDockerClient();
	} else {
		docker = new DockerClient();
	}
	const wsManager = new WebSocketManager();
	const logs = new LogStreamBroker();
	logs.setWsManager(wsManager);
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
		sshAgentServer,
		egressProxy,
		egressCAPath: egressCA.certPath,
	});

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
): Hono<Env> {
	const app = new Hono<Env>();
	logs.setWsManager(wsManager);

	app.onError((err, c) => {
		log.error(`Unhandled route error on ${c.req.method} ${c.req.path}:`, err);
		return c.text('Internal Server Error', 500);
	});

	app.use('*', async (c, next) => {
		c.set('db', db);
		c.set('masterKeyManager', masterKeyManager);
		c.set('docker', docker);
		c.set('wsManager', wsManager);
		if (jobManager) c.set('jobManager', jobManager);
		c.set('logs', logs);
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

	// MCP endpoint (authenticated)
	app.post('/mcp', (c) => handleMcpRequest(c));
	app.get('/mcp', (c) => handleMcpRequest(c));
	app.delete('/mcp', (c) => handleMcpRequest(c));

	// Auth routes (token endpoint is public, handled before auth middleware)
	app.route('/api', authRoutes);

	// Auth middleware for all /api/* and /agent-api/* routes
	app.use('/api/*', authMiddleware);
	app.use('/agent-api/*', authMiddleware);

	// Agent API routes
	app.route('/agent-api', agentApiRoutes);

	// CRUD routes
	app.route('/api', agentTypesRoutes);
	app.route('/api', companyTypesRoutes);
	app.route('/api', companiesRoutes);
	app.route('/api', agentsRoutes);
	app.route('/api', projectsRoutes);
	app.route('/api', goalsRoutes);
	app.route('/api', issuesRoutes);
	app.route('/api', commentsRoutes);
	app.route('/api', secretsRoutes);
	app.route('/api', approvalsRoutes);
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

async function cleanupOrphanRunSockets(db: PGlite, dataDir: string): Promise<void> {
	const fs = await import('node:fs/promises');
	const { join } = await import('node:path');
	const companiesDir = join(dataDir, 'companies');
	if (!existsSync(companiesDir)) return;

	const liveRunIds = new Set<string>();
	try {
		const live = await db.query<{ id: string }>(
			"SELECT id FROM heartbeat_runs WHERE status = 'running'",
		);
		for (const row of live.rows) liveRunIds.add(row.id);
	} catch {
		return;
	}

	for (const company of await fs.readdir(companiesDir).catch(() => [])) {
		const projectsDir = join(companiesDir, company, 'projects');
		for (const project of await fs.readdir(projectsDir).catch(() => [])) {
			const runDir = join(projectsDir, project, 'run');
			for (const entry of await fs.readdir(runDir).catch(() => [])) {
				if (!entry.endsWith('.sock')) continue;
				const runId = entry.replace(/\.sock$/, '').replace(/^bootstrap-/, '');
				if (liveRunIds.has(runId)) continue;
				await fs.rm(join(runDir, entry), { force: true }).catch(() => undefined);
			}
		}
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
