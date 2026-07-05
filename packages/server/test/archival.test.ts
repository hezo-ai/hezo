import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MasterKeyManager } from '../src/crypto/master-key';
import type { Db } from '../src/db/database';
import type { Env } from '../src/lib/types';
import { fullTextSearch } from '../src/services/search';
import { resolveSystemPrompt } from '../src/services/template-resolver';
import { safeClose } from './helpers';
import {
	authHeader,
	createTestApp,
	createTestProject,
	createTestTeam,
	mintAgentToken,
} from './helpers/app';

// Archival (soft delete) for project docs and assets: agents archive via MCP,
// only admins hard-delete, and every default listing surface is active-only.

let app: Hono<Env>;
let db: Db;
let token: string;
let masterKeyManager: MasterKeyManager;
let teamId: string;
let projectId: string;
let taskId: string;
let agentId: string;

async function agentToken(): Promise<string> {
	const { token: t } = await mintAgentToken(db, masterKeyManager, agentId, teamId, taskId);
	return t;
}

async function callToolViaMcp(
	authToken: string,
	toolName: string,
	args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
	const res = await app.request('/mcp', {
		method: 'POST',
		headers: { ...authHeader(authToken), 'Content-Type': 'application/json' },
		body: JSON.stringify({
			jsonrpc: '2.0',
			method: 'tools/call',
			params: { name: toolName, arguments: args },
			id: 1,
		}),
	});
	const body = (await res.json()) as { result: { content: Array<{ text: string }> } };
	return JSON.parse(body.result.content[0].text);
}

async function listToolNames(authToken: string): Promise<string[]> {
	const res = await app.request('/mcp', {
		method: 'POST',
		headers: { ...authHeader(authToken), 'Content-Type': 'application/json' },
		body: JSON.stringify({ jsonrpc: '2.0', method: 'tools/list', params: {}, id: 1 }),
	});
	const body = (await res.json()) as { result: { tools: Array<{ name: string }> } };
	return body.result.tools.map((t) => t.name);
}

async function putDoc(filename: string, content: string): Promise<Response> {
	return app.request(`/api/projects/${projectId}/docs/${filename}`, {
		method: 'PUT',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify({ content }),
	});
}

async function patchDoc(filename: string, body: Record<string, unknown>, authToken = token) {
	return app.request(`/api/projects/${projectId}/docs/${filename}`, {
		method: 'PATCH',
		headers: { ...authHeader(authToken), 'Content-Type': 'application/json' },
		body: JSON.stringify(body),
	});
}

async function listDocs(): Promise<
	Array<{ filename: string; archived_at: string | null; status: string }>
> {
	const res = await app.request(`/api/projects/${projectId}/docs`, {
		headers: authHeader(token),
	});
	return (await res.json()).data;
}

async function uploadAsset(filename: string): Promise<{ id: string; path: string }> {
	const fd = new FormData();
	fd.set('file', new File(['hello world'], filename, { type: 'text/plain' }));
	const res = await app.request(`/api/projects/${projectId}/assets`, {
		method: 'POST',
		headers: { ...authHeader(token) },
		body: fd,
	});
	const body = await res.json();
	return { id: body.data.id, path: body.data.original_filename };
}

async function patchAsset(assetId: string, body: Record<string, unknown>, authToken = token) {
	return app.request(`/api/projects/${projectId}/assets/${assetId}`, {
		method: 'PATCH',
		headers: { ...authHeader(authToken), 'Content-Type': 'application/json' },
		body: JSON.stringify(body),
	});
}

async function listAssets(): Promise<Array<{ id: string; archived_at: string | null }>> {
	const res = await app.request(`/api/projects/${projectId}/assets`, {
		headers: authHeader(token),
	});
	return (await res.json()).data;
}

