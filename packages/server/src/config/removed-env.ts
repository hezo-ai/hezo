/**
 * The configuration environment variables 0.50 stopped reading, and the check
 * that refuses to let one be ignored in silence.
 *
 * Before 0.50 every setting here was an env var. They are now config-file keys
 * and flags, resolved by `resolveConfig`. An instance whose supervisor still
 * exports the old names got no error and no warning: it fell back to the
 * built-in defaults, which for `HEZO_DATA_DIR` means opening an empty database
 * under `~/.hezo` and presenting the master-key setup page as if the instance
 * were brand new.
 *
 * So the three variables that select *where the data lives* are fatal, and
 * everything else warns. A fatal one is only raised when the value it carried
 * differs from what the resolved config actually uses, so an operator who has
 * migrated but left `EnvironmentFile=` in place is not blocked.
 *
 * This table names only variables that are genuinely no longer read. The env
 * vars that survive - `HEZO_MASTER_KEY`, `HEZO_WORKER`, `HEZO_SKIP_DOCKER`, the
 * `HEZO_TEST_*` seams, the run plumbing injected into agent containers - must
 * never appear here, which is why it is an explicit list and not a `HEZO_*`
 * prefix scan.
 */

import { redactAssetStorageUrl } from '../lib/asset-storage-info';
import { redactDatabaseUrl } from '../lib/db-info';
import { resolveDataDir } from './types';

/**
 * The part of the resolved configuration this check reads. Narrower than
 * `HezoConfig` (which satisfies it structurally) so the backup, restore and
 * uninstall subcommands, which resolve only these three, can run the same check.
 */
export interface ResolvedDataLocation {
	dataDir: string;
	database: { url?: string };
	assetStorage: { url?: string };
}

/** Where to read about the migration when a variable is reported. */
export const CONFIG_DOCS_URL = 'https://hezo.ai/docs/deployment/configuration';

export interface RemovedEnvVar {
	/** How this setting is configured now: the config-file key, and the flag if it has one. */
	replacement: string;
	/**
	 * `fatal` for the variables that select where data lives - ignoring one of
	 * those silently points the instance at a different (usually empty) database.
	 * Everything else is `warn`: the setting reverts to its default, which is
	 * visible in behaviour rather than catastrophic.
	 */
	severity: 'fatal' | 'warn';
	/**
	 * `fatal` only: what the resolved config uses for this setting, so the check
	 * can stay quiet when the ignored variable agrees with it.
	 */
	inEffect?: (config: ResolvedDataLocation) => string | undefined;
	/** Canonicalise both sides before comparing them. */
	normalise?: (value: string) => string;
	/**
	 * Redact the value before it reaches a log line. Set for anything that can
	 * carry credentials; `undefined` means the raw value is safe to print, which
	 * is what makes the `HEZO_DATA_DIR` message useful.
	 */
	redact?: (value: string) => string;
}

const JOB_CRONS: Record<string, string> = {
	HEZO_WAKEUP_CRON: 'jobs.wakeupCron',
	HEZO_HEARTBEAT_CRON: 'jobs.heartbeatCron',
	HEZO_INBOX_ARCHIVE_CRON: 'jobs.inboxArchiveCron',
	HEZO_PRICING_REFRESH_CRON: 'jobs.pricingRefreshCron',
	HEZO_MODEL_PIN_REFRESH_CRON: 'jobs.modelPinRefreshCron',
	HEZO_UPDATE_CHECK_CRON: 'jobs.updateCheckCron',
	HEZO_AUTO_INSTALL_CRON: 'jobs.autoInstallCron',
	HEZO_TELEMETRY_CRON: 'jobs.telemetryCron',
	HEZO_BUDGET_RESUME_CRON: 'jobs.budgetResumeCron',
	HEZO_CONNECTOR_HEALTH_CRON: 'jobs.connectorHealthCron',
	HEZO_CONTAINER_SYNC_CRON: 'jobs.containerSyncCron',
	HEZO_CONTAINER_IDLE_STOP_CRON: 'jobs.containerIdleStopCron',
	HEZO_ORPHAN_DETECTION_CRON: 'jobs.orphanDetectionCron',
	HEZO_ORPHAN_CONTAINER_SWEEP_CRON: 'jobs.orphanContainerSweepCron',
	HEZO_DB_MAINTENANCE_CRON: 'jobs.dbMaintenanceCron',
	HEZO_WAKEUP_COALESCING_MS: 'jobs.wakeupCoalescingMs',
	HEZO_HEARTBEAT_COOLDOWN_SEC: 'jobs.heartbeatCooldownSec',
	HEZO_HEARTBEAT_FLOOR_MIN: 'jobs.heartbeatFloorMin',
	HEZO_INBOX_RETENTION_DAYS: 'jobs.inboxRetentionDays',
	HEZO_LOG_COMPACTION_CRON: 'logCompaction.cron',
	HEZO_LOG_COMPACTION_BATCH: 'logCompaction.batch',
	HEZO_LOG_COMPACTION_MAX_PER_TICK: 'logCompaction.maxPerTick',
	HEZO_LOG_COMPACTION_PRESERVED_BYTES: 'logCompaction.preservedBytes',
	HEZO_CHAT_HEALTH_INTERVAL_MS: 'chat.healthIntervalMs',
};

