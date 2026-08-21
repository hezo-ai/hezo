import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Context } from 'hono';
import type { AssetStore } from '../assets/store';
import type { MasterKeyManager } from '../crypto/master-key';
import type { Db } from '../db/database';
import type { DomainEventBus } from '../events/bus';
import type { AuthInfo, Env } from '../lib/types';
import { verifyToken } from '../middleware/auth';
import { storeUploadedAsset } from '../routes/assets';
import type { ContainerDeps } from '../services/containers';
import type { WebSocketManager } from '../services/ws';
import { mcpConventionLines } from './mcp-reference';
import {
	handleConnectionStatusTool,
	handleRegisterTool,
	ONBOARDING_TOOL_NAMES,
	ONBOARDING_TOOLS,
	REGISTER_TOOL,
} from './onboarding';
import { projectToolsForCaller, type ToolAudience } from './tool-visibility';
import {
	authContext,
	callerOriginContext,
	registerTools,
	resolveScope,
	type ToolDef,
} from './tools';

let mcpServer: McpServer | null = null;
let toolDefs: ToolDef[] = [];
/**
 * The in-memory client/server pair that fronts the tool registry, created once
 * and shared by every request.
 *
 * A Protocol owns exactly one transport, so linking a fresh pair per request
 * made overlapping requests collide on the shared server: the second caller's
 * `connect()` rejected, and its client then waited out the full SDK request
 * timeout for an `initialize` reply no server would send. The SDK multiplexes
 * concurrent requests over a single transport by JSON-RPC id, so one long-lived
 * link serves them all. Delivery is synchronous on the caller's stack, which is
 * what keeps the per-request auth context flowing into the tool handlers.
 */
let proxyClient: Promise<Client> | null = null;

function getProxyClient(server: McpServer): Promise<Client> {
	if (!proxyClient) {
		proxyClient = (async () => {
			const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
			const client = new Client({ name: 'hezo-proxy', version: '0.1.0' });
			await server.connect(serverTransport);
			await client.connect(clientTransport);
			return client;
		})().catch((e) => {
			// Don't cache a failed link — let the next request build a new one.
			proxyClient = null;
			throw e;
		});
	}
	return proxyClient;
}

export function initMcpServer(
	db: Db,
	dataDir: string,
	masterKeyManager: MasterKeyManager,
	wsManager?: WebSocketManager,
	events?: DomainEventBus,
	containerDeps?: ContainerDeps,
	assetStore?: AssetStore,
	serverPort?: number,
): ToolDef[] {
	mcpServer = new McpServer({ name: 'hezo', version: '0.1.0' });
	// A new server needs a new link; the old pair belongs to the discarded one.
	proxyClient = null;
	toolDefs = registerTools(
		mcpServer,
		db,
		dataDir,
		masterKeyManager,
		wsManager,
		events,
		containerDeps,
		assetStore,
		serverPort,
	);
	return toolDefs;
}

export function getToolDefs(): ToolDef[] {
	return toolDefs;
}

/**
 * The caller class a tool's handler gates on, read off its own registration.
 *
 * `tools/list` comes back from the SDK carrying only what the protocol defines,
 * so the audience has to be looked up by name on the way out - but the lookup
 * resolves against the registry itself, not a second table that could name a
 * tool no longer registered, or miss one newly added.
 */
export function audienceOf(name: string): ToolAudience | undefined {
	return toolDefs.find((t) => t.name === name)?.audience;
}

/**
 * The registry-wide calling conventions, sent once per session as the
 * `initialize` result's `instructions`.
 *
 * This is the only surface above an individual tool that reaches an MCP caller
 * on the wire. Without it a convention has nowhere to live but the tool
 * descriptions, where one sentence becomes 70 copies on every `tools/list` -
 * `project` alone costs ~9 KB that way. `SHARED_INSTRUCTIONS` is not a
 * substitute: it is built for an agent run's system prompt, so an external
 * API-key caller never sees it, and `GET /SKILL.md` carries no parameter
 * descriptions at all.
 *
 * Authored with the reference page in `mcp-reference.ts` so the two cannot
 * disagree.
 */
let instructionsCache: string | null = null;
function mcpInstructions(): string {
	if (instructionsCache === null) {
		instructionsCache = mcpConventionLines('wire').join('\n');
	}
	return instructionsCache;
}

