import { join, resolve } from 'node:path';
import {
	DEFAULT_DATA_DIR,
	deriveAuthKeyPair,
	deriveUnlockKey,
	validateMnemonic,
} from '@hezo/shared';
import { Command } from 'commander';
import { loadConfigFile } from './config/load';
import { loadPolicy } from './config/policy';
import {
	detectRemovedEnvVars,
	formatRemovedEnvFatal,
	type ResolvedDataLocation,
} from './config/removed-env';
import type { ConfigFile } from './config/schema';
import { DEFAULT_CONFIG, type HezoConfig, resolveDataDir } from './config/types';
import { createStreamProgressReporter, formatBytes } from './lib/progress';
import { HEZO_VERSION } from './version';

export type { HezoConfig, LogLevelName } from './config/types';

/**
 * Read the `--config <path>` option off an already-parsed command. Every
 * command accepts it, and a command that was given none resolves from the
 * built-in defaults alone.
 */
function readConfigFile(opts: Record<string, unknown>): ConfigFile {
	const path = opts.config;
	return typeof path === 'string' && path.length > 0 ? loadConfigFile(path) : {};
}

/**
 * Resolve the settings the backup/restore/uninstall subcommands share, with the
 * same flag > config file > default precedence the server uses.
 *
 * One resolver rather than a picker per setting: the four this replaced had
 * drifted apart, and the one in `runUninstall` let an *empty* value win where
 * the others treated empty as unset.
 */
interface SubcommandTargets {
	dataDir: string;
	databaseUrl?: string;
	assetStorageUrl?: string;
}

function resolveSubcommandTargets(
	opts: Record<string, unknown>,
	env: NodeJS.ProcessEnv = process.env,
): SubcommandTargets {
	const file = readConfigFile(opts);
	const flag = (value: unknown): string | undefined =>
		typeof value === 'string' && value.length > 0 ? value : undefined;
	const targets: SubcommandTargets = {
		dataDir: resolveDataDir(flag(opts.dataDir) ?? file.dataDir ?? DEFAULT_DATA_DIR),
		databaseUrl: flag(opts.databaseUrl) ?? file.database?.url,
		assetStorageUrl: flag(opts.assetStorageUrl) ?? file.assetStorage?.url,
	};
	assertNoRemovedDataLocationEnv(env, {
		dataDir: targets.dataDir,
		database: { url: targets.databaseUrl },
		assetStorage: { url: targets.assetStorageUrl },
	});
	return targets;
}

/** The `--config` option text, identical on every command that accepts one. */
const CONFIG_OPTION_DESC =
	'Path to a Hezo config file (a CommonJS module: module.exports = { … }). Settings in it are ' +
	'overridden by any flag you also pass.';

export interface DevDataDir {
	dataDir: string;
	/**
	 * True only when neither --data-dir nor a config file set one — `bun run dev`
	 * must then forward the project-local default to the server it spawns, which
	 * would otherwise fall back to the production default (~/.hezo).
	 */
	usedDefault: boolean;
}

/**
 * Resolve the data dir for `bun run dev`. Mirrors resolveConfig's precedence
 * (--data-dir > config file > default) but swaps the production default
 * (~/.hezo) for a project-local dir so local dev never shares the production
 * database.
 */
