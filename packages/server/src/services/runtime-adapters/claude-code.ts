import { join } from 'node:path';
import {
	AgentEffort,
	AgentRuntime,
	AiProvider,
	claudeCodeModelArg,
	claudeCodeProviderUsesCustomEndpoint,
	qualifiedMcpToolName,
} from '@hezo/shared';
import { buildDocWriteGuardScript, DOC_WRITE_GUARD_FILENAME } from '../doc-write-guard';
import { buildClaudeCodeSettings } from '../stop-hook-prompt';
import type {
	McpDescriptor,
	McpHttpDescriptor,
	McpInjection,
	McpStdioDescriptor,
	RuntimeAdapter,
} from './types';

interface ClaudeHttpEntry {
	type: 'http';
	url: string;
	headers?: Record<string, string>;
}

interface ClaudeStdioEntry {
	type: 'stdio';
	command: string;
	args?: string[];
	env?: Record<string, string>;
}

type ClaudeServerEntry = ClaudeHttpEntry | ClaudeStdioEntry;

function buildHttpEntry(d: McpHttpDescriptor): ClaudeHttpEntry {
	const entry: ClaudeHttpEntry = { type: 'http', url: d.url };
	const headers: Record<string, string> = { ...(d.headers ?? {}) };
	if (d.bearerToken) headers.Authorization = `Bearer ${d.bearerToken}`;
	if (Object.keys(headers).length > 0) entry.headers = headers;
	return entry;
}

function buildStdioEntry(d: McpStdioDescriptor): ClaudeStdioEntry {
	const entry: ClaudeStdioEntry = { type: 'stdio', command: d.command };
	if (d.args?.length) entry.args = d.args;
	if (d.env && Object.keys(d.env).length > 0) entry.env = d.env;
	return entry;
}

/**
 * Claude Code phones home from several subsystems that ignore NO_PROXY (undici
 * fetch, the Sentry transport), so the telemetry it would otherwise send lands in
 * the MITM proxy at a host nobody is paying for. These switches turn that off for
 * every provider driving this CLI.
 *
 * `CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS` is the odd one out and not about noise:
 * headless `claude -p` waits a bounded time for still-running background tasks and
 * then kills them, which ends Hezo's legitimately long background work. Zero lifts
 * the ceiling, leaving the wait bounded by the run's own container lifecycle.
 */
const CLAUDE_CODE_QUIET_ENV = {
	DISABLE_TELEMETRY: '1',
	DISABLE_ERROR_REPORTING: '1',
	DISABLE_AUTOUPDATER: '1',
	DISABLE_NON_ESSENTIAL_MODEL_CALLS: '1',
	DISABLE_BUG_COMMAND: '1',
	CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS: '0',
} as const;

const CLAUDE_CODE_PROMPT_DIRECTIVE: Record<AgentEffort, string> = {
	[AgentEffort.Minimal]: '',
	[AgentEffort.Low]: 'think about this step by step.',
	[AgentEffort.Medium]: 'think',
	[AgentEffort.High]: 'think hard',
	[AgentEffort.Max]: 'ultrathink',
};

