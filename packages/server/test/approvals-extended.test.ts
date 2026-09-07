import { ApprovalType } from '@hezo/shared';
import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../src/db/database';
import type { Env } from '../src/lib/types';
import { safeClose } from './helpers';
import {
	authHeader,
	createTestApp,
	createTestProject,
	createTestTeam,
	projectSlugFor,
} from './helpers/app';

let app: Hono<Env>;
let db: Db;
let token: string;
let teamId: string;
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
		(t: Record<string, unknown>) => t.name === 'App Team',
	).id;

	const teamRes = await createTestTeam(db, {
		name: 'Approval Extended Co',
		template_id: typeId,
	});
	const team = (await teamRes.json()).data;
	teamId = team.id;
	// Name the team's one project to match what the enrichment test asserts on.
	projectSlug = (
		await (await createTestProject(db, team.id, { name: 'Enriched Test Project' })).json()
	).data.slug;

	const agentsRes = await app.request(`/api/projects/${projectSlug}/agents`, {
		headers: authHeader(token),
	});
	agentId = (await agentsRes.json()).data[0].id;
});

afterAll(async () => {
	await safeClose(db);
});

describe('GET /teams/:teamId/approvals enriched fields', () => {
	it('returns team_slug and resolved payload references', async () => {
		// Create a project so we can reference it in the payload
		const projRes = await createTestProject(db, teamId, {
			name: 'Enriched Test Project',
			description: 'For enrichment testing',
		});
		expect(projRes.status).toBe(201);
		const project = (await projRes.json()).data;

		// Create an approval with member_id and project_id in the payload
		const createRes = await app.request(`/api/projects/${projectSlug}/approvals`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				type: ApprovalType.PlanReview,
				requested_by_member_id: agentId,
				payload: {
					member_id: agentId,
					summary: 'ENRICH_TEST',
					project_id: project.id,
					reason: 'testing enriched fields',
				},
			}),
		});
		expect(createRes.status).toBe(201);

		const listRes = await app.request(`/api/projects/${projectSlug}/approvals`, {
			headers: authHeader(token),
		});
		expect(listRes.status).toBe(200);
		const rows = (await listRes.json()).data as any[];
		const row = rows.find(
			(r: any) => r.type === 'plan_review' && r.payload?.summary === 'ENRICH_TEST',
		);
		expect(row).toBeDefined();

		expect(row.team_slug).toBeTruthy();
		expect(row.payload_member_name).toBeTruthy();
		expect(row.payload_member_slug).toBeTruthy();
		expect(row.payload_project_name).toBe('Enriched Test Project');
		expect(row.payload_project_slug).toBeTruthy();
	});

	it('returns null for resolved fields when payload UUIDs are absent', async () => {
		const createRes = await app.request(`/api/projects/${projectSlug}/approvals`, {
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

		const listRes = await app.request(`/api/projects/${projectSlug}/approvals`, {
			headers: authHeader(token),
		});
		const rows = (await listRes.json()).data as any[];
		const row = rows.find(
			(r: any) => r.type === 'skill_proposal' && r.payload?.skill_slug === 'test-skill',
		);
		expect(row).toBeDefined();

		expect(row.team_slug).toBeTruthy();
		expect(row.payload_member_name).toBeNull();
		expect(row.payload_member_slug).toBeNull();
		expect(row.payload_project_name).toBeNull();
		expect(row.payload_project_slug).toBeNull();
		expect(row.payload_task_identifier).toBeNull();
	});
});

