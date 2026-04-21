import type { PGlite } from '@electric-sql/pglite';
import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MasterKeyManager } from '../../crypto/master-key';
import type { Env } from '../../lib/types';
import { safeClose } from '../helpers';
import { authHeader, createTestApp, mintAgentToken } from '../helpers/app';

let app: Hono<Env>;
let db: PGlite;
let token: string;
let companyId: string;
let projectId: string;
let otherCompanyId: string;
let ceoMemberId: string;
let masterKeyManager: MasterKeyManager;

beforeAll(async () => {
	const ctx = await createTestApp();
	app = ctx.app;
	db = ctx.db;
	token = ctx.token;
	masterKeyManager = ctx.masterKeyManager;

	const companyRes = await app.request('/api/companies', {
		method: 'POST',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify({ name: 'Goal Test Co', issue_prefix: 'GTC' }),
	});
	companyId = (await companyRes.json()).data.id;

	const projectRes = await app.request(`/api/companies/${companyId}/projects`, {
		method: 'POST',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify({ name: 'Main', description: 'Primary workstream.' }),
	});
	projectId = (await projectRes.json()).data.id;

	const otherRes = await app.request('/api/companies', {
		method: 'POST',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify({ name: 'Other Co', issue_prefix: 'OCO' }),
	});
	otherCompanyId = (await otherRes.json()).data.id;

	const ceo = await db.query<{ id: string }>(
		`SELECT ma.id FROM member_agents ma JOIN members m ON m.id = ma.id
		 WHERE m.company_id = $1 AND ma.slug = 'ceo' LIMIT 1`,
		[companyId],
	);
	ceoMemberId = ceo.rows[0].id;
});

afterAll(async () => {
	await safeClose(db);
});

async function getOperationsProjectId(cid: string): Promise<string> {
	const r = await db.query<{ id: string }>(
		`SELECT id FROM projects WHERE company_id = $1 AND slug = 'operations'`,
		[cid],
	);
	return r.rows[0].id;
}