beforeAll(async () => {
	const ctx = await createTestApp();
	app = ctx.app;
	db = ctx.db;
	token = ctx.token;
	masterKeyManager = ctx.masterKeyManager;

	const teamRes = await createTestTeam(db, { name: 'Archive Co' });
	teamId = (await teamRes.json()).data.id;
	const projectRes = await createTestProject(db, teamId, { name: 'Main', description: 'X.' });
	projectId = (await projectRes.json()).data.id;

	const agentRes = await app.request(`/api/projects/${projectId}/agents`, {
		method: 'POST',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify({ title: 'Archivist' }),
	});
	agentId = (await agentRes.json()).data.id;

	const taskRes = await app.request(`/api/projects/${projectId}/tasks`, {
		method: 'POST',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify({ project_id: projectId, title: 'Curate', assignee_id: agentId }),
	});
	taskId = (await taskRes.json()).data.id;
});

afterAll(async () => {
	await safeClose(db);
});

describe('project doc archival — REST', () => {
	it('archives and restores via PATCH, stamping who archived', async () => {
		await putDoc('old-plan.md', '# Old plan');
		const archive = await patchDoc('old-plan.md', { archived: true });
		expect(archive.status).toBe(200);
		const archivedDoc = (await archive.json()).data;
		expect(archivedDoc.archived_at).not.toBeNull();
		// The admin actor resolves to its member row for attribution.
		expect(archivedDoc.archived_by_name).not.toBeNull();

		const list = await listDocs();
		const entry = list.find((d) => d.filename === 'old-plan.md');
		expect(entry?.archived_at).not.toBeNull();

		const restore = await patchDoc('old-plan.md', { archived: false });
		expect((await restore.json()).data.archived_at).toBeNull();
	});

	it('records the agent as archiver when an agent archives', async () => {
		await putDoc('agent-archived.md', 'body');
		const res = await patchDoc('agent-archived.md', { archived: true }, await agentToken());
		expect(res.status).toBe(200);
		expect((await res.json()).data.archived_by_name).toBe('Archivist');
	});

	it('blocks writes, status flips, and revision restores while archived', async () => {
		await putDoc('frozen.md', 'v1');
		await putDoc('frozen.md', 'v2'); // record a revision to restore
		await patchDoc('frozen.md', { archived: true });

		const write = await putDoc('frozen.md', 'v3');
		expect(write.status).toBe(409);

		const status = await patchDoc('frozen.md', { status: 'approved' });
		expect(status.status).toBe(409);

		const restore = await app.request(`/api/projects/${projectId}/docs/frozen.md/restore`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ revision_number: 1 }),
		});
		expect(restore.status).toBe(409);

		// Restoring the doc unblocks writes again.
		await patchDoc('frozen.md', { archived: false });
		expect((await putDoc('frozen.md', 'v3')).status).toBe(200);
	});

	it('rejects PATCH with both or neither of status/archived', async () => {
		await putDoc('patch-shape.md', 'x');
		expect((await patchDoc('patch-shape.md', {})).status).toBe(400);
		expect((await patchDoc('patch-shape.md', { status: 'approved', archived: true })).status).toBe(
			400,
		);
	});

	it('forbids agents deleting docs; admin delete still works', async () => {
		await putDoc('deletable.md', 'x');
		const agentDelete = await app.request(`/api/projects/${projectId}/docs/deletable.md`, {
			method: 'DELETE',
			headers: authHeader(await agentToken()),
		});
		expect(agentDelete.status).toBe(403);

		const adminDelete = await app.request(`/api/projects/${projectId}/docs/deletable.md`, {
			method: 'DELETE',
			headers: authHeader(token),
		});
		expect(adminDelete.status).toBe(200);
		expect((await listDocs()).some((d) => d.filename === 'deletable.md')).toBe(false);
	});
});

