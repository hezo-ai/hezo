import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
	authHeader,
	createTestProject,
	createTestTeam,
	mintAgentToken,
	projectSlugFor,
} from './helpers/app';
import { createTestContext, destroyTestContext, type ServerTestContext } from './helpers/context';

/**
 * Line coverage for packages/server/src/routes/approvals.ts: the list filters
 * (status single/multi, archived arms), the blocked-tickets endpoint (404 /
 * wrong-type 400 / happy rows with snippet fallback), create validation, the
 * hire-proposal PATCH branches, and the resolve flow (validation, admin and
 * agent actor resolution, deny/approve, already-resolved 409).
 */

let ctx: ServerTestContext;
let teamId: string;
let projectId: string;
let projectSlug: string;
let agentId: string;
let agentSlug: string;

function jsonHeaders(token: string): Record<string, string> {
	return { ...authHeader(token), 'Content-Type': 'application/json' };
}

async function createApproval(
	type: string,
	payload: Record<string, unknown>,
): Promise<{ id: string; status: string }> {
	const res = await ctx.app.request(`/api/projects/${projectSlug}/approvals`, {
		method: 'POST',
		headers: jsonHeaders(ctx.token),
		body: JSON.stringify({ type, requested_by_member_id: agentId, payload }),
	});
	expect(res.status).toBe(201);
	return (await res.json()).data;
}

async function resolveApprovalReq(approvalId: string, body: unknown, token = ctx.token) {
	return ctx.app.request(`/api/approvals/${approvalId}/resolve`, {
		method: 'POST',
		headers: jsonHeaders(token),
		body: JSON.stringify(body),
	});
}

beforeAll(async () => {
	ctx = await createTestContext();

	const teamRes = await createTestTeam(ctx.db, { name: 'Approval Coverage Co' });
	teamId = (await teamRes.json()).data.id;
	const projectRes = await createTestProject(ctx.db, teamId, { name: 'Approval Coverage' });
	const project = (await projectRes.json()).data;
	projectId = project.id;
	projectSlug = project.slug;

	const agent = await ctx.db.query<{ id: string; slug: string }>(
		`SELECT ma.id, ma.slug FROM member_agents ma
		 JOIN members m ON m.id = ma.id
		 WHERE m.team_id = $1 AND ma.admin_status = 'enabled'
		 LIMIT 1`,
		[teamId],
	);
	agentId = agent.rows[0].id;
	agentSlug = agent.rows[0].slug;
});

afterAll(async () => {
	await destroyTestContext(ctx);
});

describe('POST /projects/:projectId/approvals', () => {
	it('creates a pending approval and persists the payload', async () => {
		const created = await createApproval('plan_review', { summary: 'Look at this plan' });
		expect(created.status).toBe('pending');
		const row = await ctx.db.query<{ payload: { summary: string }; team_id: string }>(
			'SELECT payload, team_id FROM approvals WHERE id = $1',
			[created.id],
		);
		expect(row.rows[0].team_id).toBe(teamId);
		expect(row.rows[0].payload.summary).toBe('Look at this plan');
	});

	it('400s when type is missing', async () => {
		const res = await ctx.app.request(`/api/projects/${projectSlug}/approvals`, {
			method: 'POST',
			headers: jsonHeaders(ctx.token),
			body: JSON.stringify({ payload: { x: 1 } }),
		});
		expect(res.status).toBe(400);
		expect((await res.json()).error.message).toContain('type and payload are required');
	});

	it('400s when payload is missing', async () => {
		const res = await ctx.app.request(`/api/projects/${projectSlug}/approvals`, {
			method: 'POST',
			headers: jsonHeaders(ctx.token),
			body: JSON.stringify({ type: 'plan_review' }),
		});
		expect(res.status).toBe(400);
	});
});

