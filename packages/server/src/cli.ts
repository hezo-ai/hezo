import { homedir } from 'node:os';
import { resolve } from 'node:path';
import {
	DEFAULT_DATA_DIR,
	DEFAULT_PORT,
	deriveAuthKeyPair,
	deriveUnlockKey,
	validateMnemonic,
} from '@hezo/shared';
import { Command } from 'commander';
import { DEFAULT_TELEMETRY_ENDPOINT } from './services/telemetry';
import { HEZO_VERSION } from './version';

export type LogLevelName = 'debug' | 'info' | 'warn' | 'error';

export interface HezoConfig {
	port: number;
	dataDir: string;
	/**
	 * External Postgres connection string (`--database-url` / `HEZO_DATABASE_URL`).
	 * Unset → the embedded PGlite database under `<dataDir>/pgdata`. The raw value
	 * carries credentials: it must never be logged or exposed un-redacted (see
	 * `redactDatabaseUrl` in `lib/db-info.ts`) and never passed into `buildApp`.
	 */
	databaseUrl?: string;
	masterKey?: { unlockKeyHex: string; publicKeyHex: string };
	webUrl: string;
	reset: boolean;
	open: boolean;
	logLevel: LogLevelName;
	keepOldContainers: boolean;
	/**
	 * Interface the egress proxy and SSH bridge bind to so agent containers can
	 * reach them. Defaults to `127.0.0.1` (loopback — works with Docker Desktop,
	 * which tunnels `host.docker.internal` to host loopback). On native-Linux
	 * Docker a container reaches the host via the bridge gateway IP, where a
	 * loopback bind is unreachable, so set `0.0.0.0` (or the bridge gateway IP)
	 * and firewall-restrict the port range to the docker bridge.
	 */
	containerBindHost: string;
	/**
	 * Anonymous daily usage telemetry. On by default (opt-out): once a day the
	 * server POSTs aggregate counts (projects, tasks, tokens, AI-provider mix,
	 * version) — no names, content, or costs — to `endpoint`, keyed by a random
	 * per-install id. Disabled with `--disable-telemetry` / `HEZO_TELEMETRY_ENABLED=0`.
	 */
	telemetry: {
		enabled: boolean;
		endpoint: string;
	};
}

function resolveDataDir(raw: string): string {
	return raw.startsWith('~') ? resolve(homedir(), raw.slice(2)) : resolve(raw);
}

export interface DevDataDir {
	dataDir: string;
	/**
	 * True only when neither HEZO_DATA_DIR nor --data-dir was set — `bun run dev`
	 * must then forward the project-local default to the server it spawns, which
	 * would otherwise fall back to the production default (~/.hezo).
	 */
	usedDefault: boolean;
}

/**
 * Resolve the data dir for `bun run dev`. Mirrors parseConfig's precedence
 * (env HEZO_DATA_DIR > --data-dir > default) but swaps the production default
 * (~/.hezo) for a project-local dir so local dev never shares the production
 * database. Both env and CLI values flow through resolveDataDir, so a leading
 * `~` expands exactly as the server does. An empty env value is treated as
 * unset, matching parseConfig's `pick`.
 */
