import { join } from 'node:path';
import { buildClaudeCodeSettings } from '../stop-hook-prompt';
import type {
	McpDescriptor,
	McpHttpDescriptor,
	McpInjection,
	McpStdioDescriptor,
	RuntimeMcpAdapter,
} from './types';

interface ClaudeHttpEntry {
	type: 'http';
	url: string;
	headers?: Record<string, string>;
}

interface ClaudeStdioEntry {
	type: 'stdio';
	command: string;
	args?: string[];
	env?: Record<string, string>;
}

type ClaudeServerEntry = ClaudeHttpEntry | ClaudeStdioEntry;

function buildHttpEntry(d: McpHttpDescriptor): ClaudeHttpEntry {
	const entry: ClaudeHttpEntry = { type: 'http', url: d.url };
	const headers: Record<string, string> = { ...(d.headers ?? {}) };
	if (d.bearerToken) headers.Authorization = `Bearer ${d.bearerToken}`;
	if (Object.keys(headers).length > 0) entry.headers = headers;
	return entry;
}

function buildStdioEntry(d: McpStdioDescriptor): ClaudeStdioEntry {
	const entry: ClaudeStdioEntry = { type: 'stdio', command: d.command };
	if (d.args?.length) entry.args = d.args;
	if (d.env && Object.keys(d.env).length > 0) entry.env = d.env;
	return entry;
}

export const claudeCodeAdapter: RuntimeMcpAdapter = {
	capabilities: {
		transport: 'streamable-http',
		bearerTokenStorage: 'inline',
		requiresHomeDir: true,
	},
	build(descriptors: readonly McpDescriptor[], ctx): McpInjection {
		if (!ctx.hostHomeDir || !ctx.containerHomeDir) {
			throw new Error('claude-code mcp adapter requires hostHomeDir and containerHomeDir');
		}

		const mcpServers: Record<string, ClaudeServerEntry> = {};
		for (const d of descriptors) {
			mcpServers[d.name] = d.kind === 'http' ? buildHttpEntry(d) : buildStdioEntry(d);
		}

		const settingsHostPath = join(ctx.hostHomeDir, 'settings.json');
		const settingsContainerPath = join(ctx.containerHomeDir, 'settings.json');
		const settingsContents = `${JSON.stringify(buildClaudeCodeSettings(), null, 2)}\n`;

		const cliArgs: string[] = ['--settings', settingsContainerPath];
		if (descriptors.length > 0) {
			cliArgs.push('--mcp-config', JSON.stringify({ mcpServers }), '--strict-mcp-config');
		}

		return {
			cliArgs,
			envEntries: [],
			files: [
				{
					hostPath: settingsHostPath,
					mode: 0o600,
					contents: settingsContents,
				},
			],
		};
	},
};
