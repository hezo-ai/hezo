import { AgentRuntime } from '@hezo/shared';
import { describe, expect, it } from 'vitest';
import { MCP_ADAPTERS, type McpDescriptor, validateInjection } from '../../services/mcp-injectors';

const HOME = '/workspace/.hezo/subscription/codex/run-1';
const URL = 'http://host.docker.internal:3000/mcp';
const TOKEN = 'jwt.body.signature';

const HEZO_DESCRIPTOR: McpDescriptor = {
	name: 'hezo',
	url: URL,
	bearerToken: TOKEN,
};

describe('MCP_ADAPTERS', () => {
	it('has an adapter for every AgentRuntime', () => {
		const runtimes = Object.values(AgentRuntime);
		expect(runtimes.length).toBeGreaterThan(0);
		for (const runtime of runtimes) {
			expect(MCP_ADAPTERS[runtime]).toBeDefined();
		}
		expect(Object.keys(MCP_ADAPTERS).sort()).toEqual([...runtimes].sort());
	});

	it('every adapter produces a valid injection for a single Hezo descriptor', () => {
		for (const runtime of Object.values(AgentRuntime)) {
			const adapter = MCP_ADAPTERS[runtime];
			const injection = adapter.build([HEZO_DESCRIPTOR], {
				hostHomeDir: adapter.capabilities.requiresHomeDir ? HOME : null,
				containerHomeDir: adapter.capabilities.requiresHomeDir ? HOME : null,
			});
			validateInjection(adapter, injection);
		}
	});
});

describe('claude-code adapter', () => {
	const adapter = MCP_ADAPTERS[AgentRuntime.ClaudeCode];

	it('emits --mcp-config / --strict-mcp-config CLI flags with the right shape', () => {
		const injection = adapter.build([HEZO_DESCRIPTOR], {
			hostHomeDir: null,
			containerHomeDir: null,
		});

		expect(injection.files).toEqual([]);
		expect(injection.envEntries).toEqual([]);
		expect(injection.cliArgs).toContain('--mcp-config');
		expect(injection.cliArgs).toContain('--strict-mcp-config');

		const blobIndex = injection.cliArgs.indexOf('--mcp-config') + 1;
		const blob = JSON.parse(injection.cliArgs[blobIndex]) as {
			mcpServers: Record<string, { type: string; url: string; headers?: Record<string, string> }>;
		};
		expect(blob.mcpServers.hezo.type).toBe('http');
		expect(blob.mcpServers.hezo.url).toBe(URL);
		expect(blob.mcpServers.hezo.headers?.Authorization).toBe(`Bearer ${TOKEN}`);
	});

	it('emits no MCP args for an empty descriptor list', () => {
		const injection = adapter.build([], { hostHomeDir: null, containerHomeDir: null });
		expect(injection.cliArgs).toEqual([]);
	});

	it('declares no home dir is required', () => {
		expect(adapter.capabilities.requiresHomeDir).toBe(false);
		expect(adapter.capabilities.bearerTokenStorage).toBe('inline');
	});
});

