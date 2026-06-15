import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { AiAuthMethod, AiProvider } from '@hezo/shared';
import type { AiProviderCredential } from './ai-provider-keys';
import { getWorkspacePath } from './workspace';

export const CONTAINER_SUBSCRIPTION_DIR = '/workspace/.hezo/subscription';

export interface SubscriptionLayout {
	dirName: string;
	authFileRelative: string;
	envVarName: string;
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
	// overridden so git/ssh keep finding the container's default $HOME. The
	// authFileRelative is a placeholder — Anthropic-family providers don't yet
	// have a subscription-auth path wired up in Hezo, and buildSubscriptionMount
	// short-circuits when authMethod !== Subscription anyway.
	[AiProvider.Anthropic]: {
		dirName: 'claude-code-anthropic',
		authFileRelative: '.placeholder',
		envVarName: 'HEZO_CLAUDE_CONFIG_DIR',
		rotates: false,
	},
	[AiProvider.DeepSeek]: {
		dirName: 'claude-code-deepseek',
		authFileRelative: '.placeholder',
		envVarName: 'HEZO_CLAUDE_CONFIG_DIR',
		rotates: false,
	},
	[AiProvider.ZAi]: {
		dirName: 'claude-code-zai',
		authFileRelative: '.placeholder',
		envVarName: 'HEZO_CLAUDE_CONFIG_DIR',
		rotates: false,
	},
	// OpenCode (OpenRouter) needs a per-run dir to host `opencode.json`. The
	// envVarName is a Hezo-internal marker; the OpenCode adapter points the CLI at
	// the config file via an explicit `OPENCODE_CONFIG=<dir>/opencode.json` env
	// entry (OPENCODE_CONFIG wants a file path, not a directory).
	[AiProvider.OpenRouter]: {
		dirName: 'opencode',
		authFileRelative: '.placeholder',
		envVarName: 'HEZO_OPENCODE_CONFIG_DIR',
		rotates: false,
	},
	// Kimi reads its config dir from KIMI_CODE_HOME, so the home-mount env entry
	// configures the CLI directly; the kimi adapter writes config.toml + mcp.json
	// into this dir.
	[AiProvider.Kimi]: {
		dirName: 'kimi',
		authFileRelative: '.placeholder',
		envVarName: 'KIMI_CODE_HOME',
		rotates: false,
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

	const hostDir = getHostSubscriptionRoot(
		provider,
		dataDir,
		teamId,
		projectId,
		heartbeatRunId,
	) as string;
	const containerDir = getContainerSubscriptionRoot(provider, heartbeatRunId) as string;
	const hostAuthFile = join(hostDir, layout.authFileRelative);

	mkdirSync(dirname(hostAuthFile), { recursive: true, mode: 0o700 });
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

	mkdirSync(hostDir, { recursive: true, mode: 0o700 });

	return {
		hostDir,
		containerDir,
		envEntry: `${layout.envVarName}=${containerDir}`,
	};
}
