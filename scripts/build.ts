#!/usr/bin/env bun
import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Command } from 'commander';
import { ensureBundles } from './ensure-bundles';

const ROOT = resolve(import.meta.dir, '..');

const program = new Command()
	.name('build')
	.description('Build all Hezo packages (shared → server, web in parallel)')
	.option('--compile', 'Build a single compiled binary for the current platform')
	.option('--release', 'Cross-compile self-contained binaries for every supported platform')
	.parse();

const opts = program.opts();
const wantBinary = Boolean(opts.compile || opts.release);

// Bun cross-compiles every target from a single host, so a release build needs
// only one runner. Each binary embeds the frontend, migrations, agent roles,
// and version — fully self-contained, nothing read from disk at runtime.
const TARGETS = [
	{ target: 'bun-linux-x64', out: 'hezo-linux-x64' },
	{ target: 'bun-linux-arm64', out: 'hezo-linux-arm64' },
	{ target: 'bun-windows-x64', out: 'hezo-windows-x64.exe' },
	{ target: 'bun-darwin-x64', out: 'hezo-darwin-x64' },
	{ target: 'bun-darwin-arm64', out: 'hezo-darwin-arm64' },
];

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

function readVersion(): string {
	// The release flow bumps the per-package versions (the root package.json has
	// none), so read the server package — it's what the binary is built from.
	const pkgPath = join(ROOT, 'packages', 'server', 'package.json');
	const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version: string };
	return pkg.version;
}

async function compile(version: string, target: string | null, outfile: string) {
	const cmd = ['bun', 'build', '--compile'];
	if (target) cmd.push(`--target=${target}`);
	cmd.push('--define', `process.env.HEZO_VERSION="${version}"`);
	cmd.push('packages/server/src/index.ts', '--outfile', outfile);
	await run('.', cmd);
}

// shared must build first (dependency of server)
await run('packages/shared', ['bun', 'run', 'build']);

// Stub any missing embed bundles before tsc (server) and vite (web, which
// imports server's static-assets.ts) run in parallel — both statically resolve
// the literal `import('./xxx-bundle.json')` and error if the file is absent.
// The real content is written by the build:* steps below / the binary path.
ensureBundles();

// server and web build in parallel
await Promise.all([
	(async () => {
		await run('packages/server', ['bun', 'run', 'build']);
		await run('packages/server', ['bun', 'run', 'build:migrations']);
		await run('packages/server', ['bun', 'run', 'build:agents']);
		await run('packages/server', ['bun', 'run', 'build:skills']);
		// Embed the committed marketplace team templates as the offline snapshot
		// (read-only bundle step; build:marketplace regenerates the committed JSONs
		// and is run by authors / bun run dev, not in CI where it would dirty the tree).
		await run('packages/server', ['bun', 'run', 'build:teams']);
		await run('packages/server', ['bun', 'run', 'build:docs']);
	})(),
	run('packages/web', ['bun', 'run', 'build']),
]);

// Binary-only embedding steps: the static bundle (reads packages/web/dist), the
// PGlite runtime assets, and the agent-base Docker build context — all needed
// for a self-contained executable (a binary has no repo checkout to read from).
if (wantBinary) {
	await run('packages/server', ['bun', 'run', 'build:static']);
	await run('packages/server', ['bun', 'run', 'build:pglite']);
	await run('packages/server', ['bun', 'run', 'build:docker']);
}

console.log('Build complete.');

if (wantBinary) {
	const version = readVersion();

	if (opts.release) {
		console.log(`\nCross-compiling release binaries (v${version})...`);
		const outDir = resolve(ROOT, 'dist', 'binaries');
		mkdirSync(outDir, { recursive: true });
		for (const { target, out } of TARGETS) {
			await compile(version, target, join('dist', 'binaries', out));
		}
		// sha256sum -c compatible manifest for download verification.
		const lines = readdirSync(outDir)
			.filter((f) => f !== 'SHA256SUMS')
			.sort()
			.map(
				(f) =>
					`${createHash('sha256')
						.update(readFileSync(join(outDir, f)))
						.digest('hex')}  ${f}`,
			);
		writeFileSync(join(outDir, 'SHA256SUMS'), `${lines.join('\n')}\n`);
		console.log(`\nRelease binaries + SHA256SUMS in ${outDir}`);
	} else {
		console.log(`\nCompiling single binary (v${version})...`);
		mkdirSync(resolve(ROOT, 'dist'), { recursive: true });
		await compile(version, null, 'dist/hezo');
		console.log('\nCompiled binary at dist/hezo');
	}
}
