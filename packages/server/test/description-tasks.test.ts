import type { PGlite } from '@electric-sql/pglite';
import type { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Env } from '../src/lib/types';
import { enqueueTeamCoherenceReviewTask } from '../src/services/description-tasks';
import { safeClose } from './helpers';
import { authHeader, createTestApp } from './helpers/app';

let app: Hono<Env>;
let db: PGlite;
let token: string;
let teamId: string;
let captainMemberId: string;

beforeAll(async () => {
	const ctx = await createTestApp();
	app = ctx.app;
	db = ctx.db;
	token = ctx.token;

	const typesRes = await app.request('/api/team-templates', { headers: authHeader(token) });
	const typeId = (await typesRes.json()).data.find(
		(t: Record<string, unknown>) => t.name === 'Startup',
	).id;

	const teamRes = await app.request('/api/teams', {
		method: 'POST',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify({ name: 'Description Tasks Co', template_id: typeId }),
	});
	teamId = (await teamRes.json()).data.id;

	const captain = await db.query<{ id: string }>(
		`SELECT ma.id FROM member_agents ma
		 JOIN members m ON m.id = ma.id
		 WHERE m.team_id = $1 AND ma.slug = 'captain'`,
		[teamId],
	);
	captainMemberId = captain.rows[0].id;
});

afterAll(async () => {
	await safeClose(db);
});

beforeEach(async () => {
	await db.query(`DELETE FROM tasks WHERE labels @> '["team-coherence-review"]'::jsonb`);
});

