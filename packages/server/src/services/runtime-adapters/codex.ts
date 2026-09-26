import { join } from 'node:path';
import { AgentEffort } from '@hezo/shared';
import {
	type AgentRunUsage,
	codexRolloutModel,
	extractCodexUsageFromRollout,
	mergeRunUsage,
} from '../agent-stream-parser';
import { GENERIC_PROMPT_DIRECTIVE } from '../effort';
import { buildCodexJudgeScript, CODEX_JUDGE_HOOK_TIMEOUT_SEC } from '../stop-hook-prompt';
import { CODEX_FEATURES_OFF } from './codex-features';
import {
	bearerEnvVarName,
	escapeTomlBasicString,
	renderHttpBlock,
	renderStdioBlock,
	tomlArray,
} from './toml';
import {
	HEZO_MCP_SERVER_NAME,
	type McpDescriptor,
	type McpInjection,
	type McpInjectionFile,
	type RuntimeAdapter,
} from './types';

function renderStopHookBlock(judgeScriptContainerPath: string): string {
	return [
		'[[hooks.Stop]]',
		'[[hooks.Stop.hooks]]',
		'type = "command"',
		`command = ${escapeTomlBasicString(`node ${judgeScriptContainerPath}`)}`,
		`timeout = ${CODEX_JUDGE_HOOK_TIMEOUT_SEC}`,
	].join('\n');
}

const JUDGE_SCRIPT_BASENAME = 'stop-hook-judge.mjs';

// Codex runs a hook from user config only once its hash is saved as trusted,
// and drops an untrusted one without a word on stderr or the stream
// (`hooks/src/engine/discovery.rs`). Hezo writes a fresh CODEX_HOME per run, so
// its judge hook is never trusted, and until this flag no Codex task run was
// judged. It travels with the hook: a run without the judge does not get it.
// It also lets a hook committed in the worked repo's own `.codex/config.toml`
// run; the agent already executes that repo's code in the same container.
const BYPASS_HOOK_TRUST_ARG = '--dangerously-bypass-hook-trust';

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

/**
 * Codex's own keys on a rendered `[mcp_servers.<name>]` table.
 *
 * - The timeouts, raised so a long-running MCP tool or a slow-starting stdio
 *   server isn't cut off.
 * - `required` on Hezo's own server. Without it Codex gives a server about 1 s
 *   before the first model request, whatever `startup_timeout_sec` says, so a
 *   slow start left the run with no Hezo tools and nothing on the stream to say
 *   so. Required, Codex waits up to `startup_timeout_sec`, and a server that
 *   never comes up fails the run at once (exit 1, the reason on stderr) instead
 *   of running blind. Connectors stay optional: one being down should not stop
 *   the work.
 * - The connector's method allowlist as `enabled_tools` / `disabled_tools`,
 *   which Codex matches against the raw MCP tool names, as Hezo stores them. A
 *   filtered tool is refused before the call reaches the server; deny wins over
 *   allow; an unknown name is ignored. Absent means no filter, and the table is
 *   byte-identical to one written before the filter existed. The egress proxy
 *   still enforces the allowlist on its own.
 */
function withServerKeys(serverBlock: string, d: McpDescriptor): string {
	const lines = [
		serverBlock,
		`startup_timeout_sec = ${MCP_STARTUP_TIMEOUT_SEC}`,
		`tool_timeout_sec = ${MCP_TOOL_TIMEOUT_SEC}`,
	];
	if (d.name === HEZO_MCP_SERVER_NAME) lines.push('required = true');
	if (d.enabledTools) lines.push(`enabled_tools = ${tomlArray(d.enabledTools)}`);
	if (d.disabledTools) lines.push(`disabled_tools = ${tomlArray(d.disabledTools)}`);
	return lines.join('\n');
}

/**
 * The Codex CLI version the agent image pins (`CODEX_VERSION` in
 * `docker/Dockerfile.agent-base`, held equal by `agent-cli-pins.test.ts`).
 *
 * The server asks Codex's backend for the models a subscription can run with
 * this as the client version, so the list a person picks a default model from is
 * the list the pinned CLI supports.
 */
export const CODEX_CLI_VERSION = '0.156.0';

/**
 * Codex sends the value as the Responses API's `reasoning.effort` unchanged and
 * does not clamp it, so an unsupported value fails the turn. Its model catalog
 * lists no `minimal` for any model, lists `xhigh` for every one, and lacks `max`
 * on several of them.
 */
const CODEX_REASONING_EFFORT: Record<AgentEffort, string> = {
	[AgentEffort.Minimal]: 'low',
	[AgentEffort.Low]: 'low',
	[AgentEffort.Medium]: 'medium',
	[AgentEffort.High]: 'high',
	[AgentEffort.Max]: 'xhigh',
};

