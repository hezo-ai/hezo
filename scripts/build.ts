#!/usr/bin/env bun
import { cpSync, existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { Command } from 'commander';

const ROOT = resolve(import.meta.dir, '..');

const program = new Command()
	.name('build')
	.description('Build all Hezo packages (shared → server, connect, web in parallel)')
	.option('--compile', 'Build a single compiled binary with embedded frontend')
	.parse();

const opts = program.opts();

async function run(pkg: string, cmd: string[]) {
	const cwd = resolve(ROOT, pkg);
	const label = `${pkg} → ${cmd.join(' ')}`;
	console.log(`Building ${label}...`);
	const proc = Bun.spawn(cmd, { cwd, stdout: 'inherit', stderr: 'inherit' });
	const exitCode = await proc.exited;
	if (exitCode !== 0) {
		console.error(`Build failed: ${label}`);
		process.exit(1);
	}
}

// shared must build first (dependency of server and connect)
await run('packages/shared', ['bun', 'run', 'build']);

// server and connect build in parallel
await Promise.all([
	(async () => {
		await run('packages/server', ['bun', 'run', 'build']);
		await run('packages/server', ['bun', 'run', 'build:migrations']);
	})(),
	run('packages/connect', ['bun', 'run', 'build']),
	run('packages/web', ['bun', 'run', 'build']),
]);

console.log('Build complete.');

if (opts.compile) {
	console.log('\nCompiling single binary...');

	// Copy web dist to server static
	const webDist = resolve(ROOT, 'packages/web/dist');
	const serverStatic = resolve(ROOT, 'packages/server/static');

	if (!existsSync(webDist)) {
		console.error('packages/web/dist not found. Run web build first.');
		process.exit(1);
	}

	mkdirSync(serverStatic, { recursive: true });
	cpSync(webDist, serverStatic, { recursive: true });
	console.log('Copied web assets to packages/server/static/');

	// Compile binary
	const outDir = resolve(ROOT, 'dist');
	mkdirSync(outDir, { recursive: true });

	await run('.', [
		'bun',
		'build',
		'--compile',
		'packages/server/src/index.ts',
		'--outfile',
		'dist/hezo',
	]);

	console.log('\nCompiled binary at dist/hezo');
}
