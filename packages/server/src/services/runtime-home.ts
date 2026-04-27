import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { type AgentRuntime, AiAuthMethod, AiProvider, RUNTIME_TO_PROVIDER } from '@hezo/shared';
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
	companySlug: string,
	projectSlug: string,
	heartbeatRunId: string,
): string | null {
	const layout = SUBSCRIPTION_LAYOUTS[provider];
	if (!layout) return null;
	return join(
		getWorkspacePath(dataDir, companySlug, projectSlug),
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
	companySlug: string,
	projectSlug: string,
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
		companySlug,
		projectSlug,
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
 * Per-runtime home directory used to host MCP server config and other CLI state.
 * Returns the existing subscription mount when one is provided, otherwise creates
 * a fresh per-run directory under the project workspace using the same layout
 * conventions as subscription mounts. Returns null for runtimes that do not need
 * a config home (e.g. Claude Code, which takes MCP config via CLI flags).
 */
export function ensureRuntimeHomeDir(
	runtime: AgentRuntime,
	dataDir: string,
	companySlug: string,
	projectSlug: string,
	heartbeatRunId: string,
	existing: SubscriptionMount | null,
): RuntimeHomeMount | null {
	const provider = RUNTIME_TO_PROVIDER[runtime];
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
		companySlug,
		projectSlug,
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
