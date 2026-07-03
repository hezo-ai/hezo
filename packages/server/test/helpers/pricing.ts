/**
 * Stub `FetchLike` for the pricepertoken MCP client: answers the
 * `initialize` → `notifications/initialized` → `tools/call` sequence, serving
 * `models` as the `get_all_models` payload. Records every request so tests
 * can assert on the wire protocol (headers, arguments, ordering).
 */
import type { FetchLike } from '../../src/services/pricing';

export interface RecordedMcpRequest {
	url: string;
	method?: string;
	headers?: Record<string, string>;
	body: Record<string, unknown>;
}

export interface McpStubOptions {
	/** Serve the tools/call response as an SSE-framed body. */
	sse?: boolean;
	/** Issue this session id on every response's `mcp-session-id` header. */
	sessionId?: string;
	/** HTTP status for every response (default 200). */
	status?: number;
	/** Respond to tools/call with a JSON-RPC error instead of a result. */
	rpcError?: string;
}

export function stubPricePerTokenFetch(
	models: unknown,
	opts: McpStubOptions = {},
): { fetchImpl: FetchLike; requests: RecordedMcpRequest[] } {
	const requests: RecordedMcpRequest[] = [];
	const status = opts.status ?? 200;
	const respond = (
		payload: unknown,
		contentType = 'application/json',
	): Awaited<ReturnType<FetchLike>> => {
		const headerMap: Record<string, string> = { 'content-type': contentType };
		if (opts.sessionId) headerMap['mcp-session-id'] = opts.sessionId;
		return {
			ok: status < 300,
			status,
			headers: { get: (name: string) => headerMap[name.toLowerCase()] ?? null },
			text: async () => (typeof payload === 'string' ? payload : JSON.stringify(payload)),
		};
	};
	const fetchImpl: FetchLike = async (url, init) => {
		const body = init?.body ? (JSON.parse(init.body) as Record<string, unknown>) : {};
		requests.push({ url, method: init?.method, headers: init?.headers, body });
		if (status >= 300) return respond('');
		if (body.method === 'initialize') {
			return respond({
				jsonrpc: '2.0',
				id: body.id,
				result: {
					protocolVersion: '2025-03-26',
					capabilities: {},
					serverInfo: { name: 'stub', version: '0' },
				},
			});
		}
		if (body.method === 'notifications/initialized') {
			return respond('');
		}
		if (opts.rpcError) {
			return respond({
				jsonrpc: '2.0',
				id: body.id,
				error: { code: -32000, message: opts.rpcError },
			});
		}
		const rpc = {
			jsonrpc: '2.0',
			id: body.id,
			result: { content: [{ type: 'text', text: JSON.stringify(models) }] },
		};
		if (opts.sse) {
			return respond(`event: message\ndata: ${JSON.stringify(rpc)}\n\n`, 'text/event-stream');
		}
		return respond(rpc);
	};
	return { fetchImpl, requests };
}

/** Catalog-entry factory with the real feed's shape. */
export function pptModel(
	slug: string,
	authorName: string,
	inputPer1m: number | null,
	outputPer1m: number | null,
): Record<string, unknown> {
	return {
		slug,
		author_name: authorName,
		model_name: slug,
		context_length: null,
		supports_vision: null,
		supports_reasoning: null,
		supports_tool_calls: null,
		tokens_per_second: null,
		time_to_first_token: null,
		input_per_1m: inputPer1m,
		output_per_1m: outputPer1m,
	};
}
