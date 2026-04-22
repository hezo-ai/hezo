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
import { connectionsRoutes } from './routes/connections';
import { costsRoutes } from './routes/costs';
import { executionLocksRoutes } from './routes/execution-locks';
import { githubRoutes } from './routes/github';
import { goalsRoutes } from './routes/goals';
import { healthRoutes } from './routes/health';
import { issuesRoutes } from './routes/issues';
import { kbDocsRoutes } from './routes/kb-docs';
import { mentionsRoutes } from './routes/mentions';
import { oauthCallbackRoutes } from './routes/oauth-callback';
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
import { JobManager } from './services/job-manager';
import { LogStreamBroker } from './services/log-stream-broker';
import { WebSocketManager } from './services/ws';

export type { HezoConfig };

export type MasterKeyState = 'unset' | 'locked' | 'unlocked';

export interface AppConfig {
	dataDir: string;
	connectUrl: string;
	connectPublicKey: string;
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

	const connectPublicKey = await fetchConnectPublicKey(config.connectUrl);

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
	const jobManager = new JobManager({
		db,
		docker,
		masterKeyManager,
		serverPort: config.port,
		dataDir: config.dataDir,
		wsManager,
		logs,
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
			connectUrl: config.connectUrl,
			connectPublicKey,
			webUrl: config.webUrl,
		},
		docker,
		wsManager,
		jobManager,
		logs,
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
	};
}

export function buildApp(
	db: PGlite,
	masterKeyManager: MasterKeyManager,
	config: AppConfig = { dataDir: '', connectUrl: '', connectPublicKey: '', webUrl: '' },
	docker: DockerClient = new DockerClient(),
	wsManager: WebSocketManager = new WebSocketManager(),
	jobManager?: JobManager,
	logs: LogStreamBroker = new LogStreamBroker(),
): Hono<Env> {
	const app = new Hono<Env>();
	logs.setWsManager(wsManager);

	app.use('*', async (c, next) => {
		c.set('db', db);
		c.set('masterKeyManager', masterKeyManager);
		c.set('docker', docker);
		c.set('wsManager', wsManager);
		if (jobManager) c.set('jobManager', jobManager);
		c.set('logs', logs);
		c.set('dataDir', config.dataDir);
		c.set('connectUrl', config.connectUrl);
		c.set('connectPublicKey', config.connectPublicKey);
		c.set('webUrl', config.webUrl);
		return next();
	});

	// Initialize MCP server
	initMcpServer(db, config.dataDir);

	// Public routes
	app.route('/', healthRoutes);
	app.route('/', oauthCallbackRoutes);

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
	app.route('/api', connectionsRoutes);
	app.route('/api', aiProvidersRoutes);
	app.route('/api', reposRoutes);
	app.route('/api', githubRoutes);
	app.route('/api', executionLocksRoutes);
	app.route('/api', auditLogRoutes);
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

async function fetchConnectPublicKey(connectUrl: string): Promise<string> {
	try {
		const res = await fetch(`${connectUrl}/signing-key`, { signal: AbortSignal.timeout(5000) });
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		const { key } = (await res.json()) as { key: string };
		log.info('Fetched Connect signing public key.');
		return key;
	} catch {
		log.warn('Could not fetch Connect signing key. OAuth flows will be unavailable.');
		return '';
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
