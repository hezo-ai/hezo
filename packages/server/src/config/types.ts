import { homedir } from 'node:os';
import { resolve } from 'node:path';
import type { SandboxBackend } from '@hezo/shared';
import {
	CONNECTOR_CAPABILITIES,
	DEFAULT_DATA_DIR,
	DEFAULT_PORT,
	HEARTBEAT_INTERVAL_FLOOR_MIN_DEFAULT,
	LOG_COMPACTION_PRESERVED_TAIL_BYTES,
} from '@hezo/shared';

export type LogLevelName = 'debug' | 'info' | 'warn' | 'error';

/**
 * Where daily telemetry reports are posted unless the config file overrides it.
 * Defined here rather than in `services/telemetry.ts` so `DEFAULT_CONFIG` stays
 * free of service imports - every service reaches config through
 * `runtimeConfig()`, and a service import here would close that loop.
 * `services/telemetry.ts` re-exports it under its historical name.
 */
export const DEFAULT_TELEMETRY_ENDPOINT = 'https://hezo.ai/api/telemetry';

/** Daytona's public control plane. Re-exported by `sandbox/daytona/client.ts`; see above. */
export const DEFAULT_DAYTONA_API_URL = 'https://app.daytona.io/api';

/**
 * The public GitHub OAuth app Hezo ships with. An instance that registers its
 * own app points `github.oauthClientId` at it; everyone else uses this. Read
 * from the connector registry so the id has one home.
 */
export const DEFAULT_GITHUB_OAUTH_CLIENT_ID =
	CONNECTOR_CAPABILITIES.github.deviceAuth?.clientIdDefault ?? '';

/** External Postgres connection pool. */
export interface DatabaseConfig {
	/**
	 * External Postgres connection string. Unset -> the embedded PGlite database
	 * under `<dataDir>/pgdata`. The raw value carries credentials: it must never
	 * be logged or exposed un-redacted (see `redactDatabaseUrl` in
	 * `lib/db-info.ts`) and never passed into `buildApp`.
	 */
	url?: string;
	/** Pool size for an external database (1-100). Ignored for the embedded one. */
	poolSize: number;
}

export interface AssetStorageConfig {
	/**
	 * S3-compatible asset storage URL. Unset -> asset blobs on the local
	 * filesystem under `<dataDir>/assets`. Carries credentials; redact with
	 * `redactAssetStorageUrl` in `lib/asset-storage-info.ts`.
	 */
	url?: string;
}

export interface DaytonaConfig {
	/**
	 * Daytona API key, required when `containers.backend` is `daytona`. Used only
	 * by trusted server code to reach the provider control plane - it is never
	 * placed in an agent container, and never logged.
	 */
	apiKey?: string;
	/** Daytona API base URL, for a regional or self-hosted endpoint. */
	apiUrl: string;
}

export interface ContainersConfig {
	/**
	 * Where agent containers run: `docker` (the local daemon) or a managed sandbox
	 * service. Selecting a managed backend Hezo cannot reach is **fatal at
	 * startup** - it never falls back to local Docker, because an instance that
	 * silently degraded would look healthy while running somewhere the operator
	 * did not choose. Seeds a new instance only; once set in Settings -> Containers
	 * the stored choice wins.
	 */
	backend?: string;
	/**
	 * Explicit path to the container runtime's Unix socket. Unset by default, in
	 * which case the startup preflight discovers it: `DOCKER_HOST`, then the docker
	 * CLI's current context, then the well-known path for each supported runtime
	 * (Docker Engine/Desktop, Colima, Rancher Desktop, OrbStack, Lima, rootless
	 * Docker). Set it only when the daemon listens somewhere none of those cover.
	 */
	dockerSocket?: string;
	/** Ceiling on a single docker daemon call, so a wedged one cannot stall the sync loop. */
	dockerRequestTimeoutMs: number;
	/**
	 * Skip removal of old containers on rebuild/teardown/provision - useful for
	 * inspecting crashed containers. Subsequent rebuilds fail with a name conflict
	 * until the operator removes them manually.
	 */
	keepOld: boolean;
	/**
	 * Skip the boot check that verifies agent containers get a writable view of the
	 * data directory. The check is a diagnosis, not a dependency - skipping it hides
	 * the warning, it does not make a read-only mount work.
	 */
	skipMountCheck: boolean;
	/**
	 * Container image every project's agents run in, overriding the default for this
	 * instance. Must be a reference the backend in use can pull. Mainly for running a
	 * development server against a managed sandbox service, where the default is built
	 * into the local Docker daemon and a managed service has nothing to pull. A project
	 * that names its own base image keeps it.
	 */
	agentBaseImage?: string;
	daytona: DaytonaConfig;
}

