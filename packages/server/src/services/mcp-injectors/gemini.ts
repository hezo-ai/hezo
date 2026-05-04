import { join } from 'node:path';
import type {
	McpHttpDescriptor,
	McpInjection,
	McpStdioDescriptor,
	RuntimeMcpAdapter,
} from './types';

interface GeminiHttpEntry {
	httpUrl: string;
	headers?: Record<string, string>;
}

interface GeminiStdioEntry {
	command: string;
	args?: string[];
	env?: Record<string, string>;
}

type GeminiServerEntry = GeminiHttpEntry | GeminiStdioEntry;

function buildHttpEntry(d: McpHttpDescriptor): GeminiHttpEntry {
	const entry: GeminiHttpEntry = { httpUrl: d.url };
	const headers: Record<string, string> = { ...(d.headers ?? {}) };
	if (d.bearerToken) headers.Authorization = `Bearer ${d.bearerToken}`;
	if (Object.keys(headers).length > 0) entry.headers = headers;
	return entry;
}

function buildStdioEntry(d: McpStdioDescriptor): GeminiStdioEntry {
	const entry: GeminiStdioEntry = { command: d.command };
	if (d.args?.length) entry.args = d.args;
	if (d.env && Object.keys(d.env).length > 0) entry.env = d.env;
	return entry;
}

export const geminiAdapter: RuntimeMcpAdapter = {
	capabilities: {
		transport: 'streamable-http',
		bearerTokenStorage: 'inline',
		requiresHomeDir: true,
	},
	build(descriptors, ctx): McpInjection {
		if (descriptors.length === 0) {
			return { cliArgs: [], envEntries: [], files: [] };
		}
		if (!ctx.hostHomeDir) {
			throw new Error('gemini mcp adapter requires hostHomeDir');
		}

		const mcpServers: Record<string, GeminiServerEntry> = {};
		for (const d of descriptors) {
			mcpServers[d.name] = d.kind === 'http' ? buildHttpEntry(d) : buildStdioEntry(d);
		}

		const contents = `${JSON.stringify({ mcpServers }, null, 2)}\n`;

		return {
			cliArgs: [],
			envEntries: [],
			files: [
				{
					hostPath: join(ctx.hostHomeDir, '.gemini', 'settings.json'),
					mode: 0o600,
					contents,
				},
			],
		};
	},
};
