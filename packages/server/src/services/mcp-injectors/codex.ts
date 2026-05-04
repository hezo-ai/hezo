import { join } from 'node:path';
import type {
	McpDescriptor,
	McpHttpDescriptor,
	McpInjection,
	McpStdioDescriptor,
	RuntimeMcpAdapter,
} from './types';

const TOML_KEY_RE = /^[A-Za-z0-9_-]+$/;

function escapeTomlBasicString(value: string): string {
	let out = '';
	for (const ch of value) {
		const code = ch.codePointAt(0);
		if (code === undefined) continue;
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

function tomlArray(values: readonly string[]): string {
	return `[${values.map(escapeTomlBasicString).join(', ')}]`;
}

function tomlInlineTable(entries: Record<string, string>): string {
	const parts: string[] = [];
	for (const [k, v] of Object.entries(entries)) {
		const key = TOML_KEY_RE.test(k) ? k : escapeTomlBasicString(k);
		parts.push(`${key} = ${escapeTomlBasicString(v)}`);
	}
	return `{ ${parts.join(', ')} }`;
}

function safeName(name: string): string {
	const cleaned = name.replace(/[^A-Za-z0-9_-]/g, '_');
	return cleaned.length > 0 ? cleaned : '_';
}

function bearerEnvVarName(descriptorName: string): string {
	return `HEZO_MCP_BEARER_TOKEN_${safeName(descriptorName).toUpperCase()}`;
}

function renderHttpBlock(d: McpHttpDescriptor): string {
	const key = safeName(d.name);
	if (!TOML_KEY_RE.test(key)) {
		throw new Error(`mcp descriptor name produced invalid TOML key: ${d.name}`);
	}
	const lines: string[] = [`[mcp_servers.${key}]`];
	lines.push(`url = ${escapeTomlBasicString(d.url)}`);
	if (d.bearerToken) {
		lines.push(`bearer_token_env_var = ${escapeTomlBasicString(bearerEnvVarName(d.name))}`);
	}
	if (d.headers && Object.keys(d.headers).length > 0) {
		lines.push(`headers = ${tomlInlineTable(d.headers)}`);
	}
	return lines.join('\n');
}

function renderStdioBlock(d: McpStdioDescriptor): string {
	const key = safeName(d.name);
	if (!TOML_KEY_RE.test(key)) {
		throw new Error(`mcp descriptor name produced invalid TOML key: ${d.name}`);
	}
	const lines: string[] = [`[mcp_servers.${key}]`];
	lines.push(`command = ${escapeTomlBasicString(d.command)}`);
	if (d.args && d.args.length > 0) lines.push(`args = ${tomlArray(d.args)}`);
	if (d.env && Object.keys(d.env).length > 0) lines.push(`env = ${tomlInlineTable(d.env)}`);
	return lines.join('\n');
}

export const codexAdapter: RuntimeMcpAdapter = {
	capabilities: {
		transport: 'streamable-http',
		bearerTokenStorage: 'env-var',
		requiresHomeDir: true,
	},
	build(descriptors: readonly McpDescriptor[], ctx): McpInjection {
		if (descriptors.length === 0) {
			return { cliArgs: [], envEntries: [], files: [] };
		}
		if (!ctx.hostHomeDir) {
			throw new Error('codex mcp adapter requires hostHomeDir');
		}

		const blocks = descriptors.map((d) =>
			d.kind === 'http' ? renderHttpBlock(d) : renderStdioBlock(d),
		);
		const contents = `${blocks.join('\n\n')}\n`;

		const envEntries: string[] = [];
		for (const d of descriptors) {
			if (d.kind === 'http' && d.bearerToken) {
				envEntries.push(`${bearerEnvVarName(d.name)}=${d.bearerToken}`);
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
