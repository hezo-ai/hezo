import type { AgentEffort, AiProvider, CostTokens } from '@hezo/shared';
import type { AgentRunUsage } from '../agent-stream-parser';
import type { EffortRuntimeApplication } from '../effort';
import type { SandboxFiles } from '../sandbox/types';

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
	 * Both views exist because the runtimes disagree on shape — Codex and
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
	/** Files to write before spawning, under the per-run subscription dir. */
	files: readonly McpInjectionFile[];
	/**
	 * Config files that must live in the container run-user's real HOME, for a CLI
	 * that reads only `$HOME` and offers no relocation flag or env var (the
	 * Antigravity CLI reads `~/.gemini` alone). The runner writes these rooted at
	 * the run user's home rather than the per-run dir, and scrubs any that carry a
	 * per-run secret afterwards. Safe because one run holds a container at a time,
	 * so the file is rewritten per run with no overlap.
	 */
	homeConfigFiles?: readonly HomeConfigFile[];
}

export interface HomeConfigFile {
	/** Path relative to the container run-user's home dir (e.g. `.gemini/config/mcp_config.json`). */
	relativePath: string;
	/** File mode (octal). */
	mode: number;
	/** File contents to write verbatim. */
	contents: string;
	/** True when this file carries a per-run secret and must be scrubbed after the run. */
	scrubAfterRun?: boolean;
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
	 * The run's resolved effort level. Only the OpenCode adapter reads it: OpenCode
	 * has no CLI flag or env var for reasoning, so its effort is written as
	 * `reasoning.effort` on the run's model inside the `opencode.json` this adapter
	 * already emits. Absent leaves the reasoning block off entirely.
	 */
	effort?: AgentEffort;
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

/** What a runtime needs to compose this run's environment. */
export interface RuntimeEnvContext {
	/** The AI provider this run's credential belongs to. */
	provider: AiProvider;
	/** The run's resolved model, trimmed; null when the run pins none. */
	runModel: string | null;
	/** The credential's own endpoint, for a provider whose host is per-install. */
	baseUrl: string | null;
}

/** What a runtime needs to contribute argv beyond the per-runtime arg tables. */
export interface RuntimeArgsContext {
	/** The per-run home directory as it appears inside the container, if mounted. */
	containerHomeDir: string | null;
}

/** What a runtime needs to recover usage a CLI left on disk rather than on stdout. */
export interface RuntimeUsageContext {
	/** Reads and removals are scoped to the per-run home mount. */
	files: SandboxFiles;
	price: ((model: string | undefined, tokens: CostTokens) => number) | undefined;
	onError: (msg: string) => void;
}

/**
 * Everything Hezo knows about driving one coding CLI.
 *
 * The whole point of this seam is that **nothing outside it may name a runtime**.
 * A CLI's flag spellings, env var names, model-id form, error envelope, the file
 * it leaves usage in and how it behaves at exit are its own business; the runner
 * asks the table and gets an answer for whichever runtime it holds. Every member
 * below exists because that knowledge would otherwise be an `if` in generic code.
 *
 * The optional members are optional in the honest sense - most runtimes have
 * nothing to say - and an absent one means "nothing extra", never "unsupported".
 */
export interface RuntimeAdapter {
	readonly capabilities: McpAdapterCapabilities;
	build(descriptors: readonly McpDescriptor[], ctx: McpAdapterContext): McpInjection;

	/**
	 * Env this CLI always needs, whatever provider drives it - quieting a banner,
	 * lifting a built-in ceiling. Emitted before the provider's own static bag.
	 */
	readonly constantEnv?: Readonly<Record<string, string>>;

	/**
	 * Rewrite one entry of the provider binding's static env for this run.
	 * Returning the value unchanged is the default; a runtime overrides where a
	 * pinned constant should track the run's selected model instead.
	 */
	staticEnvValue?(key: string, value: string, ctx: RuntimeEnvContext): string;

	/**
	 * Env derived from the credential rather than from a table - an endpoint that
	 * is per-install, and whatever else must be set alongside it.
	 */
	credentialEnv?(ctx: RuntimeEnvContext): readonly string[];

	/**
	 * Put a stored model id into the form this CLI's `--model` accepts. Absent
	 * means the id is passed through as stored.
	 */
	modelArg?(provider: AiProvider, model: string): string;

	/** Argv this CLI needs that no shared per-runtime table can express. */
	extraArgs?(ctx: RuntimeArgsContext): readonly string[];

	/**
	 * How this CLI is asked to reason harder. Absent means it exposes no native
	 * lever and is steered by the portable prompt directive alone, which is the
	 * honest answer for a CLI whose flag is undocumented or unstable.
	 */
	applyEffort?(effort: AgentEffort): EffortRuntimeApplication;

	/**
	 * Recover token usage for a CLI that reports none on its stream, from a file
	 * it leaves in the per-run home. The implementation is responsible for
	 * scrubbing that file: they carry provider credentials in plaintext.
	 *
	 * Best-effort by contract - null means "no usage to report", which prices the
	 * run at $0 rather than failing it.
	 */
	recoverUsage?(ctx: RuntimeUsageContext): Promise<AgentRunUsage | null>;

	/**
	 * True when this CLI can exit 0 having killed background work it had not
	 * finished. Only such a runtime has its stream watched for that report, and
	 * only there does a clean exit get second-guessed.
	 */
	readonly terminatesBackgroundWork?: boolean;
}
