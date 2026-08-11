/**
 * The dashboard's action-items widget links straight to the inbox, so it lists
 * and counts exactly the inbox's *unread* rows - never one the inbox cannot
 * show. This holds the endpoints together against drift:
 *
 *   GET /projects/:projectId/inbox/needs-you  (dashboard widget)
 *   GET /projects/:projectId/inbox/mentions + /approvals  (what the inbox lists)
 *   GET /projects/:projectId/inbox/count     (the sidebar/rail badge)
 *
 * The project is seeded with an @admin mention, a credential request and an
 * approval, plus rows the inbox's unread filter drops.
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
let credentialCommentId: string;

interface NeedsYouBody {
	items: Array<{
		kind: string;
		approval?: { id: string };
		mention?: {
			id: string;
			comment_public_id: string;
			content_type: string;
			credential_name: string | null;
		};
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

	// An unanswered credential request, raised into the inbox the way
	// request_credential does it.
	credentialCommentId = await seedComment(taskId, 'credential_request', {
		name: 'PARITY_API_KEY',
		kind: 'api_key',
		instructions: 'Need a key from the provider dashboard.',
	});
	await db.query(
		`INSERT INTO admin_mentions (team_id, task_id, comment_id, user_id) VALUES ($1, $2, $3, $4)`,
		[teamId, taskId, credentialCommentId, adminUserId],
	);

	// One already answered: no inbox row, so it reaches neither surface.
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

it('an unanswered credential request reaches both surfaces, carrying its secret name', async () => {
	const needsYou = await get<NeedsYouBody>('/inbox/needs-you');
	const mentions =
		await get<Array<{ content_type: string; credential_name: string | null; snippet: string }>>(
			'/inbox/mentions',
		);

	const inboxRow = mentions.find((m) => m.content_type === 'credential_request');
	expect(inboxRow?.credential_name).toBe('PARITY_API_KEY');
	// The instructions stand in for the snippet a text comment would have.
	expect(inboxRow?.snippet).toContain('Need a key');

	const dashboardRow = needsYou.items.find(
		(i) => i.mention?.content_type === 'credential_request',
	)?.mention;
	expect(dashboardRow?.credential_name).toBe('PARITY_API_KEY');

	// The answered one is on neither: nothing is being asked for.
	expect(JSON.stringify(mentions)).not.toContain('PARITY_DONE_KEY');
	expect(JSON.stringify(needsYou.items)).not.toContain('PARITY_DONE_KEY');
});

it('reading a credential request drops it from the dashboard but keeps it in the inbox', async () => {
	const before = await get<NeedsYouBody>('/inbox/needs-you');
	const row = before.items.find((i) => i.mention?.content_type === 'credential_request');
	expect(row).toBeDefined();

	const res = await app.request(
		`/api/projects/${projectSlug}/inbox/mentions/${row?.mention?.id}/read`,
		{ method: 'POST', headers: { ...authHeader(token), 'Content-Type': 'application/json' } },
	);
	expect(res.status).toBe(200);

	const after = await get<NeedsYouBody>('/inbox/needs-you');
	expect(after.items.some((i) => i.mention?.content_type === 'credential_request')).toBe(false);
	expect(after.action_count).toBe(before.action_count - 1);

	// Still in the inbox, now marked read - the request itself is untouched.
	const mentions =
		await get<Array<{ content_type: string; read_at: string | null; comment_id: string }>>(
			'/inbox/mentions',
		);
	const inboxRow = mentions.find((m) => m.comment_id === credentialCommentId);
	expect(inboxRow?.read_at).not.toBeNull();
	const stillPending = await db.query<{ count: number }>(
		`SELECT count(*)::int AS count FROM task_comments WHERE id = $1 AND chosen_option IS NULL`,
		[credentialCommentId],
	);
	expect(stillPending.rows[0].count).toBe(1);

	// And the count endpoints still agree with each other after the read.
	const count = await get<{ unread: number }>('/inbox/count');
	expect(after.action_count).toBe(count.unread);
});
