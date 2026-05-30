/**
 * Per-provider information used by the Connectors page and the
 * `register_connector` MCP tool to set up an MCP-server connection with
 * UI-mediated OAuth.
 *
 * Entries are forward-compatible: agents can also register connectors at
 * runtime for providers not in this registry (the registry is a UX aid for
 * autocomplete and default skill-file URLs, not a gating list).
 */

export type McpTransport = 'http' | 'sse' | 'stdio';

export interface ConnectorCapability {
	id: string;
	displayName: string;
	mcpServer: {
		url?: string;
		cmd?: string;
		transport: McpTransport;
	};
	skillFile?: {
		url: string;
	};
	allowedHosts: string[];
	/**
	 * Explicit OAuth scope list to request during DCR + authorize. When set,
	 * overrides the Authorization Server's `scopes_supported`. Required for
	 * providers whose AS advertises a broad scope universe (e.g. GitHub's
	 * MCP server, which surfaces every standard GitHub OAuth scope and would
	 * otherwise produce an unreviewable consent screen).
	 */
	scopes?: string[];
	/**
	 * Paste fallback for providers that don't expose OAuth on their MCP
	 * server. Omit when OAuth is the only path.
	 */
	paste?: {
		secretNameHint: string;
		keyPrefix?: string;
		helpUrl: string;
	};
}

export const CONNECTOR_CAPABILITIES: Record<string, ConnectorCapability> = {
	github: {
		id: 'github',
		displayName: 'GitHub',
		mcpServer: { url: 'https://api.githubcopilot.com/mcp/', transport: 'http' },
		allowedHosts: ['api.githubcopilot.com', 'api.github.com', 'github.com'],
		scopes: ['repo', 'workflow', 'read:org', 'write:ssh_signing_key', 'write:public_key'],
	},
	datocms: {
		id: 'datocms',
		displayName: 'DatoCMS',
		mcpServer: { url: 'https://mcp.datocms.com', transport: 'http' },
		skillFile: { url: 'https://www.datocms.com/docs/mcp-server/agent-skill.md' },
		allowedHosts: ['mcp.datocms.com', '*.datocms.com'],
	},
	linear: {
		id: 'linear',
		displayName: 'Linear',
		mcpServer: { url: 'https://mcp.linear.app/sse', transport: 'sse' },
		allowedHosts: ['mcp.linear.app', 'api.linear.app'],
	},
	vercel: {
		id: 'vercel',
		displayName: 'Vercel',
		mcpServer: { url: 'https://mcp.vercel.com', transport: 'http' },
		allowedHosts: ['mcp.vercel.com', 'api.vercel.com'],
	},
	cloudflare: {
		id: 'cloudflare',
		displayName: 'Cloudflare',
		mcpServer: { url: 'https://mcp.cloudflare.com', transport: 'http' },
		allowedHosts: ['mcp.cloudflare.com', 'api.cloudflare.com'],
	},
	sentry: {
		id: 'sentry',
		displayName: 'Sentry',
		mcpServer: { url: 'https://mcp.sentry.dev', transport: 'http' },
		allowedHosts: ['mcp.sentry.dev', 'sentry.io', '*.sentry.io'],
	},
	notion: {
		id: 'notion',
		displayName: 'Notion',
		mcpServer: { url: 'https://mcp.notion.com', transport: 'http' },
		allowedHosts: ['mcp.notion.com', 'api.notion.com'],
	},
};

export function getConnectorCapability(id: string): ConnectorCapability | undefined {
	return CONNECTOR_CAPABILITIES[id];
}
