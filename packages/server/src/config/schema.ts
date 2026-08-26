import { z } from 'zod';
import type { HezoConfig } from './types';

/**
 * The config file's accepted shape: a deep-`Partial` of {@link HezoConfig},
 * minus the two keys that must never live in a file (see `REJECTED_KEYS`).
 *
 * Every object is `.strict()`, so an unknown or misspelled key is a hard error
 * naming the key. A silently-ignored `dataDIr` is the specific failure mode a
 * config file introduces over flags, and rejecting it costs nothing.
 */

const cron = z.string().trim().min(1).describe('a seconds-precision six-field cron expression');

const positiveInt = z.int().positive();

const databaseSchema = z
	.object({
		url: z.string().min(1).optional(),
		// Matches parsePoolSize in db/open.ts - a pool below 2 deadlocks the
		// migration path, and above 100 exhausts most managed Postgres plans.
		poolSize: z.int().min(2).max(100).optional(),
	})
	.strict();

const assetStorageSchema = z.object({ url: z.string().min(1).optional() }).strict();

const daytonaSchema = z
	.object({ apiKey: z.string().min(1).optional(), apiUrl: z.url().optional() })
	.strict();

const containersSchema = z
	.object({
		backend: z.string().min(1).optional(),
		dockerSocket: z.string().min(1).optional(),
		dockerRequestTimeoutMs: positiveInt.optional(),
		keepOld: z.boolean().optional(),
		skipMountCheck: z.boolean().optional(),
		agentBaseImage: z.string().min(1).optional(),
		daytona: daytonaSchema.optional(),
	})
	.strict();

const egressSchema = z
	.object({
		proxyAuth: z.boolean().optional(),
		allowPrivateTargets: z.boolean().optional(),
		debug: z.boolean().optional(),
	})
	.strict();

const telemetrySchema = z
	.object({ enabled: z.boolean().optional(), endpoint: z.url().optional() })
	.strict();

const updatesSchema = z
	.object({ disabled: z.boolean().optional(), autoInstall: z.boolean().optional() })
	.strict();

const marketplaceSchema = z
	.object({ ref: z.string().min(1).optional(), baseUrl: z.url().optional() })
	.strict();

const githubSchema = z.object({ oauthClientId: z.string().min(1).optional() }).strict();

const jobsSchema = z
	.object({
		wakeupCron: cron.optional(),
		heartbeatCron: cron.optional(),
		inboxArchiveCron: cron.optional(),
		pricingRefreshCron: cron.optional(),
		modelPinRefreshCron: cron.optional(),
		updateCheckCron: cron.optional(),
		autoInstallCron: cron.optional(),
		telemetryCron: cron.optional(),
		budgetResumeCron: cron.optional(),
		connectorHealthCron: cron.optional(),
		containerSyncCron: cron.optional(),
		containerIdleStopCron: cron.optional(),
		orphanDetectionCron: cron.optional(),
		orphanContainerSweepCron: cron.optional(),
		dbMaintenanceCron: cron.optional(),
		wakeupCoalescingMs: positiveInt.optional(),
		heartbeatCooldownSec: z.int().min(0).optional(),
		heartbeatFloorMin: positiveInt.optional(),
		inboxRetentionDays: positiveInt.optional(),
	})
	.strict();

const logCompactionSchema = z
	.object({
		cron: cron.optional(),
		batch: positiveInt.optional(),
		maxPerTick: positiveInt.optional(),
		preservedBytes: positiveInt.optional(),
	})
	.strict();

/**
 * The pinned-settings block. Also the shape of the standalone policy file, which
 * is why it is exported: one schema for both, so a file the deployer writes and
 * a block they inline are validated identically.
 *
 * `manageUrl` must be `https:`. Rejected at parse rather than at render because
 * it is operator-authored - a typo should be loud at startup, not a dead link
 * discovered by whoever clicks it. The renderer checks again anyway: React does
 * not reliably block a `javascript:` href.
 */
