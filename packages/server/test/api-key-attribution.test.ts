import type { PGlite } from '@electric-sql/pglite';

// biome-ignore lint/suspicious/noExplicitAny: tests parse unpredictable JSON-RPC payloads
type Json = any;

import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Env } from '../src/lib/types';
import { safeClose } from './helpers';
import { authHeader, createTestApp, createTestProject, createTestTeam } from './helpers/app';

// An approved API key is admin-equivalent over MCP. Its actions must be attributed
// to its identity so the UI can flag them with a bot badge instead of a bare "admin".

let app: Hono<Env>;
let db: PGlite;
let token: string; // superuser admin
let projectSlug: string;

async function registerAndApprove(name: string): Promise<string> {
	const reg = await app.request('/api/api-keys/register', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ name }),
	});
	expect(reg.status).toBe(201);
	const { id, token: keyToken } = (await reg.json()).data;
	const approveRes = await app.request(`/api/api-keys/${id}/approve`, {
		method: 'POST',
		headers: authHeader(token),
	});
	expect(approveRes.status).toBe(200);
	return keyToken as string;
}

async function mcpTool(
	keyToken: string,
	name: string,
	args: Record<string, unknown>,
): Promise<Json> {
	const res = await app.request('/mcp', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${keyToken}` },
		body: JSON.stringify({
			jsonrpc: '2.0',
			method: 'tools/call',
			params: { name, arguments: args },
			id: 1,
		}),
	});
	const body = await res.json();
	if (body.error) throw new Error(`MCP ${name} failed: ${JSON.stringify(body.error)}`);
	return JSON.parse(body.result.content[0].text);
}

async function getComments(taskId: string): Promise<Json[]> {
	const res = await app.request(`/api/projects/${projectSlug}/tasks/${taskId}/comments`, {
		headers: authHeader(token),
	});
	return (await res.json()).data as Json[];
}

async function waitFor<T>(fn: () => Promise<T | null | undefined>, timeoutMs = 1500): Promise<T> {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		const r = await fn();
		if (r) return r;
		await new Promise((res) => setTimeout(res, 20));
	}
	throw new Error('waitFor timed out');
}

beforeAll(async () => {
	const ctx = await createTestApp();
	app = ctx.app;
	db = ctx.db;
	token = ctx.token;
	const team = (await (await createTestTeam(db, { name: 'Attrib Co' })).json()).data;
	projectSlug = (await (await createTestProject(db, team.id, { name: 'Attrib Project' })).json())
		.data.slug;
});

afterAll(async () => {
	await safeClose(db);
});

describe('API-key action attribution', () => {
	it('attributes a task created via MCP to the API key in the audit log', async () => {
		const keyToken = await registerAndApprove('Audit Bot');
		const created = await mcpTool(keyToken, 'create_task', {
			project: projectSlug,
			title: 'Filed by the API key',
			assignee_slug: 'captain',
		});
		expect(created.id ?? created.identifier).toBeTruthy();

		const auditRow = await waitFor(async () => {
			const r = await db.query<{ actor_type: string; actor_api_key_id: string | null }>(
				`SELECT actor_type, actor_api_key_id FROM audit_log
				 WHERE entity_type = 'task' AND action = 'created' AND actor_type = 'api_key'
				 ORDER BY created_at DESC LIMIT 1`,
			);
			return r.rows[0] ?? null;
		});
		expect(auditRow.actor_api_key_id).not.toBeNull();

		// The API key's identity name resolves from api_keys.
		const named = await db.query<{ name: string }>('SELECT name FROM api_keys WHERE id = $1', [
			auditRow.actor_api_key_id,
		]);
		expect(named.rows[0].name).toBe('Audit Bot');
	});

	it('attributes a comment and a status change made via MCP to the API key', async () => {
		const keyToken = await registerAndApprove('Comment Bot');

		// Create a task to act on (as the admin).
		const taskRes = await app.request(`/api/projects/${projectSlug}/tasks`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ title: 'Work item', assignee_slug: 'captain' }),
		});
		const task = (await taskRes.json()).data;

		await mcpTool(keyToken, 'create_comment', {
			project: projectSlug,
			task_id: task.identifier,
			content: 'handled by the API key',
		});
		await mcpTool(keyToken, 'update_task', {
			project: projectSlug,
			task_id: task.identifier,
			status: 'in_progress',
		});

		const comments = await getComments(task.id);
		const authored = comments.find((c) => c.content?.text === 'handled by the API key');
		expect(authored?.author_type).toBe('api_key');
		expect(authored?.author_name).toBe('Comment Bot');
		expect(authored?.author_api_key_id).not.toBeNull();

		const statusComment = comments.find(
			(c) => c.content_type === 'system' && c.content?.kind === 'status_change',
		);
		expect(statusComment?.author_type).toBe('api_key');
		expect(statusComment?.author_api_key_id).not.toBeNull();
	});

	it('attributes a project-doc revision (via MCP) to the API key', async () => {
		const keyToken = await registerAndApprove('Doc Bot');
		for (const content of ['v1', 'v2']) {
			await mcpTool(keyToken, 'write_project_doc', {
				project: projectSlug,
				filename: 'notes.md',
				content,
			});
		}
		const revRes = await app.request(`/api/projects/${projectSlug}/docs/notes.md/revisions`, {
			headers: authHeader(token),
		});
		const revisions = (await revRes.json()).data as Json[];
		expect(revisions[0].author_type).toBe('api_key');
		expect(revisions[0].author_name).toBe('Doc Bot');
		expect(revisions[0].author_api_key_id).not.toBeNull();
	});
});
