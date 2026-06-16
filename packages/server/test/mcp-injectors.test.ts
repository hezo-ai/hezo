import { AgentRuntime, AiAuthMethod, AiProvider } from '@hezo/shared';
import { describe, expect, it } from 'vitest';
import { MCP_ADAPTERS, type McpDescriptor, validateInjection } from '../src/services/mcp-injectors';
import {
	STOP_HOOK_JUDGE_MODEL_ANTHROPIC,
	STOP_HOOK_JUDGE_MODEL_DEEPSEEK,
	STOP_HOOK_JUDGE_MODEL_ZAI,
	STOP_HOOK_RULES,
} from '../src/services/stop-hook-prompt';

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

	describe('STOP_HOOK_RULES deferral semantics', () => {
		it('admits closing a ticket when the gated tail is filed as a blocked_by follow-up', () => {
			expect(STOP_HOOK_RULES).toContain(
				'filing the deferred work as a SEPARATE ticket whose blocked_by_task_ids points at',
			);
			expect(STOP_HOOK_RULES).toContain('marking the current ticket terminal is fine');
		});

		it('still rejects an unguarded top-level task or close-while-deferring', () => {
			expect(STOP_HOOK_RULES).toContain('A new TOP-LEVEL task with NO such blocker edge');
			expect(STOP_HOOK_RULES).toContain('is still NOT an acceptable deferral');
		});
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

	const judgeModelFor = (provider?: AiProvider): string => {
		const injection = adapter.build([HEZO_DESCRIPTOR], {
			hostHomeDir: HOME,
			containerHomeDir: HOME,
			provider,
		});
		const settings = JSON.parse(injection.files[0].contents) as {
			hooks: { Stop: Array<{ hooks: Array<{ model: string }> }> };
		};
		return settings.hooks.Stop[0].hooks[0].model;
	};

	it('picks a Stop-hook judge model the provider upstream actually serves', () => {
		// The judge call runs against the team's own upstream, so a non-Anthropic
		// Claude Code provider must get its own model id — otherwise the call 404s
		// and the hook fails open (the bug being fixed).
		expect(judgeModelFor(AiProvider.Anthropic)).toBe(STOP_HOOK_JUDGE_MODEL_ANTHROPIC);
		expect(judgeModelFor(AiProvider.DeepSeek)).toBe(STOP_HOOK_JUDGE_MODEL_DEEPSEEK);
		expect(judgeModelFor(AiProvider.ZAi)).toBe(STOP_HOOK_JUDGE_MODEL_ZAI);
	});

	it('falls back to the Anthropic judge model when no provider is supplied', () => {
		expect(judgeModelFor(undefined)).toBe(STOP_HOOK_JUDGE_MODEL_ANTHROPIC);
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

describe('opencode adapter', () => {
	const adapter = MCP_ADAPTERS[AgentRuntime.OpenCode];

	it('declares inline bearer storage and a required home dir', () => {
		expect(adapter.capabilities.requiresHomeDir).toBe(true);
		expect(adapter.capabilities.bearerTokenStorage).toBe('inline');
	});

	it('throws when no host home dir is provided', () => {
		expect(() =>
			adapter.build([HEZO_DESCRIPTOR], { hostHomeDir: null, containerHomeDir: null }),
		).toThrow(/hostHomeDir/);
	});

	it('writes opencode.json with a remote MCP server and points OPENCODE_CONFIG at it', () => {
		const injection = adapter.build([HEZO_DESCRIPTOR], {
			hostHomeDir: HOME,
			containerHomeDir: HOME,
		});

		expect(injection.cliArgs).toEqual([]);
		expect(injection.envEntries).toEqual([`OPENCODE_CONFIG=${HOME}/opencode.json`]);
		expect(injection.files.length).toBe(1);
		const file = injection.files[0];
		expect(file.hostPath).toBe(`${HOME}/opencode.json`);
		expect(file.mode).toBe(0o600);

		const config = JSON.parse(file.contents) as {
			mcp: Record<
				string,
				{ type: string; url: string; enabled: boolean; headers?: Record<string, string> }
			>;
		};
		expect(config.mcp.hezo.type).toBe('remote');
		expect(config.mcp.hezo.url).toBe(URL);
		expect(config.mcp.hezo.enabled).toBe(true);
		expect(config.mcp.hezo.headers?.Authorization).toBe(`Bearer ${TOKEN}`);
	});

	it('emits NO Stop-hook judge script (OpenCode has no in-process block-and-continue hook)', () => {
		const injection = adapter.build([HEZO_DESCRIPTOR], {
			hostHomeDir: HOME,
			containerHomeDir: HOME,
		});
		expect(injection.files.some((f) => f.hostPath.endsWith('stop-hook-judge.mjs'))).toBe(false);
		expect(injection.files.every((f) => !f.contents.includes('quality gate'))).toBe(true);
	});

	it('omits the mcp block entirely for an empty descriptor list', () => {
		const injection = adapter.build([], { hostHomeDir: HOME, containerHomeDir: HOME });
		const config = JSON.parse(injection.files[0].contents) as { mcp?: unknown };
		expect(config.mcp).toBeUndefined();
	});
});

describe('kimi adapter', () => {
	const adapter = MCP_ADAPTERS[AgentRuntime.Kimi];

	it('declares inline bearer storage and a required home dir', () => {
		expect(adapter.capabilities.requiresHomeDir).toBe(true);
		expect(adapter.capabilities.bearerTokenStorage).toBe('inline');
	});

	it('throws when no host home dir is provided', () => {
		expect(() =>
			adapter.build([HEZO_DESCRIPTOR], { hostHomeDir: null, containerHomeDir: null }),
		).toThrow(/hostHomeDir/);
	});

	it('writes config.toml, mcp.json, and a Stop-hook judge script', () => {
		const injection = adapter.build([HEZO_DESCRIPTOR], {
			hostHomeDir: HOME,
			containerHomeDir: HOME,
			providerApiKey: 'sk-kimi-test',
			model: 'kimi-k2-test',
		});

		expect(injection.cliArgs).toEqual([]);
		expect(injection.envEntries).toEqual([]);
		expect(injection.files.length).toBe(3);

		const config = injection.files.find((f) => f.hostPath === `${HOME}/config.toml`);
		const mcp = injection.files.find((f) => f.hostPath === `${HOME}/mcp.json`);
		const judge = injection.files.find((f) => f.hostPath === `${HOME}/stop-hook-judge.mjs`);
		expect(config).toBeDefined();
		expect(mcp).toBeDefined();
		expect(judge).toBeDefined();
		if (!config || !mcp || !judge) throw new Error('expected files not emitted');

		// config.toml: top-level default_model precedes the first [table].
		expect(config.contents).toContain('default_model = "kimi-k2-test"');
		expect(config.contents).toContain('default_yolo = true');
		expect(config.contents.indexOf('default_model')).toBeLessThan(config.contents.indexOf('['));
		expect(config.contents).toContain('[providers.kimi-for-coding]');
		expect(config.contents).toContain('type = "kimi"');
		expect(config.contents).toContain('api_key = "sk-kimi-test"');
		expect(config.contents).not.toContain('oauth');
		expect(config.contents).toContain('[models.kimi-k2-test]');
		// The model block requires max_context_size or the CLI rejects the config.
		expect(config.contents).toContain('max_context_size =');
		expect(config.contents).toContain('[[hooks]]');
		expect(config.contents).toContain('event = "Stop"');
		expect(config.contents).toContain(`command = "node ${HOME}/stop-hook-judge.mjs"`);

		// mcp.json: well-known mcpServers shape with inline bearer.
		const parsed = JSON.parse(mcp.contents) as {
			mcpServers: Record<string, { url: string; headers?: Record<string, string> }>;
		};
		expect(parsed.mcpServers.hezo.url).toBe(URL);
		expect(parsed.mcpServers.hezo.headers?.Authorization).toBe(`Bearer ${TOKEN}`);

		// judge script: exit-2 block protocol + Kimi upstream + rule body.
		expect(judge.mode).toBe(0o700);
		expect(judge.contents).toContain('quality gate');
		expect(judge.contents).toContain('process.exit(2)');
		expect(judge.contents).toContain('KIMI_API_KEY');
	});

	it('omits api_key when no provider credential is supplied and falls back to the default model', () => {
		const injection = adapter.build([HEZO_DESCRIPTOR], {
			hostHomeDir: HOME,
			containerHomeDir: HOME,
		});
		const config = injection.files.find((f) => f.hostPath === `${HOME}/config.toml`);
		expect(config?.contents).not.toContain('api_key');
		expect(config?.contents).toContain('default_model = "kimi-for-coding"');
	});

	it('writes the managed OAuth provider block (no api_key) for subscription auth', () => {
		const injection = adapter.build([HEZO_DESCRIPTOR], {
			hostHomeDir: HOME,
			containerHomeDir: HOME,
			authMethod: AiAuthMethod.Subscription,
			// Subscription credential is delivered via the mounted file, not providerApiKey.
		});
		const config = injection.files.find((f) => f.hostPath === `${HOME}/config.toml`);
		expect(config).toBeDefined();
		if (!config) throw new Error('expected config.toml');

		// Built-in managed provider with a colon must be a quoted TOML table key,
		// plus an .oauth sub-table pointing at the file-backed credential.
		expect(config.contents).toContain('[providers."managed:kimi-code"]');
		expect(config.contents).toContain('[providers."managed:kimi-code".oauth]');
		expect(config.contents).toContain('storage = "file"');
		expect(config.contents).toContain('key = "oauth/kimi-code"');
		// No api_key on the subscription path; the model points at the managed provider.
		expect(config.contents).not.toContain('api_key');
		expect(config.contents).toContain('provider = "managed:kimi-code"');
		expect(config.contents).toContain('max_context_size =');
	});
});
