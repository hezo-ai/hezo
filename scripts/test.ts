#!/usr/bin/env bun
import { resolve } from 'node:path';
import { Glob } from 'bun';

const ROOT = resolve(import.meta.dir, '..');

const args = process.argv.slice(2);
const bail = args.includes('--bail');
const concurrencyIdx = args.indexOf('--concurrency');
const concurrency = concurrencyIdx >= 0 ? Number.parseInt(args[concurrencyIdx + 1] || '4', 10) : 4;
const patternIdx = args.indexOf('--pattern');
const pattern = patternIdx >= 0 ? args[patternIdx + 1] : undefined;
const packageIdx = args.indexOf('--package');
const packageFilter = packageIdx >= 0 ? args[packageIdx + 1] : undefined;

const TEST_PACKAGES = ['packages/server', 'packages/connect'];

interface TestFile {
	pkg: string;
	file: string;
}

async function buildShared() {
	console.log('Building shared...');
	const proc = Bun.spawn(['bun', 'run', 'build'], {
		cwd: resolve(ROOT, 'packages/shared'),
		stdout: 'inherit',
		stderr: 'inherit',
	});
	const exitCode = await proc.exited;
	if (exitCode !== 0) {
		console.error('Failed to build shared');
		process.exit(1);
	}
}

async function discoverTests(): Promise<TestFile[]> {
	const files: TestFile[] = [];
	const packages = packageFilter
		? TEST_PACKAGES.filter((p) => p.endsWith(`/${packageFilter}`) || p === packageFilter)
		: TEST_PACKAGES;

	for (const pkg of packages) {
		const glob = new Glob('src/test/**/*.test.ts');
		const pkgDir = resolve(ROOT, pkg);
		for await (const file of glob.scan(pkgDir)) {
			if (!pattern || file.includes(pattern)) {
				files.push({ pkg, file });
			}
		}
	}
	return files;
}

async function main() {
	await buildShared();

	const testFiles = await discoverTests();

	if (testFiles.length === 0) {
		console.log('No test files found.');
		process.exit(0);
	}

	console.log(`Running ${testFiles.length} test file(s) with concurrency ${concurrency}...\n`);

	const results: Array<{ pkg: string; file: string; passed: boolean; duration: number }> = [];
	let failed = false;

	async function runTest(t: TestFile) {
		const start = Date.now();
		const proc = Bun.spawn(['npx', 'vitest', 'run', t.file], {
			cwd: resolve(ROOT, t.pkg),
			stdout: 'inherit',
			stderr: 'inherit',
			env: { ...process.env, NODE_ENV: 'test' },
		});
		const exitCode = await proc.exited;
		const duration = Date.now() - start;
		const passed = exitCode === 0;
		results.push({ pkg: t.pkg, file: t.file, passed, duration });

		if (!passed) {
			failed = true;
			if (bail) {
				console.error(`\nBAIL: ${t.pkg}/${t.file} failed`);
				process.exit(1);
			}
		}
	}

	const queue = [...testFiles];
	const running = new Set<Promise<void>>();

	while (queue.length > 0 || running.size > 0) {
		while (queue.length > 0 && running.size < concurrency) {
			const t = queue.shift()!;
			const promise = runTest(t).then(() => {
				running.delete(promise);
			});
			running.add(promise);
		}
		if (running.size > 0) {
			await Promise.race(running);
		}
	}

	console.log('\n── Test Results ──');
	for (const r of results) {
		const icon = r.passed ? '\u2713' : '\u2717';
		const label = `${r.pkg}/${r.file}`;
		console.log(`  ${icon} ${label} (${r.duration}ms)`);
	}

	const passCount = results.filter((r) => r.passed).length;
	console.log(`\n${passCount}/${results.length} passed`);

	if (failed) process.exit(1);
}

main();
