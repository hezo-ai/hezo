import { join } from 'node:path';
import {
	AgentRuntime,
	AiAuthMethod,
	type AiProvider,
	RUNTIMES_WITH_ROTATING_CREDENTIAL,
} from '@hezo/shared';
import type { AiProviderCredential } from './ai-provider-keys';
import type { SandboxFiles } from './sandbox/files';
import type { ContainerEngine } from './sandbox/types';
import { CONTAINER_WORKSPACE_ROOT, getWorkspacePath } from './workspace';

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
export function subscriptionFiles(engine: ContainerEngine, containerId: string): SandboxFiles {
	return engine.files(containerId, CONTAINER_SUBSCRIPTION_BASE);
}

/**
 * Container-side root the subscription files are written under.
 *
 * Rooting on the *container* path rather than the host one is what lets these
 * credentials reach a sandbox that is not on this machine: the bytes go through
 * the engine's file transport instead of a bind mount, and the mode contract
 * above travels with them.
 */
export const CONTAINER_SUBSCRIPTION_BASE = `${CONTAINER_WORKSPACE_ROOT}/.hezo/subscription`;

/** Directory mode for everything under the subscription base. See {@link subscriptionFiles}. */
export const SUBSCRIPTION_DIR_MODE = 0o711;

export interface RuntimeHomeLayout {
	/**
	 * First segment of the per-run directory name. The provider is appended
	 * (`claude-code` + `anthropic`), so two providers on the same CLI still get
	 * separate config dirs and can never read each other's settings.
	 */
	dirPrefix: string;
	/**
	 * Path (relative to the per-run home dir) where the runtime CLI reads its
	 * subscription credential file. Present only for runtimes whose subscription
	 * credential is delivered as a file mount (Codex, Gemini). Omitted for
	 * runtimes that need only a config home dir (the credential, if any, is
	 * delivered via env var — e.g. Anthropic's CLAUDE_CODE_OAUTH_TOKEN). When
	 * omitted, `buildSubscriptionMount` writes no file and returns null.
	 */
	authFileRelative?: string;
	/**
	 * Renders {@link authFileRelative}'s contents for an **api key**, on a CLI
	 * that will not authenticate a request from an environment variable.
	 *
	 * Codex is the case: it reports the env key as present (`codex doctor` says
	 * "auth is provided by environment") and then sends no bearer at all, so every
	 * api-key run 401s. The key it does honour is the one in its auth file, which
	 * is the same file its subscription blob lands in - hence one mechanism here
	 * rather than a second delivery path.
	 *
	 * Omitted for every CLI that does read the env var; those write no file and
	 * keep the env-only delivery `credentialEnvByAuthMethod` describes.
	 */
	apiKeyAuthFile?: (apiKey: string) => string;
	envVarName: string;
}

/**
 * Where each CLI reads its per-run config from, keyed by RUNTIME — not by
 * provider.
 *
 * Every field here is a property of the binary, not of the account: the env var
 * is the one that CLI honours, the auth file is the path it looks in, and the
 * rotation behaviour is its token handling. Keying this by provider (as it was
 * until the credential gained its own runtime) cannot express a provider that
 * runs on more than one CLI — a Moonshot key on Kimi Code was handed
 * `HEZO_CLAUDE_CONFIG_DIR` and never got `KIMI_CODE_HOME`, so its MCP config was
 * never read, the Stop-hook judge could not find the session log, and the usage
 * scrape found nothing and priced the run at $0.
 *
 * Pass the RESOLVED runtime (`effectiveRuntime`), never the provider default.
 */
