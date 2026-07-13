import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
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
	/**
	 * S3-compatible asset storage URL (`--asset-storage-url` /
	 * `HEZO_ASSET_STORAGE_URL`). Unset → asset blobs on the local filesystem
	 * under `<dataDir>/assets`. The raw value carries credentials: it must never
	 * be logged or exposed un-redacted (see `redactAssetStorageUrl` in
	 * `lib/asset-storage-info.ts`) and never passed into `buildApp`.
	 */
	assetStorageUrl?: string;
	masterKey?: { unlockKeyHex: string; publicKeyHex: string };
	webUrl: string;
	reset: boolean;
	open: boolean;
	logLevel: LogLevelName;
	keepOldContainers: boolean;
	/**
	 * Install staged updates automatically (`--auto-install-updates` /
	 * `HEZO_AUTO_INSTALL_UPDATES`). Once a newer release is downloaded and
	 * verified, the server gracefully restarts onto it by itself instead of
	 * waiting for a superuser's "Install & restart" — deferring while agent runs
	 * are in flight. Only effective where the in-app update flow is available at
	 * all (the self-managed compiled binary, not inside a container).
	 */
	autoInstallUpdates: boolean;
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
	 * Require a per-run token on every request to the egress proxy. On by
	 * default: each run's `HTTP(S)_PROXY` URL carries a random token that the
	 * proxy checks (constant-time) before substituting any secret, so a
	 * co-resident process that reaches the proxy address can't drive
	 * substitution for another run. Disable only to unblock a runtime whose HTTP
	 * client can't carry proxy credentials — the secret red line still holds
	 * either way (an unauthenticated caller only ships unsubstituted
	 * placeholders). `--no-egress-proxy-auth` / `HEZO_EGRESS_PROXY_AUTH=0`.
	 */
	egressProxyAuth: boolean;
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

/** As `pickDatabaseUrl`, for the asset-storage URL on the backup/restore subcommands. */
function pickAssetStorageUrl(
	cliValue: unknown,
	env: NodeJS.ProcessEnv = process.env,
): string | undefined {
	const e = env.HEZO_ASSET_STORAGE_URL;
	if (e !== undefined && e !== '') return e;
	if (typeof cliValue === 'string' && cliValue.length > 0) return cliValue;
	return undefined;
}

/**
 * Handle the `hezo backup` subcommand and exit. By default it captures BOTH the
 * database and every asset blob into a portable **backup bundle** directory
 * (`hezo-<timestamp>/` — `database.backup.gz` + `assets/<projectId>/<assetId>` +
 * a `manifest.json` written last). Either half is excluded with `--no-assets`
 * (database only → the legacy single `.backup.gz` file) or `--no-database`
 * (assets only). A bundle restores onto either backend, which is how an instance
 * moves its database and assets between local and hosted storage. Returns `true`
 * when it handled the invocation so the caller skips normal server startup.
 *
 * For the embedded database / local asset store the server must be stopped first
 * (the embedded engine is single-process, and a live server races the asset
 * directory). An external database + S3 storage can be backed up any time — the
 * source is only ever read.
 */
