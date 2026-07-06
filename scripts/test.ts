#!/usr/bin/env bun
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
	TEST_CONTAINER_LABEL_KEY,
	TEST_CONTAINER_LABEL_VALUE,
	TEST_CONTAINERS_ENV,
} from '@hezo/shared';
import { Command } from 'commander';
import { ensureBundles } from './ensure-bundles';

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

// Both the vitest (coverage-v8) and Bun tiers write lcov `SF:` paths relative to
// the spawn cwd (the package dir), e.g. `SF:src/logger.ts`. Normalize each report
// before upload: (1) rewrite every SF path to be repo-root-relative
// (`packages/<pkg>/src/...`) so Coveralls maps it across the monorepo without the
// per-package `src/...` paths colliding, and (2) keep only records under the
// package's `src/` tree. The vitest tier already scopes to src via `include`, but
// `bun test --coverage` also instruments loaded test support (test/helpers/*, the
// bun setup preload) — coverage must report source, not test code.
function normalizeLcov(lcovPath: string, pkg: string): void {
	if (!existsSync(lcovPath)) return;
	const srcPrefix = `${pkg}/src/`;
	const records = readFileSync(lcovPath, 'utf8')
		.split(/^end_of_record$/m)
		.map((rec) => rec.trim())
		.filter(Boolean)
		.map((rec) => rec.replace(/^SF:(?!\/|packages\/)(.+)$/m, (_m, rest) => `SF:${pkg}/${rest}`))
		.filter((rec) => {
			const sf = rec.match(/^SF:(.+)$/m);
			return sf ? sf[1].startsWith(srcPrefix) : false;
		});
	writeFileSync(
		lcovPath,
		records.length ? `${records.join('\nend_of_record\n')}\nend_of_record\n` : '',
	);
}

// `bun test --coverage` treats every line of a loaded file as executable —
// comments, blank lines, SQL string continuations, type-only lines — and emits
// `DA:<n>,0` for all of them in files its few specs load but never run. The
// vitest tier (coverage-v8) maps through sourcemaps and only emits DA rows for
// genuinely executable lines. Coveralls merges the parallel uploads by line
// number, so the Bun tier's phantom rows count as "missed lines" for every file
// both tiers load and depress the merged total (~6.5k lines repo-wide) in a way
// no test can ever recover. Reconcile the models: for each file the vitest lcov
// also reports, keep only the Bun DA rows whose line numbers exist in the vitest
// line model (recomputing LF/LH); files only the Bun tier loads pass through
// unchanged. The vitest lcov is always written and normalized before the Bun
// tier runs in the same invocation (see main()), locally and in CI.
function reconcileBunLcovLineModel(bunLcovPath: string, vitestLcovPath: string): void {
	if (!existsSync(bunLcovPath) || !existsSync(vitestLcovPath)) return;
	const vitestLines = new Map<string, Set<number>>();
	let sf = '';
	for (const line of readFileSync(vitestLcovPath, 'utf8').split('\n')) {
		if (line.startsWith('SF:')) {
			sf = line.slice(3).trim();
			if (!vitestLines.has(sf)) vitestLines.set(sf, new Set());
		} else if (line.startsWith('DA:')) {
			vitestLines.get(sf)?.add(Number.parseInt(line.slice(3), 10));
		}
	}
	const records = readFileSync(bunLcovPath, 'utf8')
		.split(/^end_of_record$/m)
		.map((rec) => rec.trim())
		.filter(Boolean)
		.map((rec) => {
			const sfMatch = rec.match(/^SF:(.+)$/m);
			const model = sfMatch ? vitestLines.get(sfMatch[1].trim()) : undefined;
			if (!model) return rec;
			let lf = 0;
			let lh = 0;
			const kept = rec.split('\n').filter((line) => {
				if (!line.startsWith('DA:')) return true;
				const [ln, hits] = line.slice(3).split(',');
				if (!model.has(Number.parseInt(ln, 10))) return false;
				lf++;
				if (Number.parseInt(hits, 10) > 0) lh++;
				return true;
			});
			return kept
				.map((line) => {
					if (line.startsWith('LF:')) return `LF:${lf}`;
					if (line.startsWith('LH:')) return `LH:${lh}`;
					return line;
				})
				.join('\n');
		});
	writeFileSync(
		bunLcovPath,
		records.length ? `${records.join('\nend_of_record\n')}\nend_of_record\n` : '',
	);
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
	// reportOnFailure:true means an lcov exists even on failure — normalize either way.
	if (coverage) normalizeLcov(resolve(ROOT, pkg, 'coverage/lcov.info'), pkg);
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
	if (coverage) {
		const bunLcov = resolve(ROOT, pkg, 'coverage-bun/lcov.info');
		normalizeLcov(bunLcov, pkg);
		reconcileBunLcovLineModel(bunLcov, resolve(ROOT, pkg, 'coverage/lcov.info'));
	}
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
	if (pattern) playwrightArgs.push(pattern);
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
