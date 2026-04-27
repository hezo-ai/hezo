/**
 * Normalized MCP server descriptor passed by the agent runner. Per-runtime
 * adapters translate a list of these into the spawn artifacts (CLI args,
 * env entries, on-disk config files) that the runtime CLI will pick up.
 *
 * Today the runner emits exactly one descriptor (the built-in Hezo server).
 * The contract is shaped as a list so per-agent / per-company MCP servers
 * can be added later without changing the adapter signature.
 */
export interface McpDescriptor {
	/** Stable identifier used as the MCP server name in the runtime config. */
	name: string;
	/** Streamable-HTTP endpoint URL. */
	url: string;
	/** Optional bearer token sent as Authorization: Bearer <token>. */
	bearerToken?: string;
}

export interface McpInjectionFile {
	/** Absolute host path to write before spawning. */
	hostPath: string;
	/** File mode (octal) — e.g. 0o600 for secrets. */
	mode: number;
	/** File contents to write verbatim. */
	contents: string;
}

/**
 * Spawn-time artifacts produced by an adapter. The runner is responsible for
 * the actual file I/O and env composition; adapters stay pure functions.
 */
export interface McpInjection {
	/** Extra args to splice into the spawn command. */
	cliArgs: readonly string[];
	/** Extra "KEY=VALUE" entries to append to the container env. */
	envEntries: readonly string[];
	/** Files to write before spawning. */
	files: readonly McpInjectionFile[];
}

export interface McpAdapterCapabilities {
	/** Wire transport this adapter targets. Currently only streamable HTTP. */
	transport: 'streamable-http';
	/** How the adapter passes the bearer token to the runtime. */
	bearerTokenStorage: 'inline' | 'env-var';
	/** True if the runtime requires a per-run config home directory on disk. */
	requiresHomeDir: boolean;
}

export interface McpAdapterContext {
	/** Per-run host config directory. Required when capabilities.requiresHomeDir is true. */
	hostHomeDir: string | null;
	/** Same path as it appears inside the container. */
	containerHomeDir: string | null;
}

export interface RuntimeMcpAdapter {
	readonly capabilities: McpAdapterCapabilities;
	build(descriptors: readonly McpDescriptor[], ctx: McpAdapterContext): McpInjection;
}
