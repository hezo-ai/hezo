/**
 * Hand-verified model rates that override both pricing feeds.
 *
 * The public feeds (llm-prices.com and LiteLLM) lag or mis-list some models —
 * verified 2026-07-03: both list deepseek-v4-pro at $1.74/M input, $3.48/M
 * output, $0.145/M cache-read (4x/4x/40x the official price), and LiteLLM
 * lists deepseek-v4-flash cache-read at 10x. Rates here are taken from the
 * provider's official pricing page and win over feed values in every merge
 * (bundled snapshot seed and live refresh alike); operator `manual` rows in
 * `model_pricing` still win over these.
 *
 * All values are **per token**. Keep entries minimal: add a model only when a
 * feed value is confirmed wrong against the provider's official pricing page,
 * and note the source + verification date. Remove an entry once the feeds are
 * correct again.
 */
import type { ParsedRate } from './feed';

export const CURATED_RATES: ParsedRate[] = [
	// DeepSeek — https://api-docs.deepseek.com/quick_start/pricing (2026-07-03).
	// Cache reads bill at the "cache hit" price; cache writes carry no premium
	// and bill at the ordinary (cache miss) input price.
	{
		modelId: 'deepseek-v4-pro',
		inputPerToken: 4.35e-7, // $0.435 / M (cache miss)
		outputPerToken: 8.7e-7, // $0.87 / M
		cacheReadPerToken: 3.625e-9, // $0.003625 / M (cache hit)
		cacheCreationPerToken: 4.35e-7,
	},
	{
		modelId: 'deepseek-v4-flash',
		inputPerToken: 1.4e-7, // $0.14 / M (cache miss)
		outputPerToken: 2.8e-7, // $0.28 / M
		cacheReadPerToken: 2.8e-9, // $0.0028 / M (cache hit)
		cacheCreationPerToken: 1.4e-7,
	},
	// Z.ai — https://docs.z.ai/guides/overview/pricing (2026-07-03). Neither feed
	// lists GLM models, which would price Z.ai runs at $0. No cache-write premium
	// documented; creation bills at the ordinary input price.
	{
		modelId: 'glm-4.7',
		inputPerToken: 6e-7, // $0.60 / M
		outputPerToken: 2.2e-6, // $2.20 / M
		cacheReadPerToken: 1.1e-7, // $0.11 / M
		cacheCreationPerToken: 6e-7,
	},
	{
		modelId: 'glm-4.5-air',
		inputPerToken: 2e-7, // $0.20 / M
		outputPerToken: 1.1e-6, // $1.10 / M
		cacheReadPerToken: 3e-8, // $0.03 / M
		cacheCreationPerToken: 2e-7,
	},
	// Kimi (Moonshot) — https://platform.kimi.ai/docs/pricing/chat-k27-code
	// (2026-07-03). Neither feed lists it; same no-write-premium convention.
	{
		modelId: 'kimi-k2.7-code',
		inputPerToken: 9.5e-7, // $0.95 / M (cache miss)
		outputPerToken: 4e-6, // $4.00 / M
		cacheReadPerToken: 1.9e-7, // $0.19 / M (cache hit)
		cacheCreationPerToken: 9.5e-7,
	},
];
