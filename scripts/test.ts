#!/usr/bin/env bun
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { resolve } from 'node:path';
import {
	TEST_CONTAINER_LABEL_KEY,
	TEST_CONTAINER_LABEL_VALUE,
	TEST_CONTAINERS_ENV,
} from '@hezo/shared';
import { Command } from 'commander';
import { buildCombinedLcov, formatStats } from './coverage/merge';
import { ensureBundles } from './ensure-bundles';
import { shouldRunBunNative } from './test-selection';

const ROOT = resolve(import.meta.dir, '..');

// Any server this run spawns (e.g. the Playwright e2e server) must label the
// containers it provisions as test containers so the cleanup below can scope to
// them. Inherited by child processes.
process.env[TEST_CONTAINERS_ENV] = '1';

// Collapse the password-verifier KDF to its cheapest valid cost for every tier
// this runner spawns. Each createTestApp enrolls a verifier via scrypt; at the
// production cost (N=2**15) that is ~280ms of pure overhead per test. Setting it
// here (inherited by child processes) covers the tiers a vitest config can't —
// notably the Bun-native tier, which `bun test` runs outside any vitest config,
// yet whose egress suites still boot createTestApp. Honoured only under
// NODE_ENV=test and clamped to lower-only (see passwordScryptParams in
// packages/shared/src/crypto/auth.ts); `??=` lets an explicit override win.
process.env.HEZO_TEST_SCRYPT_LOG_N ??= '1';

/**
 * Worker count, derived from the machine rather than hardcoded.
 *
 * Every worker is a forked process that boots its own PGlite (a WASM Postgres)
 * and re-loads the module graph, so a worker is CPU- and memory-hungry rather
 * than IO-bound. Running more of them than there are cores does not overlap
 * anything — it just adds context switching and memory pressure, and on a
 * 2-core CI runner or a 4-core laptop the old flat 10 was a ~2.5x
 * oversubscription that made the suite slower, not faster.
 *
 * Clamped to [2, 10]. The ceiling keeps behaviour identical on machines that
 * were already big enough for the previous default, so this can only reduce
 * worker counts, never raise them; the floor keeps some parallelism on a
 * single-core box. `--concurrency` still overrides.
 */
const MIN_CONCURRENCY = 2;
const MAX_CONCURRENCY = 10;
const defaultConcurrency = Math.min(
	MAX_CONCURRENCY,
	Math.max(MIN_CONCURRENCY, availableParallelism()),
);

const program = new Command()
	.name('test')
	.description('Run Hezo test suite across all packages')
	.option('--bail', 'Stop on first test failure')
	.option('--concurrency <n>', 'Number of parallel test workers', String(defaultConcurrency))
	.option(
		'--pattern <str>',
		'Filter test files by substring match (repeatable; matches are OR-ed)',
		(value: string, previous: string[]) => previous.concat(value),
		[] as string[],
	)
	.option('--package <name>', 'Run tests only in a specific package')
	.option('--skip-browser', 'Skip Playwright browser tests')
	.option('--browser', 'Run only Playwright browser tests')
	.option('--shard <value>', 'Vitest shard, form <index>/<count> (e.g. 1/3)')
	.option('--bun-native', 'Force the Bun-native tier on, whatever --pattern/--shard select')
	.option('--skip-bun-native', 'Skip the Bun-native tier')
	.option('--coverage', 'Collect coverage and write lcov/json per tier')
	.parse();

const opts = program.opts();
const bail = opts.bail as boolean;
const concurrency = Number.parseInt(opts.concurrency, 10);
const patterns = opts.pattern as string[];
const packageFilter = opts.package as string | undefined;
const skipBrowser = opts.skipBrowser as boolean;
const browserFlag = opts.browser as boolean;
const shard = opts.shard as string | undefined;
const shardIndex = shard ? Number.parseInt(shard.split('/')[0], 10) : undefined;
const forceBunNative = opts.bunNative as boolean;
const skipBunNative = opts.skipBunNative as boolean;
const coverage = opts.coverage as boolean;

if (forceBunNative && skipBunNative) {
	console.error('--bun-native and --skip-bun-native are mutually exclusive');
	process.exit(1);
}

const TEST_PACKAGES = ['packages/server', 'packages/web', 'packages/shared'];

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

