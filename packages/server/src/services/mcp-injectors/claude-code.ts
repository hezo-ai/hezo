import { join } from 'node:path';
import { AiProvider } from '@hezo/shared';
import { buildDocWriteGuardScript, DOC_WRITE_GUARD_FILENAME } from '../doc-write-guard';
import { buildClaudeCodeSettings } from '../stop-hook-prompt';
import type {
	McpDescriptor,
	McpHttpDescriptor,
	McpInjection,
	McpStdioDescriptor,
	RuntimeMcpAdapter,
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

export const claudeCodeAdapter: RuntimeMcpAdapter = {
	capabilities: {
		transport: 'streamable-http',
		bearerTokenStorage: 'inline',
		requiresHomeDir: true,
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
			for (const tool of d.disabledTools ?? []) deniedTools.push(`mcp__${d.name}__${tool}`);
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
		const settingsContents = `${JSON.stringify(buildClaudeCodeSettings(ctx.provider ?? AiProvider.Anthropic, ctx.runModel, deniedTools, guardCommand), null, 2)}\n`;

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
