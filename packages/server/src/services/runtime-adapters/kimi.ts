import { join } from 'node:path';
import {
	AgentEffort,
	AgentRuntime,
	kimiModelContextSize,
	RUNTIME_SYSTEM_PROMPT_FILE,
} from '@hezo/shared';
import { extractKimiUsageFromSessionLog } from '../agent-stream-parser';
import {
	buildDocWriteGuardScript,
	DOC_WRITE_GUARD_FILENAME,
	DOC_WRITE_GUARD_MATCHER,
} from '../doc-write-guard';
import { GENERIC_PROMPT_DIRECTIVE } from '../effort';
import { buildJudgeScriptForRuntime } from '../stop-hook-prompt';
import { bearerEnvVarName, escapeTomlBasicString } from './toml';
import type {
	McpHttpDescriptor,
	McpInjection,
	McpInjectionFile,
	McpStdioDescriptor,
	RuntimeAdapter,
} from './types';

/**
 * Kimi Code MCP + Stop-hook + system-prompt injector.
 *
 * Two config files, because Kimi Code splits its configuration in two: MCP servers
 * live in `mcp.json` (JSON) and everything else in `config.toml` (TOML). Both are
 * read from the CLI's data root, which `$KIMI_CODE_HOME` relocates to the per-run
 * directory the runner creates.
 *
 * That env var is the ONLY isolation mechanism available here — Kimi Code has no
 * `--mcp-config`-style flag to point at a specific file, which is why `cliArgs`
 * is empty and why `requiresHomeDir` is true.
 *
 * It is also why the run's system prompt lands here as a third file. Kimi Code
 * takes its prompt only as the value of `-p` — one argv element, which Linux caps
 * at MAX_ARG_STRLEN — and Hezo's system prompt alone is well past that. The CLI
 * concatenates `$KIMI_CODE_HOME/AGENTS.md` into its system prompt with no size
 * cap (it warns past 32 KB and carries on), so the static half travels there and
 * only the task body rides `-p`. See RUNTIME_SYSTEM_PROMPT_FILE.
 */

interface KimiHttpEntry {
	url: string;
	startupTimeoutMs: number;
	toolTimeoutMs: number;
	headers?: Record<string, string>;
	bearerTokenEnvVar?: string;
	enabledTools?: string[];
	disabledTools?: string[];
}

interface KimiStdioEntry {
	command: string;
	startupTimeoutMs: number;
	toolTimeoutMs: number;
	args?: string[];
	env?: Record<string, string>;
	enabledTools?: string[];
	disabledTools?: string[];
}

type KimiServerEntry = KimiHttpEntry | KimiStdioEntry;

// Per-MCP-server bounds. Kimi Code's defaults (KIMI_MCP_STARTUP_TIMEOUT_MS
// 30_000, KIMI_MCP_TOOL_TIMEOUT_MS 60_000) are far too tight for Hezo: a slow
// stdio server can take longer than 30s to come up, and plenty of Hezo MCP tools
// legitimately run for minutes. Set per-server rather than via the global env
// vars so one slow connector can't be masked by a blanket override, matching what
// the Codex and Gemini adapters already do.
const MCP_STARTUP_TIMEOUT_MS = 120_000;
const MCP_TOOL_TIMEOUT_MS = 1_800_000;

const JUDGE_SCRIPT_BASENAME = 'stop-hook-judge.mjs';

// Read from the shared table rather than restated, so the runner's decision to
// keep the system prompt out of the prompt body and this file's name can never
// disagree. Non-null for this runtime by construction.
const SYSTEM_PROMPT_BASENAME = RUNTIME_SYSTEM_PROMPT_FILE[AgentRuntime.Kimi] ?? 'AGENTS.md';

// Kimi's `[[hooks]]` entries accept EXACTLY four keys — event, matcher, command,
// timeout — and the CLI refuses to load a config containing any other key. Do not
// add fields here without checking that upstream accepts them; a rejected config
// breaks every run on this runtime, not just the hook.
const STOP_HOOK_TIMEOUT_SEC = 30;

// The doc-write guard is a string comparison plus one `git ls-files`, so it needs
// far less than the judge's budget; a short timeout keeps a wedged git from
// stalling every file write.
const DOC_WRITE_GUARD_TIMEOUT_SEC = 10;

function toolFilter(d: { enabledTools?: readonly string[]; disabledTools?: readonly string[] }): {
	enabledTools?: string[];
	disabledTools?: string[];
} {
	// Absent means "no restriction" — emit nothing at all so the config stays
	// byte-identical to a run with no connector method allowlist.
	const out: { enabledTools?: string[]; disabledTools?: string[] } = {};
	if (d.enabledTools) out.enabledTools = [...d.enabledTools];
	if (d.disabledTools) out.disabledTools = [...d.disabledTools];
	return out;
}

