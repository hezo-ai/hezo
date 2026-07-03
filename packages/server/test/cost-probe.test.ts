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
		expect(probeKeyEnv(AiProvider.Kimi)).toBe('HEZO_PROBE_KEY_KIMI');
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

	it('builds the Kimi (Claude Code/Moonshot) invocation from env alone — no staging', () => {
		// Kimi now runs through Claude Code against Moonshot's Anthropic-compatible
		// endpoint (the DeepSeek/Z.ai shape), authenticating from ANTHROPIC_AUTH_TOKEN.
		const inv = buildProbeInvocation(AiProvider.Kimi, { apiKey: 'sk-kimi' });
		expect(inv.runtime).toBe(AgentRuntime.ClaudeCode);
		expect(inv.promptMode).toBe('stdin');
		expect(inv.env).toContain('ANTHROPIC_BASE_URL=https://api.moonshot.ai/anthropic');
		expect(inv.env).toContain('ANTHROPIC_AUTH_TOKEN=sk-kimi');
		expect(inv.env).toContain('ENABLE_TOOL_SEARCH=false');
		expect(inv.env).toContain('DISABLE_TELEMETRY=1');
		expect(inv.cmd).toContain('--model');
		expect(inv.cmd[inv.cmd.indexOf('--model') + 1]).toBe('kimi-k2.7-code');
		// Claude Code authenticates from env alone — no credential file to stage.
		expect(inv.setup).toEqual([]);
	});

	it('builds a Claude Code invocation against an arbitrary Anthropic endpoint (--anthropic-base-url)', () => {
		// Validation override: run Kimi's key through Claude Code against Moonshot's
		// Anthropic-compatible endpoint (the DeepSeek/Z.ai shape that reports cost).
		const inv = buildProbeInvocation(AiProvider.Kimi, {
			apiKey: 'moonshot-key',
			model: 'kimi-k2.7-code',
			anthropicBaseUrl: 'https://api.moonshot.ai/anthropic',
		});
		expect(inv.runtime).toBe(AgentRuntime.ClaudeCode);
		expect(inv.promptMode).toBe('stdin');
		expect(inv.env).toContain('ANTHROPIC_BASE_URL=https://api.moonshot.ai/anthropic');
		expect(inv.env).toContain('ANTHROPIC_AUTH_TOKEN=moonshot-key');
		expect(inv.env).toContain('ANTHROPIC_DEFAULT_SONNET_MODEL=kimi-k2.7-code');
		expect(inv.env).toContain('DISABLE_TELEMETRY=1');
		expect(inv.setup).toEqual([]);
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
			'kimi-k2.7-code',
			'-p',
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
		expect(wrapProbeExecCmd(['opencode', 'run'], 'arg')).toEqual([
			'sh',
			'-c',
			'exec "$@" "$PROMPT"',
			'sh',
			'opencode',
			'run',
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

	it('prices the run against the snapshot table and reports the reported-vs-table ratio', () => {
		// A million cache-miss input tokens on deepseek-v4-pro cost $0.435 at the
		// curated official rate. Claude Code reporting $4.35 for the same run is a
		// 10x divergence — the diagnostic the probe exists to surface.
		const stdout =
			line({ type: 'system', subtype: 'init', model: 'deepseek-v4-pro[1m]', tools: [] }) +
			line({
				type: 'result',
				subtype: 'success',
				total_cost_usd: 4.35,
				usage: { input_tokens: 1_000_000, output_tokens: 0 },
			});
		const r = extractReportedCost(AgentRuntime.ClaudeCode, stdout);
		expect(r.modelId).toBe('deepseek-v4-pro[1m]');
		expect(r.tableCostUsd).toBeCloseTo(0.44, 2); // cents-rounded $0.435
		expect(r.reportedVsTableRatio).not.toBeNull();
		expect(r.reportedVsTableRatio ?? 0).toBeGreaterThan(9);
		expect(r.reportedVsTableRatio ?? 0).toBeLessThan(11);
	});

	it('carries the cache buckets and reports null table cost for an unpriced model', () => {
		const stdout =
			line({ type: 'system', subtype: 'init', model: 'not-a-real-model-xyz', tools: [] }) +
			line({
				type: 'result',
				subtype: 'success',
				total_cost_usd: 0.5,
				usage: {
					input_tokens: 100,
					cache_read_input_tokens: 900,
					cache_creation_input_tokens: 50,
					output_tokens: 10,
				},
			});
		const r = extractReportedCost(AgentRuntime.ClaudeCode, stdout);
		expect(r.inputTokens).toBe(1050);
		expect(r.cacheReadTokens).toBe(900);
		expect(r.cacheCreationTokens).toBe(50);
		expect(r.tableCostUsd).toBeNull();
		expect(r.reportedVsTableRatio).toBeNull();
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
		// A generic runtime whose output carries a text event + an end event, with
		// no usage or cost field — can't be priced from output or the table.
		const stdout =
			line({ type: 'text', data: 'ok' }) + line({ type: 'end', stopReason: 'EndTurn' });
		const r = extractReportedCost(AgentRuntime.OpenCode, stdout);
		expect(r.reportedCostUsd).toBeNull();
		expect(r.inputTokens).toBe(0);
		expect(r.outputTokens).toBe(0);
		expect(probeVerdict(r, 0)).toBe('no-usage');
	});
});
