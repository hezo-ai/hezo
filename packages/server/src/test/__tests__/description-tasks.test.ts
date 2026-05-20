import type { PGlite } from '@electric-sql/pglite';
import type { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Env } from '../../lib/types';
import {
	enqueueAgentSummaryTask,
	enqueueAgentTeamContextTask,
	enqueueTeamContextTaskForAllAgents,
	enqueueTeamSummaryTask,
} from '../../services/description-tasks';
import { safeClose } from '../helpers';
import { authHeader, createTestApp } from '../helpers/app';

let app: Hono<Env>;
let db: PGlite;
let token: string;
let teamId: string;
let captainMemberId: string;
let engineerMemberId: string;

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

	const eng = await db.query<{ id: string }>(
		`SELECT ma.id FROM member_agents ma
		 JOIN members m ON m.id = ma.id
		 WHERE m.team_id = $1 AND ma.slug = 'engineer'`,
		[teamId],
	);
	engineerMemberId = eng.rows[0].id;
});

afterAll(async () => {
	await safeClose(db);
});

beforeEach(async () => {
	// Wipe any description-update issues from previous tests so dedup checks
	// have a clean slate. We only delete issues with the description-update label.
	await db.query(`DELETE FROM issues WHERE labels @> '["description-update"]'::jsonb`);
});

describe('enqueueAgentSummaryTask', () => {
	it('creates an issue in the Operations project assigned to the Captain with the correct label and priority', async () => {
		const issueId = await enqueueAgentSummaryTask(db, teamId, engineerMemberId, 'created');
		expect(issueId).toBeTruthy();

		const issue = await db.query<{
			project_id: string;
			assignee_id: string;
			title: string;
			description: string;
			labels: string[];
			priority: string;
			status: string;
		}>(
			`SELECT i.project_id, i.assignee_id, i.title, i.description, i.labels, i.priority, i.status
			 FROM issues i WHERE i.id = $1`,
			[issueId],
		);
		const row = issue.rows[0];
		expect(row.assignee_id).toBe(captainMemberId);

		const opsProject = await db.query<{ id: string }>(
			`SELECT id FROM projects WHERE team_id = $1 AND slug = 'operations'`,
			[teamId],
		);
		expect(row.project_id).toBe(opsProject.rows[0].id);

		expect(row.labels).toEqual(expect.arrayContaining(['internal', 'description-update']));
		expect(row.priority).toBe('low');
		expect(row.status).toBe('backlog');
		expect(row.title).toContain('Engineer');
		expect(row.description).toContain(engineerMemberId);
		expect(row.description).toContain('get_agent_system_prompt');
		expect(row.description).toContain('set_agent_summary');
		expect(row.description).toContain('set_team_summary');
	});

	it('creates a wakeup for the Captain when enqueueing', async () => {
		const issueId = await enqueueAgentSummaryTask(db, teamId, engineerMemberId, 'created');
		const wakeups = await db.query<{ source: string; payload: Record<string, unknown> }>(
			`SELECT source, payload FROM agent_wakeup_requests
			 WHERE member_id = $1 AND payload->>'issue_id' = $2`,
			[captainMemberId, issueId],
		);
		expect(wakeups.rows.length).toBe(1);
		expect(wakeups.rows[0].source).toBe('assignment');
	});

	it('dedupes: a second call while the first issue is open returns the same issue id and creates no new issue', async () => {
		const first = await enqueueAgentSummaryTask(db, teamId, engineerMemberId, 'created');
		const second = await enqueueAgentSummaryTask(db, teamId, engineerMemberId, 'prompt_updated');
		expect(second).toBe(first);

		const count = await db.query<{ n: number }>(
			`SELECT count(*)::int AS n FROM issues
			 WHERE labels @> '["description-update"]'::jsonb
			   AND description LIKE $1`,
			[`%target=agent:${engineerMemberId}%`],
		);
		expect(count.rows[0].n).toBe(1);
	});

	it('after the first issue is closed, a new call creates a new issue', async () => {
		const first = await enqueueAgentSummaryTask(db, teamId, engineerMemberId, 'created');
		await db.query(`UPDATE issues SET status = 'done'::issue_status WHERE id = $1`, [first]);

		const second = await enqueueAgentSummaryTask(db, teamId, engineerMemberId, 'prompt_updated');
		expect(second).not.toBe(first);
		expect(second).toBeTruthy();
	});

	it('returns null and does not create an issue when there is no enabled Captain', async () => {
		// Create a fresh team with no template — only built-in Captain + Coach
		// then disable the Captain.
		const blankRes = await app.request('/api/teams', {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ name: 'No Captain Co' }),
		});
		const blankTeamId = (await blankRes.json()).data.id;
		const ceoRes = await db.query<{ id: string }>(
			`SELECT ma.id FROM member_agents ma JOIN members m ON m.id = ma.id
			 WHERE m.team_id = $1 AND ma.slug = 'captain'`,
			[blankTeamId],
		);
		const blankCeoId = ceoRes.rows[0].id;
		await db.query(
			`UPDATE member_agents SET admin_status = 'disabled'::agent_admin_status WHERE id = $1`,
			[blankCeoId],
		);

		const result = await enqueueAgentSummaryTask(db, blankTeamId, blankCeoId, 'created');
		expect(result).toBeNull();

		const issues = await db.query<{ n: number }>(
			`SELECT count(*)::int AS n FROM issues
			 WHERE team_id = $1
			   AND description LIKE $2`,
			[blankTeamId, `%target=agent:${blankCeoId}%`],
		);
		expect(issues.rows[0].n).toBe(0);
	});

	it('returns null and does not create an issue when there is no Operations project', async () => {
		// Manually nuke the Operations project of a fresh team.
		const blankRes = await app.request('/api/teams', {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ name: 'No Ops Co' }),
		});
		const blankTeamId = (await blankRes.json()).data.id;
		await db.query(`DELETE FROM projects WHERE team_id = $1 AND slug = 'operations'`, [
			blankTeamId,
		]);
		const ceoRes = await db.query<{ id: string }>(
			`SELECT ma.id FROM member_agents ma JOIN members m ON m.id = ma.id
			 WHERE m.team_id = $1 AND ma.slug = 'captain'`,
			[blankTeamId],
		);
		const blankCeoId = ceoRes.rows[0].id;

		const result = await enqueueAgentSummaryTask(db, blankTeamId, blankCeoId, 'created');
		expect(result).toBeNull();
	});
});

