import { join } from 'node:path';
import {
	AgentEffort,
	OPENCODE_PROVIDER_KEY,
	opencodeModelArg,
	opencodeModelKey,
} from '@hezo/shared';
import type {
	McpAdapterContext,
	McpHttpDescriptor,
	McpInjection,
	McpStdioDescriptor,
	RuntimeAdapter,
} from './types';

/**
 * OpenCode runtime adapter.
 *
 * Writes a per-run `opencode.json` (pointed at via the `OPENCODE_CONFIG` env
 * var) carrying the MCP server block and the run's reasoning effort. Remote MCP
 * servers use `type:"remote"` with an inline `Authorization` header; local ones
 * use `type:"local"` with a command array.
 *
 * This file is also where OpenCode's effort lands: the CLI has no reasoning flag
 * or env var, so the level resolved for the run is written as `reasoning.effort`
 * on the model the run was launched with. See {@link buildReasoningProviders}.
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

/**
 * A model entry in OpenCode's provider block. `options` is passed straight to the
 * AI-SDK provider, so `reasoning` reaches OpenRouter's unified reasoning
 * parameter. OpenCode merges this with its built-in models.dev catalog rather
 * than replacing it, so naming one model here leaves every other model intact.
 */
interface OpencodeModel {
	options: { reasoning: { effort: string } };
}

interface OpencodeProvider {
	models: Record<string, OpencodeModel>;
}

interface OpencodeConfig {
	$schema: string;
	mcp?: Record<string, OpencodeServer>;
	provider?: Record<string, OpencodeProvider>;
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

/**
 * The `provider` block carrying the run's reasoning effort, or null when there is
 * nothing to key it on.
 *
 * Keyed on the run's own model because OpenCode's `models` map has no wildcard:
 * a guessed key configures a model the run is not using, which is worse than no
 * block at all. So a run that pins no model (and takes whatever OpenCode's own
 * default is) reasons at that model's default instead.
 */
function buildReasoningProviders(ctx: McpAdapterContext): Record<string, OpencodeProvider> | null {
	const { provider, runModel, effort } = ctx;
	if (!provider || !effort) return null;
	const providerKey = OPENCODE_PROVIDER_KEY[provider];
	const model = runModel?.trim();
	if (!providerKey || !model) return null;
	return {
		[providerKey]: {
			models: {
				[opencodeModelKey(provider, model)]: {
					options: { reasoning: { effort: OPENCODE_REASONING_EFFORT[effort] } },
				},
			},
		},
	};
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

/**
 * OpenCode's models are reached through OpenRouter, whose unified `reasoning`
 * parameter takes `none|minimal|low|medium|high|xhigh|max`. Hezo's ladder is a
 * subset spelled identically, so the mapping is 1:1 - and because `none` is never
 * produced, every OpenCode run asks the model to reason.
 *
 * A model that cannot reason ignores the parameter: OpenRouter only rejects an
 * unsupported one when the caller sets `require_parameters`, which nothing here
 * does.
 *
 * This is written into the per-run `opencode.json` below rather than onto argv:
 * `--variant` names a variant that must be declared in that same config first,
 * and this adapter is the only place holding the model id the config is keyed on.
 * So the runtime declares no `applyEffort` and is steered, on the prompt side, by
 * the portable directive.
 */
const OPENCODE_REASONING_EFFORT: Record<AgentEffort, string> = {
	[AgentEffort.Minimal]: 'minimal',
	[AgentEffort.Low]: 'low',
	[AgentEffort.Medium]: 'medium',
	[AgentEffort.High]: 'high',
	[AgentEffort.Max]: 'max',
};

export const opencodeAdapter: RuntimeAdapter = {
	capabilities: {
		transport: 'streamable-http',
		bearerTokenStorage: 'inline',
		requiresHomeDir: true,
	},
	modelArg: opencodeModelArg,
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

		const providers = buildReasoningProviders(ctx);
		if (providers) config.provider = providers;

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