export const policySchema = z
	.object({
		managedBy: z.string().trim().min(1),
		manageUrl: z
			.url()
			.refine((value) => value.startsWith('https://'), {
				message: 'manageUrl must be an https: URL',
			})
			.optional(),
		pinned: z
			.object({
				maxContainerMemoryGb: positiveInt.optional(),
				defaultRamCapPerContainerGb: positiveInt.optional(),
				defaultContainerDiskGb: positiveInt.optional(),
				// Zero is meaningful here and everywhere else a budget is: unlimited.
				// A deployment can therefore pin "no hours limit" as deliberately as
				// it pins a number.
				monthlyContainerHours: z.int().min(0).optional(),
			})
			.strict(),
	})
	.strict();

export const configFileSchema = z
	.object({
		port: z.int().min(1).max(65535).optional(),
		dataDir: z.string().min(1).optional(),
		webUrl: z.string().optional(),
		logLevel: z.enum(['debug', 'info', 'warn', 'error']).optional(),
		open: z.boolean().optional(),

		database: databaseSchema.optional(),
		assetStorage: assetStorageSchema.optional(),
		containers: containersSchema.optional(),
		egress: egressSchema.optional(),
		telemetry: telemetrySchema.optional(),
		updates: updatesSchema.optional(),
		marketplace: marketplaceSchema.optional(),
		github: githubSchema.optional(),
		jobs: jobsSchema.optional(),
		logCompaction: logCompactionSchema.optional(),
		policy: policySchema.optional(),
		policyFile: z.string().min(1).optional(),
	})
	.strict();

/** What the config file may set: everything in {@link HezoConfig} bar the rejected keys. */
export type ConfigFile = z.infer<typeof configFileSchema>;

/**
 * Keys that are structurally valid but must never appear in a config file, each
 * with the reason an operator needs to hear. `.strict()` would already reject
 * them as unknown, but "Unrecognized key: masterKey" invites the reader to
 * conclude they spelled it wrong and go looking for the right spelling.
 */
const REJECTED_KEYS: Record<string, string> = {
	masterKey:
		'the master key must never be written to disk. Hezo keeps it in memory only, so a copy ' +
		'of your disk cannot decrypt your data. Unlock from the browser gate, or pass it to a ' +
		'single startup with HEZO_MASTER_KEY or --master-key.',
	reset:
		'"reset" wipes the embedded database, so a config file carrying it would wipe on every ' +
		'restart. Pass --reset on the one invocation that should start fresh.',
	// A removed mechanism, not a typo: without this entry the strict parse says
	// "Unrecognized key: chat" and the operator goes hunting for a spelling.
	chat:
		'the pinned chat container and its health check were removed - chat replies now borrow ' +
		'a task container per reply, so there is nothing to configure. Delete the "chat" block.',
};

/** A config-file validation failure, already formatted for an operator to read. */
export class ConfigFileError extends Error {}

function formatIssues(path: string, issues: z.core.$ZodIssue[]): string {
	const lines = issues.map((issue) => {
		const where = issue.path.length > 0 ? issue.path.join('.') : '(root)';
		return `  ${where}: ${issue.message}`;
	});
	return `${path} is not a valid Hezo config file:\n${lines.join('\n')}`;
}

/**
 * Validate the object a config file exported. Throws {@link ConfigFileError}
 * with every problem listed, rather than the first one.
 */
export function validateConfigFile(path: string, exported: unknown): ConfigFile {
	if (exported === null || typeof exported !== 'object' || Array.isArray(exported)) {
		throw new ConfigFileError(
			`${path} must export a configuration object, e.g. "module.exports = { port: 3100 }" ` +
				`(got ${Array.isArray(exported) ? 'an array' : typeof exported}).`,
		);
	}

	for (const [key, reason] of Object.entries(REJECTED_KEYS)) {
		if (key in exported) throw new ConfigFileError(`${path} sets "${key}", but ${reason}`);
	}

	const parsed = configFileSchema.safeParse(exported);
	if (!parsed.success) throw new ConfigFileError(formatIssues(path, parsed.error.issues));
	return parsed.data;
}
