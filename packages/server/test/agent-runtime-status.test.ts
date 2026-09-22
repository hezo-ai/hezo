import { AgentRuntimeStatus, BudgetPeriod, HeartbeatRunStatus } from '@hezo/shared';
import type { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../src/db/database';
import type { Env } from '../src/lib/types';
import {
	BUDGET_PAUSED_COMMENT_KIND,
	budgetPauseStatus,
	pauseAgentForBudget,
	reconcileBudgetPause,
	setAgentIdleIfNoActiveRuns,
} from '../src/services/agent-runtime-status';
import { safeClose } from './helpers';
import { authHeader, createTestApp, createTestProject, createTestTeam } from './helpers/app';

let db: Db;
let app: Hono<Env>;
let token: string;
let teamId: string;
let projectId: string;
let agentId: string;
let projectSlug: string;

beforeAll(async () => {
	const ctx = await createTestApp();
	db = ctx.db;
	app = ctx.app;
	token = ctx.token;

	const typesRes = await app.request('/api/team-templates', { headers: authHeader(token) });
	const teamTemplateId = (await typesRes.json()).data.find((t: any) => t.name === 'App Team').id;

	const teamRes = await createTestTeam(db, {
		name: 'Runtime Status Test',
		template_id: teamTemplateId,
	});
	const teamData = (await teamRes.json()).data;
	teamId = teamData.id;
	const project = (await (await createTestProject(db, teamId, { name: 'Setup Project' })).json())
		.data;
	projectId = project.id;
	projectSlug = project.slug;

	const agentsRes = await app.request(`/api/projects/${projectSlug}/agents`, {
		headers: authHeader(token),
	});
	agentId = (await agentsRes.json()).data[0].id;
});

afterAll(async () => {
	await safeClose(db);
});

beforeEach(async () => {
	await db.query('DELETE FROM heartbeat_runs WHERE team_id = $1', [teamId]);
	await db.query(
		`UPDATE member_agents SET runtime_status = $1::agent_runtime_status WHERE id = $2`,
		[AgentRuntimeStatus.Active, agentId],
	);
});

async function insertRun(status: HeartbeatRunStatus): Promise<string> {
	const r = await db.query<{ id: string }>(
		`INSERT INTO heartbeat_runs (team_id, member_id, status, started_at)
		 VALUES ($1, $2, $3::heartbeat_run_status, now())
		 RETURNING id`,
		[teamId, agentId, status],
	);
	return r.rows[0].id;
}

async function getStatus(): Promise<string> {
	const r = await db.query<{ runtime_status: string }>(
		'SELECT runtime_status FROM member_agents WHERE id = $1',
		[agentId],
	);
	return r.rows[0].runtime_status;
}

describe('setAgentIdleIfNoActiveRuns', () => {
	it('flips active → idle when no in-flight runs remain', async () => {
		const broadcasts: Array<{ table: string; payload: unknown }> = [];
		const wsManager = {
			broadcast: (_room: string, msg: { table: string; payload: unknown }) => {
				broadcasts.push({ table: msg.table, payload: msg.payload });
			},
		} as any;

		const transitioned = await setAgentIdleIfNoActiveRuns(
			db,
			agentId,
			teamId,
			undefined,
			wsManager,
		);

		expect(transitioned).toBe(true);
		expect(await getStatus()).toBe(AgentRuntimeStatus.Idle);
		expect(broadcasts.filter((b) => b.table === 'member_agents').length).toBe(1);
	});

	it('keeps agent active when another run is still running', async () => {
		const otherRunId = await insertRun(HeartbeatRunStatus.Running);

		const broadcasts: Array<{ table: string }> = [];
		const wsManager = {
			broadcast: (_room: string, msg: { table: string }) => {
				broadcasts.push({ table: msg.table });
			},
		} as any;

		const transitioned = await setAgentIdleIfNoActiveRuns(
			db,
			agentId,
			teamId,
			undefined,
			wsManager,
		);

		expect(transitioned).toBe(false);
		expect(await getStatus()).toBe(AgentRuntimeStatus.Active);
		expect(broadcasts.length).toBe(0);

		await db.query('DELETE FROM heartbeat_runs WHERE id = $1', [otherRunId]);
	});

	it('excludes the just-finished run when checking for remaining in-flight runs', async () => {
		const justFinishedId = await insertRun(HeartbeatRunStatus.Running);

		const transitioned = await setAgentIdleIfNoActiveRuns(
			db,
			agentId,
			teamId,
			justFinishedId,
			undefined,
		);

		expect(transitioned).toBe(true);
		expect(await getStatus()).toBe(AgentRuntimeStatus.Idle);
	});

	it('treats queued runs as in-flight (does not flip to idle)', async () => {
		await insertRun(HeartbeatRunStatus.Queued);

		const transitioned = await setAgentIdleIfNoActiveRuns(
			db,
			agentId,
			teamId,
			undefined,
			undefined,
		);

		expect(transitioned).toBe(false);
		expect(await getStatus()).toBe(AgentRuntimeStatus.Active);
	});

	it('preserves a budget-pause status (run completion does not clear it)', async () => {
		await db.query(
			`UPDATE member_agents SET runtime_status = $1::agent_runtime_status WHERE id = $2`,
			[AgentRuntimeStatus.OutOfAgentBudget, agentId],
		);

		const broadcasts: Array<{ table: string }> = [];
		const wsManager = {
			broadcast: (_room: string, msg: { table: string }) => {
				broadcasts.push({ table: msg.table });
			},
		} as any;

		const transitioned = await setAgentIdleIfNoActiveRuns(
			db,
			agentId,
			teamId,
			undefined,
			wsManager,
		);

		expect(transitioned).toBe(false);
		expect(await getStatus()).toBe(AgentRuntimeStatus.OutOfAgentBudget);
		expect(broadcasts.length).toBe(0);
	});

	it('is a no-op when agent is already idle (no spurious broadcast)', async () => {
		await db.query(
			`UPDATE member_agents SET runtime_status = $1::agent_runtime_status WHERE id = $2`,
			[AgentRuntimeStatus.Idle, agentId],
		);

		const broadcasts: Array<{ table: string }> = [];
		const wsManager = {
			broadcast: (_room: string, msg: { table: string }) => {
				broadcasts.push({ table: msg.table });
			},
		} as any;

		const transitioned = await setAgentIdleIfNoActiveRuns(
			db,
			agentId,
			teamId,
			undefined,
			wsManager,
		);

		expect(transitioned).toBe(false);
		expect(broadcasts.length).toBe(0);
	});

	it('advances last_heartbeat_at when transitioning to idle', async () => {
		await db.query(
			`UPDATE member_agents SET last_heartbeat_at = now() - interval '2 hours' WHERE id = $1`,
			[agentId],
		);

		const before = await db.query<{ last_heartbeat_at: string }>(
			'SELECT last_heartbeat_at FROM member_agents WHERE id = $1',
			[agentId],
		);

		await setAgentIdleIfNoActiveRuns(db, agentId, teamId, undefined, undefined);

		const after = await db.query<{ last_heartbeat_at: string }>(
			'SELECT last_heartbeat_at FROM member_agents WHERE id = $1',
			[agentId],
		);

		expect(new Date(after.rows[0].last_heartbeat_at).getTime()).toBeGreaterThan(
			new Date(before.rows[0].last_heartbeat_at).getTime(),
		);
	});

	it('advances last_heartbeat_at even when runtime_status is not active', async () => {
		await db.query(
			`UPDATE member_agents
			 SET runtime_status = $1::agent_runtime_status,
			     last_heartbeat_at = now() - interval '2 hours'
			 WHERE id = $2`,
			[AgentRuntimeStatus.Idle, agentId],
		);

		const before = await db.query<{ last_heartbeat_at: string }>(
			'SELECT last_heartbeat_at FROM member_agents WHERE id = $1',
			[agentId],
		);

		const transitioned = await setAgentIdleIfNoActiveRuns(
			db,
			agentId,
			teamId,
			undefined,
			undefined,
		);

		const after = await db.query<{ last_heartbeat_at: string }>(
			'SELECT last_heartbeat_at FROM member_agents WHERE id = $1',
			[agentId],
		);

		expect(transitioned).toBe(false);
		expect(new Date(after.rows[0].last_heartbeat_at).getTime()).toBeGreaterThan(
			new Date(before.rows[0].last_heartbeat_at).getTime(),
		);
	});

	it('does not advance last_heartbeat_at when other runs are still in-flight', async () => {
		await db.query(
			`UPDATE member_agents SET last_heartbeat_at = now() - interval '2 hours' WHERE id = $1`,
			[agentId],
		);
		const otherRunId = await insertRun(HeartbeatRunStatus.Running);

		const before = await db.query<{ last_heartbeat_at: string }>(
			'SELECT last_heartbeat_at FROM member_agents WHERE id = $1',
			[agentId],
		);

		await setAgentIdleIfNoActiveRuns(db, agentId, teamId, undefined, undefined);

		const after = await db.query<{ last_heartbeat_at: string }>(
			'SELECT last_heartbeat_at FROM member_agents WHERE id = $1',
			[agentId],
		);

		expect(new Date(after.rows[0].last_heartbeat_at).getTime()).toBe(
			new Date(before.rows[0].last_heartbeat_at).getTime(),
		);

		await db.query('DELETE FROM heartbeat_runs WHERE id = $1', [otherRunId]);
	});
});

function captureWs(): { wsManager: any; rows: Array<Record<string, unknown>> } {
	const rows: Array<Record<string, unknown>> = [];
	const wsManager = {
		broadcast: (_room: string, msg: { table?: string; row?: Record<string, unknown> }) => {
			if (msg.table === 'member_agents' && msg.row) rows.push(msg.row);
		},
	} as any;
	return { wsManager, rows };
}

describe('budget pause / resume', () => {
	/** A task on the project for a pause's notice to land on. */
	async function createPauseTask(title: string): Promise<string> {
		const res = await app.request(`/api/projects/${projectSlug}/tasks`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ title, description: 'x', assignee_id: agentId }),
		});
		return (await res.json()).data.id as string;
	}

	/** The budget-pause notices on a task. */
	async function pauseNotices(taskId: string) {
		return db.query<{ id: string; content: Record<string, unknown> }>(
			`SELECT id, content FROM task_comments WHERE task_id = $1 AND content->>'kind' = $2`,
			[taskId, BUDGET_PAUSED_COMMENT_KIND],
		);
	}

	beforeEach(async () => {
		await db.query('DELETE FROM usage_entries WHERE member_id = $1 OR project_id = $2', [
			agentId,
			projectId,
		]);
		await db.query(
			`UPDATE member_agents
			 SET runtime_status = 'idle', budget_notice_key = NULL,
			     daily_budget_tokens = 0, weekly_budget_tokens = 0, monthly_budget_tokens = 0
			 WHERE id = $1`,
			[agentId],
		);
		await db.query(
			`UPDATE projects
			 SET daily_budget_tokens = 0, weekly_budget_tokens = 0, monthly_budget_tokens = 0
			 WHERE id = $1`,
			[projectId],
		);
	});

	it('maps a block scope to the matching out_of_*_budget status', () => {
		expect(
			budgetPauseStatus({
				scope: 'agent',
				period: BudgetPeriod.Daily,
				usedTokens: 600,
				limitTokens: 500,
			}),
		).toBe(AgentRuntimeStatus.OutOfAgentBudget);
		expect(
			budgetPauseStatus({
				scope: 'project',
				period: BudgetPeriod.Monthly,
				usedTokens: 600,
				limitTokens: 500,
			}),
		).toBe(AgentRuntimeStatus.OutOfProjectBudget);
	});

	it('pauses to the scoped budget state and broadcasts', async () => {
		const taskId = await createPauseTask('Scoped pause');
		const { wsManager, rows } = captureWs();
		await pauseAgentForBudget(
			db,
			agentId,
			teamId,
			{ scope: 'agent', period: BudgetPeriod.Daily, usedTokens: 600, limitTokens: 500 },
			wsManager,
			{ taskId, projectId },
		);
		expect(await getStatus()).toBe(AgentRuntimeStatus.OutOfAgentBudget);
		const statusRows = rows.filter((r) => 'runtime_status' in r);
		expect(statusRows).toHaveLength(1);
		expect(statusRows[0].runtime_status).toBe(AgentRuntimeStatus.OutOfAgentBudget);
	});

	it('tells the admin once per window, though the pause lifts and returns inside it', async () => {
		const taskId = await createPauseTask('Flapping pause');
		const block = {
			scope: 'project' as const,
			period: BudgetPeriod.Monthly,
			usedTokens: 600,
			limitTokens: 500,
		};
		// The CEO's pattern: the sweep lifts a project pause it cannot see, and the
		// next dispatch sets it again.
		for (let i = 0; i < 3; i++) {
			await pauseAgentForBudget(db, agentId, teamId, block, undefined, { taskId, projectId });
			await db.query("UPDATE member_agents SET runtime_status = 'idle' WHERE id = $1", [agentId]);
		}
		expect((await pauseNotices(taskId)).rows).toHaveLength(1);

		// Another window, or another scope, is news.
		await pauseAgentForBudget(db, agentId, teamId, { ...block, scope: 'agent' }, undefined, {
			taskId,
			projectId,
		});
		expect((await pauseNotices(taskId)).rows).toHaveLength(2);
	});

	it("posts a task-less run's pause on its project's planning task", async () => {
		const planning = await db.query<{ id: string }>(
			`SELECT id FROM tasks WHERE project_id = $1 AND labels ? 'planning'
			  ORDER BY created_at LIMIT 1`,
			[projectId],
		);
		const planningTaskId = planning.rows[0]?.id ?? (await createPauseTask('Draft execution plan'));
		await db.query(`UPDATE tasks SET labels = '["planning"]'::jsonb WHERE id = $1`, [
			planningTaskId,
		]);
		await pauseAgentForBudget(
			db,
			agentId,
			teamId,
			{ scope: 'agent', period: BudgetPeriod.Daily, usedTokens: 600, limitTokens: 500 },
			undefined,
			{ taskId: null, projectId },
		);
		expect((await pauseNotices(planningTaskId)).rows).toHaveLength(1);
	});

	it('posts one @admin notice on the task the run was working, with the budget and usage', async () => {
		const taskRes = await app.request(`/api/projects/${projectSlug}/tasks`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				title: 'Budget pause notice',
				description: 'x',
				assignee_id: agentId,
			}),
		});
		const taskId = (await taskRes.json()).data.id as string;
		const block = {
			scope: 'agent' as const,
			period: BudgetPeriod.Weekly,
			usedTokens: 1_200_000,
			limitTokens: 1_000_000,
		};
		await pauseAgentForBudget(db, agentId, teamId, block, undefined, { taskId, projectId });
		// Already paused: the second call changes nothing and posts nothing.
		await pauseAgentForBudget(db, agentId, teamId, block, undefined, { taskId, projectId });

		const notices = await db.query<{ id: string; content: Record<string, unknown> }>(
			`SELECT id, content FROM task_comments WHERE task_id = $1 AND content->>'kind' = $2`,
			[taskId, BUDGET_PAUSED_COMMENT_KIND],
		);
		expect(notices.rows).toHaveLength(1);
		expect(notices.rows[0].content).toMatchObject({
			scope: 'agent',
			period: 'weekly',
			used_tokens: 1_200_000,
			limit_tokens: 1_000_000,
		});
		expect(notices.rows[0].content.text).toContain('1,000,000 tokens');
		const mentions = await db.query<{ n: number }>(
			'SELECT count(*)::int AS n FROM admin_mentions WHERE comment_id = $1',
			[notices.rows[0].id],
		);
		expect(mentions.rows[0].n).toBeGreaterThan(0);
	});

	it('does not re-broadcast when already in the target budget state', async () => {
		await db.query(
			"UPDATE member_agents SET runtime_status = 'out_of_agent_budget' WHERE id = $1",
			[agentId],
		);
		const { wsManager, rows } = captureWs();
		await pauseAgentForBudget(
			db,
			agentId,
			teamId,
			{ scope: 'agent', period: BudgetPeriod.Monthly, usedTokens: 600, limitTokens: 500 },
			wsManager,
			{ taskId: null, projectId },
		);
		expect(rows).toHaveLength(0);
	});

	it('resumes to idle once the window is back within budget', async () => {
		// Over the daily cap, paused. Then the usage is cleared and the
		// sweep's reconcile must flip the agent back to idle so it can be scheduled.
		await db.query('UPDATE member_agents SET daily_budget_tokens = 500 WHERE id = $1', [agentId]);
		await db.query(
			`INSERT INTO usage_entries (member_id, project_id, input_tokens) VALUES ($1, $2, 600)`,
			[agentId, projectId],
		);
		await pauseAgentForBudget(
			db,
			agentId,
			teamId,
			{ scope: 'agent', period: BudgetPeriod.Daily, usedTokens: 600, limitTokens: 500 },
			undefined,
			{ taskId: await createPauseTask('Resume'), projectId },
		);
		expect(await getStatus()).toBe(AgentRuntimeStatus.OutOfAgentBudget);

		await db.query('DELETE FROM usage_entries WHERE member_id = $1', [agentId]);
		const { wsManager, rows } = captureWs();
		const next = await reconcileBudgetPause(db, agentId, teamId, projectId, wsManager);
		expect(next).toBe(AgentRuntimeStatus.Idle);
		expect(await getStatus()).toBe(AgentRuntimeStatus.Idle);
		expect(rows[0].runtime_status).toBe(AgentRuntimeStatus.Idle);
	});

	it('restamps the scope when a different window now binds', async () => {
		// Paused as out_of_agent_budget, but the agent window has since cleared while
		// the project window is still over — reconcile should move it to project scope.
		await db.query(
			"UPDATE member_agents SET runtime_status = 'out_of_agent_budget' WHERE id = $1",
			[agentId],
		);
		await db.query('UPDATE projects SET monthly_budget_tokens = 100 WHERE id = $1', [projectId]);
		await db.query(
			`INSERT INTO usage_entries (member_id, project_id, input_tokens) VALUES ($1, $2, 200)`,
			[agentId, projectId],
		);

		const next = await reconcileBudgetPause(db, agentId, teamId, projectId, undefined);
		expect(next).toBe(AgentRuntimeStatus.OutOfProjectBudget);
		expect(await getStatus()).toBe(AgentRuntimeStatus.OutOfProjectBudget);
	});

	it('leaves a non-budget-paused agent untouched during reconcile', async () => {
		// An idle (or active) agent is outside the budget-pause states, so reconcile
		// must never touch it — even when it happens to be over budget.
		await db.query(
			"UPDATE member_agents SET runtime_status = 'idle', daily_budget_tokens = 100 WHERE id = $1",
			[agentId],
		);
		await db.query(
			`INSERT INTO usage_entries (member_id, project_id, input_tokens) VALUES ($1, $2, 250)`,
			[agentId, projectId],
		);
		const next = await reconcileBudgetPause(db, agentId, teamId, projectId, undefined);
		expect(next).toBeNull();
		expect(await getStatus()).toBe(AgentRuntimeStatus.Idle);
	});
});
