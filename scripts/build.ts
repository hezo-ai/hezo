#!/usr/bin/env bun
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dir, '..');

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
]);

console.log('Build complete.');
