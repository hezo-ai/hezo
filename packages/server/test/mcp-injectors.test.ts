import { AgentRuntime, AiProvider } from '@hezo/shared';
import { describe, expect, it } from 'vitest';
import { MCP_ADAPTERS, type McpDescriptor, validateInjection } from '../src/services/mcp-injectors';
import type { McpInjectionFile } from '../src/services/mcp-injectors/types';
import {
	STOP_HOOK_JUDGE_MODEL_ANTHROPIC,
	STOP_HOOK_JUDGE_MODEL_DEEPSEEK,
	STOP_HOOK_JUDGE_MODEL_KIMI,
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
		it('admits closing a task when the gated tail is filed as a blocked_by follow-up', () => {
			expect(STOP_HOOK_RULES).toContain(
				'filing the deferred work as a SEPARATE task whose blocked_by_task_ids points at',
			);
			expect(STOP_HOOK_RULES).toContain('marking the current task terminal is fine');
		});

		it('still rejects an unguarded top-level task or close-while-deferring', () => {
			expect(STOP_HOOK_RULES).toContain('A new TOP-LEVEL task with NO such blocker edge');
			expect(STOP_HOOK_RULES).toContain('is still NOT an acceptable deferral');
		});

		it('rule 9 accepts the rule-3 structural routes as carrying an announced plan out', () => {
			// Executing an announced delegation via sub-tasks / blocked_by / self-comment
			// IS carrying it out — the plan-abandonment rule must not contradict rule 3's
			// legitimate deferral paths.
			expect(STOP_HOOK_RULES).toContain('structural routes rule 3 accepts');
		});

		it('rule 10 blocks a handoff that exists only in the final message', () => {
			// The final assistant text is delivered to no one — a handoff/@-mention
			// there must have been posted via create_comment or the stop is blocked.
			expect(STOP_HOOK_RULES).toContain('exists only in the final message');
		});

		it('rule 11 blocks closing while an inherited approval is still ungranted', () => {
			// A reviewer's own pass is not the ticket's final approval; an approval the
			// thread established as required (admin final approval / a named approver's
			// sign-off) must actually land before the ticket can close.
			expect(STOP_HOOK_RULES).toContain('approval requirement INHERITED from the thread');
			expect(STOP_HOOK_RULES).toContain('does NOT discharge a pending approval');
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
		// The emitted prompt must carry the stop_hook_active loop breaker so a persistent
		// verdict can't spin the same headless exec (parity with the command-script judges).
		expect(hookEntry.prompt).toContain('stop_hook_active');
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

	const judgeModelFor = (provider?: AiProvider, runModel?: string | null): string => {
		const injection = adapter.build([HEZO_DESCRIPTOR], {
			hostHomeDir: HOME,
			containerHomeDir: HOME,
			provider,
			runModel,
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

	it('threads the run model into the judge for a third-party provider (no code change on upgrade)', () => {
		// A run pinned to a newer Moonshot flagship judges with THAT model, so the
		// hook survives a provider model upgrade without touching the constant.
		expect(judgeModelFor(AiProvider.Kimi, 'kimi-k3')).toBe('kimi-k3');
		// Anthropic still uses its stable Sonnet judge regardless of the run model.
		expect(judgeModelFor(AiProvider.Anthropic, 'claude-opus-4-8')).toBe(
			STOP_HOOK_JUDGE_MODEL_ANTHROPIC,
		);
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

	it('raises the background-terminal ceiling (top-level) and per-MCP-server timeouts', () => {
		const injection = adapter.build([HEZO_DESCRIPTOR], {
			hostHomeDir: HOME,
			containerHomeDir: HOME,
		});
		const config = injection.files.find((f) => f.hostPath === `${HOME}/config.toml`);
		if (!config) throw new Error('config.toml not emitted');
		// The direct analog of CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS (default 300000).
		expect(config.contents).toContain('background_terminal_max_timeout = 3600000');
		// Must stay a top-level key: before the first [table] header.
		expect(config.contents.indexOf('background_terminal_max_timeout')).toBeLessThan(
			config.contents.indexOf('['),
		);
		// Per-server tool + startup ceilings (defaults 300s / 30s).
		expect(config.contents).toContain('tool_timeout_sec = 1800');
		expect(config.contents).toContain('startup_timeout_sec = 120');
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

	it('disables the 5-min shell inactivity kill and sets a generous per-MCP timeout', () => {
		const injection = adapter.build([HEZO_DESCRIPTOR], {
			hostHomeDir: HOME,
			containerHomeDir: HOME,
		});
		const settings = injection.files.find((f) => f.hostPath === `${HOME}/.gemini/settings.json`);
		if (!settings) throw new Error('settings.json not emitted');
		const parsed = JSON.parse(settings.contents) as {
			tools: { shell: { inactivityTimeout: number } };
			mcpServers: Record<string, { timeout: number }>;
		};
		// 0 disables the kill of a long, silent `run_shell_command` (default 300s).
		expect(parsed.tools.shell.inactivityTimeout).toBe(0);
		expect(parsed.mcpServers.hezo.timeout).toBe(600_000);
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

	it('rejects a file mode that is zero or out of range', () => {
		for (const mode of [0, 0o1000]) {
			expect(() =>
				validateInjection(codex, {
					cliArgs: [],
					envEntries: [],
					files: [{ hostPath: '/tmp/c.toml', mode, contents: 'x' }],
				}),
			).toThrow(/mode out of range/);
		}
	});

	it('rejects an empty file', () => {
		expect(() =>
			validateInjection(codex, {
				cliArgs: [],
				envEntries: [],
				files: [{ hostPath: '/tmp/c.toml', mode: 0o600, contents: '' }],
			}),
		).toThrow(/empty/);
	});

	it('rejects an env entry that is not KEY=VALUE', () => {
		expect(() =>
			validateInjection(codex, {
				cliArgs: [],
				envEntries: ['NOEQUALS'],
				files: [],
			}),
		).toThrow(/KEY=VALUE/);
	});

	it('accepts a well-formed injection', () => {
		expect(() =>
			validateInjection(codex, {
				cliArgs: [],
				envEntries: ['HEZO_MCP_BEARER_TOKEN_HEZO=tok'],
				files: [{ hostPath: '/tmp/c.toml', mode: 0o600, contents: 'url = "x"' }],
			}),
		).not.toThrow();
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

	it('raises the per-MCP-server request timeout well above the 5s default', () => {
		const injection = adapter.build([HEZO_DESCRIPTOR], {
			hostHomeDir: HOME,
			containerHomeDir: HOME,
		});
		const config = JSON.parse(injection.files[0].contents) as {
			mcp: Record<string, { timeout: number }>;
		};
		// OpenCode's `mcp.<name>.timeout` defaults to 5000ms — any tool call slower
		// than 5s fails. We stamp a generous 10-minute ceiling instead.
		expect(config.mcp.hezo.timeout).toBe(600_000);
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

	it('renders a local (stdio) MCP server with its command array and environment', () => {
		const stdio: McpDescriptor = {
			kind: 'stdio',
			name: 'local-srv',
			command: '/usr/bin/srv',
			args: ['--port', '7'],
			env: { TOKEN: 'x' },
		};
		const injection = adapter.build([stdio], { hostHomeDir: HOME, containerHomeDir: HOME });
		const config = JSON.parse(injection.files[0].contents) as {
			mcp: Record<
				string,
				{ type: string; command: string[]; enabled: boolean; environment?: Record<string, string> }
			>;
		};
		expect(config.mcp['local-srv']).toEqual({
			type: 'local',
			command: ['/usr/bin/srv', '--port', '7'],
			enabled: true,
			timeout: 600_000,
			environment: { TOKEN: 'x' },
		});
	});

	it('omits headers and environment when none are provided', () => {
		const http: McpDescriptor = { kind: 'http', name: 'bare', url: URL };
		const injection = adapter.build([http], { hostHomeDir: HOME, containerHomeDir: HOME });
		const config = JSON.parse(injection.files[0].contents) as {
			mcp: Record<string, { headers?: unknown }>;
		};
		expect(config.mcp.bare.headers).toBeUndefined();
	});
});

describe('grok adapter', () => {
	const adapter = MCP_ADAPTERS[AgentRuntime.Grok];
	const GROK_HOME = '/workspace/.hezo/subscription/grok/run-1';

	it('declares inline bearer storage and a required home dir', () => {
		expect(adapter.capabilities.requiresHomeDir).toBe(true);
		expect(adapter.capabilities.bearerTokenStorage).toBe('inline');
	});

	it('throws when no host home dir is provided', () => {
		expect(() =>
			adapter.build([HEZO_DESCRIPTOR], { hostHomeDir: null, containerHomeDir: null }),
		).toThrow(/hostHomeDir/);
	});

	it('writes config.toml with an [mcp_servers.*] http block + inline bearer header and auto_update=false', () => {
		const injection = adapter.build([HEZO_DESCRIPTOR], {
			hostHomeDir: GROK_HOME,
			containerHomeDir: GROK_HOME,
		});

		// GROK_HOME is set via the home-mount env entry by the runner, not the
		// adapter; the adapter only writes config.toml + the debug flag (added by
		// the runner). It carries no cliArgs/envEntries of its own.
		expect(injection.cliArgs).toEqual([]);
		expect(injection.envEntries).toEqual([]);
		expect(injection.files.length).toBe(1);
		const file = injection.files[0];
		expect(file.hostPath).toBe(`${GROK_HOME}/config.toml`);
		expect(file.mode).toBe(0o600);

		expect(file.contents).toContain('[mcp_servers.hezo]');
		expect(file.contents).toContain(`url = "${URL}"`);
		expect(file.contents).toContain('enabled = true');
		expect(file.contents).toContain('[mcp_servers.hezo.headers]');
		expect(file.contents).toContain(`Authorization = "Bearer ${TOKEN}"`);
		expect(file.contents).toContain('[cli]\nauto_update = false');
		// Slow-starting MCP servers get more than the 30s default startup handshake,
		// and long foreground shell commands more than the 120s default before Grok
		// auto-backgrounds them.
		expect(file.contents).toContain('startup_timeout_sec = 120');
		expect(file.contents).toContain('[toolset.bash]\ntimeout_secs = 3600');
	});

	it('emits NO Stop-hook judge script (Grok Stop hooks are passive — fail-open like OpenCode)', () => {
		const injection = adapter.build([HEZO_DESCRIPTOR], {
			hostHomeDir: GROK_HOME,
			containerHomeDir: GROK_HOME,
		});
		expect(injection.files.some((f) => f.hostPath.endsWith('stop-hook-judge.mjs'))).toBe(false);
		expect(injection.files.every((f) => !f.contents.includes('quality gate'))).toBe(true);
	});

	it('renders a stdio MCP server with command/args and an [mcp_servers.*.env] sub-table', () => {
		const stdio: McpDescriptor = {
			kind: 'stdio',
			name: 'local-srv',
			command: '/usr/bin/srv',
			args: ['--port', '7'],
			env: { TOKEN: 'x' },
		};
		const injection = adapter.build([stdio], {
			hostHomeDir: GROK_HOME,
			containerHomeDir: GROK_HOME,
		});
		const contents = injection.files[0].contents;
		expect(contents).toContain('[mcp_servers.local-srv]');
		expect(contents).toContain('command = "/usr/bin/srv"');
		expect(contents).toContain('args = ["--port", "7"]');
		expect(contents).toContain('[mcp_servers.local-srv.env]');
		expect(contents).toContain('TOKEN = "x"');
	});

	it('still writes [cli] auto_update=false with an empty descriptor list', () => {
		const injection = adapter.build([], { hostHomeDir: GROK_HOME, containerHomeDir: GROK_HOME });
		expect(injection.files[0].contents).toContain('[cli]\nauto_update = false');
		expect(injection.files[0].contents).not.toContain('[mcp_servers.');
	});
});

describe('kimi adapter', () => {
	const adapter = MCP_ADAPTERS[AgentRuntime.Kimi];
	const KIMI_HOME = '/workspace/.hezo/subscription/kimi-code/run-1';
	const HOMES = { hostHomeDir: KIMI_HOME, containerHomeDir: KIMI_HOME };

	const readJson = (contents: string): { mcpServers: Record<string, Record<string, unknown>> } =>
		JSON.parse(contents) as { mcpServers: Record<string, Record<string, unknown>> };
	// Typed as the real injection file rather than a hand-narrowed shape: callers
	// read `mode` and `contents` off the result, which the narrower type hid.
	const fileNamed = (injection: { files: readonly McpInjectionFile[] }, name: string) =>
		injection.files.find((f) => f.hostPath.endsWith(name));

	it('declares env-var bearer storage and a required home dir', () => {
		// env-var (not inline) because Kimi Code natively supports
		// `bearerTokenEnvVar`; validateInjection then enforces no token in a file.
		expect(adapter.capabilities.requiresHomeDir).toBe(true);
		expect(adapter.capabilities.bearerTokenStorage).toBe('env-var');
	});

	it('throws when no host home dir is provided', () => {
		expect(() =>
			adapter.build([HEZO_DESCRIPTOR], { hostHomeDir: null, containerHomeDir: null }),
		).toThrow(/hostHomeDir/);
	});

	it('writes mcp.json referencing the bearer by env var, never inlining the token', () => {
		const injection = adapter.build([HEZO_DESCRIPTOR], HOMES);

		// There is no --mcp-config flag; $KIMI_CODE_HOME is the only isolation
		// mechanism, so the adapter contributes no CLI args.
		expect(injection.cliArgs).toEqual([]);

		const mcp = fileNamed(injection, 'mcp.json');
		expect(mcp).toBeDefined();
		expect(mcp?.mode).toBe(0o600);
		const parsed = readJson(mcp?.contents ?? '');
		expect(parsed.mcpServers.hezo.url).toBe(URL);
		expect(parsed.mcpServers.hezo.bearerTokenEnvVar).toBe('HEZO_MCP_BEARER_TOKEN_HEZO');
		expect(mcp?.contents).not.toContain(TOKEN);

		// The value travels via env instead.
		expect(injection.envEntries).toContain(`HEZO_MCP_BEARER_TOKEN_HEZO=${TOKEN}`);
		expect(() => validateInjection(adapter, injection)).not.toThrow();
	});

	it('raises the per-server MCP timeouts well above the CLI defaults', () => {
		// Kimi Code defaults to 30s startup / 60s per tool call; Hezo MCP tools
		// routinely exceed the latter.
		const injection = adapter.build([HEZO_DESCRIPTOR], HOMES);
		const parsed = readJson(fileNamed(injection, 'mcp.json')?.contents ?? '');
		expect(parsed.mcpServers.hezo.startupTimeoutMs).toBe(120_000);
		expect(parsed.mcpServers.hezo.toolTimeoutMs).toBe(1_800_000);
	});

	it('writes config.toml with a four-key [[hooks]] Stop entry and an allow-all permission rule', () => {
		const injection = adapter.build([HEZO_DESCRIPTOR], HOMES);
		const toml = fileNamed(injection, 'config.toml');
		expect(toml?.mode).toBe(0o600);
		const contents = toml?.contents ?? '';

		expect(contents).toContain('[[hooks]]');
		expect(contents).toContain('event = "Stop"');
		expect(contents).toContain(`command = "node ${KIMI_HOME}/stop-hook-judge.mjs"`);
		expect(contents).toContain('timeout = 30');
		expect(contents).toContain('[permission.rules]');

		// Kimi refuses to LOAD a config whose [[hooks]] entry carries any key beyond
		// these four, which would break every run on this runtime rather than just
		// the hook. Assert the exact key set.
		const hookBlock = contents.slice(contents.indexOf('[[hooks]]'));
		const keys = [...hookBlock.matchAll(/^(\w+)\s*=/gm)].map((m) => m[1]);
		expect(keys.sort()).toEqual(['command', 'event', 'timeout']);
	});

	it('writes an executable judge script carrying the shared rules', () => {
		const injection = adapter.build([HEZO_DESCRIPTOR], HOMES);
		const judge = fileNamed(injection, 'stop-hook-judge.mjs');
		expect(judge).toBeDefined();
		expect(judge?.mode).toBe(0o700);
		expect(judge?.contents).toContain(STOP_HOOK_JUDGE_MODEL_KIMI);
		expect(judge?.contents).toContain('api.moonshot.ai/v1/chat/completions');
		expect(judge?.contents).toContain('KIMI_MODEL_API_KEY');
		// The rules body is shared verbatim across every runtime that judges.
		expect(judge?.contents).toContain(JSON.stringify(STOP_HOOK_RULES).slice(1, 60));
	});

	it('gives the judge a session-log lookup and a marker-file loop guard', () => {
		// Kimi's Stop payload carries neither the final assistant message nor
		// stop_hook_active, so both substitutes must be present or the judge is
		// either blind or unbounded.
		const injection = adapter.build([HEZO_DESCRIPTOR], HOMES);
		const judge = fileNamed(injection, 'stop-hook-judge.mjs')?.contents ?? '';
		expect(judge).toContain('KIMI_CODE_HOME');
		expect(judge).toContain('wire.jsonl');
		expect(judge).toContain('.hezo-stop-blocked');
		expect(judge).toContain('alreadyBlocked()');
		expect(judge).toContain('markBlocked()');
		// Exit code 2 is Kimi's documented "intentional block"; 0 would discard it.
		expect(judge).toContain('process.exitCode = 2');
	});

	it('renders a stdio MCP server with command/args/env', () => {
		const stdio: McpDescriptor = {
			kind: 'stdio',
			name: 'local-srv',
			command: '/usr/bin/srv',
			args: ['--port', '7'],
			env: { TOKEN: 'x' },
		};
		const injection = adapter.build([stdio], HOMES);
		const parsed = readJson(fileNamed(injection, 'mcp.json')?.contents ?? '');
		expect(parsed.mcpServers['local-srv'].command).toBe('/usr/bin/srv');
		expect(parsed.mcpServers['local-srv'].args).toEqual(['--port', '7']);
		expect(parsed.mcpServers['local-srv'].env).toEqual({ TOKEN: 'x' });
	});

	it('still writes the Stop hook with an empty descriptor list, and no mcp.json', () => {
		// A run with no connectors must still be judged; an empty mcpServers map is
		// not meaningfully different from no file.
		const injection = adapter.build([], HOMES);
		expect(fileNamed(injection, 'config.toml')?.contents).toContain('event = "Stop"');
		expect(fileNamed(injection, 'mcp.json')).toBeUndefined();
		expect(injection.envEntries).toEqual([]);
	});
});

/**
 * A connector whose method allowlist withholds two of its four tools. The
 * descriptor carries both views of the restriction because the runtimes disagree
 * on shape — allowlist (Gemini, OpenCode) vs deny list (Claude Code).
 */
const RESTRICTED_DESCRIPTOR: McpDescriptor = {
	kind: 'http',
	name: 'linear',
	url: 'https://mcp.linear.app/mcp',
	enabledTools: ['get_issue', 'list_issues'],
	disabledTools: ['save_issue', 'delete_comment'],
};

describe('per-connector MCP method filtering', () => {
	const HOMES = { hostHomeDir: HOME, containerHomeDir: HOME };

	describe('claude-code', () => {
		const adapter = MCP_ADAPTERS[AgentRuntime.ClaudeCode];

		it('denies the withheld tools by fully-qualified name in settings.json', () => {
			const injection = adapter.build([HEZO_DESCRIPTOR, RESTRICTED_DESCRIPTOR], HOMES);
			const settings = JSON.parse(injection.files[0].contents) as {
				permissions?: { deny: string[] };
			};
			expect(settings.permissions?.deny).toEqual([
				'mcp__linear__save_issue',
				'mcp__linear__delete_comment',
			]);
		});

		it('omits the permissions block entirely when nothing is restricted', () => {
			const injection = adapter.build([HEZO_DESCRIPTOR], HOMES);
			const settings = JSON.parse(injection.files[0].contents) as Record<string, unknown>;
			expect(settings.permissions).toBeUndefined();
		});

		it('does not emit a --disallowedTools flag (the runner appends the global one)', () => {
			// A second --disallowedTools would collide with the flag agent-runner
			// splices in from RUNTIME_DISALLOWED_TOOLS_ARGS.
			const injection = adapter.build([RESTRICTED_DESCRIPTOR], HOMES);
			expect(injection.cliArgs).not.toContain('--disallowedTools');
		});
	});

	describe('gemini', () => {
		const adapter = MCP_ADAPTERS[AgentRuntime.Gemini];

		it('emits includeTools as the per-server allowlist', () => {
			const injection = adapter.build([HEZO_DESCRIPTOR, RESTRICTED_DESCRIPTOR], HOMES);
			const settings = JSON.parse(injection.files[0].contents) as {
				mcpServers: Record<string, { includeTools?: string[] }>;
			};
			expect(settings.mcpServers.linear.includeTools).toEqual(['get_issue', 'list_issues']);
			expect(settings.mcpServers.hezo.includeTools).toBeUndefined();
		});

		it('never emits excludeTools (its precedence would decide the effective set)', () => {
			const injection = adapter.build([RESTRICTED_DESCRIPTOR], HOMES);
			expect(injection.files[0].contents).not.toContain('excludeTools');
		});
	});

	describe('opencode', () => {
		const adapter = MCP_ADAPTERS[AgentRuntime.OpenCode];

		it('denies the server namespace then re-allows the enabled tools, in that order', () => {
			const injection = adapter.build([HEZO_DESCRIPTOR, RESTRICTED_DESCRIPTOR], HOMES);
			const config = JSON.parse(injection.files[0].contents) as {
				tools?: Record<string, boolean>;
			};
			// Key order is precedence order, so the wildcard must come first.
			expect(Object.entries(config.tools ?? {})).toEqual([
				['linear*', false],
				['linear_get_issue', true],
				['linear_list_issues', true],
			]);
		});

		it('omits the tools map when nothing is restricted', () => {
			const injection = adapter.build([HEZO_DESCRIPTOR], HOMES);
			const config = JSON.parse(injection.files[0].contents) as Record<string, unknown>;
			expect(config.tools).toBeUndefined();
		});
	});

	describe('kimi', () => {
		it('emits both enabledTools and disabledTools per server in mcp.json', () => {
			// Kimi Code supports both views natively, so unlike every other runtime
			// the descriptor maps across one-to-one with no reshaping.
			const adapter = MCP_ADAPTERS[AgentRuntime.Kimi];
			const injection = adapter.build([HEZO_DESCRIPTOR, RESTRICTED_DESCRIPTOR], HOMES);
			const mcp = injection.files.find((f) => f.hostPath.endsWith('mcp.json'));
			const parsed = JSON.parse(mcp?.contents ?? '') as {
				mcpServers: Record<string, { enabledTools?: string[]; disabledTools?: string[] }>;
			};
			expect(parsed.mcpServers.linear.enabledTools).toEqual(['get_issue', 'list_issues']);
			expect(parsed.mcpServers.linear.disabledTools).toEqual(['save_issue', 'delete_comment']);
		});

		it('emits no filter at all for an unrestricted server', () => {
			const adapter = MCP_ADAPTERS[AgentRuntime.Kimi];
			const injection = adapter.build([HEZO_DESCRIPTOR], HOMES);
			const mcp = injection.files.find((f) => f.hostPath.endsWith('mcp.json'));
			const parsed = JSON.parse(mcp?.contents ?? '') as {
				mcpServers: Record<string, Record<string, unknown>>;
			};
			expect(parsed.mcpServers.hezo.enabledTools).toBeUndefined();
			expect(parsed.mcpServers.hezo.disabledTools).toBeUndefined();
		});
	});

	describe('codex and grok', () => {
		it('pass the restriction through untouched (no documented per-server filter)', () => {
			// Deliberate: guessing a TOML key risks the CLI rejecting the whole
			// config. The egress proxy still enforces the allowlist for these runs.
			for (const runtime of [AgentRuntime.Codex, AgentRuntime.Grok]) {
				const injection = MCP_ADAPTERS[runtime].build([RESTRICTED_DESCRIPTOR], HOMES);
				const contents = injection.files.map((f) => f.contents).join('\n');
				expect(contents, runtime).toContain('[mcp_servers.linear]');
				expect(contents, runtime).not.toContain('get_issue');
			}
		});
	});

	it('every adapter still produces a valid injection when a descriptor is restricted', () => {
		for (const runtime of Object.values(AgentRuntime)) {
			const adapter = MCP_ADAPTERS[runtime];
			const injection = adapter.build([HEZO_DESCRIPTOR, RESTRICTED_DESCRIPTOR], HOMES);
			expect(() => validateInjection(adapter, injection), runtime).not.toThrow();
		}
	});
});
