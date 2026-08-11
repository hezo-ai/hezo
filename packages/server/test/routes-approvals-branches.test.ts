import { ApprovalStatus, ApprovalType } from '@hezo/shared';
import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../src/db/database';
import type { Env } from '../src/lib/types';
import { signAdminJwt } from '../src/middleware/auth';
import { safeClose } from './helpers';
import { authHeader, createTestApp, createTestTeam, projectSlugFor } from './helpers/app';

/**
 * Remaining branch coverage for packages/server/src/routes/approvals.ts not
 * reached by approvals.test.ts / approvals-extended.test.ts / approvals-blocked-tickets.test.ts:
 *   - GET list archived=true / archived=false filter arms
 *   - PATCH approval: system_prompt missing-vars 400, reports_to unresolved 400,
 *     empty-patch 400, cross-team 403, NOT_FOUND
 *   - POST /approvals/:id/resolve: cross-team 403, already-resolved 409
 *   - blocked-tickets: NOT_FOUND on cross-team approval
 */

let app: Hono<Env>;
let db: Db;
let token: string;
let outsiderToken: string;
let teamId: string;
let projectSlug: string;
let agentId: string;

beforeAll(async () => {
	const ctx = await createTestApp();
	app = ctx.app;
	db = ctx.db;
	token = ctx.token;

	const teamRes = await createTestTeam(db, { name: 'Approvals Branch Co' });
	teamId = (await teamRes.json()).data.id;
	projectSlug = await projectSlugFor(db, teamId);

	const agent = await db.query<{ id: string }>(
		`SELECT ma.id FROM member_agents ma JOIN members m ON m.id = ma.id
		 WHERE m.team_id = $1 LIMIT 1`,
		[teamId],
	);
	agentId = agent.rows[0].id;

	// A board user belonging to a DIFFERENT team — has no access to this team's
	// approvals, so requireTeamAccessForResource denies (403) on the un-scoped
	// /approvals routes that resolve the team from the approval row.
	const otherTeamRes = await createTestTeam(db, { name: 'Approvals Outsider Co' });
	const otherTeamId = (await otherTeamRes.json()).data.id;
	const outsider = await db.query<{ id: string }>(
		"INSERT INTO users (display_name, is_superuser) VALUES ('Outsider', false) RETURNING id",
	);
	const outsiderUserId = outsider.rows[0].id;
	const member = await db.query<{ id: string }>(
		`INSERT INTO members (team_id, member_type, display_name)
		 VALUES ($1, 'user', 'Outsider') RETURNING id`,
		[otherTeamId],
	);
	await db.query(`INSERT INTO member_users (id, user_id) VALUES ($1, $2)`, [
		member.rows[0].id,
		outsiderUserId,
	]);
	outsiderToken = await signAdminJwt(ctx.masterKeyManager, outsiderUserId);
});

afterAll(async () => {
	await safeClose(db);
});

function jsonHeaders(t: string) {
	return { ...authHeader(t), 'Content-Type': 'application/json' };
}

async function createHire(payload: Record<string, unknown>): Promise<string> {
	const res = await app.request(`/api/projects/${projectSlug}/approvals`, {
		method: 'POST',
		headers: jsonHeaders(token),
		body: JSON.stringify({
			type: ApprovalType.Hire,
			requested_by_member_id: agentId,
			payload,
		}),
	});
	expect(res.status).toBe(201);
	return (await res.json()).data.id;
}

describe('GET /projects/:projectId/approvals — archived filter arms', () => {
	it('archived=true returns only archived approvals', async () => {
		const archivedId = await createHire({ title: 'Archived Approval' });
		await db.query('UPDATE approvals SET archived_at = now() WHERE id = $1', [archivedId]);
		const res = await app.request(`/api/projects/${projectSlug}/approvals?archived=true`, {
			headers: authHeader(token),
		});
		expect(res.status).toBe(200);
		const rows = (await res.json()).data as Array<{ id: string; archived_at: string | null }>;
		expect(rows.length).toBeGreaterThan(0);
		expect(rows.every((r) => r.archived_at !== null)).toBe(true);
	});

	it('archived=false returns only non-archived approvals', async () => {
		await createHire({ title: 'Live Approval' });
		const res = await app.request(`/api/projects/${projectSlug}/approvals?archived=false`, {
			headers: authHeader(token),
		});
		expect(res.status).toBe(200);
		const rows = (await res.json()).data as Array<{ archived_at: string | null }>;
		expect(rows.every((r) => r.archived_at === null)).toBe(true);
	});
});

