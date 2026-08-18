import { join } from 'node:path';
import { GENERIC_PROMPT_DIRECTIVE } from '../effort';
import { buildGeminiJudgeScript } from '../stop-hook-prompt';
import type {
	McpHttpDescriptor,
	McpInjection,
	McpInjectionFile,
	McpStdioDescriptor,
	RuntimeAdapter,
} from './types';

interface GeminiHttpEntry {
	httpUrl: string;
	timeout: number;
	headers?: Record<string, string>;
	includeTools?: string[];
}

interface GeminiStdioEntry {
	command: string;
	timeout: number;
	args?: string[];
	env?: Record<string, string>;
	includeTools?: string[];
}

type GeminiServerEntry = GeminiHttpEntry | GeminiStdioEntry;

interface GeminiHookCommand {
	type: 'command';
	command: string;
	timeout: number;
}

interface GeminiHookMatcherGroup {
	hooks: GeminiHookCommand[];
}

interface GeminiSettings {
	mcpServers?: Record<string, GeminiServerEntry>;
	hooks: {
		/**
		 * Gemini's Stop analogue. Present for every task run; omitted when the
		 * caller asks for no completeness judge (see `McpAdapterContext.stopJudge`).
		 */
		AfterAgent?: GeminiHookMatcherGroup[];
	};
	tools: {
		shell: {
			inactivityTimeout: number;
		};
	};
}

// The Gemini CLI kills a `run_shell_command` that produces no output for
// `tools.shell.inactivityTimeout` seconds (default 300 = 5 min) — a long, quiet
// build/test/agent step is terminated mid-flight. `0` disables the kill entirely
// (the CLI early-returns when the value is ≤ 0), so legitimately long silent work
// is never cut off. There is no env-var equivalent; it's a settings.json key.
const SHELL_INACTIVITY_TIMEOUT_DISABLED = 0;

// `mcpServers.<name>.includeTools` is the CLI's per-server allowlist: with it
// set, only the listed tools are exposed from that server. We only ever emit the
// allowlist, never `excludeTools` — the CLI documents exclude as taking
// precedence over include, so mixing the two would make the effective set depend
// on a precedence rule instead of on our list.
//
// Per-MCP-server request timeout (`mcpServers.<name>.timeout`, milliseconds). The
// CLI default is already 10 min; we set it explicitly so a future default change
// can't silently tighten it, and to stay consistent with the other runtimes.
const MCP_REQUEST_TIMEOUT_MS = 600_000;

function buildHttpEntry(d: McpHttpDescriptor): GeminiHttpEntry {
	const entry: GeminiHttpEntry = { httpUrl: d.url, timeout: MCP_REQUEST_TIMEOUT_MS };
	const headers: Record<string, string> = { ...(d.headers ?? {}) };
	if (d.bearerToken) headers.Authorization = `Bearer ${d.bearerToken}`;
	if (Object.keys(headers).length > 0) entry.headers = headers;
	if (d.enabledTools) entry.includeTools = [...d.enabledTools];
	return entry;
}

function buildStdioEntry(d: McpStdioDescriptor): GeminiStdioEntry {
	const entry: GeminiStdioEntry = { command: d.command, timeout: MCP_REQUEST_TIMEOUT_MS };
	if (d.args?.length) entry.args = d.args;
	if (d.env && Object.keys(d.env).length > 0) entry.env = d.env;
	if (d.enabledTools) entry.includeTools = [...d.enabledTools];
	return entry;
}

const JUDGE_SCRIPT_BASENAME = 'stop-hook-judge.mjs';

/**
 * The Gemini CLI refuses to run in an "untrusted" folder and silently downgrades
 * `--yolo` to manual tool approval, which hangs a headless run. Hezo agents run
 * headless in `/workspace`, so the workspace is trusted explicitly - the
 * documented headless setting (https://geminicli.com/docs/cli/trusted-folders).
 */
const GEMINI_RUNTIME_ENV = {
	GEMINI_CLI_TRUST_WORKSPACE: 'true',
} as const;

export const geminiAdapter: RuntimeAdapter = {
	capabilities: {
		transport: 'streamable-http',
		bearerTokenStorage: 'inline',
		requiresHomeDir: true,
	},
	constantEnv: GEMINI_RUNTIME_ENV,
	// The CLI reads the Hezo ladder's own spellings straight off this variable, so
	// no mapping table is needed here.
	applyEffort: (effort) => ({
		extraArgs: [],
		extraEnv: [`GEMINI_REASONING_EFFORT=${effort}`],
		promptDirective: GENERIC_PROMPT_DIRECTIVE[effort],
	}),
	build(descriptors, ctx): McpInjection {
		if (!ctx.hostHomeDir || !ctx.containerHomeDir) {
			throw new Error('gemini mcp adapter requires hostHomeDir and containerHomeDir');
		}

		const judgeScriptHostPath = join(ctx.hostHomeDir, JUDGE_SCRIPT_BASENAME);
		const judgeScriptContainerPath = join(ctx.containerHomeDir, JUDGE_SCRIPT_BASENAME);

		// Hook and script are omitted together when the caller wants no
		// completeness judge (the CEO chat) - a hook pointing at a script that was
		// never written is a broken run, not a disabled judge.
		const stopJudge = ctx.stopJudge !== false;
		const settings: GeminiSettings = {
			hooks: stopJudge
				? {
						AfterAgent: [
							{
								hooks: [
									{
										type: 'command',
										command: `node ${judgeScriptContainerPath}`,
										timeout: 30_000,
									},
								],
							},
						],
					}
				: {},
			tools: {
				shell: {
					inactivityTimeout: SHELL_INACTIVITY_TIMEOUT_DISABLED,
				},
			},
		};

		if (descriptors.length > 0) {
			const mcpServers: Record<string, GeminiServerEntry> = {};
			for (const d of descriptors) {
				mcpServers[d.name] = d.kind === 'http' ? buildHttpEntry(d) : buildStdioEntry(d);
			}
			settings.mcpServers = mcpServers;
		}

		const contents = `${JSON.stringify(settings, null, 2)}\n`;

		const files: McpInjectionFile[] = [
			{
				hostPath: join(ctx.hostHomeDir, '.gemini', 'settings.json'),
				mode: 0o600,
				contents,
			},
		];
		if (stopJudge) {
			files.push({
				hostPath: judgeScriptHostPath,
				mode: 0o700,
				contents: buildGeminiJudgeScript(),
			});
		}

		return { cliArgs: [], envEntries: [], files };
	},
};
