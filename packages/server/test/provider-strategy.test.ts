import { AiProvider } from '@hezo/shared';
import { describe, expect, it } from 'vitest';
import { getJudgeModel, PROVIDER_STRATEGIES } from '../src/services/runtime/provider-strategy';
import {
	STOP_HOOK_JUDGE_MODEL_ANTHROPIC,
	STOP_HOOK_JUDGE_MODEL_GOOGLE,
	STOP_HOOK_JUDGE_MODEL_OPENAI,
} from '../src/services/stop-hook-prompt';

describe('PROVIDER_STRATEGIES', () => {
	it('has a strategy for every AiProvider', () => {
		const providers = Object.values(AiProvider);
		expect(providers.length).toBeGreaterThan(0);
		expect(Object.keys(PROVIDER_STRATEGIES).sort()).toEqual([...providers].sort());
	});

	it('keeps the existing providers pointed at their current judge models', () => {
		// These three must not drift — the judge call runs against the provider's
		// own upstream, which can serve exactly these models today.
		expect(PROVIDER_STRATEGIES[AiProvider.Anthropic].judgeModel).toBe(
			STOP_HOOK_JUDGE_MODEL_ANTHROPIC,
		);
		expect(PROVIDER_STRATEGIES[AiProvider.OpenAI].judgeModel).toBe(STOP_HOOK_JUDGE_MODEL_OPENAI);
		expect(PROVIDER_STRATEGIES[AiProvider.Google].judgeModel).toBe(STOP_HOOK_JUDGE_MODEL_GOOGLE);
	});

	it('fails open for Claude Code providers whose upstream cannot serve an Anthropic judge model', () => {
		// DeepSeek / Z.ai run on the Claude Code runtime against a non-Anthropic
		// upstream, so a null judge model omits the gate (today's effective behavior).
		expect(PROVIDER_STRATEGIES[AiProvider.DeepSeek].judgeModel).toBeNull();
		expect(PROVIDER_STRATEGIES[AiProvider.ZAi].judgeModel).toBeNull();
	});

	it('getJudgeModel mirrors the registry', () => {
		for (const provider of Object.values(AiProvider)) {
			expect(getJudgeModel(provider)).toBe(PROVIDER_STRATEGIES[provider].judgeModel);
		}
	});
});
