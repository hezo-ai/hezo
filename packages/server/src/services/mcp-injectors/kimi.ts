import { join } from 'node:path';
import { KIMI_CODING_BASE_URL } from '@hezo/shared';
import { buildKimiJudgeScript } from '../stop-hook-prompt';
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
 * `mcp.json`. The provider credential goes into the `[providers.kimi-for-coding]`
 * block — the kimi CLI takes its api_key from config, not env (KIMI_API_KEY is
 * still exported for the Stop-hook judge). The model the user selected is
 * declared as a `[models.<id>]` block and set as `default_model`, because kimi
 * only accepts models declared in config.
 *
 * Completeness is enforced by a `[[hooks]]` `event = "Stop"` command that runs
 * the judge script; on incomplete work the script exits 2 with the reason on
 * stderr, which kimi feeds back to the model to keep it working.
 */

const PROVIDER_NAME = 'kimi-for-coding';
const DEFAULT_MODEL = 'kimi-for-coding';
const JUDGE_SCRIPT_BASENAME = 'stop-hook-judge.mjs';
const CONFIG_BASENAME = 'config.toml';
const MCP_BASENAME = 'mcp.json';

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
	const rawModel = ctx.model?.trim() ? ctx.model.trim() : DEFAULT_MODEL;
	const key = modelKey(rawModel);

	// Top-level keys must precede every [table] header in TOML.
	const blocks: string[] = [
		[`default_model = ${escapeTomlBasicString(key)}`, 'default_yolo = true'].join('\n'),
	];

	const providerLines = [
		`[providers.${PROVIDER_NAME}]`,
		'type = "kimi"',
		`base_url = ${escapeTomlBasicString(KIMI_CODING_BASE_URL)}`,
	];
	if (ctx.providerApiKey) {
		providerLines.push(`api_key = ${escapeTomlBasicString(ctx.providerApiKey)}`);
	}
	blocks.push(providerLines.join('\n'));

	blocks.push(
		[
			`[models.${key}]`,
			`provider = ${escapeTomlBasicString(PROVIDER_NAME)}`,
			`model = ${escapeTomlBasicString(rawModel)}`,
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
