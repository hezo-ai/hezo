import { AgentRuntime } from '@hezo/shared';
import { claudeCodeAdapter } from './claude-code';
import { codexAdapter } from './codex';
import { geminiAdapter } from './gemini';
import { grokAdapter } from './grok';
import { kimiAdapter } from './kimi';
import { opencodeAdapter } from './opencode';
import type { McpAdapterContext, McpDescriptor, McpInjection, RuntimeMcpAdapter } from './types';
import { validateInjection } from './validate';

/**
 * Per-runtime MCP adapter table. The `Record<AgentRuntime, ...>` typing means
 * adding a new runtime to the AgentRuntime enum without adding an adapter
 * here is a TypeScript error — every runtime we support gets MCP exposure.
 */
export const MCP_ADAPTERS: Record<AgentRuntime, RuntimeMcpAdapter> = {
	[AgentRuntime.ClaudeCode]: claudeCodeAdapter,
	[AgentRuntime.Codex]: codexAdapter,
	[AgentRuntime.Gemini]: geminiAdapter,
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
export function buildMcpInjection(
	runtime: AgentRuntime,
	descriptors: readonly McpDescriptor[],
	ctx: McpAdapterContext,
): McpInjection {
	const adapter = MCP_ADAPTERS[runtime];
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
	RuntimeMcpAdapter,
} from './types';
export { HEZO_MCP_SERVER_NAME } from './types';
export { validateInjection } from './validate';