describe('codex adapter', () => {
	const adapter = MCP_ADAPTERS[AgentRuntime.Codex];

	it('writes config.toml at <home>/config.toml with mode 0o600 and no inline bearer token', () => {
		const injection = adapter.build([HEZO_DESCRIPTOR], {
			hostHomeDir: HOME,
			containerHomeDir: HOME,
		});

		expect(injection.cliArgs).toEqual([]);
		expect(injection.files.length).toBe(1);
		const file = injection.files[0];
		expect(file.hostPath).toBe(`${HOME}/config.toml`);
		expect(file.mode).toBe(0o600);

		// TOML body assertions — string match keeps the test transport-agnostic.
		expect(file.contents).toContain('[mcp_servers.hezo]');
		expect(file.contents).toContain(`url = "${URL}"`);
		expect(file.contents).toContain('bearer_token_env_var = "HEZO_MCP_BEARER_TOKEN_HEZO"');
		expect(file.contents).not.toContain(TOKEN);
		expect(file.contents).not.toContain('Bearer ');

		// Bearer token rides on the env, not the file.
		expect(injection.envEntries).toEqual([`HEZO_MCP_BEARER_TOKEN_HEZO=${TOKEN}`]);
	});

	it('throws when no host home dir is provided', () => {
		expect(() =>
			adapter.build([HEZO_DESCRIPTOR], { hostHomeDir: null, containerHomeDir: null }),
		).toThrow(/hostHomeDir/);
	});

	it('emits an empty injection for an empty descriptor list', () => {
		const injection = adapter.build([], { hostHomeDir: HOME, containerHomeDir: HOME });
		expect(injection).toEqual({ cliArgs: [], envEntries: [], files: [] });
	});

	it('omits the bearer env entry when the descriptor has no token', () => {
		const injection = adapter.build([{ name: 'hezo', url: URL }], {
			hostHomeDir: HOME,
			containerHomeDir: HOME,
		});
		expect(injection.envEntries).toEqual([]);
		expect(injection.files[0].contents).not.toContain('bearer_token_env_var');
	});

	it('handles multiple descriptors with distinct env var names per server', () => {
		const injection = adapter.build(
			[
				{ name: 'hezo', url: URL, bearerToken: 't1' },
				{ name: 'extras', url: 'http://other/mcp', bearerToken: 't2' },
			],
			{ hostHomeDir: HOME, containerHomeDir: HOME },
		);
		expect(injection.envEntries).toEqual([
			'HEZO_MCP_BEARER_TOKEN_HEZO=t1',
			'HEZO_MCP_BEARER_TOKEN_EXTRAS=t2',
		]);
		expect(injection.files[0].contents).toContain('[mcp_servers.hezo]');
		expect(injection.files[0].contents).toContain('[mcp_servers.extras]');
	});
});

describe('gemini adapter', () => {
	const adapter = MCP_ADAPTERS[AgentRuntime.Gemini];

	it('writes .gemini/settings.json at <home>/.gemini/settings.json with mode 0o600', () => {
		const injection = adapter.build([HEZO_DESCRIPTOR], {
			hostHomeDir: HOME,
			containerHomeDir: HOME,
		});

		expect(injection.cliArgs).toEqual([]);
		expect(injection.envEntries).toEqual([]);
		expect(injection.files.length).toBe(1);
		const file = injection.files[0];
		expect(file.hostPath).toBe(`${HOME}/.gemini/settings.json`);
		expect(file.mode).toBe(0o600);

		const parsed = JSON.parse(file.contents) as {
			mcpServers: Record<string, { httpUrl: string; headers?: Record<string, string> }>;
		};
		expect(parsed.mcpServers.hezo.httpUrl).toBe(URL);
		expect(parsed.mcpServers.hezo.headers?.Authorization).toBe(`Bearer ${TOKEN}`);
	});

	it('throws when no host home dir is provided', () => {
		expect(() =>
			adapter.build([HEZO_DESCRIPTOR], { hostHomeDir: null, containerHomeDir: null }),
		).toThrow(/hostHomeDir/);
	});

	it('emits an empty injection for an empty descriptor list', () => {
		const injection = adapter.build([], { hostHomeDir: HOME, containerHomeDir: HOME });
		expect(injection).toEqual({ cliArgs: [], envEntries: [], files: [] });
	});
});

describe('validateInjection', () => {
	const codex = MCP_ADAPTERS[AgentRuntime.Codex];

	it('rejects a non-absolute file path', () => {
		expect(() =>
			validateInjection(codex, {
				cliArgs: [],
				envEntries: ['HEZO_MCP_BEARER_TOKEN_HEZO=x'],
				files: [{ hostPath: 'config.toml', mode: 0o600, contents: '[mcp_servers.hezo]\nurl="x"' }],
			}),
		).toThrow(/absolute/);
	});

	it('rejects duplicate env keys', () => {
		expect(() =>
			validateInjection(codex, {
				cliArgs: [],
				envEntries: ['A=1', 'A=2'],
				files: [],
			}),
		).toThrow(/duplicates/);
	});

	it('rejects an inlined bearer token when adapter declares env-var storage', () => {
		expect(() =>
			validateInjection(codex, {
				cliArgs: [],
				envEntries: [],
				files: [
					{
						hostPath: '/tmp/config.toml',
						mode: 0o600,
						contents: 'Authorization = "Bearer jwt.body.signature"',
					},
				],
			}),
		).toThrow(/inlined a bearer token/);
	});
});
