/**
 * The dashboard's action-items widget links straight to the inbox, so it must
 * not list or count a row the inbox cannot show. This holds the two endpoints
 * together against drift:
 *
 *   GET /projects/:projectId/inbox/needs-you  (dashboard widget)
 *   GET /projects/:projectId/inbox/mentions + /approvals  (what the inbox lists)
 *   GET /projects/:projectId/inbox/count     (the sidebar/rail badge)
 *
 * The project is seeded with every shape that has ever tempted an extra row -
 * a pending credential request above all - plus rows the inbox filters out.
 */
import { ApprovalStatus, ApprovalType, TaskStatus } from '@hezo/shared';
import type { Hono } from 'hono';
import { afterAll, beforeAll, expect, it } from 'vitest';
import type { Db } from '../src/db/database';
import type { Env } from '../src/lib/types';
import { safeClose } from './helpers';
import { authHeader, createTestApp, createTestProject, createTestTeam } from './helpers/app';

let app: Hono<Env>;
let db: Db;
let token: string;
let teamId: string;
let projectSlug: string;
let agentId: string;

interface NeedsYouBody {
	items: Array<{
		kind: string;
		approval?: { id: string };
		mention?: { id: string; comment_public_id: string };
	}>;
	action_count: number;
}

async function seedComment(taskId: string, contentType: string, content: object): Promise<string> {
	const res = await db.query<{ id: string }>(
		`INSERT INTO task_comments (task_id, author_member_id, content_type, content)
		 VALUES ($1, $2, $3::comment_content_type, $4::jsonb)
		 RETURNING id`,
		[taskId, agentId, contentType, JSON.stringify(content)],
	);
	return res.rows[0].id;
}

beforeAll(async () => {
	const ctx = await createTestApp();
	app = ctx.app;
	db = ctx.db;
	token = ctx.token;

	const teamRes = await createTestTeam(db, { name: 'Parity Co' });
	teamId = (await teamRes.json()).data.id;

	const projectRes = await createTestProject(db, teamId, { name: 'Parity Project' });
	const project = (await projectRes.json()).data;
	projectSlug = project.slug;

	const agentRes = await app.request(`/api/projects/${projectSlug}/agents`, {
		method: 'POST',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify({ title: 'Parity Runner' }),
	});
	agentId = (await agentRes.json()).data.id;

	const taskRes = await app.request(`/api/projects/${projectSlug}/tasks`, {
		method: 'POST',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify({ title: 'Parity work', assignee_id: agentId }),
	});
	const taskId = (await taskRes.json()).data.id;
	await db.query(`UPDATE tasks SET status = $1::task_status WHERE id = $2`, [
		TaskStatus.InProgress,
		taskId,
	]);

	const admin = await db.query<{ id: string }>(
		`SELECT id FROM users WHERE is_superuser = true ORDER BY created_at LIMIT 1`,
	);
	const adminUserId = admin.rows[0].id;

	// Pending approval + unread mention: in both surfaces.
	await db.query(
		`INSERT INTO approvals (team_id, type, requested_by_member_id, payload, status)
		 VALUES ($1, $2::approval_type, $3, $4::jsonb, $5::approval_status)`,
		[
			teamId,
			ApprovalType.Strategy,
			agentId,
			JSON.stringify({ action: 'update_prd', filename: 'prd.md' }),
			ApprovalStatus.Pending,
		],
	);
	const unreadComment = await seedComment(taskId, 'text', { text: '@admin sign this off' });
	await db.query(
		`INSERT INTO admin_mentions (team_id, task_id, comment_id, user_id) VALUES ($1, $2, $3, $4)`,
		[teamId, taskId, unreadComment, adminUserId],
	);

	// A read mention and a resolved approval: in neither surface's unread set.
	const readComment = await seedComment(taskId, 'text', { text: '@admin already handled' });
	await db.query(
		`INSERT INTO admin_mentions (team_id, task_id, comment_id, user_id, read_at)
		 VALUES ($1, $2, $3, $4, now())`,
		[teamId, taskId, readComment, adminUserId],
	);
	await db.query(
		`INSERT INTO approvals (team_id, type, requested_by_member_id, payload, status, resolved_at)
		 VALUES ($1, $2::approval_type, $3, '{}'::jsonb, $4::approval_status, now())`,
		[teamId, ApprovalType.Hire, agentId, ApprovalStatus.Approved],
	);

	// A credential request the admin never fulfilled, and one they did. The inbox
	// carries neither, so neither may reach the dashboard.
	await seedComment(taskId, 'credential_request', {
		name: 'PARITY_API_KEY',
		kind: 'api_key',
		instructions: 'Need a key.',
	});
	const fulfilled = await seedComment(taskId, 'credential_request', {
		name: 'PARITY_DONE_KEY',
		kind: 'api_key',
		instructions: 'Needed a key.',
	});
	await db.query(`UPDATE task_comments SET chosen_option = $1::jsonb WHERE id = $2`, [
		JSON.stringify({ provided: true }),
		fulfilled,
	]);
});

afterAll(async () => {
	await safeClose(db);
});

async function get<T>(path: string): Promise<T> {
	const res = await app.request(`/api/projects/${projectSlug}${path}`, {
		headers: authHeader(token),
	});
	expect(res.status).toBe(200);
	return (await res.json()).data as T;
}

it('every dashboard action item is a row the inbox also lists', async () => {
	const needsYou = await get<NeedsYouBody>('/inbox/needs-you');
	const mentions = await get<Array<{ id: string; read_at: string | null }>>('/inbox/mentions');
	const approvals = await get<Array<{ id: string; status: string }>>(
		'/approvals?status=pending&archived=false',
	);

	expect(needsYou.items.length).toBeGreaterThan(0);

	const inboxMentionIds = new Set(mentions.filter((m) => !m.read_at).map((m) => m.id));
	const inboxApprovalIds = new Set(approvals.map((a) => a.id));

	for (const item of needsYou.items) {
		if (item.kind === 'approval') {
			expect(inboxApprovalIds.has(item.approval?.id ?? '')).toBe(true);
		} else if (item.kind === 'mention') {
			expect(inboxMentionIds.has(item.mention?.id ?? '')).toBe(true);
		} else {
			throw new Error(`needs-you returned a '${item.kind}' item the inbox cannot render`);
		}
	}
});

it('the dashboard action count matches the inbox unread count', async () => {
	const needsYou = await get<NeedsYouBody>('/inbox/needs-you');
	const count = await get<{ unread: number }>('/inbox/count');
	const mentions = await get<Array<{ read_at: string | null }>>('/inbox/mentions');
	const approvals = await get<Array<{ id: string }>>('/approvals?status=pending&archived=false');

	const inboxUnread = mentions.filter((m) => !m.read_at).length + approvals.length;
	expect(needsYou.action_count).toBe(inboxUnread);
	expect(needsYou.action_count).toBe(count.unread);
});

it('an unfulfilled credential request reaches neither the inbox nor the dashboard', async () => {
	const needsYou = await get<NeedsYouBody>('/inbox/needs-you');
	const mentions = await get<unknown[]>('/inbox/mentions');

	expect(JSON.stringify(needsYou.items)).not.toContain('PARITY_API_KEY');
	expect(JSON.stringify(mentions)).not.toContain('PARITY_API_KEY');
	// It is still the admin's to answer - just from the task thread, where it was asked.
	const pending = await db.query<{ count: number }>(
		`SELECT count(*)::int AS count FROM task_comments
		 WHERE content_type = 'credential_request'::comment_content_type AND chosen_option IS NULL`,
	);
	expect(pending.rows[0].count).toBe(1);
});
