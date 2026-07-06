/**
 * Coverage-focused tests for the pricepertoken.com MCP pricing source: the
 * catalog parser, model-id derivation, and the minimal streamable-HTTP client
 * (`fetchPricePerTokenPricing`) driven entirely by injected fetch stubs — no
 * network, no DB.
 */
import { describe, expect, it } from 'vitest';
import {
	deriveModelId,
	type FetchLike,
	fetchPricePerTokenPricing,
	PRICEPERTOKEN_MCP_URL,
	parsePricePerTokenModels,
} from '../src/services/pricing';
import { pptModel, stubPricePerTokenFetch } from './helpers/pricing';

/**
 * Fetch stub that answers the initialize/notifications handshake with plain
 * JSON and delegates the tools/call response to `onToolsCall` so tests can
 * shape edge-case bodies (SSE framing, isError, missing content).
 */
function handshakeFetch(
	onToolsCall: (id: unknown) => { contentType: string; text: string },
): FetchLike {
	return async (_url, init) => {
		const body = JSON.parse(init?.body ?? '{}') as Record<string, unknown>;
		let contentType = 'application/json';
		let text = '';
		if (body.method === 'initialize') {
			text = JSON.stringify({ jsonrpc: '2.0', id: body.id, result: {} });
		} else if (body.method === 'notifications/initialized') {
			text = '';
		} else {
			const r = onToolsCall(body.id);
			contentType = r.contentType;
			text = r.text;
		}
		return {
			ok: true,
			status: 200,
			headers: {
				get: (name: string) => (name.toLowerCase() === 'content-type' ? contentType : null),
			},
			text: async () => text,
		};
	};
}

describe('deriveModelId', () => {
	it('strips the slugified author prefix', () => {
		expect(deriveModelId('deepseek-deepseek-v4-pro', 'DeepSeek')).toBe('deepseek-v4-pro');
		expect(deriveModelId('anthropic-claude-sonnet-4', 'Anthropic')).toBe('claude-sonnet-4');
	});

	it('tries longest-first candidates: full slug, collapsed, first token', () => {
		// Full slugified author ("ai21-labs") wins over the first token.
		expect(deriveModelId('ai21-labs-jamba-1.5', 'AI21 Labs')).toBe('jamba-1.5');
		// Separator-collapsed author ("ai21labs").
		expect(deriveModelId('ai21labs-jamba-1.5', 'AI21 Labs')).toBe('jamba-1.5');
		// First token only ("ai21").
		expect(deriveModelId('ai21-jamba-1.5', 'AI21 Labs')).toBe('jamba-1.5');
	});

	it('joins leading slug segments for authors whose slug splits differently', () => {
		// "xAI" slugifies to "xai" but the catalog slug splits it as "x-ai-…".
		expect(deriveModelId('x-ai-grok-3', 'xAI')).toBe('grok-3');
		// Three-segment join.
		expect(deriveModelId('a-b-c-model-1', 'ABC')).toBe('model-1');
	});

	it('keeps the slug whole when no candidate matches', () => {
		expect(deriveModelId('gpt-4o', 'OpenAI')).toBe('gpt-4o');
	});

	it('keeps the slug whole for an empty or non-alphanumeric author', () => {
		expect(deriveModelId('some-model', '')).toBe('some-model');
		expect(deriveModelId('some-model', '!!!')).toBe('some-model');
	});

	it('does not strip when the slug is only the author prefix', () => {
		// slug.length must exceed candidate.length + 1 — "anthropic-" stays whole.
		expect(deriveModelId('anthropic-', 'Anthropic')).toBe('anthropic-');
	});
});