export async function runBackup(argv: string[] = process.argv): Promise<boolean> {
	if (argv[2] !== 'backup') return false;

	const program = new Command()
		.name('hezo backup')
		.description(
			'Write a portable backup of the database and asset files (works for both backends)',
		)
		.option(
			'--output <path>',
			'Output path: a bundle directory (default <data-dir>/backups/hezo-<timestamp>), or a .backup.gz file with --no-assets',
		)
		.option('--data-dir <path>', 'Data directory', DEFAULT_DATA_DIR)
		.option('--database-url <url>', 'External Postgres connection string (env: HEZO_DATABASE_URL)')
		.option(
			'--asset-storage-url <url>',
			'S3-compatible asset storage to read blobs from (env: HEZO_ASSET_STORAGE_URL)',
		)
		.option('--no-assets', 'Back up the database only — skip asset files')
		.option('--no-database', 'Back up asset files only — skip the database')
		.parse(argv.slice(3), { from: 'user' });

	const opts = program.opts();
	const withAssets = opts.assets !== false;
	const withDatabase = opts.database !== false;
	if (!withAssets && !withDatabase) {
		throw new Error('Nothing to back up: --no-assets and --no-database cannot be combined.');
	}
	const dataDir = resolveDataDir(opts.dataDir as string);
	const databaseUrl = pickDatabaseUrl(opts.databaseUrl);
	const assetStorageUrl = pickAssetStorageUrl(opts.assetStorageUrl);

	const { mkdir, writeFile } = await import('node:fs/promises');
	const { openDatabase } = await import('./db/open.js');
	const stamp = new Date().toISOString().replace(/[:.]/g, '-');

	const dumpDatabase = async (db: import('./db/database').Db): Promise<Buffer> => {
		const { loadAllMigrations } = await import('./db/load-migrations.js');
		const migrations = await loadAllMigrations();
		if (!migrations) throw new Error('No migrations found — cannot determine the schema version.');
		const { dumpLogicalBackup } = await import('./db/logical-backup.js');
		return dumpLogicalBackup(db, { hezoVersion: HEZO_VERSION, migrations });
	};

	// --no-assets keeps the exact legacy single-file artifact (the DB-only
	// .backup.gz that the auto/pre-migration and legacy-restore paths expect).
	if (!withAssets) {
		const opened = await openDatabase({ dataDir, databaseUrl });
		try {
			const bytes = await dumpDatabase(opened.db);
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

	// Bundle path: DB (unless --no-database) + asset blobs + manifest (last).
	const bundleDir = resolve(
		(opts.output as string | undefined) ?? `${dataDir}/backups/hezo-${stamp}`,
	);
	const blob = await import('./assets/blob-backup.js');
	const { openAssetStorage } = await import('./assets/open.js');

	await mkdir(bundleDir, { recursive: true });
	const opened = await openDatabase({ dataDir, databaseUrl });
	const openedStore = await openAssetStorage({ dataDir, assetStorageUrl });
	try {
		let databaseFile: string | null = null;
		if (withDatabase) {
			await writeFile(join(bundleDir, blob.BUNDLE_DB_NAME), await dumpDatabase(opened.db));
			databaseFile = blob.BUNDLE_DB_NAME;
		}
		const assets = await blob.dumpAssetBlobs(opened.db, openedStore.store, bundleDir);
		await blob.writeBundleManifest(bundleDir, {
			kind: blob.BUNDLE_KIND,
			bundleFormatVersion: blob.BUNDLE_FORMAT_VERSION,
			hezoVersion: HEZO_VERSION,
			createdAt: new Date().toISOString(),
			database: databaseFile ? { file: databaseFile } : null,
			assets: {
				backend: openedStore.store.kind,
				count: assets.count,
				totalBytes: assets.bytes,
				missing: assets.missing,
			},
		});
		const dbNote = withDatabase ? `${opened.storage.backend} database + ` : '';
		const missingNote = assets.missing.length
			? ` — ${assets.missing.length} asset blob(s) were missing at the source`
			: '';
		console.log(
			`Wrote backup bundle → ${bundleDir} ` +
				`(${dbNote}${assets.count} asset blob(s) from ${openedStore.info.backend} storage)${missingNote}`,
		);
	} finally {
		await openedStore.store.close();
		await opened.db.close();
	}
	return true;
}

/**
 * Handle the `hezo restore <backup>` subcommand, then exit. It accepts:
 *
 * - **Backup bundle** (a `hezo backup` directory) — restores the database
 *   and/or asset blobs it contains into the target backends (`--database-url` /
 *   `--asset-storage-url`), which is how an instance moves both between local
 *   and hosted storage. `--no-assets` / `--no-database` restore only one half.
 * - **Portable logical backup** (`.backup.gz`) — database only; restores onto
 *   EITHER backend. Requires an empty target or `--wipe`.
 * - **Legacy pgdata tarball** (pre-logical snapshots) — embedded only; wipes
 *   `pgdata` and reloads the physical snapshot.
 *
 * Asset blobs are verified by sha256 against the target rows when present.
 * Returns `true` when it handled the invocation so the caller skips normal
 * server startup.
 */
export async function runRestore(argv: string[] = process.argv): Promise<boolean> {
	if (argv[2] !== 'restore') return false;

	const program = new Command()
		.name('hezo restore')
		.description(
			'Restore a backup: a "hezo backup" bundle (database + assets), a logical .backup.gz, or a legacy pgdata .tar.gz',
		)
		.argument('<backup>', 'path to a backup bundle directory or file')
		.option('--data-dir <path>', 'Data directory', DEFAULT_DATA_DIR)
		.option(
			'--database-url <url>',
			'External Postgres connection string to restore into (env: HEZO_DATABASE_URL)',
		)
		.option(
			'--asset-storage-url <url>',
			'S3-compatible asset storage to restore blobs into (env: HEZO_ASSET_STORAGE_URL)',
		)
		.option('--wipe', 'Drop the existing schema in the target database before restoring')
		.option('--no-assets', 'Restore the database only — skip asset files in a bundle')
		.option('--no-database', 'Restore asset files only — skip the database in a bundle')
		.option(
			'--strict-assets',
			'Fail if any restored asset blob has no matching database row to verify against',
		)
		// argv is [runtime, script, 'restore', <backup>, ...flags] in both dev and
		// the compiled binary — parse only the tokens after the subcommand name.
		.parse(argv.slice(3), { from: 'user' });

	const opts = program.opts();
	const backupPath = resolve(program.args[0]);
	const dataDir = resolveDataDir(opts.dataDir as string);
	const databaseUrl = pickDatabaseUrl(opts.databaseUrl);
	const assetStorageUrl = pickAssetStorageUrl(opts.assetStorageUrl);

	const { loadAllMigrations } = await import('./db/load-migrations.js');
	const { openDatabase } = await import('./db/open.js');
	const blob = await import('./assets/blob-backup.js');

	// Backup bundle (a directory): restore the database and/or assets it holds.
	if (await blob.isBundleDir(backupPath)) {
		const withAssets = opts.assets !== false;
		const withDatabase = opts.database !== false;
		if (!withAssets && !withDatabase) {
			throw new Error('Nothing to restore: --no-assets and --no-database cannot be combined.');
		}
		const manifest = await blob.readBundleManifest(backupPath);
		const restoreDb = withDatabase && manifest.database !== null;
		const restoreAssets = withAssets && manifest.assets !== null;

		const { readFile } = await import('node:fs/promises');
		const { openAssetStorage } = await import('./assets/open.js');

		const opened = await openDatabase({ dataDir, databaseUrl });
		// Preflight the target asset store BEFORE loading the DB so a bad bucket fails fast.
		const openedStore = restoreAssets ? await openAssetStorage({ dataDir, assetStorageUrl }) : null;
		try {
			if (restoreDb) {
				const migrations = await loadAllMigrations();
				if (!migrations) {
					throw new Error('No migrations found — cannot reproduce the backup schema.');
				}
				const { restoreLogicalBackup } = await import('./db/logical-backup.js');
				const dbBytes = await readFile(join(backupPath, blob.BUNDLE_DB_NAME));
				const summary = await restoreLogicalBackup(opened.db, dbBytes, migrations, {
					wipe: opts.wipe === true,
				});
				console.log(
					`Restored database (Hezo ${manifest.hezoVersion}, taken ${manifest.createdAt}) into the ` +
						`${opened.storage.backend} backend: ${summary.rows} rows across ${summary.tables} tables.`,
				);
			}
			if (restoreAssets && openedStore) {
				const summary = await blob.restoreAssetBlobs(opened.db, openedStore.store, backupPath, {
					strict: opts.strictAssets === true,
				});
				const unverifiedNote = summary.unverified
					? ` (${summary.unverified} without a matching database row)`
					: '';
				console.log(
					`Restored ${summary.count} asset blob(s) into the ${openedStore.info.backend} storage${unverifiedNote}.`,
				);
			}
			if (!restoreDb && !restoreAssets) {
				console.log('This bundle has nothing to restore for the given options.');
			}
		} finally {
			if (openedStore) await openedStore.store.close();
			await opened.db.close();
		}
		return true;
	}

	// Single-file backups (unchanged): logical .backup.gz, or a legacy pgdata tarball.
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

	const migrations = await loadAllMigrations();
	if (!migrations) throw new Error('No migrations found — cannot reproduce the backup schema.');

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
			'--asset-storage-url <url>',
			'S3-compatible object storage for asset files (s3://ACCESS_KEY:SECRET@endpoint/bucket[/prefix]?region=…&pathStyle=…). Works with AWS S3, MinIO, R2, Spaces, B2, and any other S3-compatible store. Omit to store assets on the local filesystem under the data directory. (env: HEZO_ASSET_STORAGE_URL)',
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
			'--no-egress-proxy-auth',
			"Disable per-run egress proxy authentication. On by default: each run's HTTP(S)_PROXY URL carries a token the proxy verifies before substituting secrets. Only disable to unblock a runtime whose HTTP client cannot send proxy credentials — the secret red line still holds (an unauthenticated caller only ships unsubstituted placeholders). (env: HEZO_EGRESS_PROXY_AUTH=0)",
		)
		.option(
			'--auto-install-updates',
			'Install updates automatically: once a newer release is downloaded and verified, gracefully restart onto it without waiting for "Install & restart" in the web UI (in-flight agent runs delay the restart). Only takes effect where in-app auto-update is available — the self-managed binary, not inside a container. The instance comes back unlocked: the in-memory unlock key is handed to the relaunched process over IPC, never written to disk. (env: HEZO_AUTO_INSTALL_UPDATES)',
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
		assetStorageUrl: pick('HEZO_ASSET_STORAGE_URL', cli.assetStorageUrl),
		masterKey: masterKeyRaw ? parseMasterKey(masterKeyRaw) : undefined,
		webUrl: pick('HEZO_WEB_URL', cli.webUrl) ?? '',
		reset,
		// Auto-open is on by default; headless detection at startup decides whether
		// a browser actually launches. HEZO_OPEN=0 / --no-open disables it. With
		// `--no-open` commander sets cli.open=false; absent, it defaults to true.
		open: pickOpen('HEZO_OPEN', cli.open),
		logLevel: parseLogLevel(pick('HEZO_LOG_LEVEL', cli.logLevel) ?? 'info'),
		keepOldContainers: pickBool('HEZO_KEEP_OLD_CONTAINERS', cli.keepOldContainers),
		autoInstallUpdates: pickBool('HEZO_AUTO_INSTALL_UPDATES', cli.autoInstallUpdates),
		containerBindHost: pick('HEZO_CONTAINER_BIND_HOST', cli.containerBindHost) ?? '127.0.0.1',
		// Egress-proxy auth defaults ON. The env var (when set) wins; otherwise
		// `--no-egress-proxy-auth` sets cli.egressProxyAuth=false, absent it is true.
		egressProxyAuth: pickOpen('HEZO_EGRESS_PROXY_AUTH', cli.egressProxyAuth),
		telemetry: {
			enabled: telemetryEnabled,
			endpoint:
				pick('HEZO_TELEMETRY_ENDPOINT', cli.telemetryEndpoint) ?? DEFAULT_TELEMETRY_ENDPOINT,
		},
	};
}