describe('project doc archival — MCP', () => {
	it('archive/unarchive tools round-trip and are idempotent', async () => {
		const t = await agentToken();
		await callToolViaMcp(t, 'write_project_doc', {
			project: projectId,
			filename: 'mcp-doc.md',
			content: 'body',
		});

		const archived = await callToolViaMcp(t, 'archive_project_doc', {
			project: projectId,
			filename: 'mcp-doc.md',
		});
		expect(archived).toMatchObject({ archived: true, filename: 'mcp-doc.md', changed: true });

		const again = await callToolViaMcp(t, 'archive_project_doc', {
			project: projectId,
			filename: 'mcp-doc.md',
		});
		expect(again).toMatchObject({ archived: true, changed: false });

		const restored = await callToolViaMcp(t, 'unarchive_project_doc', {
			project: projectId,
			filename: 'mcp-doc.md',
		});
		expect(restored).toMatchObject({ archived: false, changed: true });
	});

	it('hides archived docs from list/read/write/status unless include_archived', async () => {
		const t = await agentToken();
		await callToolViaMcp(t, 'write_project_doc', {
			project: projectId,
			filename: 'mcp-hidden.md',
			content: 'secret history',
		});
		await callToolViaMcp(t, 'archive_project_doc', {
			project: projectId,
			filename: 'mcp-hidden.md',
		});

		const list = (await callToolViaMcp(t, 'list_project_docs', { project: projectId })) as {
			files: Array<{ filename: string }>;
		};
		expect(list.files.some((f) => f.filename === 'mcp-hidden.md')).toBe(false);

		const listArchived = (await callToolViaMcp(t, 'list_project_docs', {
			project: projectId,
			filter: 'archived',
		})) as { files: Array<{ filename: string; archived?: boolean }> };
		expect(listArchived.files.every((f) => f.archived === true)).toBe(true);
		expect(listArchived.files.some((f) => f.filename === 'mcp-hidden.md')).toBe(true);

		const listAll = (await callToolViaMcp(t, 'list_project_docs', {
			project: projectId,
			filter: 'all',
		})) as { files: Array<{ filename: string; archived?: boolean }> };
		const entry = listAll.files.find((f) => f.filename === 'mcp-hidden.md');
		expect(entry?.archived).toBe(true);

		const read = await callToolViaMcp(t, 'read_project_doc', {
			project: projectId,
			filename: 'mcp-hidden.md',
		});
		expect(String(read.error)).toContain('archived');

		const readArchived = await callToolViaMcp(t, 'read_project_doc', {
			project: projectId,
			filename: 'mcp-hidden.md',
			filter: 'archived',
		});
		expect(readArchived.content).toBe('secret history');
		expect(readArchived.archived).toBe(true);

		const write = await callToolViaMcp(t, 'write_project_doc', {
			project: projectId,
			filename: 'mcp-hidden.md',
			content: 'new body',
		});
		expect(String(write.error)).toContain('unarchive_project_doc');

		const status = await callToolViaMcp(t, 'set_project_doc_status', {
			project: projectId,
			filename: 'mcp-hidden.md',
			status: 'approved',
		});
		expect(String(status.error)).toContain('archived');
	});
});

