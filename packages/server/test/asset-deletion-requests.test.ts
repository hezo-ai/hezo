import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { CommentContentType } from '@hezo/shared';
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
} from './helpers/app';

// The `request_asset_deletion` MCP tool was replaced by direct archival
// (archive_project_asset) — agents archive instead of requesting deletion.
// The resolve endpoint stays: instances upgraded mid-flight still hold
// pending approval cards that an admin must be able to approve or deny.
// These tests seed such legacy cards directly, exactly as the old tool
// wrote them.

let app: Hono<Env>;
let db: Db;
let token: string;
let masterKeyManager: MasterKeyManager;
let dataDir: string;
let teamId: string;
let projectId: string;
let taskId: string;
let agentId: string;
let adminUserId: string;

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

/** Seed a pending deletion-request card the way the retired MCP tool wrote it. */
async function seedDeletionRequest(
	assets: Array<{ id: string; path: string }>,
	reason = 'Superseded by newer versions',
): Promise<string> {
	const refs = assets.map((a) => `assets/${a.path}`).join(', ');
	const content = {
		assets,
		reason,
		text: `Requested deletion of ${assets.length} asset${assets.length === 1 ? '' : 's'}: ${refs} — ${reason}`,
	};
	const inserted = await db.query<{ id: string }>(
		`INSERT INTO task_comments (task_id, author_member_id, content_type, content)
		 VALUES ($1, $2, 'asset_deletion_request'::comment_content_type, $3::jsonb)
		 RETURNING id`,
		[taskId, agentId, JSON.stringify(content)],
	);
	const commentId = inserted.rows[0].id;
	await db.query(
		`INSERT INTO admin_mentions (team_id, task_id, comment_id, user_id)
		 VALUES ($1, $2, $3, $4)`,
		[teamId, taskId, commentId, adminUserId],
	);
	return commentId;
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

	const admin = await db.query<{ id: string }>('SELECT id FROM users ORDER BY created_at LIMIT 1');
	adminUserId = admin.rows[0].id;
});

afterAll(async () => {
	await safeClose(db);
});

describe('resolve-asset-deletion (legacy pending cards)', () => {
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

		const commentId = await seedDeletionRequest([
			a,
			{ id: attached.id, path: attached.original_filename },
		]);
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

		// An audit row landed for the deletion (background writer).
		expect(await waitForAuditRow('deleted', a.id)).toBe(true);
	});

	it('deny keeps everything and wakes the agent with the outcome', async () => {
		const a = await uploadAsset('spared.png');
		const commentId = await seedDeletionRequest([a]);
		const res = await resolveDeletion(commentId, false);
		expect(res.status).toBe(200);
		expect((await res.json()).data.status).toBe('denied');

		const row = await db.query('SELECT id FROM assets WHERE id = $1', [a.id]);
		expect(row.rows).toHaveLength(1);
		expect(existsSync(diskPath(a.id))).toBe(true);

		const updated = await db.query<{ chosen_option: { status: string } }>(
			'SELECT chosen_option FROM task_comments WHERE id = $1',
			[commentId],
		);
		expect(updated.rows[0].chosen_option.status).toBe('denied');

		// Coalesced onto the agent's queued wakeup — match by payload (see above).
		const wakeup = await db.query<{ payload: { status: string } }>(
			`SELECT payload FROM agent_wakeup_requests
			 WHERE member_id = $1 AND payload->>'comment_id' = $2
			 ORDER BY created_at DESC LIMIT 1`,
			[agentId, commentId],
		);
		expect(wakeup.rows).toHaveLength(1);
		expect(wakeup.rows[0].payload.status).toBe('denied');
	});

	it('rejects agents resolving requests (even their own)', async () => {
		const a = await uploadAsset('agent-hands-off.png');
		const commentId = await seedDeletionRequest([a]);
		const { token: agentJwt } = await mintAgentToken(db, masterKeyManager, agentId, teamId, taskId);
		const res = await resolveDeletion(commentId, true, agentJwt);
		expect(res.status).toBe(403);
		// Still pending — the admin can act later.
		const row = await db.query<{ chosen_option: unknown }>(
			'SELECT chosen_option FROM task_comments WHERE id = $1',
			[commentId],
		);
		expect(row.rows[0].chosen_option).toBeNull();
		await resolveDeletion(commentId, false);
	});

	it('400s on double-resolve and on non-deletion-request comments', async () => {
		const a = await uploadAsset('once-only.png');
		const commentId = await seedDeletionRequest([a]);
		await resolveDeletion(commentId, false);
		const again = await resolveDeletion(commentId, true);
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
		const commentId = await seedDeletionRequest([a, b]);

		// The admin deletes one directly before approving the request.
		await app.request(`/api/projects/${projectId}/assets/${a.id}`, {
			method: 'DELETE',
			headers: authHeader(token),
		});

		const res = await resolveDeletion(commentId, true);
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
