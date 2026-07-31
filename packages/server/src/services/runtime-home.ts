import { join } from 'node:path';
import { AiAuthMethod, AiProvider } from '@hezo/shared';
import type { AiProviderCredential } from './ai-provider-keys';
import { hostSandboxFiles, type SandboxFiles } from './sandbox/files';
import { getWorkspacePath } from './workspace';

export const CONTAINER_SUBSCRIPTION_DIR = '/workspace/.hezo/subscription';

/**
 * Root of every Hezo-created per-run config directory, and the boundary the
 * traversal-bit chmod stops at.
 *
 * It is also the root a {@link SandboxFiles} is built on for these files, which
 * is what lets the mode handling live in one place: `hostSandboxFiles`'s
 * `write`/`mkdir` chmod each directory they create from the leaf back up to
 * their root, and that root is exactly this path. Before, the same
 * umask-proofing was written a second time here with the boundary found by
 * string-matching `/.hezo/subscription` inside an absolute path.
 */
export function getHostSubscriptionBase(
	dataDir: string,
	teamId: string,
	projectId: string,
): string {
	return join(getWorkspacePath(dataDir, teamId, projectId), '.hezo', 'subscription');
}

/**
 * {@link SandboxFiles} over the per-run config directories.
 *
 * Everything written through it gets `dirMode: 0o711` (not 0o700) so the
 * non-root container run-user can **traverse** the intermediate
 * `subscription/<provider>/` dirs to reach its per-run leaf - which the runner
 * chowns to that user (see `chownToRunUser`). Without the traversal bit the
 * agent CLI fails with `EACCES` opening `<leaf>/settings.json` even though the
 * leaf and its files were chowned correctly.
 */
export function subscriptionFiles(
	dataDir: string,
	teamId: string,
	projectId: string,
): SandboxFiles {
	return hostSandboxFiles(getHostSubscriptionBase(dataDir, teamId, projectId));
}

/** Directory mode for everything under the subscription base. See {@link subscriptionFiles}. */
export const SUBSCRIPTION_DIR_MODE = 0o711;

export interface SubscriptionLayout {
	dirName: string;
	/**
	 * Path (relative to the per-run home dir) where the runtime CLI reads its
	 * subscription credential file. Present only for providers whose subscription
	 * credential is delivered as a file mount (Codex, Gemini). Omitted for
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
	// Claude Code-driven providers (Anthropic, DeepSeek, Z.ai, Kimi) need a
	// per-run config dir so the runner can drop a settings.json with the Stop hook
	// the agent CLI loads via `--settings`. The envVarName is a Hezo-internal
	// marker, not consumed by Claude Code itself; HOME is intentionally not
	// overridden so git/ssh keep finding the container's default $HOME. No
	// authFileRelative: Anthropic subscription is delivered via the
	// CLAUDE_CODE_OAUTH_TOKEN env var (see PROVIDER_RUNTIME_ADAPTERS), and
	// DeepSeek/Z.ai/Kimi are api-key only (credential via ANTHROPIC_AUTH_TOKEN).
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
	[AiProvider.Kimi]: {
		dirName: 'claude-code-kimi',
		envVarName: 'HEZO_CLAUDE_CONFIG_DIR',
		rotates: false,
	},
	// Kimi Code (the `kimi` CLI) — unlike every entry above, `KIMI_CODE_HOME` is a
	// REAL variable the CLI consumes, not a Hezo-internal marker. It relocates the
	// entire data root: config.toml, mcp.json, credentials, and the per-session
	// logs. That is what makes three things possible at once — per-run config
	// isolation (there is no `--mcp-config`-style flag to point at a file), the
	// Stop hook's lookup of the run's own session log, and the post-run token-usage
	// scrape that cost accounting depends on. Api-key only (KIMI_MODEL_API_KEY via
	// env), so no authFileRelative.
	[AiProvider.KimiCode]: {
		dirName: 'kimi-code',
		envVarName: 'KIMI_CODE_HOME',
		rotates: false,
	},
	// The local providers are Claude Code-driven too, so they need the same per-run
	// config dir — without an entry here `ensureRuntimeHomeDir` returns null, no
	// settings.json is written, and the completeness Stop hook silently never
	// loads. Api-key only (a sentinel token via ANTHROPIC_AUTH_TOKEN), so no
	// authFileRelative.
	[AiProvider.Ollama]: {
		dirName: 'claude-code-ollama',
		envVarName: 'HEZO_CLAUDE_CONFIG_DIR',
		rotates: false,
	},
	[AiProvider.LmStudio]: {
		dirName: 'claude-code-lmstudio',
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
	// Grok (xAI) needs a per-run config dir to host `config.toml` (MCP servers +
	// `[cli] auto_update=false`) and the `--debug-file` cost log. Unlike the
	// Claude Code markers, GROK_HOME is a real env var the grok CLI honours: it
	// relocates the `.grok` config/session root, so the CLI reads our per-run
	// `config.toml` from `$GROK_HOME/config.toml`. Api-key only (no auth file).
	[AiProvider.XAi]: {
		dirName: 'grok',
		envVarName: 'GROK_HOME',
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
	/**
	 * The auth file's path *relative to `hostDir`*, which is the form a
	 * `SandboxFiles` takes. The rotated-credential read-back goes through that
	 * seam: the container rewrites this file during the run, so on a backend
	 * whose container is not on this machine the host cannot simply read it
	 * back - that read-back is one of the cases the abstraction exists for.
	 */
	authFileRelative: string;
	containerDir: string;
	envEntries: string[];
	rotates: boolean;
}

export async function buildSubscriptionMount(
	dataDir: string,
	teamId: string,
	projectId: string,
	heartbeatRunId: string,
	provider: AiProvider,
	credential: AiProviderCredential,
): Promise<SubscriptionMount | null> {
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
	// Relative to the subscription base, which is the form SandboxFiles takes -
	// and that base is also where its chmod walk stops, so the traversal bit
	// lands on exactly the dirs Hezo created and no higher. The credential file
	// itself stays 0o600 (and is chowned to the run-user), never world-readable.
	await subscriptionFiles(dataDir, teamId, projectId).write(
		join(layout.dirName, heartbeatRunId, authFileRelative),
		credential.value,
		{ mode: 0o600, dirMode: SUBSCRIPTION_DIR_MODE },
	);

	return {
		hostDir,
		hostAuthFile,
		authFileRelative,
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
export async function ensureRuntimeHomeDir(
	provider: AiProvider,
	dataDir: string,
	teamId: string,
	projectId: string,
	heartbeatRunId: string,
	existing: SubscriptionMount | null,
): Promise<RuntimeHomeMount | null> {
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

	await subscriptionFiles(dataDir, teamId, projectId).mkdir(join(layout.dirName, heartbeatRunId), {
		mode: SUBSCRIPTION_DIR_MODE,
	});

	return {
		hostDir,
		containerDir,
		envEntry: `${layout.envVarName}=${containerDir}`,
	};
}
