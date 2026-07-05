import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Context } from 'hono';
import type { MasterKeyManager } from '../crypto/master-key';
import type { Db } from '../db/database';
import type { DomainEventBus } from '../events/bus';
import type { AuthInfo, Env } from '../lib/types';
import { verifyToken } from '../middleware/auth';
import { storeUploadedAsset } from '../routes/assets';
import type { ContainerDeps } from '../services/containers';
import type { WebSocketManager } from '../services/ws';
import {
	handleConnectionStatusTool,
	handleRegisterTool,
	ONBOARDING_TOOL_NAMES,
	ONBOARDING_TOOLS,
	REGISTER_TOOL,
} from './onboarding';
import { authContext, registerTools, resolveScope, type ToolDef } from './tools';

let mcpServer: McpServer | null = null;
let toolDefs: ToolDef[] = [];

export function initMcpServer(
	db: Db,
	dataDir: string,
	masterKeyManager: MasterKeyManager,
	wsManager?: WebSocketManager,
	events?: DomainEventBus,
	containerDeps?: ContainerDeps,
): ToolDef[] {
	mcpServer = new McpServer({ name: 'hezo', version: '0.1.0' });
	toolDefs = registerTools(
		mcpServer,
		db,
		dataDir,
		masterKeyManager,
		wsManager,
		events,
		containerDeps,
	);
	return toolDefs;
}

export function getToolDefs(): ToolDef[] {
	return toolDefs;
}

function extractBearer(c: Context<Env>): string | null {
	const header = c.req.header('Authorization');
	if (!header?.startsWith('Bearer ')) return null;
	return header.slice(7);
}

async function authenticateRequest(c: Context<Env>): Promise<AuthInfo | null> {
	const token = extractBearer(c);
	if (!token) return null;
	const db = c.get('db');
	const masterKeyManager = c.get('masterKeyManager');
	return verifyToken(token, db, masterKeyManager);
}

/** Wrap a plain value in the MCP tool-result content shape. */
function toolResult(value: unknown): { content: { type: 'text'; text: string }[] } {
	return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
}

export async function handleMcpRequest(c: Context<Env>): Promise<Response> {
	if (!mcpServer) {
		return c.json(
			{ jsonrpc: '2.0', error: { code: -32603, message: 'MCP server not initialized' }, id: null },
			500,
		);
	}

	// A locked instance grants nothing — distinct from the unauthenticated
	// onboarding surface below, which only exists once the instance is unlocked.
	const masterKeyManager = c.get('masterKeyManager');
	if (masterKeyManager.getState() !== 'unlocked') {
		return c.json(
			{ jsonrpc: '2.0', error: { code: -32000, message: 'Server is locked' }, id: null },
			401,
		);
	}

	// `auth` is null for callers that are not yet an approved principal (no token,
	// an invalid token, or a still-`pending` registration token). Such callers
	// get the onboarding surface only; everything else requires a principal.
	const auth = await authenticateRequest(c);
	const db = c.get('db');
	const body = await c.req.json();

	// JSON-RPC notifications have no `id` field. Per the MCP streamable-http
	// transport contract the server must accept the notification with HTTP 202
	// and an empty body. Returning a JSON-RPC response here breaks rmcp clients
	// (Codex), which try to match the body against pending requests and abort.
	if (body?.id === undefined) {
		return c.body(null, 202);
	}

	// Handle initialize without a transport round-trip: the SDK proxy below
	// would reject because connect() already negotiated initialization. Allowed
	// without a principal so an agent can begin the onboarding handshake.
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

	// Onboarding tool calls work for any caller (the whole point is to register
	// before you have a usable token).
	if (body.method === 'tools/call' && ONBOARDING_TOOL_NAMES.has(body.params?.name)) {
		const value =
			body.params.name === REGISTER_TOOL
				? await handleRegisterTool(db, body.params?.arguments ?? {})
				: await handleConnectionStatusTool(db, extractBearer(c));
		return c.json({ jsonrpc: '2.0', id: body.id, result: toolResult(value) });
	}

	// Not-yet-approved callers see only the onboarding tools and cannot call
	// anything else.
	if (!auth) {
		if (body.method === 'tools/list') {
			return c.json({ jsonrpc: '2.0', id: body.id, result: { tools: ONBOARDING_TOOLS } });
		}
		if (body.method === 'tools/call') {
			return c.json({
				jsonrpc: '2.0',
				id: body.id,
				error: {
					code: -32000,
					message:
						'Not connected. Call the `register` tool, then have a Hezo admin approve you at Settings → API keys.',
				},
			});
		}
		return c.json({
			jsonrpc: '2.0',
			id: body.id,
			error: { code: -32601, message: `Unknown method: ${body.method}` },
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

/**
 * Multipart binary upload for the MCP surface. JSON-RPC can't carry a file, so
 * external callers (API key) and agent runs (run JWT) POST `multipart/form-data`
 * here with a `file` field — plus an optional `project` field for an instance
 * principal that must name the project it's acting in, and an optional `folder`
 * field to place the asset inside a library folder (up to 2 levels, e.g.
 * `scripts` or `launch/images`). The bytes are stored as a project asset through
 * the same path as the REST upload, so the result is retrievable via the
 * existing `list_project_assets` / `read_project_asset` tools (and the per-run
 * `/workspace/.hezo/assets` mount).
 */
export async function handleMcpAssetUpload(c: Context<Env>): Promise<Response> {
	const auth = await authenticateRequest(c);
	if (!auth) {
		return c.json({ error: { code: 'UNAUTHORIZED', message: 'Unauthorized' } }, 401);
	}

	let form: Awaited<ReturnType<typeof c.req.parseBody>>;
	try {
		form = await c.req.parseBody({ all: false });
	} catch {
		return c.json({ error: { code: 'INVALID_REQUEST', message: 'Invalid multipart body' } }, 400);
	}

	const file = form.file;
	if (!(file instanceof Blob) || !('name' in file) || typeof file.name !== 'string') {
		return c.json({ error: { code: 'INVALID_REQUEST', message: 'Missing file field' } }, 400);
	}
	const project =
		typeof form.project === 'string' && form.project.trim().length > 0
			? form.project.trim()
			: undefined;
	const folder = typeof form.folder === 'string' ? form.folder : undefined;

	const scope = await resolveScope(c.get('db'), auth, { project });
	if ('error' in scope) {
		return c.json({ error: { code: 'FORBIDDEN', message: scope.error } }, 403);
	}

	// storeUploadedAsset reads c.get('auth'); /mcp isn't under authMiddleware, so
	// seed the context from the MCP-authenticated principal.
	c.set('auth', auth);
	return storeUploadedAsset(c, scope.teamId, scope.projectId, file as File, null, folder);
}
