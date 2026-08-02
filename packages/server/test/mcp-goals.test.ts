import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MasterKeyManager } from '../src/crypto/master-key';
import type { Db } from '../src/db/database';
import type { Env } from '../src/lib/types';
import { safeClose } from './helpers';
import {
	authHeader,
	createTestApp,
	createTestProject,
	createTestTeam,
	mintAgentToken,
} from './helpers/app';

let app: Hono<Env>;
let db: Db;
let token: string;
let masterKeyManager: MasterKeyManager;
let teamId: string;
let projectId: string;
let projectSlug: string;
let captainAgentId: string;
let goalId: string;

beforeAll(async () => {
	const ctx = await createTestApp();
	app = ctx.app;
	db = ctx.db;
	token = ctx.token;
	masterKeyManager = ctx.masterKeyManager;

	const typesRes = await app.request('/api/team-templates', { headers: authHeader(token) });
	const typeId = (await typesRes.json()).data.find(
		(t: { name: string }) => t.name === 'App Team',
	).id;
	const teamRes = await createTestTeam(db, { name: 'MCP Goals Co', template_id: typeId });
	teamId = (await teamRes.json()).data.id;

	const projectRes = await createTestProject(db, teamId, { name: 'MCP Goals Project' });
	const project = (await projectRes.json()).data;
	projectId = project.id;
	projectSlug = project.slug;

	const captain = await db.query<{ id: string }>(
		`SELECT ma.id FROM member_agents ma JOIN members m ON m.id = ma.id
		 WHERE m.team_id = $1 AND ma.slug = 'captain' LIMIT 1`,
		[teamId],
	);
	captainAgentId = captain.rows[0].id;

	const goalRes = await app.request(`/api/projects/${projectSlug}/goals`, {
		method: 'POST',
		headers: { ...authHeader(token), 'content-type': 'application/json' },
		body: JSON.stringify({ title: 'Grow MRR to $10k', check_frequency: 'daily' }),
	});
	goalId = (await goalRes.json()).data.id;
});

afterAll(async () => {
	await safeClose(db);
});

async function callTool(
	bearer: string,
	toolName: string,
	args: Record<string, unknown>,
): Promise<unknown> {
	const res = await app.request('/mcp', {
		method: 'POST',
		headers: { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json' },
		body: JSON.stringify({
			jsonrpc: '2.0',
			method: 'tools/call',
			params: { name: toolName, arguments: args },
			id: 1,
		}),
	});
	const body = (await res.json()) as { result: { content: Array<{ text: string }> } };
	return JSON.parse(body.result.content[0].text);
}

describe('MCP goals tools', () => {
	it('registers list_goals and update_goal_progress', async () => {
		const res = await app.request('/mcp', {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ jsonrpc: '2.0', method: 'tools/list', id: 1 }),
		});
		const names = (await res.json()).result.tools.map((t: { name: string }) => t.name);
		expect(names).toContain('list_goals');
		expect(names).toContain('update_goal_progress');
	});

	it('list_goals returns the project goals', async () => {
		const goals = (await callTool(token, 'list_goals', { project: projectSlug })) as Array<{
			id: string;
		}>;
		expect(goals.map((g) => g.id)).toContain(goalId);
	});

	it('update_goal_progress is rejected for a non-run caller', async () => {
		const result = (await callTool(token, 'update_goal_progress', {
			project: projectSlug,
			goal_id: goalId,
			progress_percent: 20,
			health: 'on_track',
			status_blurb: 'Early days',
		})) as { error?: string };
		expect(result.error).toMatch(/within an agent run/);
	});

	it('update_goal_progress records progress from a Captain run', async () => {
		const agent = await mintAgentToken(db, masterKeyManager, captainAgentId, teamId, null, {
			projectId,
		});
		const updated = (await callTool(agent.token, 'update_goal_progress', {
			project: projectSlug,
			goal_id: goalId,
			progress_percent: 45,
			health: 'at_risk',
			status_blurb: 'Churn is up; need a retention push.',
		})) as { progress_percent: number; health: string; last_checked_at: string | null };
		expect(updated.progress_percent).toBe(45);
		expect(updated.health).toBe('at_risk');
		expect(updated.last_checked_at).not.toBeNull();

		// The snapshot is linked to the run, so it shows in the goal's history.
		const goals = (await callTool(token, 'list_goals', { project: projectSlug })) as Array<{
			id: string;
			history: Array<{ percent: number }>;
		}>;
		const goal = goals.find((g) => g.id === goalId);
		expect(goal?.history.at(-1)?.percent).toBe(45);
	});
});

