import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { AiAuthMethod, AiProvider } from '@hezo/shared';
import type { AiProviderCredential } from './ai-provider-keys';
import { getWorkspacePath } from './workspace';

export const CONTAINER_SUBSCRIPTION_DIR = '/workspace/.hezo/subscription';

export interface SubscriptionLayout {
	dirName: string;
	/**
	 * Path (relative to the per-run home dir) where the runtime CLI reads its
	 * subscription credential file. Present only for providers whose subscription
	 * credential is delivered as a file mount (Codex, Gemini, Kimi). Omitted for
	 * providers that need only a config home dir (the credential, if any, is
	 * delivered via env var — e.g. Anthropic's CLAUDE_CODE_OAUTH_TOKEN). When
	 * omitted, `buildSubscriptionMount` writes no file and returns null.
	 */
	authFileRelative?: string;
	envVarName: string;
	/** True when the runtime CLI rotates a single-use refresh token in place,
	 *  so runs on the credential must serialise and the rotated file persist back. */
	rotates: boolean;
}

export const SUBSCRIPTION_LAYOUTS: Partial<Record<AiProvider, SubscriptionLayout>> = {
	[AiProvider.OpenAI]: {
		dirName: 'codex',
		authFileRelative: 'auth.json',
		envVarName: 'CODEX_HOME',
		rotates: true,
	},
	[AiProvider.Google]: {
		dirName: 'gemini',
		authFileRelative: '.gemini/oauth_creds.json',
		envVarName: 'GEMINI_CLI_HOME',
		rotates: false,
	},
	// Claude Code-driven providers (Anthropic, DeepSeek, Z.ai) need a per-run
	// config dir so the runner can drop a settings.json with the Stop hook the
	// agent CLI loads via `--settings`. The envVarName is a Hezo-internal
	// marker, not consumed by Claude Code itself; HOME is intentionally not
	// overridden so git/ssh keep finding the container's default $HOME. No
	// authFileRelative: Anthropic subscription is delivered via the
	// CLAUDE_CODE_OAUTH_TOKEN env var (see PROVIDER_RUNTIME_ADAPTERS), and
	// DeepSeek/Z.ai have no subscription path at all.
	[AiProvider.Anthropic]: {
		dirName: 'claude-code-anthropic',
		envVarName: 'HEZO_CLAUDE_CONFIG_DIR',
		rotates: false,
	},
	[AiProvider.DeepSeek]: {
		dirName: 'claude-code-deepseek',
		envVarName: 'HEZO_CLAUDE_CONFIG_DIR',
		rotates: false,
	},
	[AiProvider.ZAi]: {
		dirName: 'claude-code-zai',
		envVarName: 'HEZO_CLAUDE_CONFIG_DIR',
		rotates: false,
	},
	// OpenCode (OpenRouter) needs a per-run dir to host `opencode.json`. The
	// envVarName is a Hezo-internal marker; the OpenCode adapter points the CLI at
	// the config file via an explicit `OPENCODE_CONFIG=<dir>/opencode.json` env
	// entry (OPENCODE_CONFIG wants a file path, not a directory).
	[AiProvider.OpenRouter]: {
		dirName: 'opencode',
		envVarName: 'HEZO_OPENCODE_CONFIG_DIR',
		rotates: false,
	},
	// Kimi reads its config dir from KIMI_CODE_HOME, so the home-mount env entry
	// configures the CLI directly; the kimi adapter writes config.toml + mcp.json
	// into this dir. For subscription auth the managed-Kimi-Code OAuth credential
	// is materialised at `<KIMI_CODE_HOME>/credentials/kimi-code.json` — the exact
	// path the CLI reads (verified against @moonshot-ai/kimi-code) — and the kimi
	// adapter writes a `[providers."managed:kimi-code".oauth]` ref pointing at it.
	// The CLI rotates the refresh token in place each run, so rotates: true.
	[AiProvider.Kimi]: {
		dirName: 'kimi',
		authFileRelative: 'credentials/kimi-code.json',
		envVarName: 'KIMI_CODE_HOME',
		rotates: true,
	},
};

