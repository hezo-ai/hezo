import type { PGlite } from '@electric-sql/pglite';
import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MasterKeyManager } from '../../crypto/master-key';
import type { Env } from '../../lib/types';
import { safeClose } from '../helpers';
import { authHeader, createTestApp, mintAgentToken } from '../helpers/app';

let app: Hono<Env>;
let db: PGlite;
let boardToken: string;
let masterKeyManager: MasterKeyManager;

let companyId: string;
let projectId: string;
let issueId: string;
let agentId: string;

let companyBId: string;
let agentBId: string;
let issueBId: string;

interface ToolResponse {
	comment_id?: string;
	notified?: number;
	error?: string;
}

async function callToolAsAgent(
	token: string,
	toolName: string,
	args: Record<string, unknown>,
): Promise<ToolResponse> {
	const res = await app.request('/mcp', {
		method: 'POST',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify({
			jsonrpc: '2.0',
			method: 'tools/call',
			params: { name: toolName, arguments: args },
			id: 1,
		}),
	});
	const body = (await res.json()) as {
		result: { content: Array<{ type: string; text: string }> };
	};
	return JSON.parse(body.result.content[0].text);
}

async function listNotifications(companyIdOrSlug: string): Promise<Array<Record<string, unknown>>> {
	const res = await app.request(`/api/companies/${companyIdOrSlug}/notifications`, {
		headers: authHeader(boardToken),
	});
	const body = (await res.json()) as { data: Array<Record<string, unknown>> };
	return body.data;
}

beforeAll(async () => {
	const ctx = await createTestApp();
	app = ctx.app;
	db = ctx.db;
	boardToken = ctx.token;
	masterKeyManager = ctx.masterKeyManager;

	const typesRes = await app.request('/api/company-types', { headers: authHeader(boardToken) });
	const typeId = (await typesRes.json()).data.find(
		(t: Record<string, unknown>) => t.name === 'Startup',
	).id;

	// Company A
	const companyRes = await app.request('/api/companies', {
		method: 'POST',
		headers: { ...authHeader(boardToken), 'Content-Type': 'application/json' },
		body: JSON.stringify({ name: 'Notify Co', template_id: typeId }),
	});
	companyId = (await companyRes.json()).data.id;

	const agentsRes = await app.request(`/api/companies/${companyId}/agents`, {
		headers: authHeader(boardToken),
	});
	agentId = (await agentsRes.json()).data[0].id;

	const projectRes = await app.request(`/api/companies/${companyId}/projects`, {
		method: 'POST',
		headers: { ...authHeader(boardToken), 'Content-Type': 'application/json' },
		body: JSON.stringify({ name: 'Test Project', description: 'Test project' }),
	});
	projectId = (await projectRes.json()).data.id;

	const issueRes = await app.request(`/api/companies/${companyId}/issues`, {
		method: 'POST',
		headers: { ...authHeader(boardToken), 'Content-Type': 'application/json' },
		body: JSON.stringify({
			project_id: projectId,
			title: 'Needs board sign-off',
			assignee_id: agentId,
		}),
	});
	issueId = (await issueRes.json()).data.id;

	// Company B (separate board membership)
	const companyBRes = await app.request('/api/companies', {
		method: 'POST',
		headers: { ...authHeader(boardToken), 'Content-Type': 'application/json' },
		body: JSON.stringify({ name: 'Notify Co B', template_id: typeId }),
	});
	companyBId = (await companyBRes.json()).data.id;

	const agentsBRes = await app.request(`/api/companies/${companyBId}/agents`, {
		headers: authHeader(boardToken),
	});
	agentBId = (await agentsBRes.json()).data[0].id;

	const projectBRes = await app.request(`/api/companies/${companyBId}/projects`, {
		method: 'POST',
		headers: { ...authHeader(boardToken), 'Content-Type': 'application/json' },
		body: JSON.stringify({ name: 'Test Project B', description: 'Test project' }),
	});
	const projectBId = (await projectBRes.json()).data.id;

	const issueBRes = await app.request(`/api/companies/${companyBId}/issues`, {
		method: 'POST',
		headers: { ...authHeader(boardToken), 'Content-Type': 'application/json' },
		body: JSON.stringify({ project_id: projectBId, title: 'B issue', assignee_id: agentBId }),
	});
	issueBId = (await issueBRes.json()).data.id;
});

afterAll(async () => {
	await safeClose(db);
});

