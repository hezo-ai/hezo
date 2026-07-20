import { ApprovalStatus, ApprovalType, GoalHealth, TaskStatus } from '@hezo/shared';
import type { Hono } from 'hono';
import { afterAll, beforeAll, expect, it } from 'vitest';
import type { Db } from '../src/db/database';
import type { Env } from '../src/lib/types';
import { safeClose } from './helpers';
import { authHeader, createTestApp, createTestProject, createTestTeam } from './helpers/app';

let app: Hono<Env>;
let db: Db;
let token: string;
let teamId: string;
let projectId: string;
let projectSlug: string;
let agentId: string;
let taskId: string;

beforeAll(async () => {
	const ctx = await createTestApp();
	app = ctx.app;
	db = ctx.db;
	token = ctx.token;

	const teamRes = await createTestTeam(db, { name: 'Dash Co' });
	teamId = (await teamRes.json()).data.id;

	const projectRes = await createTestProject(db, teamId, { name: 'Dashboard Demo' });
	const project = (await projectRes.json()).data;
	projectId = project.id;
	projectSlug = project.slug;

	const agentRes = await app.request(`/api/projects/${projectSlug}/agents`, {
		method: 'POST',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify({ title: 'Runner' }),
	});
	agentId = (await agentRes.json()).data.id;

	const taskRes = await app.request(`/api/projects/${projectSlug}/tasks`, {
		method: 'POST',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify({
			project_id: projectId,
			title: 'Ship dashboard',
			assignee_id: agentId,
		}),
	});
	taskId = (await taskRes.json()).data.id;

	await db.query(`UPDATE tasks SET status = $1::task_status WHERE id = $2`, [
		TaskStatus.InProgress,
		taskId,
	]);

	await db.query(
		`UPDATE projects SET progress_summary = $1, progress_summary_updated_at = now() WHERE id = $2`,
		['**On track.** Building the dashboard.', projectId],
	);

	await db.query(
		`INSERT INTO goals (team_id, project_id, title, measurement, actions, health, progress_percent)
		 VALUES ($1, $2, 'Launch MVP', 'Users onboarded', 'Ship features', $3::goal_health, 42)`,
		[teamId, projectId, GoalHealth.OnTrack],
	);

	await db.query(
		`INSERT INTO cost_entries (member_id, project_id, amount_cents) VALUES ($1, $2, 500)`,
		[agentId, projectId],
	);
	await db.query(
		`INSERT INTO cost_entries (member_id, project_id, amount_cents, created_at)
		 VALUES ($1, $2, 1200, now() - interval '3 days')`,
		[agentId, projectId],
	);
});

afterAll(async () => {
	await safeClose(db);
});

it('GET /projects/:projectId/dashboard returns aggregated project snapshot', async () => {
	const res = await app.request(`/api/projects/${projectSlug}/dashboard`, {
		headers: authHeader(token),
	});
	expect(res.status).toBe(200);
	const body = (await res.json()).data as {
		open_task_count: number;
		spend: { all_time_cents: number };
		budget: { daily: { spentCents: number } } | null;
		progress: { summary: string } | null;
		goals: Array<{ title: string }>;
		in_progress_tasks: Array<{ identifier: string; title: string }>;
		running_agents: Array<{ title: string }>;
		needs_you: unknown[];
		inbox_unread: number;
	};

	expect(body.open_task_count).toBeGreaterThanOrEqual(1);
	expect(body.budget?.daily.spentCents).toBe(500);
	expect(body.spend.all_time_cents).toBe(1700);
	expect(body.progress?.summary).toContain('On track');
	expect(body.goals).toHaveLength(1);
	expect(body.goals[0].title).toBe('Launch MVP');
	expect(body.in_progress_tasks.some((t) => t.title === 'Ship dashboard')).toBe(true);
	expect(body.running_agents).toEqual([]);
});

it('lists running agents with their active task', async () => {
	await db.query(
		`UPDATE member_agents SET runtime_status = 'active'::agent_runtime_status WHERE id = $1`,
		[agentId],
	);
	await db.query(
		`INSERT INTO heartbeat_runs (member_id, team_id, task_id, status, started_at)
		 VALUES ($1, $2, $3, 'running', now())`,
		[agentId, teamId, taskId],
	);

	const res = await app.request(`/api/projects/${projectSlug}/dashboard`, {
		headers: authHeader(token),
	});
	const body = (await res.json()).data as {
		running_agents_count: number;
		running_agents: Array<{
			title: string;
			task_identifier: string | null;
			task_in_current_project: boolean;
			run_status: string;
		}>;
	};
	expect(body.running_agents).toHaveLength(1);
	expect(body.running_agents_count).toBe(1);
	expect(body.running_agents[0].title).toBe('Runner');
	expect(body.running_agents[0].task_identifier).toBeTruthy();
	expect(body.running_agents[0].task_in_current_project).toBe(true);
	expect(body.running_agents[0].run_status).toBe('running');
});