export function getContainerSubscriptionRoot(
	provider: AiProvider,
	heartbeatRunId: string,
): string | null {
	const layout = SUBSCRIPTION_LAYOUTS[provider];
	if (!layout) return null;
	return `${CONTAINER_SUBSCRIPTION_DIR}/${layout.dirName}/${heartbeatRunId}`;
}

export function getHostSubscriptionRoot(
	provider: AiProvider,
	dataDir: string,
	teamId: string,
	projectId: string,
	heartbeatRunId: string,
): string | null {
	const layout = SUBSCRIPTION_LAYOUTS[provider];
	if (!layout) return null;
	return join(
		getWorkspacePath(dataDir, teamId, projectId),
		'.hezo',
		'subscription',
		layout.dirName,
		heartbeatRunId,
	);
}

export interface SubscriptionMount {
	hostDir: string;
	hostAuthFile: string;
	containerDir: string;
	envEntries: string[];
	rotates: boolean;
}

export function buildSubscriptionMount(
	dataDir: string,
	teamId: string,
	projectId: string,
	heartbeatRunId: string,
	provider: AiProvider,
	credential: AiProviderCredential,
): SubscriptionMount | null {
	if (credential.authMethod !== AiAuthMethod.Subscription) return null;

	const layout = SUBSCRIPTION_LAYOUTS[provider];
	if (!layout) return null;
	// No credential file for this provider — the subscription credential is
	// delivered via env var (buildProviderEnv), so there is nothing to mount.
	const { authFileRelative } = layout;
	if (!authFileRelative) return null;

	const hostDir = getHostSubscriptionRoot(
		provider,
		dataDir,
		teamId,
		projectId,
		heartbeatRunId,
	) as string;
	const containerDir = getContainerSubscriptionRoot(provider, heartbeatRunId) as string;
	const hostAuthFile = join(hostDir, authFileRelative);

	// 0o711 (not 0o700) so the non-root container run-user can *traverse* these
	// intermediate dirs to reach the per-run leaf — which the runner chowns to that
	// user (see chownToRunUser). The credential file itself stays 0o600 (and is
	// chowned to the run-user), never world-readable.
	mkdirSync(dirname(hostAuthFile), { recursive: true, mode: 0o711 });
	writeFileSync(hostAuthFile, credential.value, { mode: 0o600 });

	return {
		hostDir,
		hostAuthFile,
		containerDir,
		envEntries: [`${layout.envVarName}=${containerDir}`],
		rotates: layout.rotates,
	};
}

export interface RuntimeHomeMount {
	hostDir: string;
	containerDir: string;
	envEntry: string;
}

/**
 * Per-provider home directory used to host runtime CLI config (MCP server
 * config, settings.json, etc.). Returns the existing subscription mount when
 * one is provided, otherwise creates a fresh per-run directory under the
 * project workspace using the same layout conventions as subscription mounts.
 * Returns null only for providers without a SUBSCRIPTION_LAYOUTS entry.
 */
export function ensureRuntimeHomeDir(
	provider: AiProvider,
	dataDir: string,
	teamId: string,
	projectId: string,
	heartbeatRunId: string,
	existing: SubscriptionMount | null,
): RuntimeHomeMount | null {
	const layout = SUBSCRIPTION_LAYOUTS[provider];
	if (!layout) return null;

	if (existing) {
		return {
			hostDir: existing.hostDir,
			containerDir: existing.containerDir,
			envEntry: `${layout.envVarName}=${existing.containerDir}`,
		};
	}

	const hostDir = getHostSubscriptionRoot(
		provider,
		dataDir,
		teamId,
		projectId,
		heartbeatRunId,
	) as string;
	const containerDir = getContainerSubscriptionRoot(provider, heartbeatRunId) as string;

	// 0o711 so the non-root container run-user can traverse the intermediate dirs to
	// its per-run config dir (which the runner then chowns to that user).
	mkdirSync(hostDir, { recursive: true, mode: 0o711 });

	return {
		hostDir,
		containerDir,
		envEntry: `${layout.envVarName}=${containerDir}`,
	};
}
