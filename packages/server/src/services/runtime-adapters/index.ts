import { type AgentEffort, AgentRuntime } from '@hezo/shared';
import { type EffortRuntimeApplication, GENERIC_PROMPT_DIRECTIVE } from '../effort';
import { antigravityAdapter } from './antigravity';
import { claudeCodeAdapter } from './claude-code';
import { codexAdapter } from './codex';
import { grokAdapter } from './grok';
import { kimiAdapter } from './kimi';
import { opencodeAdapter } from './opencode';
import type { McpAdapterContext, McpDescriptor, McpInjection, RuntimeAdapter } from './types';
import { validateInjection } from './validate';

/**
 * Per-runtime adapter table, and the only place a runtime is named.
 *
 * The `Record<AgentRuntime, ...>` typing means adding a runtime to the enum
 * without adding an adapter here is a TypeScript error - a new CLI cannot be
 * half-wired. Everything a runtime does differently from its peers hangs off a
 * row in this table: MCP artifacts, env, argv, model-id form, usage recovery and
 * exit behaviour. Code outside this directory asks the table; it does not ask
 * which runtime it holds.
 */
export const RUNTIME_ADAPTERS: Record<AgentRuntime, RuntimeAdapter> = {
	[AgentRuntime.ClaudeCode]: claudeCodeAdapter,
	[AgentRuntime.Codex]: codexAdapter,
	[AgentRuntime.Antigravity]: antigravityAdapter,
	[AgentRuntime.OpenCode]: opencodeAdapter,
	[AgentRuntime.Grok]: grokAdapter,
	[AgentRuntime.Kimi]: kimiAdapter,
};

/**
 * Render a runtime's MCP artifacts and prove they satisfy the adapter contract.
 *
 * The build and the check are one call because they are one question, and
 * because the answer has to be reachable twice: once before a container is
 * claimed, to refuse a run whose configuration cannot work, and once for real
 * inside `buildRuntimeInvocation`. Two builders would be two things to keep in
 * step; this is one, called from both.
 *
 * Everything it reads is host-side - the adapter table, the descriptor list, the
 * per-run home paths, the project's doc slugs - so it needs no container.
 */
/**
 * How hard this runtime is asked to reason.
 *
 * A runtime with no native lever declares none, and gets the portable prompt
 * directive: OpenCode's effort is written into the `opencode.json` its own
 * adapter emits rather than onto argv, and Grok's `--reasoning-effort` values are
 * not stable across its betas. Both are steered by the directive alone.
 */
export function applyEffortToRuntime(
	runtime: AgentRuntime,
	effort: AgentEffort,
): EffortRuntimeApplication {
	return (
		RUNTIME_ADAPTERS[runtime].applyEffort?.(effort) ?? {
			extraArgs: [],
			extraEnv: [],
			promptDirective: GENERIC_PROMPT_DIRECTIVE[effort],
		}
	);
}

export function buildMcpInjection(
	runtime: AgentRuntime,
	descriptors: readonly McpDescriptor[],
	ctx: McpAdapterContext,
): McpInjection {
	const adapter = RUNTIME_ADAPTERS[runtime];
	const injection = adapter.build(descriptors, ctx);
	validateInjection(adapter, injection);
	return injection;
}

export type {
	McpAdapterCapabilities,
	McpAdapterContext,
	McpDescriptor,
	McpHttpDescriptor,
	McpInjection,
	McpInjectionFile,
	McpStdioDescriptor,
	RuntimeAdapter,
	RuntimeArgsContext,
	RuntimeEnvContext,
	RuntimeUsageContext,
} from './types';
export { HEZO_MCP_SERVER_NAME } from './types';
export { validateInjection } from './validate';
