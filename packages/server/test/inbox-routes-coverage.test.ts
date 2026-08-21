import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { signAgentJwt } from '../src/middleware/auth';
import { authHeader, createAgentRun, createTestTeam, projectSlugFor } from './helpers/app';
import { createTestContext, destroyTestContext, type ServerTestContext } from './helpers/context';

/**
 * Coverage suite for packages/server/src/routes/inbox.ts: the admin-only
 * guard on every endpoint, the mention listing (snippet building/truncation,
 * archived filter), the unread count (mentions + pending approvals), and the
 * read / read-all state transitions.
 */

let ctx: ServerTestContext;
let teamId: string;
let projectSlug: string;
let projectId: string;
let adminUserId: string;
let captainId: string;
let taskId: string;
let agentToken: string;

const LONG_TEXT = `mention ${'x'.repeat(300)}`;

async function insertComment(text: unknown): Promise<string> {
	const content = typeof text === 'string' ? JSON.stringify({ text }) : JSON.stringify(text ?? {});
	const res = await ctx.db.query<{ id: string }>(
		`INSERT INTO task_comments (task_id, author_member_id, content_type, content)
		 VALUES ($1, $2, 'text'::comment_content_type, $3::jsonb) RETURNING id`,
		[taskId, captainId, content],
	);
	return res.rows[0].id;
}

