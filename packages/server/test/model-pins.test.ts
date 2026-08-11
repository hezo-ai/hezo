/**
 * The pin's behaviour against a real database and a stubbed provider catalog.
 *
 * The rule itself (which model wins) is covered in `@hezo/shared`; what matters
 * here is the part that touches an operator's instance - a NEW credential picks
 * up the pin, and an EXISTING one is never moved.
 */

import { AiProvider } from '@hezo/shared';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { setSystemMeta } from '../src/lib/system-meta';
import { getPinnedModel, refreshModelPins } from '../src/services/model-pins';
import { authHeader } from './helpers/app';
import { createTestContext, destroyTestContext, type ServerTestContext } from './helpers/context';

let ctx: ServerTestContext;
const originalFetch = globalThis.fetch;

/** Answer the catalog endpoint with an OpenAI-shaped listing. */
function stubCatalog(ids: string[]): void {
	globalThis.fetch = vi.fn().mockResolvedValue({
		ok: true,
		status: 200,
		json: async () => ({ data: ids.map((id) => ({ id })) }),
	}) as unknown as typeof fetch;
}

beforeEach(async () => {
	if (ctx) await destroyTestContext(ctx);
	ctx = await createTestContext();
	globalThis.fetch = originalFetch;
});

afterAll(async () => {
	globalThis.fetch = originalFetch;
	if (ctx) await destroyTestContext(ctx);
});

async function addProvider(provider: string, apiKey: string): Promise<string> {
	const res = await ctx.app.request('/api/ai-providers', {
		method: 'POST',
		headers: { ...authHeader(ctx.token), 'Content-Type': 'application/json' },
		body: JSON.stringify({ provider, api_key: apiKey, label: `${provider}-pin-test` }),
	});
	expect(res.status).toBe(201);
	return ((await res.json()) as { data: { id: string } }).data.id;
}

async function modelOf(configId: string): Promise<string | null> {
	const r = await ctx.db.query<{ default_model: string | null }>(
		'SELECT default_model FROM ai_provider_configs WHERE id = $1',
		[configId],
	);
	return r.rows[0]?.default_model ?? null;
}

describe('getPinnedModel', () => {
	it('falls back to the compile-time pin before any refresh has run', async () => {
		expect(await getPinnedModel(ctx.db, AiProvider.Anthropic)).toBe('claude-opus-5');
	});

	it('prefers a refreshed pin over the compile-time one', async () => {
		await setSystemMeta(ctx.db, `model_pin:${AiProvider.Anthropic}`, 'claude-opus-6');
		expect(await getPinnedModel(ctx.db, AiProvider.Anthropic)).toBe('claude-opus-6');
	});

	it('has no pin for a local runner, whose catalog is the operator’s own', async () => {
		expect(await getPinnedModel(ctx.db, AiProvider.Ollama)).toBeNull();
	});
});

describe('a new provider credential', () => {
	it('starts on the pinned model rather than on none', async () => {
		await setSystemMeta(ctx.db, `model_pin:${AiProvider.Anthropic}`, 'claude-opus-6');
		globalThis.fetch = vi.fn().mockResolvedValue({ ok: true }) as unknown as typeof fetch;
		const id = await addProvider('anthropic', 'sk-ant-pin-new');
		globalThis.fetch = originalFetch;
		expect(await modelOf(id)).toBe('claude-opus-6');
	});
});

describe('refreshModelPins', () => {
	it('moves the pin to the newest model the provider now serves', async () => {
		globalThis.fetch = vi.fn().mockResolvedValue({ ok: true }) as unknown as typeof fetch;
		await addProvider('anthropic', 'sk-ant-pin-refresh');
		stubCatalog(['claude-sonnet-4-6', 'claude-opus-6', 'claude-opus-5']);

		const result = await refreshModelPins(ctx.db, ctx.masterKeyManager);
		globalThis.fetch = originalFetch;

		expect(result.changed.join()).toContain('claude-opus-6');
		expect(await getPinnedModel(ctx.db, AiProvider.Anthropic)).toBe('claude-opus-6');
	});

	// The rule the whole design rests on. A refresh that moved a configured
	// credential would silently change which model every agent on it runs, which
	// is an instance-wide behaviour change nobody asked for.
	it('never moves a credential that is already configured', async () => {
		globalThis.fetch = vi.fn().mockResolvedValue({ ok: true }) as unknown as typeof fetch;
		const id = await addProvider('anthropic', 'sk-ant-pin-existing');
		globalThis.fetch = originalFetch;
		const chosen = await modelOf(id);

		stubCatalog(['claude-opus-9']);
		await refreshModelPins(ctx.db, ctx.masterKeyManager);
		globalThis.fetch = originalFetch;

		// The pin moved; the operator's config did not.
		expect(await getPinnedModel(ctx.db, AiProvider.Anthropic)).toBe('claude-opus-9');
		expect(await modelOf(id)).toBe(chosen);
	});

	it('holds the previous pin when the catalog offers nothing in the family', async () => {
		globalThis.fetch = vi.fn().mockResolvedValue({ ok: true }) as unknown as typeof fetch;
		await addProvider('anthropic', 'sk-ant-pin-nomatch');
		globalThis.fetch = originalFetch;
		await setSystemMeta(ctx.db, `model_pin:${AiProvider.Anthropic}`, 'claude-opus-6');

		stubCatalog(['some-unrelated-model']);
		const result = await refreshModelPins(ctx.db, ctx.masterKeyManager);
		globalThis.fetch = originalFetch;

		expect(result.skipped.join()).toContain('no model matched');
		expect(await getPinnedModel(ctx.db, AiProvider.Anthropic)).toBe('claude-opus-6');
	});

	it('holds the previous pin when the provider cannot be reached', async () => {
		globalThis.fetch = vi.fn().mockResolvedValue({ ok: true }) as unknown as typeof fetch;
		await addProvider('anthropic', 'sk-ant-pin-down');
		await setSystemMeta(ctx.db, `model_pin:${AiProvider.Anthropic}`, 'claude-opus-6');

		globalThis.fetch = vi
			.fn()
			.mockRejectedValue(new Error('ECONNREFUSED')) as unknown as typeof fetch;
		const result = await refreshModelPins(ctx.db, ctx.masterKeyManager);
		globalThis.fetch = originalFetch;

		expect(result.skipped.join()).toContain('unreachable');
		expect(await getPinnedModel(ctx.db, AiProvider.Anthropic)).toBe('claude-opus-6');
	});

	it('reads no catalog at all when no provider is configured', async () => {
		const spy = vi.fn();
		globalThis.fetch = spy as unknown as typeof fetch;
		const result = await refreshModelPins(ctx.db, ctx.masterKeyManager);
		globalThis.fetch = originalFetch;
		expect(result.changed).toEqual([]);
		expect(spy).not.toHaveBeenCalled();
	});
});
