import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MasterKeyManager } from '../src/crypto/master-key';
import type { Db } from '../src/db/database';
import type { AuthInfo, Env } from '../src/lib/types';
import { resolveScope } from '../src/mcp/tools';
import { safeClose } from './helpers';
import {
	authHeader,
	createTestApp,
	createTestProject,
	createTestTeam,
	restartTestApp,
} from './helpers/app';

// Branch coverage for packages/server/src/mcp/server.ts (the JSON-RPC proxy
// and the multipart asset upload) plus two tools.ts paths only reachable by
// driving the registry directly: the missing-auth-context guard and the
// authorizeScope default deny.

let app: Hono<Env>;
let db: Db;
let token: string;
let masterKeyManager: MasterKeyManager;
let dataDir: string;
let projectSlug: string;
let apiKey: string;

beforeAll(async () => {
	const ctx = await createTestApp();
	app = ctx.app;
	db = ctx.db;
	token = ctx.token;
	masterKeyManager = ctx.masterKeyManager;
	dataDir = ctx.dataDir;

	const teamRes = await createTestTeam(db, { name: 'Server Branch Co' });
	const teamId = (await teamRes.json()).data.id;
	const projectRes = await createTestProject(db, teamId, { name: 'Server Branch Project' });
	projectSlug = (await projectRes.json()).data.slug;

	const keyRes = await app.request('/api/api-keys', {
		method: 'POST',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify({ name: 'Server Branch Key' }),
	});
	apiKey = (await keyRes.json()).data.key;
});

afterAll(async () => {
	await safeClose(db);
});

async function rpc(
	body: Record<string, unknown>,
	auth?: string,
): Promise<{ status: number; json: Record<string, unknown> }> {
	const headers: Record<string, string> = { 'Content-Type': 'application/json' };
	if (auth) headers.Authorization = `Bearer ${auth}`;
	const res = await app.request('/mcp', { method: 'POST', headers, body: JSON.stringify(body) });
	return {
		status: res.status,
		json: (await res.json().catch(() => ({}))) as Record<string, unknown>,
	};
}

