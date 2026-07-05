import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MasterKeyManager } from '../src/crypto/master-key';
import type { Db } from '../src/db/database';
import type { Env } from '../src/lib/types';
import { safeClose } from './helpers';
import {
	authHeader,
	createTestApp,
	createTestProject,
	createTestTeam,
	mintAgentToken,
	restartTestApp,
} from './helpers/app';

let app: Hono<Env>;
let db: Db;
let token: string;
let masterKeyManager: MasterKeyManager;
let teamId: string;
let projectSlug: string;
let projectId: string;
let agentId: string;
let dataDir: string;

beforeAll(async () => {
	const ctx = await createTestApp();
	app = ctx.app;
	db = ctx.db;
	token = ctx.token;
	masterKeyManager = ctx.masterKeyManager;
	dataDir = ctx.dataDir;

	const teamRes = await createTestTeam(db, { name: 'MCP Branch Co' });
	teamId = (await teamRes.json()).data.id;
	const proj = (await (await createTestProject(db, teamId, { name: 'Branch Project' })).json())
		.data;
	projectSlug = proj.slug;
	projectId = proj.id;
	const agentsRes = await app.request(`/api/projects/${projectSlug}/agents`, {
		headers: authHeader(token),
	});
	agentId = (await agentsRes.json()).data[0].id;
});

afterAll(async () => {
	await safeClose(db);
});

describe('handleMcpRequest — locked instance', () => {
	it('returns 401 "Server is locked" when the manager is not unlocked', async () => {
		// A fresh manager over the same DB stays 'locked' (canary present, no key in
		// memory) — getState() !== 'unlocked' short-circuits with 401 before auth.
		const { app: lockedApp, masterKeyManager: lockedMgr } = await restartTestApp(db, dataDir);
		expect(lockedMgr.getState()).toBe('locked');
		const res = await lockedApp.request('/mcp', {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ jsonrpc: '2.0', method: 'tools/list', id: 1 }),
		});
		expect(res.status).toBe(401);
		const body = await res.json();
		expect(body.error.code).toBe(-32000);
		expect(body.error.message).toContain('locked');
	});
});

describe('handleMcpRequest — onboarding tool dispatch with a token', () => {
	it('routes connection_status through the onboarding handler even for an approved caller', async () => {
		const res = await app.request('/mcp', {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				jsonrpc: '2.0',
				method: 'tools/call',
				params: { name: 'connection_status', arguments: {} },
				id: 2,
			}),
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		// connection_status returns a text content block via toolResult.
		expect(body.result.content[0].type).toBe('text');
		expect(body).not.toHaveProperty('error');
	});

	it('returns a JSON-RPC unknown-method error to an unauthenticated caller', async () => {
		const res = await app.request('/mcp', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ jsonrpc: '2.0', method: 'totally/bogus', id: 7 }),
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.id).toBe(7);
		expect(body.error.code).toBe(-32601);
		expect(body.error.message).toContain('totally/bogus');
	});
});

describe('handleMcpRequest — extractBearer branches', () => {
	it('treats a malformed (non-Bearer) Authorization header as unauthenticated', async () => {
		const res = await app.request('/mcp', {
			method: 'POST',
			headers: { Authorization: 'Basic abc123', 'Content-Type': 'application/json' },
			body: JSON.stringify({ jsonrpc: '2.0', method: 'tools/list', id: 8 }),
		});
		// Not a Bearer token → auth is null → onboarding-only tools list.
		const body = await res.json();
		const names = body.result.tools.map((t: { name: string }) => t.name);
		expect(names).toContain('register');
		expect(names).not.toContain('create_task');
	});

	it('treats an invalid Bearer token as unauthenticated (onboarding surface)', async () => {
		const res = await app.request('/mcp', {
			method: 'POST',
			headers: { Authorization: 'Bearer not-a-real-token', 'Content-Type': 'application/json' },
			body: JSON.stringify({
				jsonrpc: '2.0',
				method: 'tools/call',
				params: { name: 'list_teams', arguments: {} },
				id: 9,
			}),
		});
		const body = await res.json();
		expect(body.error.message).toContain('Not connected');
	});
});

describe('handleMcpAssetUpload — error branches', () => {
	it('rejects an invalid multipart body with 400 INVALID_REQUEST', async () => {
		const { token: agentToken } = await mintAgentToken(
			db,
			masterKeyManager,
			agentId,
			teamId,
			null,
			{
				projectId,
			},
		);
		// A multipart content-type with a body that has no valid boundary parts makes
		// parseBody reject → the catch arm returns INVALID_REQUEST.
		const res = await app.request('/mcp/assets', {
			method: 'POST',
			headers: {
				...authHeader(agentToken),
				'Content-Type': 'multipart/form-data; boundary=----broken',
			},
			body: 'not actually a multipart payload',
		});
		expect(res.status).toBe(400);
		const body = await res.json();
		expect(body.error.code).toBe('INVALID_REQUEST');
		expect(body.error.message).toContain('multipart');
	});

	it('rejects a multipart body with no file field as 400 Missing file field', async () => {
		const { token: agentToken } = await mintAgentToken(
			db,
			masterKeyManager,
			agentId,
			teamId,
			null,
			{
				projectId,
			},
		);
		const fd = new FormData();
		fd.set('notfile', 'just text');
		const res = await app.request('/mcp/assets', {
			method: 'POST',
			headers: { ...authHeader(agentToken) },
			body: fd,
		});
		expect(res.status).toBe(400);
		const body = await res.json();
		expect(body.error.message).toContain('Missing file field');
	});

	it('returns 403 FORBIDDEN when an instance key uploads without naming a resolvable project', async () => {
		const createRes = await app.request('/api/api-keys', {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ name: 'Scope Key' }),
		});
		const rawKey = (await createRes.json()).data.key;

		// An instance-scoped key with no `project` field cannot resolve a scope.
		const fd = new FormData();
		fd.set('file', new File([new Uint8Array([1, 2, 3])], 'x.png', { type: 'image/png' }));
		const res = await app.request('/mcp/assets', {
			method: 'POST',
			headers: { ...authHeader(rawKey) },
			body: fd,
		});
		expect(res.status).toBe(403);
		const body = await res.json();
		expect(body.error.code).toBe('FORBIDDEN');
	});

	it('ignores a blank project field (trims to undefined) for an instance key → 403', async () => {
		const createRes = await app.request('/api/api-keys', {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ name: 'Blank Scope Key' }),
		});
		const rawKey = (await createRes.json()).data.key;
		const fd = new FormData();
		fd.set('file', new File([new Uint8Array([4, 5, 6])], 'y.png', { type: 'image/png' }));
		fd.set('project', '   '); // whitespace-only → treated as undefined
		const res = await app.request('/mcp/assets', {
			method: 'POST',
			headers: { ...authHeader(rawKey) },
			body: fd,
		});
		expect(res.status).toBe(403);
	});
});
