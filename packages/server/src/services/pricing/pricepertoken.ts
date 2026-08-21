/**
 * Model pricing source: the pricepertoken.com MCP server.
 *
 * pricepertoken.com tracks current per-token prices across providers and
 * exposes them through a public, stateless MCP server (streamable HTTP).
 * Hezo calls its `get_all_models` tool with raw JSON-RPC over POST — no MCP
 * SDK — and normalizes the result to per-token `ParsedRate` rows.
 *
 * The catalog quotes prices per **million** tokens and carries **no cache
 * rates**. Rather than leave them null - which bills cache traffic at the full
 * input rate, ~10x over on the cache-read bucket that dominates agent runs -
 * they are derived from the feed's own input rate per provider
 * ({@link CACHE_RATE_MULTIPLIERS}). A `manual` override still wins for exact
 * per-model billing.
 */

/** The pricepertoken.com MCP endpoint (streamable HTTP, JSON-RPC POST). */
export const PRICEPERTOKEN_MCP_URL = 'https://api.pricepertoken.com/mcp/mcp';

/** `get_all_models` defaults to 100 rows; ask for the whole catalog. */
const GET_ALL_MODELS_LIMIT = 10_000;

/** The catalog quotes costs per this many tokens; we store per-token. */
const TOKENS_PER_MILLION = 1_000_000;

/**
 * Cache rates the catalog does not carry, as multiples of the base input rate,
 * keyed by the catalog's `author_name` (case-insensitive).
 *
 * Anthropic prices cache reads at 0.1x input and cache writes at 1.25x for the
 * default 5-minute TTL (2x for the 1-hour TTL, which no runtime Hezo drives
 * opts into - 1.25x is both the common case and the lower of the two).
 *
 * **Derived rather than baked** so the cache rates stay correct when the feed
 * moves a base price, and so a model released after this ships is covered
 * without a code change - the failure mode a snapshot of absolute figures has.
 *
 * A provider absent here keeps null rates and bills cache traffic at the full
 * input rate, exactly as before. Add a row only once that provider's
 * multipliers are verified: a guessed multiplier is worse than the honest
 * fallback, because it is wrong in a direction nobody checks.
 */
const CACHE_RATE_MULTIPLIERS: Record<string, { read: number; creation: number }> = {
	anthropic: { read: 0.1, creation: 1.25 },
};

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
	init?: {
		method?: string;
		headers?: Record<string, string>;
		body?: string;
		signal?: AbortSignal;
	},
) => Promise<{
	ok: boolean;
	status: number;
	headers: { get(name: string): string | null };
	text: () => Promise<string>;
}>;

/** One entry in the `get_all_models` catalog (only the fields we price on). */
export interface PricePerTokenModel {
	slug?: unknown;
	author_name?: unknown;
	input_per_1m?: unknown;
	output_per_1m?: unknown;
}

interface JsonRpcMessage {
	jsonrpc?: string;
	id?: number | string | null;
	result?: unknown;
	error?: { code?: number; message?: string };
}

/**
 * Extract the JSON-RPC response from a streamable-HTTP body. The server
 * answers `application/json` today, but the spec also allows an SSE-framed
 * response where each event's `data:` line carries one JSON-RPC message —
 * scan for the message that resolves the call (a `result` or `error`).
 */
function parseRpcBody(contentType: string | null, body: string): JsonRpcMessage | undefined {
	if (contentType?.includes('text/event-stream')) {
		for (const line of body.split('\n')) {
			if (!line.startsWith('data:')) continue;
			try {
				const msg = JSON.parse(line.slice(5).trim()) as JsonRpcMessage;
				if (msg.result !== undefined || msg.error !== undefined) return msg;
			} catch {
				// Not a JSON payload line (comment/heartbeat) — keep scanning.
			}
		}
		return undefined;
	}
	if (!body.trim()) return undefined;
	return JSON.parse(body) as JsonRpcMessage;
}

/**
 * Minimal streamable-HTTP MCP client: one POST per JSON-RPC message. The
 * server is stateless today (never issues a session id), but if one ever
 * appears in a response it is echoed on subsequent requests per the spec.
 */
class McpHttpClient {
	private sessionId: string | null = null;

	constructor(
		private readonly fetchImpl: FetchLike,
		private readonly url: string,
	) {}

	async send(payload: Record<string, unknown>): Promise<JsonRpcMessage | undefined> {
		const headers: Record<string, string> = {
			'Content-Type': 'application/json',
			Accept: 'application/json, text/event-stream',
			// The server 403s default CLI agents; any product token works.
			'User-Agent': 'hezo',
		};
		if (this.sessionId) headers['mcp-session-id'] = this.sessionId;
		const res = await this.fetchImpl(this.url, {
			method: 'POST',
			headers,
			body: JSON.stringify(payload),
		});
		if (!res.ok) {
			throw new Error(`pricepertoken MCP request failed: HTTP ${res.status}`);
		}
		this.sessionId = res.headers.get('mcp-session-id') ?? this.sessionId;
		const msg = parseRpcBody(res.headers.get('content-type'), await res.text());
		if (msg?.error) {
			throw new Error(`pricepertoken MCP error: ${msg.error.message ?? 'unknown error'}`);
		}
		return msg;
	}
}