it('excludes disabled agents from running count and list', async () => {
	await db.query(
		`UPDATE member_agents
		 SET runtime_status = 'active'::agent_runtime_status,
		     admin_status = 'disabled'::agent_admin_status
		 WHERE id = $1`,
		[agentId],
	);
	await db.query(`DELETE FROM heartbeat_runs WHERE member_id = $1`, [agentId]);
	await db.query(
		`INSERT INTO heartbeat_runs (member_id, team_id, task_id, status, started_at)
		 VALUES ($1, $2, $3, 'running', now())`,
		[agentId, teamId, taskId],
	);

	const res = await app.request(`/api/projects/${projectSlug}/dashboard`, {
		headers: authHeader(token),
	});
	const body = (await res.json()).data as {
		running_agents_count: number;
		running_agents: Array<{ id: string }>;
	};
	expect(body.running_agents).toEqual([]);
	expect(body.running_agents_count).toBe(0);

	// Restore for later tests.
	await db.query(
		`UPDATE member_agents
		 SET admin_status = 'enabled'::agent_admin_status,
		     runtime_status = 'idle'::agent_runtime_status
		 WHERE id = $1`,
		[agentId],
	);
	await db.query(`DELETE FROM heartbeat_runs WHERE member_id = $1`, [agentId]);
});

it('hides task link on running agents when the task is in another project', async () => {
	const otherTeamRes = await createTestTeam(db, { name: 'Other Co' });
	const otherTeamId = (await otherTeamRes.json()).data.id;
	const otherProjectRes = await createTestProject(db, otherTeamId, { name: 'Other Project' });
	const otherProject = (await otherProjectRes.json()).data;

	const otherTaskRes = await db.query<{ id: string; identifier: string }>(
		`INSERT INTO tasks (team_id, project_id, assignee_id, number, identifier, title, status)
		 VALUES ($1, $2, $3, 99, 'OTH-99', 'Cross-team work', $4::task_status)
		 RETURNING id, identifier`,
		[otherTeamId, otherProject.id, agentId, TaskStatus.InProgress],
	);
	const otherTaskId = otherTaskRes.rows[0].id;

	await db.query(
		`UPDATE member_agents SET runtime_status = 'active'::agent_runtime_status WHERE id = $1`,
		[agentId],
	);
	await db.query(`DELETE FROM heartbeat_runs WHERE member_id = $1`, [agentId]);
	await db.query(
		`INSERT INTO heartbeat_runs (member_id, team_id, task_id, status, started_at)
		 VALUES ($1, $2, $3, 'running', now())`,
		[agentId, teamId, otherTaskId],
	);

	const res = await app.request(`/api/projects/${projectSlug}/dashboard`, {
		headers: authHeader(token),
	});
	const body = (await res.json()).data as {
		running_agents: Array<{
			task_identifier: string | null;
			task_in_current_project: boolean;
		}>;
	};
	expect(body.running_agents).toHaveLength(1);
	expect(body.running_agents[0].task_identifier).toBe('OTH-99');
	expect(body.running_agents[0].task_in_current_project).toBe(false);
});

it('returns the same payload when :projectId is the project UUID', async () => {
	const res = await app.request(`/api/projects/${projectId}/dashboard`, {
		headers: authHeader(token),
	});
	expect(res.status).toBe(200);
	const body = (await res.json()).data as { spend: { all_time_cents: number } };
	expect(body.spend.all_time_cents).toBe(1700);
});

it('includes pending hire approvals with no project_id or task_id', async () => {
	await db.query(
		`INSERT INTO approvals (team_id, type, requested_by_member_id, payload, status)
		 VALUES ($1, $2::approval_type, $3, $4::jsonb, $5::approval_status)`,
		[
			teamId,
			ApprovalType.Hire,
			agentId,
			JSON.stringify({
				title: 'Designer',
				slug: 'designer',
				role_description: 'Designs things',
				system_prompt: '',
				reports_to: null,
				default_effort: 'medium',
				heartbeat_interval_min: 30,
				daily_budget_cents: 0,
				weekly_budget_cents: 0,
				monthly_budget_cents: 3000,
				touches_code: false,
			}),
			ApprovalStatus.Pending,
		],
	);

	const res = await app.request(`/api/projects/${projectSlug}/dashboard`, {
		headers: authHeader(token),
	});
	const body = (await res.json()).data as {
		needs_you: Array<{ kind: string; approval?: { type: string } }>;
		inbox_unread: number;
	};
	expect(body.needs_you.some((n) => n.kind === 'approval' && n.approval?.type === 'hire')).toBe(
		true,
	);
	expect(body.inbox_unread).toBeGreaterThanOrEqual(1);
});

