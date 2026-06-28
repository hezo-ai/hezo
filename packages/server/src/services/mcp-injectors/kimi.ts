import { join } from 'node:path';
import { AiAuthMethod, KIMI_CODING_BASE_URL } from '@hezo/shared';
import { buildKimiJudgeScript } from '../stop-hook-prompt';
import { escapeTomlBasicString, TOML_KEY_RE, tomlTableKey } from './toml';
import type {
	McpAdapterContext,
	McpHttpDescriptor,
	McpInjection,
	McpStdioDescriptor,
	RuntimeMcpAdapter,
} from './types';

/**
 * Kimi Code CLI runtime adapter.
 *
 * Kimi reads its config from `$KIMI_CODE_HOME/config.toml` (the home-mount env
 * entry points it at the per-run dir) and MCP servers from a sibling
 * `mcp.json`. The model the user selected is declared as a `[models.<id>]`
 * block (with the schema-required `max_context_size`) and set as
 * `default_model`, because kimi only accepts models declared in config.
 * `default_yolo = true` provides non-interactive auto-approval — the `--yolo`
 * CLI flag is rejected in `--prompt` mode.
 *
 * The provider block depends on the auth method:
 * - **api key**: a custom `[providers.kimi-for-coding]` block carries the
 *   `api_key` (the kimi CLI takes its api_key from config, not env; KIMI_API_KEY
 *   is still exported for the Stop-hook judge).
 * - **subscription**: the built-in managed provider `[providers."managed:kimi-code"]`
 *   with a `[providers."managed:kimi-code".oauth]` ref (`storage = "file"`,
 *   `key = "oauth/kimi-code"`) that points the CLI at the OAuth credential file
 *   Hezo mounts at `<KIMI_CODE_HOME>/credentials/kimi-code.json`.
 *
 * Completeness is enforced by a `[[hooks]]` `event = "Stop"` command that runs
 * the judge script; on incomplete work the script exits 2 with the reason on
 * stderr, which kimi feeds back to the model to keep it working.
 */

/** Custom provider id for api-key auth. */
const API_KEY_PROVIDER_NAME = 'kimi-for-coding';
/** Built-in managed OAuth provider id (subscription auth). */
const MANAGED_PROVIDER_NAME = 'managed:kimi-code';
/** OAuth credential key; resolves to `<KIMI_CODE_HOME>/credentials/kimi-code.json`. */
const MANAGED_OAUTH_KEY = 'oauth/kimi-code';
const DEFAULT_MODEL = 'kimi-for-coding';
/** kimi-for-coding context window; `[models.*]` requires a positive value. */
const DEFAULT_MAX_CONTEXT_SIZE = 262144;
const JUDGE_SCRIPT_BASENAME = 'stop-hook-judge.mjs';
const CONFIG_BASENAME = 'config.toml';
const MCP_BASENAME = 'mcp.json';

/** Sanitize a model id into a TOML-table key (`[models.<key>]`). */
function modelKey(model: string): string {
	const cleaned = model.replace(/[^A-Za-z0-9_-]/g, '_');
	return cleaned.length > 0 && TOML_KEY_RE.test(cleaned) ? cleaned : DEFAULT_MODEL;
}

interface KimiMcpRemote {
	url: string;
	headers?: Record<string, string>;
}

interface KimiMcpLocal {
	command: string;
	args?: string[];
	env?: Record<string, string>;
}

function buildMcpRemote(d: McpHttpDescriptor): KimiMcpRemote {
	const headers: Record<string, string> = { ...(d.headers ?? {}) };
	if (d.bearerToken) headers.Authorization = `Bearer ${d.bearerToken}`;
	const entry: KimiMcpRemote = { url: d.url };
	if (Object.keys(headers).length > 0) entry.headers = headers;
	return entry;
}

function buildMcpLocal(d: McpStdioDescriptor): KimiMcpLocal {
	const entry: KimiMcpLocal = { command: d.command };
	if (d.args?.length) entry.args = d.args;
	if (d.env && Object.keys(d.env).length > 0) entry.env = d.env;
	return entry;
}

