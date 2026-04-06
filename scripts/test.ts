#!/usr/bin/env bun
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { Glob } from 'bun';
import { Command } from 'commander';

const ROOT = resolve(import.meta.dir, '..');

const program = new Command()
	.name('test')
	.description('Run Hezo test suite across all packages')
	.option('--bail', 'Stop on first test failure')
	.option('--concurrency <n>', 'Number of parallel test workers', '10')
	.option('--pattern <str>', 'Filter test files by substring match')
	.option('--package <name>', 'Run tests only in a specific package')
	.option('--skip-e2e', 'Skip Playwright e2e tests')
	.option('--e2e', 'Run only Playwright e2e tests')
	.parse();

const opts = program.opts();
const bail = opts.bail as boolean;
const concurrency = Number.parseInt(opts.concurrency, 10);
const pattern = opts.pattern as string | undefined;
const packageFilter = opts.package as string | undefined;
const skipE2E = opts.skipE2e as boolean;
const e2eFlag = opts.e2e as boolean;

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

async function buildAgentBundle() {
	console.log('Building agent bundle...');
	const proc = Bun.spawn(['bun', 'run', 'build:agents'], {
		cwd: resolve(ROOT, 'packages/server'),
		stdout: 'inherit',
		stderr: 'inherit',
	});
	const exitCode = await proc.exited;
	if (exitCode !== 0) {
		console.error('Failed to build agent bundle');
		process.exit(1);
	}
}

async function main() {
	await Promise.all([buildShared(), buildAgentBundle()]);

	const e2eOnly = e2eFlag;
	const testFiles = e2eOnly ? [] : await discoverTests();

	if (testFiles.length === 0 && !e2eOnly) {
		console.log('No test files found.');
		process.exit(0);
	}

	const runOrderPath = resolve(ROOT, 'tests/test-run-order.json');
	let runOrder: Record<string, number> = {};
	try {
		const orderFile = Bun.file(runOrderPath);
		if (await orderFile.exists()) {
			runOrder = await orderFile.json();
		}
	} catch {}

	const testKey = (t: TestFile) => `${t.pkg}/${t.file}`;
	testFiles.sort((a, b) => (runOrder[testKey(b)] || 0) - (runOrder[testKey(a)] || 0));

	console.log(`Running ${testFiles.length} test file(s) with concurrency ${concurrency}...\n`);

	const results: Array<{ pkg: string; file: string; passed: boolean; duration: number }> = [];
	let failed = false;

	async function runTest(t: TestFile) {
		const start = Date.now();
		const proc = Bun.spawn(['bunx', 'vitest', 'run', t.file], {
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
			const t = queue.shift() as string;
			const promise = runTest(t).then(() => {
				running.delete(promise);
			});
			running.add(promise);
		}
		if (running.size > 0) {
			await Promise.race(running);
		}
	}

	const durations: Record<string, number> = {};
	for (const r of results) {
		durations[`${r.pkg}/${r.file}`] = r.duration;
	}
	mkdirSync(resolve(ROOT, 'tests'), { recursive: true });
	await Bun.write(runOrderPath, JSON.stringify(durations, null, 2));

	if (results.length > 0) {
		console.log('\n── Unit/Integration Test Results ──');
		for (const r of results) {
			const icon = r.passed ? '\u2713' : '\u2717';
			const label = `${r.pkg}/${r.file}`;
			console.log(`  ${icon} ${label} (${r.duration}ms)`);
		}

		const passCount = results.filter((r) => r.passed).length;
		console.log(`\n${passCount}/${results.length} passed`);
	}

	const runE2E = !skipE2E && (!packageFilter || e2eOnly);
	let e2ePassed = true;

	if (runE2E) {
		console.log('\n── E2E Tests ──');
		const proc = Bun.spawn(['bunx', 'playwright', 'test'], {
			cwd: ROOT,
			stdout: 'inherit',
			stderr: 'inherit',
			env: { ...process.env, NODE_ENV: 'test' },
		});
		e2ePassed = (await proc.exited) === 0;
		console.log(`\nE2E: ${e2ePassed ? 'passed' : 'FAILED'}`);
	}

	await cleanupDockerContainers();

	if (failed || !e2ePassed) process.exit(1);
}

async function cleanupDockerContainers() {
	try {
		const ps = Bun.spawn(['docker', 'ps', '-aq', '--filter', 'name=^hezo-'], {
			stdout: 'pipe',
			stderr: 'pipe',
		});
		const ids = (await new Response(ps.stdout).text()).trim();
		await ps.exited;

		if (!ids) return;

		const containerIds = ids.split('\n').filter(Boolean);
		console.log(`\nCleaning up ${containerIds.length} Docker container(s)...`);

		const rm = Bun.spawn(['docker', 'rm', '-f', ...containerIds], {
			stdout: 'inherit',
			stderr: 'inherit',
		});
		await rm.exited;
	} catch {
		// Docker may not be available — skip cleanup silently
	}
}

main();
