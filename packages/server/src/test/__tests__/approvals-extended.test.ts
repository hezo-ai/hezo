import type { PGlite } from '@electric-sql/pglite';
import { ApprovalType } from '@hezo/shared';
import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Env } from '../../lib/types';
import { safeClose } from '../helpers';
import { authHeader, createTestApp } from '../helpers/app';

let app: Hono<Env>;
let db: PGlite;
let token: string;
let companyId: string;
let agentId: string;

beforeAll(async () => {
	const ctx = await createTestApp();
	app = ctx.app;
	db = ctx.db;
	token = ctx.token;

	const typesRes = await app.request('/api/company-types', {
		headers: authHeader(token),
	});
	const typeId = (await typesRes.json()).data.find(
		(t: Record<string, unknown>) => t.name === 'Startup',
	).id;

	const companyRes = await app.request('/api/companies', {
		method: 'POST',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify({
			name: 'Approval Extended Co',
			template_id: typeId,
			issue_prefix: 'AX',
		}),
	});
	companyId = (await companyRes.json()).data.id;

	const agentsRes = await app.request(`/api/companies/${companyId}/agents`, {
		headers: authHeader(token),
	});
	agentId = (await agentsRes.json()).data[0].id;
});

afterAll(async () => {
	await safeClose(db);
});

describe('POST /companies/:companyId/approvals validation', () => {
	it('returns 400 when type is missing', async () => {
		const res = await app.request(`/api/companies/${companyId}/approvals`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				requested_by_member_id: agentId,
				payload: { secret_name: 'MY_SECRET', reason: 'test' },
			}),
		});
		expect(res.status).toBe(400);
	});

	it('returns 400 when payload is missing', async () => {
		const res = await app.request(`/api/companies/${companyId}/approvals`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				type: 'secret_access',
				requested_by_member_id: agentId,
			}),
		});
		expect(res.status).toBe(400);
	});
});

describe('applyApprovalSideEffect — system_prompt_update', () => {
	it('updates agent system_prompt and creates a system_prompt_revisions record on approval', async () => {
		// Capture the agent's current system prompt before the approval
		const agentBefore = await db.query<{ system_prompt: string }>(
			'SELECT system_prompt FROM member_agents WHERE id = $1',
			[agentId],
		);
		const oldPrompt = agentBefore.rows[0]?.system_prompt ?? '';

		const newPrompt = 'Updated system prompt for testing purposes';

		// Create a system_prompt_update approval
		const createRes = await app.request(`/api/companies/${companyId}/approvals`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				type: ApprovalType.SystemPromptUpdate,
				requested_by_member_id: agentId,
				payload: {
					member_id: agentId,
					new_system_prompt: newPrompt,
					reason: 'improvement',
				},
			}),
		});
		expect(createRes.status).toBe(201);
		const approval = (await createRes.json()).data;

		// Approve it
		const resolveRes = await app.request(`/api/approvals/${approval.id}/resolve`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ status: 'approved', resolution_note: 'Looks good' }),
		});
		expect(resolveRes.status).toBe(200);
		expect((await resolveRes.json()).data.status).toBe('approved');

		// Verify the agent's system_prompt was updated
		const agentAfter = await db.query<{ system_prompt: string }>(
			'SELECT system_prompt FROM member_agents WHERE id = $1',
			[agentId],
		);
		expect(agentAfter.rows[0].system_prompt).toBe(newPrompt);

		// Verify a revision record was created
		const revisions = await db.query<{
			member_agent_id: string;
			revision_number: number;
			old_prompt: string;
			new_prompt: string;
			change_summary: string;
			approval_id: string;
		}>('SELECT * FROM system_prompt_revisions WHERE member_agent_id = $1 AND approval_id = $2', [
			agentId,
			approval.id,
		]);
		expect(revisions.rows.length).toBe(1);
		const rev = revisions.rows[0];
		expect(rev.old_prompt).toBe(oldPrompt);
		expect(rev.new_prompt).toBe(newPrompt);
		expect(rev.change_summary).toBe('improvement');
		expect(rev.revision_number).toBeGreaterThanOrEqual(1);
	});
});

