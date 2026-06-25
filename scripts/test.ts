#!/usr/bin/env bun
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Command } from 'commander';
import { ensureBundles } from './ensure-bundles';

const ROOT = resolve(import.meta.dir, '..');

const defaultConcurrency = 10;

const program = new Command()
	.name('test')
	.description('Run Hezo test suite across all packages')
	.option('--bail', 'Stop on first test failure')
	.option('--concurrency <n>', 'Number of parallel test workers', String(defaultConcurrency))
	.option('--pattern <str>', 'Filter test files by substring match')
	.option('--package <name>', 'Run tests only in a specific package')
	.option('--skip-browser', 'Skip Playwright browser tests')
	.option('--browser', 'Run only Playwright browser tests')
	.option('--shard <value>', 'Vitest shard, form <index>/<count> (e.g. 1/3)')
	.option('--coverage', 'Collect coverage and write lcov/json per tier')
	.parse();

const opts = program.opts();
const bail = opts.bail as boolean;
const concurrency = Number.parseInt(opts.concurrency, 10);
const pattern = opts.pattern as string | undefined;
const packageFilter = opts.package as string | undefined;
const skipBrowser = opts.skipBrowser as boolean;
const browserFlag = opts.browser as boolean;
const shard = opts.shard as string | undefined;
const shardIndex = shard ? Number.parseInt(shard.split('/')[0], 10) : undefined;
const coverage = opts.coverage as boolean;

const TEST_PACKAGES = ['packages/server', 'packages/web'];

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

// coverage-v8 (vitest) and `bun test --coverage` both write lcov `SF:` paths
// relative to the spawn cwd (the package dir), e.g. `SF:src/logger.ts`. Coveralls
// resolves lcov paths from the repo root, so they must be repo-root-relative
// (`packages/server/src/logger.ts`) to map across the monorepo — otherwise the
// per-package `src/...` paths collide. Rewrite in place so the uploaded lcov is
// correct at the source. Idempotent: lines already rooted at `/` (absolute) or
// `packages/` are left untouched.
function rewriteLcovToRepoRoot(lcovPath: string, pkg: string): void {
	if (!existsSync(lcovPath)) return;
	const fixed = readFileSync(lcovPath, 'utf8').replace(
		/^SF:(?!\/|packages\/)(.+)$/gm,
		(_m, rest) => `SF:${pkg}/${rest}`,
	);
	writeFileSync(lcovPath, fixed);
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
	if (shard) args.push(`--shard=${shard}`);
	// --passWithNoTests guards an empty selection (a pattern matching nothing, or
	// a shard that lands zero files); add it once if either is in play.
	if (pattern || shard) args.push('--passWithNoTests');
	// Overrides the config's enabled:false default. reportsDirectory ('./coverage')
	// is package-relative and cwd is the package dir below, so server/web reports
	// land in their own packages/<pkg>/coverage/ — no collision.
	if (coverage) args.push('--coverage.enabled', '--coverage.provider=v8');
	if (pattern) args.push(pattern);

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
	// reportOnFailure:true means an lcov exists even on failure — rewrite either way.
	if (coverage) rewriteLcovToRepoRoot(resolve(ROOT, pkg, 'coverage/lcov.info'), pkg);
	console.log(`\n${pkg}: ${passed ? 'passed' : 'FAILED'} (${(duration / 1000).toFixed(1)}s)`);
	return passed;
}

async function runBunNativeForPackage(pkg: string): Promise<boolean> {
	const bunDir = resolve(ROOT, pkg, 'test/bun');
	if (!existsSync(bunDir)) return true;

	console.log(`\n── Running ${pkg} Bun-native tier (bun test test/bun/) ──`);
	const start = Date.now();
	const bunArgs = ['test', 'test/bun/'];
	// Separate dir from the vitest tier's './coverage' — both write lcov.info, so
	// a shared dir would clobber. Paths are made repo-root-relative below via
	// rewriteLcovToRepoRoot (same as the vitest tier).
	if (coverage) {
		bunArgs.push('--coverage', '--coverage-reporter=lcov', '--coverage-dir=coverage-bun');
	}
	const proc = Bun.spawn(['bun', ...bunArgs], {
		cwd: resolve(ROOT, pkg),
		stdout: 'inherit',
		stderr: 'inherit',
		env: { ...process.env, NODE_ENV: 'test' },
	});
	const exitCode = await proc.exited;
	const duration = Date.now() - start;
	const passed = exitCode === 0;
	if (coverage) rewriteLcovToRepoRoot(resolve(ROOT, pkg, 'coverage-bun/lcov.info'), pkg);
	console.log(
		`\n${pkg} (Bun-native): ${passed ? 'passed' : 'FAILED'} (${(duration / 1000).toFixed(1)}s)`,
	);
	return passed;
}

async function runBrowserTests(): Promise<boolean> {
	console.log('\n── Browser Tests ──');
	const playwrightArgs = ['playwright', 'test'];
	if (pattern) playwrightArgs.push(pattern);
	const proc = Bun.spawn(['bunx', ...playwrightArgs], {
		cwd: ROOT,
		stdout: 'inherit',
		stderr: 'inherit',
		env: { ...process.env, NODE_ENV: 'test' },
	});
	const passed = (await proc.exited) === 0;
	console.log(`\nBrowser: ${passed ? 'passed' : 'FAILED'}`);
	return passed;
}

async function main() {
	// vitest transforms through vite, which statically resolves the literal
	// `import('./xxx-bundle.json')` in the server's migrate/agent-roles/static
	// loaders and errors if the file is absent. buildAgentBundle fills the agents
	// bundle with real content; stub the rest so both the server and web suites
	// resolve. An empty stub is treated as "absent" at runtime → filesystem fallback.
	ensureBundles();
	await Promise.all([buildShared(), buildAgentBundle()]);

	const browserOnly = browserFlag;
	let integrationPassed = true;

	if (!browserOnly) {
		const packages = packageFilter
			? TEST_PACKAGES.filter((p) => p.endsWith(`/${packageFilter}`) || p === packageFilter)
			: TEST_PACKAGES;

		if (packages.length === 0) {
			console.error(`No matching package for --package=${packageFilter}`);
			process.exit(1);
		}

		// The Bun-native tier runs under `bun test` (production runtime). Its
		// files live in test/bun/ and contain "bun" in their path, so honour
		// --pattern by running it only when no pattern is set or the pattern
		// targets that tier. It isn't shardable by vitest, so when sharding run
		// it exactly once (on shard 1) — not duplicated across the matrix, not
		// dropped. Without --shard, shardIndex is undefined → unchanged behavior.
		const runBunNative =
			(!pattern || pattern.includes('bun')) && (shardIndex === undefined || shardIndex === 1);

		for (const pkg of packages) {
			const passed = await runVitestForPackage(pkg);
			if (!passed) {
				integrationPassed = false;
				if (bail) break;
			}
			if (runBunNative) {
				const bunPassed = await runBunNativeForPackage(pkg);
				if (!bunPassed) {
					integrationPassed = false;
					if (bail) break;
				}
			}
		}
	}

	const runBrowser = !skipBrowser && (!packageFilter || browserOnly);
	const browserPassed = runBrowser ? await runBrowserTests() : true;

	await cleanupDockerContainers();

	if (!integrationPassed || !browserPassed) process.exit(1);
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