export function resolveDevDataDir(
	defaultDir: string,
	cliDataDir: string | undefined,
	env: NodeJS.ProcessEnv = process.env,
): DevDataDir {
	const envValue = env.HEZO_DATA_DIR;
	if (envValue !== undefined && envValue !== '') {
		return { dataDir: resolveDataDir(envValue), usedDefault: false };
	}
	if (cliDataDir !== undefined && cliDataDir !== '') {
		return { dataDir: resolveDataDir(cliDataDir), usedDefault: false };
	}
	return { dataDir: resolve(defaultDir), usedDefault: true };
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

/**
 * The master key is always the 12-word mnemonic — a raw derived key is
 * rejected because it could never enroll the auth public key, leaving an
 * unlocked server nobody can log into.
 */
function parseMasterKey(raw: string): { unlockKeyHex: string; publicKeyHex: string } {
	if (!validateMnemonic(raw)) {
		throw new Error('Invalid master key: must be the 12-word master key phrase.');
	}
	return {
		unlockKeyHex: deriveUnlockKey(raw),
		publicKeyHex: deriveAuthKeyPair(raw).publicKeyHex,
	};
}

/**
 * Handle a version request: `hezo --version`, `hezo -V`, or `hezo version`.
 * Prints the running build's version string and returns `true` so the caller
 * skips normal server startup (mirroring `runRestore`). Returns `false` when no
 * version was requested. `out` is injectable for testing.
 */
export function runVersion(
	argv: string[] = process.argv,
	out: (line: string) => void = console.log,
): boolean {
	const tokens = argv.slice(2);
	if (tokens.includes('--version') || tokens.includes('-V') || tokens[0] === 'version') {
		out(HEZO_VERSION);
		return true;
	}
	return false;
}

/** Env wins over flag, mirroring parseConfig's `pick` for subcommands. */
function pickDatabaseUrl(
	cliValue: unknown,
	env: NodeJS.ProcessEnv = process.env,
): string | undefined {
	const e = env.HEZO_DATABASE_URL;
	if (e !== undefined && e !== '') return e;
	if (typeof cliValue === 'string' && cliValue.length > 0) return cliValue;
	return undefined;
}

/**
 * Handle the `hezo backup` subcommand: write a portable logical backup of the
 * database (either backend) and exit. Returns `true` when it handled the
 * invocation so the caller skips normal server startup.
 *
 * For the embedded database the server must be stopped first — the embedded
 * engine is single-process. An external database can be backed up any time.
 */
export async function runBackup(argv: string[] = process.argv): Promise<boolean> {
	if (argv[2] !== 'backup') return false;

	const program = new Command()
		.name('hezo backup')
		.description('Write a portable logical backup of the database (works for both backends)')
		.option(
			'--output <path>',
			'Output file (default <data-dir>/backups/hezo-<timestamp>.backup.gz)',
		)
		.option('--data-dir <path>', 'Data directory', DEFAULT_DATA_DIR)
		.option('--database-url <url>', 'External Postgres connection string (env: HEZO_DATABASE_URL)')
		.parse(argv.slice(3), { from: 'user' });

	const opts = program.opts();
	const dataDir = resolveDataDir(opts.dataDir as string);
	const databaseUrl = pickDatabaseUrl(opts.databaseUrl);

	const { loadAllMigrations } = await import('./db/load-migrations.js');
	const migrations = await loadAllMigrations();
	if (!migrations) throw new Error('No migrations found — cannot determine the schema version.');

	const { openDatabase } = await import('./db/open.js');
	const { dumpLogicalBackup } = await import('./db/logical-backup.js');
	const { mkdir, writeFile } = await import('node:fs/promises');

	const opened = await openDatabase({ dataDir, databaseUrl });
	try {
		const bytes = await dumpLogicalBackup(opened.db, { hezoVersion: HEZO_VERSION, migrations });
		const stamp = new Date().toISOString().replace(/[:.]/g, '-');
		const output = resolve(
			(opts.output as string | undefined) ?? `${dataDir}/backups/hezo-${stamp}.backup.gz`,
		);
		await mkdir(resolve(output, '..'), { recursive: true });
		await writeFile(output, bytes);
		console.log(`Wrote logical backup of ${opened.storage.backend} database → ${output}`);
	} finally {
		await opened.db.close();
	}
	return true;
}

/**
 * Handle the `hezo restore <backup>` subcommand, then exit. Two formats:
 *
 * - **Portable logical backup** (`hezo backup` output, `.backup.gz`) —
 *   restores onto EITHER backend, which is also how an instance moves between
 *   embedded and hosted Postgres. Requires an empty target or `--wipe`.
 * - **Legacy pgdata tarball** (pre-logical snapshots) — embedded only; wipes
 *   `pgdata` and reloads the physical snapshot.
 *
 * Returns `true` when it handled the invocation so the caller skips normal
 * server startup.
 */
export async function runRestore(argv: string[] = process.argv): Promise<boolean> {
	if (argv[2] !== 'restore') return false;

	const program = new Command()
		.name('hezo restore')
		.description('Restore a database backup (logical .backup.gz, or a legacy pgdata .tar.gz)')
		.argument('<backup>', 'path to a backup file')
		.option('--data-dir <path>', 'Data directory', DEFAULT_DATA_DIR)
		.option(
			'--database-url <url>',
			'External Postgres connection string to restore into (env: HEZO_DATABASE_URL)',
		)
		.option('--wipe', 'Drop the existing schema in the target database before restoring')
		// argv is [runtime, script, 'restore', <backup>, ...flags] in both dev and
		// the compiled binary — parse only the tokens after the subcommand name.
		.parse(argv.slice(3), { from: 'user' });

	const opts = program.opts();
	const backupPath = resolve(program.args[0]);
	const dataDir = resolveDataDir(opts.dataDir as string);
	const databaseUrl = pickDatabaseUrl(opts.databaseUrl);

	const { readFile } = await import('node:fs/promises');
	const bytes = await readFile(backupPath);

	const { readLogicalBackupHeader, restoreLogicalBackup } = await import('./db/logical-backup.js');
	const header = readLogicalBackupHeader(bytes);

	if (!header) {
		// Legacy physical pgdata tarball — embedded only.
		if (databaseUrl) {
			console.error(
				'This file is a legacy pgdata snapshot, which only restores into the embedded ' +
					'database. To move data into an external Postgres, take a portable backup with ' +
					'`hezo backup` and restore that instead.',
			);
			process.exit(1);
		}
		const { restoreDataDir } = await import('./db/backup.js');
		await restoreDataDir(dataDir, backupPath);
		return true;
	}

	const { loadAllMigrations } = await import('./db/load-migrations.js');
	const migrations = await loadAllMigrations();
	if (!migrations) throw new Error('No migrations found — cannot reproduce the backup schema.');

	const { openDatabase } = await import('./db/open.js');
	const opened = await openDatabase({ dataDir, databaseUrl });
	try {
		const summary = await restoreLogicalBackup(opened.db, bytes, migrations, {
			wipe: opts.wipe === true,
		});
		console.log(
			`Restored logical backup (Hezo ${header.hezoVersion}, taken ${header.createdAt}) ` +
				`into the ${opened.storage.backend} database: ${summary.rows} rows across ${summary.tables} tables.`,
		);
	} finally {
		await opened.db.close();
	}
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
		.option(
			'--database-url <url>',
			'External Postgres connection string (postgres://user:password@host:5432/db). Omit to use the embedded database under the data directory. (env: HEZO_DATABASE_URL)',
		)
		.option(
			'--master-key <phrase>',
			'The 12-word master key phrase for setup/unlock (env: HEZO_MASTER_KEY)',
		)
		.option('--web-url <url>', 'Web UI base URL for redirects (env: HEZO_WEB_URL)', '')
		.option('--reset', 'Reset database and start fresh (env: HEZO_RESET)')
		.option('--no-open', 'Do not auto-open the browser on startup (env: HEZO_OPEN=0)')
		.option(
			'--log-level <level>',
			'Log level: debug | info | warn | error (env: HEZO_LOG_LEVEL)',
			'info',
		)
		.option(
			'--keep-old-containers',
			'Skip removal of old containers on rebuild/teardown/provision — useful for inspecting crashed containers via `docker logs` / `docker inspect`. Subsequent rebuilds will fail with a name conflict until the operator removes them manually. (env: HEZO_KEEP_OLD_CONTAINERS)',
		)
		.option(
			'--container-bind-host <host>',
			'Interface the egress proxy and SSH bridge bind to so agent containers can reach them. Default 127.0.0.1 (works with Docker Desktop). On native-Linux Docker set 0.0.0.0 (or the bridge gateway IP) and firewall-restrict the egress port range to the docker bridge. (env: HEZO_CONTAINER_BIND_HOST)',
		)
		.option(
			'--disable-telemetry',
			'Disable anonymous daily usage telemetry (aggregate counts only — no names, content, or costs). On by default. (env: HEZO_TELEMETRY_ENABLED=0)',
		)
		.option(
			'--telemetry-endpoint <url>',
			`Override the telemetry collection endpoint (default ${DEFAULT_TELEMETRY_ENDPOINT}). (env: HEZO_TELEMETRY_ENDPOINT)`,
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
	// Like pickBool but defaults to ON. Commander's `--no-open` sets cli.open to
	// false when passed and true otherwise, so the only way to disable via CLI is
	// `--no-open`; the env var still wins when set.
	const pickOpen = (envName: string, cliValue: unknown): boolean => {
		const e = env[envName];
		if (e !== undefined && e !== '') return parseBool(e);
		return cliValue !== false;
	};

	const masterKeyRaw = pick('HEZO_MASTER_KEY', cli.masterKey);

	const databaseUrl = pick('HEZO_DATABASE_URL', cli.databaseUrl);
	const reset = pickBool('HEZO_RESET', cli.reset);
	if (databaseUrl && reset) {
		throw new Error(
			'--reset applies to the embedded database only (it renames a corrupt pgdata aside). ' +
				'For an external database, drop and recreate it with your provider tools instead.',
		);
	}

	// Telemetry defaults ON. The env var (when set) wins; otherwise the only way
	// to disable via CLI is the explicit `--disable-telemetry` flag.
	const telemetryEnabled = ((): boolean => {
		const e = env.HEZO_TELEMETRY_ENABLED;
		if (e !== undefined && e !== '') return parseBool(e);
		return cli.disableTelemetry !== true;
	})();

	return {
		port: parsePort(pick('HEZO_PORT', cli.port) ?? String(DEFAULT_PORT)),
		dataDir: resolveDataDir(pick('HEZO_DATA_DIR', cli.dataDir) ?? DEFAULT_DATA_DIR),
		databaseUrl,
		masterKey: masterKeyRaw ? parseMasterKey(masterKeyRaw) : undefined,
		webUrl: pick('HEZO_WEB_URL', cli.webUrl) ?? '',
		reset,
		// Auto-open is on by default; headless detection at startup decides whether
		// a browser actually launches. HEZO_OPEN=0 / --no-open disables it. With
		// `--no-open` commander sets cli.open=false; absent, it defaults to true.
		open: pickOpen('HEZO_OPEN', cli.open),
		logLevel: parseLogLevel(pick('HEZO_LOG_LEVEL', cli.logLevel) ?? 'info'),
		keepOldContainers: pickBool('HEZO_KEEP_OLD_CONTAINERS', cli.keepOldContainers),
		containerBindHost: pick('HEZO_CONTAINER_BIND_HOST', cli.containerBindHost) ?? '127.0.0.1',
		telemetry: {
			enabled: telemetryEnabled,
			endpoint:
				pick('HEZO_TELEMETRY_ENDPOINT', cli.telemetryEndpoint) ?? DEFAULT_TELEMETRY_ENDPOINT,
		},
	};
}
