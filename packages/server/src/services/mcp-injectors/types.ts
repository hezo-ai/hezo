/**
 * Normalized MCP server descriptor passed by the agent runner. Per-runtime
 * adapters translate a list of these into the spawn artifacts (CLI args,
 * env entries, on-disk config files) that the runtime CLI will pick up.
 *
 * The runner always emits the built-in Hezo server (HTTP) plus zero or
 * more per-company / per-project descriptors loaded from `mcp_connections`.
 */
export type McpDescriptor = McpHttpDescriptor | McpStdioDescriptor;

export interface McpHttpDescriptor {
	kind: 'http';
	/** Stable identifier used as the MCP server name in the runtime config. */
	name: string;
	/** Streamable-HTTP endpoint URL. */
	url: string;
	/** Headers to send with each request to this MCP server. Values may
	 * contain `__HEZO_SECRET_*__` placeholders that the egress proxy
	 * substitutes at request time. */
	headers?: Record<string, string>;
	/** Convenience: bearer token added as `Authorization: Bearer <token>`. */
	bearerToken?: string;
}

export interface McpStdioDescriptor {
	kind: 'stdio';
	/** Stable identifier used as the MCP server name in the runtime config. */
	name: string;
	/** Absolute path or PATH-resolvable binary the runtime spawns. */
	command: string;
	/** Args passed to the command. */
	args?: string[];
	/** Env entries set on the spawned MCP process. Values may contain
	 * `__HEZO_SECRET_*__` placeholders. */
	env?: Record<string, string>;
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
