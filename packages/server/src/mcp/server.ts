import type { PGlite } from '@electric-sql/pglite';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Context } from 'hono';
import type { MasterKeyManager } from '../crypto/master-key';
import type { AuthInfo, Env } from '../lib/types';
import { verifyToken } from '../middleware/auth';
import type { WebSocketManager } from '../services/ws';
import { authContext, registerTools, type ToolDef } from './tools';

let mcpServer: McpServer | null = null;
let toolDefs: ToolDef[] = [];

export function initMcpServer(
	db: PGlite,
	dataDir: string,
	masterKeyManager: MasterKeyManager,
	wsManager?: WebSocketManager,
): ToolDef[] {
	mcpServer = new McpServer({ name: 'hezo', version: '0.1.0' });
	toolDefs = registerTools(mcpServer, db, dataDir, masterKeyManager, wsManager);
	return toolDefs;
}

export function getToolDefs(): ToolDef[] {
	return toolDefs;
}

async function authenticateRequest(c: Context<Env>): Promise<AuthInfo | null> {
	const header = c.req.header('Authorization');
	if (!header?.startsWith('Bearer ')) return null;

	const token = header.slice(7);
	const db = c.get('db');
	const masterKeyManager = c.get('masterKeyManager');
	return verifyToken(token, db, masterKeyManager);
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

	const body = await c.req.json();

	// JSON-RPC notifications have no `id` field. Per the MCP streamable-http
	// transport contract the server must accept the notification with HTTP 202
	// and an empty body. Returning a JSON-RPC response here breaks rmcp clients
	// (Codex), which try to match the body against pending requests and abort.
	if (body?.id === undefined) {
		return c.body(null, 202);
	}

	// Handle initialize without a transport round-trip: the SDK proxy below
	// would reject because connect() already negotiated initialization.
	if (body.method === 'initialize') {
		return c.json({
			jsonrpc: '2.0',
			id: body.id,
			result: {
				protocolVersion: '2025-03-26',
				capabilities: { tools: {} },
				serverInfo: { name: 'hezo', version: '0.1.0' },
			},
		});
	}

	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	const serverConnection = mcpServer.connect(serverTransport);
	const client = new Client({ name: 'hezo-proxy', version: '0.1.0' });
	await client.connect(clientTransport);

	try {
		let result: unknown;
		if (body.method === 'tools/list') {
			result = await client.listTools();
		} else if (body.method === 'tools/call') {
			result = await authContext.run(auth, () => client.callTool(body.params));
		} else {
			return c.json({
				jsonrpc: '2.0',
				id: body.id,
				error: { code: -32601, message: `Unknown method: ${body.method}` },
			});
		}
		return c.json({ jsonrpc: '2.0', id: body.id, result });
	} finally {
		await client.close();
		await serverConnection;
	}
}
