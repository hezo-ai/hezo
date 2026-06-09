import { homedir } from 'node:os';
import { resolve } from 'node:path';
import {
	DEFAULT_DATA_DIR,
	DEFAULT_PORT,
	mnemonicToMasterKey,
	validateMnemonic,
} from '@hezo/shared';
import { Command } from 'commander';

export type LogLevelName = 'debug' | 'info' | 'warn' | 'error';

export interface HezoConfig {
	port: number;
	dataDir: string;
	masterKey?: string;
	webUrl: string;
	reset: boolean;
	open: boolean;
	logLevel: LogLevelName;
	keepOldContainers: boolean;
}

function resolveDataDir(raw: string): string {
	return raw.startsWith('~') ? resolve(homedir(), raw.slice(2)) : resolve(raw);
}

function parsePort(raw: string): number {
	const n = Number.parseInt(raw, 10);
	if (Number.isNaN(n) || n < 1 || n > 65535) {
		throw new Error(`Invalid port: ${raw}. Must be 1-65535.`);
	}
	return n;
}

function parseLogLevel(raw: string): LogLevelName {
	const lower = raw.toLowerCase();
	if (lower === 'debug' || lower === 'info' || lower === 'warn' || lower === 'error') {
		return lower;
	}
	throw new Error(`Invalid log level: ${raw}. Must be debug | info | warn | error.`);
}

function parseBool(raw: string): boolean {
	if (raw === '') return true;
	const lower = raw.toLowerCase();
	return lower !== '0' && lower !== 'false' && lower !== 'no' && lower !== 'off';
}

function parseMasterKey(raw: string): string {
	return validateMnemonic(raw) ? mnemonicToMasterKey(raw) : raw;
}

/**
 * Handle the `hezo restore <backup>` subcommand: restore a pre-migration
 * snapshot into the data dir's `pgdata`, then exit. Returns `true` when it
 * handled the invocation so the caller skips normal server startup. The
 * operator then runs the matching (older) Hezo binary against the restored DB.
 */
export async function runRestore(argv: string[] = process.argv): Promise<boolean> {
	if (argv[2] !== 'restore') return false;

	const program = new Command()
		.name('hezo restore')
		.description('Restore a pre-migration database snapshot (for manual downgrade)')
		.argument('<backup>', 'path to a backup .tar.gz under <data-dir>/backups')
		.option('--data-dir <path>', 'Data directory', DEFAULT_DATA_DIR)
		// argv is [runtime, script, 'restore', <backup>, ...flags] in both dev and
		// the compiled binary — parse only the tokens after the subcommand name.
		.parse(argv.slice(3), { from: 'user' });

	const backup = program.args[0];
	const dataDir = resolveDataDir(program.opts().dataDir as string);
	const { restoreDataDir } = await import('./db/backup.js');
	await restoreDataDir(dataDir, resolve(backup));
	return true;
}

/**
 * Central configuration resolution. Each option can be set via either a CLI
 * flag or an env var; the env var takes precedence when both are present. The
 * defaults defined here are the final fallback. This is the only place where
 * config values are resolved — subsystems (logger level, container removal
 * gate, etc.) receive their slice and apply it locally at startup.
 */
export function parseConfig(
	argv: string[] = process.argv,
	env: NodeJS.ProcessEnv = process.env,
): HezoConfig {
	const program = new Command()
		.name('hezo')
		.description('Hezo server — self-hosted AI agent management platform')
		.option('--port <port>', 'Server port (env: HEZO_PORT)', String(DEFAULT_PORT))
		.option('--data-dir <path>', 'Data directory (env: HEZO_DATA_DIR)', DEFAULT_DATA_DIR)
		.option('--master-key <key>', 'Master key for unlocking (env: HEZO_MASTER_KEY)')
		.option('--web-url <url>', 'Web UI base URL for redirects (env: HEZO_WEB_URL)', '')
		.option('--reset', 'Reset database and start fresh (env: HEZO_RESET)')
		.option('--open', 'Auto-open the browser (env: HEZO_OPEN)')
		.option(
			'--log-level <level>',
			'Log level: debug | info | warn | error (env: HEZO_LOG_LEVEL)',
			'info',
		)
		.option(
			'--keep-old-containers',
			'Skip removal of old containers on rebuild/teardown/provision — useful for inspecting crashed containers via `docker logs` / `docker inspect`. Subsequent rebuilds will fail with a name conflict until the operator removes them manually. (env: HEZO_KEEP_OLD_CONTAINERS)',
		)
		.parse(argv);

	const cli = program.opts();

	// Env var > CLI value > default. For value-bearing options the CLI value
	// is a string; for flags it's a boolean (commander sets `true` when the
	// flag is present, `undefined` otherwise).
	const pick = (envName: string, cliValue: unknown): string | undefined => {
		const e = env[envName];
		if (e !== undefined && e !== '') return e;
		if (typeof cliValue === 'string' && cliValue.length > 0) return cliValue;
		return undefined;
	};
	const pickBool = (envName: string, cliValue: unknown): boolean => {
		const e = env[envName];
		if (e !== undefined) return parseBool(e);
		return cliValue === true;
	};

	const masterKeyRaw = pick('HEZO_MASTER_KEY', cli.masterKey);

	return {
		port: parsePort(pick('HEZO_PORT', cli.port) ?? String(DEFAULT_PORT)),
		dataDir: resolveDataDir(pick('HEZO_DATA_DIR', cli.dataDir) ?? DEFAULT_DATA_DIR),
		masterKey: masterKeyRaw ? parseMasterKey(masterKeyRaw) : undefined,
		webUrl: pick('HEZO_WEB_URL', cli.webUrl) ?? '',
		reset: pickBool('HEZO_RESET', cli.reset),
		open: pickBool('HEZO_OPEN', cli.open),
		logLevel: parseLogLevel(pick('HEZO_LOG_LEVEL', cli.logLevel) ?? 'info'),
		keepOldContainers: pickBool('HEZO_KEEP_OLD_CONTAINERS', cli.keepOldContainers),
	};
}
