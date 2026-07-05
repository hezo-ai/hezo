import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../src/db/database';
import {
	deriveModelId,
	fetchPricePerTokenPricing,
	listModelPricing,
	PRICEPERTOKEN_MCP_URL,
	parsePricePerTokenModels,
	refreshPricingFromPricePerToken,
} from '../src/services/pricing';
import { createTestDbWithMigrations } from './helpers/db';
import { pptModel, stubPricePerTokenFetch } from './helpers/pricing';

describe('deriveModelId', () => {
	it('strips the author prefix in its common spellings', () => {
		expect(deriveModelId('deepseek-deepseek-v4-pro', 'Deepseek')).toBe('deepseek-v4-pro');
		expect(deriveModelId('anthropic-claude-opus-4.8', 'Anthropic')).toBe('claude-opus-4.8');
		// Full slugified author name ("Z-ai" → "z-ai") beats its first token ("z").
		expect(deriveModelId('z-ai-glm-4.7', 'Z-ai')).toBe('glm-4.7');
		expect(deriveModelId('moonshotai-kimi-k2.7-code', 'Moonshotai')).toBe('kimi-k2.7-code');
		// Multi-word author matched by its first token ("AI21 Labs" → "ai21").
		expect(deriveModelId('ai21-jamba-1.5-large', 'AI21 Labs')).toBe('jamba-1.5-large');
	});

	it('matches an author whose slug splits differently than the display name', () => {
		// "xAI" slugifies to "xai" but the slug segments as "x-ai-…".
		expect(deriveModelId('x-ai-grok-4', 'xAI')).toBe('grok-4');
	});

	it('keeps the whole slug when no author candidate matches', () => {
		// Hosted rebrands where the slug prefix is the host, not the author.
		expect(deriveModelId('together-cwm', 'Fireworks')).toBe('together-cwm');
		expect(deriveModelId('thudm-glm-4.1v-9b-thinking', 'Z-ai')).toBe('thudm-glm-4.1v-9b-thinking');
		expect(deriveModelId('solo', '')).toBe('solo');
	});
});

describe('parsePricePerTokenModels', () => {
	it('converts per-million prices to per-token with null cache rates', () => {
		const rates = parsePricePerTokenModels([
			pptModel('deepseek-deepseek-v4-pro', 'Deepseek', 0.435, 0.87),
		]);
		expect(rates).toEqual([
			{
				modelId: 'deepseek-v4-pro',
				inputPerToken: 0.435 / 1_000_000,
				outputPerToken: 0.87 / 1_000_000,
				cacheReadPerToken: null,
				cacheCreationPerToken: null,
			},
		]);
	});

	it('skips entries without both numeric prices or without a slug', () => {
		const rates = parsePricePerTokenModels([
			pptModel('openai-gpt-5', 'OpenAI', 0.625, 5),
			pptModel('openai-no-prices', 'OpenAI', null, null),
			pptModel('openai-half-priced', 'OpenAI', 1, null),
			{ author_name: 'OpenAI', input_per_1m: 1, output_per_1m: 2 },
		]);
		expect(rates.map((r) => r.modelId)).toEqual(['gpt-5']);
	});

	it('dedupes slugs that derive to the same model id (first wins)', () => {
		const rates = parsePricePerTokenModels([
			pptModel('openai-gpt-5', 'OpenAI', 0.625, 5),
			pptModel('gpt-5', '', 99, 99),
		]);
		expect(rates).toHaveLength(1);
		expect(rates[0].inputPerToken).toBe(0.625 / 1_000_000);
	});

	it('returns no rows for a non-array payload', () => {
		expect(parsePricePerTokenModels({ nope: true })).toEqual([]);
		expect(parsePricePerTokenModels(undefined)).toEqual([]);
	});
});