/** Lowercase and dash-join an author name ("AI21 Labs" → "ai21-labs"). */
function slugifyAuthor(name: string): string {
	return name
		.toLowerCase()
		.trim()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '');
}

/**
 * Derive the bare model id from a catalog slug. Slugs are author-prefixed
 * (`deepseek-deepseek-v4-pro`, `z-ai-glm-4.7`) while runtimes report the bare
 * id, so strip the author prefix. Candidates from the author name — slugified
 * (`ai21-labs`), separator-collapsed (`ai21labs`), first token (`ai21`) —
 * longest match first; then a segment-join pass for names whose slug splits
 * differently than the display name (`x-ai-…` ↔ "xAI"). A slug that matches
 * no candidate is kept whole — a never-queried id is harmless.
 */
export function deriveModelId(slug: string, authorName: string): string {
	const author = slugifyAuthor(authorName);
	if (!author) return slug;
	const candidates = [...new Set([author, author.replaceAll('-', ''), author.split('-')[0]])].sort(
		(a, b) => b.length - a.length,
	);
	for (const candidate of candidates) {
		if (slug.startsWith(`${candidate}-`) && slug.length > candidate.length + 1) {
			return slug.slice(candidate.length + 1);
		}
	}
	const collapsed = author.replaceAll('-', '');
	const segments = slug.split('-');
	for (let k = 2; k <= 3 && k < segments.length; k++) {
		if (segments.slice(0, k).join('') === collapsed) {
			return segments.slice(k).join('-');
		}
	}
	return slug;
}

/**
 * Map the raw `get_all_models` array to rate rows: per-million → per-token,
 * author prefix stripped from the slug. Skips entries without both numeric
 * prices (the catalog lists some models it has no rates for). Cache rates are
 * derived from the input rate where the author has known multipliers and null
 * otherwise. Dedupes by derived id (first entry wins) so two slugs collapsing
 * to one id can't break the bulk upsert.
 */
export function parsePricePerTokenModels(raw: unknown): ParsedRate[] {
	if (!Array.isArray(raw)) return [];
	const byId = new Map<string, ParsedRate>();
	for (const entry of raw as PricePerTokenModel[]) {
		if (!entry || typeof entry !== 'object') continue;
		const { slug, author_name, input_per_1m, output_per_1m } = entry;
		if (typeof slug !== 'string' || slug === '') continue;
		if (typeof input_per_1m !== 'number' || !Number.isFinite(input_per_1m)) continue;
		if (typeof output_per_1m !== 'number' || !Number.isFinite(output_per_1m)) continue;
		const author = typeof author_name === 'string' ? author_name : '';
		const modelId = deriveModelId(slug, author);
		if (byId.has(modelId)) continue;
		const inputPerToken = input_per_1m / TOKENS_PER_MILLION;
		const cache = CACHE_RATE_MULTIPLIERS[author.toLowerCase()];
		byId.set(modelId, {
			modelId,
			inputPerToken,
			outputPerToken: output_per_1m / TOKENS_PER_MILLION,
			cacheReadPerToken: cache ? inputPerToken * cache.read : null,
			cacheCreationPerToken: cache ? inputPerToken * cache.creation : null,
		});
	}
	return [...byId.values()];
}

/**
 * Fetch the full catalog from the live MCP server. Runs the polite handshake
 * (`initialize` → `notifications/initialized`) before `tools/call`, though
 * the stateless server also accepts a bare call. Throws on HTTP or JSON-RPC
 * failure — callers decide whether that's fatal (route) or retried (cron).
 */
export async function fetchPricePerTokenPricing(
	fetchImpl: FetchLike = globalThis.fetch as unknown as FetchLike,
): Promise<ParsedRate[]> {
	const client = new McpHttpClient(fetchImpl, PRICEPERTOKEN_MCP_URL);
	await client.send({
		jsonrpc: '2.0',
		id: 0,
		method: 'initialize',
		params: {
			protocolVersion: '2025-03-26',
			capabilities: {},
			clientInfo: { name: 'hezo', version: '1.0' },
		},
	});
	await client.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
	const msg = await client.send({
		jsonrpc: '2.0',
		id: 1,
		method: 'tools/call',
		params: { name: 'get_all_models', arguments: { limit: GET_ALL_MODELS_LIMIT } },
	});
	const result = msg?.result as
		| { content?: Array<{ type?: string; text?: string }>; isError?: boolean }
		| undefined;
	const text = result?.content?.find((c) => typeof c.text === 'string')?.text;
	if (!text) {
		throw new Error('pricepertoken MCP: get_all_models returned no text content');
	}
	if (result?.isError) {
		throw new Error(`pricepertoken MCP: get_all_models failed: ${text}`);
	}
	return parsePricePerTokenModels(JSON.parse(text));
}
