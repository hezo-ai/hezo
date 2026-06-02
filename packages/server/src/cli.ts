import { homedir } from 'node:os';
import { resolve } from 'node:path';
import {
	DEFAULT_DATA_DIR,
	DEFAULT_PORT,
	mnemonicToMasterKey,
	validateMnemonic,
} from '@hezo/shared';
import { Command } from 'commander';

export interface HezoConfig {
	port: number;
	dataDir: string;
	masterKey?: string;
	webUrl: string;
	reset: boolean;
	open: boolean;
}

function resolveDataDir(raw: string): string {
	return raw.startsWith('~') ? resolve(homedir(), raw.slice(2)) : resolve(raw);
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

export function parseArgs(argv: string[] = process.argv): HezoConfig {
	const program = new Command()
		.name('hezo')
		.description('Hezo server — self-hosted AI agent management platform')
		.option('--port <port>', 'Server port', String(DEFAULT_PORT))
		.option('--data-dir <path>', 'Data directory', DEFAULT_DATA_DIR)
		.option('--master-key <key>', 'Master key for unlocking')
		.option('--web-url <url>', 'Web UI base URL for redirects (leave empty to use same origin)', '')
		.option('--reset', 'Reset database and start fresh')
		.option('--open', 'Auto-open the browser')
		.parse(argv);

	const opts = program.opts();

	const port = Number.parseInt(opts.port, 10);
	if (Number.isNaN(port) || port < 1 || port > 65535) {
		throw new Error(`Invalid port: ${opts.port}. Must be 1-65535.`);
	}

	const dataDir = resolveDataDir(opts.dataDir as string);

	// The user-facing master key is a 12-word BIP39 phrase; convert it to the
	// internal hex. Anything that isn't a valid phrase (raw hex, opaque e2e key)
	// passes through unchanged.
	let masterKey: string | undefined = opts.masterKey;
	if (masterKey && validateMnemonic(masterKey)) {
		masterKey = mnemonicToMasterKey(masterKey);
	}

	return {
		port,
		dataDir,
		masterKey,
		webUrl: opts.webUrl ?? '',
		reset: opts.reset ?? false,
		open: opts.open ?? false,
	};
}
