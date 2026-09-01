import { describe, expect, it } from 'vitest';
import {
	compareModelVersions,
	fallbackPinnedModel,
	MODEL_PIN_SPECS,
	parseModelVersion,
	pickLatestModel,
} from '../src/model-pins';
import { AiProvider } from '../src/types/common';

/**
 * The selection rule, against real catalog listings.
 *
 * The ids below were read from each provider's live `/models` endpoint, because
 * the whole point of this rule is to behave correctly on what providers actually
 * serve - a hand-invented catalog would only prove the rule matches its author's
 * expectations.
 */
describe('parseModelVersion', () => {
	it('reads the two separators providers use interchangeably', () => {
		expect(parseModelVersion('claude-sonnet-4-6')).toEqual([4, 6]);
		expect(parseModelVersion('gemini-3.6-flash')).toEqual([3, 6]);
		expect(parseModelVersion('gpt-5.3-codex')).toEqual([5, 3]);
	});

	it('drops a dated snapshot suffix, which is a release date and not a version', () => {
		// Left in, this id would outrank every later model on the strength of a
		// number that is not a version at all.
		expect(parseModelVersion('claude-haiku-4-5-20251001')).toEqual([4, 5]);
		expect(parseModelVersion('gpt-5-2025-08-07')).toEqual([5]);
	});
});

describe('compareModelVersions', () => {
	it('orders a major bump above a minor one', () => {
		expect(compareModelVersions('claude-sonnet-5', 'claude-sonnet-4-6')).toBeGreaterThan(0);
		expect(compareModelVersions('gemini-3.6-flash', 'gemini-3.5-flash')).toBeGreaterThan(0);
	});

	it('breaks a prefix tie on the longer version', () => {
		expect(compareModelVersions('kimi-k2.7-code', 'kimi-k2')).toBeGreaterThan(0);
	});

	it('is deterministic for ids carrying identical numbers', () => {
		// Otherwise a catalog's ordering could make the pin flap between refreshes.
		expect(compareModelVersions('glm-5', 'glm-5')).toBe(0);
		expect(Math.sign(compareModelVersions('a-1', 'b-1'))).toBe(-1);
	});
});

describe('pickLatestModel', () => {
	it('picks the newest Anthropic Opus without crossing tier', () => {
		const catalog = [
			'claude-opus-5',
			'claude-sonnet-5',
			'claude-fable-5',
			'claude-opus-4-8',
			'claude-sonnet-4-6',
			'claude-haiku-4-5-20251001',
		];
		// The other tiers are in the catalog and must not be reachable from this
		// pin, however their version numbers compare - crossing tier is the failure
		// the family restriction exists to prevent, in either direction.
		expect(pickLatestModel(AiProvider.Anthropic, catalog)).toBe('claude-opus-5');
	});

	it('picks a codex-family OpenAI model, never a general chat one', () => {
		const catalog = [
			'gpt-4o-mini',
			'gpt-5',
			'gpt-5.4-mini',
			'gpt-5.1-codex',
			'gpt-5.2-codex',
			'gpt-5.3-codex',
		];
		// gpt-5.4-mini is the higher version but drives the Codex CLI badly - it
		// warns "model metadata not found" and guesses the model's limits.
		expect(pickLatestModel(AiProvider.OpenAI, catalog)).toBe('gpt-5.3-codex');
	});

	it('skips Google preview and non-text families', () => {
		const catalog = [
			'gemini-2.5-flash',
			'gemini-3-flash-preview',
			'gemini-3.1-flash-lite',
			'gemini-3.1-flash-image',
			'gemini-3.5-flash',
			'gemini-3.6-flash',
			'gemini-3.1-pro-preview',
		];
		expect(pickLatestModel(AiProvider.Google, catalog)).toBe('gemini-3.6-flash');
	});

	it('prefers a Kimi major over a longer-versioned older one', () => {
		const catalog = [
			'kimi-k2.5',
			'kimi-k2.6',
			'kimi-k2.7-code',
			'kimi-k2.7-code-highspeed',
			'kimi-k3',
		];
		expect(pickLatestModel(AiProvider.Kimi, catalog)).toBe('kimi-k3');
	});

	it('matches z.ai ids case-insensitively and keeps the catalog spelling', () => {
		// The catalog answers lowercase while this repo's static env uses `GLM-4.7`;
		// the endpoint accepts either, so the pin carries what the provider said.
		expect(pickLatestModel(AiProvider.ZAi, ['glm-4.5', 'glm-4.7', 'glm-5', 'glm-5.2'])).toBe(
			'glm-5.2',
		);
	});

	it('ignores xAI ids carrying extra trailing segments', () => {
		const catalog = [
			'grok-4.20-0309-non-reasoning',
			'grok-4.20-multi-agent-0309',
			'grok-4.3',
			'grok-4.5',
			'grok-imagine-video',
		];
		expect(pickLatestModel(AiProvider.XAi, catalog)).toBe('grok-4.5');
	});

	it('picks OpenRouter’s own auto route out of a catalog of vendor lines', () => {
		const catalog = [
			'anthropic/claude-haiku-4.5',
			'anthropic/claude-opus-5',
			'openrouter/auto',
			'openai/gpt-5.3-codex',
			'google/gemini-3.6-flash',
		];
		// A router's value is the routing: a vendor line inside its catalog would
		// out-version the auto route on every comparison, so the family is that one
		// id exactly and nothing else in the catalog is reachable from this pin.
		expect(pickLatestModel(AiProvider.OpenRouter, catalog)).toBe('openrouter/auto');
	});

	it('holds the OpenRouter pin when the catalog stops listing the auto route', () => {
		// Nothing else here is a sane substitute, so null - the caller keeps what it
		// had rather than picking a vendor line the operator never chose.
		expect(
			pickLatestModel(AiProvider.OpenRouter, ['anthropic/claude-opus-5', 'openai/gpt-5.3-codex']),
		).toBeNull();
	});

	it('holds the previous pin when the family matches nothing', () => {
		// Renamed upstream, or a key that sees a restricted catalog. Null means the
		// caller keeps what it had rather than pinning something from another tier.
		expect(pickLatestModel(AiProvider.Anthropic, ['gpt-5.3-codex', 'gemini-3.6-flash'])).toBeNull();
		expect(pickLatestModel(AiProvider.Anthropic, [])).toBeNull();
	});

	it('has no pin for the local runners, whose catalog is the operator’s own', () => {
		expect(MODEL_PIN_SPECS[AiProvider.Ollama]).toBeUndefined();
		expect(MODEL_PIN_SPECS[AiProvider.LmStudio]).toBeUndefined();
		expect(pickLatestModel(AiProvider.Ollama, ['llama3'])).toBeNull();
		expect(fallbackPinnedModel(AiProvider.Ollama)).toBeNull();
	});

	it('ships a fallback that its own family accepts', () => {
		// A fallback outside the family would be replaced by the very first refresh,
		// which makes the compile-time default a different model from the pinned one.
		for (const [provider, spec] of Object.entries(MODEL_PIN_SPECS)) {
			expect(`${provider}: ${spec.fallback}`).toBe(
				`${provider}: ${pickLatestModel(provider as AiProvider, [spec.fallback])}`,
			);
		}
	});
});
