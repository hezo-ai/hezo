import type { Hono } from 'hono';
import { expect } from 'vitest';
import type { Env } from '../../src/lib/types';
import { authHeader } from './app';

/** An MCP tool result as tests read it: the parsed JSON body, with any failure as `error`. */
export type McpToolResult = Record<string, unknown> & { error?: string };

/**
 * Call an MCP tool as the principal `token` names and return its parsed result.
 *
 * A schema-validation failure comes back as a non-JSON MCP error string in the
 * result content, or as a JSON-RPC error. Either surfaces as `{ error }`, so a
 * test asserts refusals the same way whatever layer produced them.
 */
export async function callMcpTool(
	app: Hono<Env>,
	token: string,
	toolName: string,
	args: Record<string, unknown>,
): Promise<McpToolResult> {
	const res = await app.request('/mcp', {
		method: 'POST',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify({
			jsonrpc: '2.0',
			method: 'tools/call',
			params: { name: toolName, arguments: args },
			id: 1,
		}),
	});
	expect(res.status).toBe(200);
	const body = (await res.json()) as {
		result?: { content: Array<{ type: string; text: string }> };
		error?: { message: string };
	};
	if (!body.result) return { error: body.error?.message ?? 'unknown error' };
	const text = body.result.content[0].text;
	try {
		return JSON.parse(text) as McpToolResult;
	} catch {
		return { error: text };
	}
}