// The run pipeline files these as `strategy` rows carrying an `agent_error`
// payload, and it never writes `project_id` - so the two fields the inbox card
// needs to open the run that failed both come off the task join.
describe('GET approvals: the agent-error notice projection', () => {
	it('resolves the task project and the run entry, leaving payload_project_slug alone', async () => {
		const RUN_ID = '9f1d0000-0000-0000-0000-0000000000aa';
		const project = (
			await db.query<{ id: string; slug: string }>(
				'SELECT id, slug FROM projects WHERE slug = $1',
				[projectSlug],
			)
		).rows[0];

		const task = (
			await db.query<{ id: string; identifier: string }>(
				`INSERT INTO tasks (team_id, project_id, number, identifier, title)
				 VALUES ($1, $2, 9001, 'ENR-9001', 'Refused task')
				 RETURNING id, identifier`,
				[teamId, project.id],
			)
		).rows[0];
		const runComment = (
			await db.query<{ public_id: string }>(
				`INSERT INTO task_comments (task_id, author_member_id, content_type, content)
				 VALUES ($1, $2, 'run', $3::jsonb)
				 RETURNING public_id`,
				[task.id, agentId, JSON.stringify({ run_id: RUN_ID, agent_id: agentId })],
			)
		).rows[0];

		await db.query(
			`INSERT INTO approvals (team_id, type, requested_by_member_id, payload)
			 VALUES ($1, $2::approval_type, $3, $4::jsonb)`,
			[
				teamId,
				ApprovalType.Strategy,
				agentId,
				JSON.stringify({
					type: 'agent_error',
					member_id: agentId,
					run_id: RUN_ID,
					task_id: task.id,
					message: 'PROJECTION_TEST',
				}),
			],
		);

		const listRes = await app.request(`/api/projects/${projectSlug}/approvals`, {
			headers: authHeader(token),
		});
		const rows = (await listRes.json()).data as any[];
		const row = rows.find((r: any) => r.payload?.message === 'PROJECTION_TEST');
		expect(row).toBeDefined();

		expect(row.payload_task_identifier).toBe(task.identifier);
		// The slug a task link must route through. `team_slug` is a different
		// string and resolves against nothing.
		expect(row.payload_task_project_slug).toBe(project.slug);
		expect(row.payload_run_comment_public_id).toBe(runComment.public_id);
		// The pre-existing field keeps its meaning - the OAuth and hire
		// destinations read it, and this payload carries no `project_id`.
		expect(row.payload_project_slug).toBeNull();
	});

	it('leaves the run anchor null when the run left no entry in the thread', async () => {
		const project = (
			await db.query<{ id: string }>('SELECT id FROM projects WHERE slug = $1', [projectSlug])
		).rows[0];
		const task = (
			await db.query<{ id: string }>(
				`INSERT INTO tasks (team_id, project_id, number, identifier, title)
				 VALUES ($1, $2, 9002, 'ENR-9002', 'Anchorless task')
				 RETURNING id`,
				[teamId, project.id],
			)
		).rows[0];

		await db.query(
			`INSERT INTO approvals (team_id, type, requested_by_member_id, payload)
			 VALUES ($1, $2::approval_type, $3, $4::jsonb)`,
			[
				teamId,
				ApprovalType.Strategy,
				agentId,
				JSON.stringify({
					type: 'agent_error',
					member_id: agentId,
					run_id: null,
					task_id: task.id,
					message: 'NO_RUN_ENTRY',
				}),
			],
		);

		const listRes = await app.request(`/api/projects/${projectSlug}/approvals`, {
			headers: authHeader(token),
		});
		const rows = (await listRes.json()).data as any[];
		const row = rows.find((r: any) => r.payload?.message === 'NO_RUN_ENTRY');
		expect(row).toBeDefined();
		expect(row.payload_run_comment_public_id).toBeNull();
		// The task is still reachable; only the anchor is missing.
		expect(row.payload_task_project_slug).toBeTruthy();
	});
});

describe('POST /teams/:teamId/approvals validation', () => {
	it('returns 400 when type is missing', async () => {
		const res = await app.request(`/api/projects/${projectSlug}/approvals`, {
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
		const res = await app.request(`/api/projects/${projectSlug}/approvals`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				type: 'plan_review',
				requested_by_member_id: agentId,
			}),
		});
		expect(res.status).toBe(400);
	});
});

describe('GET /teams/:teamId/approvals status filtering', () => {
	let pendingApprovalId: string;
	let approvedApprovalId: string;

	beforeAll(async () => {
		// Create a pending approval (leave it pending)
		const pendingRes = await app.request(`/api/projects/${projectSlug}/approvals`, {
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
		const toApproveRes = await app.request(`/api/projects/${projectSlug}/approvals`, {
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
		const res = await app.request(`/api/projects/${projectSlug}/approvals`, {
			headers: authHeader(token),
		});
		expect(res.status).toBe(200);
		const rows = (await res.json()).data as Array<{ id: string; status: string }>;
		expect(rows.every((r) => r.status === 'pending')).toBe(true);
		expect(rows.some((r) => r.id === pendingApprovalId)).toBe(true);
		expect(rows.some((r) => r.id === approvedApprovalId)).toBe(false);
	});

	it('returns only approved approvals when ?status=approved', async () => {
		const res = await app.request(`/api/projects/${projectSlug}/approvals?status=approved`, {
			headers: authHeader(token),
		});
		expect(res.status).toBe(200);
		const rows = (await res.json()).data as Array<{ id: string; status: string }>;
		expect(rows.every((r) => r.status === 'approved')).toBe(true);
		expect(rows.some((r) => r.id === approvedApprovalId)).toBe(true);
		expect(rows.some((r) => r.id === pendingApprovalId)).toBe(false);
	});

	it('returns both pending and approved when ?status=pending,approved', async () => {
		const res = await app.request(
			`/api/projects/${projectSlug}/approvals?status=pending,approved`,
			{
				headers: authHeader(token),
			},
		);
		expect(res.status).toBe(200);
		const rows = (await res.json()).data as Array<{ id: string; status: string }>;
		const ids = rows.map((r) => r.id);
		expect(ids).toContain(pendingApprovalId);
		expect(ids).toContain(approvedApprovalId);
	});
});

describe('Deny flow', () => {
	it('sets status to denied and does NOT apply side effects', async () => {
		const createRes = await app.request(`/api/projects/${projectSlug}/approvals`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				type: ApprovalType.SkillProposal,
				requested_by_member_id: agentId,
				payload: {
					skill_name: 'Deny Test',
					skill_slug: 'deny-test',
					content: 'should not be applied',
					reason: 'testing deny flow',
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

		const skill = await db.query<{ id: string }>(`SELECT id FROM skills WHERE slug = $1`, [
			'deny-test',
		]);
		expect(skill.rows.length).toBe(0);
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
		const createRes = await app.request(`/api/projects/${projectSlug}/approvals`, {
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
