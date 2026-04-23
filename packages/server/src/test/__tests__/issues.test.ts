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
let masterKeyManager: MasterKeyManager;
let companyId: string;
let projectId: string;
let agentId: string;

beforeAll(async () => {
	const ctx = await createTestApp();
	app = ctx.app;
	db = ctx.db;
	token = ctx.token;
	masterKeyManager = ctx.masterKeyManager;

	const companyRes = await app.request('/api/companies', {
		method: 'POST',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify({ name: 'Issue Test Co' }),
	});
	companyId = (await companyRes.json()).data.id;

	const projectRes = await app.request(`/api/companies/${companyId}/projects`, {
		method: 'POST',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify({ name: 'Main Project', description: 'Test project.' }),
	});
	projectId = (await projectRes.json()).data.id;

	const agentRes = await app.request(`/api/companies/${companyId}/agents`, {
		method: 'POST',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify({ title: 'Test Agent' }),
	});
	agentId = (await agentRes.json()).data.id;
});

afterAll(async () => {
	await safeClose(db);
});

describe('issues CRUD', () => {
	it('creates an issue with auto-generated identifier', async () => {
		const res = await app.request(`/api/companies/${companyId}/issues`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				project_id: projectId,
				title: 'First issue',
				priority: 'high',
				assignee_id: agentId,
			}),
		});
		expect(res.status).toBe(201);
		const body = await res.json();
		expect(body.data.identifier).toMatch(/^MP-\d+$/);
		expect(body.data.number).toBeGreaterThanOrEqual(1);
		expect(body.data.status).toBe('backlog');
		expect(body.data.priority).toBe('high');
		expect(body.data.runtime_type).toBeNull();
	});

	it('accepts a runtime_type override on create and honors it on update', async () => {
		const createRes = await app.request(`/api/companies/${companyId}/issues`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				project_id: projectId,
				title: 'Codex-only task',
				assignee_id: agentId,
				runtime_type: 'codex',
			}),
		});
		expect(createRes.status).toBe(201);
		const created = (await createRes.json()).data;
		expect(created.runtime_type).toBe('codex');

		const patchRes = await app.request(`/api/companies/${companyId}/issues/${created.id}`, {
			method: 'PATCH',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ runtime_type: 'gemini' }),
		});
		expect(patchRes.status).toBe(200);
		expect((await patchRes.json()).data.runtime_type).toBe('gemini');
	});

	it('creates sequential issue numbers', async () => {
		const firstRes = await app.request(`/api/companies/${companyId}/issues`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				project_id: projectId,
				title: 'Sequential A',
				assignee_id: agentId,
			}),
		});
		expect(firstRes.status).toBe(201);
		const firstNum = (await firstRes.json()).data.number;

		const secondRes = await app.request(`/api/companies/${companyId}/issues`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				project_id: projectId,
				title: 'Sequential B',
				assignee_id: agentId,
			}),
		});
		expect(secondRes.status).toBe(201);
		const secondNum = (await secondRes.json()).data.number;
		expect(secondNum).toBe(firstNum + 1);
	});

	it('lists issues with pagination', async () => {
		const res = await app.request(`/api/companies/${companyId}/issues?per_page=1`, {
			headers: authHeader(token),
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.data).toHaveLength(1);
		expect(body.meta.total).toBeGreaterThanOrEqual(2);
		expect(body.meta.per_page).toBe(1);
	});

	it('filters issues by status', async () => {
		const res = await app.request(`/api/companies/${companyId}/issues?status=backlog`, {
			headers: authHeader(token),
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.data.every((i: any) => i.status === 'backlog')).toBe(true);
	});

	it('gets an issue by id with computed fields', async () => {
		const listRes = await app.request(`/api/companies/${companyId}/issues`, {
			headers: authHeader(token),
		});
		const issue = (await listRes.json()).data[0];

		const res = await app.request(`/api/companies/${companyId}/issues/${issue.id}`, {
			headers: authHeader(token),
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.data).toHaveProperty('project_name');
		expect(body.data).toHaveProperty('comment_count');
		expect(body.data).toHaveProperty('cost_cents');
	});

	it('resolves an issue by identifier (case-insensitive)', async () => {
		const listRes = await app.request(`/api/companies/${companyId}/issues`, {
			headers: authHeader(token),
		});
		const issue = (await listRes.json()).data[0];

		const upperRes = await app.request(`/api/companies/${companyId}/issues/${issue.identifier}`, {
			headers: authHeader(token),
		});
		expect(upperRes.status).toBe(200);
		expect((await upperRes.json()).data.id).toBe(issue.id);

		const lowerRes = await app.request(
			`/api/companies/${companyId}/issues/${issue.identifier.toLowerCase()}`,
			{ headers: authHeader(token) },
		);
		expect(lowerRes.status).toBe(200);
		expect((await lowerRes.json()).data.id).toBe(issue.id);
	});

	it('updates an issue status', async () => {
		const listRes = await app.request(`/api/companies/${companyId}/issues`, {
			headers: authHeader(token),
		});
		const issue = (await listRes.json()).data[0];

		const res = await app.request(`/api/companies/${companyId}/issues/${issue.id}`, {
			method: 'PATCH',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ status: 'in_progress' }),
		});
		expect(res.status).toBe(200);
		expect((await res.json()).data.status).toBe('in_progress');
	});

	it('creates a sub-issue', async () => {
		const listRes = await app.request(`/api/companies/${companyId}/issues`, {
			headers: authHeader(token),
		});
		const parentIssue = (await listRes.json()).data[0];

		const res = await app.request(
			`/api/companies/${companyId}/issues/${parentIssue.id}/sub-issues`,
			{
				method: 'POST',
				headers: { ...authHeader(token), 'Content-Type': 'application/json' },
				body: JSON.stringify({ title: 'Sub-task', assignee_id: agentId }),
			},
		);
		expect(res.status).toBe(201);
		const body = await res.json();
		expect(body.data.parent_issue_id).toBe(parentIssue.id);
		expect(body.data.identifier).toMatch(/^MP-\d+$/);
	});

	it('manages issue dependencies', async () => {
		const listRes = await app.request(`/api/companies/${companyId}/issues`, {
			headers: authHeader(token),
		});
		const issues = (await listRes.json()).data;

		// Add dependency
		const addRes = await app.request(
			`/api/companies/${companyId}/issues/${issues[0].id}/dependencies`,
			{
				method: 'POST',
				headers: { ...authHeader(token), 'Content-Type': 'application/json' },
				body: JSON.stringify({ blocked_by_issue_id: issues[1].id }),
			},
		);
		expect(addRes.status).toBe(201);

		// List dependencies
		const listDepsRes = await app.request(
			`/api/companies/${companyId}/issues/${issues[0].id}/dependencies`,
			{ headers: authHeader(token) },
		);
		expect(listDepsRes.status).toBe(200);
		const deps = (await listDepsRes.json()).data;
		expect(deps).toHaveLength(1);

		// Remove dependency
		const removeRes = await app.request(
			`/api/companies/${companyId}/issues/${issues[0].id}/dependencies/${deps[0].id}`,
			{ method: 'DELETE', headers: authHeader(token) },
		);
		expect(removeRes.status).toBe(200);
	});

	it('updates and retrieves progress_summary', async () => {
		const listRes = await app.request(`/api/companies/${companyId}/issues`, {
			headers: authHeader(token),
		});
		const issue = (await listRes.json()).data[0];

		const summary =
			'## Requirements\n- Build auth module\n\n## Done\n- Set up project\n\n## Next\n- Implement login';
		const patchRes = await app.request(`/api/companies/${companyId}/issues/${issue.id}`, {
			method: 'PATCH',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ progress_summary: summary }),
		});
		expect(patchRes.status).toBe(200);
		const patched = (await patchRes.json()).data;
		expect(patched.progress_summary).toBe(summary);
		expect(patched.progress_summary_updated_at).toBeTruthy();

		// GET detail includes progress_summary and updater name
		const detailRes = await app.request(`/api/companies/${companyId}/issues/${issue.id}`, {
			headers: authHeader(token),
		});
		expect(detailRes.status).toBe(200);
		const detail = (await detailRes.json()).data;
		expect(detail.progress_summary).toBe(summary);
		expect(detail.progress_summary_updated_at).toBeTruthy();
	});

	it('clears progress_summary with null', async () => {
		const listRes = await app.request(`/api/companies/${companyId}/issues`, {
			headers: authHeader(token),
		});
		const issue = (await listRes.json()).data[0];

		// Set it first
		await app.request(`/api/companies/${companyId}/issues/${issue.id}`, {
			method: 'PATCH',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ progress_summary: 'Some summary' }),
		});

		// Clear it
		const clearRes = await app.request(`/api/companies/${companyId}/issues/${issue.id}`, {
			method: 'PATCH',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ progress_summary: null }),
		});
		expect(clearRes.status).toBe(200);
		expect((await clearRes.json()).data.progress_summary).toBeNull();
	});

	it('does not include progress_summary in list view', async () => {
		const listRes = await app.request(`/api/companies/${companyId}/issues`, {
			headers: authHeader(token),
		});
		expect(listRes.status).toBe(200);
		const issues = (await listRes.json()).data;
		// List query selects specific columns, progress_summary should not be there
		expect(issues[0]).not.toHaveProperty('progress_summary');
	});

	it('updates and retrieves rules', async () => {
		const listRes = await app.request(`/api/companies/${companyId}/issues`, {
			headers: authHeader(token),
		});
		const issue = (await listRes.json()).data[0];

		const rules = 'Consult the architect before making changes.\nPrioritize performance.';
		const patchRes = await app.request(`/api/companies/${companyId}/issues/${issue.id}`, {
			method: 'PATCH',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ rules }),
		});
		expect(patchRes.status).toBe(200);
		const patched = (await patchRes.json()).data;
		expect(patched.rules).toBe(rules);

		const detailRes = await app.request(`/api/companies/${companyId}/issues/${issue.id}`, {
			headers: authHeader(token),
		});
		expect(detailRes.status).toBe(200);
		expect((await detailRes.json()).data.rules).toBe(rules);
	});

	it('clears rules with null', async () => {
		const listRes = await app.request(`/api/companies/${companyId}/issues`, {
			headers: authHeader(token),
		});
		const issue = (await listRes.json()).data[0];

		await app.request(`/api/companies/${companyId}/issues/${issue.id}`, {
			method: 'PATCH',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ rules: 'Some rules' }),
		});

		const clearRes = await app.request(`/api/companies/${companyId}/issues/${issue.id}`, {
			method: 'PATCH',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ rules: null }),
		});
		expect(clearRes.status).toBe(200);
		expect((await clearRes.json()).data.rules).toBeNull();
	});

	it('does not include rules in list view', async () => {
		const listRes = await app.request(`/api/companies/${companyId}/issues`, {
			headers: authHeader(token),
		});
		expect(listRes.status).toBe(200);
		const issues = (await listRes.json()).data;
		expect(issues[0]).not.toHaveProperty('rules');
	});

	it('rejects issue creation without assignee_id', async () => {
		const res = await app.request(`/api/companies/${companyId}/issues`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				project_id: projectId,
				title: 'No assignee issue',
			}),
		});
		expect(res.status).toBe(400);
		const body = await res.json();
		expect(body.error.message).toContain('assignee_id is required');
	});

	it('rejects sub-issue creation without assignee_id', async () => {
		const listRes = await app.request(`/api/companies/${companyId}/issues`, {
			headers: authHeader(token),
		});
		const parentIssue = (await listRes.json()).data[0];

		const res = await app.request(
			`/api/companies/${companyId}/issues/${parentIssue.id}/sub-issues`,
			{
				method: 'POST',
				headers: { ...authHeader(token), 'Content-Type': 'application/json' },
				body: JSON.stringify({ title: 'Sub without assignee' }),
			},
		);
		expect(res.status).toBe(400);
		const body = await res.json();
		expect(body.error.message).toContain('assignee_id is required');
	});

	it('rejects setting assignee_id to null on update', async () => {
		const listRes = await app.request(`/api/companies/${companyId}/issues`, {
			headers: authHeader(token),
		});
		const issue = (await listRes.json()).data[0];

		const res = await app.request(`/api/companies/${companyId}/issues/${issue.id}`, {
			method: 'PATCH',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ assignee_id: null }),
		});
		expect(res.status).toBe(400);
		const body = await res.json();
		expect(body.error.message).toContain('assignee_id cannot be null');
	});

	it('filters by multiple assignee_ids when comma-separated', async () => {
		const secondAgentRes = await app.request(`/api/companies/${companyId}/agents`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ title: 'Second Agent' }),
		});
		const secondAgentId = (await secondAgentRes.json()).data.id;

		await app.request(`/api/companies/${companyId}/issues`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				project_id: projectId,
				title: 'Agent two ticket',
				assignee_id: secondAgentId,
			}),
		});

		const listRes = await app.request(
			`/api/companies/${companyId}/issues?assignee_id=${agentId},${secondAgentId}`,
			{ headers: authHeader(token) },
		);
		expect(listRes.status).toBe(200);
		const issues = (await listRes.json()).data;
		const assigneeIds = new Set(issues.map((i: any) => i.assignee_id));
		expect(assigneeIds.has(agentId)).toBe(true);
		expect(assigneeIds.has(secondAgentId)).toBe(true);
	});

	it('pins issues with active runs to the top regardless of sort order', async () => {
		const oldRes = await app.request(`/api/companies/${companyId}/issues`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				project_id: projectId,
				title: 'Old running issue',
				assignee_id: agentId,
			}),
		});
		const oldIssue = (await oldRes.json()).data;

		await new Promise((r) => setTimeout(r, 10));

		const newRes = await app.request(`/api/companies/${companyId}/issues`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				project_id: projectId,
				title: 'New idle issue',
				assignee_id: agentId,
			}),
		});
		const newIssue = (await newRes.json()).data;

		await db.query(
			`INSERT INTO heartbeat_runs (company_id, member_id, issue_id, status)
			 VALUES ($1, $2, $3, 'running')`,
			[companyId, agentId, oldIssue.id],
		);

		const listRes = await app.request(
			`/api/companies/${companyId}/issues?project_id=${projectId}&sort=created_at:desc`,
			{ headers: authHeader(token) },
		);
		const data = (await listRes.json()).data;
		const oldIdx = data.findIndex((i: any) => i.id === oldIssue.id);
		const newIdx = data.findIndex((i: any) => i.id === newIssue.id);
		expect(oldIdx).toBeGreaterThanOrEqual(0);
		expect(newIdx).toBeGreaterThanOrEqual(0);
		expect(oldIdx).toBeLessThan(newIdx);
		expect(data[oldIdx].has_active_run).toBe(true);

		await db.query(`DELETE FROM heartbeat_runs WHERE issue_id = $1`, [oldIssue.id]);
	});

	it('allows an agent to close an issue via PATCH', async () => {
		const createRes = await app.request(`/api/companies/${companyId}/issues`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				project_id: projectId,
				title: 'Agent-close target',
				assignee_id: agentId,
			}),
		});
		const issue = (await createRes.json()).data;

		const { token: agentToken } = await mintAgentToken(db, masterKeyManager, agentId, companyId);

		const res = await app.request(`/api/companies/${companyId}/issues/${issue.id}`, {
			method: 'PATCH',
			headers: { ...authHeader(agentToken), 'Content-Type': 'application/json' },
			body: JSON.stringify({ status: 'closed' }),
		});
		expect(res.status).toBe(200);
		expect((await res.json()).data.status).toBe('closed');
	});

	it('rejects an agent trying to re-open a closed issue via PATCH', async () => {
		const createRes = await app.request(`/api/companies/${companyId}/issues`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				project_id: projectId,
				title: 'Agent-reopen target',
				assignee_id: agentId,
			}),
		});
		const issue = (await createRes.json()).data;

		await app.request(`/api/companies/${companyId}/issues/${issue.id}`, {
			method: 'PATCH',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ status: 'closed' }),
		});

		const { token: agentToken } = await mintAgentToken(db, masterKeyManager, agentId, companyId);

		const reopenRes = await app.request(`/api/companies/${companyId}/issues/${issue.id}`, {
			method: 'PATCH',
			headers: { ...authHeader(agentToken), 'Content-Type': 'application/json' },
			body: JSON.stringify({ status: 'open' }),
		});
		expect(reopenRes.status).toBe(403);
		const body = await reopenRes.json();
		expect(body.error.message).toMatch(/board/i);

		const bypassRes = await app.request(`/api/companies/${companyId}/issues/${issue.id}`, {
			method: 'PATCH',
			headers: { ...authHeader(agentToken), 'Content-Type': 'application/json' },
			body: JSON.stringify({ status: 'in_progress' }),
		});
		expect(bypassRes.status).toBe(403);
	});

	it('allows a board member to close and re-open an issue', async () => {
		const createRes = await app.request(`/api/companies/${companyId}/issues`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				project_id: projectId,
				title: 'Board close/reopen target',
				assignee_id: agentId,
			}),
		});
		const issue = (await createRes.json()).data;

		const closeRes = await app.request(`/api/companies/${companyId}/issues/${issue.id}`, {
			method: 'PATCH',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ status: 'closed' }),
		});
		expect(closeRes.status).toBe(200);
		expect((await closeRes.json()).data.status).toBe('closed');

		const reopenRes = await app.request(`/api/companies/${companyId}/issues/${issue.id}`, {
			method: 'PATCH',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ status: 'open' }),
		});
		expect(reopenRes.status).toBe(200);
		expect((await reopenRes.json()).data.status).toBe('open');
	});

	it('allows agents to set non-terminal statuses via PATCH', async () => {
		const createRes = await app.request(`/api/companies/${companyId}/issues`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				project_id: projectId,
				title: 'Agent progress target',
				assignee_id: agentId,
			}),
		});
		const issue = (await createRes.json()).data;

		const { token: agentToken } = await mintAgentToken(db, masterKeyManager, agentId, companyId);

		const res = await app.request(`/api/companies/${companyId}/issues/${issue.id}`, {
			method: 'PATCH',
			headers: { ...authHeader(agentToken), 'Content-Type': 'application/json' },
			body: JSON.stringify({ status: 'in_progress' }),
		});
		expect(res.status).toBe(200);
		expect((await res.json()).data.status).toBe('in_progress');
	});
});