describe('parsePricePerTokenModels', () => {
	it('returns [] for non-array input', () => {
		expect(parsePricePerTokenModels(null)).toEqual([]);
		expect(parsePricePerTokenModels({ models: [] })).toEqual([]);
		expect(parsePricePerTokenModels('nope')).toEqual([]);
	});

	it('converts per-million prices to per-token and nulls cache rates', () => {
		const rates = parsePricePerTokenModels([
			pptModel('anthropic-claude-sonnet-4', 'Anthropic', 3, 15),
		]);
		expect(rates).toEqual([
			{
				modelId: 'claude-sonnet-4',
				inputPerToken: 3 / 1_000_000,
				outputPerToken: 15 / 1_000_000,
				cacheReadPerToken: null,
				cacheCreationPerToken: null,
			},
		]);
	});

	it('skips malformed entries: null, missing slug, non-numeric or missing prices', () => {
		const rates = parsePricePerTokenModels([
			null,
			'string-entry',
			pptModel('', 'Acme', 1, 2), // empty slug
			{ author_name: 'Acme', input_per_1m: 1, output_per_1m: 2 }, // no slug
			pptModel('acme-no-input', 'Acme', null, 2),
			pptModel('acme-no-output', 'Acme', 1, null),
			{ slug: 'acme-nan', author_name: 'Acme', input_per_1m: Number.NaN, output_per_1m: 2 },
			{
				slug: 'acme-infinite',
				author_name: 'Acme',
				input_per_1m: 1,
				output_per_1m: Number.POSITIVE_INFINITY,
			},
			{ slug: 'acme-string-price', author_name: 'Acme', input_per_1m: '1', output_per_1m: 2 },
			pptModel('acme-good', 'Acme', 1, 2),
		]);
		expect(rates.map((r) => r.modelId)).toEqual(['good']);
	});

	it('treats a non-string author as empty (slug kept whole)', () => {
		const rates = parsePricePerTokenModels([
			{ slug: 'oddity-model', author_name: 42, input_per_1m: 1, output_per_1m: 2 },
		]);
		expect(rates[0].modelId).toBe('oddity-model');
	});

	it('dedupes by derived id — the first entry wins', () => {
		// Two different slugs collapse to the same bare id ("model-x") once their
		// author prefixes are stripped; only the first survives.
		const rates = parsePricePerTokenModels([
			pptModel('acme-model-x', 'Acme', 1, 2),
			pptModel('acmelabs-model-x', 'AcmeLabs', 9, 9),
		]);
		const modelX = rates.filter((r) => r.modelId === 'model-x');
		expect(modelX).toHaveLength(1);
		expect(modelX[0].inputPerToken).toBe(1 / 1_000_000);
	});
});