describe('handleMcpRequest branches', () => {
	it('accepts a JSON-RPC notification (no id) with HTTP 202 and empty body', async () => {
		const res = await app.request('/mcp', {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
		});
		expect(res.status).toBe(202);
		expect(await res.text()).toBe('');
	});

	it('answers initialize without a principal', async () => {
		const { json } = await rpc({ jsonrpc: '2.0', id: 7, method: 'initialize', params: {} });
		const result = json.result as { serverInfo: { name: string }; protocolVersion: string };
		expect(result.serverInfo.name).toBe('hezo');
		expect(result.protocolVersion).toBeDefined();
	});

	it('carries the registry conventions as initialize instructions', async () => {
		// The only surface above an individual tool that reaches a caller on the
		// wire. Without it a convention has nowhere to live but the 81 tool
		// descriptions, where one sentence is serialized once per tool on every
		// `tools/list`.
		const { json } = await rpc({ jsonrpc: '2.0', id: 8, method: 'initialize', params: {} });
		const instructions = (json.result as { instructions?: string }).instructions ?? '';
		expect(instructions.length).toBeGreaterThan(1000);
		// The conventions a caller cannot infer from any single tool's schema.
		expect(instructions).toContain('**Project scope (`project`):**');
		expect(instructions).toContain('Omit it to act in the project your run is already in');
		expect(instructions).toContain('**Paging is the norm');
		expect(instructions).toContain('result_too_large');
		expect(instructions).toContain('__HEZO_SECRET_<NAME>__');
	});

	it('states the conventions without the reference page furniture', async () => {
		// Same source as docs/reference/mcp-api.md, so two clauses that point at
		// page layout are reworded for the wire rather than shipped verbatim.
		const { json } = await rpc({ jsonrpc: '2.0', id: 9, method: 'initialize', params: {} });
		const instructions = (json.result as { instructions?: string }).instructions ?? '';
		expect(instructions).not.toContain('**Authorization** below');
		expect(instructions).not.toContain('_Write tool_');
	});

	it('serves identical instructions on every initialize', async () => {
		// Cached, and constant: a caller that reconnects must not see it drift.
		const a = await rpc({ jsonrpc: '2.0', id: 10, method: 'initialize', params: {} });
		const b = await rpc({ jsonrpc: '2.0', id: 11, method: 'initialize', params: {} });
		expect((a.json.result as { instructions?: string }).instructions).toBe(
			(b.json.result as { instructions?: string }).instructions,
		);
	});

	it('unauthenticated tools/list returns only the onboarding tools', async () => {
		const { json } = await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
		const tools = (json.result as { tools: Array<{ name: string }> }).tools;
		expect(tools.length).toBeGreaterThan(0);
		expect(tools.map((t) => t.name)).not.toContain('list_tasks');
	});

	it('unauthenticated tools/call for a normal tool is refused with onboarding guidance', async () => {
		const { json } = await rpc({
			jsonrpc: '2.0',
			id: 2,
			method: 'tools/call',
			params: { name: 'list_tasks', arguments: {} },
		});
		expect((json.error as { message: string }).message).toContain('Not connected');
	});

	it('unauthenticated unknown methods error with -32601', async () => {
		const { json } = await rpc({ jsonrpc: '2.0', id: 3, method: 'resources/list' });
		expect((json.error as { code: number }).code).toBe(-32601);
	});

	it('authenticated unknown methods error with -32601', async () => {
		const { json } = await rpc({ jsonrpc: '2.0', id: 4, method: 'resources/list' }, token);
		expect((json.error as { code: number; message: string }).message).toContain('Unknown method');
	});

	it('GET /mcp is method-not-allowed', async () => {
		const res = await app.request('/mcp', { method: 'GET' });
		expect(res.status).toBe(405);
		expect(res.headers.get('Allow')).toBe('POST');
	});

	it('authenticated tools/list proxies the full registry', async () => {
		const { json } = await rpc({ jsonrpc: '2.0', id: 5, method: 'tools/list' }, token);
		const tools = (json.result as { tools: Array<{ name: string }> }).tools;
		expect(tools.map((t) => t.name)).toContain('list_tasks');
	});

	it('onboarding register + connection_status work without a principal', async () => {
		const reg = await rpc({
			jsonrpc: '2.0',
			id: 6,
			method: 'tools/call',
			params: { name: 'register', arguments: { name: 'Onboarding Cov Client' } },
		});
		const regPayload = JSON.parse(
			(reg.json.result as { content: Array<{ text: string }> }).content[0].text,
		) as { token?: string; key?: string; status?: string };
		const pendingKey = regPayload.token ?? regPayload.key;
		expect(pendingKey).toBeDefined();

		const status = await rpc(
			{
				jsonrpc: '2.0',
				id: 7,
				method: 'tools/call',
				params: { name: 'connection_status', arguments: {} },
			},
			pendingKey,
		);
		const statusPayload = JSON.parse(
			(status.json.result as { content: Array<{ text: string }> }).content[0].text,
		) as { status: string };
		expect(statusPayload.status).toBeDefined();
	});
});

describe('handleMcpAssetUpload branches', () => {
	it('rejects unauthenticated uploads', async () => {
		const form = new FormData();
		form.append('file', new File(['x'], 'x.txt', { type: 'text/plain' }));
		const res = await app.request('/mcp/assets', { method: 'POST', body: form });
		expect(res.status).toBe(401);
	});

	it('rejects an unparsable multipart body', async () => {
		const res = await app.request('/mcp/assets', {
			method: 'POST',
			headers: {
				...authHeader(apiKey),
				'Content-Type': 'multipart/form-data; boundary=deadbeef',
			},
			body: 'this is not multipart at all',
		});
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: { message: string } };
		expect(body.error.message).toMatch(/Invalid multipart body|Missing file field/);
	});

	it('rejects a body with no file field', async () => {
		const form = new FormData();
		form.append('project', projectSlug);
		const res = await app.request('/mcp/assets', {
			method: 'POST',
			headers: authHeader(apiKey),
			body: form,
		});
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: { code: string } };
		expect(body.error.code).toBe('INVALID_REQUEST');
	});

	it('rejects an instance principal that names no project', async () => {
		const form = new FormData();
		form.append('file', new File(['x'], 'x.txt', { type: 'text/plain' }));
		const res = await app.request('/mcp/assets', {
			method: 'POST',
			headers: authHeader(apiKey),
			body: form,
		});
		expect(res.status).toBe(403);
		const body = (await res.json()) as { error: { message: string } };
		expect(body.error.message).toBe('`project` is required');
	});

	it('stores an upload into the named project with a folder', async () => {
		const form = new FormData();
		form.append('file', new File(['uploaded bytes'], 'upload.txt', { type: 'text/plain' }));
		form.append('project', projectSlug);
		form.append('folder', 'incoming');
		const res = await app.request('/mcp/assets', {
			method: 'POST',
			headers: authHeader(apiKey),
			body: form,
		});
		expect(res.status).toBe(201);
		const asset = await db.query(
			`SELECT id FROM assets WHERE original_filename = 'incoming/upload.txt'`,
		);
		expect(asset.rows.length).toBe(1);
	});
});

