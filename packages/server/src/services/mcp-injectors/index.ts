import { AgentRuntime } from '@hezo/shared';
import { claudeCodeAdapter } from './claude-code';
import { codexAdapter } from './codex';
import { geminiAdapter } from './gemini';
import type { RuntimeMcpAdapter } from './types';

/**
 * Per-runtime MCP adapter table. The `Record<AgentRuntime, ...>` typing means
 * adding a new runtime to the AgentRuntime enum without adding an adapter
 * here is a TypeScript error — every runtime we support gets MCP exposure.
 */
export const MCP_ADAPTERS: Record<AgentRuntime, RuntimeMcpAdapter> = {
	[AgentRuntime.ClaudeCode]: claudeCodeAdapter,
	[AgentRuntime.Codex]: codexAdapter,
	[AgentRuntime.Gemini]: geminiAdapter,
};

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
export { validateInjection } from './validate';
