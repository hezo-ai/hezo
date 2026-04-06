import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import type { PGlite } from '@electric-sql/pglite';
import { type Context, Hono } from 'hono';
import type { HezoConfig } from './cli';
import { MasterKeyManager } from './crypto/master-key';
import { BASE_SCHEMA } from './db/schema';
import type { Env } from './lib/types';
import { getToolDefs, handleMcpRequest, initMcpServer } from './mcp/server';
import { generateSkillFile } from './mcp/skill-file';
import { authMiddleware } from './middleware/auth';
import { agentApiRoutes } from './routes/agent-api';
import { agentTypesRoutes } from './routes/agent-types';
import { agentsRoutes } from './routes/agents';
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
import { healthRoutes } from './routes/health';
import { issuesRoutes } from './routes/issues';
import { kbDocsRoutes } from './routes/kb-docs';
import { liveChatRoutes } from './routes/live-chat';
import { oauthCallbackRoutes } from './routes/oauth-callback';
import { preferencesRoutes } from './routes/preferences';
import { previewRoutes } from './routes/preview';
import { projectDocsRoutes } from './routes/project-docs';
import { projectsRoutes } from './routes/projects';
import { reposRoutes } from './routes/repos';
import { secretsRoutes } from './routes/secrets';
import { skillsRoutes } from './routes/skills';
import { DockerClient } from './services/docker';
import { JobManager } from './services/job-manager';
import { WebSocketManager } from './services/ws';

export type { HezoConfig };

export type MasterKeyState = 'unset' | 'locked' | 'unlocked';

export interface AppConfig {
	dataDir: string;
	connectUrl: string;
	connectPublicKey: string;
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
		db = new PGlite({ fs: new NodeFS(pgDataPath) });
	} catch {
		db = new PGlite();
	}

	await db.exec(BASE_SCHEMA);
	await runAvailableMigrations(db);
	await runSeed(db);

	const masterKeyManager = new MasterKeyManager();
	const masterKeyState = await resolveMasterKeyState(db, masterKeyManager, config.masterKey);

	const connectPublicKey = await fetchConnectPublicKey(config.connectUrl);

	const docker = new DockerClient();
	const wsManager = new WebSocketManager();
	const jobManager = new JobManager({
		db,
		docker,
		masterKeyManager,
		serverPort: config.port,
		dataDir: config.dataDir,
		wsManager,
	});
	const app = buildApp(
		db,
		masterKeyManager,
		{
			dataDir: config.dataDir,
			connectUrl: config.connectUrl,
			connectPublicKey,
		},
		docker,
		wsManager,
		jobManager,
	);

	if (masterKeyState === 'unlocked') {
		jobManager.start();
	}

	return {
		app,
		port: config.port,
		masterKeyState,
		jobManager,
		wsManager,
		db,
		docker,
		masterKeyManager,
	};
}

export function buildApp(
	db: PGlite,
	masterKeyManager: MasterKeyManager,
	config: AppConfig = { dataDir: '', connectUrl: '', connectPublicKey: '' },
	docker: DockerClient = new DockerClient(),
	wsManager: WebSocketManager = new WebSocketManager(),
	jobManager?: JobManager,
): Hono<Env> {
	const app = new Hono<Env>();

	app.use('*', async (c, next) => {
		c.set('db', db);
		c.set('masterKeyManager', masterKeyManager);
		c.set('docker', docker);
		c.set('wsManager', wsManager);
		if (jobManager) c.set('jobManager', jobManager);
		c.set('dataDir', config.dataDir);
		c.set('connectUrl', config.connectUrl);
		c.set('connectPublicKey', config.connectPublicKey);
		return next();
	});

	// Initialize MCP server
	initMcpServer(db);

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
	app.route('/api', issuesRoutes);
	app.route('/api', commentsRoutes);
	app.route('/api', secretsRoutes);
	app.route('/api', approvalsRoutes);
	app.route('/api', costsRoutes);
	app.route('/api', apiKeysRoutes);
	app.route('/api', kbDocsRoutes);
	app.route('/api', skillsRoutes);
	app.route('/api', preferencesRoutes);
	app.route('/api', projectDocsRoutes);
	app.route('/api', connectionsRoutes);
	app.route('/api', reposRoutes);
	app.route('/api', executionLocksRoutes);
	app.route('/api', liveChatRoutes);
	app.route('/api', auditLogRoutes);
	app.route('/api', previewRoutes);

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
		console.log('Fetched Connect signing public key.');
		return key;
	} catch {
		console.warn('Could not fetch Connect signing key. OAuth flows will be unavailable.');
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
			console.warn('No migrations found. Run build:migrations or add migration files.');
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
		console.error('Seed failed:', err);
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
		console.log(messages[state]);
		return state;
	} catch {
		console.warn('Master key module not available. Skipping key verification.');
		return 'unset';
	}
}
