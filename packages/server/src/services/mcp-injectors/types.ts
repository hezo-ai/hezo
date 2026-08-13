import type { AiProvider } from '@hezo/shared';

/**
 * Normalized MCP server descriptor passed by the agent runner. Per-runtime
 * adapters translate a list of these into the spawn artifacts (CLI args,
 * env entries, on-disk config files) that the runtime CLI will pick up.
 *
 * The runner always emits the built-in Hezo server (HTTP) plus zero or
 * more per-team / per-project descriptors loaded from `mcp_connections`.
 */
export type McpDescriptor = McpHttpDescriptor | McpStdioDescriptor;

/**
 * The name the built-in Hezo server is registered under.
 *
 * Shared because two sides have to agree on it: the runner emits the
 * descriptor, and the stream parser looks for *this* server in the runtime's
 * startup report to tell "Hezo is reachable" from "the agent has no Hezo tools
 * at all". A literal in both places would let them drift, and the failure that
 * causes is silent - the parser simply never finds the server it is checking.
 */
export const HEZO_MCP_SERVER_NAME = 'hezo';

interface McpDescriptorBase {
	/** Stable identifier used as the MCP server name in the runtime config. */
	name: string;
	/**
	 * Allowlist of this server's tool names the run may use. Absent means **no
	 * restriction** — the run gets everything the server advertises, and adapters
	 * emit no filter at all so the config is byte-identical to before this
	 * existed. Present means the runtime config should expose only these.
	 *
	 * This is the *hiding* leg: it keeps a disabled tool out of the agent's tool
	 * list so it never tries to call one. It is not the enforcement boundary —
	 * the runtimes are installed unpinned and their filter keys can drift, so the
	 * egress proxy independently rejects a `tools/call` naming a disabled method
	 * (see `services/egress/mcp-method-guard.ts`).
	 */
	enabledTools?: readonly string[];
	/**
	 * The same restriction expressed the other way round: the catalogued tools
	 * this run may NOT use. Set only alongside `enabledTools`.
	 *
	 * Both views exist because the runtimes disagree on shape — Gemini and
	 * OpenCode take an allowlist, Claude Code's settings file only has a
	 * `permissions.deny`. A deny list is strictly weaker: it can only name tools
	 * we knew about when the connector's methods were last listed, so a tool the
	 * server adds afterwards is not denied by it. That gap is deliberate and
	 * accepted here precisely because the proxy, not the runtime config, is what
	 * actually enforces the allowlist.
	 */
	disabledTools?: readonly string[];
}

export interface McpHttpDescriptor extends McpDescriptorBase {
	kind: 'http';
	/** Streamable-HTTP endpoint URL. */
	url: string;
	/** Headers to send with each request to this MCP server. Values may
	 * contain `__HEZO_SECRET_*__` placeholders that the egress proxy
	 * substitutes at request time. */
	headers?: Record<string, string>;
	/** Convenience: bearer token added as `Authorization: Bearer <token>`. */
	bearerToken?: string;
}

export interface McpStdioDescriptor extends McpDescriptorBase {
	kind: 'stdio';
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
	/**
	 * True when the contents are prose the adapter is passing through (a resolved
	 * system prompt) rather than config it rendered. The env-var bearer check is
	 * skipped for these: it exists to catch an adapter inlining the MCP token into
	 * a config file, and agent-authored text legitimately *describes* bearer
	 * headers - `Authorization: Bearer __HEZO_SECRET_<NAME>__` is exactly what the
	 * shared instructions tell agents to emit, and a placeholder is not a secret.
	 * Without this, a project custom prompt mentioning one would break every run on
	 * that runtime.
	 */
	passthrough?: boolean;
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
	/**
	 * AI provider for this run. The Claude Code adapter uses it to pick the
	 * Stop-hook judge model — the judge runs against the team's own upstream, so
	 * the model must be one that provider serves (the Anthropic id on DeepSeek /
	 * Z.ai would 404 and the hook would fail open). Optional for adapters/tests
	 * that don't need it; the Claude Code adapter falls back to the Anthropic judge.
	 */
	provider?: AiProvider;
	/**
	 * The run's resolved model (agent override or provider default), if any. The
	 * Claude Code adapter uses it, for a third-party Anthropic-compatible
	 * provider, to judge with the model the run actually uses instead of a
	 * hardcoded constant — so a provider model upgrade needs no code change (see
	 * {@link judgeModelForProvider}). Absent/null falls back to the constant.
	 */
	runModel?: string | null;
	/**
	 * Whether this invocation gets the completeness Stop-hook judge. Absent or
	 * true emits it, so every task run keeps it; false omits it on each of the
	 * four runtimes that carry one (the doc-write guard is unaffected - it is a
	 * deterministic path match, not a verdict on whether work is finished).
	 *
	 * The policy decision belongs to the caller, not the adapter: the judge
	 * evaluates whether an agent is abandoning TASK work, and it reads only the
	 * run's final message. A CEO chat turn has no task to abandon and its final
	 * message is the reply already delivered to the operator, so every rule it
	 * could fire on is either inapplicable or false there - it would only add a
	 * round trip to each reply and, on a block, spend a whole extra turn chasing
	 * a `create_comment` on a task that does not exist. What the chat DOES need -
	 * catching a handoff stranded in a comment the turn posted - is answered
	 * structurally by the wake receipt and the no-wake exit check instead.
	 */
	stopJudge?: boolean;
	/**
	 * Filenames of the project's active project docs. Runtimes with a blockable
	 * pre-tool hook bake these into a guard script so a `Write`/`Edit` aimed at a
	 * path that shadows a project doc is refused before it happens - the docs are
	 * database records, and writing one to disk silently changes nothing while
	 * leaving the real doc stale.
	 *
	 * Baked in rather than fetched at hook time so the guard needs no network,
	 * credentials or tool access from inside the container. Empty or absent means
	 * no guard is emitted at all.
	 */
	projectDocSlugs?: readonly string[];
	/**
	 * The run's resolved system prompt, for a runtime that cannot carry it in the
	 * prompt itself. Only Kimi Code uses it: its `-p <PROMPT>` is a single argv
	 * element and Linux caps one of those at MAX_ARG_STRLEN, so the ~111 KB static
	 * half is written to the instructions file its CLI auto-loads
	 * (RUNTIME_SYSTEM_PROMPT_FILE) and the prompt carries the task body alone.
	 *
	 * Every other adapter ignores it - their runtimes take the whole prompt on
	 * stdin or from a prompt file, where no such ceiling applies.
	 */
	systemPrompt?: string | null;
}

export interface RuntimeMcpAdapter {
	readonly capabilities: McpAdapterCapabilities;
	build(descriptors: readonly McpDescriptor[], ctx: McpAdapterContext): McpInjection;
}
