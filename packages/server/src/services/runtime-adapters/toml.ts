import type { McpHttpDescriptor, McpStdioDescriptor } from './types';

/**
 * Shared TOML rendering helpers for the runtime MCP adapters whose CLIs read a
 * `config.toml` (Codex). Centralised here so the escaper / key sanitiser /
 * MCP-server block renderer live in one place.
 */

export const TOML_KEY_RE = /^[A-Za-z0-9_-]+$/;

export function escapeTomlBasicString(value: string): string {
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

export function tomlArray(values: readonly string[]): string {
	return `[${values.map(escapeTomlBasicString).join(', ')}]`;
}

export function tomlInlineTable(entries: Record<string, string>): string {
	const parts: string[] = [];
	for (const [k, v] of Object.entries(entries)) {
		const key = TOML_KEY_RE.test(k) ? k : escapeTomlBasicString(k);
		parts.push(`${key} = ${escapeTomlBasicString(v)}`);
	}
	return `{ ${parts.join(', ')} }`;
}

/** Sanitize an arbitrary name into a bare TOML-key segment. */
export function safeName(name: string): string {
	const cleaned = name.replace(/[^A-Za-z0-9_-]/g, '_');
	return cleaned.length > 0 ? cleaned : '_';
}

export function bearerEnvVarName(descriptorName: string): string {
	return `HEZO_MCP_BEARER_TOKEN_${safeName(descriptorName).toUpperCase()}`;
}

/**
 * Render an `[mcp_servers.<name>]` block for an HTTP MCP server, the shape the
 * Codex CLI expects. Bearer tokens are referenced by env-var name
 * (`bearer_token_env_var`) rather than inlined; the caller exports the matching
 * `HEZO_MCP_BEARER_TOKEN_*` env entry.
 */
export function renderHttpBlock(d: McpHttpDescriptor): string {
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

/** Render an `[mcp_servers.<name>]` block for a stdio MCP server. */
export function renderStdioBlock(d: McpStdioDescriptor): string {
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