describe('fetchPricePerTokenPricing', () => {
	it('runs the MCP handshake and calls get_all_models with the full-catalog limit', async () => {
		const { fetchImpl, requests } = stubPricePerTokenFetch([
			pptModel('anthropic-claude-opus-4.8', 'Anthropic', 5, 25),
		]);
		const rates = await fetchPricePerTokenPricing(fetchImpl);
		expect(rates).toEqual([
			{
				modelId: 'claude-opus-4.8',
				inputPerToken: 5e-6,
				outputPerToken: 2.5e-5,
				cacheReadPerToken: null,
				cacheCreationPerToken: null,
			},
		]);

		expect(requests.map((r) => r.body.method)).toEqual([
			'initialize',
			'notifications/initialized',
			'tools/call',
		]);
		for (const r of requests) {
			expect(r.url).toBe(PRICEPERTOKEN_MCP_URL);
			expect(r.method).toBe('POST');
			// The server 403s default CLI agents, so every request must identify.
			expect(r.headers?.['User-Agent']).toBe('hezo');
			expect(r.headers?.Accept).toContain('text/event-stream');
		}
		const call = requests[2].body as { params?: { name?: string; arguments?: { limit?: number } } };
		expect(call.params?.name).toBe('get_all_models');
		// The tool defaults to 100 rows — the limit override is load-bearing.
		expect(call.params?.arguments?.limit).toBe(10_000);
	});

	it('parses an SSE-framed response body', async () => {
		const { fetchImpl } = stubPricePerTokenFetch([pptModel('openai-gpt-5', 'OpenAI', 0.625, 5)], {
			sse: true,
		});
		const rates = await fetchPricePerTokenPricing(fetchImpl);
		expect(rates.map((r) => r.modelId)).toEqual(['gpt-5']);
	});

	it('echoes a server-issued mcp-session-id on subsequent requests', async () => {
		const { fetchImpl, requests } = stubPricePerTokenFetch(
			[pptModel('openai-gpt-5', 'OpenAI', 0.625, 5)],
			{ sessionId: 'sess-123' },
		);
		await fetchPricePerTokenPricing(fetchImpl);
		// First request can't know the id; the follow-ups must carry it.
		expect(requests[0].headers?.['mcp-session-id']).toBeUndefined();
		expect(requests[1].headers?.['mcp-session-id']).toBe('sess-123');
		expect(requests[2].headers?.['mcp-session-id']).toBe('sess-123');
	});

	it('throws on a non-2xx response', async () => {
		const { fetchImpl } = stubPricePerTokenFetch([], { status: 503 });
		await expect(fetchPricePerTokenPricing(fetchImpl)).rejects.toThrow(/HTTP 503/);
	});

	it('throws on a JSON-RPC error', async () => {
		const { fetchImpl } = stubPricePerTokenFetch([], { rpcError: 'tool exploded' });
		await expect(fetchPricePerTokenPricing(fetchImpl)).rejects.toThrow(/tool exploded/);
	});
});

describe('refreshPricingFromPricePerToken', () => {
	let db: Db;

	beforeEach(async () => {
		db = await createTestDbWithMigrations();
	});

	afterEach(async () => {
		await db.close();
	});

	it("upserts catalog rows as source='pricepertoken' and updates on re-refresh", async () => {
		const first = stubPricePerTokenFetch([pptModel('acme-new-model', 'Acme', 1, 2)]);
		expect(await refreshPricingFromPricePerToken(db, first.fetchImpl)).toBe(1);
		const rows = await listModelPricing(db);
		const inserted = rows.find((r) => r.model_id === 'new-model');
		expect(inserted?.source).toBe('pricepertoken');
		expect(inserted?.input_per_token).toBe(1e-6);

		// A second refresh with a new price updates the same row in place.
		const second = stubPricePerTokenFetch([pptModel('acme-new-model', 'Acme', 3, 2)]);
		await refreshPricingFromPricePerToken(db, second.fetchImpl);
		const after = (await listModelPricing(db)).filter((r) => r.model_id === 'new-model');
		expect(after).toHaveLength(1);
		expect(after[0].input_per_token).toBe(3e-6);
	});
});
