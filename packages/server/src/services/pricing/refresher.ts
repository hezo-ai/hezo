/**
 * Pull both pricing feeds, merge them, and upsert into `model_pricing`.
 * Standalone (no service instance needed) so the "refresh now" route can call it
 * directly; the service wraps it to also reload its in-memory map.
 */
import type { PGlite } from '@electric-sql/pglite';
import { logger } from '../../logger';
import {
	type FetchLike,
	fetchLiteLlmPricing,
	fetchLlmPrices,
	mergeRates,
	type ParsedRate,
} from './feed';
import { upsertFeedRates } from './repo';

const log = logger.child('pricing');

/**
 * Fetch both feeds, merge (llm-prices wins, LiteLLM fills gaps + cache-creation),
 * and upsert the combined `source='litellm'` rows. Tolerant of a single feed
 * being unavailable — as long as one returns rows the refresh proceeds; only a
 * total outage throws. Returns the merged row count.
 */
export async function refreshPricingFromFeed(db: PGlite, fetchImpl?: FetchLike): Promise<number> {
	const [llmPrices, litellm] = await Promise.allSettled([
		fetchLlmPrices(fetchImpl),
		fetchLiteLlmPricing(fetchImpl),
	]);
	if (llmPrices.status === 'rejected' && litellm.status === 'rejected') {
		throw new Error(
			`pricing feeds unavailable: ${(litellm.reason as Error)?.message}; ${(llmPrices.reason as Error)?.message}`,
		);
	}
	const rates = mergeRates(ratesOf(llmPrices, 'llm-prices'), ratesOf(litellm, 'LiteLLM'));
	await upsertFeedRates(db, rates);
	return rates.length;
}

/** Unwrap a settled feed fetch, logging and yielding no rows on failure. */
function ratesOf(result: PromiseSettledResult<ParsedRate[]>, label: string): ParsedRate[] {
	if (result.status === 'fulfilled') return result.value;
	log.warn(`${label} pricing feed unavailable: ${(result.reason as Error)?.message}`);
	return [];
}
