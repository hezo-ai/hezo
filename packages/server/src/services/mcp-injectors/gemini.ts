import { join } from 'node:path';
import type { McpDescriptor, McpInjection, RuntimeMcpAdapter } from './types';

interface GeminiMcpServerEntry {
	httpUrl: string;
	headers?: Record<string, string>;
}

function buildServerEntry(descriptor: McpDescriptor): GeminiMcpServerEntry {
	const entry: GeminiMcpServerEntry = { httpUrl: descriptor.url };
	if (descriptor.bearerToken) {
		// Hezo agent JWTs use a custom header so the upstream-bound
		// `Authorization` header on agent-proxy requests can carry secret
		// placeholders without colliding with our own auth.
		entry.headers = { 'X-Hezo-Agent-Token': descriptor.bearerToken };
	}
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

		const mcpServers: Record<string, GeminiMcpServerEntry> = {};
		for (const descriptor of descriptors) {
			mcpServers[descriptor.name] = buildServerEntry(descriptor);
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
