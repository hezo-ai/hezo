import { join } from 'node:path';
import { AgentRuntime } from '@hezo/shared';
import {
	buildDocWriteGuardScript,
	DOC_WRITE_GUARD_FILENAME,
	DOC_WRITE_GUARD_MATCHER,
} from '../doc-write-guard';
import { buildJudgeScriptForRuntime } from '../stop-hook-prompt';
import { bearerEnvVarName, escapeTomlBasicString } from './toml';
import type {
	McpHttpDescriptor,
	McpInjection,
	McpInjectionFile,
	McpStdioDescriptor,
	RuntimeMcpAdapter,
} from './types';

/**
 * Kimi Code MCP + Stop-hook injector.
 *
 * Two files, because Kimi Code splits its configuration in two: MCP servers live
 * in `mcp.json` (JSON) and everything else in `config.toml` (TOML). Both are read
 * from the CLI's data root, which `$KIMI_CODE_HOME` relocates to the per-run
 * directory the runner creates.
 *
 * That env var is the ONLY isolation mechanism available here — Kimi Code has no
 * `--mcp-config`-style flag to point at a specific file, which is why `cliArgs`
 * is empty and why `requiresHomeDir` is true.
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
 */
function renderConfigToml(
	judgeScriptContainerPath: string,
	docWriteGuardContainerPath: string | null,
): string {
	const lines = [
		'[permission.rules]',
		'default = "allow"',
		'',
		'[[hooks]]',
		'event = "Stop"',
		`command = ${escapeTomlBasicString(`node ${judgeScriptContainerPath}`)}`,
		`timeout = ${STOP_HOOK_TIMEOUT_SEC}`,
		'',
	];
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

export const kimiAdapter: RuntimeMcpAdapter = {
	capabilities: {
		transport: 'streamable-http',
		bearerTokenStorage: 'env-var',
		requiresHomeDir: true,
	},
	build(descriptors, ctx): McpInjection {
		if (!ctx.hostHomeDir || !ctx.containerHomeDir) {
			throw new Error('kimi mcp adapter requires hostHomeDir and containerHomeDir');
		}

		const judgeScriptHostPath = join(ctx.hostHomeDir, JUDGE_SCRIPT_BASENAME);
		const judgeScriptContainerPath = join(ctx.containerHomeDir, JUDGE_SCRIPT_BASENAME);

		const docSlugs = ctx.projectDocSlugs ?? [];
		const guardContainerPath =
			docSlugs.length > 0 ? join(ctx.containerHomeDir, DOC_WRITE_GUARD_FILENAME) : null;

		const files: McpInjectionFile[] = [
			{
				hostPath: join(ctx.hostHomeDir, 'config.toml'),
				mode: 0o600,
				contents: renderConfigToml(judgeScriptContainerPath, guardContainerPath),
			},
			{
				hostPath: judgeScriptHostPath,
				mode: 0o700,
				// Non-null: JUDGE_SPECS carries an entry for this runtime. Falling back
				// to an empty script would install a hook that does nothing, which is
				// worse than the loud failure of a missing file.
				contents: buildJudgeScriptForRuntime(AgentRuntime.Kimi) ?? '',
			},
		];
		if (guardContainerPath) {
			files.push({
				hostPath: join(ctx.hostHomeDir, DOC_WRITE_GUARD_FILENAME),
				mode: 0o700,
				contents: buildDocWriteGuardScript(docSlugs),
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