describe('MCP project progress + goal run activity', () => {
	it('registers update_project_progress', async () => {
		const res = await app.request('/mcp', {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ jsonrpc: '2.0', method: 'tools/list', id: 1 }),
		});
		const names = (await res.json()).result.tools.map((t: { name: string }) => t.name);
		expect(names).toContain('update_project_progress');
	});

	it('update_project_progress is rejected for a non-run caller', async () => {
		const result = (await callTool(token, 'update_project_progress', {
			project: projectSlug,
			summary: 'Should not stick',
		})) as { error?: string };
		expect(result.error).toMatch(/within an agent run/);
	});

	it('update_project_progress from a Captain run is shown by GET /progress', async () => {
		const agent = await mintAgentToken(db, masterKeyManager, captainAgentId, teamId, null, {
			projectId,
		});
		const updated = (await callTool(agent.token, 'update_project_progress', {
			project: projectSlug,
			summary: '**On track.** Onboarding shipped; billing next.',
		})) as { summary: string; updated_at: string | null };
		expect(updated.summary).toContain('On track');
		expect(updated.updated_at).not.toBeNull();

		const res = await app.request(`/api/projects/${projectSlug}/progress`, {
			headers: authHeader(token),
		});
		expect(res.status).toBe(200);
		expect((await res.json()).data.summary).toContain('Onboarding shipped');
	});

	// The summary and the three columns are one artifact from one run: written together, read
	// together, and sharing a single `updated_at`.
	it('writes the activity columns alongside the summary in one call', async () => {
		const identifier = (
			await db.query<{ identifier: string }>(
				`INSERT INTO tasks (team_id, project_id, number, identifier, title, status, priority, labels)
				 VALUES ($1, $2, 9100, 'BILL-1', 'Ship the billing split', 'in_progress'::task_status,
				         'medium'::task_priority, '[]'::jsonb)
				 RETURNING identifier`,
				[teamId, projectId],
			)
		).rows[0].identifier;

		const agent = await mintAgentToken(db, masterKeyManager, captainAgentId, teamId, null, {
			projectId,
		});
		const updated = (await callTool(agent.token, 'update_project_progress', {
			project: projectSlug,
			summary: '**Billing is the long pole.**',
			actioned: [{ task: identifier, summary: 'Payments can now take live cards end to end.' }],
			closed: [{ task: 'ZZ-404', summary: 'This task does not exist.' }],
		})) as {
			activity: { actioned: { identifier: string; title: string; summary: string }[] };
			unknown_tasks?: string[];
		};

		expect(updated.activity.actioned[0].identifier).toBe(identifier);
		expect(updated.activity.actioned[0].title).toBe('Ship the billing split');
		// An identifier that does not resolve comes back rather than vanishing.
		expect(updated.unknown_tasks).toEqual(['ZZ-404']);

		const res = await app.request(`/api/projects/${projectSlug}/progress`, {
			headers: authHeader(token),
		});
		const body = (await res.json()).data;
		expect(body.summary).toContain('Billing is the long pole');
		expect(body.activity.actioned[0].summary).toBe('Payments can now take live cards end to end.');
		expect(body.activity.closed).toEqual([]);
	});

	// A caller refreshing only the summary must not blank the columns beneath it.
	it('leaves the stored columns alone when no lists are passed', async () => {
		const agent = await mintAgentToken(db, masterKeyManager, captainAgentId, teamId, null, {
			projectId,
		});
		await callTool(agent.token, 'update_project_progress', {
			project: projectSlug,
			summary: '**Summary only.**',
		});

		const res = await app.request(`/api/projects/${projectSlug}/progress`, {
			headers: authHeader(token),
		});
		const body = (await res.json()).data;
		expect(body.summary).toContain('Summary only');
		expect(body.activity.actioned.length).toBe(1);
	});

	it('surfaces a run that created a task and commented on it for the goal', async () => {
		// A fresh goal so the feed reflects only this run's activity.
		const goalRes = await app.request(`/api/projects/${projectSlug}/goals`, {
			method: 'POST',
			headers: { ...authHeader(token), 'content-type': 'application/json' },
			body: JSON.stringify({ title: 'Launch the beta', check_frequency: 'daily' }),
		});
		const feedGoalId = (await goalRes.json()).data.id as string;

		// One Captain run: estimate the goal, and comment on a task linked to it. The task is
		// seeded directly with created_by_run_id = this run, so the feed shows both the created
		// task and the comment attribution (create_comment sets created_by_run_id over MCP).
		const agent = await mintAgentToken(db, masterKeyManager, captainAgentId, teamId, null, {
			projectId,
		});
		// The scheduler tags progress-update runs with kind='progress_update'; mintAgentToken makes a
		// generic task-kind run, so mark it to mirror a real progress-update run.
		await db.query(
			`UPDATE heartbeat_runs SET kind = 'progress_update'::heartbeat_run_kind WHERE id = $1`,
			[agent.runId],
		);
		const task = (
			await db.query<{ id: string; identifier: string }>(
				`INSERT INTO tasks (team_id, project_id, number, identifier, title, status, priority, labels, goal_id, created_by_run_id)
				 VALUES ($1, $2, 9001, 'BETA-1', 'Stand up the beta signup', 'backlog'::task_status, 'medium'::task_priority, '[]'::jsonb, $3, $4)
				 RETURNING id, identifier`,
				[teamId, projectId, feedGoalId, agent.runId],
			)
		).rows[0];
		await callTool(agent.token, 'update_goal_progress', {
			project: projectSlug,
			goal_id: feedGoalId,
			progress_percent: 15,
			health: 'on_track',
			status_blurb: 'Kicking off the beta work.',
		});
		await callTool(agent.token, 'create_comment', {
			project: projectSlug,
			task_id: task.id,
			content: 'Prioritise the signup funnel first.',
		});

		const res = await app.request(`/api/projects/${projectSlug}/goals/${feedGoalId}/runs`, {
			headers: authHeader(token),
		});
		expect(res.status).toBe(200);
		const runs = (await res.json()).data as Array<{
			id: string;
			progress: { progress_percent: number } | null;
			created_tasks: Array<{ identifier: string }>;
			commented_tasks: Array<{ identifier: string; comment_count: number }>;
		}>;
		const entry = runs.find((r) => r.id === agent.runId);
		expect(entry).toBeTruthy();
		expect(entry?.progress?.progress_percent).toBe(15);
		expect(entry?.created_tasks.map((t) => t.identifier)).toContain(task.identifier);
		expect(entry?.commented_tasks.map((t) => t.identifier)).toContain(task.identifier);
		expect(
			entry?.commented_tasks.find((t) => t.identifier === task.identifier)?.comment_count,
		).toBe(1);
	});
});