describe('goals CRUD', () => {
	it('creates a company-wide goal and opens a CEO ticket in Operations', async () => {
		const res = await app.request(`/api/companies/${companyId}/goals`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ title: 'Raise seed round', description: 'Close $2M seed by Q3.' }),
		});
		expect(res.status).toBe(201);
		const goal = (await res.json()).data;
		expect(goal.title).toBe('Raise seed round');
		expect(goal.project_id).toBeNull();
		expect(goal.status).toBe('active');

		const opsId = await getOperationsProjectId(companyId);
		const issueResult = await db.query<{
			assignee_id: string;
			project_id: string;
			status: string;
			priority: string;
			description: string;
			labels: string | string[];
		}>(
			'SELECT assignee_id, project_id, status, priority, description, labels FROM issues WHERE company_id = $1 AND description LIKE $2',
			[companyId, `%goal=${goal.id}%`],
		);
		expect(issueResult.rows.length).toBe(1);
		const issue = issueResult.rows[0];
		expect(issue.assignee_id).toBe(ceoMemberId);
		expect(issue.project_id).toBe(opsId);
		expect(issue.status).toBe('open');
		expect(issue.priority).toBe('medium');
		const labels = typeof issue.labels === 'string' ? JSON.parse(issue.labels) : issue.labels;
		expect(labels).toContain('goal-update');
	});

	it('creates a project-scoped goal and routes the CEO ticket into that project', async () => {
		const res = await app.request(`/api/companies/${companyId}/goals`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				title: 'Launch public v1',
				description: 'Ship the API to the public.',
				project_id: projectId,
			}),
		});
		expect(res.status).toBe(201);
		const goal = (await res.json()).data;
		expect(goal.project_id).toBe(projectId);

		const issueResult = await db.query<{ project_id: string }>(
			'SELECT project_id FROM issues WHERE company_id = $1 AND description LIKE $2',
			[companyId, `%goal=${goal.id}%`],
		);
		expect(issueResult.rows[0].project_id).toBe(projectId);
	});

	it('rejects a goal with project_id from another company', async () => {
		const otherProjRes = await app.request(`/api/companies/${otherCompanyId}/projects`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ name: 'Other Proj', description: 'Unrelated.' }),
		});
		const otherProjId = (await otherProjRes.json()).data.id;

		const res = await app.request(`/api/companies/${companyId}/goals`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ title: 'Invalid scope', project_id: otherProjId }),
		});
		expect(res.status).toBe(400);
	});

	it('rejects a missing title', async () => {
		const res = await app.request(`/api/companies/${companyId}/goals`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ description: 'no title' }),
		});
		expect(res.status).toBe(400);
	});

	it('forbids an agent from creating a goal', async () => {
		const agent = await mintAgentToken(db, masterKeyManager, ceoMemberId, companyId);
		const res = await app.request(`/api/companies/${companyId}/goals`, {
			method: 'POST',
			headers: { ...authHeader(agent.token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ title: 'Agent goal' }),
		});
		expect(res.status).toBe(403);
	});

	it('dedups update tickets: second update appends a comment to the open ticket', async () => {
		const createRes = await app.request(`/api/companies/${companyId}/goals`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ title: 'Dedup target', description: 'initial' }),
		});
		const goal = (await createRes.json()).data;

		const firstIssues = await db.query<{ id: string }>(
			'SELECT id FROM issues WHERE company_id = $1 AND description LIKE $2',
			[companyId, `%goal=${goal.id}%`],
		);
		expect(firstIssues.rows.length).toBe(1);
		const ticketId = firstIssues.rows[0].id;

		const patchRes = await app.request(`/api/companies/${companyId}/goals/${goal.id}`, {
			method: 'PATCH',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ description: 'updated body' }),
		});
		expect(patchRes.status).toBe(200);

		const issuesAfter = await db.query<{ id: string }>(
			'SELECT id FROM issues WHERE company_id = $1 AND description LIKE $2',
			[companyId, `%goal=${goal.id}%`],
		);
		expect(issuesAfter.rows.length).toBe(1);

		const commentsResult = await db.query<{ id: string }>(
			'SELECT id FROM issue_comments WHERE issue_id = $1',
			[ticketId],
		);
		expect(commentsResult.rows.length).toBeGreaterThanOrEqual(1);
	});

	it('status-only change does not open a ticket', async () => {
		const createRes = await app.request(`/api/companies/${companyId}/goals`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ title: 'Status-only target' }),
		});
		const goal = (await createRes.json()).data;

		const before = await db.query<{ n: number }>(
			`SELECT count(*)::int AS n FROM issues WHERE company_id = $1 AND description LIKE $2`,
			[companyId, `%goal=${goal.id}%`],
		);
		const beforeCount = before.rows[0].n;

		const patchRes = await app.request(`/api/companies/${companyId}/goals/${goal.id}`, {
			method: 'PATCH',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ status: 'achieved' }),
		});
		expect(patchRes.status).toBe(200);

		const after = await db.query<{ n: number }>(
			`SELECT count(*)::int AS n FROM issues WHERE company_id = $1 AND description LIKE $2`,
			[companyId, `%goal=${goal.id}%`],
		);
		expect(after.rows[0].n).toBe(beforeCount);
	});

	it('lists goals with project_name for project-scoped goals', async () => {
		const res = await app.request(`/api/companies/${companyId}/goals`, {
			headers: authHeader(token),
		});
		expect(res.status).toBe(200);
		const rows: Array<{ project_id: string | null; project_name: string | null; status: string }> =
			(await res.json()).data;
		const scoped = rows.find((g) => g.project_id === projectId);
		expect(scoped?.project_name).toBe('Main');
		const companyWide = rows.find((g) => g.project_id === null);
		expect(companyWide?.project_name).toBeNull();
	});

	it('archives a goal on DELETE', async () => {
		const createRes = await app.request(`/api/companies/${companyId}/goals`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ title: 'To archive' }),
		});
		const goal = (await createRes.json()).data;

		const delRes = await app.request(`/api/companies/${companyId}/goals/${goal.id}`, {
			method: 'DELETE',
			headers: authHeader(token),
		});
		expect(delRes.status).toBe(200);
		expect((await delRes.json()).data.status).toBe('archived');
	});
});
