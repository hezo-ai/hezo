import {
	AgentRuntime,
	AiProvider,
	claudeCodeModelArg,
	opencodeModelArg,
	opencodeModelKey,
	PROVIDER_TO_RUNTIME,
	providerDirectUpstreamHosts,
	RUNTIME_AUTO_APPROVE_ARGS,
	RUNTIME_STREAM_ARGS,
} from '@hezo/shared';
import { describe, expect, it } from 'vitest';

describe('providerDirectUpstreamHosts', () => {
	it('returns api.deepseek.com for DeepSeek', () => {
		expect(providerDirectUpstreamHosts(AiProvider.DeepSeek)).toEqual(['api.deepseek.com']);
	});

	it('returns api.anthropic.com for Anthropic', () => {
		expect(providerDirectUpstreamHosts(AiProvider.Anthropic)).toEqual(['api.anthropic.com']);
	});

	it('routes OpenRouter direct and Kimi via its Moonshot endpoint host', () => {
		expect(providerDirectUpstreamHosts(AiProvider.OpenRouter)).toEqual(['openrouter.ai']);
		// Kimi runs on Claude Code against Moonshot's Anthropic-compatible endpoint,
		// so the direct host is derived from ANTHROPIC_BASE_URL.
		expect(providerDirectUpstreamHosts(AiProvider.Kimi)).toEqual(['api.moonshot.ai']);
	});
});

describe('provider → runtime mapping', () => {
	it('drives OpenRouter through OpenCode and Kimi through Claude Code', () => {
		expect(PROVIDER_TO_RUNTIME[AiProvider.OpenRouter]).toBe(AgentRuntime.OpenCode);
		expect(PROVIDER_TO_RUNTIME[AiProvider.Kimi]).toBe(AgentRuntime.ClaudeCode);
	});
});

describe('opencodeModelArg', () => {
	it('prefixes the OpenRouter provider key onto a bare model id', () => {
		expect(opencodeModelArg(AiProvider.OpenRouter, 'anthropic/claude-sonnet-4.5')).toBe(
			'openrouter/anthropic/claude-sonnet-4.5',
		);
	});

	it('leaves an already-qualified id untouched', () => {
		expect(opencodeModelArg(AiProvider.OpenRouter, 'openrouter/x-ai/grok')).toBe(
			'openrouter/x-ai/grok',
		);
	});

	it('returns the model unchanged for providers without an OpenCode key', () => {
		expect(opencodeModelArg(AiProvider.Anthropic, 'claude-opus-4-6')).toBe('claude-opus-4-6');
	});

	it('opencodeModelKey takes the prefix back off for the config map', () => {
		expect(opencodeModelKey(AiProvider.OpenRouter, 'openrouter/x-ai/grok')).toBe('x-ai/grok');
		expect(opencodeModelKey(AiProvider.OpenRouter, 'x-ai/grok')).toBe('x-ai/grok');
		expect(opencodeModelKey(AiProvider.Anthropic, 'claude-opus-4-6')).toBe('claude-opus-4-6');
	});

	it('asks OpenCode to stream the model reasoning it is now always told to do', () => {
		// `--thinking` is what puts reasoning parts on the `--format json` stream;
		// without it a run reasons invisibly and the log shows no thinking blocks.
		// `--print-logs` sends the CLI's own diagnostics to stderr, which the runner
		// relays verbatim, so a failure the JSON stream describes only generically
		// still names its provider and model.
		expect(RUNTIME_STREAM_ARGS[AgentRuntime.OpenCode]).toEqual([
			'--format',
			'json',
			'--thinking',
			'--print-logs',
			'--log-level',
			'ERROR',
		]);
	});

	it('auto-approves OpenCode with the flag OpenCode actually has', () => {
		// Not `--dangerously-skip-permissions`: that is Claude Code's spelling, and
		// OpenCode accepts unknown flags silently, so the wrong one never applied.
		expect(RUNTIME_AUTO_APPROVE_ARGS[AgentRuntime.OpenCode]).toEqual(['--auto']);
		expect(RUNTIME_AUTO_APPROVE_ARGS[AgentRuntime.OpenCode]).not.toContain(
			'--dangerously-skip-permissions',
		);
	});
});

describe('claudeCodeModelArg', () => {
	it('strips [1m] suffixes from DeepSeek model ids', () => {
		expect(claudeCodeModelArg(AiProvider.DeepSeek, 'deepseek-v4-pro[1m]')).toBe('deepseek-v4-pro');
		expect(claudeCodeModelArg(AiProvider.DeepSeek, 'deepseek-v4-pro[1m][1m]')).toBe(
			'deepseek-v4-pro',
		);
	});

	it('leaves other providers unchanged', () => {
		expect(claudeCodeModelArg(AiProvider.Anthropic, 'claude-opus-4-6')).toBe('claude-opus-4-6');
	});
});