function extractBearer(c: Context<Env>): string | null {
	const header = c.req.header('Authorization');
	if (!header?.startsWith('Bearer ')) return null;
	return header.slice(7);
}

/**
 * The origin this request was addressed to, for building absolute URLs the same
 * caller can dial back. See {@link callerOriginContext} for why it comes off the
 * request rather than from server config.
 */
function callerOrigin(c: Context<Env>): string {
	const host = c.req.header('Host');
	if (!host) return new URL(c.req.url).origin;
	// The MCP leg is plain HTTP over the tunnel's loopback port; a deployment
	// terminating TLS in front says so with the standard forwarded header.
	const proto = c.req.header('X-Forwarded-Proto') ?? new URL(c.req.url).protocol.replace(':', '');
	return `${proto}://${host}`;
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
				// Hand-rolled rather than delegated to the SDK (see the branch above),
				// so this is the only place `instructions` can reach a caller -
				// passing it to `new McpServer(...)` would be a silent no-op.
				instructions: mcpInstructions(),
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

	const client = await getProxyClient(mcpServer);

	let result: unknown;
	if (body.method === 'tools/list') {
		// Listed per caller: an agent scoped to one project has no use for
		// `create_team` or the Captain-only prompt editors, and carrying their
		// schemas costs it context on every turn. Hiding only - `tools/call` still
		// runs every gate below, so this can never be the thing granting access.
		const listed = await client.listTools();
		result = {
			...listed,
			// The audience rides on each tool's registration, so it is read back off
			// the registry rather than from a second table keyed by name.
			tools: await projectToolsForCaller(db, auth, listed.tools, audienceOf),
		};
	} else if (body.method === 'tools/call') {
		result = await authContext.run(auth, () =>
			callerOriginContext.run(callerOrigin(c), () => client.callTool(body.params)),
		);
	} else {
		return c.json({
			jsonrpc: '2.0',
			id: body.id,
			error: { code: -32601, message: `Unknown method: ${body.method}` },
		});
	}
	return c.json({ jsonrpc: '2.0', id: body.id, result });
}

/**
 * Multipart binary upload for the MCP surface. JSON-RPC can't carry a file, so
 * external callers (API key) and agent runs (run JWT) POST `multipart/form-data`
 * here with a `file` field — plus optional fields:
 *   - `project` — for an instance principal that must name the project it's
 *     acting in.
 *   - `path` — the full destination path (folders + basename, up to 2 levels,
 *     e.g. `launch/images/hero.png`); its folders are preserved. A folder
 *     embedded in the file part's `filename=` is honoured the same way when no
 *     explicit `path` field is sent.
 *   - `folder` — legacy: place the basename inside a library folder (up to 2
 *     levels). Ignored when `path` is given.
 *   - `overwrite` — `true`/`1` replaces an existing asset at the path in place
 *     (stable reference), matching write_project_asset; otherwise a colliding
 *     name is auto-suffixed.
 * The bytes are stored as a project asset through the same path as the REST
 * upload, so the result is retrievable via the existing `list_project_assets` /
 * `read_project_asset` tools (binary contents come back as a signed download
 * URL). The JSON response carries `byte_size`, so the caller can confirm the
 * full file landed.
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
	const pathField =
		typeof form.path === 'string' && form.path.trim().length > 0 ? form.path.trim() : undefined;
	// A folder embedded in the file part's `filename=` (file.name carries a
	// separator) is treated as the full destination path when no explicit `path`
	// field is sent — so `-F filename=community-posts/hero.png` lands there
	// instead of being stripped to its basename.
	const path = pathField ?? (/[/\\]/.test(file.name) ? file.name : undefined);
	const overwrite = form.overwrite === 'true' || form.overwrite === '1';

	const scope = await resolveScope(c.get('db'), auth, { project });
	if ('error' in scope) {
		return c.json({ error: { code: 'FORBIDDEN', message: scope.error } }, 403);
	}

	// storeUploadedAsset reads c.get('auth'); /mcp isn't under authMiddleware, so
	// seed the context from the MCP-authenticated principal.
	c.set('auth', auth);
	return storeUploadedAsset(c, scope.teamId, scope.projectId, file as File, null, folder, {
		path,
		overwrite,
	});
}
