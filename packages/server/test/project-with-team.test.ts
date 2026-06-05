import type { PGlite } from '@electric-sql/pglite';
import { CAPTAIN_AGENT_SLUG } from '@hezo/shared';
import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MasterKeyManager } from '../src/crypto/master-key';
import type { Env } from '../src/lib/types';
import { signAdminJwt } from '../src/middleware/auth';
import { safeClose } from './helpers';
import { authHeader, createTestApp } from './helpers/app';

let app: Hono<Env>;
let db: PGlite;
let token: string;
let masterKeyManager: MasterKeyManager;

interface CreatedProjectTeam {
	team_id: string;
	team_slug: string;
	project_slug: string;
	intake_task_id: string;
	approval_id: string;
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
	it('creates a fresh team (Internal project + Captain) and opens the project intake', async () => {
		const res = await createProjectWithTeam('Marketing Site', 'A site for the launch.');
		expect(res.status).toBe(201);
		const data = (await res.json()).data as CreatedProjectTeam;
		expect(data.team_slug).toBeTruthy();
		expect(data.project_slug).toBeTruthy();
		expect(data.intake_task_id).toBeTruthy();
		expect(data.approval_id).toBeTruthy();

		// The team is named after the project.
		const team = await db.query<{ name: string }>('SELECT name FROM teams WHERE id = $1', [
			data.team_id,
		]);
		expect(team.rows[0]?.name).toBe('Marketing Site');

		// It has an Internal project and an enabled Captain.
		const internal = await db.query<{ id: string }>(
			'SELECT id FROM projects WHERE team_id = $1 AND is_internal = true',
			[data.team_id],
		);
		expect(internal.rows).toHaveLength(1);

		const captain = await db.query<{ id: string }>(
			`SELECT ma.id FROM member_agents ma
			 JOIN members m ON m.id = ma.id
			 WHERE m.team_id = $1 AND ma.slug = $2 AND ma.admin_status::text = 'enabled'`,
			[data.team_id, CAPTAIN_AGENT_SLUG],
		);
		expect(captain.rows).toHaveLength(1);

		// The intake task lives in that team's Internal project, assigned to its Captain.
		const intake = await db.query<{ project_id: string; assignee_id: string }>(
			'SELECT project_id, assignee_id FROM tasks WHERE id = $1',
			[data.intake_task_id],
		);
		expect(intake.rows[0]?.project_id).toBe(internal.rows[0].id);
		expect(intake.rows[0]?.assignee_id).toBe(captain.rows[0].id);

		// The approval is a pending project_creation.
		const appr = await db.query<{ type: string; status: string }>(
			'SELECT type::text, status::text FROM approvals WHERE id = $1',
			[data.approval_id],
		);
		expect(appr.rows[0]?.type).toBe('project_creation');
		expect(appr.rows[0]?.status).toBe('pending');
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
