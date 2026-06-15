import {
	AgentRuntime,
	AiProvider,
	claudeCodeModelArg,
	opencodeModelArg,
	PROVIDER_TO_RUNTIME,
	providerDirectUpstreamHosts,
} from '@hezo/shared';
import { describe, expect, it } from 'vitest';

describe('providerDirectUpstreamHosts', () => {
	it('returns api.deepseek.com for DeepSeek', () => {
		expect(providerDirectUpstreamHosts(AiProvider.DeepSeek)).toEqual(['api.deepseek.com']);
	});

	it('returns api.anthropic.com for Anthropic', () => {
		expect(providerDirectUpstreamHosts(AiProvider.Anthropic)).toEqual(['api.anthropic.com']);
	});

	it('routes OpenRouter and Kimi traffic direct to their upstreams', () => {
		expect(providerDirectUpstreamHosts(AiProvider.OpenRouter)).toEqual(['openrouter.ai']);
		expect(providerDirectUpstreamHosts(AiProvider.Kimi)).toEqual(['api.kimi.com']);
	});
});

describe('provider → runtime mapping', () => {
	it('drives OpenRouter through OpenCode and Kimi through the kimi runtime', () => {
		expect(PROVIDER_TO_RUNTIME[AiProvider.OpenRouter]).toBe(AgentRuntime.OpenCode);
		expect(PROVIDER_TO_RUNTIME[AiProvider.Kimi]).toBe(AgentRuntime.Kimi);
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