function buildHttpEntry(d: McpHttpDescriptor): KimiHttpEntry {
	const entry: KimiHttpEntry = {
		url: d.url,
		startupTimeoutMs: MCP_STARTUP_TIMEOUT_MS,
		toolTimeoutMs: MCP_TOOL_TIMEOUT_MS,
		...toolFilter(d),
	};
	if (d.headers && Object.keys(d.headers).length > 0) entry.headers = { ...d.headers };
	// Reference the bearer by env-var NAME rather than inlining the value. Kimi
	// Code supports this natively, so `bearerTokenStorage` is 'env-var' and
	// `validateInjection` enforces that no `Bearer …` value reaches a file.
	if (d.bearerToken) entry.bearerTokenEnvVar = bearerEnvVarName(d.name);
	return entry;
}

function buildStdioEntry(d: McpStdioDescriptor): KimiStdioEntry {
	const entry: KimiStdioEntry = {
		command: d.command,
		startupTimeoutMs: MCP_STARTUP_TIMEOUT_MS,
		toolTimeoutMs: MCP_TOOL_TIMEOUT_MS,
		...toolFilter(d),
	};
	if (d.args?.length) entry.args = [...d.args];
	if (d.env && Object.keys(d.env).length > 0) entry.env = { ...d.env };
	return entry;
}

/**
 * `config.toml`: the Stop hook plus a permission rule.
 *
 * `-p` already applies the `auto` permission policy, so this rule is a belt to
 * that braces — an explicit allow-all so a future tightening of what `auto`
 * covers cannot leave a headless run blocked on an approval prompt nobody can
 * answer. Approvals are safe to skip here for the same reason they are on every
 * other runtime: the container is an ephemeral, egress-constrained sandbox in
 * which the agent already executes arbitrary code.
 *
 * `permission.rules` is an ARRAY of `{pattern, decision}` — an inline table with
 * a `default` key parses as one malformed rule, and the CLI then drops the whole
 * `permission` section with a warning rather than failing, so the belt silently
 * was not there. `kimi doctor` is what states the schema; check a change against
 * it, since a rejected section reports as a warning and not an error.
 */
function renderConfigToml(
	judgeScriptContainerPath: string | null,
	docWriteGuardContainerPath: string | null,
): string {
	const lines = ['[[permission.rules]]', 'pattern = "*"', 'decision = "allow"', ''];
	// Omitted entirely when the caller wants no completeness judge (the CEO chat),
	// together with the script it would point at. Exactly the four permitted keys
	// - any fifth makes the CLI reject the whole config.
	if (judgeScriptContainerPath) {
		lines.push(
			'[[hooks]]',
			'event = "Stop"',
			`command = ${escapeTomlBasicString(`node ${judgeScriptContainerPath}`)}`,
			`timeout = ${STOP_HOOK_TIMEOUT_SEC}`,
			'',
		);
	}
	// PreToolUse is one of Kimi's three blockable events. Emitted only when the
	// project has docs to guard, so a run without them keeps a byte-identical
	// config. Exactly the four permitted keys, in the same order as the Stop
	// entry — any fifth key makes the CLI reject the whole config.
	if (docWriteGuardContainerPath) {
		lines.push(
			'[[hooks]]',
			'event = "PreToolUse"',
			`matcher = ${escapeTomlBasicString(DOC_WRITE_GUARD_MATCHER)}`,
			`command = ${escapeTomlBasicString(`node ${docWriteGuardContainerPath}`)}`,
			`timeout = ${DOC_WRITE_GUARD_TIMEOUT_SEC}`,
			'',
		);
	}
	return lines.join('\n');
}

/**
 * Basename of Kimi Code's per-session wire log, written under
 * `$KIMI_CODE_HOME/sessions/<workspace>/<session>/agents/<agent>/`. Its
 * `stream-json` stdout carries no token usage at all, so - as with Grok - cost is
 * recovered from this file. The path depth is an upstream implementation detail,
 * so the home is searched rather than the path reconstructed.
 */
const KIMI_SESSION_LOG_BASENAME = 'wire.jsonl';

/**
 * Depth cap for the wire-log search. The real path sits five levels below the
 * home dir; eight leaves room for an upstream layout change without ever letting
 * a symlink loop or a surprise `node_modules` turn run teardown into a full-disk
 * walk.
 */
const KIMI_SESSION_LOG_MAX_DEPTH = 8;

/**
 * Kimi Code accepts `low|medium|high|xhigh|max`. It has no `minimal`, so the
 * lowest Hezo level maps to `low` and `max` maps straight through. `xhigh` is
 * deliberately unused - Hezo's ladder tops out at `max`, and reaching past
 * `high` for that level would make the two indistinguishable.
 */
const KIMI_THINKING_EFFORT: Record<AgentEffort, string> = {
	[AgentEffort.Minimal]: 'low',
	[AgentEffort.Low]: 'low',
	[AgentEffort.Medium]: 'medium',
	[AgentEffort.High]: 'high',
	[AgentEffort.Max]: 'max',
};

