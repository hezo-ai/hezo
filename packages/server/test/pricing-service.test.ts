import type { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FetchLike, LlmPricesFeed } from '../src/services/pricing';
import {
	CURATED_RATES,
	countModelPricing,
	LLM_PRICES_URL,
	loadSnapshotRates,
	mergeRates,
	normalizeModelId,
	PricingService,
	parseLlmPrices,
	upsertManualRate,
} from '../src/services/pricing';
import { createTestDbWithMigrations } from './helpers/db';

let db: PGlite;

beforeEach(async () => {
	db = await createTestDbWithMigrations();
});

afterEach(async () => {
	await db.close();
});

/** A `fetch` stub returning a fixed LiteLLM-shaped payload. */
function stubFetch(payload: Record<string, unknown>): FetchLike {
	return async () => ({ ok: true, status: 200, json: async () => payload });
}

/** A `fetch` stub serving each feed its own payload, keyed by URL. */
function stubFeeds(litellm: Record<string, unknown>, llmPrices: LlmPricesFeed): FetchLike {
	return async (url) => ({
		ok: true,
		status: 200,
		json: async () => (url === LLM_PRICES_URL ? llmPrices : litellm),
	});
}

const M = 1_000_000;

describe('normalizeModelId', () => {
	it('strips provider prefix, 1m tag, and release date', () => {
		expect(normalizeModelId('openai/gpt-5')).toBe('gpt-5');
		expect(normalizeModelId('claude-opus-4-8-20260205')).toBe('claude-opus-4-8');
		expect(normalizeModelId('gpt-5-2025-08-07')).toBe('gpt-5');
		expect(normalizeModelId('deepseek-v4-pro[1m]')).toBe('deepseek-v4-pro');
		expect(normalizeModelId('zai/glm-4.7')).toBe('glm-4.7');
	});

	it('strips any bracketed context-window tag, not just [1m]', () => {
		expect(normalizeModelId('deepseek-v4-pro[2m]')).toBe('deepseek-v4-pro');
		expect(normalizeModelId('glm-4.7[200k]')).toBe('glm-4.7');
		expect(normalizeModelId('anthropic/claude-opus-4-8[1m]')).toBe('claude-opus-4-8');
	});
});

