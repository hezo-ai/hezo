import { createHash } from 'node:crypto';
import type { PGlite } from '@electric-sql/pglite';
import { AuthType } from '@hezo/shared';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Context } from 'hono';
import { verify } from 'hono/jwt';
import type { AuthInfo, Env } from '../lib/types';
import { safeCompareHex } from '../middleware/auth';
import { registerTools, type ToolDef } from './tools';

let mcpServer: McpServer | null = null;
let toolDefs: ToolDef[] = [];

export function initMcpServer(db: PGlite): ToolDef[] {
	mcpServer = new McpServer({ name: 'hezo', version: '0.1.0' });
	toolDefs = registerTools(mcpServer, db);
	return toolDefs;
}

export function getToolDefs(): ToolDef[] {
	return toolDefs;
}

async function authenticateRequest(c: Context<Env>): Promise<AuthInfo | null> {
	const header = c.req.header('Authorization');
	if (!header?.startsWith('Bearer ')) return null;

	const token = header.slice(7);
	const masterKeyManager = c.get('masterKeyManager');
	if (masterKeyManager.getState() !== 'unlocked') return null;

	if (token.startsWith('hezo_')) {
		const db = c.get('db');
		const prefix = token.slice(5, 13);
		const result = await db.query<{ company_id: string; key_hash: string }>(
			'SELECT company_id, key_hash FROM api_keys WHERE prefix = $1',
			[prefix],
		);
		if (result.rows.length === 0) return null;
		const tokenHash = createHash('sha256').update(token).digest('hex');
		if (!safeCompareHex(tokenHash, result.rows[0].key_hash)) return null;
		return { type: AuthType.ApiKey, companyId: result.rows[0].company_id };
	}

	try {
		const jwtKey = await masterKeyManager.getJwtKey();
		const secret = jwtKey.toString('base64');
		const payload = await verify(token, secret, 'HS256');
		if (payload.member_id && payload.company_id) {
			return {
				type: AuthType.Agent,
				memberId: payload.member_id as string,
				companyId: payload.company_id as string,
			};
		}
		if (payload.user_id) {
			const db = c.get('db');
			const userResult = await db.query<{ is_superuser: boolean }>(
				'SELECT is_superuser FROM users WHERE id = $1',
				[payload.user_id],
			);
			const isSuperuser = userResult.rows[0]?.is_superuser ?? false;
			return { type: AuthType.Board, userId: payload.user_id as string, isSuperuser };
		}
		return null;
	} catch {
		return null;
	}
}

export async function handleMcpRequest(c: Context<Env>): Promise<Response> {
	if (!mcpServer) {
		return c.json(
			{ jsonrpc: '2.0', error: { code: -32603, message: 'MCP server not initialized' }, id: null },
			500,
		);
	}

	const auth = await authenticateRequest(c);
	if (!auth) {
		return c.json(
			{ jsonrpc: '2.0', error: { code: -32000, message: 'Unauthorized' }, id: null },
			401,
		);
	}

	// Use in-memory transport for a simple request-response cycle
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

	const serverConnection = mcpServer.connect(serverTransport);

	const body = await c.req.json();

	// Create a temporary client to send the request through the in-memory transport
	const client = new Client({ name: 'hezo-proxy', version: '0.1.0' });
	await client.connect(clientTransport);

	let result: unknown;
	try {
		if (body.method === 'tools/list') {
			result = await client.listTools();
		} else if (body.method === 'tools/call') {
			result = await client.callTool(body.params);
		} else if (body.method === 'initialize') {
			// Already initialized via connect, return server info
			result = {
				protocolVersion: '2025-03-26',
				capabilities: { tools: {} },
				serverInfo: { name: 'hezo', version: '0.1.0' },
			};
		} else {
			result = { error: { code: -32601, message: `Unknown method: ${body.method}` } };
		}
	} finally {
		await client.close();
		await serverConnection;
	}

	return c.json({ jsonrpc: '2.0', result, id: body.id ?? null });
}