/**
 * Where the CLI writes its session rollouts, relative to `CODEX_HOME`.
 *
 * `codex exec --ephemeral` ("run without persisting session files") would leave
 * both empty and silently disable usage recovery for every Codex run. Hezo does
 * not pass it; anything that starts to must account for this.
 */
const CODEX_ROLLOUT_DIRS = ['sessions', 'archived_sessions'] as const;

/** Rollout filenames are `rollout-<ISO timestamp>-<uuid>.jsonl`. */
const CODEX_ROLLOUT_MATCH = { prefix: 'rollout-', suffix: '.jsonl' } as const;

/** `sessions/YYYY/MM/DD/<file>` is four levels; a little slack costs nothing. */
const CODEX_ROLLOUT_DEPTH = 6;

/**
 * Read at most this much of a rollout, from the end.
 *
 * These files are the full verbatim transcript - every tool result in full - and
 * run to hundreds of megabytes; the largest observed locally was 232 MB. The
 * token figures are cumulative, so the tail carries them, and a whole-file read
 * at ten concurrent runs is an out-of-memory fault rather than a slow path.
 */
const MAX_CODEX_ROLLOUT_TAIL_BYTES = 2_000_000;

/**
 * How much of a rollout's start to read for its model, when only the tail is read
 * for its tokens.
 *
 * A rollout restates its model in a `turn_context` record per turn, not per
 * request, so a single-turn run states it once, near the start - measured at
 * about 140 KB in, behind the session header and the instructions. A tail read
 * of any rollout over the tail budget found none and recorded no model.
 */
const CODEX_ROLLOUT_HEAD_BYTES = 512_000;

export const codexAdapter: RuntimeAdapter = {
	applyEffort: (effort) => ({
		extraArgs: ['-c', `model_reasoning_effort=${CODEX_REASONING_EFFORT[effort]}`],
		extraEnv: [],
		promptDirective: GENERIC_PROMPT_DIRECTIVE[effort],
	}),
	offStreamUsage: {
		async read({ files, onError }) {
			// Codex names no model on its `exec --json` stream and reports usage only on
			// the one terminal turn event, so a run killed before that event records
			// nothing. Both are in the rollout however the run ended.
			try {
				const paths: string[] = [];
				for (const dir of CODEX_ROLLOUT_DIRS) {
					if (!(await files.exists(dir))) continue;
					paths.push(...(await files.findByName(dir, CODEX_ROLLOUT_MATCH, CODEX_ROLLOUT_DEPTH)));
				}
				if (paths.length === 0) return null;

				// Summed across files rather than picking one: CODEX_HOME is per-run, so
				// every rollout under it belongs to this run - including any a subagent
				// wrote, which bills to the same account.
				let total: AgentRunUsage | null = null;
				for (const path of paths) {
					const size = await files.size(path);
					const whole = size !== null && size <= MAX_CODEX_ROLLOUT_TAIL_BYTES;
					const text = whole
						? await files.read(path)
						: await files.readTail(path, MAX_CODEX_ROLLOUT_TAIL_BYTES);
					const openingModel = whole
						? undefined
						: codexRolloutModel(await files.readHead(path, CODEX_ROLLOUT_HEAD_BYTES));
					const usage = extractCodexUsageFromRollout(text, openingModel);
					if (!usage) continue;
					total = total ? mergeRunUsage(total, usage) : usage;
				}
				return total;
			} catch (e) {
				onError(`failed to read codex rollout for usage: ${(e as Error).message}`);
				return null;
			}
		},
		async scrub(files) {
			// This is the whole verbatim transcript, materially more sensitive than the
			// credential file sitting beside it.
			for (const dir of CODEX_ROLLOUT_DIRS) await files.removeDir(dir);
		},
	},
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
		// web-search mode, background-terminal ceiling and feature switches lead
		// the file. "live" fetches current pages rather than the cached index, giving
		// agents real-time web search.
		const blocks: string[] = [
			[
				'web_search = "live"',
				`background_terminal_max_timeout = ${BACKGROUND_TERMINAL_MAX_TIMEOUT_MS}`,
				...CODEX_FEATURES_OFF.map((f) => `features.${f} = false`),
			].join('\n'),
		];
		for (const d of descriptors) {
			const serverBlock = d.kind === 'http' ? renderHttpBlock(d) : renderStdioBlock(d);
			blocks.push(withServerKeys(serverBlock, d));
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

		return { cliArgs: stopJudge ? [BYPASS_HOOK_TRUST_ARG] : [], envEntries, files };
	},
};