describe('PATCH /approvals/:approvalId — validation + auth arms', () => {
	it('404s for an unknown approval', async () => {
		const res = await app.request('/api/approvals/00000000-0000-0000-0000-000000000000', {
			method: 'PATCH',
			headers: jsonHeaders(token),
			body: JSON.stringify({ title: 'X' }),
		});
		expect(res.status).toBe(404);
	});

	it('403s when a user outside the team patches a hire proposal', async () => {
		const id = await createHire({ title: 'Cross-team Patch' });
		const res = await app.request(`/api/approvals/${id}`, {
			method: 'PATCH',
			headers: jsonHeaders(outsiderToken),
			body: JSON.stringify({ title: 'New Title' }),
		});
		expect(res.status).toBe(403);
	});

	it('400s when a revised system_prompt drops required substitution vars', async () => {
		const id = await createHire({ title: 'Prompt Vars', system_prompt: 'original' });
		const res = await app.request(`/api/approvals/${id}`, {
			method: 'PATCH',
			headers: jsonHeaders(token),
			body: JSON.stringify({ system_prompt: 'A prompt with no required template variables.' }),
		});
		expect(res.status).toBe(400);
		expect((await res.json()).error.code).toBe('INVALID_REQUEST');
	});

	it('400s when reports_to names an agent not on this team', async () => {
		const id = await createHire({ title: 'Bad Manager' });
		const res = await app.request(`/api/approvals/${id}`, {
			method: 'PATCH',
			headers: jsonHeaders(token),
			body: JSON.stringify({ reports_to: 'no-such-agent-slug' }),
		});
		expect(res.status).toBe(400);
		expect((await res.json()).error.message).toMatch(/no agent/);
	});

	it('400s when the patch contains no updatable fields', async () => {
		const id = await createHire({ title: 'Empty Patch' });
		const res = await app.request(`/api/approvals/${id}`, {
			method: 'PATCH',
			headers: jsonHeaders(token),
			body: JSON.stringify({ irrelevant_field: 'ignored' }),
		});
		expect(res.status).toBe(400);
		expect((await res.json()).error.message).toMatch(/No fields to update/);
	});
});

describe('POST /approvals/:approvalId/resolve — auth + state arms', () => {
	it('403s when a user outside the team resolves the approval', async () => {
		const id = await createHire({ title: 'Cross-team Resolve' });
		const res = await app.request(`/api/approvals/${id}/resolve`, {
			method: 'POST',
			headers: jsonHeaders(outsiderToken),
			body: JSON.stringify({ status: 'approved' }),
		});
		expect(res.status).toBe(403);
	});

	it('409s when resolving an already-resolved approval', async () => {
		const id = await createHire({ title: 'Already Resolved' });
		await db.query(
			`UPDATE approvals SET status = $2::approval_status, resolved_at = now() WHERE id = $1`,
			[id, ApprovalStatus.Denied],
		);
		const res = await app.request(`/api/approvals/${id}/resolve`, {
			method: 'POST',
			headers: jsonHeaders(token),
			body: JSON.stringify({ status: 'approved' }),
		});
		expect(res.status).toBe(409);
	});
});

describe('GET blocked-tasks — cross-team NOT_FOUND arm', () => {
	it('404s when the approval belongs to a different team', async () => {
		// An approval created in a different team is not visible via this projectSlug.
		const otherTeam = await createTestTeam(db, { name: 'Blocked Tasks Other Co' });
		const otherTeamId = (await otherTeam.json()).data.id;
		const ins = await db.query<{ id: string }>(
			`INSERT INTO approvals (team_id, type, payload)
			 VALUES ($1, $2::approval_type, '{}'::jsonb) RETURNING id`,
			[otherTeamId, ApprovalType.DesignatedRepoRequest],
		);
		const res = await app.request(
			`/api/projects/${projectSlug}/approvals/${ins.rows[0].id}/blocked-tasks`,
			{ headers: authHeader(token) },
		);
		expect(res.status).toBe(404);
	});
});
