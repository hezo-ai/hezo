#!/usr/bin/env bun
import { existsSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { Command } from 'commander';
import { clearAllProjectWorkspaces } from '../packages/server/src/services/workspace';

const ROOT = resolve(import.meta.dir, '..');

const program = new Command()
	.name('dev')
	.description('Start all Hezo services in development mode')
	.option('--reset', 'Reset the server database')
	.option('--open', 'Auto-open the browser')
	.option('--port <port>', 'Server port')
	.option('--master-key <key>', 'Master key for unlocking')
	.option('--data-dir <path>', 'Data directory')
	.parse();

const opts = program.opts();

const dataDir = opts.dataDir ? resolve(opts.dataDir) : resolve(homedir(), '.hezo');

if (opts.reset) {
	const pgDataPath = resolve(dataDir, 'pgdata');
	if (existsSync(pgDataPath)) {
		rmSync(pgDataPath, { recursive: true, force: true });
		console.log(`Reset: removed ${pgDataPath}`);
	}
}

const cleared = clearAllProjectWorkspaces(dataDir);
if (cleared.length > 0) {
	console.log(`Cleared ${cleared.length} project workspace(s) under ${dataDir}/companies`);
}

// Duplicated from @hezo/shared (DEFAULT_WEB_PORT) to avoid adding a root-level
// workspace dependency — mirrors packages/web/vite.config.ts.
const webPort = process.env.HEZO_WEB_PORT ?? '5173';
const serverArgs: string[] = ['--web-url', `http://localhost:${webPort}`];
if (opts.open) serverArgs.push('--open');
if (opts.port) serverArgs.push('--port', opts.port);
if (opts.masterKey) serverArgs.push('--master-key', opts.masterKey);
if (opts.dataDir) serverArgs.push('--data-dir', opts.dataDir);

// Bundle migrations before starting the server
const bundle = Bun.spawnSync(['bun', 'run', 'scripts/bundle-migrations.ts'], {
	cwd: resolve(ROOT, 'packages/server'),
	stdout: 'inherit',
	stderr: 'inherit',
});
if (bundle.exitCode !== 0) {
	console.error('Failed to bundle migrations');
	process.exit(1);
}

const procs = [
	Bun.spawn(['bun', 'run', '--watch', 'src/index.ts'], {
		cwd: resolve(ROOT, 'packages/connect'),
		stdout: 'inherit',
		stderr: 'inherit',
		env: { ...process.env },
	}),
	Bun.spawn(['bun', 'run', '--watch', 'src/index.ts', ...serverArgs], {
		cwd: resolve(ROOT, 'packages/server'),
		stdout: 'inherit',
		stderr: 'inherit',
		env: { ...process.env },
	}),
	Bun.spawn(['bun', 'run', 'dev'], {
		cwd: resolve(ROOT, 'packages/web'),
		stdout: 'inherit',
		stderr: 'inherit',
		env: { ...process.env },
	}),
];

const shutdown = () => {
	for (const p of procs) p.kill();
	process.exit(0);
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

await Promise.race(procs.map((p) => p.exited));
shutdown();