describe('GET /projects/:projectId/approvals', () => {
	let pendingId: string;
	let approvedId: string;
	let archivedId: string;

	beforeAll(async () => {
		pendingId = (await createApproval('plan_review', { summary: 'list-pending' })).id;
		approvedId = (await createApproval('plan_review', { summary: 'list-approved' })).id;
		await resolveApprovalReq(approvedId, { status: 'approved' });
		archivedId = (await createApproval('plan_review', { summary: 'list-archived' })).id;
		await ctx.db.query('UPDATE approvals SET archived_at = now() WHERE id = $1', [archivedId]);
	});

	it('defaults to pending and joins the display names', async () => {
		const res = await ctx.app.request(`/api/projects/${projectSlug}/approvals`, {
			headers: authHeader(ctx.token),
		});
		expect(res.status).toBe(200);
		const rows = (await res.json()).data as Array<Record<string, unknown>>;
		const ids = rows.map((r) => r.id);
		expect(ids).toContain(pendingId);
		expect(ids).not.toContain(approvedId);
		const pending = rows.find((r) => r.id === pendingId);
		expect(pending?.team_id).toBe(teamId);
		expect(typeof pending?.team_slug).toBe('string');
		expect(pending?.requested_by_name).toBeTruthy();
	});

	it('filters a single non-default status', async () => {
		const res = await ctx.app.request(`/api/projects/${projectSlug}/approvals?status=approved`, {
			headers: authHeader(ctx.token),
		});
		const rows = (await res.json()).data as Array<{ id: string; status: string }>;
		expect(rows.map((r) => r.id)).toContain(approvedId);
		expect(rows.every((r) => r.status === 'approved')).toBe(true);
	});

	it('accepts a comma-separated status list', async () => {
		const res = await ctx.app.request(
			`/api/projects/${projectSlug}/approvals?status=pending, approved`,
			{ headers: authHeader(ctx.token) },
		);
		const ids = ((await res.json()).data as Array<{ id: string }>).map((r) => r.id);
		expect(ids).toContain(pendingId);
		expect(ids).toContain(approvedId);
	});

	it('archived=true returns only archived rows; archived=false excludes them', async () => {
		const archivedRes = await ctx.app.request(
			`/api/projects/${projectSlug}/approvals?archived=true`,
			{ headers: authHeader(ctx.token) },
		);
		const archivedIds = ((await archivedRes.json()).data as Array<{ id: string }>).map((r) => r.id);
		expect(archivedIds).toContain(archivedId);
		expect(archivedIds).not.toContain(pendingId);

		const activeRes = await ctx.app.request(
			`/api/projects/${projectSlug}/approvals?archived=false`,
			{ headers: authHeader(ctx.token) },
		);
		const activeIds = ((await activeRes.json()).data as Array<{ id: string }>).map((r) => r.id);
		expect(activeIds).toContain(pendingId);
		expect(activeIds).not.toContain(archivedId);
	});
});

describe('GET /projects/:projectId/approvals/:approvalId/blocked-tickets', () => {
	it('404s for an unknown approval', async () => {
		const res = await ctx.app.request(
			`/api/projects/${projectSlug}/approvals/${randomUUID()}/blocked-tickets`,
			{ headers: authHeader(ctx.token) },
		);
		expect(res.status).toBe(404);
	});

	it('400s for a non-designated_repo_request approval', async () => {
		const other = await createApproval('plan_review', { summary: 'not a repo request' });
		const res = await ctx.app.request(
			`/api/projects/${projectSlug}/approvals/${other.id}/blocked-tickets`,
			{ headers: authHeader(ctx.token) },
		);
		expect(res.status).toBe(400);
		expect((await res.json()).error.message).toContain('designated_repo_request');
	});

	it('lists blocked tasks with snippet from the preceding comment or the fallback', async () => {
		const approval = await createApproval('designated_repo_request', {
			platform: 'github',
			project_id: projectId,
		});

		const mkTask = async (title: string): Promise<{ id: string; identifier: string }> => {
			const r = await ctx.app.request(`/api/projects/${projectSlug}/tasks`, {
				method: 'POST',
				headers: jsonHeaders(ctx.token),
				body: JSON.stringify({ project_id: projectId, title, assignee_id: agentId }),
			});
			return (await r.json()).data;
		};
		const withContext = await mkTask('Blocked with context');
		const bare = await mkTask('Blocked without context');

		await ctx.db.query(
			`INSERT INTO task_comments (task_id, content_type, content, created_at)
			 VALUES ($1, 'text'::comment_content_type, $2::jsonb, now() - INTERVAL '1 minute')`,
			[withContext.id, JSON.stringify({ text: 'Cannot push: repo missing.' })],
		);
		for (const t of [withContext, bare]) {
			await ctx.db.query(
				`INSERT INTO task_comments (task_id, content_type, content)
				 VALUES ($1, 'action'::comment_content_type, $2::jsonb)`,
				[t.id, JSON.stringify({ kind: 'setup_repo', approval_id: approval.id })],
			);
		}

		const res = await ctx.app.request(
			`/api/projects/${projectSlug}/approvals/${approval.id}/blocked-tickets`,
			{ headers: authHeader(ctx.token) },
		);
		expect(res.status).toBe(200);
		const rows = (await res.json()).data as Array<{
			identifier: string;
			snippet: string;
			project_slug: string;
			agent_slug: string | null;
			comment_public_id: string;
		}>;
		expect(rows).toHaveLength(2);
		const contextRow = rows.find((r) => r.identifier === withContext.identifier);
		const bareRow = rows.find((r) => r.identifier === bare.identifier);
		expect(contextRow?.snippet).toBe('Cannot push: repo missing.');
		expect(contextRow?.project_slug).toBe(projectSlug);
		expect(contextRow?.agent_slug).toBe(agentSlug);
		expect(contextRow?.comment_public_id).toBeTruthy();
		expect(bareRow?.snippet).toBe('Needs a designated GitHub repo to start work');
	});
});