describe('operations project assignee restriction', () => {
	let operationsProjectId: string;
	let ceoAgentId: string;

	beforeAll(async () => {
		const opsResult = await db.query<{ id: string }>(
			`SELECT id FROM projects WHERE company_id = $1 AND slug = 'operations'`,
			[companyId],
		);
		operationsProjectId = opsResult.rows[0].id;

		const ceoResult = await db.query<{ id: string }>(
			`SELECT ma.id FROM member_agents ma
			 JOIN members m ON m.id = ma.id
			 WHERE m.company_id = $1 AND ma.slug = 'ceo'`,
			[companyId],
		);
		ceoAgentId = ceoResult.rows[0].id;
	});

	it('rejects creating an Operations issue assigned to a non-CEO agent', async () => {
		const res = await app.request(`/api/companies/${companyId}/issues`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				project_id: operationsProjectId,
				title: 'Non-CEO on Operations',
				assignee_id: agentId,
			}),
		});
		expect(res.status).toBe(400);
		expect((await res.json()).error.message).toContain('CEO');
	});

	it('accepts creating an Operations issue assigned to the CEO', async () => {
		const res = await app.request(`/api/companies/${companyId}/issues`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				project_id: operationsProjectId,
				title: 'CEO on Operations',
				assignee_id: ceoAgentId,
			}),
		});
		expect(res.status).toBe(201);
		expect((await res.json()).data.assignee_id).toBe(ceoAgentId);
	});

	it('allows non-CEO assignees on non-Operations projects', async () => {
		const res = await app.request(`/api/companies/${companyId}/issues`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				project_id: projectId,
				title: 'Non-CEO on regular project',
				assignee_id: agentId,
			}),
		});
		expect(res.status).toBe(201);
	});

	it('rejects reassigning an Operations issue to a non-CEO agent', async () => {
		const createRes = await app.request(`/api/companies/${companyId}/issues`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				project_id: operationsProjectId,
				title: 'Reassignable Operations issue',
				assignee_id: ceoAgentId,
			}),
		});
		const issue = (await createRes.json()).data;

		const res = await app.request(`/api/companies/${companyId}/issues/${issue.id}`, {
			method: 'PATCH',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ assignee_id: agentId }),
		});
		expect(res.status).toBe(400);
		expect((await res.json()).error.message).toContain('CEO');
	});

	it('allows reassigning an Operations issue back to the CEO', async () => {
		const createRes = await app.request(`/api/companies/${companyId}/issues`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				project_id: operationsProjectId,
				title: 'Operations keep-CEO issue',
				assignee_id: ceoAgentId,
			}),
		});
		const issue = (await createRes.json()).data;

		const res = await app.request(`/api/companies/${companyId}/issues/${issue.id}`, {
			method: 'PATCH',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ assignee_id: ceoAgentId }),
		});
		expect(res.status).toBe(200);
	});

	it('rejects sub-issue of an Operations parent assigned to a non-CEO agent', async () => {
		const parentRes = await app.request(`/api/companies/${companyId}/issues`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				project_id: operationsProjectId,
				title: 'Operations parent',
				assignee_id: ceoAgentId,
			}),
		});
		const parent = (await parentRes.json()).data;

		const res = await app.request(`/api/companies/${companyId}/issues/${parent.id}/sub-issues`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ title: 'Sub with non-CEO', assignee_id: agentId }),
		});
		expect(res.status).toBe(400);
		expect((await res.json()).error.message).toContain('CEO');
	});

	it('exposes project_slug on the issue detail response', async () => {
		const createRes = await app.request(`/api/companies/${companyId}/issues`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				project_id: operationsProjectId,
				title: 'Operations detail check',
				assignee_id: ceoAgentId,
			}),
		});
		const issue = (await createRes.json()).data;

		const detailRes = await app.request(`/api/companies/${companyId}/issues/${issue.id}`, {
			headers: authHeader(token),
		});
		const detail = (await detailRes.json()).data;
		expect(detail.project_slug).toBe('operations');
	});
});