describe('asset archival — REST', () => {
	it('archives and restores via PATCH; list carries archived_at', async () => {
		const a = await uploadAsset('rest-archive.txt');
		const res = await patchAsset(a.id, { archived: true });
		expect(res.status).toBe(200);
		expect((await res.json()).data.archived_at).not.toBeNull();

		const listed = (await listAssets()).find((x) => x.id === a.id);
		expect(listed?.archived_at).not.toBeNull();

		const restore = await patchAsset(a.id, { archived: false });
		expect((await restore.json()).data.archived_at).toBeNull();
	});

	it('keeps the original archival stamp on a repeated archive', async () => {
		const a = await uploadAsset('idempotent.txt');
		await patchAsset(a.id, { archived: true });
		const first = await db.query<{ archived_at: string }>(
			'SELECT archived_at FROM assets WHERE id = $1',
			[a.id],
		);
		await patchAsset(a.id, { archived: true });
		const second = await db.query<{ archived_at: string }>(
			'SELECT archived_at FROM assets WHERE id = $1',
			[a.id],
		);
		expect(second.rows[0].archived_at).toEqual(first.rows[0].archived_at);
	});

	it('rejects PATCH bodies with both or neither of folder/archived', async () => {
		const a = await uploadAsset('patch-shape.txt');
		expect((await patchAsset(a.id, {})).status).toBe(400);
		expect((await patchAsset(a.id, { folder: 'x', archived: true })).status).toBe(400);
	});

	it('remains agent-forbidden on PATCH and DELETE', async () => {
		const a = await uploadAsset('agent-forbidden.txt');
		const t = await agentToken();
		expect((await patchAsset(a.id, { archived: true }, t)).status).toBe(403);
		const del = await app.request(`/api/projects/${projectId}/assets/${a.id}`, {
			method: 'DELETE',
			headers: authHeader(t),
		});
		expect(del.status).toBe(403);
	});

	it('auto-suffixes a new upload colliding with an archived asset (path stays reserved)', async () => {
		const a = await uploadAsset('reserved.txt');
		await patchAsset(a.id, { archived: true });
		const b = await uploadAsset('reserved.txt');
		expect(b.path).not.toBe('reserved.txt');
		expect(b.path).toMatch(/^reserved-[0-9a-f]+\.txt$/);
	});
});

describe('asset archival — MCP', () => {
	it('replaces request_asset_deletion with archive/unarchive tools', async () => {
		const names = await listToolNames(await agentToken());
		expect(names).not.toContain('request_asset_deletion');
		expect(names).toContain('archive_project_asset');
		expect(names).toContain('unarchive_project_asset');
		expect(names).toContain('archive_project_doc');
		expect(names).toContain('unarchive_project_doc');
	});

	it('archive/unarchive round-trips, is idempotent, and audits', async () => {
		const t = await agentToken();
		const write = await callToolViaMcp(t, 'write_project_asset', {
			project: projectId,
			filename: 'mcp-asset.txt',
			content: 'v1',
		});
		expect(write.written).toBe(true);

		const archived = await callToolViaMcp(t, 'archive_project_asset', {
			project: projectId,
			filename: 'mcp-asset.txt',
		});
		expect(archived).toMatchObject({
			archived: true,
			reference: 'assets/mcp-asset.txt',
			changed: true,
		});

		const again = await callToolViaMcp(t, 'archive_project_asset', {
			project: projectId,
			filename: 'mcp-asset.txt',
		});
		expect(again).toMatchObject({ archived: true, changed: false });

		// The audit observer writes via trackBackground — poll briefly.
		let audited = false;
		for (let i = 0; i < 40 && !audited; i++) {
			const r = await db.query(
				`SELECT 1 FROM audit_log
				 WHERE action = 'updated' AND entity_type = 'asset'
				   AND details->>'filename' = 'mcp-asset.txt' AND details->>'archived' = 'true'`,
			);
			audited = r.rows.length > 0;
			if (!audited) await new Promise((resolve) => setTimeout(resolve, 50));
		}
		expect(audited).toBe(true);

		const restored = await callToolViaMcp(t, 'unarchive_project_asset', {
			project: projectId,
			filename: 'mcp-asset.txt',
		});
		expect(restored).toMatchObject({ archived: false, changed: true });
	});

	it('hides archived assets from list/read/write/move/copy unless include_archived', async () => {
		const t = await agentToken();
		await callToolViaMcp(t, 'write_project_asset', {
			project: projectId,
			filename: 'mcp-frozen.txt',
			content: 'frozen content',
		});
		await callToolViaMcp(t, 'archive_project_asset', {
			project: projectId,
			filename: 'mcp-frozen.txt',
		});

		const list = (await callToolViaMcp(t, 'list_project_assets', { project: projectId })) as {
			files: Array<{ filename: string }>;
		};
		expect(list.files.some((f) => f.filename === 'mcp-frozen.txt')).toBe(false);

		const listArchived = (await callToolViaMcp(t, 'list_project_assets', {
			project: projectId,
			filter: 'archived',
		})) as { files: Array<{ filename: string; archived?: boolean }> };
		expect(listArchived.files.every((f) => f.archived === true)).toBe(true);
		expect(listArchived.files.some((f) => f.filename === 'mcp-frozen.txt')).toBe(true);

		const listAll = (await callToolViaMcp(t, 'list_project_assets', {
			project: projectId,
			filter: 'all',
		})) as { files: Array<{ filename: string; archived?: boolean }> };
		expect(listAll.files.find((f) => f.filename === 'mcp-frozen.txt')?.archived).toBe(true);

		const read = await callToolViaMcp(t, 'read_project_asset', {
			project: projectId,
			filename: 'mcp-frozen.txt',
		});
		expect(String(read.error)).toContain('archived');

		const readArchived = await callToolViaMcp(t, 'read_project_asset', {
			project: projectId,
			filename: 'mcp-frozen.txt',
			filter: 'all',
		});
		expect(readArchived.content).toBe('frozen content');
		expect(readArchived.archived).toBe(true);

		const write = await callToolViaMcp(t, 'write_project_asset', {
			project: projectId,
			filename: 'mcp-frozen.txt',
			content: 'overwrite attempt',
		});
		expect(String(write.error)).toContain('unarchive_project_asset');

		const move = await callToolViaMcp(t, 'move_project_asset', {
			project: projectId,
			from: 'mcp-frozen.txt',
			to: 'moved/mcp-frozen.txt',
		});
		expect(String(move.error)).toContain('archived');

		const copy = await callToolViaMcp(t, 'copy_project_asset', {
			project: projectId,
			from: 'mcp-frozen.txt',
			to: 'copies/mcp-frozen.txt',
		});
		expect(String(copy.error)).toContain('archived');
	});
});

