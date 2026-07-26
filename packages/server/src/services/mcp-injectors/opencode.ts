import { join } from 'node:path';
import type {
	McpHttpDescriptor,
	McpInjection,
	McpStdioDescriptor,
	RuntimeMcpAdapter,
} from './types';

/**
 * OpenCode runtime adapter.
 *
 * Writes a per-run `opencode.json` (pointed at via the `OPENCODE_CONFIG` env
 * var) carrying the MCP server block. Remote MCP servers use `type:"remote"`
 * with an inline `Authorization` header; local ones use `type:"local"` with a
 * command array.
 *
 * Unlike the other runtimes, OpenCode has NO completeness Stop-hook judge: its
 * plugin API cannot block-and-continue the agent loop in headless `opencode
 * run` (the `session.idle` event only fires after the loop has already torn
 * down — upstream sst/opencode#16626 tracks adding a `session.stopping` hook).
 * We therefore deliberately omit the judge for OpenCode, accepting the same
 * fail-open posture used for subscription-auth runtimes. Provider auth
 * (OPENROUTER_API_KEY) is supplied via container env by the runner, so no
 * secret is written to the config file.
 */

interface OpencodeRemoteServer {
	type: 'remote';
	url: string;
	enabled: true;
	timeout: number;
	headers?: Record<string, string>;
}

interface OpencodeLocalServer {
	type: 'local';
	command: string[];
	enabled: true;
	timeout: number;
	environment?: Record<string, string>;
}

type OpencodeServer = OpencodeRemoteServer | OpencodeLocalServer;

interface OpencodeConfig {
	$schema: string;
	mcp?: Record<string, OpencodeServer>;
	/**
	 * OpenCode's tool gate. Unlike the other runtimes this is **top-level**, not a
	 * key on the server entry (whose only switch is the whole-server `enabled`) —
	 * a flat map of tool-name pattern to boolean, where a later, more specific key
	 * overrides an earlier wildcard.
	 */
	tools?: Record<string, boolean>;
}

const CONFIG_BASENAME = 'opencode.json';

// OpenCode's per-MCP-server request timeout (`mcp.<name>.timeout`) defaults to a
// mere 5000 ms — any Hezo MCP tool call that takes longer than 5s fails outright.
// There is no env-var override (OpenCode reads only a fixed env-var set, none
// timeout-related), so we stamp a generous per-server timeout into the
// `opencode.json` the injector already writes. 10 min matches the other runtimes'
// MCP ceilings and is safely above any real Hezo tool call.
const MCP_REQUEST_TIMEOUT_MS = 600_000;

function buildRemoteServer(d: McpHttpDescriptor): OpencodeRemoteServer {
	const headers: Record<string, string> = { ...(d.headers ?? {}) };
	if (d.bearerToken) headers.Authorization = `Bearer ${d.bearerToken}`;
	const server: OpencodeRemoteServer = {
		type: 'remote',
		url: d.url,
		enabled: true,
		timeout: MCP_REQUEST_TIMEOUT_MS,
	};
	if (Object.keys(headers).length > 0) server.headers = headers;
	return server;
}

function buildLocalServer(d: McpStdioDescriptor): OpencodeLocalServer {
	const server: OpencodeLocalServer = {
		type: 'local',
		command: [d.command, ...(d.args ?? [])],
		enabled: true,
		timeout: MCP_REQUEST_TIMEOUT_MS,
	};
	if (d.env && Object.keys(d.env).length > 0) server.environment = d.env;
	return server;
}

export const opencodeAdapter: RuntimeMcpAdapter = {
	capabilities: {
		transport: 'streamable-http',
		bearerTokenStorage: 'inline',
		requiresHomeDir: true,
	},
	build(descriptors, ctx): McpInjection {
		if (!ctx.hostHomeDir || !ctx.containerHomeDir) {
			throw new Error('opencode mcp adapter requires hostHomeDir and containerHomeDir');
		}

		const config: OpencodeConfig = { $schema: 'https://opencode.ai/config.json' };
		if (descriptors.length > 0) {
			const mcp: Record<string, OpencodeServer> = {};
			for (const d of descriptors) {
				mcp[d.name] = d.kind === 'http' ? buildRemoteServer(d) : buildLocalServer(d);
			}
			config.mcp = mcp;

			// Deny each restricted server's whole namespace, then re-allow its
			// enabled tools. Insertion order is precedence order, so the wildcard
			// has to be written before the specific keys. A server with no
			// allowlist contributes nothing, and when none is restricted the
			// `tools` key is omitted entirely — an unrestricted run's config stays
			// byte-identical to what it was before method access existed.
			const tools: Record<string, boolean> = {};
			for (const d of descriptors) {
				if (!d.enabledTools) continue;
				tools[`${d.name}*`] = false;
				for (const tool of d.enabledTools) tools[`${d.name}_${tool}`] = true;
			}
			if (Object.keys(tools).length > 0) config.tools = tools;
		}

		const contents = `${JSON.stringify(config, null, 2)}\n`;
		const configContainerPath = join(ctx.containerHomeDir, CONFIG_BASENAME);

		return {
			cliArgs: [],
			envEntries: [`OPENCODE_CONFIG=${configContainerPath}`],
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