async function insertMention(
	commentId: string,
	opts: { archived?: boolean; read?: boolean } = {},
): Promise<string> {
	const res = await ctx.db.query<{ id: string }>(
		`INSERT INTO admin_mentions (team_id, task_id, comment_id, user_id, read_at, archived_at)
		 VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
		[
			teamId,
			taskId,
			commentId,
			adminUserId,
			opts.read ? new Date().toISOString() : null,
			opts.archived ? new Date().toISOString() : null,
		],
	);
	return res.rows[0].id;
}

beforeAll(async () => {
	ctx = await createTestContext();

	const teamRes = await createTestTeam(ctx.db, { name: 'Inbox Coverage Co' });
	teamId = (await teamRes.json()).data.id;
	projectSlug = await projectSlugFor(ctx.db, teamId);
	const projectRow = await ctx.db.query<{ id: string }>('SELECT id FROM projects WHERE slug = $1', [
		projectSlug,
	]);
	projectId = projectRow.rows[0].id;

	const admin = await ctx.db.query<{ id: string }>(
		'SELECT id FROM users WHERE is_superuser = true ORDER BY created_at LIMIT 1',
	);
	adminUserId = admin.rows[0].id;

	const captain = await ctx.db.query<{ id: string }>(
		`SELECT ma.id FROM member_agents ma JOIN members m ON m.id = ma.id
		 WHERE m.team_id = $1 AND ma.slug = 'captain'`,
		[teamId],
	);
	captainId = captain.rows[0].id;

	const meta = await ctx.db.query<{ task_prefix: string; number: number }>(
		`SELECT p.task_prefix, next_project_task_number(p.id) AS number
		 FROM projects p WHERE p.id = $1`,
		[projectId],
	);
	const task = await ctx.db.query<{ id: string }>(
		`INSERT INTO tasks (team_id, project_id, number, identifier, title, status, priority, labels)
		 VALUES ($1, $2, $3, $4, 'Inbox target task', 'backlog'::task_status, 'medium'::task_priority, '[]'::jsonb)
		 RETURNING id`,
		[teamId, projectId, meta.rows[0].number, `${meta.rows[0].task_prefix}-${meta.rows[0].number}`],
	);
	taskId = task.rows[0].id;

	const runId = await createAgentRun(ctx.db, captainId, teamId);
	agentToken = await signAgentJwt(ctx.masterKeyManager, captainId, teamId, runId, projectId, false);
});

afterAll(async () => {
	await destroyTestContext(ctx);
});

describe('admin-only guard', () => {
	it('rejects agent JWTs on every inbox endpoint with 403', async () => {
		const requests: Array<[string, string]> = [
			['GET', `/api/projects/${projectSlug}/inbox/mentions`],
			['GET', `/api/projects/${projectSlug}/inbox/count`],
			[
				'POST',
				`/api/projects/${projectSlug}/inbox/mentions/00000000-0000-4000-8000-000000000000/read`,
			],
			['POST', `/api/projects/${projectSlug}/inbox/mentions/read-all`],
		];
		for (const [method, path] of requests) {
			const res = await ctx.app.request(path, { method, headers: authHeader(agentToken) });
			expect(res.status).toBe(403);
			expect((await res.json()).error.code).toBe('FORBIDDEN');
		}
	});
});

describe('GET /inbox/mentions', () => {
	it('lists unarchived mentions with author metadata and truncated snippets', async () => {
		const longComment = await insertComment(LONG_TEXT);
		const shortComment = await insertComment('short mention text');
		const noTextComment = await insertComment({ not_text: true });
		await insertMention(longComment);
		await insertMention(shortComment);
		await insertMention(noTextComment);

		const res = await ctx.app.request(`/api/projects/${projectSlug}/inbox/mentions`, {
			headers: authHeader(ctx.token),
		});
		expect(res.status).toBe(200);
		const mentions = (await res.json()).data as Array<Record<string, unknown>>;
		expect(mentions).toHaveLength(3);

		const long = mentions.find((m) => (m.snippet as string).startsWith('mention'));
		expect(long).toBeDefined();
		expect((long!.snippet as string).length).toBeLessThanOrEqual(180);
		expect(long!.snippet as string).toMatch(/…$/);
		expect(long!.task_title).toBe('Inbox target task');
		expect(long!.project_slug).toBe(projectSlug);
		expect(long!.author_display_name).toBe('Captain');
		expect(long!.author_slug).toBe('captain');
		expect(long!.read_at).toBeNull();

		const short = mentions.find((m) => m.snippet === 'short mention text');
		expect(short).toBeDefined();

		// Content without a text field falls back to an empty snippet.
		const empty = mentions.find((m) => m.snippet === '');
		expect(empty).toBeDefined();
	});

	it('strips markdown so the snippet reads as prose, not source', async () => {
		const markdownComment = await insertComment(
			'**Captain review: PASS.**\n\nThe submission satisfies:\n\n- ZNTL uses the [Aug 17 offering](/x)\n- `verify_totals` passes',
		);
		await insertMention(markdownComment);

		const res = await ctx.app.request(`/api/projects/${projectSlug}/inbox/mentions`, {
			headers: authHeader(ctx.token),
		});
		const mentions = (await res.json()).data as Array<Record<string, unknown>>;
		const row = mentions.find((m) => (m.snippet as string).startsWith('Captain review'));
		expect(row?.snippet).toBe(
			'Captain review: PASS. The submission satisfies: • ZNTL uses the Aug 17 offering • verify_totals passes',
		);
	});

	it('archived=true returns only archived mentions', async () => {
		const archivedComment = await insertComment('archived mention');
		await insertMention(archivedComment, { archived: true });

		const res = await ctx.app.request(`/api/projects/${projectSlug}/inbox/mentions?archived=true`, {
			headers: authHeader(ctx.token),
		});
		expect(res.status).toBe(200);
		const mentions = (await res.json()).data as Array<Record<string, unknown>>;
		expect(mentions).toHaveLength(1);
		expect(mentions[0].snippet).toBe('archived mention');
	});
});

describe('GET /inbox/count', () => {
	it('counts unread mentions plus pending approvals, excluding archived', async () => {
		const before = await ctx.app.request(`/api/projects/${projectSlug}/inbox/count`, {
			headers: authHeader(ctx.token),
		});
		expect(before.status).toBe(200);
		const baseline = (await before.json()).data.unread as number;

		// One read mention (not counted), one pending approval (counted).
		const readComment = await insertComment('already read');
		await insertMention(readComment, { read: true });
		await ctx.db.query(
			`INSERT INTO approvals (team_id, type, status, payload)
			 VALUES ($1, 'hire'::approval_type, 'pending'::approval_status, '{}'::jsonb)`,
			[teamId],
		);

		const after = await ctx.app.request(`/api/projects/${projectSlug}/inbox/count`, {
			headers: authHeader(ctx.token),
		});
		expect((await after.json()).data.unread).toBe(baseline + 1);
	});
});

describe('POST /inbox/mentions/:mentionId/read', () => {
	it('404s for an unknown mention', async () => {
		const res = await ctx.app.request(
			`/api/projects/${projectSlug}/inbox/mentions/00000000-0000-4000-8000-000000000000/read`,
			{ method: 'POST', headers: authHeader(ctx.token) },
		);
		expect(res.status).toBe(404);
	});

	it('marks a mention read and keeps the original timestamp on repeat', async () => {
		const comment = await insertComment('to be read');
		const mentionId = await insertMention(comment);

		const res = await ctx.app.request(
			`/api/projects/${projectSlug}/inbox/mentions/${mentionId}/read`,
			{ method: 'POST', headers: authHeader(ctx.token) },
		);
		expect(res.status).toBe(200);
		const first = (await res.json()).data;
		expect(first.id).toBe(mentionId);
		expect(first.read_at).not.toBeNull();

		// COALESCE keeps the first read_at on a second call.
		const again = await ctx.app.request(
			`/api/projects/${projectSlug}/inbox/mentions/${mentionId}/read`,
			{ method: 'POST', headers: authHeader(ctx.token) },
		);
		expect(again.status).toBe(200);
		expect((await again.json()).data.read_at).toBe(first.read_at);
	});
});

describe('POST /inbox/mentions/read-all', () => {
	it('marks every unread mention read and reports the count', async () => {
		const unreadBefore = await ctx.db.query<{ c: number }>(
			`SELECT count(*)::int AS c FROM admin_mentions
			 WHERE team_id = $1 AND user_id = $2 AND read_at IS NULL`,
			[teamId, adminUserId],
		);
		expect(unreadBefore.rows[0].c).toBeGreaterThan(0);

		const res = await ctx.app.request(`/api/projects/${projectSlug}/inbox/mentions/read-all`, {
			method: 'POST',
			headers: authHeader(ctx.token),
		});
		expect(res.status).toBe(200);
		expect((await res.json()).data.marked_read).toBe(unreadBefore.rows[0].c);

		const unreadAfter = await ctx.db.query<{ c: number }>(
			`SELECT count(*)::int AS c FROM admin_mentions
			 WHERE team_id = $1 AND user_id = $2 AND read_at IS NULL`,
			[teamId, adminUserId],
		);
		expect(unreadAfter.rows[0].c).toBe(0);

		// A second call is a no-op.
		const again = await ctx.app.request(`/api/projects/${projectSlug}/inbox/mentions/read-all`, {
			method: 'POST',
			headers: authHeader(ctx.token),
		});
		expect((await again.json()).data.marked_read).toBe(0);
	});
});
