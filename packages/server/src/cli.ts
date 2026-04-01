import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { Command } from 'commander';

export interface HezoConfig {
	port: number;
	dataDir: string;
	masterKey?: string;
	connectUrl: string;
	connectApiKey?: string;
	reset: boolean;
	noOpen: boolean;
}

const DEFAULT_PORT = 3100;
const DEFAULT_DATA_DIR = '~/.hezo';
const DEFAULT_CONNECT_URL = 'http://localhost:4100';

export function parseArgs(argv: string[] = process.argv): HezoConfig {
	const program = new Command()
		.name('hezo')
		.description('Hezo server — self-hosted AI agent management platform')
		.option('--port <port>', 'Server port', String(DEFAULT_PORT))
		.option('--data-dir <path>', 'Data directory', DEFAULT_DATA_DIR)
		.option('--master-key <key>', 'Master key for unlocking')
		.option('--connect-url <url>', 'Hezo Connect URL', DEFAULT_CONNECT_URL)
		.option('--connect-api-key <key>', 'Hezo Connect API key')
		.option('--reset', 'Reset database and start fresh')
		.option('--no-open', 'Do not auto-open the browser')
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

	return {
		port,
		dataDir,
		masterKey: opts.masterKey,
		connectUrl: opts.connectUrl,
		connectApiKey: opts.connectApiKey,
		reset: opts.reset ?? false,
		noOpen: opts.open === false,
	};
}
