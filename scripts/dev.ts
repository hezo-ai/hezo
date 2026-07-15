#!/usr/bin/env bun
import { existsSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { Command } from 'commander';
import { resolveDevDataDir } from '../packages/server/src/cli';
import { clearAllProjectWorkspaces } from '../packages/server/src/services/workspace';

const ROOT = resolve(import.meta.dir, '..');
const SERVER_CWD = resolve(ROOT, 'packages/server');

// Args after the script name. These are forwarded verbatim to the server so
// dev never has to mirror the server's option list — the server's commander
// (packages/server/src/cli.ts) is the single source of truth for flags.
const forwardedArgs = process.argv.slice(2);

// Delegate help to the server so `bun run dev --help` shows the authoritative
// option set. The server's parseConfig() runs before startup, so commander
// prints help and exits without booting anything.
if (forwardedArgs.includes('--help') || forwardedArgs.includes('-h')) {
	const help = Bun.spawnSync(['bun', 'run', 'src/index.ts', '--help'], {
		cwd: SERVER_CWD,
		stdout: 'inherit',
		stderr: 'inherit',
	});
	process.exit(help.exitCode ?? 0);
}

// dev acts on a couple of flags itself (resetting pgdata, clearing workspaces),
// so it parses just those while tolerating every other flag for passthrough.
const program = new Command()
	.name('dev')
	.description('Start all Hezo services in development mode (forwards all flags to the server)')
	.allowUnknownOption()
	.allowExcessArguments()
	.option('--reset', 'Reset the server database')
	.option('--data-dir <path>', 'Data directory')
	.parse();

const opts = program.opts();

// Default to a project-local, gitignored dir (<repo>/.hezo-dev) so local dev
// never shares the production database at ~/.hezo. An explicit --data-dir or
// HEZO_DATA_DIR still wins (and is then already visible to the spawned server).
const { dataDir, usedDefault } = resolveDevDataDir(
	resolve(ROOT, '.hezo-dev'),
	opts.dataDir,
	process.env,
);

if (opts.reset) {
	const pgDataPath = resolve(dataDir, 'pgdata');
	if (existsSync(pgDataPath)) {
		rmSync(pgDataPath, { recursive: true, force: true });
		console.log(`Reset: removed ${pgDataPath}`);
	}
}

const cleared = clearAllProjectWorkspaces(dataDir);
if (cleared.length > 0) {
	console.log(`Cleared ${cleared.length} project workspace(s) under ${dataDir}/teams`);
}

// Duplicated from @hezo/shared (DEFAULT_WEB_PORT) to avoid adding a root-level
// workspace dependency — mirrors packages/web/vite.config.ts.
const webPort = process.env.HEZO_WEB_PORT ?? '5173';
// Default the web URL for redirects unless the caller set their own, then
// forward every flag through untouched.
const hasWebUrl = forwardedArgs.some((a) => a === '--web-url' || a.startsWith('--web-url='));
// Auto-open is the server's default, but dev is restarted constantly — spawning
// a browser tab each time is noise. Suppress it by default; HEZO_OPEN=1 in the
// inherited env still wins (the env var takes precedence over this flag), and we
// don't double-pass if the caller already forwarded --no-open.
const hasNoOpen = forwardedArgs.includes('--no-open');
const serverArgs: string[] = [
	...(hasNoOpen ? [] : ['--no-open']),
	...(hasWebUrl ? [] : ['--web-url', `http://localhost:${webPort}`]),
	// Only inject when we fell back to the dev default — otherwise the server
	// already sees the user's choice via inherited env or forwardedArgs.
	...(usedDefault ? ['--data-dir', dataDir] : []),
	...forwardedArgs,
];

// Sync dependencies before starting: a fast no-op when current, and it
// re-applies any changed patches/*.patch to node_modules — the server
// otherwise keeps running a stale copy of a patched dependency after a pull.
const install = Bun.spawnSync(['bun', 'install'], { cwd: ROOT });
if (install.exitCode !== 0) {
	process.stdout.write(install.stdout.toString());
	process.stderr.write(install.stderr.toString());
	console.error('bun install failed');
	process.exit(1);
}

// Bundle migrations before starting the server
const bundle = Bun.spawnSync(['bun', 'run', 'scripts/bundle-migrations.ts'], {
	cwd: resolve(ROOT, 'packages/server'),
	stdout: 'inherit',
	stderr: 'inherit',
});
if (bundle.exitCode !== 0) {
	console.error('Failed to bundle migrations');
	process.exit(1);
}

// Regenerate the committed marketplace team templates from their authoring
// sources (agents/<team>/team.json + prompts) so the dev server serves fresh
// JSON and any version bump / prompt change shows up as a reviewable git diff.
const marketplace = Bun.spawnSync(['bun', 'run', 'scripts/build-marketplace-teams.ts'], {
	cwd: resolve(ROOT, 'packages/server'),
	stdout: 'inherit',
	stderr: 'inherit',
});
if (marketplace.exitCode !== 0) {
	console.error('Failed to build marketplace team templates');
	process.exit(1);
}

const procs = [
	// --hot (not --watch) so import.meta.hot.dispose can close PGlite before reload.
	Bun.spawn(['bun', 'run', '--hot', 'src/index.ts', ...serverArgs], {
		cwd: resolve(ROOT, 'packages/server'),
		stdout: 'inherit',
		stderr: 'inherit',
		env: { ...process.env },
	}),
	Bun.spawn(['bun', 'run', 'dev'], {
		cwd: resolve(ROOT, 'packages/web'),
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