describe('enqueueTeamSummaryTask', () => {
	it('creates a team-targeted issue in the Operations project assigned to the Captain', async () => {
		const issueId = await enqueueTeamSummaryTask(db, teamId, 'agent_added');
		expect(issueId).toBeTruthy();

		const issue = await db.query<{
			assignee_id: string;
			title: string;
			description: string;
			labels: string[];
		}>('SELECT assignee_id, title, description, labels FROM issues WHERE id = $1', [issueId]);
		const row = issue.rows[0];
		expect(row.assignee_id).toBe(captainMemberId);
		expect(row.title).toContain('team');
		expect(row.description).toContain('target=team');
		expect(row.description).toContain('set_team_summary');
		expect(row.labels).toEqual(expect.arrayContaining(['internal', 'description-update']));
	});

	it('dedupes: only one open team-summary issue exists at a time', async () => {
		const first = await enqueueTeamSummaryTask(db, teamId, 'agent_added');
		const second = await enqueueTeamSummaryTask(db, teamId, 'prompt_updated');
		expect(second).toBe(first);

		const count = await db.query<{ n: number }>(
			`SELECT count(*)::int AS n FROM issues
			 WHERE team_id = $1
			   AND labels @> '["description-update"]'::jsonb
			   AND description LIKE '%target=team%'
			   AND status NOT IN ('done', 'closed', 'cancelled')`,
			[teamId],
		);
		expect(count.rows[0].n).toBe(1);
	});
});

