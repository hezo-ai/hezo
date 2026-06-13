/**
 * Pull the live LiteLLM feed and upsert it into `model_pricing`. Standalone
 * (no service instance needed) so the "refresh now" route can call it directly;
 * the service wraps it to also reload its in-memory map.
 */
import type { PGlite } from '@electric-sql/pglite';
import { type FetchLike, fetchLiteLlmPricing } from './feed';
import { upsertFeedRates } from './repo';

/** Fetch the feed and upsert `source='litellm'` rows. Returns the row count. */
export async function refreshPricingFromFeed(db: PGlite, fetchImpl?: FetchLike): Promise<number> {
	const rates = await fetchLiteLlmPricing(fetchImpl);
	await upsertFeedRates(db, rates);
	return rates.length;
}
