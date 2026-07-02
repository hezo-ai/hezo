import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { PGlite } from '@electric-sql/pglite';
import { CommentContentType } from '@hezo/shared';
import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MasterKeyManager } from '../src/crypto/master-key';
import type { Env } from '../src/lib/types';
import { safeClose } from './helpers';
import {
	authHeader,
	createTestApp,
	createTestProject,
	createTestTeam,
	mintAgentToken,
} from './helpers/app';

let app: Hono<Env>;
let db: PGlite;
let token: string;
let masterKeyManager: MasterKeyManager;
let dataDir: string;
let teamId: string;
let projectId: string;
let taskId: string;
let agentId: string;

function buildPng(seed = 0): Uint8Array {
	const sig = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
	const extra = new Uint8Array(16);
	for (let i = 0; i < extra.length; i++) extra[i] = (i + seed) & 0xff;
	const out = new Uint8Array(sig.length + extra.length);
	out.set(sig, 0);
	out.set(extra, sig.length);
	return out;
}

async function uploadAsset(
	filename: string,
	folder?: string,
): Promise<{ id: string; path: string }> {
	const fd = new FormData();
	fd.set('file', new File([buildPng(filename.length)], filename, { type: 'image/png' }));
	if (folder) fd.set('folder', folder);
	const res = await app.request(`/api/projects/${projectId}/assets`, {
		method: 'POST',
		headers: { ...authHeader(token) },
		body: fd,
	});
	const body = await res.json();
	return { id: body.data.id, path: body.data.original_filename };
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

async function agentToken(): Promise<string> {
	const { token: t } = await mintAgentToken(db, masterKeyManager, agentId, teamId, taskId);
	return t;
}

async function requestDeletion(
	filenames: string[],
	reason = 'Superseded by newer versions',
): Promise<Record<string, unknown>> {
	return callToolViaMcp(await agentToken(), 'request_asset_deletion', {
		project: projectId,
		task_id: taskId,
		filenames,
		reason,
	});
}

async function resolveDeletion(
	commentId: string,
	approve: boolean,
	authToken = token,
): Promise<Response> {
	return app.request(
		`/api/projects/${projectId}/tasks/${taskId}/comments/${commentId}/resolve-asset-deletion`,
		{
			method: 'POST',
			headers: { ...authHeader(authToken), 'Content-Type': 'application/json' },
			body: JSON.stringify({ approve }),
		},
	);
}

function diskPath(assetId: string): string {
	return join(dataDir, 'teams', teamId, 'projects', projectId, 'assets', assetId);
}

/** The audit observer writes via trackBackground — poll briefly for the row. */
async function waitForAuditRow(action: string, entityId: string): Promise<boolean> {
	for (let i = 0; i < 40; i++) {
		const r = await db.query(
			`SELECT 1 FROM audit_log WHERE action = $1 AND entity_type = 'asset' AND entity_id = $2`,
			[action, entityId],
		);
		if (r.rows.length > 0) return true;
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	return false;
}

beforeAll(async () => {
	const ctx = await createTestApp();
	app = ctx.app;
	db = ctx.db;
	token = ctx.token;
	masterKeyManager = ctx.masterKeyManager;
	dataDir = ctx.dataDir;

	const teamRes = await createTestTeam(db, { name: 'Deletion Co' });
	teamId = (await teamRes.json()).data.id;

	const projectRes = await createTestProject(db, teamId, { name: 'Main', description: 'X.' });
	projectId = (await projectRes.json()).data.id;

	const agentRes = await app.request(`/api/projects/${projectId}/agents`, {
		method: 'POST',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify({ title: 'Cleanup Bot' }),
	});
	agentId = (await agentRes.json()).data.id;

	const taskRes = await app.request(`/api/projects/${projectId}/tasks`, {
		method: 'POST',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify({ project_id: projectId, title: 'Tidy assets', assignee_id: agentId }),
	});
	taskId = (await taskRes.json()).data.id;
});

afterAll(async () => {
	await safeClose(db);
});

describe('request_asset_deletion', () => {
	it('posts an approval card with an asset snapshot and raises the admin inbox', async () => {
		const a = await uploadAsset('old-draft.png', 'drafts');
		const b = await uploadAsset('old-logo.png');

		const before = await app.request(`/api/projects/${projectId}/inbox/count`, {
			headers: authHeader(token),
		});
		const beforeCount = (await before.json()).data.unread as number;

		const res = await requestDeletion([a.path, b.path], 'Stale drafts from the old brand');
		expect(res.status).toBe('pending');
		expect(res.reused).toBe(false);
		expect(res.assets).toEqual([`assets/${a.path}`, `assets/${b.path}`]);

		const comment = await db.query<{
			content_type: string;
			content: {
				assets: Array<{ id: string; path: string }>;
				reason: string;
				text: string;
			};
			chosen_option: unknown;
		}>('SELECT content_type, content, chosen_option FROM task_comments WHERE id = $1', [
			res.comment_id as string,
		]);
		expect(comment.rows).toHaveLength(1);
		expect(comment.rows[0].content_type).toBe(CommentContentType.AssetDeletionRequest);
		expect(comment.rows[0].chosen_option).toBeNull();
		expect(comment.rows[0].content.reason).toBe('Stale drafts from the old brand');
		expect(comment.rows[0].content.assets).toEqual([
			{ id: a.id, path: a.path },
			{ id: b.id, path: b.path },
		]);
		// The inbox snippet reads content.text.
		expect(comment.rows[0].content.text).toContain('assets/drafts/old-draft.png');

		// Admin mention rows exist for the comment and the badge rose.
		const mentions = await db.query('SELECT id FROM admin_mentions WHERE comment_id = $1', [
			res.comment_id as string,
		]);
		expect(mentions.rows.length).toBeGreaterThan(0);
		const after = await app.request(`/api/projects/${projectId}/inbox/count`, {
			headers: authHeader(token),
		});
		expect((await after.json()).data.unread).toBeGreaterThan(beforeCount);

		// Cleanup: deny so later tests start with no pending request for these ids.
		await resolveDeletion(res.comment_id as string, false);
	});

	it('is all-or-nothing: a missing path errors and posts nothing', async () => {
		const a = await uploadAsset('kept.png');
		const res = await requestDeletion([a.path, 'ghost/none.png']);
		expect(String(res.error)).toContain('assets/ghost/none.png');
		expect(String(res.error)).toContain('all-or-nothing');
		const comments = await db.query(
			`SELECT id FROM task_comments
			 WHERE task_id = $1 AND content_type = 'asset_deletion_request'::comment_content_type
			   AND chosen_option IS NULL`,
			[taskId],
		);
		expect(comments.rows).toHaveLength(0);
	});

	it('reuses an identical pending request instead of stacking cards', async () => {
		const a = await uploadAsset('dupe-me.png');
		const first = await requestDeletion([a.path]);
		expect(first.reused).toBe(false);
		const second = await requestDeletion([a.path]);
		expect(second.reused).toBe(true);
		expect(second.comment_id).toBe(first.comment_id);
		await resolveDeletion(first.comment_id as string, false);
	});
});

describe('resolve-asset-deletion', () => {
	it('approve deletes rows, attachments, and blobs; records outcome; wakes the agent', async () => {
		const a = await uploadAsset('doomed.png', 'trash');
		// Attach the asset to a comment so the cascade is exercised.
		const fd = new FormData();
		fd.set('file', new File([buildPng(77)], 'attached.png', { type: 'image/png' }));
		const attachRes = await app.request(`/api/projects/${projectId}/tasks/${taskId}/assets`, {
			method: 'POST',
			headers: { ...authHeader(token) },
			body: fd,
		});
		const attached = (await attachRes.json()).data;
		await app.request(`/api/projects/${projectId}/tasks/${taskId}/comments`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				content_type: 'text',
				content: { text: 'attaching for cascade test' },
				attachment_ids: [attached.id],
			}),
		});

		const req = await requestDeletion([a.path, attached.original_filename]);
		const commentId = req.comment_id as string;
		expect(existsSync(diskPath(a.id))).toBe(true);

		const res = await resolveDeletion(commentId, true);
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.data.status).toBe('approved');
		expect(body.data.deleted_asset_ids.sort()).toEqual([a.id, attached.id].sort());

		// Rows gone, attachment joins cascaded, blobs gone.
		const rows = await db.query('SELECT id FROM assets WHERE id = ANY($1::uuid[])', [
			[a.id, attached.id],
		]);
		expect(rows.rows).toHaveLength(0);
		const joins = await db.query('SELECT 1 FROM comment_attachments WHERE asset_id = $1', [
			attached.id,
		]);
		expect(joins.rows).toHaveLength(0);
		expect(existsSync(diskPath(a.id))).toBe(false);
		expect(existsSync(diskPath(attached.id))).toBe(false);

		// chosen_option records the approval; a system comment landed.
		const updated = await db.query<{
			chosen_option: { status: string; deleted_asset_ids: string[] };
		}>('SELECT chosen_option FROM task_comments WHERE id = $1', [commentId]);
		expect(updated.rows[0].chosen_option.status).toBe('approved');
		expect(updated.rows[0].chosen_option.deleted_asset_ids).toHaveLength(2);
		const system = await db.query<{ content: { text: string } }>(
			`SELECT content FROM task_comments
			 WHERE task_id = $1 AND content_type = 'system'::comment_content_type
			 ORDER BY created_at DESC LIMIT 1`,
			[taskId],
		);
		expect(system.rows[0].content.text).toContain('Asset deletion approved: 2 deleted');

		// The requesting agent is woken with the outcome. createWakeup coalesces
		// onto any still-queued wakeup for the same agent+task (e.g. the pending
		// assignment wakeup), so match on the merged payload, not the row source.
		const wakeup = await db.query<{ payload: { status: string } }>(
			`SELECT payload FROM agent_wakeup_requests
			 WHERE member_id = $1 AND payload->>'comment_id' = $2
			 ORDER BY created_at DESC LIMIT 1`,
			[agentId, commentId],
		);
		expect(wakeup.rows).toHaveLength(1);
		expect(wakeup.rows[0].payload.status).toBe('approved');

		// The request's inbox mentions were marked read.
		const unread = await db.query(
			'SELECT 1 FROM admin_mentions WHERE comment_id = $1 AND read_at IS NULL',
			[commentId],
		);
		expect(unread.rows).toHaveLength(0);

		// Audit rows landed for the request and the deletion (background writer).
		expect(await waitForAuditRow('requested', a.id)).toBe(true);
		expect(await waitForAuditRow('deleted', a.id)).toBe(true);
	});

	it('deny keeps everything and wakes the agent with the outcome', async () => {
		const a = await uploadAsset('spared.png');
		const req = await requestDeletion([a.path]);
		const res = await resolveDeletion(req.comment_id as string, false);
		expect(res.status).toBe(200);
		expect((await res.json()).data.status).toBe('denied');

		const row = await db.query('SELECT id FROM assets WHERE id = $1', [a.id]);
		expect(row.rows).toHaveLength(1);
		expect(existsSync(diskPath(a.id))).toBe(true);

		const updated = await db.query<{ chosen_option: { status: string } }>(
			'SELECT chosen_option FROM task_comments WHERE id = $1',
			[req.comment_id as string],
		);
		expect(updated.rows[0].chosen_option.status).toBe('denied');

		// Coalesced onto the agent's queued wakeup — match by payload (see above).
		const wakeup = await db.query<{ payload: { status: string } }>(
			`SELECT payload FROM agent_wakeup_requests
			 WHERE member_id = $1 AND payload->>'comment_id' = $2
			 ORDER BY created_at DESC LIMIT 1`,
			[agentId, req.comment_id as string],
		);
		expect(wakeup.rows).toHaveLength(1);
		expect(wakeup.rows[0].payload.status).toBe('denied');
	});

	it('rejects agents resolving requests (even their own)', async () => {
		const a = await uploadAsset('agent-hands-off.png');
		const req = await requestDeletion([a.path]);
		const res = await resolveDeletion(req.comment_id as string, true, await agentToken());
		expect(res.status).toBe(403);
		// Still pending — the admin can act later.
		const row = await db.query<{ chosen_option: unknown }>(
			'SELECT chosen_option FROM task_comments WHERE id = $1',
			[req.comment_id as string],
		);
		expect(row.rows[0].chosen_option).toBeNull();
		await resolveDeletion(req.comment_id as string, false);
	});

	it('400s on double-resolve and on non-deletion-request comments', async () => {
		const a = await uploadAsset('once-only.png');
		const req = await requestDeletion([a.path]);
		await resolveDeletion(req.comment_id as string, false);
		const again = await resolveDeletion(req.comment_id as string, true);
		expect(again.status).toBe(400);

		const text = await app.request(`/api/projects/${projectId}/tasks/${taskId}/comments`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ content_type: 'text', content: { text: 'not a request' } }),
		});
		const textId = (await text.json()).data.id;
		const wrongType = await resolveDeletion(textId, true);
		expect(wrongType.status).toBe(400);
	});

	it('approve after an asset was separately deleted removes the rest and reports the miss', async () => {
		const a = await uploadAsset('goes-first.png');
		const b = await uploadAsset('goes-second.png');
		const req = await requestDeletion([a.path, b.path]);

		// The admin deletes one directly before approving the request.
		await app.request(`/api/projects/${projectId}/assets/${a.id}`, {
			method: 'DELETE',
			headers: authHeader(token),
		});

		const res = await resolveDeletion(req.comment_id as string, true);
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.data.deleted_asset_ids).toEqual([b.id]);

		const system = await db.query<{ content: { text: string } }>(
			`SELECT content FROM task_comments
			 WHERE task_id = $1 AND content_type = 'system'::comment_content_type
			 ORDER BY created_at DESC LIMIT 1`,
			[taskId],
		);
		expect(system.rows[0].content.text).toContain('1 deleted');
		expect(system.rows[0].content.text).toContain('1 no longer existed');
	});
});