export function resolveDevDataDir(
	defaultDir: string,
	cliDataDir: string | undefined,
	configPath?: string,
): DevDataDir {
	if (cliDataDir !== undefined && cliDataDir !== '') {
		return { dataDir: resolveDataDir(cliDataDir), usedDefault: false };
	}
	const fromFile = configPath ? loadConfigFile(configPath).dataDir : undefined;
	if (fromFile !== undefined && fromFile !== '') {
		return { dataDir: resolveDataDir(fromFile), usedDefault: false };
	}
	return { dataDir: resolve(defaultDir), usedDefault: true };
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

/**
 * Refuse an embedded backup/restore while a Hezo server is live on `dataDir`.
 *
 * Embedded PGlite is single-process: backup opens a *second* Postgres cluster
 * over the same `pgdata` files (and restore writes those files directly), so
 * running either against a live server races its writes and can corrupt the
 * data. The running server drops an advisory PID lock; this reads it and only
 * refuses when the recorded process is actually alive, so a stale lock left by a
 * crash (dead PID) does not block anything. Embedded target only — external
 * Postgres handles its own concurrency and is safe to back up live.
 */
async function assertNoLiveEmbeddedServer(
	dataDir: string,
	action: 'backup' | 'restore',
): Promise<void> {
	const { readLiveInstanceLock, instanceLockPath } = await import('./db/instance-lock.js');
	const live = readLiveInstanceLock(dataDir);
	if (!live) return;
	const verb = action === 'backup' ? 'back up' : 'restore';
	const risk =
		action === 'backup'
			? 'the backup opens a second database over the same files, which races the live server and can corrupt them'
			: 'the restore writes over files the live server is using, which can corrupt them';
	throw new Error(
		`A Hezo server appears to be running against ${dataDir} (PID ${live.pid}). ` +
			`Stop it before you ${verb} the embedded database — ${risk}. ` +
			`If you are certain no server is running, delete ${instanceLockPath(dataDir)} and retry.`,
	);
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

/**
 * Best-effort teardown for backup/restore cleanup paths. A close failure must
 * never mask the operation's real error: when a query crashes the embedded
 * engine's WASM instance, closing that dead instance throws the same runtime
 * error, and a throwing `finally` would replace the diagnosable original.
 */
async function closeQuietly(closeable: { close(): Promise<unknown> } | null | undefined) {
	if (!closeable) return;
	try {
		await closeable.close();
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		console.warn(`Warning: could not close the database cleanly (${msg}); continuing.`);
	}
}

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
		.option('--config <path>', CONFIG_OPTION_DESC)
		.option('--data-dir <path>', `Data directory (default ${DEFAULT_DATA_DIR})`)
		.option('--database-url <url>', 'External Postgres connection string')
		.option('--asset-storage-url <url>', 'S3-compatible asset storage to read blobs from')
		.option('--no-assets', 'Back up the database only — skip asset files')
		.option('--no-database', 'Back up asset files only — skip the database')
		.parse(argv.slice(3), { from: 'user' });

	const opts = program.opts();
	const withAssets = opts.assets !== false;
	const withDatabase = opts.database !== false;
	if (!withAssets && !withDatabase) {
		throw new Error('Nothing to back up: --no-assets and --no-database cannot be combined.');
	}
	const { dataDir, databaseUrl, assetStorageUrl } = resolveSubcommandTargets(opts);

	// Embedded backend: never open a second cluster over a live server's files.
	if (!databaseUrl) await assertNoLiveEmbeddedServer(dataDir, 'backup');

	const { mkdir } = await import('node:fs/promises');
	const { openDatabase } = await import('./db/open.js');
	const stamp = new Date().toISOString().replace(/[:.]/g, '-');

	// Streams straight to `outFile`: a logical dump held in memory first is a
	// multi-GB allocation on a real instance, which OOM-kills small hosts.
	const dumpDatabaseToFile = async (
		db: import('./db/database').Db,
		sourceLabel: string,
		outFile: string,
	): Promise<void> => {
		// A data dir (or external database) that isn't a Hezo instance has no
		// `_migrations` bookkeeping. For embedded storage `openPersistentDb` happily
		// creates an empty database on open, so without this guard the dump would
		// crash with a bare `relation "_migrations" does not exist`. Fail with an
		// actionable message instead - the usual cause is a `--data-dir` (or a
		// config file's `dataDir`) that doesn't point at the running instance's data.
		const probe = await db.query<{ reg: string | null }>(
			`SELECT to_regclass('public._migrations')::text AS reg`,
		);
		if (probe.rows[0]?.reg == null) {
			throw new Error(
				`No Hezo database found at ${sourceLabel}: its migration bookkeeping (the _migrations ` +
					`table) is missing, so there is nothing to back up. Check that --data-dir (or the ` +
					`\`dataDir\` key in the file you pass to --config) points at your instance's data ` +
					`directory; an external database is selected with --database-url or \`database.url\`. ` +
					`A brand-new instance has no database until the server has started at least once.`,
			);
		}
		const { loadAllMigrations } = await import('./db/load-migrations.js');
		const migrations = await loadAllMigrations();
		if (!migrations) throw new Error('No migrations found — cannot determine the schema version.');
		const { dumpLogicalBackupToFile } = await import('./db/logical-backup.js');
		await mkdir(resolve(outFile, '..'), { recursive: true });
		await dumpLogicalBackupToFile(db, outFile, { hezoVersion: HEZO_VERSION, migrations });
	};

	// --no-assets keeps the exact legacy single-file artifact (the DB-only
	// .backup.gz that the auto/pre-migration and legacy-restore paths expect).
	if (!withAssets) {
		const opened = await openDatabase({ dataDir, databaseUrl });
		try {
			const output = resolve(
				(opts.output as string | undefined) ?? `${dataDir}/backups/hezo-${stamp}.backup.gz`,
			);
			await dumpDatabaseToFile(opened.db, opened.storage.display, output);
			console.log(`Wrote logical backup of ${opened.storage.backend} database → ${output}`);
		} finally {
			await closeQuietly(opened.db);
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
			await dumpDatabaseToFile(
				opened.db,
				opened.storage.display,
				join(bundleDir, blob.BUNDLE_DB_NAME),
			);
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
		await closeQuietly(openedStore.store);
		await closeQuietly(opened.db);
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
 *
 * Physical pgdata tarballs (the pre-logical snapshot format) are not accepted:
 * they only ever loaded into embedded PGlite, so they were never a backup you
 * could restore onto both backends. Restoring one needs a Hezo old enough to
 * have written it.
 *
 * Asset blobs are verified by sha256 against the target rows when present.
 * Returns `true` when it handled the invocation so the caller skips normal
 * server startup.
 *
 * Every phase reports progress (`lib/progress.ts`) — a live row/file counter
 * with a percentage and ETA, rewritten in place on a TTY and appended as
 * throttled lines when the output is a pipe or a log file — so a restore of a
 * large instance is never a silent multi-minute wait.
 */
export async function runRestore(argv: string[] = process.argv): Promise<boolean> {
	if (argv[2] !== 'restore') return false;

	const program = new Command()
		.name('hezo restore')
		.description(
			'Restore a backup: a "hezo backup" bundle (database + assets), or a logical .backup.gz',
		)
		.argument('<backup>', 'path to a backup bundle directory or file')
		.option('--config <path>', CONFIG_OPTION_DESC)
		.option('--data-dir <path>', `Data directory (default ${DEFAULT_DATA_DIR})`)
		.option('--database-url <url>', 'External Postgres connection string to restore into')
		.option('--asset-storage-url <url>', 'S3-compatible asset storage to restore blobs into')
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
	const { dataDir, databaseUrl, assetStorageUrl } = resolveSubcommandTargets(opts);

	// Embedded target: refuse to write over the files of a live server.
	if (!databaseUrl) await assertNoLiveEmbeddedServer(dataDir, 'restore');

	const { loadAllMigrations } = await import('./db/load-migrations.js');
	const { openDatabase } = await import('./db/open.js');
	const blob = await import('./assets/blob-backup.js');

	// Restoring a large instance is minutes of work with nothing to look at:
	// report each phase (and a live row/file counter) on the way through.
	const progress = createStreamProgressReporter();

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

		const { stat } = await import('node:fs/promises');
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
				const { restoreLogicalBackupFromFile } = await import('./db/logical-backup.js');
				const dbPath = join(backupPath, blob.BUNDLE_DB_NAME);
				progress.report({
					phase: 'read',
					label: 'Reading the database backup',
					detail: formatBytes((await stat(dbPath)).size),
				});
				const summary = await restoreLogicalBackupFromFile(opened.db, dbPath, migrations, {
					wipe: opts.wipe === true,
					onProgress: progress.report,
				});
				progress.finish();
				console.log(
					`Restored database (Hezo ${manifest.hezoVersion}, taken ${manifest.createdAt}) into the ` +
						`${opened.storage.backend} backend: ${summary.rows} rows across ${summary.tables} tables.`,
				);
			}
			if (restoreAssets && openedStore) {
				const summary = await blob.restoreAssetBlobs(opened.db, openedStore.store, backupPath, {
					strict: opts.strictAssets === true,
					onProgress: progress.report,
				});
				progress.finish();
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
			progress.finish();
			await closeQuietly(openedStore?.store);
			await closeQuietly(opened.db);
		}
		return true;
	}

	// Single-file backup: a logical .backup.gz.
	const { stat } = await import('node:fs/promises');
	progress.report({
		phase: 'read',
		label: 'Reading the backup',
		detail: formatBytes((await stat(backupPath)).size),
	});

	const { peekLogicalBackupHeaderFromFile, restoreLogicalBackupFromFile } = await import(
		'./db/logical-backup.js'
	);
	// Only decompress as far as the header to tell the two formats apart; the
	// restore then streams the body off disk rather than holding it in memory.
	const header = await peekLogicalBackupHeaderFromFile(backupPath);

	if (!header) {
		progress.finish();
		console.error(
			`${backupPath} is not a Hezo logical backup. Point at a ".backup.gz" written by ` +
				'`hezo backup`, or at a backup bundle directory.\n\n' +
				'If this is a legacy pgdata snapshot (the pre-logical .tar.gz format), restore it ' +
				'with the Hezo version that wrote it, then take a portable backup with `hezo backup` ' +
				'so it can be restored onto either storage backend from here on.',
		);
		process.exit(1);
	}

	const migrations = await loadAllMigrations();
	if (!migrations) throw new Error('No migrations found — cannot reproduce the backup schema.');

	const opened = await openDatabase({ dataDir, databaseUrl });
	try {
		const summary = await restoreLogicalBackupFromFile(opened.db, backupPath, migrations, {
			wipe: opts.wipe === true,
			onProgress: progress.report,
		});
		progress.finish();
		console.log(
			`Restored logical backup (Hezo ${header.hezoVersion}, taken ${header.createdAt}) ` +
				`into the ${opened.storage.backend} database: ${summary.rows} rows across ${summary.tables} tables.`,
		);
	} finally {
		progress.finish();
		await closeQuietly(opened.db);
	}
	return true;
}

/** Injectable seams for {@link runUninstall} — real Docker cleanup by default. */
export interface UninstallDeps {
	/**
	 * Remove the containers Hezo provisioned. Returns the count removed, or `null`
	 * when the backend was unreachable. Defaults to the real path; overridden in
	 * tests so they never touch a live daemon or a real provider account.
	 */
	removeContainers?: (opts: SandboxBackendOptions) => Promise<number | null>;
}

/** What uninstall needs to reach the backend the instance was running on. */
export interface SandboxBackendOptions {
	backend?: string;
	daytonaApiKey?: string;
	daytonaApiUrl?: string;
	/** Carried through for the same reason startup carries it: a pinned socket is pinned because discovery misses it. */
	dockerSocket?: string;
}

/**
 * Remove the containers, on whichever backend the instance used.
 *
 * Hard-wired to local Docker before, which meant uninstalling a managed-backend
 * instance removed the data directory and left the provider's sandboxes running.
 * Nothing then reaps them either: the orphan sweep lives in the server that was
 * just deleted, so they bill until somebody notices in a dashboard.
 *
 * An unreachable backend answers `null` rather than aborting - the data directory
 * is the thing the operator asked to remove, and refusing to do that because a
 * provider is down would be the wrong trade.
 */
async function defaultRemoveProvisionedContainers(
	opts: SandboxBackendOptions,
): Promise<number | null> {
	const { openSandboxBackend } = await import('./services/sandbox/open.js');
	const { removeProvisionedContainers } = await import('./services/uninstall.js');
	try {
		const { engine } = await openSandboxBackend(opts);
		return await removeProvisionedContainers(engine);
	} catch {
		return null;
	}
}

/**
 * Handle the `hezo uninstall` subcommand and exit. Removes Hezo's **data
 * directory** (default `~/.hezo`) — every project workspace, the embedded
 * database, backups, and settings — and best-effort removes the containers Hezo
 * provisioned. It does not touch the `hezo` binary itself.
 *
 * This exists because a plain `rm -rf ~/.hezo` fails on macOS: Docker Desktop
 * tags the nested `.previews` bind-mount point (`<project>/workspace/.previews`,
 * a mount target inside the `/workspace` bind) with a `deny delete` ACL that
 * `rm` cannot override, so the tree is left undeletable with a bare "Permission
 * denied". `forceRmRecursive` strips those ACLs (`chmod -RN`) and retries, so
 * `hezo uninstall` is the supported, ACL-aware way to fully remove an instance.
 *
 * Guards: refuses while a live embedded server holds the instance lock (stop it
 * first — deleting the data dir under a live server corrupts its database), and
 * requires an explicit `--yes`. Without `--yes` it prints exactly what would be
 * removed and exits without deleting anything.
 *
 * Returns `true` when it handled the invocation so the caller skips normal
 * server startup.
 */
export async function runUninstall(
	argv: string[] = process.argv,
	deps: UninstallDeps = {},
): Promise<boolean> {
	if (argv[2] !== 'uninstall') return false;

	const program = new Command()
		.name('hezo uninstall')
		.description(
			"Remove Hezo's data directory (all projects, the database, backups, settings) and the containers it created",
		)
		.option('--config <path>', CONFIG_OPTION_DESC)
		.option('--data-dir <path>', `Data directory to remove (default ${DEFAULT_DATA_DIR})`)
		.option('--yes', 'Confirm removal — required; without it nothing is deleted')
		// The instance's own backend, so its containers are removed wherever they
		// actually ran. Defaults to Docker, matching the server's default.
		.option(
			'--sandbox-backend <name>',
			'Backend the instance ran containers on: docker (default) or daytona',
		)
		.option('--daytona-api-key <key>', 'Daytona API key')
		.option('--daytona-api-url <url>', 'Daytona API base URL')
		.parse(argv.slice(3), { from: 'user' });

	const opts = program.opts();
	const { dataDir } = resolveSubcommandTargets(opts);
	// The instance's own backend, so its containers are removed wherever they
	// actually ran — read from the same config file the server was started with.
	const containers = readConfigFile(opts).containers;

	const { existsSync } = await import('node:fs');
	if (!existsSync(dataDir)) {
		console.log(`Nothing to remove: no Hezo data directory at ${dataDir}.`);
		return true;
	}

	// Refuse while a live embedded server is using this data dir — removing it
	// under a running server corrupts the database and leaves containers with
	// dangling mounts. A stale lock from a crash (dead PID) does not block.
	const { readLiveInstanceLock, instanceLockPath } = await import('./db/instance-lock.js');
	const live = readLiveInstanceLock(dataDir);
	if (live) {
		throw new Error(
			`A Hezo server appears to be running against ${dataDir} (PID ${live.pid}). ` +
				`Stop it before uninstalling. If you are certain no server is running, ` +
				`delete ${instanceLockPath(dataDir)} and retry.`,
		);
	}

	// A destructive, irreversible delete requires an explicit opt-in. Without it,
	// show exactly what would go and how to confirm — deleting nothing.
	if (opts.yes !== true) {
		const dataDirArg =
			typeof opts.dataDir === 'string' && opts.dataDir !== DEFAULT_DATA_DIR
				? ` --data-dir ${opts.dataDir}`
				: '';
		console.log(
			`This permanently deletes Hezo's data directory and everything in it:\n` +
				`  ${dataDir}\n` +
				`That includes every project workspace, the embedded database, backups, and ` +
				`settings. The hezo binary itself is not affected.\n\n` +
				`Re-run with --yes to confirm:\n` +
				`  hezo uninstall --yes${dataDirArg}`,
		);
		return true;
	}

	// Best-effort container cleanup before the data dir goes: their ids live in
	// the database we are about to delete, so skipping this orphans them. Never
	// fatal — Docker may already be stopped.
	const removeContainers = deps.removeContainers ?? defaultRemoveProvisionedContainers;
	const backendOpts: SandboxBackendOptions = {
		backend: opts.sandboxBackend ?? containers?.backend,
		daytonaApiKey: opts.daytonaApiKey ?? containers?.daytona?.apiKey,
		daytonaApiUrl: opts.daytonaApiUrl ?? containers?.daytona?.apiUrl,
		dockerSocket: opts.dockerSocket ?? containers?.dockerSocket,
	};
	const managed = (backendOpts.backend ?? 'docker') !== 'docker';
	try {
		const removed = await removeContainers(backendOpts);
		if (removed === null) {
			console.log(
				managed
					? '→ Sandbox provider not reachable; skipping container cleanup. Remove any ' +
							'leftover sandboxes from the provider dashboard - nothing else will, since ' +
							'the sweep that would have lived in this instance is going away with it.'
					: '→ Docker not reachable; skipping container cleanup. Remove any leftovers with: ' +
							'docker rm -f $(docker ps -aq --filter label=hezo.team)',
			);
		} else if (removed > 0) {
			console.log(`→ Removed ${removed} Hezo container(s).`);
		}
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		console.log(
			`→ Could not clean up Hezo containers (${msg}); continuing. Remove any leftovers with: ` +
				'docker rm -f $(docker ps -aq --filter label=hezo.team)',
		);
	}

	// ACL-aware removal: forceRmRecursive strips the macOS Docker Desktop
	// deny-delete ACLs a plain `rm -rf` chokes on, then retries.
	const { forceRmRecursive, getRunSocketDir } = await import('./services/workspace.js');
	forceRmRecursive(dataDir);
	// Per-run ssh/egress sockets live under the OS temp dir, keyed by a hash of
	// the data dir — clean those too so nothing is left behind.
	forceRmRecursive(getRunSocketDir(dataDir));

	console.log(`Removed Hezo data directory: ${dataDir}`);
	return true;
}

/**
 * Central configuration resolution: **CLI flag > config file > built-in default**.
 *
 * The flag wins because it is the more specific, more immediate instruction -
 * you type it to override the file you already wrote. `--config` names the file;
 * without it only defaults and flags apply.
 *
 * Two settings are deliberately unreachable from the file (`schema.ts` rejects
 * them by name): `masterKey`, which must never be written to disk, and `reset`,
 * which would wipe the database on every restart rather than once.
 *
 * This is the only place config values are resolved. Subsystems take their slice
 * from the returned object, or read it back through `runtimeConfig()`.
 */
export function resolveConfig(
	argv: string[] = process.argv,
	env: NodeJS.ProcessEnv = process.env,
): HezoConfig {
	const program = new Command()
		.name('hezo')
		.description('Hezo server — self-hosted AI agent management platform')
		.option('--config <path>', CONFIG_OPTION_DESC)
		.option('--port <port>', `Server port (default ${DEFAULT_CONFIG.port})`)
		.option('--data-dir <path>', `Data directory (default ${DEFAULT_DATA_DIR})`)
		.option(
			'--database-url <url>',
			'External Postgres connection string (postgres://user:password@host:5432/db). Omit to use the embedded database under the data directory.',
		)
		.option(
			'--asset-storage-url <url>',
			'S3-compatible object storage for asset files (s3://ACCESS_KEY:SECRET@endpoint/bucket[/prefix]?region=…&pathStyle=…). Works with AWS S3, MinIO, R2, Spaces, B2, and any other S3-compatible store. Omit to store assets on the local filesystem under the data directory.',
		)
		.option(
			'--sandbox-backend <name>',
			'Where agent containers run: docker (default, the local daemon) or daytona (a managed sandbox service). Selecting a managed backend that cannot be reached is fatal at startup - Hezo never falls back to local Docker.',
		)
		.option(
			'--daytona-api-key <key>',
			'Daytona API key, required when --sandbox-backend is daytona',
		)
		.option(
			'--daytona-api-url <url>',
			'Daytona API base URL, for a regional or self-hosted endpoint. Defaults to the public API.',
		)
		.option(
			'--master-key <phrase>',
			'The 12-word master key phrase for setup/unlock (env: HEZO_MASTER_KEY). Never accepted from the config file - the master key must not be written to disk.',
		)
		.option('--web-url <url>', 'Web UI base URL for redirects')
		.option(
			'--reset',
			'Reset the embedded database and start fresh. A flag only: it renames the existing pgdata aside on the one invocation you pass it, so it is never accepted from the config file.',
		)
		.option('--no-open', 'Do not auto-open the browser on startup')
		.option('--log-level <level>', 'Log level: debug | info | warn | error')
		.option(
			'--keep-old-containers',
			'Skip removal of old containers on rebuild/teardown/provision — useful for inspecting crashed containers via `docker logs` / `docker inspect`. Subsequent rebuilds will fail with a name conflict until the operator removes them manually.',
		)
		.option(
			'--docker-socket <path>',
			"Path to the container runtime's Unix socket. By default Hezo finds it automatically: DOCKER_HOST, then the docker CLI's current context, then the well-known path for each supported runtime (Docker Engine/Desktop, Colima, Rancher Desktop, OrbStack, Lima, rootless Docker). Set this only when the daemon listens somewhere none of those cover. Unix sockets only - tcp:// and npipe:// are not supported.",
		)
		.option(
			'--no-egress-proxy-auth',
			"Disable per-run egress proxy authentication. On by default: each run's HTTP(S)_PROXY URL carries a token the proxy verifies before substituting secrets. Only disable to unblock a runtime whose HTTP client cannot send proxy credentials — the secret red line still holds (an unauthenticated caller only ships unsubstituted placeholders).",
		)
		.option(
			'--egress-allow-private-targets',
			"Allow agent egress through the proxy to reach loopback, link-local and private (RFC1918) addresses. Blocked by default: the proxy runs on the host, so without the guard an agent could tunnel to Hezo's own API, its database, or any host-bound daemon. Enable only when an MCP server or git remote your agents genuinely need lives on the LAN.",
		)
		.option(
			'--auto-install-updates',
			'Install updates automatically: once a newer release is downloaded and verified, gracefully restart onto it without waiting for "Install & restart" in the web UI (in-flight agent runs delay the restart). Only takes effect where in-app auto-update is available — the self-managed binary, not inside a container. The instance comes back unlocked: the in-memory unlock key is handed to the relaunched process over IPC, never written to disk.',
		)
		.option(
			'--disable-telemetry',
			'Disable anonymous daily usage telemetry (aggregate counts only — no names, content, or costs). On by default.',
		)
		.option(
			'--telemetry-endpoint <url>',
			`Override the telemetry collection endpoint (default ${DEFAULT_CONFIG.telemetry.endpoint}).`,
		)
		.parse(argv);

	const cli = program.opts();
	const file = readConfigFile(cli);
	const d = DEFAULT_CONFIG;
	const configPath = typeof cli.config === 'string' && cli.config ? resolve(cli.config) : undefined;

	// Commander cannot tell "flag absent" from "flag equals its default" on a
	// negatable boolean (--no-open stores true when absent, false when passed), so
	// every option asks the parser where its value came from instead of inspecting
	// the value. That one test works for value options and booleans alike.
	const passed = (key: string): boolean => program.getOptionValueSource(key) === 'cli';
	const str = (key: string): string | undefined =>
		passed(key) && typeof cli[key] === 'string' && cli[key].length > 0
			? (cli[key] as string)
			: undefined;
	const bool = (key: string): boolean | undefined => (passed(key) ? cli[key] === true : undefined);
	// --no-x flags: commander stores false on the positive key when passed.
	const negatable = (key: string): boolean | undefined =>
		passed(key) ? cli[key] !== false : undefined;

	const port = ((): number => {
		const raw = str('port');
		if (raw === undefined) return file.port ?? d.port;
		const n = Number.parseInt(raw, 10);
		if (Number.isNaN(n) || n < 1 || n > 65535) {
			throw new Error(`Invalid port: ${raw}. Must be 1-65535.`);
		}
		return n;
	})();

	const logLevel = ((): HezoConfig['logLevel'] => {
		const raw = str('logLevel');
		if (raw === undefined) return file.logLevel ?? d.logLevel;
		const lower = raw.toLowerCase();
		if (lower === 'debug' || lower === 'info' || lower === 'warn' || lower === 'error') {
			return lower;
		}
		throw new Error(`Invalid log level: ${raw}. Must be debug | info | warn | error.`);
	})();

	const databaseUrl = str('databaseUrl') ?? file.database?.url;
	const reset = bool('reset') ?? false;
	if (databaseUrl && reset) {
		throw new Error(
			'--reset applies to the embedded database only (it renames a corrupt pgdata aside). ' +
				'For an external database, drop and recreate it with your provider tools instead.',
		);
	}

	const masterKeyRaw = ((): string | undefined => {
		// The one setting the config file may not carry, so the env var stays the
		// way to unlock a single non-interactive startup: a flag would put a
		// twelve-word key in the process list.
		const e = env.HEZO_MASTER_KEY;
		if (e !== undefined && e !== '') return e;
		return str('masterKey');
	})();

	const config: HezoConfig = {
		port,
		dataDir: resolveDataDir(str('dataDir') ?? file.dataDir ?? DEFAULT_DATA_DIR),
		webUrl: str('webUrl') ?? file.webUrl ?? d.webUrl,
		logLevel,
		open: negatable('open') ?? file.open ?? d.open,

		database: {
			url: databaseUrl,
			poolSize: file.database?.poolSize ?? d.database.poolSize,
		},
		assetStorage: { url: str('assetStorageUrl') ?? file.assetStorage?.url },
		containers: {
			backend: str('sandboxBackend') ?? file.containers?.backend,
			dockerSocket: str('dockerSocket') ?? file.containers?.dockerSocket,
			dockerRequestTimeoutMs:
				file.containers?.dockerRequestTimeoutMs ?? d.containers.dockerRequestTimeoutMs,
			keepOld: bool('keepOldContainers') ?? file.containers?.keepOld ?? d.containers.keepOld,
			skipMountCheck: file.containers?.skipMountCheck ?? d.containers.skipMountCheck,
			agentBaseImage: file.containers?.agentBaseImage,
			daytona: {
				apiKey: str('daytonaApiKey') ?? file.containers?.daytona?.apiKey,
				apiUrl:
					str('daytonaApiUrl') ?? file.containers?.daytona?.apiUrl ?? d.containers.daytona.apiUrl,
			},
		},
		egress: {
			proxyAuth: negatable('egressProxyAuth') ?? file.egress?.proxyAuth ?? d.egress.proxyAuth,
			allowPrivateTargets:
				bool('egressAllowPrivateTargets') ??
				file.egress?.allowPrivateTargets ??
				d.egress.allowPrivateTargets,
			debug: file.egress?.debug ?? d.egress.debug,
		},
		telemetry: {
			// The only CLI half is the positive `--disable-telemetry`, so a passed
			// flag means off and everything else defers to the file, then the default.
			enabled:
				(passed('disableTelemetry') ? false : undefined) ??
				file.telemetry?.enabled ??
				d.telemetry.enabled,
			endpoint: str('telemetryEndpoint') ?? file.telemetry?.endpoint ?? d.telemetry.endpoint,
		},
		updates: {
			disabled: file.updates?.disabled ?? d.updates.disabled,
			autoInstall: bool('autoInstallUpdates') ?? file.updates?.autoInstall ?? d.updates.autoInstall,
		},
		marketplace: {
			ref: file.marketplace?.ref ?? d.marketplace.ref,
			baseUrl: file.marketplace?.baseUrl ?? d.marketplace.baseUrl,
		},
		github: { oauthClientId: file.github?.oauthClientId ?? d.github.oauthClientId },
		jobs: { ...d.jobs, ...file.jobs },
		logCompaction: { ...d.logCompaction, ...file.logCompaction },

		// An inline block and a standalone file are the same shape; the file wins,
		// because it is the one a deployment can rewrite without restarting.
		// Loading it here rather than at first read keeps a malformed file a
		// startup failure, which is when an operator can still see it.
		policyFile: file.policyFile ? resolve(file.policyFile) : undefined,
		policy:
			loadPolicy(file.policyFile ? resolve(file.policyFile) : undefined) ?? file.policy ?? null,

		reset,
		masterKey: masterKeyRaw ? parseMasterKey(masterKeyRaw) : undefined,
		configPath,
	};

	// Configuration env vars are no longer read. Refuse to start when an ignored
	// one would have put the data somewhere other than where we are about to look:
	// coming up on an empty database looks like a fresh install, not a fault.
	assertNoRemovedDataLocationEnv(env, config);
	return config;
}

/**
 * Throw when a removed env var still selects where the data lives. Shared by the
 * server and the backup/restore/uninstall subcommands, each of which would
 * otherwise silently target a different tree than the operator configured.
 */
function assertNoRemovedDataLocationEnv(
	env: NodeJS.ProcessEnv,
	location: ResolvedDataLocation,
): void {
	const { fatal } = detectRemovedEnvVars(env, location);
	if (fatal.length > 0) throw new Error(formatRemovedEnvFatal(fatal));
}
