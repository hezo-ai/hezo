/**
 * LiteLLM pricing feed: parsing, fetching, and the bundled offline snapshot.
 *
 * The public feed (`model_prices_and_context_window.json`) and the committed
 * snapshot share the exact same shape — a map of `modelId → { per-token costs }`
 * — so one parser (`parseLiteLlmPricing`) handles both. No DB here; the repo
 * persists, the service orchestrates.
 */
import snapshot from './litellm-snapshot.json';

/** The canonical, continuously-updated open pricing dataset. Per-token costs. */
export const LITELLM_PRICING_URL =
	'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json';

/** One entry in the LiteLLM feed (only the fields we price on). */
export interface LiteLlmEntry {
	input_cost_per_token?: number;
	output_cost_per_token?: number;
	cache_read_input_token_cost?: number;
	cache_creation_input_token_cost?: number;
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

/** Fetch + parse the live feed. Throws on a non-2xx response. */
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

/** Rates from the committed snapshot — seeds the table on first boot / offline. */
export function loadSnapshotRates(): ParsedRate[] {
	return parseLiteLlmPricing(snapshot as Record<string, LiteLlmEntry>);
}
