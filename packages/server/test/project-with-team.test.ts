import { CAPTAIN_AGENT_SLUG } from '@hezo/shared';
import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MasterKeyManager } from '../src/crypto/master-key';
import type { Db } from '../src/db/database';
import type { Env } from '../src/lib/types';
import { signAdminJwt } from '../src/middleware/auth';
import { safeClose } from './helpers';
import { authHeader, createTestApp } from './helpers/app';

let app: Hono<Env>;
let db: Db;
let token: string;
let masterKeyManager: MasterKeyManager;

interface CreatedProjectTeam {
	id: string;
	team_id: string;
	team_slug: string;
	slug: string;
	is_internal: boolean;
	planning_task_id: string;
	planning_task_identifier: string;
	setup_task_id: string | null;
	setup_task_identifier: string | null;
	suggestions_task_id: string | null;
	suggestions_task_identifier: string | null;
}

async function createProjectWithTeam(name: string, description = 'A test project.') {
	const res = await app.request('/api/projects', {
		method: 'POST',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify({ name, description }),
	});
	return res;
}

beforeAll(async () => {
	const ctx = await createTestApp();
	app = ctx.app;
	db = ctx.db;
	token = ctx.token;
	masterKeyManager = ctx.masterKeyManager;
});

afterAll(async () => {
	await safeClose(db);
});

describe('POST /projects — create a project with its own team', () => {
	it('directly creates the team, its single project, and the Captain planning task', async () => {
		const res = await createProjectWithTeam('Marketing Site', 'A site for the launch.');
		expect(res.status).toBe(201);
		const data = (await res.json()).data as CreatedProjectTeam;
		expect(data.team_slug).toBeTruthy();
		expect(data.slug).toBeTruthy();
		expect(data.planning_task_id).toBeTruthy();
		expect(data.planning_task_identifier).toBeTruthy();
		expect(data.is_internal).toBe(false);

		// The team is named after the project.
		const team = await db.query<{ name: string }>('SELECT name FROM teams WHERE id = $1', [
			data.team_id,
		]);
		expect(team.rows[0]?.name).toBe('Marketing Site');

		// The team owns exactly one (user-facing) project — its own.
		const projects = await db.query<{ id: string; is_internal: boolean }>(
			'SELECT id, is_internal FROM projects WHERE team_id = $1',
			[data.team_id],
		);
		expect(projects.rows).toHaveLength(1);
		expect(projects.rows[0].is_internal).toBe(false);
		expect(projects.rows[0].id).toBe(data.id);

		const captain = await db.query<{ id: string }>(
			`SELECT ma.id FROM member_agents ma
			 JOIN members m ON m.id = ma.id
			 WHERE m.team_id = $1 AND ma.slug = $2 AND ma.admin_status::text = 'enabled'`,
			[data.team_id, CAPTAIN_AGENT_SLUG],
		);
		expect(captain.rows).toHaveLength(1);

		// The planning task lives in the team's own project, assigned to its Captain.
		const planning = await db.query<{ project_id: string; assignee_id: string }>(
			'SELECT project_id, assignee_id FROM tasks WHERE id = $1',
			[data.planning_task_id],
		);
		expect(planning.rows[0]?.project_id).toBe(data.id);
		expect(planning.rows[0]?.assignee_id).toBe(captain.rows[0].id);

		// The planning task waits on two CEO tasks: setup, then starter suggestions.
		const dep = await db.query<{ blocked_by_task_id: string }>(
			'SELECT blocked_by_task_id FROM task_dependencies WHERE task_id = $1',
			[data.planning_task_id],
		);
		expect(dep.rows.map((r) => r.blocked_by_task_id).sort()).toEqual(
			[data.setup_task_id, data.suggestions_task_id].sort(),
		);

		// Both are surfaced on the response, numbered 1 and 2 ahead of planning (3),
		// so the creator can land the operator on setup.
		const rows = await db.query<{
			id: string;
			number: number;
			identifier: string;
			title: string;
			status: string;
			assignee_id: string | null;
		}>(
			`SELECT id, number, identifier, title, status::text AS status, assignee_id
			 FROM tasks WHERE project_id = $1 ORDER BY number`,
			[data.id],
		);
		const [setup, suggestions, planningRow] = rows.rows;
		expect(setup.id).toBe(data.setup_task_id);
		expect(setup.number).toBe(1);
		expect(setup.title).toBe('Set up the team');
		expect(data.setup_task_identifier).toBe(setup.identifier);
		expect(suggestions.id).toBe(data.suggestions_task_id);
		expect(suggestions.number).toBe(2);
		expect(suggestions.title).toBe('Suggest starter tasks');
		expect(suggestions.status).toBe('blocked');
		expect(suggestions.assignee_id).toBe(setup.assignee_id);
		expect(data.suggestions_task_identifier).toBe(suggestions.identifier);
		expect(planningRow.id).toBe(data.planning_task_id);
		expect(planningRow.number).toBe(3);
		expect(planningRow.status).toBe('blocked');

		// The suggestions task waits on setup alone.
		const suggestionsDep = await db.query<{ blocked_by_task_id: string }>(
			'SELECT blocked_by_task_id FROM task_dependencies WHERE task_id = $1',
			[data.suggestions_task_id],
		);
		expect(suggestionsDep.rows.map((r) => r.blocked_by_task_id)).toEqual([data.setup_task_id]);

		// …and it sorts first in the project's task list under the default work-order
		// sort (unblocked before blocked), which is what the post-create landing relies
		// on to show it at the top.
		const listRes = await app.request(`/api/projects/${data.slug}/tasks`, {
			headers: authHeader(token),
		});
		expect(listRes.status).toBe(200);
		const listed = (await listRes.json()).data as { id: string }[];
		expect(listed[0].id).toBe(data.setup_task_id);
		expect(listed.map((t) => t.id)).toContain(data.planning_task_id);
	});

	it('gives each project its own distinct team', async () => {
		const a = (await (await createProjectWithTeam('Project Alpha')).json())
			.data as CreatedProjectTeam;
		const b = (await (await createProjectWithTeam('Project Beta')).json())
			.data as CreatedProjectTeam;
		expect(a.team_id).not.toBe(b.team_id);
		expect(a.team_slug).not.toBe(b.team_slug);
	});

	it('rejects missing name or description', async () => {
		const noName = await app.request('/api/projects', {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ description: 'x' }),
		});
		expect(noName.status).toBe(400);
		const noDesc = await app.request('/api/projects', {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ name: 'No Desc' }),
		});
		expect(noDesc.status).toBe(400);
	});

	it('requires superuser', async () => {
		const nonSuper = await db.query<{ id: string }>(
			"INSERT INTO users (display_name, is_superuser) VALUES ('Member', false) RETURNING id",
		);
		const memberToken = await signAdminJwt(masterKeyManager, nonSuper.rows[0].id);
		const res = await app.request('/api/projects', {
			method: 'POST',
			headers: { ...authHeader(memberToken), 'Content-Type': 'application/json' },
			body: JSON.stringify({ name: 'Nope', description: 'x' }),
		});
		expect(res.status).toBe(403);
	});
});
