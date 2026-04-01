#!/usr/bin/env bun
import { resolve } from 'node:path';
import { Command } from 'commander';

const ROOT = resolve(import.meta.dir, '..');

const program = new Command()
	.name('dev')
	.description('Start all Hezo services in development mode')
	.option('--reset', 'Reset the server database')
	.option('--no-open', 'Do not auto-open the browser')
	.option('--port <port>', 'Server port')
	.option('--master-key <key>', 'Master key for unlocking')
	.parse();

const opts = program.opts();
const serverArgs: string[] = [];
if (opts.reset) serverArgs.push('--reset');
if (opts.open === false) serverArgs.push('--no-open');
if (opts.port) serverArgs.push('--port', opts.port);
if (opts.masterKey) serverArgs.push('--master-key', opts.masterKey);

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
