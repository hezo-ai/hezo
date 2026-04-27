import type { McpDescriptor, McpInjection, RuntimeMcpAdapter } from './types';

interface ClaudeMcpServerEntry {
	type: 'http';
	url: string;
	headers?: Record<string, string>;
}

function buildServerEntry(descriptor: McpDescriptor): ClaudeMcpServerEntry {
	const entry: ClaudeMcpServerEntry = { type: 'http', url: descriptor.url };
	if (descriptor.bearerToken) {
		entry.headers = { Authorization: `Bearer ${descriptor.bearerToken}` };
	}
	return entry;
}

export const claudeCodeAdapter: RuntimeMcpAdapter = {
	capabilities: {
		transport: 'streamable-http',
		bearerTokenStorage: 'inline',
		requiresHomeDir: false,
	},
	build(descriptors: readonly McpDescriptor[]): McpInjection {
		const mcpServers: Record<string, ClaudeMcpServerEntry> = {};
		for (const descriptor of descriptors) {
			mcpServers[descriptor.name] = buildServerEntry(descriptor);
		}

		const cliArgs =
			descriptors.length === 0
				? []
				: ['--mcp-config', JSON.stringify({ mcpServers }), '--strict-mcp-config'];

		return {
			cliArgs,
			envEntries: [],
			files: [],
		};
	},
};
