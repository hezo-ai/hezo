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

describe('GET /companies/:companyId/approvals enriched fields', () => {
	it('returns company_slug and resolved payload references', async () => {
		// Create a project so we can reference it in the payload
		const projRes = await app.request(`/api/companies/${companyId}/projects`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				name: 'Enriched Test Project',
				description: 'For enrichment testing',
			}),
		});
		expect(projRes.status).toBe(201);
		const project = (await projRes.json()).data;

		// Create an approval with member_id and project_id in the payload
		const createRes = await app.request(`/api/companies/${companyId}/approvals`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				type: ApprovalType.SecretAccess,
				requested_by_member_id: agentId,
				payload: {
					member_id: agentId,
					secret_name: 'ENRICH_TEST',
					project_id: project.id,
					reason: 'testing enriched fields',
				},
			}),
		});
		expect(createRes.status).toBe(201);

		const listRes = await app.request(`/api/companies/${companyId}/approvals`, {
			headers: authHeader(token),
		});
		expect(listRes.status).toBe(200);
		const rows = (await listRes.json()).data as any[];
		const row = rows.find(
			(r: any) => r.type === 'secret_access' && r.payload?.secret_name === 'ENRICH_TEST',
		);
		expect(row).toBeDefined();

		expect(row.company_slug).toBeTruthy();
		expect(row.payload_member_name).toBeTruthy();
		expect(row.payload_member_slug).toBeTruthy();
		expect(row.payload_project_name).toBe('Enriched Test Project');
		expect(row.payload_project_slug).toBeTruthy();
	});

	it('returns null for resolved fields when payload UUIDs are absent', async () => {
		const createRes = await app.request(`/api/companies/${companyId}/approvals`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				type: ApprovalType.SkillProposal,
				requested_by_member_id: agentId,
				payload: {
					skill_name: 'test-skill',
					skill_slug: 'test-skill',
					content: '# Test',
					reason: 'testing null fields',
				},
			}),
		});
		expect(createRes.status).toBe(201);

		const listRes = await app.request(`/api/companies/${companyId}/approvals`, {
			headers: authHeader(token),
		});
		const rows = (await listRes.json()).data as any[];
		const row = rows.find(
			(r: any) => r.type === 'skill_proposal' && r.payload?.skill_slug === 'test-skill',
		);
		expect(row).toBeDefined();

		expect(row.company_slug).toBeTruthy();
		expect(row.payload_member_name).toBeNull();
		expect(row.payload_member_slug).toBeNull();
		expect(row.payload_project_name).toBeNull();
		expect(row.payload_project_slug).toBeNull();
		expect(row.payload_issue_identifier).toBeNull();
	});
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
		const createRes = await app.request(`/api/companies/${companyId}/approvals`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				type: 'kb_update',
				requested_by_member_id: agentId,
				payload: {
					slug: 'deny-test',
					title: 'Deny Test',
					content: 'should not be applied',
					change_summary: 'testing deny flow',
				},
			}),
		});
		expect(createRes.status).toBe(201);
		const approval = (await createRes.json()).data;

		const resolveRes = await app.request(`/api/approvals/${approval.id}/resolve`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ status: 'denied', resolution_note: 'Not appropriate' }),
		});
		expect(resolveRes.status).toBe(200);
		expect((await resolveRes.json()).data.status).toBe('denied');

		const kbDoc = await db.query<{ id: string }>(
			`SELECT id FROM documents WHERE type = 'kb_doc' AND company_id = $1 AND slug = $2`,
			[companyId, 'deny-test'],
		);
		expect(kbDoc.rows.length).toBe(0);
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