// The vitest and Bun coverage tiers write per-package reports (vitest also writes
// an istanbul `coverage-final.json`; Bun writes only lcov). CI shards the vitest
// tiers, so the shard reports are merged in JSON space — not by OR-ing per-shard
// lcovs, which double-counts branches whose coverage-v8 ordinals differ per run —
// then reconciled and combined. All that plumbing lives in scripts/coverage/
// (lcov.ts + merge.ts); CI's merge job runs it on the downloaded artifacts and
// the local full run below prints the same combined total.
//
// Reports each tier writes, consumed by buildCombinedLcov():
//   packages/server/coverage/coverage-final.json   (vitest, istanbul JSON)
//   packages/server/coverage-bun/lcov.info         (bun test --coverage)
//   packages/web/coverage/coverage-final.json      (vitest)
//   packages/shared/coverage/coverage-final.json   (vitest)
function printCombinedCoverage(): void {
	const finalJson = (pkg: string) => resolve(ROOT, pkg, 'coverage/coverage-final.json');
	const result = buildCombinedLcov({
		serverJson: [finalJson('packages/server')].filter(existsSync),
		webJson: [finalJson('packages/web')].filter(existsSync),
		sharedJson: [finalJson('packages/shared')].filter(existsSync),
		bunLcov: resolve(ROOT, 'packages/server/coverage-bun/lcov.info'),
	});
	mkdirSync(resolve(ROOT, 'coverage'), { recursive: true });
	writeFileSync(resolve(ROOT, 'coverage/lcov.info'), result.combined);
	console.log('\n── Combined coverage (Coveralls-equivalent: lines + branches) ──');
	console.log(formatStats(result.stats));
	console.log('(wrote coverage/lcov.info)');
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
	if (patterns.length || shard) args.push('--passWithNoTests');
	// Overrides the config's enabled:false default. reportsDirectory ('./coverage')
	// is package-relative and cwd is the package dir below, so server/web reports
	// land in their own packages/<pkg>/coverage/ — no collision.
	if (coverage) args.push('--coverage.enabled', '--coverage.provider=v8');
	// vitest treats trailing positionals as OR-ed filename filters, so a repeated
	// --pattern maps straight onto them.
	args.push(...patterns);

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

async function runBunNativeForPackage(pkg: string): Promise<boolean> {
	const bunDir = resolve(ROOT, pkg, 'test/bun');
	if (!existsSync(bunDir)) return true;

	console.log(`\n── Running ${pkg} Bun-native tier (bun test test/bun/) ──`);
	const start = Date.now();
	const bunArgs = ['test', 'test/bun/'];
	// Bun writes only lcov (no istanbul JSON), to its own dir so it never clobbers
	// the vitest tier's ./coverage. It carries no branch data and its line model is
	// reconciled against the merged vitest model later, in buildCombinedLcov.
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
	console.log(
		`\n${pkg} (Bun-native): ${passed ? 'passed' : 'FAILED'} (${(duration / 1000).toFixed(1)}s)`,
	);
	return passed;
}

// Build the web bundle the Playwright suite serves via `vite preview`. Running
// the browser tests against the prebuilt bundle instead of two Vite dev servers
// keeps the CI runner's CPU off the dev server's per-request module transform,
// which otherwise starved the backend until task fetches timed out (see the
// HEZO_E2E_PREVIEW note in playwright.config.ts). Done synchronously here, before
// Playwright launches its webServers, because Playwright starts webServers ahead
// of any globalSetup — there is no in-config hook that runs early enough.
async function buildWebBundle(): Promise<boolean> {
	console.log('Building web bundle for browser tests...');
	const proc = Bun.spawn(['bunx', 'vite', 'build'], {
		cwd: resolve(ROOT, 'packages/web'),
		stdout: 'inherit',
		stderr: 'inherit',
	});
	const exitCode = await proc.exited;
	if (exitCode !== 0) console.error('Failed to build web bundle');
	return exitCode === 0;
}

async function runBrowserTests(): Promise<boolean> {
	console.log('\n── Browser Tests ──');
	if (!(await buildWebBundle())) return false;
	const playwrightArgs = ['playwright', 'test'];
	playwrightArgs.push(...patterns);
	// Fan the browser suite across CI runners the same way the vitest tiers shard.
	// Playwright distributes its tests across the shards; `--pass-with-no-tests`
	// keeps a shard that lands zero tests green instead of erroring.
	if (shard) playwrightArgs.push(`--shard=${shard}`, '--pass-with-no-tests');
	const proc = Bun.spawn(['bunx', ...playwrightArgs], {
		cwd: ROOT,
		stdout: 'inherit',
		stderr: 'inherit',
		// HEZO_E2E_PREVIEW=1 switches playwright.config.ts's webServers from the
		// Vite dev server to `vite preview`, serving the bundle built just above.
		env: { ...process.env, NODE_ENV: 'test', HEZO_E2E_PREVIEW: '1' },
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
		// --pattern by running it only when no pattern is set or a pattern
		// targets that tier. It isn't shardable by vitest, so when sharding run
		// it exactly once (on shard 1) — not duplicated across the matrix, not
		// dropped. Without --shard, shardIndex is undefined → unchanged behavior.
		//
		// The two flags override that default in either direction, and exist
		// because CI no longer runs this tier inside the backend shards at all:
		// it needs Docker and the agent-base image, so it runs in the dedicated
		// `test-containers` job (--bun-native) while every backend shard opts out
		// (--skip-bun-native). Keeping the shard-1 default means a local
		// `--shard` run still behaves as it always did.
		const runBunNative = shouldRunBunNative({
			patterns,
			shardIndex,
			force: forceBunNative,
			skip: skipBunNative,
		});

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

		// A full local --coverage run (unsharded) prints the combined line+branch
		// total the way Coveralls scores it. CI never reaches here — its shards run
		// with --shard, and the dedicated merge job combines the shard artifacts.
		if (coverage && shardIndex === undefined && !process.env.CI) printCombinedCoverage();
	}

	const runBrowser = !skipBrowser && (!packageFilter || browserOnly);
	const browserPassed = runBrowser ? await runBrowserTests() : true;

	await cleanupDockerContainers();

	if (!integrationPassed || !browserPassed) process.exit(1);
}

async function cleanupDockerContainers() {
	try {
		// Scope strictly to containers this test run provisioned (labelled by the
		// provisioner). A bare `name=^hezo-` filter also matches a developer's live
		// dev-server containers and would delete them.
		const ps = Bun.spawn(
			[
				'docker',
				'ps',
				'-aq',
				'--filter',
				`label=${TEST_CONTAINER_LABEL_KEY}=${TEST_CONTAINER_LABEL_VALUE}`,
			],
			{
				stdout: 'pipe',
				stderr: 'pipe',
			},
		);
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
