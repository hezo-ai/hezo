import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../src/db/database';
import type { Env } from '../src/lib/types';
import { safeClose } from './helpers';
import { authHeader, createTestApp, createTestTeam, projectSlugFor } from './helpers/app';

let app: Hono<Env>;
let db: Db;
let token: string;
let projectSlug: string;
let projectId: string;
let teamId: string;
let agentId: string;

async function fetchAgent(): Promise<Record<string, unknown>> {
	const res = await app.request(`/api/projects/${projectSlug}/agents/${agentId}`, {
		headers: authHeader(token),
	});
	expect(res.status).toBe(200);
	return (await res.json()).data as Record<string, unknown>;
}

async function insertTask(assigneeId: string | null, status = 'backlog'): Promise<string> {
	const meta = await db.query<{ task_prefix: string; number: number }>(
		`SELECT p.task_prefix, next_project_task_number(p.id) AS number
		 FROM projects p WHERE p.id = $1`,
		[projectId],
	);
	const n = meta.rows[0].number;
	const res = await db.query<{ id: string }>(
		`INSERT INTO tasks (team_id, project_id, assignee_id, number, identifier, title, status, priority, labels)
		 VALUES ($1, $2, $3, $4, $5, 'Work', $6::task_status, 'medium'::task_priority, '[]'::jsonb)
		 RETURNING id`,
		[teamId, projectId, assigneeId, n, `${meta.rows[0].task_prefix}-${n}`, status],
	);
	return res.rows[0].id;
}

beforeAll(async () => {
	const ctx = await createTestApp();
	app = ctx.app;
	db = ctx.db;
	token = ctx.token;

	const typesRes = await app.request('/api/team-templates', { headers: authHeader(token) });
	const typeId = (await typesRes.json()).data.find(
		(t: Record<string, unknown>) => t.name === 'App Team',
	).id;
	const teamRes = await createTestTeam(db, { name: 'Heartbeat Co', template_id: typeId });
	const team = (await teamRes.json()).data;
	teamId = team.id;
	projectSlug = await projectSlugFor(db, team.id);
	const projectRow = await db.query<{ id: string }>('SELECT id FROM projects WHERE slug = $1', [
		projectSlug,
	]);
	projectId = projectRow.rows[0].id;

	const listRes = await app.request(`/api/projects/${projectSlug}/agents`, {
		headers: authHeader(token),
	});
	const agents = (await listRes.json()).data as Array<Record<string, unknown>>;
	const agent = agents.find((a) => !a.is_instance && a.admin_status === 'enabled');
	expect(agent).toBeDefined();
	agentId = agent!.id as string;
});

afterAll(async () => {
	await safeClose(db);
});

describe('agents API next_heartbeat_at', () => {
	it('is last_heartbeat_at + configured interval for an enabled agent', async () => {
		await db.query(
			`UPDATE member_agents SET last_heartbeat_at = $2, heartbeat_interval_min = 90 WHERE id = $1`,
			[agentId, '2026-01-01T00:00:00Z'],
		);
		const agent = await fetchAgent();
		// interval 90 > floor 60, so the 90-minute cadence wins.
		expect(Date.parse(agent.next_heartbeat_at as string)).toBe(Date.parse('2026-01-01T01:30:00Z'));
	});

	it('clamps a sub-floor interval up to the 60-minute floor', async () => {
		await db.query(
			`UPDATE member_agents SET last_heartbeat_at = $2, heartbeat_interval_min = 5 WHERE id = $1`,
			[agentId, '2026-01-01T00:00:00Z'],
		);
		const agent = await fetchAgent();
		// 5-minute interval is below the floor — next is last + 60m, not last + 5m.
		expect(Date.parse(agent.next_heartbeat_at as string)).toBe(Date.parse('2026-01-01T01:00:00Z'));
	});

	it('is ~now when the agent has never run a heartbeat (due immediately)', async () => {
		await db.query(`UPDATE member_agents SET last_heartbeat_at = NULL WHERE id = $1`, [agentId]);
		const agent = await fetchAgent();
		const delta = Math.abs(Date.parse(agent.next_heartbeat_at as string) - Date.now());
		expect(delta).toBeLessThan(10_000);
	});

	it('is null for a disabled agent (off the schedule)', async () => {
		await db.query(
			`UPDATE member_agents SET admin_status = 'disabled'::agent_admin_status,
			   last_heartbeat_at = $2 WHERE id = $1`,
			[agentId, '2026-01-01T00:00:00Z'],
		);
		const agent = await fetchAgent();
		expect(agent.next_heartbeat_at).toBeNull();
		// restore for the next case
		await db.query(
			`UPDATE member_agents SET admin_status = 'enabled'::agent_admin_status WHERE id = $1`,
			[agentId],
		);
	});

	it('is null for a budget-paused agent (off the schedule)', async () => {
		await db.query(
			`UPDATE member_agents SET admin_status = 'enabled'::agent_admin_status,
			   runtime_status = 'out_of_agent_budget'::agent_runtime_status,
			   last_heartbeat_at = $2 WHERE id = $1`,
			[agentId, '2026-01-01T00:00:00Z'],
		);
		const agent = await fetchAgent();
		expect(agent.next_heartbeat_at).toBeNull();
	});
});

describe('agents API has_actionable_work', () => {
	beforeAll(async () => {
		// Detach any tasks the template seeded onto this agent so each case below
		// controls its own actionable-work state.
		await db.query('UPDATE tasks SET assignee_id = NULL WHERE assignee_id = $1', [agentId]);
	});

	it('is false when the agent has no assigned task', async () => {
		const agent = await fetchAgent();
		expect(agent.has_actionable_work).toBe(false);
	});

	it('is true for an open task assigned to the agent', async () => {
		const taskId = await insertTask(agentId, 'backlog');
		const agent = await fetchAgent();
		expect(agent.has_actionable_work).toBe(true);
		await db.query('DELETE FROM tasks WHERE id = $1', [taskId]);
	});

	it('is false when the only assigned task is terminal (done/closed/cancelled)', async () => {
		const taskId = await insertTask(agentId, 'done');
		const agent = await fetchAgent();
		expect(agent.has_actionable_work).toBe(false);
		await db.query('DELETE FROM tasks WHERE id = $1', [taskId]);
	});

	it('is false when the assigned task is blocked by an open task, true once the blocker closes', async () => {
		const taskId = await insertTask(agentId, 'backlog');
		const blockerId = await insertTask(null, 'in_progress');
		await db.query('INSERT INTO task_dependencies (task_id, blocked_by_task_id) VALUES ($1, $2)', [
			taskId,
			blockerId,
		]);

		const blocked = await fetchAgent();
		expect(blocked.has_actionable_work).toBe(false);

		await db.query(`UPDATE tasks SET status = 'done'::task_status WHERE id = $1`, [blockerId]);
		const unblocked = await fetchAgent();
		expect(unblocked.has_actionable_work).toBe(true);

		await db.query('DELETE FROM task_dependencies WHERE task_id = $1', [taskId]);
		await db.query('DELETE FROM tasks WHERE id = ANY($1::uuid[])', [[taskId, blockerId]]);
	});
});
