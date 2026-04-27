#!/usr/bin/env bun
import { resolve } from 'node:path';
import { Command } from 'commander';

const ROOT = resolve(import.meta.dir, '..');

const defaultConcurrency = 10;

const program = new Command()
	.name('test')
	.description('Run Hezo test suite across all packages')
	.option('--bail', 'Stop on first test failure')
	.option('--concurrency <n>', 'Number of parallel test workers', String(defaultConcurrency))
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

async function runVitestForPackage(pkg: string): Promise<boolean> {
	const args = [
		'vitest',
		'run',
		'--pool=forks',
		`--poolOptions.forks.maxForks=${concurrency}`,
		`--poolOptions.forks.minForks=${concurrency}`,
	];
	if (bail) args.push('--bail=1');
	if (pattern) {
		args.push('--passWithNoTests', pattern);
	}

	console.log(`\n── Running ${pkg} tests (pool=forks, workers=${concurrency}) ──`);
	const start = Date.now();
	const proc = Bun.spawn(['bunx', ...args], {
		cwd: resolve(ROOT, pkg),
		stdout: 'inherit',
		stderr: 'inherit',
		env: { ...process.env, NODE_ENV: 'test' },
	});
	const exitCode = await proc.exited;
	const duration = Date.now() - start;
	const passed = exitCode === 0;
	console.log(`\n${pkg}: ${passed ? 'passed' : 'FAILED'} (${(duration / 1000).toFixed(1)}s)`);
	return passed;
}

async function runPlaywright(): Promise<boolean> {
	console.log('\n── E2E Tests ──');
	const playwrightArgs = ['playwright', 'test'];
	if (pattern) playwrightArgs.push(pattern);
	const proc = Bun.spawn(['bunx', ...playwrightArgs], {
		cwd: ROOT,
		stdout: 'inherit',
		stderr: 'inherit',
		env: { ...process.env, NODE_ENV: 'test' },
	});
	const passed = (await proc.exited) === 0;
	console.log(`\nE2E: ${passed ? 'passed' : 'FAILED'}`);
	return passed;
}

async function main() {
	await Promise.all([buildShared(), buildAgentBundle()]);

	const e2eOnly = e2eFlag;
	let unitPassed = true;

	if (!e2eOnly) {
		const packages = packageFilter
			? TEST_PACKAGES.filter((p) => p.endsWith(`/${packageFilter}`) || p === packageFilter)
			: TEST_PACKAGES;

		if (packages.length === 0) {
			console.error(`No matching package for --package=${packageFilter}`);
			process.exit(1);
		}

		for (const pkg of packages) {
			const passed = await runVitestForPackage(pkg);
			if (!passed) {
				unitPassed = false;
				if (bail) break;
			}
		}
	}

	const runE2E = !skipE2E && (!packageFilter || e2eOnly);
	const e2ePassed = runE2E ? await runPlaywright() : true;

	await cleanupDockerContainers();

	if (!unitPassed || !e2ePassed) process.exit(1);
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