const warnOnly = (replacement: string, redact?: (value: string) => string): RemovedEnvVar => ({
	replacement,
	severity: 'warn',
	redact,
});

export const REMOVED_ENV_VARS: Record<string, RemovedEnvVar> = {
	// Fatal: each one moves where the instance's data lives.
	HEZO_DATA_DIR: {
		replacement: 'the `dataDir` config-file key, or --data-dir',
		severity: 'fatal',
		inEffect: (c) => c.dataDir,
		normalise: resolveDataDir,
	},
	HEZO_DATABASE_URL: {
		replacement: 'the `database.url` config-file key, or --database-url',
		severity: 'fatal',
		inEffect: (c) => c.database.url,
		normalise: (v) => v.trim(),
		redact: redactDatabaseUrl,
	},
	HEZO_ASSET_STORAGE_URL: {
		replacement: 'the `assetStorage.url` config-file key, or --asset-storage-url',
		severity: 'fatal',
		inEffect: (c) => c.assetStorage.url,
		normalise: (v) => v.trim(),
		redact: redactAssetStorageUrl,
	},

	HEZO_PORT: warnOnly('the `port` config-file key, or --port'),
	HEZO_WEB_URL: warnOnly('the `webUrl` config-file key, or --web-url'),
	HEZO_LOG_LEVEL: warnOnly('the `logLevel` config-file key, or --log-level'),
	HEZO_OPEN: warnOnly('the `open` config-file key, or --no-open'),
	HEZO_RESET: warnOnly('--reset (never a config-file key: it would wipe the database on restart)'),
	HEZO_DATABASE_POOL_SIZE: warnOnly('the `database.poolSize` config-file key'),

	HEZO_SANDBOX_BACKEND: warnOnly('the `containers.backend` config-file key, or --sandbox-backend'),
	HEZO_DOCKER_SOCKET: warnOnly('the `containers.dockerSocket` config-file key, or --docker-socket'),
	DOCKER_REQUEST_TIMEOUT_MS: warnOnly('the `containers.dockerRequestTimeoutMs` config-file key'),
	HEZO_KEEP_OLD_CONTAINERS: warnOnly(
		'the `containers.keepOld` config-file key, or --keep-old-containers',
	),
	HEZO_SKIP_MOUNT_CHECK: warnOnly('the `containers.skipMountCheck` config-file key'),
	HEZO_AGENT_BASE_IMAGE: warnOnly('the `containers.agentBaseImage` config-file key'),
	HEZO_DAYTONA_API_KEY: warnOnly(
		'the `containers.daytona.apiKey` config-file key, or --daytona-api-key',
		() => '(redacted)',
	),
	HEZO_DAYTONA_API_URL: warnOnly(
		'the `containers.daytona.apiUrl` config-file key, or --daytona-api-url',
	),

	HEZO_EGRESS_PROXY_AUTH: warnOnly(
		'the `egress.proxyAuth` config-file key, or --no-egress-proxy-auth',
	),
	HEZO_EGRESS_ALLOW_PRIVATE_TARGETS: warnOnly(
		'the `egress.allowPrivateTargets` config-file key, or --egress-allow-private-targets',
	),
	HEZO_EGRESS_DEBUG: warnOnly('the `egress.debug` config-file key'),

	HEZO_TELEMETRY_ENABLED: warnOnly(
		'the `telemetry.enabled` config-file key, or --disable-telemetry',
	),
	HEZO_TELEMETRY_ENDPOINT: warnOnly(
		'the `telemetry.endpoint` config-file key, or --telemetry-endpoint',
	),
	HEZO_DISABLE_AUTO_UPDATE: warnOnly('the `updates.disabled` config-file key'),
	HEZO_AUTO_INSTALL_UPDATES: warnOnly(
		'the `updates.autoInstall` config-file key, or --auto-install-updates',
	),

	HEZO_MARKETPLACE_REF: warnOnly('the `marketplace.ref` config-file key'),
	HEZO_MARKETPLACE_BASE_URL: warnOnly('the `marketplace.baseUrl` config-file key'),
	GITHUB_OAUTH_CLIENT_ID: warnOnly('the `github.oauthClientId` config-file key'),

	...Object.fromEntries(
		Object.entries(JOB_CRONS).map(([name, key]) => [
			name,
			warnOnly(`the \`${key}\` config-file key`),
		]),
	),
};

