import { AgentRuntime } from '@hezo/shared';
import { describe, expect, it } from 'vitest';
import { MCP_ADAPTERS, type McpDescriptor, validateInjection } from '../src/services/mcp-injectors';

const HOME = '/workspace/.hezo/subscription/codex/run-1';
const URL = 'http://host.docker.internal:3000/mcp';
const TOKEN = 'jwt.body.signature';

const HEZO_DESCRIPTOR: McpDescriptor = {
	kind: 'http',
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
			hostHomeDir: HOME,
			containerHomeDir: HOME,
		});

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

	it('omits --mcp-config / --strict-mcp-config for an empty descriptor list but still emits --settings', () => {
		const injection = adapter.build([], { hostHomeDir: HOME, containerHomeDir: HOME });
		expect(injection.cliArgs).not.toContain('--mcp-config');
		expect(injection.cliArgs).not.toContain('--strict-mcp-config');
		expect(injection.cliArgs).toContain('--settings');
		expect(injection.files.length).toBe(1);
	});

	it('declares a home dir is required for the Stop-hook settings file', () => {
		expect(adapter.capabilities.requiresHomeDir).toBe(true);
		expect(adapter.capabilities.bearerTokenStorage).toBe('inline');
	});

	it('throws when no host home dir is provided', () => {
		expect(() =>
			adapter.build([HEZO_DESCRIPTOR], { hostHomeDir: null, containerHomeDir: null }),
		).toThrow(/hostHomeDir/);
	});

	it('writes settings.json at <home>/settings.json with mode 0o600 and Stop hook config', () => {
		const injection = adapter.build([HEZO_DESCRIPTOR], {
			hostHomeDir: HOME,
			containerHomeDir: HOME,
		});

		expect(injection.files.length).toBe(1);
		const file = injection.files[0];
		expect(file.hostPath).toBe(`${HOME}/settings.json`);
		expect(file.mode).toBe(0o600);

		const settings = JSON.parse(file.contents) as {
			hooks: { Stop: Array<{ hooks: Array<{ type: string; model: string; prompt: string }> }> };
		};
		expect(settings.hooks.Stop.length).toBe(1);
		const hookEntry = settings.hooks.Stop[0].hooks[0];
		expect(hookEntry.type).toBe('prompt');
		expect(hookEntry.model.length).toBeGreaterThan(0);
		expect(hookEntry.prompt).toContain('quality gate');
		expect(hookEntry.prompt).toContain('$ARGUMENTS');
	});

	it('passes --settings pointing at the container path for the settings file', () => {
		const injection = adapter.build([HEZO_DESCRIPTOR], {
			hostHomeDir: HOME,
			containerHomeDir: HOME,
		});

		const settingsIndex = injection.cliArgs.indexOf('--settings');
		expect(settingsIndex).toBeGreaterThanOrEqual(0);
		expect(injection.cliArgs[settingsIndex + 1]).toBe(`${HOME}/settings.json`);
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
		// 2 files: config.toml + stop-hook judge script
		expect(injection.files.length).toBe(2);
		const file = injection.files.find((f) => f.hostPath === `${HOME}/config.toml`);
		expect(file).toBeDefined();
		if (!file) throw new Error('config.toml not emitted');
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

	it('enables live web search ahead of every TOML table', () => {
		const injection = adapter.build([HEZO_DESCRIPTOR], {
			hostHomeDir: HOME,
			containerHomeDir: HOME,
		});
		const config = injection.files.find((f) => f.hostPath === `${HOME}/config.toml`);
		if (!config) throw new Error('config.toml not emitted');
		expect(config.contents).toContain('web_search = "live"');
		// Top-level keys must precede any [table] header or TOML parsing fails.
		expect(config.contents.indexOf('web_search')).toBeLessThan(config.contents.indexOf('['));
	});

	it('throws when no host home dir is provided', () => {
		expect(() =>
			adapter.build([HEZO_DESCRIPTOR], { hostHomeDir: null, containerHomeDir: null }),
		).toThrow(/hostHomeDir/);
	});

	it('still emits the Stop hook + judge script even with an empty descriptor list', () => {
		const injection = adapter.build([], { hostHomeDir: HOME, containerHomeDir: HOME });
		expect(injection.cliArgs).toEqual([]);
		expect(injection.envEntries).toEqual([]);
		expect(injection.files.length).toBe(2);
		const config = injection.files.find((f) => f.hostPath === `${HOME}/config.toml`);
		const script = injection.files.find((f) => f.hostPath === `${HOME}/stop-hook-judge.mjs`);
		expect(config?.contents).toContain('[[hooks.Stop]]');
		expect(script?.contents).toContain('quality gate');
	});

	it('emits a Stop hook entry pointing at the judge script with the right shape', () => {
		const injection = adapter.build([HEZO_DESCRIPTOR], {
			hostHomeDir: HOME,
			containerHomeDir: HOME,
		});
		const config = injection.files.find((f) => f.hostPath === `${HOME}/config.toml`);
		expect(config?.contents).toContain('[[hooks.Stop]]');
		expect(config?.contents).toContain('[[hooks.Stop.hooks]]');
		expect(config?.contents).toContain('type = "command"');
		expect(config?.contents).toContain(`command = "node ${HOME}/stop-hook-judge.mjs"`);
	});

	it('writes the judge script at <home>/stop-hook-judge.mjs with mode 0o700 and the rule body', () => {
		const injection = adapter.build([HEZO_DESCRIPTOR], {
			hostHomeDir: HOME,
			containerHomeDir: HOME,
		});
		const script = injection.files.find((f) => f.hostPath === `${HOME}/stop-hook-judge.mjs`);
		expect(script).toBeDefined();
		if (!script) throw new Error('judge script not emitted');
		expect(script.mode).toBe(0o700);
		expect(script.contents).toContain('quality gate');
		expect(script.contents).toContain('last_assistant_message');
		expect(script.contents).toContain('api.openai.com');
	});

	it('omits the bearer env entry when the descriptor has no token', () => {
		const injection = adapter.build([{ kind: 'http', name: 'hezo', url: URL }], {
			hostHomeDir: HOME,
			containerHomeDir: HOME,
		});
		expect(injection.envEntries).toEqual([]);
		const config = injection.files.find((f) => f.hostPath === `${HOME}/config.toml`);
		expect(config?.contents).not.toContain('bearer_token_env_var');
	});

	it('handles multiple descriptors with distinct env var names per server', () => {
		const injection = adapter.build(
			[
				{ kind: 'http', name: 'hezo', url: URL, bearerToken: 't1' },
				{ kind: 'http', name: 'extras', url: 'http://other/mcp', bearerToken: 't2' },
			],
			{ hostHomeDir: HOME, containerHomeDir: HOME },
		);
		expect(injection.envEntries).toEqual([
			'HEZO_MCP_BEARER_TOKEN_HEZO=t1',
			'HEZO_MCP_BEARER_TOKEN_EXTRAS=t2',
		]);
		const config = injection.files.find((f) => f.hostPath === `${HOME}/config.toml`);
		expect(config?.contents).toContain('[mcp_servers.hezo]');
		expect(config?.contents).toContain('[mcp_servers.extras]');
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
		// 2 files: .gemini/settings.json + stop-hook judge script
		expect(injection.files.length).toBe(2);
		const file = injection.files.find((f) => f.hostPath === `${HOME}/.gemini/settings.json`);
		expect(file).toBeDefined();
		if (!file) throw new Error('settings.json not emitted');
		expect(file.mode).toBe(0o600);

		const parsed = JSON.parse(file.contents) as {
			mcpServers: Record<string, { httpUrl: string; headers?: Record<string, string> }>;
			hooks: { AfterAgent: Array<{ hooks: Array<{ type: string; command: string }> }> };
		};
		expect(parsed.mcpServers.hezo.httpUrl).toBe(URL);
		expect(parsed.mcpServers.hezo.headers?.Authorization).toBe(`Bearer ${TOKEN}`);
		expect(parsed.hooks.AfterAgent.length).toBe(1);
		expect(parsed.hooks.AfterAgent[0].hooks[0].type).toBe('command');
		expect(parsed.hooks.AfterAgent[0].hooks[0].command).toBe(`node ${HOME}/stop-hook-judge.mjs`);
	});

	it('throws when no host home dir is provided', () => {
		expect(() =>
			adapter.build([HEZO_DESCRIPTOR], { hostHomeDir: null, containerHomeDir: null }),
		).toThrow(/hostHomeDir/);
	});

	it('still emits the AfterAgent hook + judge script even with an empty descriptor list', () => {
		const injection = adapter.build([], { hostHomeDir: HOME, containerHomeDir: HOME });
		expect(injection.cliArgs).toEqual([]);
		expect(injection.envEntries).toEqual([]);
		expect(injection.files.length).toBe(2);
		const settings = injection.files.find((f) => f.hostPath === `${HOME}/.gemini/settings.json`);
		const script = injection.files.find((f) => f.hostPath === `${HOME}/stop-hook-judge.mjs`);
		const parsed = JSON.parse(settings?.contents ?? '{}') as {
			hooks: { AfterAgent: Array<{ hooks: Array<{ command: string }> }> };
			mcpServers?: Record<string, unknown>;
		};
		expect(parsed.hooks.AfterAgent[0].hooks[0].command).toBe(`node ${HOME}/stop-hook-judge.mjs`);
		expect(parsed.mcpServers).toBeUndefined();
		expect(script?.contents).toContain('quality gate');
	});

	it('writes the judge script at <home>/stop-hook-judge.mjs with mode 0o700 and Google AI call', () => {
		const injection = adapter.build([HEZO_DESCRIPTOR], {
			hostHomeDir: HOME,
			containerHomeDir: HOME,
		});
		const script = injection.files.find((f) => f.hostPath === `${HOME}/stop-hook-judge.mjs`);
		expect(script).toBeDefined();
		if (!script) throw new Error('judge script not emitted');
		expect(script.mode).toBe(0o700);
		expect(script.contents).toContain('quality gate');
		expect(script.contents).toContain('prompt_response');
		expect(script.contents).toContain('generativelanguage.googleapis.com');
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
