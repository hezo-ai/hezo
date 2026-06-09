import type { PGlite } from '@electric-sql/pglite';
import { CommentContentType } from '@hezo/shared';
import type { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { MasterKeyManager } from '../src/crypto/master-key';
import type { Env } from '../src/lib/types';
import { safeClose } from './helpers';
import {
	authHeader,
	createTestApp,
	createTestProject,
	mintAgentToken,
	projectSlugFor,
} from './helpers/app';

let app: Hono<Env>;
let db: PGlite;
let token: string;
let masterKeyManager: MasterKeyManager;

let teamId: string;
let projectId: string;
let projectSlug: string;
let architectId: string;
let captainId: string;
let testAdminUserId: string;
let secondAdminUserId: string;
let nonBoardUserId: string;

interface MentionRow {
	id: string;
	user_id: string;
	comment_id: string;
	read_at: string | null;
}

async function mentionsForComment(commentId: string): Promise<MentionRow[]> {
	const res = await db.query<MentionRow>(
		`SELECT id, user_id, comment_id, read_at
		 FROM admin_mentions
		 WHERE comment_id = $1
		 ORDER BY created_at ASC`,
		[commentId],
	);
	return res.rows;
}

async function insertTask(assigneeId: string, title: string): Promise<string> {
	const meta = await db.query<{ task_prefix: string; number: number }>(
		`SELECT p.task_prefix, next_project_task_number(p.id) AS number
		 FROM projects p WHERE p.id = $1`,
		[projectId],
	);
	const n = meta.rows[0].number;
	const res = await db.query<{ id: string }>(
		`INSERT INTO tasks (team_id, project_id, assignee_id, number, identifier, title, status, priority, labels)
		 VALUES ($1, $2, $3, $4, $5, $6, 'backlog'::task_status, 'medium'::task_priority, '[]'::jsonb)
		 RETURNING id`,
		[teamId, projectId, assigneeId, n, `${meta.rows[0].task_prefix}-${n}`, title],
	);
	return res.rows[0].id;
}

async function mcpComment(agentToken: string, taskIdArg: string, content: string): Promise<string> {
	const res = await app.request('/mcp', {
		method: 'POST',
		headers: { ...authHeader(agentToken), 'Content-Type': 'application/json' },
		body: JSON.stringify({
			jsonrpc: '2.0',
			method: 'tools/call',
			params: {
				name: 'create_comment',
				arguments: { team_id: teamId, task_id: taskIdArg, content },
			},
			id: 1,
		}),
	});
	expect(res.status).toBe(200);
	const body = (await res.json()) as {
		result: { content: Array<{ type: string; text: string }> };
	};
	const inserted = JSON.parse(body.result.content[0].text) as { id: string };
	return inserted.id;
}

async function adminComment(userToken: string, taskIdArg: string, text: string): Promise<string> {
	const res = await app.request(`/api/projects/${projectSlug}/tasks/${taskIdArg}/comments`, {
		method: 'POST',
		headers: { ...authHeader(userToken), 'Content-Type': 'application/json' },
		body: JSON.stringify({
			content_type: CommentContentType.Text,
			content: { text },
		}),
	});
	expect(res.status).toBe(201);
	return (await res.json()).data.id;
}

async function addAdminUser(displayName: string): Promise<string> {
	const userRes = await db.query<{ id: string }>(
		'INSERT INTO users (display_name) VALUES ($1) RETURNING id',
		[displayName],
	);
	const userId = userRes.rows[0].id;
	const memberRes = await db.query<{ id: string }>(
		`INSERT INTO members (team_id, member_type, display_name)
		 VALUES ($1, 'user', $2) RETURNING id`,
		[teamId, displayName],
	);
	await db.query(`INSERT INTO member_users (id, user_id, role) VALUES ($1, $2, 'admin')`, [
		memberRes.rows[0].id,
		userId,
	]);
	return userId;
}

async function addNonBoardUser(displayName: string): Promise<string> {
	const userRes = await db.query<{ id: string }>(
		'INSERT INTO users (display_name) VALUES ($1) RETURNING id',
		[displayName],
	);
	const userId = userRes.rows[0].id;
	const memberRes = await db.query<{ id: string }>(
		`INSERT INTO members (team_id, member_type, display_name)
		 VALUES ($1, 'user', $2) RETURNING id`,
		[teamId, displayName],
	);
	await db.query(`INSERT INTO member_users (id, user_id, role) VALUES ($1, $2, 'member')`, [
		memberRes.rows[0].id,
		userId,
	]);
	return userId;
}

beforeAll(async () => {
	const ctx = await createTestApp();
	app = ctx.app;
	db = ctx.db;
	token = ctx.token;
	masterKeyManager = ctx.masterKeyManager;

	const adminRow = await db.query<{ id: string }>(
		"SELECT id FROM users WHERE display_name = 'Test Admin'",
	);
	testAdminUserId = adminRow.rows[0].id;

	const typesRes = await app.request('/api/team-templates', { headers: authHeader(token) });
	const typeId = (await typesRes.json()).data.find(
		(t: Record<string, unknown>) => t.name === 'Startup',
	).id;

	const teamRes = await app.request('/api/teams', {
		method: 'POST',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify({
			name: 'Admin Mentions Co',
			template_id: typeId,
		}),
	});
	const teamData = (await teamRes.json()).data;
	teamId = teamData.id;

	projectSlug = await projectSlugFor(ctx.db, teamId);
	const agentsRes = await app.request(`/api/projects/${projectSlug}/agents`, {
		headers: authHeader(token),
	});
	const agents = (await agentsRes.json()).data as Array<{ id: string; slug: string }>;
	architectId = agents.find((a) => a.slug === 'architect')!.id;
	captainId = agents.find((a) => a.slug === 'captain')!.id;

	const projectRes = await createTestProject(db, teamId, {
		name: 'Admin Test Project',
		description: 'x',
	});
	const projectData = (await projectRes.json()).data;
	projectId = projectData.id;
	projectSlug = projectData.slug;

	secondAdminUserId = await addAdminUser('Second Admin User');
	nonBoardUserId = await addNonBoardUser('Plain Member');
});

afterAll(async () => {
	await safeClose(db);
});

beforeEach(async () => {
	await db.query('DELETE FROM admin_mentions');
});

describe('@admin fan-out via MCP create_comment', () => {
	it('lands one row per team the admin when an agent writes @admin', async () => {
		const taskIdLocal = await insertTask(captainId, 'A admin-decision ticket');
		const { token: agentToken } = await mintAgentToken(
			db,
			masterKeyManager,
			architectId,
			teamId,
			taskIdLocal,
		);
		const commentId = await mcpComment(
			agentToken,
			taskIdLocal,
			'@admin — should we ship the new auth flow before review?',
		);

		const rows = await mentionsForComment(commentId);
		const userIds = rows.map((r) => r.user_id).sort();
		expect(userIds).toEqual([testAdminUserId, secondAdminUserId].sort());
		expect(rows.every((r) => r.read_at === null)).toBe(true);
	});

	it('does not notify non-the admin on the team', async () => {
		const taskIdLocal = await insertTask(captainId, 'Another admin-decision ticket');
		const { token: agentToken } = await mintAgentToken(
			db,
			masterKeyManager,
			architectId,
			teamId,
			taskIdLocal,
		);
		const commentId = await mcpComment(agentToken, taskIdLocal, '@admin — please confirm.');

		const rows = await mentionsForComment(commentId);
		expect(rows.some((r) => r.user_id === nonBoardUserId)).toBe(false);
	});

	it('is idempotent under repeated fan-out attempts for the same comment', async () => {
		const taskIdLocal = await insertTask(captainId, 'Idempotency test ticket');
		const { token: agentToken } = await mintAgentToken(
			db,
			masterKeyManager,
			architectId,
			teamId,
			taskIdLocal,
		);
		const commentId = await mcpComment(agentToken, taskIdLocal, '@admin — confirm scope.');

		const rowsAfterFirst = await mentionsForComment(commentId);

		const { fireCommentWakeups } = await import('../src/services/comment-wakeups');
		await fireCommentWakeups({
			db,
			taskId: taskIdLocal,
			teamId,
			commentId,
			content: { text: '@admin — confirm scope.' },
			contentType: CommentContentType.Text,
			authorMemberId: architectId,
			authorUserId: null,
		});

		const rowsAfterSecond = await mentionsForComment(commentId);
		expect(rowsAfterSecond.length).toBe(rowsAfterFirst.length);
	});

	it('does not notify a the admin who authored the comment', async () => {
		const taskIdLocal = await insertTask(architectId, 'Admin-authored comment');
		const commentId = await adminComment(
			token,
			taskIdLocal,
			'@admin — note for our future selves.',
		);

		const rows = await mentionsForComment(commentId);
		expect(rows.some((r) => r.user_id === testAdminUserId)).toBe(false);
		// The other the admin (not the author) should still get notified.
		expect(rows.some((r) => r.user_id === secondAdminUserId)).toBe(true);
	});

	it('does not fan out on the passive @@admin form', async () => {
		const taskIdLocal = await insertTask(captainId, 'Passive admin reference');
		const { token: agentToken } = await mintAgentToken(
			db,
			masterKeyManager,
			architectId,
			teamId,
			taskIdLocal,
		);
		const commentId = await mcpComment(
			agentToken,
			taskIdLocal,
			'Admin approved on previous task — @@admin.',
		);

		const rows = await mentionsForComment(commentId);
		expect(rows.length).toBe(0);
	});
});

describe('GET /teams/:teamId/inbox/mentions', () => {
	it('returns the caller-scoped active mentions', async () => {
		const taskIdLocal = await insertTask(captainId, 'Inbox listing test');
		const { token: agentToken } = await mintAgentToken(
			db,
			masterKeyManager,
			architectId,
			teamId,
			taskIdLocal,
		);
		await mcpComment(agentToken, taskIdLocal, '@admin please weigh in here.');

		const res = await app.request(`/api/projects/${projectSlug}/inbox/mentions`, {
			headers: authHeader(token),
		});
		expect(res.status).toBe(200);
		const data = (await res.json()).data as Array<{
			task_id: string;
			snippet: string;
			read_at: string | null;
		}>;
		expect(data.length).toBeGreaterThan(0);
		expect(data[0].task_id).toBe(taskIdLocal);
		expect(data[0].snippet).toContain('please weigh in');
		expect(data[0].read_at).toBeNull();
	});

	it('returns active (non-archived) mentions by default; archived=true returns only archived', async () => {
		const taskIdLocal = await insertTask(captainId, 'Archive filter test');
		const { token: agentToken } = await mintAgentToken(
			db,
			masterKeyManager,
			architectId,
			teamId,
			taskIdLocal,
		);
		const readCommentId = await mcpComment(agentToken, taskIdLocal, '@admin read but active.');
		const archivedCommentId = await mcpComment(agentToken, taskIdLocal, '@admin archived already.');

		await db.query(
			`UPDATE admin_mentions SET read_at = now() WHERE comment_id = $1 AND user_id = $2`,
			[readCommentId, testAdminUserId],
		);
		await db.query(
			`UPDATE admin_mentions SET read_at = now(), archived_at = now()
			 WHERE comment_id = $1 AND user_id = $2`,
			[archivedCommentId, testAdminUserId],
		);

		const active = await app.request(`/api/projects/${projectSlug}/inbox/mentions`, {
			headers: authHeader(token),
		});
		const activeRows = (await active.json()).data as Array<{ comment_id: string }>;
		// A read-but-not-archived mention stays in the default view; archived is hidden.
		expect(activeRows.some((m) => m.comment_id === readCommentId)).toBe(true);
		expect(activeRows.some((m) => m.comment_id === archivedCommentId)).toBe(false);

		const archivedRes = await app.request(
			`/api/projects/${projectSlug}/inbox/mentions?archived=true`,
			{
				headers: authHeader(token),
			},
		);
		const archivedRows = (await archivedRes.json()).data as Array<{ comment_id: string }>;
		expect(archivedRows.some((m) => m.comment_id === archivedCommentId)).toBe(true);
		expect(archivedRows.some((m) => m.comment_id === readCommentId)).toBe(false);
	});
});

describe('GET /teams/:teamId/inbox/count', () => {
	it('counts the caller-unread mentions plus pending approvals', async () => {
		await db.query('DELETE FROM approvals WHERE team_id = $1', [teamId]);

		const taskIdLocal = await insertTask(captainId, 'Count test');
		const { token: agentToken } = await mintAgentToken(
			db,
			masterKeyManager,
			architectId,
			teamId,
			taskIdLocal,
		);
		await mcpComment(agentToken, taskIdLocal, '@admin first decision.');
		const readComment = await mcpComment(agentToken, taskIdLocal, '@admin second decision.');
		await db.query(
			`UPDATE admin_mentions SET read_at = now() WHERE comment_id = $1 AND user_id = $2`,
			[readComment, testAdminUserId],
		);

		await db.query(
			`INSERT INTO approvals (team_id, type, requested_by_member_id, payload, status)
			 VALUES ($1, 'strategy'::approval_type, $2, '{}'::jsonb, 'pending'::approval_status),
			        ($1, 'strategy'::approval_type, $2, '{}'::jsonb, 'approved'::approval_status)`,
			[teamId, architectId],
		);

		const res = await app.request(`/api/projects/${projectSlug}/inbox/count`, {
			headers: authHeader(token),
		});
		expect(res.status).toBe(200);
		const data = (await res.json()).data as { unread: number };
		// One unread mention (the read one is excluded) plus one pending approval.
		expect(data.unread).toBe(2);
	});

	it('rejects non-admin auth', async () => {
		const taskIdLocal = await insertTask(captainId, 'Count auth test');
		const { token: agentToken } = await mintAgentToken(
			db,
			masterKeyManager,
			architectId,
			teamId,
			taskIdLocal,
		);
		const res = await app.request(`/api/projects/${projectSlug}/inbox/count`, {
			headers: authHeader(agentToken),
		});
		expect(res.status).toBe(403);
	});

	it('excludes archived rows so the badge cannot exceed the default-tab list', async () => {
		await db.query('DELETE FROM approvals WHERE team_id = $1', [teamId]);

		const taskIdLocal = await insertTask(captainId, 'Archived-row count test');
		const { token: agentToken } = await mintAgentToken(
			db,
			masterKeyManager,
			architectId,
			teamId,
			taskIdLocal,
		);
		const liveCommentId = await mcpComment(agentToken, taskIdLocal, '@admin live ask.');
		const archivedUnreadCommentId = await mcpComment(
			agentToken,
			taskIdLocal,
			'@admin pre-archived ask.',
		);

		await db.query(
			`UPDATE admin_mentions SET archived_at = now()
			 WHERE comment_id = $1 AND user_id = $2`,
			[archivedUnreadCommentId, testAdminUserId],
		);

		await db.query(
			`INSERT INTO approvals (team_id, type, requested_by_member_id, payload, status, archived_at)
			 VALUES ($1, 'strategy'::approval_type, $2, '{}'::jsonb, 'pending'::approval_status, NULL),
			        ($1, 'strategy'::approval_type, $2, '{}'::jsonb, 'pending'::approval_status, now())`,
			[teamId, architectId],
		);

		const res = await app.request(`/api/projects/${projectSlug}/inbox/count`, {
			headers: authHeader(token),
		});
		expect(res.status).toBe(200);
		const { unread } = (await res.json()).data as { unread: number };
		// One live unread mention + one live pending approval. The archived unread
		// mention and the archived pending approval don't appear in the default-tab
		// list, so they must not inflate the badge either.
		expect(unread).toBe(2);
		// Confirm: the live items truly exist for the caller (sanity check).
		expect(liveCommentId).toBeTruthy();
	});
});

describe('POST /teams/:teamId/inbox/mentions/:mentionId/read', () => {
	it('marks the caller-owned mention as read', async () => {
		const taskIdLocal = await insertTask(captainId, 'Mark-as-read test');
		const { token: agentToken } = await mintAgentToken(
			db,
			masterKeyManager,
			architectId,
			teamId,
			taskIdLocal,
		);
		const commentId = await mcpComment(agentToken, taskIdLocal, '@admin please confirm.');

		const mineRow = await db.query<{ id: string }>(
			`SELECT id FROM admin_mentions WHERE comment_id = $1 AND user_id = $2`,
			[commentId, testAdminUserId],
		);
		const mentionId = mineRow.rows[0].id;

		const res = await app.request(`/api/projects/${projectSlug}/inbox/mentions/${mentionId}/read`, {
			method: 'POST',
			headers: authHeader(token),
		});
		expect(res.status).toBe(200);

		const after = await db.query<{ read_at: string | null }>(
			`SELECT read_at FROM admin_mentions WHERE id = $1`,
			[mentionId],
		);
		expect(after.rows[0].read_at).not.toBeNull();
	});

	it('returns 404 when marking a mention belonging to a different user', async () => {
		const taskIdLocal = await insertTask(captainId, 'Cross-user read test');
		const { token: agentToken } = await mintAgentToken(
			db,
			masterKeyManager,
			architectId,
			teamId,
			taskIdLocal,
		);
		const commentId = await mcpComment(agentToken, taskIdLocal, '@admin please confirm.');

		const otherRow = await db.query<{ id: string }>(
			`SELECT id FROM admin_mentions WHERE comment_id = $1 AND user_id = $2`,
			[commentId, secondAdminUserId],
		);
		const otherMentionId = otherRow.rows[0].id;

		const res = await app.request(
			`/api/projects/${projectSlug}/inbox/mentions/${otherMentionId}/read`,
			{
				method: 'POST',
				headers: authHeader(token),
			},
		);
		expect(res.status).toBe(404);
	});
});

describe('reserved agent slug "admin"', () => {
	it('rejects an attempt to create an agent named "Admin"', async () => {
		const res = await app.request(`/api/projects/${projectSlug}/agents`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ title: 'Admin' }),
		});
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error?: { code: string; message: string } };
		expect(body.error?.code).toBe('INVALID_REQUEST');
		expect(body.error?.message).toMatch(/reserved/i);
	});

	it('accepts a similar but non-clashing title like "Admin Member"', async () => {
		const res = await app.request(`/api/projects/${projectSlug}/agents`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ title: 'Admin Member' }),
		});
		expect(res.status).toBe(201);
		const body = (await res.json()) as { data: { slug: string } };
		expect(body.data.slug).toBe('admin-member');
	});
});