describe('registry-level tool branches', () => {
	it('getToolDefs exposes the registered tool metadata', async () => {
		const { getToolDefs } = await import('../src/mcp/server');
		const defs = getToolDefs();
		const createTask = defs.find((d) => d.name === 'create_task');
		expect(createTask?.write).toBe(true);
		const listTasks = defs.find((d) => d.name === 'list_tasks');
		expect(listTasks?.write).toBe(false);
	});

	it('a tool invoked without an auth context returns Unauthorized', async () => {
		const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js');
		const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
		const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
		const { registerTools } = await import('../src/mcp/tools');

		const server = new McpServer({ name: 'raw', version: '0.0.0' });
		registerTools(server, db, dataDir, masterKeyManager);
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		const connection = server.connect(serverTransport);
		const client = new Client({ name: 'raw-client', version: '0.0.0' });
		await client.connect(clientTransport);
		try {
			const res = (await client.callTool({ name: 'list_teams', arguments: {} })) as {
				content: Array<{ text: string }>;
			};
			expect(JSON.parse(res.content[0].text)).toEqual({
				error: 'Unauthorized: missing auth context',
			});
		} finally {
			await client.close();
			await connection;
		}
	});

	it('resolveScope denies unknown principal types', async () => {
		const bogus = { type: 'something-else' } as unknown as AuthInfo;
		const r = await resolveScope(db, bogus, { project: projectSlug });
		expect(r).toEqual({ error: 'Access denied' });
	});

	it('create_project without containerDeps reports it is unavailable', async () => {
		const { AuthType, DEFAULT_TEAM_ID } = await import('@hezo/shared');
		const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js');
		const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
		const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
		const { registerTools, authContext } = await import('../src/mcp/tools');
		const { instanceCeoId } = await import('./helpers/app');

		const ceoId = await instanceCeoId(db);
		const hq = await db.query<{ id: string }>(
			'SELECT id FROM projects WHERE is_internal = true LIMIT 1',
		);
		const auth = {
			type: AuthType.Agent,
			memberId: ceoId,
			teamId: DEFAULT_TEAM_ID,
			runId: crypto.randomUUID(),
			taskId: null,
			projectId: hq.rows[0].id,
			crossProject: true,
		} as unknown as AuthInfo;

		// Registered without containerDeps — the guard is the branch under test.
		const server = new McpServer({ name: 'no-deps', version: '0.0.0' });
		registerTools(server, db, dataDir, masterKeyManager);
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		const connection = server.connect(serverTransport);
		const client = new Client({ name: 'no-deps-client', version: '0.0.0' });
		await client.connect(clientTransport);
		try {
			const res = (await authContext.run(auth, () =>
				client.callTool({
					name: 'create_project',
					arguments: { name: 'Depless', description: 'No deps available.' },
				}),
			)) as { content: Array<{ text: string }> };
			expect(JSON.parse(res.content[0].text)).toEqual({
				error: 'Project creation is not available in this context',
			});
		} finally {
			await client.close();
			await connection;
		}
	});
});

// Keep last: restartTestApp swaps the module-global MCP server for one bound
// to a locked MasterKeyManager, so tool calls through the first app would use
// stale key material after this.
describe('locked instance', () => {
	it('refuses /mcp with 401 while locked', async () => {
		const locked = await restartTestApp(db, dataDir);
		const res = await locked.app.request('/mcp', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
		});
		expect(res.status).toBe(401);
		const body = (await res.json()) as { error: { message: string } };
		expect(body.error.message).toBe('Server is locked');
	});
});
