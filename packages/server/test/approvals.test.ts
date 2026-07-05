import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../src/db/database';
import type { Env } from '../src/lib/types';
import { safeClose } from './helpers';
import { authHeader, createTestApp, createTestTeam, projectSlugFor } from './helpers/app';
import { compliantPrompt } from './helpers/prompt';

let app: Hono<Env>;
let db: Db;
let token: string;
let projectSlug: string;
let agentId: string;

beforeAll(async () => {
	const ctx = await createTestApp();
	app = ctx.app;
	db = ctx.db;
	token = ctx.token;

	const typesRes = await app.request('/api/team-templates', {
		headers: authHeader(token),
	});
	const typeId = (await typesRes.json()).data.find(
		(t: Record<string, unknown>) => t.name === 'Startup',
	).id;

	const teamRes = await createTestTeam(db, {
		name: 'Approval Co',
		template_id: typeId,
	});
	projectSlug = await projectSlugFor(db, (await teamRes.json()).data.id);

	const agentsRes = await app.request(`/api/projects/${projectSlug}/agents`, {
		headers: authHeader(token),
	});
	agentId = (await agentsRes.json()).data[0].id;
});

afterAll(async () => {
	await safeClose(db);
});

describe('approvals CRUD', () => {
	it('creates and resolves an approval', async () => {
		// Create
		const createRes = await app.request(`/api/projects/${projectSlug}/approvals`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				type: 'plan_review',
				requested_by_member_id: agentId,
				payload: { summary: 'Plan to review' },
			}),
		});
		expect(createRes.status).toBe(201);
		const approval = (await createRes.json()).data;
		expect(approval.status).toBe('pending');

		// List pending
		const listRes = await app.request(`/api/projects/${projectSlug}/approvals`, {
			headers: authHeader(token),
		});
		expect(listRes.status).toBe(200);
		expect((await listRes.json()).data.length).toBeGreaterThanOrEqual(1);

		// Approve
		const resolveRes = await app.request(`/api/approvals/${approval.id}/resolve`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				status: 'approved',
				resolution_note: 'Granted for project scope',
			}),
		});
		expect(resolveRes.status).toBe(200);
		const resolved = (await resolveRes.json()).data;
		expect(resolved.status).toBe('approved');
		expect(resolved.resolved_at).not.toBeNull();
	});

	it('lets the admin modify a pending hire proposal before approving', async () => {
		const createRes = await app.request(`/api/projects/${projectSlug}/approvals`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				type: 'hire',
				requested_by_member_id: agentId,
				payload: { title: 'Analyst', slug: 'analyst', system_prompt: 'Draft.' },
			}),
		});
		const approval = (await createRes.json()).data;

		const patchRes = await app.request(`/api/approvals/${approval.id}`, {
			method: 'PATCH',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				system_prompt: compliantPrompt('You are the Analyst. Own all reporting.'),
				monthly_budget_cents: 7000,
			}),
		});
		expect(patchRes.status).toBe(200);
		const patched = (await patchRes.json()).data;
		expect(patched.payload.system_prompt).toContain('Own all reporting');
		expect(patched.payload.monthly_budget_cents).toBe(7000);
		// Untouched fields and the fixed slug are preserved.
		expect(patched.payload.slug).toBe('analyst');
		expect(patched.payload.title).toBe('Analyst');
	});

	it('rejects modifying a non-hire approval', async () => {
		const createRes = await app.request(`/api/projects/${projectSlug}/approvals`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				type: 'plan_review',
				requested_by_member_id: agentId,
				payload: { summary: 'x' },
			}),
		});
		const approval = (await createRes.json()).data;
		const res = await app.request(`/api/approvals/${approval.id}`, {
			method: 'PATCH',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ system_prompt: 'nope' }),
		});
		expect(res.status).toBe(400);
	});

	it('rejects modifying an already-resolved hire proposal', async () => {
		const createRes = await app.request(`/api/projects/${projectSlug}/approvals`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				type: 'hire',
				requested_by_member_id: agentId,
				payload: { title: 'Late Role', slug: 'late-role' },
			}),
		});
		const approval = (await createRes.json()).data;
		await app.request(`/api/approvals/${approval.id}/resolve`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ status: 'denied' }),
		});

		const res = await app.request(`/api/approvals/${approval.id}`, {
			method: 'PATCH',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ system_prompt: 'too late' }),
		});
		expect(res.status).toBe(409);
	});

	it('rejects resolving an already-resolved approval', async () => {
		// Create and resolve
		const createRes = await app.request(`/api/projects/${projectSlug}/approvals`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				type: 'hire',
				requested_by_member_id: agentId,
				payload: { title: 'New Agent' },
			}),
		});
		const approval = (await createRes.json()).data;

		await app.request(`/api/approvals/${approval.id}/resolve`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ status: 'denied' }),
		});

		// Try again
		const res = await app.request(`/api/approvals/${approval.id}/resolve`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ status: 'approved' }),
		});
		expect(res.status).toBe(409);
	});
});