describe('GET /companies/:companyId/approvals status filtering', () => {
	let pendingApprovalId: string;
	let approvedApprovalId: string;

	beforeAll(async () => {
		// Create a pending approval (leave it pending)
		const pendingRes = await app.request(`/api/companies/${companyId}/approvals`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				type: 'hire',
				requested_by_member_id: agentId,
				payload: { title: 'Filter Test Pending' },
			}),
		});
		pendingApprovalId = (await pendingRes.json()).data.id;

		// Create another approval and approve it
		const toApproveRes = await app.request(`/api/companies/${companyId}/approvals`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				type: 'strategy',
				requested_by_member_id: agentId,
				payload: { description: 'Filter Test Approved' },
			}),
		});
		approvedApprovalId = (await toApproveRes.json()).data.id;

		await app.request(`/api/approvals/${approvedApprovalId}/resolve`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ status: 'approved' }),
		});
	});

	it('returns only pending approvals by default (no status query param)', async () => {
		const res = await app.request(`/api/companies/${companyId}/approvals`, {
			headers: authHeader(token),
		});
		expect(res.status).toBe(200);
		const rows = (await res.json()).data as Array<{ id: string; status: string }>;
		expect(rows.every((r) => r.status === 'pending')).toBe(true);
		expect(rows.some((r) => r.id === pendingApprovalId)).toBe(true);
		expect(rows.some((r) => r.id === approvedApprovalId)).toBe(false);
	});

	it('returns only approved approvals when ?status=approved', async () => {
		const res = await app.request(`/api/companies/${companyId}/approvals?status=approved`, {
			headers: authHeader(token),
		});
		expect(res.status).toBe(200);
		const rows = (await res.json()).data as Array<{ id: string; status: string }>;
		expect(rows.every((r) => r.status === 'approved')).toBe(true);
		expect(rows.some((r) => r.id === approvedApprovalId)).toBe(true);
		expect(rows.some((r) => r.id === pendingApprovalId)).toBe(false);
	});

	it('returns both pending and approved when ?status=pending,approved', async () => {
		const res = await app.request(`/api/companies/${companyId}/approvals?status=pending,approved`, {
			headers: authHeader(token),
		});
		expect(res.status).toBe(200);
		const rows = (await res.json()).data as Array<{ id: string; status: string }>;
		const ids = rows.map((r) => r.id);
		expect(ids).toContain(pendingApprovalId);
		expect(ids).toContain(approvedApprovalId);
	});
});

describe('Deny flow', () => {
	it('sets status to denied and does NOT apply side effects', async () => {
		// Capture prompt before
		const agentBefore = await db.query<{ system_prompt: string }>(
			'SELECT system_prompt FROM member_agents WHERE id = $1',
			[agentId],
		);
		const promptBefore = agentBefore.rows[0]?.system_prompt ?? '';

		const newPrompt = 'This prompt should NEVER be applied';

		const createRes = await app.request(`/api/companies/${companyId}/approvals`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				type: 'system_prompt_update',
				requested_by_member_id: agentId,
				payload: {
					member_id: agentId,
					new_system_prompt: newPrompt,
					reason: 'should not apply',
				},
			}),
		});
		expect(createRes.status).toBe(201);
		const approval = (await createRes.json()).data;

		// Deny it
		const resolveRes = await app.request(`/api/approvals/${approval.id}/resolve`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ status: 'denied', resolution_note: 'Not appropriate' }),
		});
		expect(resolveRes.status).toBe(200);
		expect((await resolveRes.json()).data.status).toBe('denied');

		// Verify the agent's system_prompt was NOT changed
		const agentAfter = await db.query<{ system_prompt: string }>(
			'SELECT system_prompt FROM member_agents WHERE id = $1',
			[agentId],
		);
		expect(agentAfter.rows[0].system_prompt).toBe(promptBefore);

		// Verify no revision record was created for this approval
		const revisions = await db.query<{ id: string }>(
			'SELECT id FROM system_prompt_revisions WHERE approval_id = $1',
			[approval.id],
		);
		expect(revisions.rows.length).toBe(0);
	});
});

describe('POST /approvals/:approvalId/resolve edge cases', () => {
	it('returns 404 when the approval does not exist', async () => {
		const fakeId = '00000000-0000-0000-0000-000000000000';
		const res = await app.request(`/api/approvals/${fakeId}/resolve`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ status: 'approved' }),
		});
		expect(res.status).toBe(404);
	});

	it('returns 400 when status is an invalid value', async () => {
		const createRes = await app.request(`/api/companies/${companyId}/approvals`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				type: 'hire',
				requested_by_member_id: agentId,
				payload: { title: 'Invalid Status Test' },
			}),
		});
		expect(createRes.status).toBe(201);
		const approval = (await createRes.json()).data;

		const res = await app.request(`/api/approvals/${approval.id}/resolve`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ status: 'maybe' }),
		});
		expect(res.status).toBe(400);
	});
});
