import { DEFAULT_TEAM_ID } from '@hezo/shared';
import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MasterKeyManager } from '../src/crypto/master-key';
import type { Db } from '../src/db/database';
import type { Env } from '../src/lib/types';
import { signAdminJwt } from '../src/middleware/auth';
import { safeClose } from './helpers';
import {
	authHeader,
	createTestApp,
	createTestProject,
	createTestTeam,
	instanceCeoId,
	mintAgentToken,
} from './helpers/app';
import { callMcpTool } from './helpers/mcp-call';

// "Suggest tasks" on an existing project: POST /projects/:projectId/task-suggestions
// and its tool twin start_task_suggestions open the CEO's suggestions task, or
// return the open one.

let app: Hono<Env>;
let db: Db;
let token: string;
let masterKeyManager: MasterKeyManager;
let teamId: string;
let projectId: string;
let projectSlug: string;
let ceoId: string;

beforeAll(async () => {
	const ctx = await createTestApp();
	app = ctx.app;
	db = ctx.db;
	token = ctx.token;
	masterKeyManager = ctx.masterKeyManager;
	const teamRes = await createTestTeam(db, { name: 'Suggest Route Co' });
	teamId = (await teamRes.json()).data.id;
	const project = (await (await createTestProject(db, teamId, { name: 'Suggest Route' })).json())
		.data;
	projectId = project.id;
	projectSlug = project.slug;
	ceoId = await instanceCeoId(db);
});

afterAll(async () => {
	await safeClose(db);
});

async function post(bearer: string, slug = projectSlug): Promise<Response> {
	return app.request(`/api/projects/${slug}/task-suggestions`, {
		method: 'POST',
		headers: { ...authHeader(bearer), 'Content-Type': 'application/json' },
		body: '{}',
	});
}

async function clearSuggestionTasks(): Promise<void> {
	await db.query(`DELETE FROM tasks WHERE labels @> '["task-suggestions"]'::jsonb`);
}

describe('POST /projects/:projectId/task-suggestions', () => {
	it('opens the CEO suggestions task (201), then returns it again (200)', async () => {
		await clearSuggestionTasks();
		const first = await post(token);
		expect(first.status).toBe(201);
		const created = (await first.json()).data as {
			task_id: string;
			task_identifier: string;
			created: boolean;
		};
		expect(created.created).toBe(true);
		const row = await db.query<{
			project_id: string;
			assignee_id: string;
			title: string;
			status: string;
		}>('SELECT project_id, assignee_id, title, status::text AS status FROM tasks WHERE id = $1', [
			created.task_id,
		]);
		expect(row.rows[0]).toMatchObject({
			project_id: projectId,
			assignee_id: ceoId,
			title: 'Suggest tasks',
			status: 'backlog',
		});
		const wakes = await db.query(
			`SELECT 1 FROM agent_wakeup_requests WHERE member_id = $1 AND payload->>'task_id' = $2`,
			[ceoId, created.task_id],
		);
		expect(wakes.rows).toHaveLength(1);

		const again = await post(token);
		expect(again.status).toBe(200);
		expect((await again.json()).data).toEqual({ ...created, created: false });
	});

	it('refuses a team member who is not a superuser', async () => {
		const user = await db.query<{ id: string }>(
			"INSERT INTO users (display_name, is_superuser) VALUES ('Member', false) RETURNING id",
		);
		const member = await db.query<{ id: string }>(
			`INSERT INTO members (team_id, member_type, display_name) VALUES ($1, 'user', 'Member') RETURNING id`,
			[teamId],
		);
		await db.query(`INSERT INTO member_users (id, user_id, role) VALUES ($1, $2, 'admin')`, [
			member.rows[0].id,
			user.rows[0].id,
		]);
		const memberToken = await signAdminJwt(masterKeyManager, user.rows[0].id);
		expect((await post(memberToken)).status).toBe(403);
	});

	it('refuses HQ', async () => {
		const res = await post(token, 'hq');
		expect(res.status).toBe(400);
		expect((await res.json()).error.message).toMatch(/HQ project/);
	});
});

describe('start_task_suggestions', () => {
	it('lets an admin start it', async () => {
		await clearSuggestionTasks();
		const result = (await callMcpTool(app, token, 'start_task_suggestions', {
			project: projectSlug,
		})) as { created?: boolean; task_identifier?: string; error?: string };
		expect(result.error).toBeUndefined();
		expect(result.created).toBe(true);
		expect(result.task_identifier).toBeTruthy();
	});

	it('lets the CEO start it and records the run that filed it', async () => {
		await clearSuggestionTasks();
		const { token: ceoToken, runId } = await mintAgentToken(
			db,
			masterKeyManager,
			ceoId,
			teamId,
			null,
			{ projectId },
		);
		const result = (await callMcpTool(app, ceoToken, 'start_task_suggestions', {
			project: projectSlug,
		})) as { task_id: string; created: boolean };
		expect(result.created).toBe(true);
		const row = await db.query<{ created_by_run_id: string | null }>(
			'SELECT created_by_run_id FROM tasks WHERE id = $1',
			[result.task_id],
		);
		expect(row.rows[0].created_by_run_id).toBe(runId);
	});

	it('refuses an agent that is not the CEO', async () => {
		const captain = await db.query<{ id: string }>(
			`SELECT ma.id FROM member_agents ma JOIN members m ON m.id = ma.id
			 WHERE m.team_id = $1 AND ma.slug = 'captain'`,
			[teamId],
		);
		const { token: captainToken } = await mintAgentToken(
			db,
			masterKeyManager,
			captain.rows[0].id,
			teamId,
			null,
			{ projectId },
		);
		const result = (await callMcpTool(app, captainToken, 'start_task_suggestions', {
			project: projectSlug,
		})) as { error?: string };
		expect(result.error).toMatch(/Only the CEO/);
	});

	it('refuses HQ', async () => {
		const { token: hqToken } = await mintAgentToken(
			db,
			masterKeyManager,
			ceoId,
			DEFAULT_TEAM_ID,
			null,
			{
				crossProject: true,
			},
		);
		const result = (await callMcpTool(app, hqToken, 'start_task_suggestions', {
			project: 'hq',
		})) as { error?: string };
		expect(result.error).toMatch(/HQ project/);
	});
});