describe('archived items leave discovery surfaces', () => {
	it('drops archived docs from full-text search', async () => {
		await putDoc('searchable.md', 'The zebrafish migration protocol');
		const before = await fullTextSearch(db, [teamId], 'zebrafish', { scope: 'project_docs' });
		expect(before.some((r) => r.docSlug === 'searchable.md')).toBe(true);

		await patchDoc('searchable.md', { archived: true });
		const after = await fullTextSearch(db, [teamId], 'zebrafish', { scope: 'project_docs' });
		expect(after.some((r) => r.docSlug === 'searchable.md')).toBe(false);
	});

	it('drops archived docs from mention suggestions but keeps them resolving', async () => {
		await putDoc('suggestable.md', 'body');
		await patchDoc('suggestable.md', { archived: true });

		const projectSlugRes = await db.query<{ slug: string }>(
			'SELECT slug FROM projects WHERE id = $1',
			[projectId],
		);
		const projectSlug = projectSlugRes.rows[0].slug;

		const search = await app.request(
			`/api/projects/${projectId}/mentions/search?kind=doc&q=suggestable&project_slug=${projectSlug}`,
			{ headers: authHeader(token) },
		);
		const suggestions = (await search.json()).data as Array<{ handle: string }>;
		expect(suggestions.some((s) => s.handle === 'suggestable.md')).toBe(false);

		// Existing references still resolve so old comments keep linking.
		const resolve = await app.request(`/api/projects/${projectId}/docs/resolve`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				project_docs: [{ project_slug: projectSlug, filename: 'suggestable.md' }],
			}),
		});
		const resolved = (await resolve.json()).data;
		expect(
			resolved.project_docs.some((d: { filename: string }) => d.filename === 'suggestable.md'),
		).toBe(true);
	});

	it('drops archived docs from the agent-run project docs manifest', async () => {
		await putDoc('in-context.md', 'context body');
		await putDoc('out-of-context.md', 'context body');
		await patchDoc('out-of-context.md', { archived: true });

		const manifest = await resolveSystemPrompt(db, '{{project_docs_context}}', {
			teamId,
			projectId,
		});
		expect(manifest).toContain('in-context.md');
		expect(manifest).not.toContain('out-of-context.md');
	});
});
