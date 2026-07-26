import { join } from 'node:path';
import { escapeTomlBasicString, safeName, TOML_KEY_RE, tomlArray } from './toml';
import type {
	McpHttpDescriptor,
	McpInjection,
	McpStdioDescriptor,
	RuntimeMcpAdapter,
} from './types';

/**
 * xAI Grok Build (`grok`) CLI runtime adapter.
 *
 * The grok CLI reads its config from `$GROK_HOME/config.toml` (GROK_HOME is set
 * per-run to the home mount — see SUBSCRIPTION_LAYOUTS). MCP servers are declared
 * as `[mcp_servers.<name>]` tables: HTTP servers carry a `url` + `enabled` and an
 * inline `[mcp_servers.<name>.headers]` sub-table for the bearer `Authorization`
 * header (verified against `grok mcp add`); stdio servers carry `command`/`args`
 * plus an optional `[mcp_servers.<name>.env]` sub-table. We also stamp
 * `[cli] auto_update = false` so the CLI never phones home for an update mid-run.
 *
 * Unlike the Claude Code / Codex / Gemini adapters, Grok gets NO completeness
 * Stop-hook judge: Grok's hooks advertise `blockingEvents: ["pre_tool_use"]`
 * only (confirmed from the CLI's ACP handshake), so its `Stop`/`SessionEnd`
 * hooks are passive and cannot block-and-continue the agent loop the way Hezo's
 * judge requires. We therefore run fail-open, the same posture as OpenCode.
 *
 * The `grok` CLI reports no token usage on its stdout stream; per-run cost is
 * recovered from the `--debug-file` tracing spans (the runner adds that flag and
 * parses the file — see `extractGrokUsageFromDebugLog` in agent-stream-parser.ts).
 * The provider credential (XAI_API_KEY) is supplied via container env by the
 * runner, so no secret is written into the config file.
 */

const CONFIG_BASENAME = 'config.toml';

// A slow-starting stdio MCP server (e.g. an `npx -y <pkg>` cold start that must
// download the package) can exceed Grok's 30s default MCP startup handshake
// (`[mcp_servers.<name>].startup_timeout_sec`) and be dropped at launch. Give it
// a generous ceiling. (Grok's per-tool-call default, `tool_timeout_sec`, is
// already 6000s, so we leave that alone.)
const MCP_STARTUP_TIMEOUT_SEC = 120;

// Grok's bash toolset defaults to a 120s foreground `timeout_secs`; on expiry it
// auto-backgrounds rather than killing the command (`auto_background_on_timeout`
// is true by default), but raising the foreground window lets a normal long
// build/test finish inline instead of being pushed to a background poll loop.
const BASH_TIMEOUT_SEC = 3600;

/** Render a TOML key: bare when it only uses `[A-Za-z0-9_-]`, else quoted. */
function tomlKey(name: string): string {
	return TOML_KEY_RE.test(name) ? name : escapeTomlBasicString(name);
}

/** Render a `[mcp_servers.<name>.<sub>]` table of string values. */
function renderSubTable(serverKey: string, sub: string, entries: Record<string, string>): string {
	const lines = [`[mcp_servers.${serverKey}.${sub}]`];
	for (const [k, v] of Object.entries(entries)) {
		lines.push(`${tomlKey(k)} = ${escapeTomlBasicString(v)}`);
	}
	return lines.join('\n');
}

function renderHttpServer(d: McpHttpDescriptor): string {
	const key = safeName(d.name);
	const blocks: string[] = [
		[
			`[mcp_servers.${key}]`,
			`url = ${escapeTomlBasicString(d.url)}`,
			'enabled = true',
			`startup_timeout_sec = ${MCP_STARTUP_TIMEOUT_SEC}`,
		].join('\n'),
	];
	const headers: Record<string, string> = { ...(d.headers ?? {}) };
	if (d.bearerToken) headers.Authorization = `Bearer ${d.bearerToken}`;
	if (Object.keys(headers).length > 0) {
		blocks.push(renderSubTable(key, 'headers', headers));
	}
	return blocks.join('\n\n');
}

function renderStdioServer(d: McpStdioDescriptor): string {
	const key = safeName(d.name);
	const lines = [`[mcp_servers.${key}]`, `command = ${escapeTomlBasicString(d.command)}`];
	if (d.args && d.args.length > 0) lines.push(`args = ${tomlArray(d.args)}`);
	lines.push('enabled = true');
	lines.push(`startup_timeout_sec = ${MCP_STARTUP_TIMEOUT_SEC}`);
	const blocks: string[] = [lines.join('\n')];
	if (d.env && Object.keys(d.env).length > 0) {
		blocks.push(renderSubTable(key, 'env', d.env));
	}
	return blocks.join('\n\n');
}

export const grokAdapter: RuntimeMcpAdapter = {
	capabilities: {
		transport: 'streamable-http',
		bearerTokenStorage: 'inline',
		requiresHomeDir: true,
	},
	build(descriptors, ctx): McpInjection {
		if (!ctx.hostHomeDir || !ctx.containerHomeDir) {
			throw new Error('grok mcp adapter requires hostHomeDir and containerHomeDir');
		}

		// A descriptor's `enabledTools` is intentionally ignored here: Grok
		// documents no per-server tool filter, and inventing a TOML key risks the
		// CLI rejecting the whole config and breaking every Grok run. Restricted
		// connectors are still enforced — the egress proxy refuses a `tools/call`
		// naming a disabled method regardless of runtime. See
		// RUNTIME_SUPPORTS_MCP_TOOL_FILTER in @hezo/shared.
		const blocks: string[] = [];
		for (const d of descriptors) {
			blocks.push(d.kind === 'http' ? renderHttpServer(d) : renderStdioServer(d));
		}
		// Give long foreground shell commands room to finish inline before Grok
		// auto-backgrounds them at the 120s default.
		blocks.push(`[toolset.bash]\ntimeout_secs = ${BASH_TIMEOUT_SEC}`);
		// Never let the CLI self-update mid-run inside the locked-down container.
		blocks.push('[cli]\nauto_update = false');
		const contents = `${blocks.join('\n\n')}\n`;

		return {
			cliArgs: [],
			envEntries: [],
			files: [
				{
					hostPath: join(ctx.hostHomeDir, CONFIG_BASENAME),
					mode: 0o600,
					contents,
				},
			],
		};
	},
};