describe('archiveOldInboxItems sweep', () => {
	async function seedMention(readAtSql: string): Promise<string> {
		const taskIdLocal = await insertTask(captainId, `Sweep ${Math.random()}`);
		const comment = await db.query<{ id: string }>(
			`INSERT INTO task_comments (task_id, author_member_id, content_type, content)
			 VALUES ($1, $2, 'text'::comment_content_type, '{"text":"sweep"}'::jsonb)
			 RETURNING id`,
			[taskIdLocal, architectId],
		);
		const mention = await db.query<{ id: string }>(
			`INSERT INTO admin_mentions (team_id, task_id, comment_id, user_id, read_at)
			 VALUES ($1, $2, $3, $4, ${readAtSql})
			 RETURNING id`,
			[teamId, taskIdLocal, comment.rows[0].id, testAdminUserId],
		);
		return mention.rows[0].id;
	}

	async function seedApproval(status: string, resolvedAtSql: string): Promise<string> {
		const r = await db.query<{ id: string }>(
			`INSERT INTO approvals (team_id, type, requested_by_member_id, payload, status, resolved_at)
			 VALUES ($1, 'strategy'::approval_type, $2, '{}'::jsonb, $3::approval_status, ${resolvedAtSql})
			 RETURNING id`,
			[teamId, architectId, status],
		);
		return r.rows[0].id;
	}

	const mentionArchived = async (id: string) =>
		(
			await db.query<{ archived_at: string | null }>(
				'SELECT archived_at FROM admin_mentions WHERE id = $1',
				[id],
			)
		).rows[0].archived_at;
	const approvalArchived = async (id: string) =>
		(
			await db.query<{ archived_at: string | null }>(
				'SELECT archived_at FROM approvals WHERE id = $1',
				[id],
			)
		).rows[0].archived_at;

	it('archives only seen items past the retention window, and is idempotent', async () => {
		await db.query('DELETE FROM approvals WHERE team_id = $1', [teamId]);

		const oldMention = await seedMention(`now() - interval '40 days'`);
		const recentMention = await seedMention(`now() - interval '10 days'`);
		const unreadMention = await seedMention('NULL');
		const oldApproval = await seedApproval('approved', `now() - interval '40 days'`);
		const recentApproval = await seedApproval('denied', `now() - interval '10 days'`);
		const pendingApproval = await seedApproval('pending', 'NULL');

		const { archiveOldInboxItems } = await import('../src/services/inbox-archive');
		const archived = await archiveOldInboxItems(db, 30);
		expect(archived).toBe(2);

		expect(await mentionArchived(oldMention)).not.toBeNull();
		expect(await mentionArchived(recentMention)).toBeNull();
		expect(await mentionArchived(unreadMention)).toBeNull();
		expect(await approvalArchived(oldApproval)).not.toBeNull();
		expect(await approvalArchived(recentApproval)).toBeNull();
		expect(await approvalArchived(pendingApproval)).toBeNull();

		expect(await archiveOldInboxItems(db, 30)).toBe(0);
	});
});
