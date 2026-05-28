import type { PGlite } from '@electric-sql/pglite';
import { CommentContentType } from '@hezo/shared';
import type { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { MasterKeyManager } from '../src/crypto/master-key';
import type { Env } from '../src/lib/types';
import { safeClose } from './helpers';
import { authHeader, createTestApp, createTestProject, mintAgentToken } from './helpers/app';

let app: Hono<Env>;
let db: PGlite;
let token: string;
let masterKeyManager: MasterKeyManager;

let teamId: string;
let projectId: string;
let architectId: string;
let captainId: string;
let testAdminUserId: string;
let secondBoardUserId: string;
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
		 FROM board_mentions
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

async function boardComment(userToken: string, taskIdArg: string, text: string): Promise<string> {
	const res = await app.request(`/api/teams/${teamId}/tasks/${taskIdArg}/comments`, {
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

async function addBoardUser(displayName: string): Promise<string> {
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
	await db.query(`INSERT INTO member_users (id, user_id, role) VALUES ($1, $2, 'board')`, [
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
			name: 'Board Mentions Co',
			template_id: typeId,
		}),
	});
	teamId = (await teamRes.json()).data.id;

	const agentsRes = await app.request(`/api/teams/${teamId}/agents`, {
		headers: authHeader(token),
	});
	const agents = (await agentsRes.json()).data as Array<{ id: string; slug: string }>;
	architectId = agents.find((a) => a.slug === 'architect')!.id;
	captainId = agents.find((a) => a.slug === 'captain')!.id;

	const projectRes = await createTestProject(db, teamId, {
		name: 'Board Test Project',
		description: 'x',
	});
	projectId = (await projectRes.json()).data.id;

	secondBoardUserId = await addBoardUser('Second Board User');
	nonBoardUserId = await addNonBoardUser('Plain Member');
});

afterAll(async () => {
	await safeClose(db);
});

beforeEach(async () => {
	await db.query('DELETE FROM board_mentions');
});

describe('@board fan-out via MCP create_comment', () => {
	it('lands one row per team board user when an agent writes @board', async () => {
		const taskIdLocal = await insertTask(captainId, 'A board-decision ticket');
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
			'@board — should we ship the new auth flow before review?',
		);

		const rows = await mentionsForComment(commentId);
		const userIds = rows.map((r) => r.user_id).sort();
		expect(userIds).toEqual([testAdminUserId, secondBoardUserId].sort());
		expect(rows.every((r) => r.read_at === null)).toBe(true);
	});

	it('does not notify non-board members on the team', async () => {
		const taskIdLocal = await insertTask(captainId, 'Another board-decision ticket');
		const { token: agentToken } = await mintAgentToken(
			db,
			masterKeyManager,
			architectId,
			teamId,
			taskIdLocal,
		);
		const commentId = await mcpComment(agentToken, taskIdLocal, '@board — please confirm.');

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
		const commentId = await mcpComment(agentToken, taskIdLocal, '@board — confirm scope.');

		const rowsAfterFirst = await mentionsForComment(commentId);

		const { fireCommentWakeups } = await import('../src/services/comment-wakeups');
		await fireCommentWakeups({
			db,
			taskId: taskIdLocal,
			teamId,
			commentId,
			content: { text: '@board — confirm scope.' },
			contentType: CommentContentType.Text,
			authorMemberId: architectId,
			authorUserId: null,
		});

		const rowsAfterSecond = await mentionsForComment(commentId);
		expect(rowsAfterSecond.length).toBe(rowsAfterFirst.length);
	});

	it('does not notify a board user who authored the comment', async () => {
		const taskIdLocal = await insertTask(architectId, 'Board-authored comment');
		const commentId = await boardComment(
			token,
			taskIdLocal,
			'@board — note for our future selves.',
		);

		const rows = await mentionsForComment(commentId);
		expect(rows.some((r) => r.user_id === testAdminUserId)).toBe(false);
		// The other board user (not the author) should still get notified.
		expect(rows.some((r) => r.user_id === secondBoardUserId)).toBe(true);
	});

	it('does not fan out on the passive @@board form', async () => {
		const taskIdLocal = await insertTask(captainId, 'Passive board reference');
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
			'Board approved on previous task — @@board.',
		);

		const rows = await mentionsForComment(commentId);
		expect(rows.length).toBe(0);
	});
});