export const RUNTIME_HOME_LAYOUTS: Record<AgentRuntime, RuntimeHomeLayout> = {
	[AgentRuntime.Codex]: {
		dirPrefix: 'codex',
		authFileRelative: 'auth.json',
		// The shape `codex login --with-api-key` writes. Rendered rather than
		// piped through that command because the run has no interactive step to
		// hang it off, and the file is what the CLI reads either way.
		apiKeyAuthFile: (apiKey) =>
			`${JSON.stringify({ auth_mode: 'apikey', OPENAI_API_KEY: apiKey }, null, 2)}\n`,
		envVarName: 'CODEX_HOME',
	},
	[AgentRuntime.Gemini]: {
		dirPrefix: 'gemini',
		authFileRelative: '.gemini/oauth_creds.json',
		envVarName: 'GEMINI_CLI_HOME',
	},
	// Claude Code needs a per-run config dir so the runner can drop a settings.json
	// with the Stop hook the agent CLI loads via `--settings`. The envVarName is a
	// Hezo-internal marker, not consumed by Claude Code itself; HOME is
	// intentionally not overridden so git/ssh keep finding the container's default
	// $HOME. No authFileRelative: Anthropic subscription is delivered via the
	// CLAUDE_CODE_OAUTH_TOKEN env var (see PROVIDER_RUNTIME_ADAPTERS), and every
	// other Claude Code provider is api-key only.
	[AgentRuntime.ClaudeCode]: {
		dirPrefix: 'claude-code',
		envVarName: 'HEZO_CLAUDE_CONFIG_DIR',
	},
	// OpenCode reads the config file via an explicit
	// `OPENCODE_CONFIG=<dir>/opencode.json` env entry (OPENCODE_CONFIG wants a file
	// path, not a directory), so this marker only carries the directory.
	[AgentRuntime.OpenCode]: {
		dirPrefix: 'opencode',
		envVarName: 'HEZO_OPENCODE_CONFIG_DIR',
	},
	// Unlike the Claude Code marker, GROK_HOME is a real env var the grok CLI
	// honours: it relocates the `.grok` config/session root, so the CLI reads our
	// per-run `config.toml` from `$GROK_HOME/config.toml`. Also hosts the
	// `--debug-file` cost log. Api-key only (no auth file).
	[AgentRuntime.Grok]: {
		dirPrefix: 'grok',
		envVarName: 'GROK_HOME',
	},
	// `KIMI_CODE_HOME` is likewise a REAL variable the CLI consumes. It relocates
	// the entire data root: config.toml, mcp.json, credentials, and the per-session
	// logs. That is what makes three things possible at once — per-run config
	// isolation (there is no `--mcp-config`-style flag to point at a file), the
	// Stop hook's lookup of the run's own session log, and the post-run token-usage
	// scrape that cost accounting depends on. Api-key only (KIMI_MODEL_API_KEY via
	// env), so no authFileRelative.
	[AgentRuntime.Kimi]: {
		dirPrefix: 'kimi-code',
		envVarName: 'KIMI_CODE_HOME',
	},
};

/**
 * Per-run directory name for a (runtime, provider) pairing. The provider suffix
 * keeps two accounts on the same CLI in separate dirs.
 */
function layoutDirName(layout: RuntimeHomeLayout, provider: AiProvider): string {
	return `${layout.dirPrefix}-${provider}`;
}

export function getContainerSubscriptionRoot(
	provider: AiProvider,
	runtime: AgentRuntime,
	heartbeatRunId: string,
): string | null {
	const layout = RUNTIME_HOME_LAYOUTS[runtime];
	if (!layout) return null;
	return `${CONTAINER_SUBSCRIPTION_DIR}/${layoutDirName(layout, provider)}/${heartbeatRunId}`;
}

export function getHostSubscriptionRoot(
	provider: AiProvider,
	runtime: AgentRuntime,
	dataDir: string,
	teamId: string,
	projectId: string,
	heartbeatRunId: string,
): string | null {
	const layout = RUNTIME_HOME_LAYOUTS[runtime];
	if (!layout) return null;
	return join(
		getWorkspacePath(dataDir, teamId, projectId),
		'.hezo',
		'subscription',
		layoutDirName(layout, provider),
		heartbeatRunId,
	);
}