export interface EgressConfig {
	/**
	 * Require a per-run token on every request to the egress proxy. On by default:
	 * each run's `HTTP(S)_PROXY` URL carries a random token that the proxy checks
	 * (constant-time) before substituting any secret, so a co-resident process that
	 * reaches the proxy address can't drive substitution for another run. Disable
	 * only to unblock a runtime whose HTTP client can't carry proxy credentials -
	 * the secret red line still holds either way (an unauthenticated caller only
	 * ships unsubstituted placeholders).
	 */
	proxyAuth: boolean;
	/**
	 * Permit proxied agent egress to loopback / link-local / private addresses. Off
	 * by default: the egress proxy runs in the host's network namespace, so without
	 * the guard an agent could tunnel to Hezo's own API, its database, or any
	 * host-bound daemon. Enable only when an MCP server or git remote the agents
	 * legitimately need lives on the LAN.
	 */
	allowPrivateTargets: boolean;
	/** Per-connection proxy lifecycle tracing. Diagnostic only; very noisy. */
	debug: boolean;
}

export interface TelemetryConfig {
	/**
	 * Anonymous daily usage telemetry. On by default (opt-out): once a day the
	 * server POSTs aggregate counts (projects, tasks, tokens, AI-provider mix,
	 * version) - no names, content, or costs - to `endpoint`, keyed by a random
	 * per-install id.
	 */
	enabled: boolean;
	endpoint: string;
}

export interface UpdatesConfig {
	/**
	 * Disable the in-app auto-update entirely: the release check, the background
	 * download, and the "Install & restart" banner. When disabled the banner instead
	 * links to the GitHub release page.
	 */
	disabled: boolean;
	/**
	 * Install staged updates automatically. Once a newer release is downloaded and
	 * verified, the server gracefully restarts onto it by itself instead of waiting
	 * for a superuser's "Install & restart" - deferring while agent runs are in
	 * flight. Only effective where the in-app update flow is available at all (the
	 * self-managed compiled binary, not inside a container).
	 */
	autoInstall: boolean;
}

export interface MarketplaceConfig {
	/** Git ref the team marketplace is fetched from. */
	ref: string;
	/** Base URL the marketplace is fetched from, for a fork or a mirror. */
	baseUrl: string;
}

export interface GithubConfig {
	/**
	 * OAuth app client id used for the GitHub connector's device flow. Defaults to
	 * the public app Hezo ships with; point it at your own OAuth app to keep the
	 * authorization under your organization's control.
	 */
	oauthClientId: string;
}

/**
 * Background job cadences and the tuning that goes with them. Crons are
 * seconds-precision six-field expressions.
 */
export interface JobsConfig {
	wakeupCron: string;
	heartbeatCron: string;
	inboxArchiveCron: string;
	pricingRefreshCron: string;
	modelPinRefreshCron: string;
	updateCheckCron: string;
	autoInstallCron: string;
	telemetryCron: string;
	budgetResumeCron: string;
	connectorHealthCron: string;
	containerSyncCron: string;
	containerIdleStopCron: string;
	orphanDetectionCron: string;
	orphanContainerSweepCron: string;
	dbMaintenanceCron: string;
	/** Window in which repeated wakeups for one agent collapse into a single run. */
	wakeupCoalescingMs: number;
	/** Quiet window after a run before the agent becomes heartbeat-eligible again. */
	heartbeatCooldownSec: number;
	/**
	 * Lowest heartbeat cadence the scheduler honours, in minutes. Raising it above
	 * the default clamps every agent up to it.
	 */
	heartbeatFloorMin: number;
	/** How long archived inbox items are kept, in days. */
	inboxRetentionDays: number;
}

export interface LogCompactionConfig {
	cron: string;
	/** Runs compacted per batch. */
	batch: number;
	/** Runs compacted per cron tick, bounding an unindexed scan that runs often. */
	maxPerTick: number;
	/**
	 * Bytes of each old run's log kept when it is compacted - the trailing slice
	 * holding the agent's end-of-run summary and its `[done] … tokens=… cost=…` line.
	 */
	preservedBytes: number;
}

