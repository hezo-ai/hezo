/**
 * Model pricing feeds: two upstream sources combined into one rate set.
 *
 * - **LiteLLM** (`model_prices_and_context_window.json`): a large community
 *   catalog keyed `modelId → { per-token costs }`. It carries cache *creation*
 *   (write) costs, which matter for Anthropic, and a long tail of models.
 * - **llm-prices.com** (`current-v1.json`): a curated, current list of
 *   `{ id, input, output, input_cached }` quoted **per million tokens**. It
 *   tracks newer models LiteLLM lags on (e.g. DeepSeek V4).
 *
 * Both normalize to per-token `ParsedRate` rows. `mergeRates` blends them:
 * llm-prices values win where present (the curated/current source), LiteLLM
 * supplies any model llm-prices omits and backfills the cache-creation cost it
 * doesn't carry. `CURATED_RATES` (hand-verified against official pricing pages)
 * override both feeds wherever they list a model. The committed snapshot seeds
 * the table offline / on first boot.
 */
import { CURATED_RATES } from './curated-rates';
import snapshot from './litellm-snapshot.json';

/** The community-maintained LiteLLM dataset. Per-token costs. */
export const LITELLM_PRICING_URL =
	'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json';

/** The curated llm-prices.com dataset. Per-million-token costs. */
export const LLM_PRICES_URL = 'https://www.llm-prices.com/current-v1.json';

/** llm-prices.com quotes costs per this many tokens; we store per-token. */
const TOKENS_PER_MILLION = 1_000_000;

/** One entry in the LiteLLM feed (only the fields we price on). */
export interface LiteLlmEntry {
	input_cost_per_token?: number;
	output_cost_per_token?: number;
	cache_read_input_token_cost?: number;
	cache_creation_input_token_cost?: number;
}

/** One entry in the llm-prices.com feed. Costs are per **million** tokens. */
export interface LlmPricesEntry {
	id?: string;
	vendor?: string;
	name?: string;
	input?: number;
	output?: number;
	input_cached?: number | null;
}

/** Top-level llm-prices.com payload. */
export interface LlmPricesFeed {
	updated_at?: string;
	prices?: LlmPricesEntry[];
}

/** A normalized rate row ready to upsert into `model_pricing`. */
export interface ParsedRate {
	modelId: string;
	inputPerToken: number;
	outputPerToken: number;
	cacheReadPerToken: number | null;
	cacheCreationPerToken: number | null;
}

/** `fetch`-compatible signature so tests can inject a stub. */
export type FetchLike = (
	input: string,
	init?: { signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

/**
 * Map a raw LiteLLM map to rate rows. Skips the `sample_spec` meta key and any
 * entry without both an input and output per-token cost (audio/embedding/etc.
 * specs that don't price like a chat model, or partial rows).
 */
export function parseLiteLlmPricing(data: Record<string, LiteLlmEntry>): ParsedRate[] {
	const out: ParsedRate[] = [];
	for (const [modelId, entry] of Object.entries(data)) {
		if (modelId === 'sample_spec') continue;
		if (!entry || typeof entry !== 'object') continue;
		if (typeof entry.input_cost_per_token !== 'number') continue;
		if (typeof entry.output_cost_per_token !== 'number') continue;
		out.push({
			modelId,
			inputPerToken: entry.input_cost_per_token,
			outputPerToken: entry.output_cost_per_token,
			cacheReadPerToken:
				typeof entry.cache_read_input_token_cost === 'number'
					? entry.cache_read_input_token_cost
					: null,
			cacheCreationPerToken:
				typeof entry.cache_creation_input_token_cost === 'number'
					? entry.cache_creation_input_token_cost
					: null,
		});
	}
	return out;
}

/**
 * Map the llm-prices.com feed to rate rows, converting per-million costs to
 * per-token. Skips entries missing an id or either of input/output. The feed
 * carries no cache-*creation* cost, so that field is left null (the cost math
 * falls back to the base input rate, or to LiteLLM's value after merge).
 * Tolerates a missing or non-array `prices` field by returning no rows.
 */
export function parseLlmPrices(data: LlmPricesFeed): ParsedRate[] {
	const out: ParsedRate[] = [];
	const prices = Array.isArray(data?.prices) ? data.prices : [];
	for (const entry of prices) {
		if (!entry || typeof entry.id !== 'string') continue;
		if (typeof entry.input !== 'number') continue;
		if (typeof entry.output !== 'number') continue;
		out.push({
			modelId: entry.id,
			inputPerToken: entry.input / TOKENS_PER_MILLION,
			outputPerToken: entry.output / TOKENS_PER_MILLION,
			cacheReadPerToken:
				typeof entry.input_cached === 'number' ? entry.input_cached / TOKENS_PER_MILLION : null,
			cacheCreationPerToken: null,
		});
	}
	return out;
}

/**
 * Combine two rate sets into one, keyed by lowercased model id. `primary` wins
 * for any model both list; `secondary` supplies models `primary` omits and
 * backfills null cache fields (so a feed that lacks cache-creation costs borrows
 * them from the other). Required input/output always come from the winning row.
 */
export function mergeRates(primary: ParsedRate[], secondary: ParsedRate[]): ParsedRate[] {
	const byId = new Map<string, ParsedRate>();
	for (const rate of secondary) byId.set(rate.modelId.toLowerCase(), rate);
	for (const rate of primary) {
		const key = rate.modelId.toLowerCase();
		const other = byId.get(key);
		byId.set(
			key,
			other
				? {
						modelId: rate.modelId,
						inputPerToken: rate.inputPerToken,
						outputPerToken: rate.outputPerToken,
						cacheReadPerToken: rate.cacheReadPerToken ?? other.cacheReadPerToken,
						cacheCreationPerToken: rate.cacheCreationPerToken ?? other.cacheCreationPerToken,
					}
				: rate,
		);
	}
	return [...byId.values()];
}

/** Fetch + parse the live LiteLLM feed. Throws on a non-2xx response. */
export async function fetchLiteLlmPricing(
	fetchImpl: FetchLike = globalThis.fetch as unknown as FetchLike,
): Promise<ParsedRate[]> {
	const res = await fetchImpl(LITELLM_PRICING_URL);
	if (!res.ok) {
		throw new Error(`LiteLLM pricing fetch failed: HTTP ${res.status}`);
	}
	const data = (await res.json()) as Record<string, LiteLlmEntry>;
	return parseLiteLlmPricing(data);
}

/** Fetch + parse the live llm-prices.com feed. Throws on a non-2xx response. */
export async function fetchLlmPrices(
	fetchImpl: FetchLike = globalThis.fetch as unknown as FetchLike,
): Promise<ParsedRate[]> {
	const res = await fetchImpl(LLM_PRICES_URL);
	if (!res.ok) {
		throw new Error(`llm-prices fetch failed: HTTP ${res.status}`);
	}
	const data = (await res.json()) as LlmPricesFeed;
	return parseLlmPrices(data);
}

/** Rates from the committed snapshot (with curated overrides applied) — seeds
 * the table on first boot / offline. */
export function loadSnapshotRates(): ParsedRate[] {
	return mergeRates(CURATED_RATES, parseLiteLlmPricing(snapshot as Record<string, LiteLlmEntry>));
}