export const claudeCodeAdapter: RuntimeAdapter = {
	capabilities: {
		transport: 'streamable-http',
		bearerTokenStorage: 'inline',
		requiresHomeDir: true,
	},
	constantEnv: CLAUDE_CODE_QUIET_ENV,
	// Claude Code's reasoning lever is its own prompt vocabulary rather than a flag
	// or a variable: these words are what the CLI itself recognises.
	applyEffort: (effort) => ({
		extraArgs: [],
		extraEnv: [],
		promptDirective: CLAUDE_CODE_PROMPT_DIRECTIVE[effort],
	}),
	// Even with the ceiling lifted, the CLI can still report that it terminated
	// unfinished background work - and it says so while exiting 0. It is the only
	// runtime that does, so it is the only one whose clean exit gets second-guessed.
	terminatesBackgroundWork: true,
	modelArg: claudeCodeModelArg,
	staticEnvValue(key, value, ctx) {
		// On a third-party Anthropic-compatible provider the subagent default should
		// follow the run's own model rather than a pinned constant, so a provider
		// model upgrade or a retired id needs no code change. The constant stays the
		// fallback when the run pins nothing. (A newly selected model still needs a
		// `model_pricing` row, or its runs price to $0.)
		if (key !== 'CLAUDE_CODE_SUBAGENT_MODEL' || !ctx.runModel) return value;
		if (!claudeCodeProviderUsesCustomEndpoint(ctx.provider, AgentRuntime.ClaudeCode)) return value;
		return claudeCodeModelArg(ctx.provider, ctx.runModel);
	},
	credentialEnv(ctx) {
		// A locally-hosted provider's endpoint is per-install, so it rides on the
		// credential instead of a static table.
		if (!ctx.baseUrl) return [];
		return [
			`ANTHROPIC_BASE_URL=${ctx.baseUrl}`,
			// These runners authenticate, when they authenticate at all, from
			// ANTHROPIC_AUTH_TOKEN. Claude Code prefers ANTHROPIC_API_KEY when both are
			// present, so a key inherited from the host environment would silently win
			// and be sent to the operator's own server. Blank it explicitly.
			'ANTHROPIC_API_KEY=',
		];
	},
	build(descriptors: readonly McpDescriptor[], ctx): McpInjection {
		if (!ctx.hostHomeDir || !ctx.containerHomeDir) {
			throw new Error('claude-code mcp adapter requires hostHomeDir and containerHomeDir');
		}

		const mcpServers: Record<string, ClaudeServerEntry> = {};
		for (const d of descriptors) {
			mcpServers[d.name] = d.kind === 'http' ? buildHttpEntry(d) : buildStdioEntry(d);
		}

		// Claude Code's per-server `mcpServers` entry has no tool filter, so a
		// connector's method allowlist is expressed in the settings file as denials
		// of the withheld tools, addressed by their fully-qualified names.
		const deniedTools: string[] = [];
		for (const d of descriptors) {
			for (const tool of d.disabledTools ?? [])
				deniedTools.push(qualifiedMcpToolName(d.name, tool));
		}

		// Blocking doc-write guard, emitted only when the project actually has docs
		// to guard - with none, the settings file stays byte-identical to what it
		// was before the guard existed.
		const docSlugs = ctx.projectDocSlugs ?? [];
		const guardHostPath = join(ctx.hostHomeDir, DOC_WRITE_GUARD_FILENAME);
		const guardContainerPath = join(ctx.containerHomeDir, DOC_WRITE_GUARD_FILENAME);
		const guardCommand = docSlugs.length > 0 ? `node ${guardContainerPath}` : null;

		const settingsHostPath = join(ctx.hostHomeDir, 'settings.json');
		const settingsContainerPath = join(ctx.containerHomeDir, 'settings.json');
		// The doc-write guard above is emitted either way: it is a deterministic
		// path match, unaffected by whether this invocation gets a completeness
		// judge (`stopJudge`, false for the CEO chat).
		const settingsContents = `${JSON.stringify(
			buildClaudeCodeSettings(
				ctx.provider ?? AiProvider.Anthropic,
				ctx.runModel,
				deniedTools,
				guardCommand,
				ctx.stopJudge !== false,
			),
			null,
			2,
		)}\n`;

		const cliArgs: string[] = ['--settings', settingsContainerPath];
		if (descriptors.length > 0) {
			cliArgs.push('--mcp-config', JSON.stringify({ mcpServers }), '--strict-mcp-config');
		}

		const files = [
			{
				hostPath: settingsHostPath,
				mode: 0o600,
				contents: settingsContents,
			},
		];
		if (guardCommand) {
			files.push({
				hostPath: guardHostPath,
				// Executed via `node <path>`, so it needs to be readable, not +x.
				mode: 0o600,
				contents: buildDocWriteGuardScript(docSlugs),
			});
		}

		return { cliArgs, envEntries: [], files };
	},
};
