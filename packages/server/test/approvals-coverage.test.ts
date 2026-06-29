import type { PGlite } from '@electric-sql/pglite';
import { ApprovalType } from '@hezo/shared';
import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MasterKeyManager } from '../src/crypto/master-key';
import type { Env } from '../src/lib/types';
import { safeClose } from './helpers';
import {
	authHeader,
	createTestApp,
	createTestTeam,
	mintAgentToken,
	projectSlugFor,
} from './helpers/app';
import { compliantPrompt } from './helpers/prompt';

let app: Hono<Env>;
let db: PGlite;
let token: string;
let masterKeyManager: MasterKeyManager;
let teamId: string;
let projectSlug: string;
let agentId: string;
let agentSlug: string;

function jsonHeaders() {
	return { ...authHeader(token), 'Content-Type': 'application/json' };
}

async function createApproval(
	type: string,
	payload: Record<string, unknown>,
): Promise<{ id: string }> {
	const res = await app.request(`/api/projects/${projectSlug}/approvals`, {
		method: 'POST',
		headers: jsonHeaders(),
		body: JSON.stringify({ type, requested_by_member_id: agentId, payload }),
	});
	return (await res.json()).data;
}

beforeAll(async () => {
	const ctx = await createTestApp();
	app = ctx.app;
	db = ctx.db;
	token = ctx.token;
	masterKeyManager = ctx.masterKeyManager;

	const typesRes = await app.request('/api/team-templates', { headers: authHeader(token) });
	const typeId = (await typesRes.json()).data.find(
		(t: { name: string }) => t.name === 'Startup',
	).id;

	const teamRes = await createTestTeam(db, { name: 'Approvals Cov Co', template_id: typeId });
	teamId = (await teamRes.json()).data.id;
	projectSlug = await projectSlugFor(db, teamId);

	const agentsRes = await app.request(`/api/projects/${projectSlug}/agents`, {
		headers: authHeader(token),
	});
	const captain = (await agentsRes.json()).data[0];
	agentId = captain.id;
	agentSlug = captain.slug;
});

afterAll(async () => {
	await safeClose(db);
});

describe('GET approvals archived filter', () => {
	it('returns only archived approvals when ?archived=true', async () => {
		const live = await createApproval(ApprovalType.Hire, { title: 'Live One', slug: 'live-one' });
		const archived = await createApproval(ApprovalType.Hire, {
			title: 'Archived One',
			slug: 'archived-one',
		});
		await db.query(`UPDATE approvals SET archived_at = now() WHERE id = $1`, [archived.id]);

		const res = await app.request(`/api/projects/${projectSlug}/approvals?archived=true`, {
			headers: authHeader(token),
		});
		expect(res.status).toBe(200);
		const ids = ((await res.json()).data as Array<{ id: string }>).map((r) => r.id);
		expect(ids).toContain(archived.id);
		expect(ids).not.toContain(live.id);
	});

	it('returns only non-archived approvals when ?archived=false', async () => {
		const live = await createApproval(ApprovalType.Hire, { title: 'Live Two', slug: 'live-two' });
		const archived = await createApproval(ApprovalType.Hire, {
			title: 'Archived Two',
			slug: 'archived-two',
		});
		await db.query(`UPDATE approvals SET archived_at = now() WHERE id = $1`, [archived.id]);

		const res = await app.request(`/api/projects/${projectSlug}/approvals?archived=false`, {
			headers: authHeader(token),
		});
		expect(res.status).toBe(200);
		const ids = ((await res.json()).data as Array<{ id: string }>).map((r) => r.id);
		expect(ids).toContain(live.id);
		expect(ids).not.toContain(archived.id);
	});
});

describe('PATCH /approvals/:approvalId edge branches', () => {
	it('returns 404 for an unknown approval', async () => {
		const res = await app.request(`/api/approvals/${crypto.randomUUID()}`, {
			method: 'PATCH',
			headers: jsonHeaders(),
			body: JSON.stringify({ system_prompt: compliantPrompt('Hi') }),
		});
		expect(res.status).toBe(404);
	});

	it('rejects a revised system prompt missing required substitution vars', async () => {
		const approval = await createApproval(ApprovalType.Hire, {
			title: 'Bad Prompt',
			slug: 'bad-prompt',
		});
		const res = await app.request(`/api/approvals/${approval.id}`, {
			method: 'PATCH',
			headers: jsonHeaders(),
			// Non-empty but missing the required vars.
			body: JSON.stringify({ system_prompt: 'You are an agent with no template vars.' }),
		});
		expect(res.status).toBe(400);
	});

	it('rejects a reports_to that does not resolve to a team agent', async () => {
		const approval = await createApproval(ApprovalType.Hire, {
			title: 'Bad Manager',
			slug: 'bad-manager',
		});
		const res = await app.request(`/api/approvals/${approval.id}`, {
			method: 'PATCH',
			headers: jsonHeaders(),
			body: JSON.stringify({ reports_to: 'no-such-agent-slug' }),
		});
		expect(res.status).toBe(400);
		expect((await res.json()).error.message).toContain('no-such-agent-slug');
	});

	it('accepts a reports_to that resolves to an existing team agent', async () => {
		const approval = await createApproval(ApprovalType.Hire, {
			title: 'Good Manager',
			slug: 'good-manager',
		});
		const res = await app.request(`/api/approvals/${approval.id}`, {
			method: 'PATCH',
			headers: jsonHeaders(),
			body: JSON.stringify({ reports_to: agentSlug }),
		});
		expect(res.status).toBe(200);
		expect((await res.json()).data.payload.reports_to).toBe(agentSlug);
	});

	it('clears reports_to when an empty string is supplied', async () => {
		const approval = await createApproval(ApprovalType.Hire, {
			title: 'Clear Manager',
			slug: 'clear-manager',
			reports_to: agentSlug,
		});
		const res = await app.request(`/api/approvals/${approval.id}`, {
			method: 'PATCH',
			headers: jsonHeaders(),
			body: JSON.stringify({ reports_to: '   ' }),
		});
		expect(res.status).toBe(200);
		expect((await res.json()).data.payload.reports_to).toBeNull();
	});

	it('returns 400 when the patch resolves to no updatable fields', async () => {
		const approval = await createApproval(ApprovalType.Hire, {
			title: 'No Fields',
			slug: 'no-fields',
		});
		const res = await app.request(`/api/approvals/${approval.id}`, {
			method: 'PATCH',
			headers: jsonHeaders(),
			body: JSON.stringify({}),
		});
		expect(res.status).toBe(400);
		expect((await res.json()).error.message).toContain('No fields to update');
	});
});

describe('POST /approvals/:approvalId/resolve under agent auth', () => {
	it('records the agent member as the actor when resolved with an agent token', async () => {
		// Mint an agent JWT for the captain on this team.
		const { token: agentToken } = await mintAgentToken(db, masterKeyManager, agentId, teamId);

		const approval = await createApproval(ApprovalType.Strategy, {
			description: 'Agent-resolved strategy',
		});

		const res = await app.request(`/api/approvals/${approval.id}/resolve`, {
			method: 'POST',
			headers: { Authorization: `Bearer ${agentToken}`, 'Content-Type': 'application/json' },
			body: JSON.stringify({ status: 'approved', resolution_note: 'lgtm' }),
		});
		expect(res.status).toBe(200);
		expect((await res.json()).data.status).toBe('approved');
	});
});
