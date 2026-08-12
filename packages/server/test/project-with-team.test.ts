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

		// The planning task is blocked by an initial CEO coherence/setup task.
		const dep = await db.query<{ blocked_by_task_id: string }>(
			'SELECT blocked_by_task_id FROM task_dependencies WHERE task_id = $1',
			[data.planning_task_id],
		);
		expect(dep.rows).toHaveLength(1);

		// That setup task is surfaced on the response: it is the project's FIRST task
		// (number 1) and the one the planning task is blocked by, so the creator can
		// land the operator on it.
		expect(data.setup_task_id).toBe(dep.rows[0].blocked_by_task_id);
		const setup = await db.query<{ number: number; identifier: string; title: string }>(
			'SELECT number, identifier, title FROM tasks WHERE id = $1',
			[data.setup_task_id],
		);
		expect(setup.rows[0].number).toBe(1);
		expect(setup.rows[0].title).toBe('Set up the team');
		expect(data.setup_task_identifier).toBe(setup.rows[0].identifier);

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