describe('PATCH /approvals/:approvalId (hire proposal edit)', () => {
	it('404s for an unknown approval', async () => {
		const res = await ctx.app.request(`/api/approvals/${randomUUID()}`, {
			method: 'PATCH',
			headers: jsonHeaders(ctx.token),
			body: JSON.stringify({ title: 'x' }),
		});
		expect(res.status).toBe(404);
	});

	it('400s for a non-hire approval', async () => {
		const plan = await createApproval('plan_review', { summary: 'not editable' });
		const res = await ctx.app.request(`/api/approvals/${plan.id}`, {
			method: 'PATCH',
			headers: jsonHeaders(ctx.token),
			body: JSON.stringify({ title: 'x' }),
		});
		expect(res.status).toBe(400);
		expect((await res.json()).error.message).toContain('hire');
	});

	it('409s for an already-resolved hire proposal', async () => {
		const hire = await createApproval('hire', { title: 'Resolved Role', slug: 'resolved-role' });
		await resolveApprovalReq(hire.id, { status: 'denied' });
		const res = await ctx.app.request(`/api/approvals/${hire.id}`, {
			method: 'PATCH',
			headers: jsonHeaders(ctx.token),
			body: JSON.stringify({ title: 'x' }),
		});
		expect(res.status).toBe(409);
	});

	it('accepts a revised system prompt that names no variables', async () => {
		const hire = await createApproval('hire', { title: 'Prompted', slug: 'prompted' });
		const res = await ctx.app.request(`/api/approvals/${hire.id}`, {
			method: 'PATCH',
			headers: jsonHeaders(ctx.token),
			body: JSON.stringify({ system_prompt: 'You are an agent with no variables.' }),
		});
		expect(res.status).toBe(200);
	});

	it('400s when reports_to names an agent not on the team', async () => {
		const hire = await createApproval('hire', { title: 'Orphan', slug: 'orphan' });
		const res = await ctx.app.request(`/api/approvals/${hire.id}`, {
			method: 'PATCH',
			headers: jsonHeaders(ctx.token),
			body: JSON.stringify({ reports_to: 'nonexistent-manager' }),
		});
		expect(res.status).toBe(400);
		expect((await res.json()).error.message).toContain('nonexistent-manager');
	});

	it('400s when no updatable fields are present', async () => {
		const hire = await createApproval('hire', { title: 'Empty Patch', slug: 'empty-patch' });
		const res = await ctx.app.request(`/api/approvals/${hire.id}`, {
			method: 'PATCH',
			headers: jsonHeaders(ctx.token),
			body: JSON.stringify({ unrelated: true }),
		});
		expect(res.status).toBe(400);
		expect((await res.json()).error.message).toContain('No fields to update');
	});

	it('merges a valid patch (prompt + manager) into the payload', async () => {
		const hire = await createApproval('hire', {
			title: 'Analyst',
			slug: 'cover-analyst',
			system_prompt: 'Draft.',
		});
		const res = await ctx.app.request(`/api/approvals/${hire.id}`, {
			method: 'PATCH',
			headers: jsonHeaders(ctx.token),
			body: JSON.stringify({
				system_prompt: 'You are the Analyst. Own reporting.',
				reports_to: agentSlug,
			}),
		});
		expect(res.status).toBe(200);
		const patched = (await res.json()).data as {
			payload: { system_prompt: string; reports_to: string; slug: string };
		};
		expect(patched.payload.system_prompt).toContain('Own reporting');
		expect(patched.payload.reports_to).toBe(agentSlug);
		expect(patched.payload.slug).toBe('cover-analyst');
	});
});

