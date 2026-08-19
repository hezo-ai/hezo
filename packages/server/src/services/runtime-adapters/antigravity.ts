import { AgentEffort } from '@hezo/shared';
import { GENERIC_PROMPT_DIRECTIVE } from '../effort';
import type {
	HomeConfigFile,
	McpHttpDescriptor,
	McpInjection,
	McpStdioDescriptor,
	RuntimeAdapter,
} from './types';

/**
 * The Antigravity CLI (`agy`) reads its configuration from `$HOME/.gemini` alone -
 * it has no relocation env var (unlike Kimi/Grok) and no config flag (unlike
 * Claude Code / OpenCode). So its files go into the container run-user's real
 * HOME through {@link McpInjection.homeConfigFiles}, not a per-run dir; one run
 * holds a container at a time, so the per-run MCP config is rewritten each run.
 *
 * Two files:
 * - `.gemini/antigravity-cli/settings.json` = `{"modelProvider":"gemini"}`, which
 *   is what makes `agy` authenticate the Gemini API from `GEMINI_API_KEY` (env
 *   alone is rejected as "authentication required"). Static, carries no secret.
 * - `.gemini/config/mcp_config.json`, the MCP server map. `agy` speaks streamable
 *   HTTP (POST, tolerates the endpoint's GET->405) and sends the `Authorization`
 *   header from the `headers` field, so Hezo's descriptor maps straight onto it.
 *   Carries the per-run agent JWT, so it is scrubbed after the run.
 *
 * No completeness Stop-hook judge: `agy`'s Stop hook does not fire in headless
 * (`--print`) mode, so the runtime ships fail-open like Grok and OpenCode.
 */
interface AgyHttpEntry {
	serverUrl: string;
	headers?: Record<string, string>;
}

interface AgyStdioEntry {
	command: string;
	args?: string[];
	env?: Record<string, string>;
}

type AgyServerEntry = AgyHttpEntry | AgyStdioEntry;

const MODEL_PROVIDER_MARKER = `${JSON.stringify({ modelProvider: 'gemini' })}\n`;

// agy's `--effort` accepts exactly low|medium|high; Hezo's ladder has five
// levels, so the ends fold inward (passing `minimal`/`max` verbatim is rejected).
const EFFORT_ARG: Record<AgentEffort, 'low' | 'medium' | 'high'> = {
	[AgentEffort.Minimal]: 'low',
	[AgentEffort.Low]: 'low',
	[AgentEffort.Medium]: 'medium',
	[AgentEffort.High]: 'high',
	[AgentEffort.Max]: 'high',
};

function buildHttpEntry(d: McpHttpDescriptor): AgyHttpEntry {
	const entry: AgyHttpEntry = { serverUrl: d.url };
	const headers: Record<string, string> = { ...(d.headers ?? {}) };
	if (d.bearerToken) headers.Authorization = `Bearer ${d.bearerToken}`;
	if (Object.keys(headers).length > 0) entry.headers = headers;
	return entry;
}

function buildStdioEntry(d: McpStdioDescriptor): AgyStdioEntry {
	const entry: AgyStdioEntry = { command: d.command };
	if (d.args?.length) entry.args = d.args;
	if (d.env && Object.keys(d.env).length > 0) entry.env = d.env;
	return entry;
}

export const antigravityAdapter: RuntimeAdapter = {
	capabilities: {
		transport: 'streamable-http',
		bearerTokenStorage: 'inline',
		// Config lives in the container HOME, not a per-run dir.
		requiresHomeDir: false,
	},
	applyEffort: (effort) => ({
		extraArgs: ['--effort', EFFORT_ARG[effort]],
		extraEnv: [],
		promptDirective: GENERIC_PROMPT_DIRECTIVE[effort],
	}),
	build(descriptors): McpInjection {
		const homeConfigFiles: HomeConfigFile[] = [
			{
				relativePath: '.gemini/antigravity-cli/settings.json',
				mode: 0o600,
				contents: MODEL_PROVIDER_MARKER,
			},
		];

		const mcpServers: Record<string, AgyServerEntry> = {};
		for (const d of descriptors) {
			mcpServers[d.name] = d.kind === 'http' ? buildHttpEntry(d) : buildStdioEntry(d);
		}
		homeConfigFiles.push({
			relativePath: '.gemini/config/mcp_config.json',
			mode: 0o600,
			contents: `${JSON.stringify({ mcpServers }, null, 2)}\n`,
			scrubAfterRun: true,
		});

		return { cliArgs: [], envEntries: [], files: [], homeConfigFiles };
	},
};