export const kimiAdapter: RuntimeAdapter = {
	capabilities: {
		transport: 'streamable-http',
		bearerTokenStorage: 'env-var',
		requiresHomeDir: true,
	},
	// A real, documented thinking-effort knob, unlike OpenCode and Grok - it is part
	// of the same shell-read KIMI_MODEL_* family the credential travels in. The
	// prompt directive rides along too: it costs nothing and keeps behaviour
	// consistent when a model ignores the knob.
	applyEffort: (effort) => ({
		extraArgs: [],
		extraEnv: [`KIMI_MODEL_THINKING_EFFORT=${KIMI_THINKING_EFFORT[effort]}`],
		promptDirective: GENERIC_PROMPT_DIRECTIVE[effort],
	}),
	staticEnvValue(key, value, ctx) {
		if (!ctx.runModel) return value;
		// The CLI selects its model from `KIMI_MODEL_NAME`, not only from `--model`:
		// that variable is what activates the shell-read `KIMI_MODEL_*` credential
		// family at all, so the run's selected model has to land there rather than
		// only on a flag. The table's value stays the fallback when nothing is pinned.
		if (key === 'KIMI_MODEL_NAME') return ctx.runModel;
		// Tracks the selected model rather than the pinned default: the window is a
		// property of the model, and declaring the default's window for a smaller one
		// makes the CLI compact too late and the endpoint refuse.
		if (key === 'KIMI_MODEL_MAX_CONTEXT_SIZE') return String(kimiModelContextSize(ctx.runModel));
		return value;
	},
	async recoverUsage({ files, price, onError }) {
		const logPaths = await files.findByName(
			'sessions',
			KIMI_SESSION_LOG_BASENAME,
			KIMI_SESSION_LOG_MAX_DEPTH,
		);
		if (logPaths.length === 0) return null;
		try {
			// The home dir is per-run, so in practice there is exactly one session.
			// Concatenating tolerates a resumed or sub-agent session without
			// double-counting: the extractor dedupes by record identity, not by file.
			const contents = (await Promise.all(logPaths.map((p) => files.read(p)))).join('\n');
			return extractKimiUsageFromSessionLog(contents, price);
		} catch (e) {
			onError(`failed to read kimi session log for usage: ${(e as Error).message}`);
			return null;
		} finally {
			for (const p of logPaths) await files.remove(p);
		}
	},
	build(descriptors, ctx): McpInjection {
		if (!ctx.hostHomeDir || !ctx.containerHomeDir) {
			throw new Error('kimi mcp adapter requires hostHomeDir and containerHomeDir');
		}

		const stopJudge = ctx.stopJudge !== false;
		const judgeScriptHostPath = join(ctx.hostHomeDir, JUDGE_SCRIPT_BASENAME);
		const judgeScriptContainerPath = stopJudge
			? join(ctx.containerHomeDir, JUDGE_SCRIPT_BASENAME)
			: null;

		const docSlugs = ctx.projectDocSlugs ?? [];
		const guardContainerPath =
			docSlugs.length > 0 ? join(ctx.containerHomeDir, DOC_WRITE_GUARD_FILENAME) : null;

		const files: McpInjectionFile[] = [
			{
				hostPath: join(ctx.hostHomeDir, 'config.toml'),
				mode: 0o600,
				contents: renderConfigToml(judgeScriptContainerPath, guardContainerPath),
			},
		];
		if (stopJudge) {
			files.push({
				hostPath: judgeScriptHostPath,
				mode: 0o700,
				// Non-null: JUDGE_SPECS carries an entry for this runtime. Falling back
				// to an empty script would install a hook that does nothing, which is
				// worse than the loud failure of a missing file.
				contents: buildJudgeScriptForRuntime(AgentRuntime.Kimi) ?? '',
			});
		}
		if (guardContainerPath) {
			files.push({
				hostPath: join(ctx.hostHomeDir, DOC_WRITE_GUARD_FILENAME),
				mode: 0o700,
				contents: buildDocWriteGuardScript(docSlugs),
			});
		}

		// The system prompt, which this runtime cannot receive any other way. The
		// CLI loads this file first, before any AGENTS.md in the workspace, and
		// concatenates rather than overrides - so the repo's own instructions still
		// reach the agent, after Hezo's.
		if (ctx.systemPrompt) {
			files.push({
				hostPath: join(ctx.hostHomeDir, SYSTEM_PROMPT_BASENAME),
				mode: 0o600,
				contents: ctx.systemPrompt.endsWith('\n') ? ctx.systemPrompt : `${ctx.systemPrompt}\n`,
				passthrough: true,
			});
		}

		const envEntries: string[] = [];
		for (const d of descriptors) {
			if (d.kind === 'http' && d.bearerToken) {
				envEntries.push(`${bearerEnvVarName(d.name)}=${d.bearerToken}`);
			}
		}

		// Only write mcp.json when there is something to declare: an empty
		// `mcpServers` map is not meaningfully different from no file, and skipping
		// it keeps a no-connector run's config surface minimal.
		if (descriptors.length > 0) {
			const mcpServers: Record<string, KimiServerEntry> = {};
			for (const d of descriptors) {
				mcpServers[d.name] = d.kind === 'http' ? buildHttpEntry(d) : buildStdioEntry(d);
			}
			files.push({
				hostPath: join(ctx.hostHomeDir, 'mcp.json'),
				mode: 0o600,
				contents: `${JSON.stringify({ mcpServers }, null, 2)}\n`,
			});
		}

		return { cliArgs: [], envEntries, files };
	},
};