describe('enqueueTeamCoherenceReviewTask', () => {
	it('creates an task in the Internal project assigned to the Captain with the correct label and priority', async () => {
		const taskId = await enqueueTeamCoherenceReviewTask(db, teamId, 'agent_hired');
		expect(taskId).toBeTruthy();

		const task = await db.query<{
			project_id: string;
			assignee_id: string;
			title: string;
			description: string;
			labels: string[];
			priority: string;
			status: string;
		}>(
			`SELECT project_id, assignee_id, title, description, labels, priority, status
			 FROM tasks WHERE id = $1`,
			[taskId],
		);
		const row = task.rows[0];
		expect(row.assignee_id).toBe(captainMemberId);

		const opsProject = await db.query<{ id: string }>(
			`SELECT id FROM projects WHERE team_id = $1 AND is_internal = true`,
			[teamId],
		);
		expect(row.project_id).toBe(opsProject.rows[0].id);

		expect(row.labels).toEqual(expect.arrayContaining(['internal', 'team-coherence-review']));
		expect(row.priority).toBe('high');
		expect(row.status).toBe('backlog');
		expect(row.title).toContain('coherence');
	});

	it('body covers org-chart audit AND the three descriptive-blob MCP tools', async () => {
		const taskId = await enqueueTeamCoherenceReviewTask(db, teamId, 'agent_hired');
		const task = await db.query<{ description: string }>(
			`SELECT description FROM tasks WHERE id = $1`,
			[taskId],
		);
		const body = task.rows[0].description;
		expect(body).toContain('list_agents');
		expect(body).toContain('get_agent_system_prompt');
		expect(body).toContain('update_agent_system_prompt');
		expect(body).toContain('set_agent_summary');
		expect(body).toContain('set_agent_team_context');
		expect(body).toContain('set_team_summary');
	});

	it('creates a wakeup for the Captain when enqueueing', async () => {
		const taskId = await enqueueTeamCoherenceReviewTask(db, teamId, 'agent_hired');
		const wakeups = await db.query<{ source: string; payload: Record<string, unknown> }>(
			`SELECT source, payload FROM agent_wakeup_requests
			 WHERE member_id = $1 AND payload->>'task_id' = $2`,
			[captainMemberId, taskId],
		);
		expect(wakeups.rows.length).toBe(1);
		expect(wakeups.rows[0].source).toBe('assignment');
	});

	it('dedupes: a second call while the first task is open returns the same task id and creates no new task', async () => {
		const first = await enqueueTeamCoherenceReviewTask(db, teamId, 'agent_hired');
		const second = await enqueueTeamCoherenceReviewTask(db, teamId, 'reports_to_changed');
		expect(second).toBe(first);

		const count = await db.query<{ n: number }>(
			`SELECT count(*)::int AS n FROM tasks
			 WHERE team_id = $1
			   AND labels @> '["team-coherence-review"]'::jsonb
			   AND status NOT IN ('done', 'closed', 'cancelled')`,
			[teamId],
		);
		expect(count.rows[0].n).toBe(1);
	});

	it('after the first task is closed, a new call creates a new task', async () => {
		const first = await enqueueTeamCoherenceReviewTask(db, teamId, 'agent_hired');
		await db.query(`UPDATE tasks SET status = 'done'::task_status WHERE id = $1`, [first]);

		const second = await enqueueTeamCoherenceReviewTask(db, teamId, 'prompt_updated');
		expect(second).not.toBe(first);
		expect(second).toBeTruthy();
	});

	it('returns null and does not create a task when there is no enabled Captain', async () => {
		const blankRes = await app.request('/api/teams', {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ name: 'No Captain Co' }),
		});
		const blankTeamId = (await blankRes.json()).data.id;

		const captainRes = await db.query<{ id: string }>(
			`SELECT ma.id FROM member_agents ma JOIN members m ON m.id = ma.id
			 WHERE m.team_id = $1 AND ma.slug = 'captain'`,
			[blankTeamId],
		);
		await db.query(
			`UPDATE member_agents SET admin_status = 'disabled'::agent_admin_status WHERE id = $1`,
			[captainRes.rows[0].id],
		);

		await db.query(`DELETE FROM tasks WHERE team_id = $1`, [blankTeamId]);

		const result = await enqueueTeamCoherenceReviewTask(db, blankTeamId, 'agent_hired');
		expect(result).toBeNull();

		const tasks = await db.query<{ n: number }>(
			`SELECT count(*)::int AS n FROM tasks
			 WHERE team_id = $1 AND labels @> '["team-coherence-review"]'::jsonb`,
			[blankTeamId],
		);
		expect(tasks.rows[0].n).toBe(0);
	});

	it('returns null and does not create a task when there is no Internal project', async () => {
		const blankRes = await app.request('/api/teams', {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ name: 'No Ops Co' }),
		});
		const blankTeamId = (await blankRes.json()).data.id;
		await db.query(`DELETE FROM projects WHERE team_id = $1 AND is_internal = true`, [blankTeamId]);

		const result = await enqueueTeamCoherenceReviewTask(db, blankTeamId, 'agent_hired');
		expect(result).toBeNull();
	});
});

describe('template apply', () => {
	it('produces exactly one team-coherence task on a fresh templated team (no per-agent duplicates)', async () => {
		const typesRes = await app.request('/api/team-templates', { headers: authHeader(token) });
		const typeId = (await typesRes.json()).data.find(
			(t: Record<string, unknown>) => t.name === 'Startup',
		).id;

		const teamRes = await app.request('/api/teams', {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ name: 'Regression Co', template_id: typeId }),
		});
		const newTeamId = (await teamRes.json()).data.id;

		const coherence = await db.query<{ n: number }>(
			`SELECT count(*)::int AS n FROM tasks
			 WHERE team_id = $1 AND labels @> '["team-coherence-review"]'::jsonb`,
			[newTeamId],
		);
		expect(coherence.rows[0].n).toBe(1);

		const oldDescriptionTasks = await db.query<{ n: number }>(
			`SELECT count(*)::int AS n FROM tasks
			 WHERE team_id = $1 AND labels @> '["description-update"]'::jsonb`,
			[newTeamId],
		);
		expect(oldDescriptionTasks.rows[0].n).toBe(0);
	});
});