export interface ChatConfig {
	/** Cadence of the live-chat container health check. */
	healthIntervalMs: number;
}

/**
 * The fully resolved configuration: built-in defaults, overlaid with the
 * `--config` file, overlaid with the CLI flags actually passed.
 *
 * The config file's accepted shape is a deep-`Partial` of this type minus
 * `masterKey` and `reset` (see `schema.ts`), so the file, the type and the docs
 * cannot drift apart.
 */
/**
 * Settings fixed by whoever deployed this instance, and who to ask about them.
 *
 * **Core never learns any deployment's name.** What it learns is that a setting
 * was decided by the operator who runs this instance rather than by the person
 * using it, who that operator is, and where to go to change it. A managed
 * service fills this in; so does an IT department that fixes limits for a team.
 * Nothing in the server branches on `managedBy` - it is rendered, never read.
 *
 * **Per-key optional, deliberately.** A single `managed: true` boolean could not
 * express pinning memory while leaving disk to the operator, which is the normal
 * case: a deployment fixes what it bills for and leaves the rest alone.
 */
export interface PolicyConfig {
	/** Who fixed these settings, as shown to the operator. Rendered, never branched on. */
	managedBy: string;
	/**
	 * Where to change them. Absent means "locked, with no link" - which is the
	 * honest rendering for a deployment with no self-service surface.
	 *
	 * Stored as an opaque string so whether it is generic or instance-scoped stays
	 * the deployer's decision. Validated as `https:` at parse (`config/schema.ts`)
	 * and again at the render end, because React does not reliably block a
	 * `javascript:` href.
	 */
	manageUrl?: string;
	/**
	 * The settings this deployment fixes. A key present here wins over whatever
	 * `system_meta` holds, and `PATCH` of it is refused rather than silently
	 * ignored - on a managed deployment the person using the instance is still its
	 * superuser and can call the API directly.
	 */
	pinned: {
		maxContainerMemoryGb?: number;
		defaultRamCapPerContainerGb?: number;
		defaultContainerDiskGb?: number;
		monthlyContainerHours?: number;
		/** Which container backend runs agent containers. A name, not a number. */
		backend?: SandboxBackend;
	};
}

/**
 * Single sign-on from an external control plane.
 *
 * The issuer proves *who* is signing in. It never proves, carries or obtains
 * the unlock key: an instance that accepts a valid token is still locked, and
 * still asks for the passphrase. Null when no issuer is configured, which
 * leaves the whole mechanism inert.
 */
export interface SsoConfig {
	/** The control plane a user is sent back to, and shown on the gate. */
	issuerUrl: string;
	/**
	 * Accepted issuer keys as a `kid:hex` list. A list rather than one key so an
	 * issuer can rotate without a flag day: publish both, move minting to the new
	 * one, then drop the old.
	 */
	issuerPublicKey: string;
	/**
	 * Where signing out goes. Ending the instance's session is not enough: the
	 * issuer still has one, and would sign the person straight back in.
	 *
	 * Signing out ends a session. It does not re-lock the instance. A new process
	 * starts locked by default, though a supervised update may restore the key
	 * through its in-memory IPC handoff and deliberate one-shot `--master-key` or
	 * `HEZO_MASTER_KEY` input may inject it at startup.
	 */
	logoutUrl: string;
	/** The one issuer-side account allowed in. Hosted is one account per instance. */
	ownerSubject: string;
	/** What a token's `aud` must equal, configured rather than read off the request. */
	audience: string;
}

export interface HezoConfig {
	port: number;
	dataDir: string;
	/** Public base URL, used so account sign-ins redirect back correctly. Empty -> same origin. */
	webUrl: string;
	logLevel: LogLevelName;
	/**
	 * Auto-open the web app in a browser at startup. Headless detection at startup
	 * decides whether a browser actually launches.
	 */
	open: boolean;

