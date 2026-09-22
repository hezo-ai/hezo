import type { Hono } from 'hono';
import { expect } from 'vitest';
import type { Env } from '../../src/lib/types';
import { authHeader } from './app';

/** An MCP tool result as tests read it: the parsed JSON body, with any failure as `error`. */
export type McpToolResult = Record<string, unknown> & { error?: string };

/**
 * Call an MCP tool as the principal `token` names and return its parsed result,
 * typed as the caller expects the tool's JSON to be.
 *
 * A schema-validation failure comes back as a non-JSON MCP error string in the
 * result content, or as a JSON-RPC error. Either surfaces as `{ error }`, so a
 * test asserts refusals the same way whatever layer produced them.
 */
export async function callMcpTool<T = McpToolResult>(
	app: Hono<Env>,
	token: string,
	toolName: string,
	args: Record<string, unknown>,
): Promise<T> {
	const content = await callMcpToolContent(app, token, toolName, args);
	if ('error' in content) return content as T;
	const text = content[0]?.text ?? '';
	try {
		return JSON.parse(text) as T;
	} catch {
		return { error: text } as T;
	}
}

/** One block of an MCP tool result: text, or an image with its data and type. */
export interface McpContentBlock {
	type: string;
	text?: string;
	data?: string;
	mimeType?: string;
}

/**
 * Call an MCP tool and return its content blocks as they came, for a test that
 * reads more than one block or a non-text one. A JSON-RPC error comes back as
 * `{ error }`.
 */
export async function callMcpToolContent(
	app: Hono<Env>,
	token: string,
	toolName: string,
	args: Record<string, unknown>,
): Promise<McpContentBlock[] | { error: string }> {
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
		result?: { content: McpContentBlock[] };
		error?: { message: string };
	};
	if (!body.result) return { error: body.error?.message ?? 'unknown error' };
	return body.result.content;
}
