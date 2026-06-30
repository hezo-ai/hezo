import { AgentRuntime, AiProvider } from '@hezo/shared';
import { describe, expect, it } from 'vitest';
import {
	buildProbeInvocation,
	DEFAULT_PROBE_PROMPT,
	extractReportedCost,
	probeKeyEnv,
	probeVerdict,
	wrapProbeExecCmd,
} from '../src/services/cost-probe';

const line = (e: unknown) => `${JSON.stringify(e)}\n`;

describe('cost-probe › probeKeyEnv', () => {
	it('derives a collision-free env var from the provider slug', () => {
		expect(probeKeyEnv(AiProvider.DeepSeek)).toBe('HEZO_PROBE_KEY_DEEPSEEK');
		expect(probeKeyEnv(AiProvider.XAi)).toBe('HEZO_PROBE_KEY_X_AI');
		expect(probeKeyEnv(AiProvider.OpenRouter)).toBe('HEZO_PROBE_KEY_OPENROUTER');
	});
});

describe('cost-probe › buildProbeInvocation', () => {
	it('builds the DeepSeek (Claude Code) invocation with the provider env and stream flags', () => {
		const inv = buildProbeInvocation(AiProvider.DeepSeek, { apiKey: 'sk-deepseek' });
		expect(inv.runtime).toBe(AgentRuntime.ClaudeCode);
		expect(inv.promptMode).toBe('stdin');
		// Provider env mirrors buildProviderEnv: base URL, model defaults, quiet env,
		// the credential under DeepSeek's auth-token var, plus the prompt.
		expect(inv.env).toContain('ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic');
		expect(inv.env).toContain('ANTHROPIC_AUTH_TOKEN=sk-deepseek');
		expect(inv.env).toContain('DISABLE_TELEMETRY=1');
		expect(inv.env).toContain(`PROMPT=${DEFAULT_PROBE_PROMPT}`);
		// Never leak the key onto the native Anthropic var for a third-party endpoint.
		expect(inv.env.some((e) => e.startsWith('ANTHROPIC_API_KEY='))).toBe(false);
		// CLI argv mirrors the production assembly.
		expect(inv.cmd).toEqual([
			'claude',
			'--output-format',
			'stream-json',
			'--verbose',
			'--dangerously-skip-permissions',
			'--disallowedTools',
			'WebFetch',
			'ExitPlanMode',
			'--model',
			'deepseek-v4-flash',
			'-p',
		]);
		// Claude Code authenticates from env alone — no credential file to stage.
		expect(inv.setup).toEqual([]);
	});

	it('builds the OpenAI (Codex) invocation with the exec subcommand and stdin positional', () => {
		const inv = buildProbeInvocation(AiProvider.OpenAI, { apiKey: 'sk-openai' });
		expect(inv.runtime).toBe(AgentRuntime.Codex);
		expect(inv.env).toContain('OPENAI_API_KEY=sk-openai');
		expect(inv.cmd).toEqual([
			'codex',
			'exec',
			'--json',
			'--dangerously-bypass-approvals-and-sandbox',
			'--model',
			'gpt-4o-mini',
			'-',
		]);
		// Codex authenticates from $CODEX_HOME/auth.json (a bare OPENAI_API_KEY env run
		// falls back to ChatGPT mode and 401s), so the probe stages the key there.
		expect(inv.env).toContain('CODEX_HOME=/home/node/.codex');
		expect(inv.env).toContain('CODEX_AUTH_JSON={"OPENAI_API_KEY":"sk-openai"}');
		expect(inv.setup).toEqual([
			'mkdir -p "$CODEX_HOME"',
			'printf %s "$CODEX_AUTH_JSON" > "$CODEX_HOME/auth.json"',
		]);
	});

	it('builds the Google (Gemini) invocation with GEMINI_API_KEY, not GOOGLE_API_KEY', () => {
		const inv = buildProbeInvocation(AiProvider.Google, { apiKey: 'g-key' });
		expect(inv.runtime).toBe(AgentRuntime.Gemini);
		// The Gemini CLI authenticates from GEMINI_API_KEY; a bare GOOGLE_API_KEY is
		// not accepted as an auth method.
		expect(inv.env).toContain('GEMINI_API_KEY=g-key');
		expect(inv.env.some((e) => e.startsWith('GOOGLE_API_KEY='))).toBe(false);
		// /workspace is untrusted to the Gemini CLI unless we say otherwise.
		expect(inv.env).toContain('GEMINI_CLI_TRUST_WORKSPACE=true');
		expect(inv.cmd).toEqual([
			'gemini',
			'--output-format',
			'stream-json',
			'--yolo',
			'--model',
			'gemini-2.5-flash',
		]);
		expect(inv.setup).toEqual([]);
	});

	it('strips the DeepSeek [1m] tag from an overridden model (Claude Code re-appends it)', () => {
		const inv = buildProbeInvocation(AiProvider.DeepSeek, {
			apiKey: 'k',
			model: 'deepseek-v4-pro[1m]',
		});
		expect(inv.cmd).toContain('--model');
		expect(inv.cmd[inv.cmd.indexOf('--model') + 1]).toBe('deepseek-v4-pro');
	});

	it('qualifies an OpenRouter model with the opencode provider key', () => {
		const inv = buildProbeInvocation(AiProvider.OpenRouter, { apiKey: 'k', model: 'x-ai/grok' });
		expect(inv.runtime).toBe(AgentRuntime.OpenCode);
		expect(inv.cmd[0]).toBe('opencode');
		expect(inv.cmd).toContain('run');
		expect(inv.cmd[inv.cmd.indexOf('--model') + 1]).toBe('openrouter/x-ai/grok');
	});

	it('passes no --model flag for Kimi (it resolves the model from config)', () => {
		const inv = buildProbeInvocation(AiProvider.Kimi, { apiKey: 'k', model: 'whatever' });
		expect(inv.cmd).not.toContain('--model');
		expect(inv.promptMode).toBe('arg');
	});

	it('passes no --model flag for xAI/Grok even with an override (CLI rejects api.x.ai ids)', () => {
		const inv = buildProbeInvocation(AiProvider.XAi, { apiKey: 'k', model: 'grok-4-fast' });
		expect(inv.runtime).toBe(AgentRuntime.Grok);
		expect(inv.cmd).not.toContain('--model');
		expect(inv.cmd).toEqual(['grok', '--output-format', 'streaming-json', '-p']);
		expect(inv.promptMode).toBe('arg');
	});

	it('stages a Kimi config.toml with the api key + declared model', () => {
		const inv = buildProbeInvocation(AiProvider.Kimi, { apiKey: 'k-key' });
		expect(inv.runtime).toBe(AgentRuntime.Kimi);
		expect(inv.env).toContain('KIMI_CODE_HOME=/home/node/.kimi-code');
		const toml = inv.env.find((e) => e.startsWith('KIMI_CONFIG_TOML='));
		expect(toml).toBeDefined();
		// Kimi reads its key + model from config, not env; the staged config carries both.
		expect(toml).toContain('default_model = "kimi-for-coding"');
		expect(toml).toContain('default_yolo = true');
		expect(toml).toContain('base_url = "https://api.kimi.com/coding/v1"');
		expect(toml).toContain('api_key = "k-key"');
		expect(inv.setup).toEqual([
			'mkdir -p "$KIMI_CODE_HOME"',
			'printf %s "$KIMI_CONFIG_TOML" > "$KIMI_CODE_HOME/config.toml"',
		]);
	});

	it('honors a custom prompt', () => {
		const inv = buildProbeInvocation(AiProvider.DeepSeek, { apiKey: 'k', prompt: 'ping' });
		expect(inv.env).toContain('PROMPT=ping');
	});
});

