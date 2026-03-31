#!/usr/bin/env bun
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dir, '..');

const procs = [
	Bun.spawn(['bun', 'run', '--watch', 'src/index.ts'], {
		cwd: resolve(ROOT, 'packages/connect'),
		stdout: 'inherit',
		stderr: 'inherit',
		env: { ...process.env },
	}),
	Bun.spawn(['bun', 'run', '--watch', 'src/index.ts'], {
		cwd: resolve(ROOT, 'packages/server'),
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
