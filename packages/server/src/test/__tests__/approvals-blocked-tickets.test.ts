import type { PGlite } from '@electric-sql/pglite';
import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Env } from '../../lib/types';
import { safeClose } from '../helpers';
import { authHeader, createTestApp } from '../helpers/app';

let app: Hono<Env>;
let db: PGlite;
let token: string;
let companyId: string;
let otherCompanyId: string;
let projectId: string;
let approvalId: string;
let issueAId: string;
let issueBId: string;
let agentAId: string;
let agentBId: string;
let commentAId: string;
let commentBId: string;

async function createAgent(name: string, slug: string): Promise<string> {
	const r = await app.request(`/api/companies/${companyId}/agents`, {
		method: 'POST',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify({ title: name, slug }),
	});
	return (await r.json()).data.id;
}

async function createIssue(title: string, assigneeId: string): Promise<string> {
	const r = await app.request(`/api/companies/${companyId}/issues`, {
		method: 'POST',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify({ project_id: projectId, title, assignee_id: assigneeId }),
	});
	return (await r.json()).data.id;
}

async function insertActionComment(issueId: string, approvalRef: string): Promise<string> {
	const r = await db.query<{ id: string }>(
		`INSERT INTO issue_comments (issue_id, content_type, content)
		 VALUES ($1, 'action'::comment_content_type, $2::jsonb)
		 RETURNING id`,
		[issueId, JSON.stringify({ kind: 'setup_repo', approval_id: approvalRef })],
	);
	return r.rows[0].id;
}

async function insertTextComment(issueId: string, text: string): Promise<void> {
	await db.query(
		`INSERT INTO issue_comments (issue_id, content_type, content, created_at)
		 VALUES ($1, 'text'::comment_content_type, $2::jsonb, now() - INTERVAL '1 minute')`,
		[issueId, JSON.stringify({ text })],
	);
}

beforeAll(async () => {
	const ctx = await createTestApp();
	app = ctx.app;
	db = ctx.db;
	token = ctx.token;

	const typesRes = await app.request('/api/company-types', { headers: authHeader(token) });
	const typeId = (await typesRes.json()).data.find(
		(t: { name: string }) => t.name === 'Startup',
	).id;

	const companyRes = await app.request('/api/companies', {
		method: 'POST',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify({ name: 'Blocked Co', template_id: typeId }),
	});
	companyId = (await companyRes.json()).data.id;

	const otherRes = await app.request('/api/companies', {
		method: 'POST',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify({ name: 'Other Co', template_id: typeId }),
	});
	otherCompanyId = (await otherRes.json()).data.id;

	const projectRes = await app.request(`/api/companies/${companyId}/projects`, {
		method: 'POST',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify({ name: 'Repo Ops', description: 'ops' }),
	});
	projectId = (await projectRes.json()).data.id;

	agentAId = await createAgent('Alice Agent', 'alice');
	agentBId = await createAgent('Bob Agent', 'bob');

	issueAId = await createIssue('Migrate to vNext', agentAId);
	issueBId = await createIssue('Add CI workflow', agentBId);

	const approval = await db.query<{ id: string }>(
		`INSERT INTO approvals (company_id, type, status, payload)
		 VALUES ($1, 'designated_repo_request'::approval_type, 'pending'::approval_status, $2::jsonb)
		 RETURNING id`,
		[
			companyId,
			JSON.stringify({
				platform: 'github',
				reason: 'designated_repo',
				project_id: projectId,
				issue_id: issueAId,
			}),
		],
	);
	approvalId = approval.rows[0].id;

	await insertTextComment(issueAId, 'I tried to push the new migration but there is no repo yet.');
	commentAId = await insertActionComment(issueAId, approvalId);
	commentBId = await insertActionComment(issueBId, approvalId);
});

afterAll(async () => {
	await safeClose(db);
});

describe('GET /api/companies/:companyId/approvals/:approvalId/blocked-tickets', () => {
	it('returns one row per pending setup_repo action comment, with agent and project info', async () => {
		const res = await app.request(
			`/api/companies/${companyId}/approvals/${approvalId}/blocked-tickets`,
			{ headers: authHeader(token) },
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			data: Array<{
				issue_id: string;
				identifier: string;
				title: string;
				project_slug: string;
				comment_id: string;
				agent_name: string | null;
				agent_slug: string | null;
				snippet: string;
			}>;
		};
		expect(body.data).toHaveLength(2);

		const byIssue = new Map(body.data.map((r) => [r.issue_id, r]));
		const a = byIssue.get(issueAId);
		const b = byIssue.get(issueBId);
		expect(a?.title).toBe('Migrate to vNext');
		expect(a?.agent_name).toBe('Alice Agent');
		expect(a?.agent_slug).toBe('alice-agent');
		expect(a?.project_slug).toBe('repo-ops');
		expect(a?.comment_id).toBe(commentAId);
		expect(a?.snippet).toContain('there is no repo yet');

		expect(b?.title).toBe('Add CI workflow');
		expect(b?.agent_name).toBe('Bob Agent');
		expect(b?.agent_slug).toBe('bob-agent');
		expect(b?.comment_id).toBe(commentBId);
		expect(b?.snippet).toBe('Needs a designated GitHub repo to start work');
	});

	it('skips comments whose chosen_option is set (i.e. resolved)', async () => {
		await db.query(`UPDATE issue_comments SET chosen_option = $1::jsonb WHERE id = $2`, [
			JSON.stringify({ status: 'complete' }),
			commentBId,
		]);

		const res = await app.request(
			`/api/companies/${companyId}/approvals/${approvalId}/blocked-tickets`,
			{ headers: authHeader(token) },
		);
		const body = (await res.json()) as { data: Array<{ issue_id: string }> };
		expect(body.data).toHaveLength(1);
		expect(body.data[0].issue_id).toBe(issueAId);

		await db.query(`UPDATE issue_comments SET chosen_option = NULL WHERE id = $1`, [commentBId]);
	});

	it('returns 404 if the approval does not belong to the company', async () => {
		const res = await app.request(
			`/api/companies/${otherCompanyId}/approvals/${approvalId}/blocked-tickets`,
			{ headers: authHeader(token) },
		);
		expect(res.status).toBe(404);
	});

	it('returns 400 for non-designated_repo_request approvals', async () => {
		const other = await db.query<{ id: string }>(
			`INSERT INTO approvals (company_id, type, status, payload)
			 VALUES ($1, 'hire'::approval_type, 'pending'::approval_status, $2::jsonb)
			 RETURNING id`,
			[companyId, JSON.stringify({ title: 'New Agent', slug: 'new-agent' })],
		);
		const res = await app.request(
			`/api/companies/${companyId}/approvals/${other.rows[0].id}/blocked-tickets`,
			{ headers: authHeader(token) },
		);
		expect(res.status).toBe(400);
	});
});
