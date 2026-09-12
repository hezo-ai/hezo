/**
 * Model pricing math, shared by the server's run-cost path.
 *
 * Rates are **per-token** (the `model_pricing` table stores per-token values),
 * and a run's cost is the dot product of its token buckets with the matching
 * rates.
 *
 * Four buckets, not two: cache-read and cache-creation tokens bill at very
 * different rates from regular input. Anthropic charges cache *reads* at ~0.1x
 * and cache *writes* (creation) at ~1.25x of the base input rate; OpenAI reads
 * cached input at ~0.1x and charges no write premium. The token data carries the
 * buckets separately, so we price them separately when the rates are known.
 *
 * The pricepertoken.com catalog carries no cache rates of its own, so they are
 * derived from each provider's published multipliers (see `CACHE_RATE_MULTIPLIERS`
 * in the server's pricing service). A provider whose multipliers have not been
 * verified keeps null rates and falls back to the full input rate - deliberately
 * conservative, an upper bound rather than an understatement, since a guessed
 * multiplier is wrong in a direction nobody checks.
 *
 * That fallback is not a small effect where it applies: an agent run is
 * cache-read dominated, ~96% on a live instance, so a provider left on it reads
 * roughly tenfold high. A manual override row can supply real cache rates.
 */

/** Per-token rates for one model. Cache rates fall back to the input rate. */
export interface ModelRate {
	inputPerToken: number;
	outputPerToken: number;
	/** Discounted rate for cache *reads*; falls back to `inputPerToken`. */
	cacheReadPerToken?: number | null;
	/** Premium rate for cache *writes* (creation); falls back to `inputPerToken`. */
	cacheCreationPerToken?: number | null;
}

/**
 * Token counts for a single run, split by billing bucket. `inputTokens` is the
 * *regular* (non-cached) input only — cache reads/writes are their own buckets
 * and are never folded into `inputTokens`.
 */
export interface CostTokens {
	inputTokens: number;
	cacheReadTokens?: number;
	cacheCreationTokens?: number;
	outputTokens: number;
}

/** Compute a run's cost in integer cents from per-token rates. */
export function costCentsFromRate(rate: ModelRate, tokens: CostTokens): number {
	const nz = (n: number | undefined): number => (n && n > 0 ? n : 0);
	const cacheReadRate = rate.cacheReadPerToken ?? rate.inputPerToken;
	const cacheCreationRate = rate.cacheCreationPerToken ?? rate.inputPerToken;
	const dollars =
		nz(tokens.inputTokens) * rate.inputPerToken +
		nz(tokens.cacheReadTokens) * cacheReadRate +
		nz(tokens.cacheCreationTokens) * cacheCreationRate +
		nz(tokens.outputTokens) * rate.outputPerToken;
	return Math.round(dollars * 100);
}