describe('fetchPricePerTokenPricing', () => {
	const catalog = [
		pptModel('deepseek-deepseek-v4-pro', 'DeepSeek', 0.5, 2),
		pptModel('z-ai-glm-4.7', 'Z.ai', 0.6, 2.2),
		pptModel('unpriced-model', 'Ghost', null, null),
	];

	it('runs the handshake then tools/call and parses the catalog (JSON body)', async () => {
		const { fetchImpl, requests } = stubPricePerTokenFetch(catalog);
		const rates = await fetchPricePerTokenPricing(fetchImpl);

		expect(rates.map((r) => r.modelId).sort()).toEqual(['deepseek-v4-pro', 'glm-4.7']);
		const deepseek = rates.find((r) => r.modelId === 'deepseek-v4-pro');
		expect(deepseek?.inputPerToken).toBe(0.5 / 1_000_000);
		expect(deepseek?.outputPerToken).toBe(2 / 1_000_000);

		// Wire protocol: initialize → notifications/initialized → tools/call, all to the MCP URL.
		expect(requests.map((r) => r.body.method)).toEqual([
			'initialize',
			'notifications/initialized',
			'tools/call',
		]);
		expect(requests.every((r) => r.url === PRICEPERTOKEN_MCP_URL)).toBe(true);
		expect(requests.every((r) => r.method === 'POST')).toBe(true);
		expect(requests[0].headers?.['User-Agent']).toBe('hezo');
		expect(requests[0].headers?.Accept).toContain('text/event-stream');
		expect(requests[0].headers?.['Content-Type']).toBe('application/json');
		// No session issued — no session header echoed.
		expect(requests[2].headers?.['mcp-session-id']).toBeUndefined();
		// The whole catalog is requested, not the 100-row default.
		const call = requests[2].body.params as { name: string; arguments: { limit: number } };
		expect(call.name).toBe('get_all_models');
		expect(call.arguments.limit).toBe(10_000);
	});

	it('parses an SSE-framed tools/call response', async () => {
		const { fetchImpl } = stubPricePerTokenFetch(catalog, { sse: true });
		const rates = await fetchPricePerTokenPricing(fetchImpl);
		expect(rates.map((r) => r.modelId).sort()).toEqual(['deepseek-v4-pro', 'glm-4.7']);
	});

	it('scans past SSE comments and non-JSON data lines to the resolving message', async () => {
		const fetchImpl = handshakeFetch((id) => {
			const rpc = {
				jsonrpc: '2.0',
				id,
				result: { content: [{ type: 'text', text: JSON.stringify(catalog) }] },
			};
			return {
				contentType: 'text/event-stream',
				text: [
					': heartbeat comment',
					'data: this is not json',
					'data: {"jsonrpc":"2.0"}', // valid JSON but resolves nothing
					'event: message',
					`data: ${JSON.stringify(rpc)}`,
					'',
				].join('\n'),
			};
		});
		const rates = await fetchPricePerTokenPricing(fetchImpl);
		expect(rates).toHaveLength(2);
	});

	it('throws "no text content" when the SSE stream never resolves the call', async () => {
		const fetchImpl = handshakeFetch(() => ({
			contentType: 'text/event-stream',
			text: 'data: {"jsonrpc":"2.0"}\n\n',
		}));
		await expect(fetchPricePerTokenPricing(fetchImpl)).rejects.toThrow(/no text content/);
	});

	it('echoes a server-issued session id on subsequent requests', async () => {
		const { fetchImpl, requests } = stubPricePerTokenFetch(catalog, { sessionId: 'sess-42' });
		await fetchPricePerTokenPricing(fetchImpl);
		expect(requests[0].headers?.['mcp-session-id']).toBeUndefined();
		expect(requests[1].headers?.['mcp-session-id']).toBe('sess-42');
		expect(requests[2].headers?.['mcp-session-id']).toBe('sess-42');
	});

	it('throws on an HTTP-level failure', async () => {
		const { fetchImpl } = stubPricePerTokenFetch(catalog, { status: 503 });
		await expect(fetchPricePerTokenPricing(fetchImpl)).rejects.toThrow(/HTTP 503/);
	});

	it('throws on a JSON-RPC error response', async () => {
		const { fetchImpl } = stubPricePerTokenFetch(catalog, { rpcError: 'tool exploded' });
		await expect(fetchPricePerTokenPricing(fetchImpl)).rejects.toThrow(
			/pricepertoken MCP error: tool exploded/,
		);
	});

	it('throws when the result carries no text content', async () => {
		const fetchImpl = handshakeFetch((id) => ({
			contentType: 'application/json',
			text: JSON.stringify({
				jsonrpc: '2.0',
				id,
				result: { content: [{ type: 'image' }] },
			}),
		}));
		await expect(fetchPricePerTokenPricing(fetchImpl)).rejects.toThrow(/no text content/);
	});

	it('throws the tool error text when the result is flagged isError', async () => {
		const fetchImpl = handshakeFetch((id) => ({
			contentType: 'application/json',
			text: JSON.stringify({
				jsonrpc: '2.0',
				id,
				result: { content: [{ type: 'text', text: 'quota exceeded' }], isError: true },
			}),
		}));
		await expect(fetchPricePerTokenPricing(fetchImpl)).rejects.toThrow(
			/get_all_models failed: quota exceeded/,
		);
	});
});
