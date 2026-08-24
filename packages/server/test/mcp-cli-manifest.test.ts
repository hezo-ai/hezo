import { describe, expect, it } from 'vitest';
import { HEZO_MCP_CLI_SOURCE } from '../src/services/mcp-cli/cli-source';
import {
	buildMcpCliManifest,
	CONTAINER_MCP_CLI_BIN_DIR,
	CONTAINER_MCP_CLI_MANIFEST,
	CONTAINER_MCP_CLI_SCRIPT,
	MCP_CLI_BIN_NAME,
	MCP_CLI_WRAPPER_SOURCE,
	renderMcpCliManifest,
} from '../src/services/mcp-cli/manifest';
import type { McpDescriptor } from '../src/services/runtime-adapters/types';

const http = (over: Partial<McpDescriptor> = {}): McpDescriptor =>
	({
		kind: 'http',
		name: 'typefully',
		url: 'https://mcp.typefully.com/mcp',
		...over,
	}) as McpDescriptor;

describe('buildMcpCliManifest', () => {
	it('carries the descriptor through unchanged, including the secret placeholder', () => {
		// The red-line property: a placeholder reaches the container verbatim and is
		// substituted at the egress proxy. If this ever renders a real credential,
		// the CLI has become a secret-materialization path.
		const m = buildMcpCliManifest([
			http({ headers: { Authorization: 'Bearer __HEZO_SECRET_MCP_TYPEFULLY__' } }),
		]);
		expect(m.servers[0]).toEqual({
			name: 'typefully',
			transport: 'http',
			url: 'https://mcp.typefully.com/mcp',
			headers: { Authorization: 'Bearer __HEZO_SECRET_MCP_TYPEFULLY__' },
		});
	});

	it('folds bearerToken into an Authorization header', () => {
		// The descriptor's two spellings are an adapter convenience; the wire has
		// one way to authenticate, so the CLI should not have to know both.
		const m = buildMcpCliManifest([http({ bearerToken: 'jwt-123' })]);
		expect(m.servers[0]?.headers).toEqual({ Authorization: 'Bearer jwt-123' });
	});

	it('mirrors the method allowlist so the CLI can refuse locally', () => {
		const m = buildMcpCliManifest([
			http({ enabledTools: ['list_drafts'], disabledTools: ['delete_draft'] }),
		]);
		expect(m.servers[0]?.enabledTools).toEqual(['list_drafts']);
		expect(m.servers[0]?.disabledTools).toEqual(['delete_draft']);
	});

	it('omits absent optional fields rather than emitting nulls', () => {
		const m = buildMcpCliManifest([http()]);
		expect(m.servers[0]).not.toHaveProperty('headers');
		expect(m.servers[0]).not.toHaveProperty('enabledTools');
	});

	it('carries a stdio connector, placeholders in env included', () => {
		const m = buildMcpCliManifest([
			{
				kind: 'stdio',
				name: 'localsrv',
				command: 'npx',
				args: ['-y', 'some-mcp'],
				env: { API_KEY: '__HEZO_SECRET_LOCAL__' },
			} as McpDescriptor,
		]);
		expect(m.servers[0]).toEqual({
			name: 'localsrv',
			transport: 'stdio',
			command: 'npx',
			args: ['-y', 'some-mcp'],
			env: { API_KEY: '__HEZO_SECRET_LOCAL__' },
		});
	});

	it('renders as trailing-newline JSON', () => {
		const text = renderMcpCliManifest([http()]);
		expect(text.endsWith('\n')).toBe(true);
		expect(JSON.parse(text).version).toBe(1);
	});

	it('roots its container paths at the subscription base, not a runtime home dir', () => {
		// Antigravity declares requiresHomeDir: false, so a home-rooted CLI would be
		// missing on exactly one of the six runtimes.
		expect(CONTAINER_MCP_CLI_MANIFEST).toBe('/workspace/.hezo/subscription/mcp-cli/manifest.json');
		expect(CONTAINER_MCP_CLI_SCRIPT).toBe('/workspace/.hezo/subscription/mcp-cli/hezo-mcp.mjs');
	});

	it('ships a PATH wrapper that execs the per-run script by its container path', () => {
		// The prompts name the bare `hezo-mcp` command; the wrapper is what makes it
		// resolve. It must exec the script's container path and forward arguments.
		expect(MCP_CLI_WRAPPER_SOURCE).toBe(
			'#!/bin/sh\nexec node /workspace/.hezo/subscription/mcp-cli/hezo-mcp.mjs "$@"\n',
		);
		expect(`${CONTAINER_MCP_CLI_BIN_DIR}/${MCP_CLI_BIN_NAME}`).toBe('/usr/local/bin/hezo-mcp');
	});
});

describe('HEZO_MCP_CLI_SOURCE', () => {
	it('survives embedding in a template literal', () => {
		// The source is escaped into a TS template literal, so a backtick or a `${`
		// in the script would silently corrupt it. These assertions are the drift
		// guard: they read back what the escaping must have preserved.
		expect(HEZO_MCP_CLI_SOURCE).toContain('#!/usr/bin/env node');
		expect(HEZO_MCP_CLI_SOURCE).toContain('`--args -`');
		expect(HEZO_MCP_CLI_SOURCE).not.toContain('\\`');
	});

	it('ships the four subcommands the shared instructions promise', () => {
		for (const cmd of ['servers', 'search', 'describe', 'call']) {
			expect(HEZO_MCP_CLI_SOURCE, cmd).toContain(`cmd === '${cmd}'`);
		}
	});

	it('reads the manifest from the env var the runner sets', () => {
		expect(HEZO_MCP_CLI_SOURCE).toContain('process.env.HEZO_MCP_MANIFEST');
	});

	it('never resolves a secret placeholder itself', () => {
		// It forwards whatever the manifest carries; the proxy substitutes. The
		// header comment naming the convention is wanted - what must not exist is
		// code that reads, rewrites or resolves a placeholder, which would make the
		// CLI a secret-materialization path and break the red line.
		expect(HEZO_MCP_CLI_SOURCE).toContain('egress proxy substitutes');
		expect(HEZO_MCP_CLI_SOURCE).not.toMatch(/decrypt|masterKey|vault/i);
		// No replace/match/regex touching the placeholder pattern anywhere in code.
		expect(HEZO_MCP_CLI_SOURCE).not.toMatch(/HEZO_SECRET[^_\s]*['"`)\]]/);
	});
});
