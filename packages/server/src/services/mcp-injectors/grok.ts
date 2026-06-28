import { join } from 'node:path';
import { buildGrokJudgeScript } from '../stop-hook-prompt';
import { bearerEnvVarName, escapeTomlBasicString, renderHttpBlock, renderStdioBlock } from './toml';
import type { McpDescriptor, McpInjection, RuntimeMcpAdapter } from './types';

/**
 * Grok Build (`grok`) CLI runtime adapter.
 *
 * Grok reads user config from `~/.grok/config.toml` (TOML, Codex/Claude-Code
 * shaped). MCP servers are declared as `[mcp_servers.<name>]` tables — the same
 * shape Codex uses — with bearer tokens referenced by env-var name. Completeness
 * is enforced by a `[[hooks.Stop]]` command hook that runs the judge script
 * (`buildGrokJudgeScript`), which calls xAI's OpenAI-compatible Chat Completions
 * API and fails open without `XAI_API_KEY`.
 *
 * NOTE: the `grok` CLI is in beta and its exact hook-config schema and MCP table
 * shape are not fully documented. This adapter assumes the Codex-style
 * `[mcp_servers.*]` / `[[hooks.Stop]]` command-hook conventions; if a later beta
 * diverges, only the rendering here and the judge protocol need adjusting (the
 * judge already fails open, so a mismatch degrades to "no completeness gate"
 * rather than breaking runs).
 */

const JUDGE_SCRIPT_BASENAME = 'stop-hook-judge.mjs';

function renderStopHookBlock(judgeScriptContainerPath: string): string {
	return [
		'[[hooks.Stop]]',
		'[[hooks.Stop.hooks]]',
		'type = "command"',
		`command = ${escapeTomlBasicString(`node ${judgeScriptContainerPath}`)}`,
		'timeout = 30',
	].join('\n');
}

export const grokAdapter: RuntimeMcpAdapter = {
	capabilities: {
		transport: 'streamable-http',
		bearerTokenStorage: 'env-var',
		requiresHomeDir: true,
	},
	build(descriptors: readonly McpDescriptor[], ctx): McpInjection {
		if (!ctx.hostHomeDir || !ctx.containerHomeDir) {
			throw new Error('grok mcp adapter requires hostHomeDir and containerHomeDir');
		}

		const judgeScriptHostPath = join(ctx.hostHomeDir, JUDGE_SCRIPT_BASENAME);
		const judgeScriptContainerPath = join(ctx.containerHomeDir, JUDGE_SCRIPT_BASENAME);

		const blocks: string[] = [];
		for (const d of descriptors) {
			blocks.push(d.kind === 'http' ? renderHttpBlock(d) : renderStdioBlock(d));
		}
		blocks.push(renderStopHookBlock(judgeScriptContainerPath));
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
					hostPath: join(ctx.hostHomeDir, '.grok', 'config.toml'),
					mode: 0o600,
					contents,
				},
				{
					hostPath: judgeScriptHostPath,
					mode: 0o700,
					contents: buildGrokJudgeScript(),
				},
			],
		};
	},
};