describe('GET /teams/:teamId/inbox/mentions', () => {
	it('returns the caller-scoped unread mentions only', async () => {
		const taskIdLocal = await insertTask(captainId, 'Inbox listing test');
		const { token: agentToken } = await mintAgentToken(
			db,
			masterKeyManager,
			architectId,
			teamId,
			taskIdLocal,
		);
		await mcpComment(agentToken, taskIdLocal, '@board please weigh in here.');

		const res = await app.request(`/api/teams/${teamId}/inbox/mentions`, {
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

	it('omits read mentions by default but includes them with include_read=true', async () => {
		const taskIdLocal = await insertTask(captainId, 'Read filter test');
		const { token: agentToken } = await mintAgentToken(
			db,
			masterKeyManager,
			architectId,
			teamId,
			taskIdLocal,
		);
		const commentId = await mcpComment(agentToken, taskIdLocal, '@board check this.');

		await db.query(
			`UPDATE board_mentions SET read_at = now() WHERE comment_id = $1 AND user_id = $2`,
			[commentId, testAdminUserId],
		);

		const unreadOnly = await app.request(`/api/teams/${teamId}/inbox/mentions`, {
			headers: authHeader(token),
		});
		const unread = (await unreadOnly.json()).data as Array<{ comment_id: string }>;
		expect(unread.some((m) => m.comment_id === commentId)).toBe(false);

		const withRead = await app.request(`/api/teams/${teamId}/inbox/mentions?include_read=true`, {
			headers: authHeader(token),
		});
		const all = (await withRead.json()).data as Array<{ comment_id: string }>;
		expect(all.some((m) => m.comment_id === commentId)).toBe(true);
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
		const commentId = await mcpComment(agentToken, taskIdLocal, '@board please confirm.');

		const mineRow = await db.query<{ id: string }>(
			`SELECT id FROM board_mentions WHERE comment_id = $1 AND user_id = $2`,
			[commentId, testAdminUserId],
		);
		const mentionId = mineRow.rows[0].id;

		const res = await app.request(`/api/teams/${teamId}/inbox/mentions/${mentionId}/read`, {
			method: 'POST',
			headers: authHeader(token),
		});
		expect(res.status).toBe(200);

		const after = await db.query<{ read_at: string | null }>(
			`SELECT read_at FROM board_mentions WHERE id = $1`,
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
		const commentId = await mcpComment(agentToken, taskIdLocal, '@board please confirm.');

		const otherRow = await db.query<{ id: string }>(
			`SELECT id FROM board_mentions WHERE comment_id = $1 AND user_id = $2`,
			[commentId, secondBoardUserId],
		);
		const otherMentionId = otherRow.rows[0].id;

		const res = await app.request(`/api/teams/${teamId}/inbox/mentions/${otherMentionId}/read`, {
			method: 'POST',
			headers: authHeader(token),
		});
		expect(res.status).toBe(404);
	});
});

describe('reserved agent slug "board"', () => {
	it('rejects an attempt to create an agent named "Board"', async () => {
		const res = await app.request(`/api/teams/${teamId}/agents`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ title: 'Board' }),
		});
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error?: { code: string; message: string } };
		expect(body.error?.code).toBe('INVALID_REQUEST');
		expect(body.error?.message).toMatch(/reserved/i);
	});

	it('accepts a similar but non-clashing title like "Board Member"', async () => {
		const res = await app.request(`/api/teams/${teamId}/agents`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ title: 'Board Member' }),
		});
		expect(res.status).toBe(201);
		const body = (await res.json()) as { data: { slug: string } };
		expect(body.data.slug).toBe('board-member');
	});
});