function buildConfigToml(ctx: McpAdapterContext, judgeScriptContainerPath: string): string {
	const isSubscription = ctx.authMethod === AiAuthMethod.Subscription;
	const providerName = isSubscription ? MANAGED_PROVIDER_NAME : API_KEY_PROVIDER_NAME;
	const rawModel = ctx.model?.trim() ? ctx.model.trim() : DEFAULT_MODEL;
	const key = modelKey(rawModel);

	// Top-level keys must precede every [table] header in TOML.
	const blocks: string[] = [
		[`default_model = ${escapeTomlBasicString(key)}`, 'default_yolo = true'].join('\n'),
	];

	const providerLines = [
		`[providers.${tomlTableKey(providerName)}]`,
		'type = "kimi"',
		`base_url = ${escapeTomlBasicString(KIMI_CODING_BASE_URL)}`,
	];
	// api-key auth: credential goes inline. subscription auth: no api_key — the
	// OAuth ref below points at the mounted credential file instead.
	if (!isSubscription && ctx.providerApiKey) {
		providerLines.push(`api_key = ${escapeTomlBasicString(ctx.providerApiKey)}`);
	}
	blocks.push(providerLines.join('\n'));

	// Subscription: an [providers.<name>.oauth] sub-table tells the CLI to load
	// the managed-Kimi-Code credential from its file store (Hezo mounts it at
	// <KIMI_CODE_HOME>/credentials/kimi-code.json). Must follow the parent table.
	if (isSubscription) {
		blocks.push(
			[
				`[providers.${tomlTableKey(providerName)}.oauth]`,
				'storage = "file"',
				`key = ${escapeTomlBasicString(MANAGED_OAUTH_KEY)}`,
			].join('\n'),
		);
	}

	blocks.push(
		[
			`[models.${key}]`,
			`provider = ${escapeTomlBasicString(providerName)}`,
			`model = ${escapeTomlBasicString(rawModel)}`,
			`max_context_size = ${DEFAULT_MAX_CONTEXT_SIZE}`,
		].join('\n'),
	);

	blocks.push(
		[
			'[[hooks]]',
			'event = "Stop"',
			`command = ${escapeTomlBasicString(`node ${judgeScriptContainerPath}`)}`,
			'timeout = 30',
		].join('\n'),
	);

	return `${blocks.join('\n\n')}\n`;
}

export const kimiAdapter: RuntimeMcpAdapter = {
	capabilities: {
		transport: 'streamable-http',
		bearerTokenStorage: 'inline',
		requiresHomeDir: true,
	},
	build(descriptors, ctx): McpInjection {
		if (!ctx.hostHomeDir || !ctx.containerHomeDir) {
			throw new Error('kimi mcp adapter requires hostHomeDir and containerHomeDir');
		}

		const judgeScriptHostPath = join(ctx.hostHomeDir, JUDGE_SCRIPT_BASENAME);
		const judgeScriptContainerPath = join(ctx.containerHomeDir, JUDGE_SCRIPT_BASENAME);

		const mcpServers: Record<string, KimiMcpRemote | KimiMcpLocal> = {};
		for (const d of descriptors) {
			mcpServers[d.name] = d.kind === 'http' ? buildMcpRemote(d) : buildMcpLocal(d);
		}
		const mcpContents = `${JSON.stringify({ mcpServers }, null, 2)}\n`;

		return {
			cliArgs: [],
			envEntries: [],
			files: [
				{
					hostPath: join(ctx.hostHomeDir, CONFIG_BASENAME),
					mode: 0o600,
					contents: buildConfigToml(ctx, judgeScriptContainerPath),
				},
				{
					hostPath: join(ctx.hostHomeDir, MCP_BASENAME),
					mode: 0o600,
					contents: mcpContents,
				},
				{
					hostPath: judgeScriptHostPath,
					mode: 0o700,
					contents: buildKimiJudgeScript(),
				},
			],
		};
	},
};