describe('MCP suggest_goal', () => {
	it('registers suggest_goal', async () => {
		const res = await app.request('/mcp', {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ jsonrpc: '2.0', method: 'tools/list', id: 1 }),
		});
		const tools = (await res.json()).result.tools as { name: string; description: string }[];
		const suggestGoal = tools.find((t) => t.name === 'suggest_goal');
		expect(suggestGoal).toBeDefined();
		// The description must carry the doctrine: goals are admin-elicited outcomes or
		// milestones; activity-shaped recurring work ("do X every day/week") is a standing
		// task, not a goal. Without it, agents file cron jobs and one-off deliverables as
		// goals that then get cadence-checked forever.
		expect(suggestGoal?.description).toContain('OUTCOME or MILESTONE');
		expect(suggestGoal?.description).toContain('it is NOT a goal');
		expect(suggestGoal?.description).toContain('standing task');
		expect(suggestGoal?.description).toContain(
			'ask the admin what they want the project to achieve',
		);
	});

	it('is rejected for a non-agent caller', async () => {
		const result = (await callTool(token, 'suggest_goal', {
			project: projectSlug,
			title: 'Should not stick',
		})) as { error?: string };
		expect(result.error).toMatch(/only callable by agents/);
	});

	it('is rejected for a non-Captain agent run', async () => {
		const architect = await db.query<{ id: string }>(
			`SELECT ma.id FROM member_agents ma JOIN members m ON m.id = ma.id
			 WHERE m.team_id = $1 AND ma.slug = 'architect' LIMIT 1`,
			[teamId],
		);
		const agent = await mintAgentToken(db, masterKeyManager, architect.rows[0].id, teamId, null, {
			projectId,
		});
		const result = (await callTool(agent.token, 'suggest_goal', {
			project: projectSlug,
			title: 'Architect should not suggest goals',
		})) as { error?: string };
		expect(result.error).toMatch(/Only the Captain or CEO/);
	});

	it('files a pending suggestion (not a goal) and materialises it on admin approval', async () => {
		const agent = await mintAgentToken(db, masterKeyManager, captainAgentId, teamId, null, {
			projectId,
		});
		const suggested = (await callTool(agent.token, 'suggest_goal', {
			project: projectSlug,
			title: 'Reach 5k Instagram followers',
			measurement: '5000 followers on the connected Instagram account',
			check_frequency: 'weekly',
			target_date: '2026-12-31',
		})) as { approval_id: string; status: string };
		expect(suggested.status).toBe('pending');

		// A suggestion is NOT a goal yet — list_goals doesn't include it.
		const before = (await callTool(token, 'list_goals', { project: projectSlug })) as Array<{
			title: string;
		}>;
		expect(before.map((g) => g.title)).not.toContain('Reach 5k Instagram followers');

		// It shows on the project's suggestions endpoint.
		const suggestionsRes = await app.request(`/api/projects/${projectSlug}/goals/suggestions`, {
			headers: authHeader(token),
		});
		const suggestions = (await suggestionsRes.json()).data as Array<{
			approval_id: string;
			title: string;
		}>;
		expect(suggestions.map((s) => s.approval_id)).toContain(suggested.approval_id);

		// The admin approves the suggestion → the real goal is created.
		const resolveRes = await app.request(`/api/approvals/${suggested.approval_id}/resolve`, {
			method: 'POST',
			headers: { ...authHeader(token), 'content-type': 'application/json' },
			body: JSON.stringify({ status: 'approved' }),
		});
		expect(resolveRes.status).toBe(200);

		const after = (await callTool(token, 'list_goals', { project: projectSlug })) as Array<{
			title: string;
			check_frequency: string;
		}>;
		const goal = after.find((g) => g.title === 'Reach 5k Instagram followers');
		expect(goal).toBeTruthy();
		expect(goal?.check_frequency).toBe('weekly');

		// And it's no longer pending on the suggestions endpoint.
		const afterSuggestionsRes = await app.request(
			`/api/projects/${projectSlug}/goals/suggestions`,
			{ headers: authHeader(token) },
		);
		const afterSuggestions = (await afterSuggestionsRes.json()).data as Array<{
			approval_id: string;
		}>;
		expect(afterSuggestions.map((s) => s.approval_id)).not.toContain(suggested.approval_id);
	});
});