describe('cost-probe › wrapProbeExecCmd', () => {
	it('pipes the prompt on stdin for stdin-mode runtimes', () => {
		expect(wrapProbeExecCmd(['claude', '-p'], 'stdin')).toEqual([
			'sh',
			'-c',
			'printf %s "$PROMPT" | "$@"',
			'sh',
			'claude',
			'-p',
		]);
	});

	it('appends the prompt as the trailing arg for arg-mode runtimes', () => {
		expect(wrapProbeExecCmd(['grok', '-p'], 'arg')).toEqual([
			'sh',
			'-c',
			'exec "$@" "$PROMPT"',
			'sh',
			'grok',
			'-p',
		]);
	});

	it('runs setup commands before the CLI when credential staging is needed', () => {
		expect(
			wrapProbeExecCmd(['codex', 'exec', '-'], 'stdin', [
				'mkdir -p "$CODEX_HOME"',
				'printf %s "$CODEX_AUTH_JSON" > "$CODEX_HOME/auth.json"',
			]),
		).toEqual([
			'sh',
			'-c',
			'mkdir -p "$CODEX_HOME"\nprintf %s "$CODEX_AUTH_JSON" > "$CODEX_HOME/auth.json"\nprintf %s "$PROMPT" | "$@"',
			'sh',
			'codex',
			'exec',
			'-',
		]);
	});
});