	database: DatabaseConfig;
	assetStorage: AssetStorageConfig;
	containers: ContainersConfig;
	egress: EgressConfig;
	telemetry: TelemetryConfig;
	updates: UpdatesConfig;
	marketplace: MarketplaceConfig;
	github: GithubConfig;
	jobs: JobsConfig;
	logCompaction: LogCompactionConfig;
	chat: ChatConfig;
	/** The configured SSO issuer, or null when sign-in is local only. */
	sso: SsoConfig | null;
	/**
	 * Settings fixed by the deployer, or null when nothing is. Loaded from its own
	 * file (`policyFile`) rather than the main config, so it can be reloaded on a
	 * plan change without re-running `resolveConfig` - which re-reads argv and env
	 * and can legitimately refuse to start.
	 */
	policy: PolicyConfig | null;
	/**
	 * Path to the JSON file `policy` is read from, watched for changes. Unset ->
	 * nothing is pinned and nothing is watched.
	 */
	policyFile?: string;

	/**
	 * The `--config` file this was resolved from, absolute, or undefined when none
	 * was given. Reported at startup so an operator who meant to pass `--config` and
	 * forgot can see that they are running on defaults.
	 */
	configPath?: string;
	/**
	 * Start fresh with an empty embedded database (the existing `pgdata` is renamed
	 * aside, not deleted). **`--reset` only** - never a config-file key, because a
	 * persistent file carrying it would wipe the database on every restart.
	 */
	reset: boolean;
	/**
	 * Derived from the twelve-word master key phrase, for a single non-interactive
	 * startup. **`HEZO_MASTER_KEY` / `--master-key` only** - never a config-file key.
	 * The master key is kept in memory only; a copy on disk next to the encrypted
	 * data would let anyone who reads the host decrypt the vault.
	 */
	masterKey?: { unlockKeyHex: string; publicKeyHex: string };
}

/** Expand a leading `~` and make the path absolute. */
export function resolveDataDir(raw: string): string {
	return raw.startsWith('~') ? resolve(homedir(), raw.slice(2)) : resolve(raw);
}

/**
 * Every built-in default, in one place. This is the base of the
 * flag > config file > default merge, and the documented default column in
 * `docs/deployment/configuration.md` is generated from the same values.
 */
export const DEFAULT_CONFIG: HezoConfig = {
	port: DEFAULT_PORT,
	dataDir: resolveDataDir(DEFAULT_DATA_DIR),
	webUrl: '',
	logLevel: 'info',
	open: true,

	policy: null,
	sso: null,

	database: { poolSize: 10 },
	assetStorage: {},
	containers: {
		dockerRequestTimeoutMs: 10_000,
		keepOld: false,
		skipMountCheck: false,
		daytona: { apiUrl: DEFAULT_DAYTONA_API_URL },
	},
	egress: { proxyAuth: true, allowPrivateTargets: false, debug: false },
	telemetry: { enabled: true, endpoint: DEFAULT_TELEMETRY_ENDPOINT },
	updates: { disabled: false, autoInstall: false },
	marketplace: { ref: 'main', baseUrl: 'https://raw.githubusercontent.com' },
	github: { oauthClientId: DEFAULT_GITHUB_OAUTH_CLIENT_ID },
	jobs: {
		wakeupCron: '*/5 * * * * *',
		heartbeatCron: '*/5 * * * * *',
		inboxArchiveCron: '0 0 3 * * *',
		pricingRefreshCron: '0 0 2 * * *',
		modelPinRefreshCron: '0 0 3 * * *',
		updateCheckCron: '0 0 4 * * *',
		autoInstallCron: '0 */5 * * * *',
		telemetryCron: '0 0 5 * * *',
		budgetResumeCron: '*/30 * * * * *',
		connectorHealthCron: '0 */5 * * * *',
		containerSyncCron: '* * * * * *',
		containerIdleStopCron: '15 * * * * *',
		orphanDetectionCron: '*/30 * * * * *',
		orphanContainerSweepCron: '45 */10 * * * *',
		dbMaintenanceCron: '0 30 4 * * *',
		wakeupCoalescingMs: 2_000,
		heartbeatCooldownSec: 60,
		heartbeatFloorMin: HEARTBEAT_INTERVAL_FLOOR_MIN_DEFAULT,
		inboxRetentionDays: 30,
	},
	logCompaction: {
		cron: '*/10 * * * * *',
		batch: 50,
		maxPerTick: 500,
		preservedBytes: LOG_COMPACTION_PRESERVED_TAIL_BYTES,
	},
	chat: { healthIntervalMs: 10_000 },

	reset: false,
};