describe('PricingService', () => {
	it('seeds from the bundled snapshot when the table is empty', async () => {
		expect(await countModelPricing(db)).toBe(0);
		const svc = new PricingService(db);
		await svc.init();
		expect(await countModelPricing(db)).toBeGreaterThan(0);
		// claude-opus-4-8 is in the snapshot; 1M regular input @ $5/M = $5.00 → 500c.
		expect(svc.costCents('claude-opus-4-8', { inputTokens: M, outputTokens: 0 })).toBe(500);
	});

	it('resolves prefixed / dated model ids to the same rate', async () => {
		const svc = new PricingService(db);
		await svc.init();
		const exact = svc.costCents('claude-opus-4-8', { inputTokens: M, outputTokens: 0 });
		expect(svc.costCents('anthropic/claude-opus-4-8', { inputTokens: M, outputTokens: 0 })).toBe(
			exact,
		);
		expect(svc.costCents('claude-opus-4-8-20991231', { inputTokens: M, outputTokens: 0 })).toBe(
			exact,
		);
	});

	it('returns 0 for an unknown model', async () => {
		const svc = new PricingService(db);
		await svc.init();
		expect(svc.costCents('no-such-model-xyz', { inputTokens: M, outputTokens: M })).toBe(0);
		expect(svc.costCents(undefined, { inputTokens: M, outputTokens: M })).toBe(0);
	});

	it('prices a context-tagged model off its nearest feed sibling', async () => {
		const svc = new PricingService(db);
		await svc.init();
		// The feed lists only a dated variant of the model the CLI reports.
		await svc.refresh(
			stubFetch({
				'deepseek-r2-pro-0606': {
					input_cost_per_token: 0.000001,
					output_cost_per_token: 0.000002,
				},
			}),
		);
		// Exact dated id prices directly: 1M input @ $1/M → 100c.
		const exact = svc.costCents('deepseek-r2-pro-0606', { inputTokens: M, outputTokens: 0 });
		expect(exact).toBe(100);
		// The logged miss now resolves: strip `[1m]`, then match the segment-prefix
		// sibling instead of recording $0.
		expect(svc.costCents('deepseek-r2-pro[1m]', { inputTokens: M, outputTokens: 0 })).toBe(exact);
	});

	it('prices a more-specific variant off its base model', async () => {
		const svc = new PricingService(db);
		await svc.init();
		// `gpt-5-pro` isn't in the feed but `gpt-5` is; the variant borrows the base
		// rate rather than falling through to $0.
		const base = svc.costCents('gpt-5', { inputTokens: M, outputTokens: 0 });
		expect(base).toBeGreaterThan(0);
		expect(svc.costCents('gpt-5-pro[1m]', { inputTokens: M, outputTokens: 0 })).toBe(base);
	});

	it('does not cross-match a model sharing only a vendor prefix', async () => {
		const svc = new PricingService(db);
		await svc.init();
		// `deepseek-r2-pro` shares only the `deepseek` vendor token with the seeded
		// deepseek rows — not a whole-segment prefix — so it must stay unpriced
		// rather than borrow an unrelated rate.
		expect(svc.costCents('deepseek-r2-pro[1m]', { inputTokens: M, outputTokens: 0 })).toBe(0);
		// A sibling version is likewise not a match for a different sibling.
		expect(svc.costCents('claude-sonnet-9', { inputTokens: M, outputTokens: 0 })).toBe(0);
	});

	it('lets a manual override win over the feed row', async () => {
		const svc = new PricingService(db);
		await svc.init();
		const seeded = svc.costCents('claude-opus-4-8', { inputTokens: M, outputTokens: 0 });
		await upsertManualRate(db, {
			model_id: 'claude-opus-4-8',
			input_per_token: 0.001,
			output_per_token: 0.001,
		});
		await svc.reload();
		// 1M input @ $0.001/token = $1000 → 100000c, distinct from the seeded rate.
		expect(svc.costCents('claude-opus-4-8', { inputTokens: M, outputTokens: 0 })).toBe(100_000);
		expect(svc.costCents('claude-opus-4-8', { inputTokens: M, outputTokens: 0 })).not.toBe(seeded);
	});

	it('refreshes from the feed and preserves manual overrides', async () => {
		const svc = new PricingService(db);
		await svc.init();
		await upsertManualRate(db, {
			model_id: 'claude-opus-4-8',
			input_per_token: 0.001,
			output_per_token: 0.001,
		});
		await svc.reload();

		const count = await svc.refresh(
			stubFetch({
				'new-model-x': { input_cost_per_token: 0.00001, output_cost_per_token: 0.00002 },
				// The feed also lists claude-opus-4-8, but the manual override must win.
				'claude-opus-4-8': { input_cost_per_token: 0.000005, output_cost_per_token: 0.000025 },
			}),
		);
		// The two stub models plus the curated built-in rows merged into every refresh.
		expect(count).toBe(2 + CURATED_RATES.length);
		// New feed model is now priced: 1M input @ $0.00001 = $10 → 1000c.
		expect(svc.costCents('new-model-x', { inputTokens: M, outputTokens: 0 })).toBe(1000);
		// Manual override survives the refresh.
		expect(svc.costCents('claude-opus-4-8', { inputTokens: M, outputTokens: 0 })).toBe(100_000);
	});

	it('prices cache reads at the discounted feed rate', async () => {
		const svc = new PricingService(db);
		await svc.init();
		// claude-opus-4-8 snapshot: input $5/M, cache-read $0.5/M.
		// 1M cache reads should cost $0.50 → 50c, not $5.00.
		expect(
			svc.costCents('claude-opus-4-8', { inputTokens: 0, cacheReadTokens: M, outputTokens: 0 }),
		).toBe(50);
	});

	it('combines both feeds: llm-prices supplies new models, LiteLLM backfills cache-creation', async () => {
		const svc = new PricingService(db);
		await svc.init();
		await svc.refresh(
			stubFeeds(
				{
					// Overlapping model — LiteLLM carries the cache-creation cost that
					// llm-prices omits.
					'claude-x': {
						input_cost_per_token: 0.000005,
						output_cost_per_token: 0.000025,
						cache_creation_input_token_cost: 0.00000625,
					},
				},
				{
					updated_at: 'now',
					prices: [
						// New model LiteLLM lacks; quoted per million tokens.
						{ id: 'newmodel-9', input: 1.74, output: 3.48, input_cached: 0.145 },
						// Same model as LiteLLM, with a different (winning) input price.
						{ id: 'claude-x', input: 6, output: 30 },
					],
				},
			),
		);
		// The new model comes from llm-prices: 1M input @ $1.74/M → 174c.
		expect(svc.costCents('newmodel-9', { inputTokens: M, outputTokens: 0 })).toBe(174);
		// The id the CLI actually reports (context-tagged) resolves to the same rate.
		expect(svc.costCents('newmodel-9[1m]', { inputTokens: M, outputTokens: 0 })).toBe(174);
		// On the overlap, llm-prices' input price wins: 1M input @ $6/M → 600c.
		expect(svc.costCents('claude-x', { inputTokens: M, outputTokens: 0 })).toBe(600);
		// …but cache-creation, absent from llm-prices, is backfilled from LiteLLM:
		// 1M cache-creation @ $6.25/M → 625c (not the input-rate fallback of 600c).
		expect(
			svc.costCents('claude-x', { inputTokens: 0, cacheCreationTokens: M, outputTokens: 0 }),
		).toBe(625);
	});

	it('curated rates override wrong feed values for DeepSeek v4 (regression)', async () => {
		// Both public feeds mis-list deepseek-v4-pro (llm-prices/LiteLLM carry
		// $1.74/M input — 4x the official $0.435/M — and a 40x cache-read rate).
		// The curated built-in rates must win over both feeds on refresh.
		const svc = new PricingService(db);
		await svc.init();
		await svc.refresh(
			stubFeeds(
				{
					'deepseek-v4-pro': {
						input_cost_per_token: 0.00000174,
						output_cost_per_token: 0.00000348,
						cache_read_input_token_cost: 1.45e-7,
					},
				},
				{
					updated_at: 'now',
					prices: [{ id: 'deepseek-v4-pro', input: 1.74, output: 3.48, input_cached: 0.145 }],
				},
			),
		);
		// Official rate: 1M input (cache miss) @ $0.435/M → 43.5 → 44c, not 174c.
		expect(svc.costCents('deepseek-v4-pro', { inputTokens: M, outputTokens: 0 })).toBe(44);
		// The context-tagged id the CLI reports resolves to the same curated rate.
		expect(svc.costCents('deepseek-v4-pro[1m]', { inputTokens: M, outputTokens: 0 })).toBe(44);
		// Cache reads bill at the official cache-hit price: 1M @ $0.003625/M → 0c
		// (rounded); 10M reads → $0.03625 → 4c. The wrong feed rate would give 145c.
		expect(
			svc.costCents('deepseek-v4-pro', {
				inputTokens: 0,
				cacheReadTokens: 10 * M,
				outputTokens: 0,
			}),
		).toBe(4);
		// A manual operator row still beats the curated rate.
		await upsertManualRate(db, {
			model_id: 'deepseek-v4-pro',
			input_per_token: 0.000001,
			output_per_token: 0.000001,
		});
		await svc.reload();
		expect(svc.costCents('deepseek-v4-pro', { inputTokens: M, outputTokens: 0 })).toBe(100);
	});
});