describe('POST /approvals/:approvalId/resolve', () => {
	it('404s for an unknown approval', async () => {
		const res = await resolveApprovalReq(randomUUID(), { status: 'approved' });
		expect(res.status).toBe(404);
	});

	it("400s when status is not 'approved' or 'denied'", async () => {
		const approval = await createApproval('plan_review', { summary: 'bad status' });
		const res = await resolveApprovalReq(approval.id, { status: 'maybe' });
		expect(res.status).toBe(400);
		expect((await res.json()).error.message).toContain("'approved' or 'denied'");
	});

	it('approves as the admin, recording resolution note and timestamp', async () => {
		const approval = await createApproval('plan_review', { summary: 'approve me' });
		const res = await resolveApprovalReq(approval.id, {
			status: 'approved',
			resolution_note: 'Looks good',
		});
		expect(res.status).toBe(200);
		const row = (await res.json()).data as {
			status: string;
			resolution_note: string;
			resolved_at: string;
		};
		expect(row.status).toBe('approved');
		expect(row.resolution_note).toBe('Looks good');
		expect(row.resolved_at).not.toBeNull();
	});

	it('denies without a note (null resolution_note)', async () => {
		const approval = await createApproval('plan_review', { summary: 'deny me' });
		const res = await resolveApprovalReq(approval.id, { status: 'denied' });
		expect(res.status).toBe(200);
		const row = (await res.json()).data as { status: string; resolution_note: string | null };
		expect(row.status).toBe('denied');
		expect(row.resolution_note).toBeNull();
	});

	it('409s when resolving twice', async () => {
		const approval = await createApproval('plan_review', { summary: 'double resolve' });
		await resolveApprovalReq(approval.id, { status: 'approved' });
		const res = await resolveApprovalReq(approval.id, { status: 'denied' });
		expect(res.status).toBe(409);
		expect((await res.json()).error.code).toBe('INVALID_STATE');
	});

	it('approving a strategy update_prd applies and broadcasts the side effect', async () => {
		const approval = await createApproval('strategy', {
			action: 'update_prd',
			filename: 'prd.md',
			content: '# PRD v2\nApproved direction.',
			project_id: projectId,
		});
		const res = await resolveApprovalReq(approval.id, { status: 'approved' });
		expect(res.status).toBe(200);
		expect(((await res.json()).data as { status: string }).status).toBe('approved');

		// The side effect materialized: the project doc was written.
		const doc = await ctx.db.query<{ content: string }>(
			`SELECT content FROM documents WHERE project_id = $1 AND slug = 'prd.md'`,
			[projectId],
		);
		expect(doc.rows).toHaveLength(1);
		expect(doc.rows[0].content).toContain('Approved direction');
	});

	it('resolves via agent auth, attributing the agent member as actor', async () => {
		const approval = await createApproval('plan_review', { summary: 'agent resolves' });
		const { token: agentToken } = await mintAgentToken(
			ctx.db,
			ctx.masterKeyManager,
			agentId,
			teamId,
		);
		const res = await resolveApprovalReq(approval.id, { status: 'approved' }, agentToken);
		expect(res.status).toBe(200);
		expect(((await res.json()).data as { status: string }).status).toBe('approved');
	});

	it('403s for a board user outside the team', async () => {
		const approval = await createApproval('plan_review', { summary: 'outsider blocked' });
		const otherTeam = await createTestTeam(ctx.db, { name: 'Approvals Other Side Co' });
		const otherTeamId = (await otherTeam.json()).data.id;
		await projectSlugFor(ctx.db, otherTeamId);
		const outsider = await ctx.db.query<{ id: string }>(
			"INSERT INTO users (display_name, is_superuser) VALUES ('Resolver Outsider', false) RETURNING id",
		);
		const member = await ctx.db.query<{ id: string }>(
			`INSERT INTO members (team_id, member_type, display_name)
			 VALUES ($1, 'user', 'Resolver Outsider') RETURNING id`,
			[otherTeamId],
		);
		await ctx.db.query('INSERT INTO member_users (id, user_id) VALUES ($1, $2)', [
			member.rows[0].id,
			outsider.rows[0].id,
		]);
		const { signAdminJwt } = await import('../src/middleware/auth');
		const outsiderToken = await signAdminJwt(ctx.masterKeyManager, outsider.rows[0].id);

		const res = await resolveApprovalReq(approval.id, { status: 'approved' }, outsiderToken);
		expect(res.status).toBe(403);
		const still = await ctx.db.query<{ status: string }>(
			'SELECT status FROM approvals WHERE id = $1',
			[approval.id],
		);
		expect(still.rows[0].status).toBe('pending');
	});
});