export interface RemovedEnvFinding {
	/** The variable name, always safe to print. */
	name: string;
	/** Its value, already redacted where the variable can carry credentials. */
	value: string;
	replacement: string;
	/** `fatal` only: what the resolved config uses instead, redacted the same way. */
	inEffect?: string;
}

export interface RemovedEnvReport {
	fatal: RemovedEnvFinding[];
	warnings: RemovedEnvFinding[];
}

/**
 * Which removed variables this process was started with. `config` is the fully
 * resolved configuration, so a fatal variable that agrees with the value
 * actually in effect is not reported at all.
 */
export function detectRemovedEnvVars(
	env: Record<string, string | undefined>,
	config: ResolvedDataLocation,
): RemovedEnvReport {
	const report: RemovedEnvReport = { fatal: [], warnings: [] };
	// Sorted so a multi-variable message reads the same on every host.
	for (const name of Object.keys(REMOVED_ENV_VARS).sort()) {
		const raw = env[name];
		if (raw === undefined || raw === '') continue;
		const spec = REMOVED_ENV_VARS[name];
		const show = (value: string): string => spec.redact?.(value) ?? value;

		if (spec.severity === 'warn' || !spec.inEffect) {
			report.warnings.push({ name, value: show(raw), replacement: spec.replacement });
			continue;
		}

		const canonical = spec.normalise ?? ((v: string) => v);
		const resolved = spec.inEffect(config);
		// Agreeing values mean the operator has migrated and merely left the old
		// export in place. Nothing is being ignored in a way that matters.
		if (resolved !== undefined && canonical(resolved) === canonical(raw)) continue;

		report.fatal.push({
			name,
			value: show(raw),
			replacement: spec.replacement,
			inEffect: resolved === undefined ? undefined : show(resolved),
		});
	}
	return report;
}

/**
 * The message `resolveConfig` throws with. `index.ts` prints it verbatim and
 * exits 1, so it has to be the whole diagnosis: what was ignored, what is in
 * effect instead, and the two ways to fix it.
 */
export function formatRemovedEnvFatal(findings: RemovedEnvFinding[]): string {
	const lines = [
		findings.length === 1
			? `${findings[0].name} is set, but Hezo no longer reads it.`
			: `${findings.length} environment variables are set that Hezo no longer reads.`,
		'',
		'Each one selected where this instance keeps its data, so starting anyway would',
		'open a different (most likely empty) database and show the master-key setup page',
		'as if this were a brand-new instance. Nothing has been changed or deleted.',
		'',
	];
	for (const f of findings) {
		lines.push(`  ${f.name}=${f.value}`);
		lines.push(`    in effect instead: ${f.inEffect ?? '(the built-in default)'}`);
		lines.push(`    configure it with: ${f.replacement}`);
	}
	lines.push(
		'',
		'Move each one into a config file and pass --config, or pass the matching flag.',
		'A systemd unit upgraded from 0.49 or earlier needs both: the config file, and',
		'--config on its ExecStart line in place of EnvironmentFile=.',
		'',
		`Configuration reference: ${CONFIG_DOCS_URL}`,
	);
	return lines.join('\n');
}

/** The one-line-per-variable warning for the settings that merely reverted to their default. */
export function formatRemovedEnvWarning(findings: RemovedEnvFinding[]): string {
	const lines = [
		`Ignoring ${findings.length} environment variable${findings.length === 1 ? '' : 's'} Hezo no longer reads. ` +
			`${findings.length === 1 ? 'This setting is' : 'These settings are'} on the built-in default until moved into a config file:`,
	];
	for (const f of findings) lines.push(`  ${f.name} -> ${f.replacement}`);
	lines.push(`See ${CONFIG_DOCS_URL}`);
	return lines.join('\n');
}