describe('loadSnapshotRates', () => {
	it('applies every curated override on top of the bundled snapshot', () => {
		// The seed path (first boot / offline) must already carry the corrected
		// rates — a fresh instance never prices DeepSeek/GLM/Kimi runs off the
		// stale snapshot values (or, for models the snapshot lacks, at $0).
		const byId = new Map(loadSnapshotRates().map((r) => [r.modelId.toLowerCase(), r]));
		for (const curated of CURATED_RATES) {
			expect(byId.get(curated.modelId.toLowerCase())).toEqual(curated);
		}
	});
});

describe('parseLlmPrices', () => {
	it('converts per-million costs to per-token and skips incomplete rows', () => {
		const rates = parseLlmPrices({
			updated_at: 'now',
			prices: [
				{ id: 'deepseek-v4-pro', input: 1.74, output: 3.48, input_cached: 0.145 },
				{ id: 'no-output', input: 1 },
				{ input: 1, output: 2 },
			] as LlmPricesFeed['prices'],
		});
		expect(rates).toEqual([
			{
				modelId: 'deepseek-v4-pro',
				inputPerToken: 1.74e-6,
				outputPerToken: 3.48e-6,
				cacheReadPerToken: 1.45e-7,
				cacheCreationPerToken: null,
			},
		]);
	});

	it('tolerates a missing or non-array prices field', () => {
		expect(parseLlmPrices({})).toEqual([]);
		expect(parseLlmPrices({ prices: undefined })).toEqual([]);
	});
});

describe('mergeRates', () => {
	it('lets primary win and backfills null fields from secondary', () => {
		const primary = [
			{
				modelId: 'claude-x',
				inputPerToken: 6e-6,
				outputPerToken: 30e-6,
				cacheReadPerToken: null,
				cacheCreationPerToken: null,
			},
		];
		const secondary = [
			{
				modelId: 'claude-x',
				inputPerToken: 5e-6,
				outputPerToken: 25e-6,
				cacheReadPerToken: 5e-7,
				cacheCreationPerToken: 6.25e-6,
			},
			{
				modelId: 'only-in-secondary',
				inputPerToken: 1e-6,
				outputPerToken: 2e-6,
				cacheReadPerToken: null,
				cacheCreationPerToken: null,
			},
		];
		const merged = mergeRates(primary, secondary);
		const byId = Object.fromEntries(merged.map((r) => [r.modelId, r]));
		// Primary input/output win; null cache fields fall back to secondary.
		expect(byId['claude-x']).toEqual({
			modelId: 'claude-x',
			inputPerToken: 6e-6,
			outputPerToken: 30e-6,
			cacheReadPerToken: 5e-7,
			cacheCreationPerToken: 6.25e-6,
		});
		// Secondary-only models are retained.
		expect(byId['only-in-secondary'].inputPerToken).toBe(1e-6);
	});
});
