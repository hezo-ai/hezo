import { join } from 'node:path';
import { AgentEffort } from '@hezo/shared';
import { GENERIC_PROMPT_DIRECTIVE } from '../effort';
import { buildCodexJudgeScript } from '../stop-hook-prompt';
import { bearerEnvVarName, escapeTomlBasicString, renderHttpBlock, renderStdioBlock } from './toml';
import type { McpDescriptor, McpInjection, McpInjectionFile, RuntimeAdapter } from './types';

function renderStopHookBlock(judgeScriptContainerPath: string): string {
	return [
		'[[hooks.Stop]]',
		'[[hooks.Stop.hooks]]',
		'type = "command"',
		`command = ${escapeTomlBasicString(`node ${judgeScriptContainerPath}`)}`,
		'timeout = 30',
	].join('\n');
}

const JUDGE_SCRIPT_BASENAME = 'stop-hook-judge.mjs';

// Codex's background-terminal poll ceiling (`background_terminal_max_timeout`,
// milliseconds) is the structural analog of Claude Code's
// `CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS`: how long an empty poll on a
// backgrounded/long-running command waits for output before yielding back to the
// model. Default is 300000 (5 min); raise it to an hour (the value Codex's own
// built-in `awaiter` agent uses). Unlike Claude Code there is no "0 = infinite"
// sentinel — the wait is clamped to a max, so 0 would be invalid; use a large
// finite value.
const BACKGROUND_TERMINAL_MAX_TIMEOUT_MS = 3_600_000;

// Per-MCP-server bounds (seconds). Codex aborts a single tool call after
// `tool_timeout_sec` (default 300 = 5 min) and drops a server that doesn't start
// within `startup_timeout_sec` (default 30). Raise both so a long-running MCP
// tool or a slow-starting stdio server isn't cut off.
const MCP_TOOL_TIMEOUT_SEC = 1_800;
const MCP_STARTUP_TIMEOUT_SEC = 120;

/** Append Codex's per-server timeout keys to a rendered `[mcp_servers.<name>]` table. */
function withServerTimeouts(serverBlock: string): string {
	return [
		serverBlock,
		`startup_timeout_sec = ${MCP_STARTUP_TIMEOUT_SEC}`,
		`tool_timeout_sec = ${MCP_TOOL_TIMEOUT_SEC}`,
	].join('\n');
}

const CODEX_REASONING_EFFORT: Record<AgentEffort, string> = {
	[AgentEffort.Minimal]: 'minimal',
	[AgentEffort.Low]: 'low',
	[AgentEffort.Medium]: 'medium',
	[AgentEffort.High]: 'high',
	[AgentEffort.Max]: 'high',
};

export const codexAdapter: RuntimeAdapter = {
	applyEffort: (effort) => ({
		extraArgs: ['-c', `model_reasoning_effort=${CODEX_REASONING_EFFORT[effort]}`],
		extraEnv: [],
		promptDirective: GENERIC_PROMPT_DIRECTIVE[effort],
	}),
	capabilities: {
		transport: 'streamable-http',
		bearerTokenStorage: 'env-var',
		requiresHomeDir: true,
	},
	build(descriptors: readonly McpDescriptor[], ctx): McpInjection {
		if (!ctx.hostHomeDir || !ctx.containerHomeDir) {
			throw new Error('codex mcp adapter requires hostHomeDir and containerHomeDir');
		}

		const judgeScriptHostPath = join(ctx.hostHomeDir, JUDGE_SCRIPT_BASENAME);
		const judgeScriptContainerPath = join(ctx.containerHomeDir, JUDGE_SCRIPT_BASENAME);

		// Top-level keys must precede every [table] header in TOML, so the
		// web-search mode + background-terminal ceiling lead the file. "live"
		// fetches current pages rather than the cached index, giving agents
		// real-time web search.
		const blocks: string[] = [
			`web_search = "live"\nbackground_terminal_max_timeout = ${BACKGROUND_TERMINAL_MAX_TIMEOUT_MS}`,
		];
		// A descriptor's `enabledTools` is intentionally ignored here: Codex
		// documents no per-server tool filter, and inventing a TOML key risks the
		// CLI rejecting the whole config and breaking every Codex run. Restricted
		// connectors are still enforced — the egress proxy refuses a `tools/call`
		// naming a disabled method regardless of runtime. See
		// RUNTIME_SUPPORTS_MCP_TOOL_FILTER in @hezo/shared.
		for (const d of descriptors) {
			const serverBlock = d.kind === 'http' ? renderHttpBlock(d) : renderStdioBlock(d);
			blocks.push(withServerTimeouts(serverBlock));
		}
		// Both the hook block and the script it points at are omitted together when
		// the caller wants no completeness judge (the CEO chat) - a hook naming a
		// script that was never written is a broken run, not a disabled judge.
		const stopJudge = ctx.stopJudge !== false;
		if (stopJudge) blocks.push(renderStopHookBlock(judgeScriptContainerPath));
		const contents = `${blocks.join('\n\n')}\n`;

		const envEntries: string[] = [];
		for (const d of descriptors) {
			if (d.kind === 'http' && d.bearerToken) {
				envEntries.push(`${bearerEnvVarName(d.name)}=${d.bearerToken}`);
			}
		}

		const files: McpInjectionFile[] = [
			{
				hostPath: join(ctx.hostHomeDir, 'config.toml'),
				mode: 0o600,
				contents,
			},
		];
		if (stopJudge) {
			files.push({
				hostPath: judgeScriptHostPath,
				mode: 0o700,
				contents: buildCodexJudgeScript(),
			});
		}

		return { cliArgs: [], envEntries, files };
	},
};
