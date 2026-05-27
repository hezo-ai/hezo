import { join } from 'node:path';
import { buildGeminiJudgeScript } from '../stop-hook-prompt';
import type {
	McpHttpDescriptor,
	McpInjection,
	McpStdioDescriptor,
	RuntimeMcpAdapter,
} from './types';

interface GeminiHttpEntry {
	httpUrl: string;
	headers?: Record<string, string>;
}

interface GeminiStdioEntry {
	command: string;
	args?: string[];
	env?: Record<string, string>;
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
		AfterAgent: GeminiHookMatcherGroup[];
	};
}

function buildHttpEntry(d: McpHttpDescriptor): GeminiHttpEntry {
	const entry: GeminiHttpEntry = { httpUrl: d.url };
	const headers: Record<string, string> = { ...(d.headers ?? {}) };
	if (d.bearerToken) headers.Authorization = `Bearer ${d.bearerToken}`;
	if (Object.keys(headers).length > 0) entry.headers = headers;
	return entry;
}

function buildStdioEntry(d: McpStdioDescriptor): GeminiStdioEntry {
	const entry: GeminiStdioEntry = { command: d.command };
	if (d.args?.length) entry.args = d.args;
	if (d.env && Object.keys(d.env).length > 0) entry.env = d.env;
	return entry;
}

const JUDGE_SCRIPT_BASENAME = 'stop-hook-judge.mjs';

export const geminiAdapter: RuntimeMcpAdapter = {
	capabilities: {
		transport: 'streamable-http',
		bearerTokenStorage: 'inline',
		requiresHomeDir: true,
	},
	build(descriptors, ctx): McpInjection {
		if (!ctx.hostHomeDir || !ctx.containerHomeDir) {
			throw new Error('gemini mcp adapter requires hostHomeDir and containerHomeDir');
		}

		const judgeScriptHostPath = join(ctx.hostHomeDir, JUDGE_SCRIPT_BASENAME);
		const judgeScriptContainerPath = join(ctx.containerHomeDir, JUDGE_SCRIPT_BASENAME);

		const settings: GeminiSettings = {
			hooks: {
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

		return {
			cliArgs: [],
			envEntries: [],
			files: [
				{
					hostPath: join(ctx.hostHomeDir, '.gemini', 'settings.json'),
					mode: 0o600,
					contents,
				},
				{
					hostPath: judgeScriptHostPath,
					mode: 0o700,
					contents: buildGeminiJudgeScript(),
				},
			],
		};
	},
};
