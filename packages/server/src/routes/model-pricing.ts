/**
 * Runtime model pricing admin. Anyone authenticated can read the table; writes
 * (manual overrides + feed refresh) are superuser-only. Manual rows win over
 * feed rows at cost-computation time (see `services/pricing`).
 */
import { Hono } from 'hono';
import { err, ok } from '../lib/response';
import type { Env } from '../lib/types';
import { requireAdminEquivalent } from '../middleware/auth';
import {
	deleteManualRate,
	listModelPricing,
	type ManualRateInput,
	refreshPricingFromPricePerToken,
	upsertManualRate,
} from '../services/pricing';

export const modelPricingRoutes = new Hono<Env>();

/** Optional, finite, non-negative per-token rate; `undefined`/`null` → null. */
function parseOptionalRate(value: unknown): number | null | undefined {
	if (value === undefined || value === null) return null;
	if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return undefined;
	return value;
}

/** Required, finite, non-negative per-token rate. */
function parseRequiredRate(value: unknown): number | undefined {
	if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return undefined;
	return value;
}

modelPricingRoutes.get('/model-pricing', async (c) => {
	const db = c.get('db');
	const rows = await listModelPricing(db);
	return ok(c, rows);
});

modelPricingRoutes.post('/model-pricing', async (c) => {
	const denied = requireAdminEquivalent(c);
	if (denied) return denied;

	const db = c.get('db');
	const body = await c.req
		.json<Record<string, unknown>>()
		.catch(() => ({}) as Record<string, unknown>);

	const modelId = typeof body.model_id === 'string' ? body.model_id.trim() : '';
	if (!modelId) {
		return err(c, 'INVALID_REQUEST', 'model_id is required', 400);
	}
	const input = parseRequiredRate(body.input_per_token);
	const output = parseRequiredRate(body.output_per_token);
	if (input === undefined || output === undefined) {
		return err(
			c,
			'INVALID_REQUEST',
			'input_per_token and output_per_token must be non-negative numbers',
			400,
		);
	}
	const cacheRead = parseOptionalRate(body.cache_read_per_token);
	const cacheCreation = parseOptionalRate(body.cache_creation_per_token);
	if (cacheRead === undefined || cacheCreation === undefined) {
		return err(
			c,
			'INVALID_REQUEST',
			'cache_read_per_token and cache_creation_per_token must be non-negative numbers or null',
			400,
		);
	}

	const payload: ManualRateInput = {
		model_id: modelId,
		input_per_token: input,
		output_per_token: output,
		cache_read_per_token: cacheRead,
		cache_creation_per_token: cacheCreation,
	};
	const row = await upsertManualRate(db, payload);
	await c.get('pricing')?.reload();
	return ok(c, row, 201);
});

modelPricingRoutes.delete('/model-pricing/:id', async (c) => {
	const denied = requireAdminEquivalent(c);
	if (denied) return denied;

	const db = c.get('db');
	const deleted = await deleteManualRate(db, c.req.param('id'));
	if (!deleted) {
		return err(c, 'NOT_FOUND', 'No manual pricing override with that id', 404);
	}
	await c.get('pricing')?.reload();
	return ok(c, { deleted: true });
});

modelPricingRoutes.post('/model-pricing/refresh', async (c) => {
	const denied = requireAdminEquivalent(c);
	if (denied) return denied;

	const db = c.get('db');
	const pricing = c.get('pricing');
	try {
		const count = pricing ? await pricing.refresh() : await refreshPricingFromPricePerToken(db);
		return ok(c, { refreshed: count });
	} catch (e) {
		return err(c, 'UPSTREAM_ERROR', `Pricing refresh failed: ${(e as Error).message}`, 503);
	}
});
