import type { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FetchLike } from '../src/services/pricing';
import {
	countModelPricing,
	normalizeModelId,
	PricingService,
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

const M = 1_000_000;

describe('normalizeModelId', () => {
	it('strips provider prefix, 1m tag, and release date', () => {
		expect(normalizeModelId('openai/gpt-5')).toBe('gpt-5');
		expect(normalizeModelId('claude-opus-4-8-20260205')).toBe('claude-opus-4-8');
		expect(normalizeModelId('gpt-5-2025-08-07')).toBe('gpt-5');
		expect(normalizeModelId('deepseek-v4-pro[1m]')).toBe('deepseek-v4-pro');
		expect(normalizeModelId('zai/glm-4.7')).toBe('glm-4.7');
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
		expect(count).toBe(2);
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
});