it('includes hire approvals whose payload task_id no longer resolves', async () => {
	const missingTaskId = '00000000-0000-4000-8000-000000000099';
	await db.query(
		`INSERT INTO approvals (team_id, type, requested_by_member_id, payload, status)
		 VALUES ($1, $2::approval_type, $3, $4::jsonb, $5::approval_status)`,
		[
			teamId,
			ApprovalType.Hire,
			agentId,
			JSON.stringify({
				title: 'Orphaned Hire',
				slug: 'orphaned-hire',
				role_description: 'Was linked to a deleted task',
				system_prompt: '',
				reports_to: null,
				default_effort: 'medium',
				heartbeat_interval_min: 30,
				daily_budget_cents: 0,
				weekly_budget_cents: 0,
				monthly_budget_cents: 3000,
				touches_code: false,
				task_id: missingTaskId,
			}),
			ApprovalStatus.Pending,
		],
	);

	const res = await app.request(`/api/projects/${projectSlug}/dashboard`, {
		headers: authHeader(token),
	});
	const body = (await res.json()).data as {
		needs_you: Array<{
			kind: string;
			approval?: { type: string; requested_by_name: string | null };
		}>;
	};
	expect(body.needs_you.some((n) => n.kind === 'approval' && n.approval?.type === 'hire')).toBe(
		true,
	);
});

it('includes pending credential requests in needs_you', async () => {
	await db.query(
		`INSERT INTO task_comments (task_id, author_member_id, content_type, content)
		 VALUES ($1, $2, 'credential_request'::comment_content_type, $3::jsonb)
		 RETURNING id`,
		[
			taskId,
			agentId,
			JSON.stringify({
				name: 'DASH_API_KEY',
				kind: 'api_key',
				instructions: 'Need a key.',
			}),
		],
	);

	const res = await app.request(`/api/projects/${projectSlug}/dashboard`, {
		headers: authHeader(token),
	});
	const body = (await res.json()).data as {
		needs_you: Array<{ kind: string; credential?: { credential_name: string } }>;
		inbox_unread: number;
	};
	expect(body.needs_you.some((n) => n.kind === 'credential')).toBe(true);
	expect(body.needs_you.find((n) => n.kind === 'credential')?.credential?.credential_name).toBe(
		'DASH_API_KEY',
	);
	expect(body.inbox_unread).toBeGreaterThanOrEqual(1);
});

it('returns a minimal HQ dashboard without spend, progress, or goals', async () => {
	const hq = await db.query<{ id: string; slug: string }>(
		`SELECT id, slug FROM projects WHERE is_internal = true LIMIT 1`,
	);
	expect(hq.rows).toHaveLength(1);

	const res = await app.request(`/api/projects/${hq.rows[0].slug}/dashboard`, {
		headers: authHeader(token),
	});
	expect(res.status).toBe(200);
	const body = (await res.json()).data as {
		is_internal: boolean;
		budget: unknown;
		progress: unknown;
		goals: unknown[];
		spend: { all_time_cents: number };
	};
	expect(body.is_internal).toBe(true);
	expect(body.budget).toBeNull();
	expect(body.progress).toBeNull();
	expect(body.goals).toEqual([]);
	expect(body.spend.all_time_cents).toBe(0);
});

it('includes unread mentions when :projectId is the project UUID', async () => {
	const admin = await db.query<{ id: string }>(
		`SELECT id FROM users WHERE is_superuser = true ORDER BY created_at LIMIT 1`,
	);
	const comment = await db.query<{ id: string; public_id: string }>(
		`INSERT INTO task_comments (task_id, author_member_id, content_type, content)
		 VALUES ($1, $2, 'text'::comment_content_type, $3::jsonb)
		 RETURNING id, public_id`,
		[taskId, agentId, JSON.stringify({ text: '@admin please review the dashboard' })],
	);
	await db.query(
		`INSERT INTO admin_mentions (team_id, task_id, comment_id, user_id)
		 VALUES ($1, $2, $3, $4)`,
		[teamId, taskId, comment.rows[0].id, admin.rows[0].id],
	);

	const bySlug = await app.request(`/api/projects/${projectSlug}/dashboard`, {
		headers: authHeader(token),
	});
	const byUuid = await app.request(`/api/projects/${projectId}/dashboard`, {
		headers: authHeader(token),
	});
	expect(bySlug.status).toBe(200);
	expect(byUuid.status).toBe(200);

	const slugBody = (await bySlug.json()).data as {
		needs_you: Array<{ kind: string; mention?: { comment_public_id: string } }>;
	};
	const uuidBody = (await byUuid.json()).data as {
		needs_you: Array<{ kind: string; mention?: { comment_public_id: string } }>;
	};

	const mentionOnSlug = slugBody.needs_you.find((n) => n.kind === 'mention');
	const mentionOnUuid = uuidBody.needs_you.find((n) => n.kind === 'mention');
	expect(mentionOnSlug?.mention?.comment_public_id).toBe(comment.rows[0].public_id);
	expect(mentionOnUuid?.mention?.comment_public_id).toBe(comment.rows[0].public_id);
});

it('returns 404 for unknown project', async () => {
	const res = await app.request('/api/projects/missing-project/dashboard', {
		headers: authHeader(token),
	});
	expect(res.status).toBe(404);
});
