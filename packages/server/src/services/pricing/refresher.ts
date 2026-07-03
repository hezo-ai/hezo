/**
 * Pull the pricepertoken.com catalog and upsert it into `model_pricing`.
 * Standalone (no service instance needed) so the "refresh now" route can call
 * it directly; the service wraps it to also reload its in-memory map. Throws
 * on fetch/parse failure — the route maps that to a 503 and the daily cron
 * logs and leaves the existing rows in place.
 */
import type { PGlite } from '@electric-sql/pglite';
import { type FetchLike, fetchPricePerTokenPricing } from './pricepertoken';
import { upsertFeedRates } from './repo';

/** Fetch `get_all_models` and upsert the rows. Returns the row count. */
export async function refreshPricingFromPricePerToken(
	db: PGlite,
	fetchImpl?: FetchLike,
): Promise<number> {
	const rates = await fetchPricePerTokenPricing(fetchImpl);
	await upsertFeedRates(db, rates);
	return rates.length;
}
