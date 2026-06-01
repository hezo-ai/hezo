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

	let dataDir: string = opts.dataDir;
	if (dataDir.startsWith('~')) {
		dataDir = resolve(homedir(), dataDir.slice(2));
	} else {
		dataDir = resolve(dataDir);
	}

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
