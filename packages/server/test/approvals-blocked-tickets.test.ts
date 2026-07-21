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
let otherTeamId: string;
let projectId: string;
let projectSlug: string;
let otherProjectSlug: string;
let approvalId: string;
let taskAId: string;
let taskBId: string;
let agentAId: string;
let agentBId: string;
let commentAId: string;
let commentBId: string;

async function createAgent(name: string, slug: string): Promise<string> {
	const r = await app.request(`/api/projects/${projectSlug}/agents`, {
		method: 'POST',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify({ title: name, slug }),
	});
	return (await r.json()).data.id;
}

async function createTask(title: string, assigneeId: string): Promise<string> {
	const r = await app.request(`/api/projects/${projectSlug}/tasks`, {
		method: 'POST',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify({ project_id: projectId, title, assignee_id: assigneeId }),
	});
	return (await r.json()).data.id;
}

async function insertActionComment(taskId: string, approvalRef: string): Promise<string> {
	const r = await db.query<{ id: string }>(
		`INSERT INTO task_comments (task_id, content_type, content)
		 VALUES ($1, 'action'::comment_content_type, $2::jsonb)
		 RETURNING id`,
		[taskId, JSON.stringify({ kind: 'setup_repo', approval_id: approvalRef })],
	);
	return r.rows[0].id;
}

async function insertTextComment(taskId: string, text: string): Promise<void> {
	await db.query(
		`INSERT INTO task_comments (task_id, content_type, content, created_at)
		 VALUES ($1, 'text'::comment_content_type, $2::jsonb, now() - INTERVAL '1 minute')`,
		[taskId, JSON.stringify({ text })],
	);
}

beforeAll(async () => {
	const ctx = await createTestApp();
	app = ctx.app;
	db = ctx.db;
	token = ctx.token;

	const typesRes = await app.request('/api/team-templates', { headers: authHeader(token) });
	const typeId = (await typesRes.json()).data.find(
		(t: { name: string }) => t.name === 'App Team',
	).id;

	const teamRes = await createTestTeam(db, { name: 'Blocked Co', template_id: typeId });
	teamId = (await teamRes.json()).data.id;

	const otherRes = await createTestTeam(db, { name: 'Other Co', template_id: typeId });
	const otherTeam = (await otherRes.json()).data;
	otherTeamId = otherTeam.id;
	otherProjectSlug = `${await projectSlugFor(db, otherTeam.id)}`;

	const projectRes = await createTestProject(db, teamId, { name: 'Repo Ops', description: 'ops' });
	const project = (await projectRes.json()).data;
	projectId = project.id;
	projectSlug = project.slug;

	agentAId = await createAgent('Alice Agent', 'alice');
	agentBId = await createAgent('Bob Agent', 'bob');

	taskAId = await createTask('Migrate to vNext', agentAId);
	taskBId = await createTask('Add CI workflow', agentBId);

	const approval = await db.query<{ id: string }>(
		`INSERT INTO approvals (team_id, type, status, payload)
		 VALUES ($1, 'designated_repo_request'::approval_type, 'pending'::approval_status, $2::jsonb)
		 RETURNING id`,
		[
			teamId,
			JSON.stringify({
				platform: 'github',
				reason: 'designated_repo',
				project_id: projectId,
				task_id: taskAId,
			}),
		],
	);
	approvalId = approval.rows[0].id;

	await insertTextComment(taskAId, 'I tried to push the new migration but there is no repo yet.');
	commentAId = await insertActionComment(taskAId, approvalId);
	commentBId = await insertActionComment(taskBId, approvalId);
});

afterAll(async () => {
	await safeClose(db);
});

describe('GET /api/teams/:teamId/approvals/:approvalId/blocked-tickets', () => {
	it('returns one row per pending setup_repo action comment, with agent and project info', async () => {
		const res = await app.request(
			`/api/projects/${projectSlug}/approvals/${approvalId}/blocked-tickets`,
			{
				headers: authHeader(token),
			},
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			data: Array<{
				task_id: string;
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

		const byTask = new Map(body.data.map((r) => [r.task_id, r]));
		const a = byTask.get(taskAId);
		const b = byTask.get(taskBId);
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
		await db.query(`UPDATE task_comments SET chosen_option = $1::jsonb WHERE id = $2`, [
			JSON.stringify({ status: 'complete' }),
			commentBId,
		]);

		const res = await app.request(
			`/api/projects/${projectSlug}/approvals/${approvalId}/blocked-tickets`,
			{
				headers: authHeader(token),
			},
		);
		const body = (await res.json()) as { data: Array<{ task_id: string }> };
		expect(body.data).toHaveLength(1);
		expect(body.data[0].task_id).toBe(taskAId);

		await db.query(`UPDATE task_comments SET chosen_option = NULL WHERE id = $1`, [commentBId]);
	});

	it('returns 404 if the approval does not belong to the team', async () => {
		const res = await app.request(
			`/api/projects/${otherProjectSlug}/approvals/${approvalId}/blocked-tickets`,
			{ headers: authHeader(token) },
		);
		expect(res.status).toBe(404);
	});

	it('returns 400 for non-designated_repo_request approvals', async () => {
		const other = await db.query<{ id: string }>(
			`INSERT INTO approvals (team_id, type, status, payload)
			 VALUES ($1, 'hire'::approval_type, 'pending'::approval_status, $2::jsonb)
			 RETURNING id`,
			[teamId, JSON.stringify({ title: 'New Agent', slug: 'new-agent' })],
		);
		const res = await app.request(
			`/api/projects/${projectSlug}/approvals/${other.rows[0].id}/blocked-tickets`,
			{ headers: authHeader(token) },
		);
		expect(res.status).toBe(400);
	});
});
