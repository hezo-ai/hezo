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

/**
 * OAuth 2.0 Device Authorization Grant (RFC 8628) configuration for providers
 * whose Authorization Server supports neither Dynamic Client Registration nor a
 * redirect-friendly secret-less client (GitHub, and similarly GitLab / Google /
 * Microsoft). The device flow needs only a pre-registered *public* client_id —
 * no redirect URI, no client secret — so it works on any self-hosted origin.
 *
 * Endpoints are plain public URLs. `clientIdEnv` names the env var holding the
 * instance's client_id; `clientIdDefault` is an optional committed public dev
 * fallback used outside production. `baseUrlEnv`, when set, lets tests (and
 * self-hosted GitHub Enterprise) redirect the endpoint origins.
 */
export interface DeviceAuthConfig {
	deviceCodeUrl: string;
	tokenUrl: string;
	clientIdEnv: string;
	clientIdDefault?: string;
	baseUrlEnv?: string;
}

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
	 * Token acquisition via the device flow instead of the default auth-code +
	 * PKCE + DCR path. Present only for providers whose AS can't do DCR. When
	 * set, the connector's Connect button drives the device flow; `auth-start`
	 * (DCR) is never used for it.
	 */
	deviceAuth?: DeviceAuthConfig;
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
		deviceAuth: {
			deviceCodeUrl: 'https://github.com/login/device/code',
			tokenUrl: 'https://github.com/login/oauth/access_token',
			clientIdEnv: 'GITHUB_OAUTH_CLIENT_ID',
			// Public OAuth-App client_id with device flow enabled; safe to commit.
			// Production overrides via GITHUB_OAUTH_CLIENT_ID.
			clientIdDefault: 'Ov23liSH5q35gMqGTKH9',
			baseUrlEnv: 'GITHUB_OAUTH_BASE_URL',
		},
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
