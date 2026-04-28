import { join } from 'node:path';
import type { McpDescriptor, McpInjection, RuntimeMcpAdapter } from './types';

const TOML_KEY_RE = /^[A-Za-z0-9_-]+$/;

function escapeTomlBasicString(value: string): string {
	let out = '';
	for (const ch of value) {
		const code = ch.codePointAt(0)!;
		if (ch === '\\') out += '\\\\';
		else if (ch === '"') out += '\\"';
		else if (ch === '\n') out += '\\n';
		else if (ch === '\r') out += '\\r';
		else if (ch === '\t') out += '\\t';
		else if (code < 0x20) out += `\\u${code.toString(16).padStart(4, '0')}`;
		else out += ch;
	}
	return `"${out}"`;
}

/**
 * Sanitize a descriptor name for use as a TOML bare key and as the suffix in
 * the bearer-token env var name. Only [A-Za-z0-9_-] survive; everything else
 * becomes "_". Names that would collapse to empty fall back to a stable hash.
 */
function safeName(name: string): string {
	const cleaned = name.replace(/[^A-Za-z0-9_-]/g, '_');
	return cleaned.length > 0 ? cleaned : '_';
}

function bearerEnvVarName(descriptorName: string): string {
	return `HEZO_MCP_BEARER_TOKEN_${safeName(descriptorName).toUpperCase()}`;
}

function renderServerBlock(descriptor: McpDescriptor): string {
	const key = safeName(descriptor.name);
	if (!TOML_KEY_RE.test(key)) {
		throw new Error(`mcp descriptor name produced invalid TOML key: ${descriptor.name}`);
	}
	const lines: string[] = [`[mcp_servers.${key}]`];
	lines.push(`url = ${escapeTomlBasicString(descriptor.url)}`);
	if (descriptor.bearerToken) {
		// Codex's MCP transport config does not currently support arbitrary
		// custom request headers, so the agent JWT stays on `Authorization:
		// Bearer ...`. The auth middleware accepts this for board / API-key
		// callers as a fallback, and Codex MCP traffic does not transit the
		// secret-proxy substitution path (it goes to /mcp), so the conflict
		// the proxy avoids does not apply here.
		lines.push(
			`bearer_token_env_var = ${escapeTomlBasicString(bearerEnvVarName(descriptor.name))}`,
		);
	}
	return lines.join('\n');
}

export const codexAdapter: RuntimeMcpAdapter = {
	capabilities: {
		transport: 'streamable-http',
		bearerTokenStorage: 'env-var',
		requiresHomeDir: true,
	},
	build(descriptors, ctx): McpInjection {
		if (descriptors.length === 0) {
			return { cliArgs: [], envEntries: [], files: [] };
		}
		if (!ctx.hostHomeDir) {
			throw new Error('codex mcp adapter requires hostHomeDir');
		}

		const blocks = descriptors.map(renderServerBlock);
		const contents = `${blocks.join('\n\n')}\n`;

		const envEntries: string[] = [];
		for (const descriptor of descriptors) {
			if (descriptor.bearerToken) {
				envEntries.push(`${bearerEnvVarName(descriptor.name)}=${descriptor.bearerToken}`);
			}
		}

		return {
			cliArgs: [],
			envEntries,
			files: [
				{
					hostPath: join(ctx.hostHomeDir, 'config.toml'),
					mode: 0o600,
					contents,
				},
			],
		};
	},
};