describe('request_board_approval MCP tool', () => {
	it('fans out one notification per board member and posts a system comment', async () => {
		const before = await db.query<{ count: number }>(
			`SELECT COUNT(*)::int AS count FROM member_users mu
			   JOIN members m ON m.id = mu.id
			  WHERE m.company_id = $1 AND mu.role = 'board'`,
			[companyId],
		);
		const boardCount = before.rows[0].count;
		expect(boardCount).toBeGreaterThanOrEqual(1);

		const { token: agentToken } = await mintAgentToken(
			db,
			masterKeyManager,
			agentId,
			companyId,
			issueId,
		);

		const result = await callToolAsAgent(agentToken, 'request_board_approval', {
			company_id: companyId,
			issue_id: issueId,
			summary: 'PRD ready for sign-off — please review and approve.',
		});

		expect(result.error).toBeUndefined();
		expect(result.notified).toBe(boardCount);
		expect(result.comment_id).toBeTruthy();

		const notifications = await db.query<Record<string, unknown>>(
			`SELECT * FROM notifications WHERE company_id = $1 AND kind = 'board_approval_requested'`,
			[companyId],
		);
		expect(notifications.rows).toHaveLength(boardCount);
		for (const row of notifications.rows) {
			const payload = row.payload as Record<string, unknown>;
			expect(payload.issue_id).toBe(issueId);
			expect(payload.comment_id).toBe(result.comment_id);
			expect(payload.requested_by_member_id).toBe(agentId);
			expect(payload.summary).toContain('PRD ready');
			expect(row.read_at).toBeNull();
		}

		const comment = await db.query<Record<string, unknown>>(
			`SELECT * FROM issue_comments WHERE id = $1`,
			[result.comment_id],
		);
		expect(comment.rows[0].content_type).toBe('system');
		expect(comment.rows[0].author_member_id).toBe(agentId);
	});

	it('does not leak notifications to board members of a different company', async () => {
		const { token: agentToken } = await mintAgentToken(
			db,
			masterKeyManager,
			agentBId,
			companyBId,
			issueBId,
		);

		await callToolAsAgent(agentToken, 'request_board_approval', {
			company_id: companyBId,
			issue_id: issueBId,
			summary: 'Spec ready for sign-off in B',
		});

		const aRows = await db.query<{ count: number }>(
			`SELECT COUNT(*)::int AS count FROM notifications n
			   JOIN member_users mu ON mu.id = n.recipient_member_user_id
			   JOIN members m ON m.id = mu.id
			  WHERE n.company_id = $2 AND m.company_id = $1`,
			[companyId, companyBId],
		);
		expect(aRows.rows[0].count).toBe(0);
	});

	it('rejects an issue in a different company than the agent caller', async () => {
		const { token: agentToken } = await mintAgentToken(
			db,
			masterKeyManager,
			agentId,
			companyId,
			issueId,
		);

		const result = await callToolAsAgent(agentToken, 'request_board_approval', {
			company_id: companyId,
			issue_id: issueBId,
			summary: 'cross-company attempt',
		});
		expect(result.error).toBeTruthy();
	});
});

describe('notifications REST', () => {
	it('GET returns enriched notifications for the calling board member', async () => {
		const rows = await listNotifications(companyId);
		expect(rows.length).toBeGreaterThan(0);
		const first = rows[0] as Record<string, unknown>;
		expect(first.kind).toBe('board_approval_requested');
		expect(first.issue_identifier).toBeTruthy();
		expect(first.project_slug).toBeTruthy();
		expect(first.requester_name).toBeTruthy();
		expect(first.company_slug).toBeTruthy();
	});

	it('PATCH marks a notification read', async () => {
		const rows = await listNotifications(companyId);
		const target = rows.find((r) => r.read_at === null) as Record<string, unknown> | undefined;
		expect(target).toBeTruthy();

		const res = await app.request(`/api/companies/${companyId}/notifications/${target!.id}`, {
			method: 'PATCH',
			headers: { ...authHeader(boardToken), 'Content-Type': 'application/json' },
			body: JSON.stringify({ read: true }),
		});
		expect(res.status).toBe(200);

		const after = await db.query<{ read_at: string | null }>(
			`SELECT read_at FROM notifications WHERE id = $1`,
			[target!.id],
		);
		expect(after.rows[0].read_at).not.toBeNull();
	});

	it('PATCH refuses a notification belonging to a different user', async () => {
		const otherUser = await db.query<{ id: string }>(
			"INSERT INTO users (display_name, is_superuser) VALUES ('Other Board', false) RETURNING id",
		);
		const memberRow = await db.query<{ id: string }>(
			`INSERT INTO members (company_id, member_type, display_name) VALUES ($1, 'user', 'Other Board') RETURNING id`,
			[companyId],
		);
		await db.query(`INSERT INTO member_users (id, user_id, role) VALUES ($1, $2, 'board')`, [
			memberRow.rows[0].id,
			otherUser.rows[0].id,
		]);

		const orphan = await db.query<{ id: string }>(
			`INSERT INTO notifications (company_id, recipient_member_user_id, kind, payload)
			 VALUES ($1, $2, 'board_approval_requested', $3::jsonb) RETURNING id`,
			[
				companyId,
				memberRow.rows[0].id,
				JSON.stringify({
					issue_id: issueId,
					comment_id: '',
					requested_by_member_id: agentId,
					summary: 'orphan',
				}),
			],
		);

		const res = await app.request(
			`/api/companies/${companyId}/notifications/${orphan.rows[0].id}`,
			{
				method: 'PATCH',
				headers: { ...authHeader(boardToken), 'Content-Type': 'application/json' },
				body: JSON.stringify({ read: true }),
			},
		);
		expect(res.status).toBe(404);
	});

	it('mark-all-read clears every unread notification for the caller', async () => {
		await db.query(
			`UPDATE notifications SET read_at = NULL WHERE company_id = $1
			   AND recipient_member_user_id IN (
			     SELECT mu.id FROM member_users mu
			       JOIN members m ON m.id = mu.id
			      WHERE m.company_id = $1 AND mu.user_id = (SELECT id FROM users WHERE display_name = 'Test Admin' LIMIT 1)
			   )`,
			[companyId],
		);

		const res = await app.request(`/api/companies/${companyId}/notifications/mark-all-read`, {
			method: 'POST',
			headers: { ...authHeader(boardToken), 'Content-Type': 'application/json' },
			body: '{}',
		});
		expect(res.status).toBe(200);

		const remaining = await db.query<{ count: number }>(
			`SELECT COUNT(*)::int AS count FROM notifications n
			   JOIN member_users mu ON mu.id = n.recipient_member_user_id
			  WHERE n.company_id = $1
			    AND mu.user_id = (SELECT id FROM users WHERE display_name = 'Test Admin' LIMIT 1)
			    AND n.read_at IS NULL`,
			[companyId],
		);
		expect(remaining.rows[0].count).toBe(0);
	});
});