export interface SubscriptionMount {
	/**
	 * Host path the run's config directory *would* occupy under a bind mount.
	 *
	 * Kept only for the prompt's `hostHomeDir` variable and operator-facing
	 * diagnostics - nothing reads or writes through it, because a managed
	 * backend's sandbox is not on this machine. Every actual read and write goes
	 * through {@link SandboxFiles} rooted at `containerDir`.
	 */
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
	runtime: AgentRuntime,
	credential: AiProviderCredential,
	engine: ContainerEngine,
	containerId: string,
): Promise<SubscriptionMount | null> {
	const layout = RUNTIME_HOME_LAYOUTS[runtime];
	if (!layout) return null;
	// No credential file for this runtime — the credential is delivered via env
	// var (buildProviderEnv), so there is nothing to mount.
	const { authFileRelative } = layout;
	if (!authFileRelative) return null;

	const isSubscription = credential.authMethod === AiAuthMethod.Subscription;
	// An api key only gets a file on a CLI that will not read it from the
	// environment; everywhere else env delivery stands and this returns null.
	const contents = isSubscription ? credential.value : layout.apiKeyAuthFile?.(credential.value);
	if (contents === undefined) return null;

	const hostDir = getHostSubscriptionRoot(
		provider,
		runtime,
		dataDir,
		teamId,
		projectId,
		heartbeatRunId,
	) as string;
	const containerDir = getContainerSubscriptionRoot(provider, runtime, heartbeatRunId) as string;
	const hostAuthFile = join(hostDir, authFileRelative);
	// Relative to the subscription base, which is the form SandboxFiles takes -
	// and that base is also where its chmod walk stops, so the traversal bit
	// lands on exactly the dirs Hezo created and no higher. The credential file
	// itself stays 0o600 (and is chowned to the run-user), never world-readable.
	await subscriptionFiles(engine, containerId).write(
		join(layoutDirName(layout, provider), heartbeatRunId, authFileRelative),
		contents,
		{ mode: 0o600, dirMode: SUBSCRIPTION_DIR_MODE },
	);

	return {
		hostDir,
		hostAuthFile,
		authFileRelative,
		containerDir,
		envEntries: [`${layout.envVarName}=${containerDir}`],
		// Only a subscription blob rotates. An api-key file is written from the
		// stored key every run, so reading it back would persist a rotation that
		// never happened over the operator's own credential.
		rotates: RUNTIMES_WITH_ROTATING_CREDENTIAL.includes(runtime) && isSubscription,
	};
}

export interface RuntimeHomeMount {
	hostDir: string;
	containerDir: string;
	envEntry: string;
}

/**
 * Per-run home directory hosting the CLI's config (MCP server config,
 * settings.json, …). Returns the existing subscription mount when one is
 * provided, otherwise creates a fresh per-run directory under the project
 * workspace using the same layout conventions as subscription mounts.
 *
 * The env var comes from the RESOLVED runtime, so a credential switched onto a
 * different CLI gets that CLI's variable rather than its provider default's.
 */
export async function ensureRuntimeHomeDir(
	provider: AiProvider,
	runtime: AgentRuntime,
	dataDir: string,
	teamId: string,
	projectId: string,
	heartbeatRunId: string,
	existing: SubscriptionMount | null,
	engine: ContainerEngine,
	containerId: string,
): Promise<RuntimeHomeMount | null> {
	const layout = RUNTIME_HOME_LAYOUTS[runtime];
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
		runtime,
		dataDir,
		teamId,
		projectId,
		heartbeatRunId,
	) as string;
	const containerDir = getContainerSubscriptionRoot(provider, runtime, heartbeatRunId) as string;

	await subscriptionFiles(engine, containerId).mkdir(
		join(layoutDirName(layout, provider), heartbeatRunId),
		{ mode: SUBSCRIPTION_DIR_MODE },
	);

	return {
		hostDir,
		containerDir,
		envEntry: `${layout.envVarName}=${containerDir}`,
	};
}