describe('enqueueAgentTeamContextTask', () => {
	it('creates an agent-scoped team_context issue in Operations assigned to the Captain', async () => {
		const issueId = await enqueueAgentTeamContextTask(db, teamId, engineerMemberId, 'agent_added');
		expect(issueId).toBeTruthy();

		const issue = await db.query<{
			assignee_id: string;
			title: string;
			description: string;
			labels: string[];
			status: string;
		}>('SELECT assignee_id, title, description, labels, status FROM issues WHERE id = $1', [
			issueId,
		]);
		const row = issue.rows[0];
		expect(row.assignee_id).toBe(captainMemberId);
		expect(row.title).toContain('team relationships');
		expect(row.description).toContain(`target=team_context:${engineerMemberId}`);
		expect(row.description).toContain('set_agent_team_context');
		expect(row.labels).toEqual(expect.arrayContaining(['internal', 'description-update']));
		expect(row.status).toBe('backlog');
	});

	it('dedupes by agent: only one open team_context issue per agent at a time', async () => {
		const first = await enqueueAgentTeamContextTask(db, teamId, engineerMemberId, 'agent_added');
		const second = await enqueueAgentTeamContextTask(
			db,
			teamId,
			engineerMemberId,
			'prompt_updated',
		);
		expect(second).toBe(first);

		const count = await db.query<{ n: number }>(
			`SELECT count(*)::int AS n FROM issues
			 WHERE labels @> '["description-update"]'::jsonb
			   AND description LIKE $1`,
			[`%target=team_context:${engineerMemberId}%`],
		);
		expect(count.rows[0].n).toBe(1);
	});

	it('does not dedupe against the agent-summary task for the same agent', async () => {
		const summaryIssue = await enqueueAgentSummaryTask(db, teamId, engineerMemberId, 'created');
		const contextIssue = await enqueueAgentTeamContextTask(
			db,
			teamId,
			engineerMemberId,
			'agent_added',
		);
		expect(contextIssue).toBeTruthy();
		expect(contextIssue).not.toBe(summaryIssue);
	});
});

describe('enqueueTeamContextTaskForAllAgents', () => {
	it('enqueues one issue per enabled agent in the team', async () => {
		const agents = await db.query<{ n: number }>(
			`SELECT count(*)::int AS n FROM member_agents ma
			 JOIN members m ON m.id = ma.id
			 WHERE m.team_id = $1 AND ma.admin_status = 'enabled'`,
			[teamId],
		);
		const enabledAgentCount = agents.rows[0].n;

		await enqueueTeamContextTaskForAllAgents(db, teamId, 'agent_added');

		const count = await db.query<{ n: number }>(
			`SELECT count(*)::int AS n FROM issues
			 WHERE team_id = $1
			   AND labels @> '["description-update"]'::jsonb
			   AND description LIKE '%target=team_context:%'`,
			[teamId],
		);
		expect(count.rows[0].n).toBe(enabledAgentCount);
	});

	it('skips the excepted agent', async () => {
		await enqueueTeamContextTaskForAllAgents(db, teamId, 'agent_added', engineerMemberId);

		const engineerTasks = await db.query<{ n: number }>(
			`SELECT count(*)::int AS n FROM issues
			 WHERE labels @> '["description-update"]'::jsonb
			   AND description LIKE $1`,
			[`%target=team_context:${engineerMemberId}%`],
		);
		expect(engineerTasks.rows[0].n).toBe(0);

		const ceoTasks = await db.query<{ n: number }>(
			`SELECT count(*)::int AS n FROM issues
			 WHERE labels @> '["description-update"]'::jsonb
			   AND description LIKE $1`,
			[`%target=team_context:${captainMemberId}%`],
		);
		expect(ceoTasks.rows[0].n).toBe(1);
	});
});
