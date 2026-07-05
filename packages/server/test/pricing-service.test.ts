import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../src/db/database';
import {
	countModelPricing,
	normalizeModelId,
	PricingService,
	upsertManualRate,
} from '../src/services/pricing';
import { createTestDbWithMigrations } from './helpers/db';
import { pptModel, stubPricePerTokenFetch } from './helpers/pricing';

let db: Db;

beforeEach(async () => {
	db = await createTestDbWithMigrations();
});

afterEach(async () => {
	await db.close();
});

const M = 1_000_000;

describe('normalizeModelId', () => {
	it('strips provider prefix, 1m tag, and release date', () => {
		expect(normalizeModelId('openai/gpt-5')).toBe('gpt-5');
		expect(normalizeModelId('claude-opus-4-8-20260205')).toBe('claude-opus-4-8');
		expect(normalizeModelId('gpt-5-2025-08-07')).toBe('gpt-5');
		expect(normalizeModelId('deepseek-v4-pro[1m]')).toBe('deepseek-v4-pro');
	});

	it('strips any bracketed context-window tag, not just [1m]', () => {
		expect(normalizeModelId('deepseek-v4-pro[2m]')).toBe('deepseek-v4-pro');
		expect(normalizeModelId('anthropic/claude-opus-4-8[1m]')).toBe('claude-opus-4-8');
	});

	it('unifies version dots to dashes so catalog and runtime spellings meet', () => {
		// The catalog says claude-opus-4.8; Claude Code reports claude-opus-4-8.
		expect(normalizeModelId('claude-opus-4.8')).toBe('claude-opus-4-8');
		expect(normalizeModelId('claude-opus-4-8')).toBe('claude-opus-4-8');
		expect(normalizeModelId('zai/glm-4.7')).toBe('glm-4-7');
		expect(normalizeModelId('glm-4.7[200k]')).toBe('glm-4-7');
	});
});

describe('PricingService', () => {
	it('loads the migration-baked catalog — no fetch needed to price a run', async () => {
		// The 014 migration bakes the pricepertoken catalog in, so a fresh
		// instance prices runs before (or without) any successful refresh.
		expect(await countModelPricing(db)).toBeGreaterThan(400);
		const svc = new PricingService(db);
		await svc.init();
		// claude-opus-4.8 is baked at $5/Mtok input: 1M regular input → 500c.
		expect(svc.costCents('claude-opus-4-8', { inputTokens: M, outputTokens: 0 })).toBe(500);
	});

	it('resolves dotted, prefixed, and dated model ids to the same rate', async () => {
		const svc = new PricingService(db);
		await svc.init();
		const exact = svc.costCents('claude-opus-4-8', { inputTokens: M, outputTokens: 0 });
		expect(exact).toBe(500);
		// The catalog keys the dotted spelling; every runtime variant resolves to it.
		expect(svc.costCents('claude-opus-4.8', { inputTokens: M, outputTokens: 0 })).toBe(exact);
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
			stubPricePerTokenFetch([pptModel('deepseek-deepseek-r2-pro-0606', 'Deepseek', 1, 2)])
				.fetchImpl,
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
		// `gpt-5-codex-preview` isn't in the catalog but `gpt-5-codex` is; the
		// variant borrows the longest whole-segment base rate rather than falling
		// through to $0 (or to the shorter `gpt-5` match).
		const base = svc.costCents('gpt-5-codex', { inputTokens: M, outputTokens: 0 });
		expect(base).toBeGreaterThan(0);
		expect(svc.costCents('gpt-5-codex-preview[1m]', { inputTokens: M, outputTokens: 0 })).toBe(
			base,
		);
	});

	it('does not cross-match a model sharing only a vendor prefix', async () => {
		const svc = new PricingService(db);
		await svc.init();
		// `deepseek-r2-pro` shares only the `deepseek` vendor token with the baked
		// deepseek rows — not a whole-segment prefix — so it must stay unpriced
		// rather than borrow an unrelated rate.
		expect(svc.costCents('deepseek-r2-pro[1m]', { inputTokens: M, outputTokens: 0 })).toBe(0);
		// A sibling version is likewise not a match for a different sibling.
		expect(svc.costCents('claude-sonnet-9', { inputTokens: M, outputTokens: 0 })).toBe(0);
	});

	it('lets a manual override win over the catalog row', async () => {
		const svc = new PricingService(db);
		await svc.init();
		const baked = svc.costCents('claude-opus-4-8', { inputTokens: M, outputTokens: 0 });
		await upsertManualRate(db, {
			model_id: 'claude-opus-4-8',
			input_per_token: 0.001,
			output_per_token: 0.001,
		});
		await svc.reload();
		// 1M input @ $0.001/token = $1000 → 100000c, distinct from the baked rate.
		expect(svc.costCents('claude-opus-4-8', { inputTokens: M, outputTokens: 0 })).toBe(100_000);
		expect(svc.costCents('claude-opus-4-8', { inputTokens: M, outputTokens: 0 })).not.toBe(baked);
	});

	it('refreshes from the catalog and preserves manual overrides', async () => {
		const svc = new PricingService(db);
		await svc.init();
		await upsertManualRate(db, {
			model_id: 'claude-opus-4.8',
			input_per_token: 0.001,
			output_per_token: 0.001,
		});
		await svc.reload();

		const count = await svc.refresh(
			stubPricePerTokenFetch([
				pptModel('acme-new-model-x', 'Acme', 10, 20),
				// The feed also lists claude-opus-4.8, but the manual override must win.
				pptModel('anthropic-claude-opus-4.8', 'Anthropic', 5, 25),
			]).fetchImpl,
		);
		expect(count).toBe(2);
		// New feed model is now priced: 1M input @ $10/Mtok = $10 → 1000c.
		expect(svc.costCents('new-model-x', { inputTokens: M, outputTokens: 0 })).toBe(1000);
		// Manual override survives the refresh.
		expect(svc.costCents('claude-opus-4-8', { inputTokens: M, outputTokens: 0 })).toBe(100_000);
	});

	it('bills cache reads at the full input rate — the conservative upper bound', async () => {
		const svc = new PricingService(db);
		await svc.init();
		// The catalog carries no cache rates, so 1M cache reads cost the same as
		// 1M regular input ($5.00 → 500c for claude-opus-4.8), not a discounted
		// rate. Deliberate: recorded cost is an upper bound, never an undercount.
		expect(
			svc.costCents('claude-opus-4-8', { inputTokens: 0, cacheReadTokens: M, outputTokens: 0 }),
		).toBe(500);
	});

	it('a manual override with cache rates restores exact cache billing', async () => {
		const svc = new PricingService(db);
		await svc.init();
		await upsertManualRate(db, {
			model_id: 'claude-opus-4.8',
			input_per_token: 5e-6,
			output_per_token: 2.5e-5,
			cache_read_per_token: 5e-7,
		});
		await svc.reload();
		// 1M cache reads @ $0.5/Mtok → 50c once the override supplies the rate.
		expect(
			svc.costCents('claude-opus-4-8', { inputTokens: 0, cacheReadTokens: M, outputTokens: 0 }),
		).toBe(50);
	});
});
