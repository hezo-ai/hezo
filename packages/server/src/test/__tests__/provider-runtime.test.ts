import { AiProvider, claudeCodeModelArg, providerDirectUpstreamHosts } from '@hezo/shared';
import { describe, expect, it } from 'vitest';

describe('providerDirectUpstreamHosts', () => {
	it('returns api.deepseek.com for DeepSeek', () => {
		expect(providerDirectUpstreamHosts(AiProvider.DeepSeek)).toEqual(['api.deepseek.com']);
	});

	it('returns api.anthropic.com for Anthropic', () => {
		expect(providerDirectUpstreamHosts(AiProvider.Anthropic)).toEqual(['api.anthropic.com']);
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
