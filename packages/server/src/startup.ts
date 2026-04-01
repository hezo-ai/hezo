import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { PGlite } from '@electric-sql/pglite';
import { Hono } from 'hono';
import type { HezoConfig } from './cli';
import { MasterKeyManager } from './crypto/master-key';
import { BASE_SCHEMA } from './db/schema';
import type { Env } from './lib/types';
import { authMiddleware } from './middleware/auth';
import { agentsRoutes } from './routes/agents';
import { apiKeysRoutes } from './routes/api-keys';
import { approvalsRoutes } from './routes/approvals';
import { authRoutes } from './routes/auth';
import { commentsRoutes } from './routes/comments';
import { companiesRoutes } from './routes/companies';
import { companyTypesRoutes } from './routes/company-types';
import { connectionsRoutes } from './routes/connections';
import { costsRoutes } from './routes/costs';
import { healthRoutes } from './routes/health';
import { issuesRoutes } from './routes/issues';
import { kbDocsRoutes } from './routes/kb-docs';
import { oauthCallbackRoutes } from './routes/oauth-callback';
import { preferencesRoutes } from './routes/preferences';
import { projectDocsRoutes } from './routes/project-docs';
import { projectsRoutes } from './routes/projects';
import { reposRoutes } from './routes/repos';
import { secretsRoutes } from './routes/secrets';

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

	const app = buildApp(db, masterKeyManager, {
		dataDir: config.dataDir,
		connectUrl: config.connectUrl,
		connectPublicKey,
	});

	return { app, port: config.port, masterKeyState };
}

export function buildApp(
	db: PGlite,
	masterKeyManager: MasterKeyManager,
	config: AppConfig = { dataDir: '', connectUrl: '', connectPublicKey: '' },
): Hono<Env> {
	const app = new Hono<Env>();

	app.use('*', async (c, next) => {
		c.set('db', db);
		c.set('masterKeyManager', masterKeyManager);
		c.set('dataDir', config.dataDir);
		c.set('connectUrl', config.connectUrl);
		c.set('connectPublicKey', config.connectPublicKey);
		return next();
	});

	// Public routes
	app.route('/', healthRoutes);
	app.route('/', oauthCallbackRoutes);

	const statusHandler = (c: any) =>
		c.json({ masterKeyState: masterKeyManager.getState(), version: '0.1.0' });
	app.get('/', statusHandler);
	app.get('/api/status', statusHandler);

	// Auth routes (token endpoint is public, handled before auth middleware)
	app.route('/api', authRoutes);

	// Auth middleware for all /api/* routes
	app.use('/api/*', authMiddleware);

	// CRUD routes
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
	app.route('/api', preferencesRoutes);
	app.route('/api', projectDocsRoutes);
	app.route('/api', connectionsRoutes);
	app.route('/api', reposRoutes);

	return app;
}

async function fetchConnectPublicKey(connectUrl: string): Promise<string> {
	try {
		const res = await fetch(`${connectUrl}/signing-key`);
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
		const { seedBuiltins } = await import('./db/seed.js');
		await seedBuiltins(db);
	} catch {
		// Seed module may not be available in minimal builds
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