describe('cost-probe › extractReportedCost', () => {
	it('reads a Claude Code total_cost_usd and tokens from the result event', () => {
		const stdout =
			line({ type: 'system', subtype: 'init', model: 'deepseek-v4-pro', tools: [] }) +
			line({
				type: 'result',
				subtype: 'success',
				total_cost_usd: 0.4567,
				usage: { input_tokens: 100, output_tokens: 50 },
			});
		const r = extractReportedCost(AgentRuntime.ClaudeCode, stdout);
		expect(r.reportedCostUsd).toBe(0.4567);
		expect(r.inputTokens).toBe(100);
		expect(r.outputTokens).toBe(50);
		expect(r.costEvent).not.toBeNull();
		expect(probeVerdict(r, 0)).toBe('cost-emitted');
	});

	it('reports null cost but real tokens when the runtime emits no cost (Codex)', () => {
		const stdout =
			line({ type: 'thread.started', model: 'gpt-4o-mini' }) +
			line({ type: 'turn.completed', usage: { input_tokens: 1000, output_tokens: 100 } });
		const r = extractReportedCost(AgentRuntime.Codex, stdout);
		expect(r.reportedCostUsd).toBeNull();
		expect(r.inputTokens).toBe(1000);
		expect(r.outputTokens).toBe(100);
		expect(probeVerdict(r, 0)).toBe('tokens-only');
	});

	it('reads a generic runtime cost field', () => {
		const stdout = line({
			type: 'result',
			cost: 0.1,
			usage: { input_tokens: 10, output_tokens: 5 },
		});
		const r = extractReportedCost(AgentRuntime.OpenCode, stdout);
		expect(r.reportedCostUsd).toBe(0.1);
		expect(probeVerdict(r, 0)).toBe('cost-emitted');
	});

	it('classifies a crashed run with no output as no-output', () => {
		const r = extractReportedCost(AgentRuntime.ClaudeCode, '');
		expect(r.reportedCostUsd).toBeNull();
		expect(r.inputTokens).toBe(0);
		expect(probeVerdict(r, 1)).toBe('no-output');
	});

	it('classifies a clean run that emitted output but no cost/usage as no-usage', () => {
		// Real xAI/Grok shape: a text event + an end event, no usage or cost.
		const stdout =
			line({ type: 'text', data: 'ok' }) + line({ type: 'end', stopReason: 'EndTurn' });
		const r = extractReportedCost(AgentRuntime.Grok, stdout);
		expect(r.reportedCostUsd).toBeNull();
		expect(r.inputTokens).toBe(0);
		expect(r.outputTokens).toBe(0);
		expect(probeVerdict(r, 0)).toBe('no-usage');
	});
});
