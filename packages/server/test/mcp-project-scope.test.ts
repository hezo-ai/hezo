import { DEFAULT_TEAM_ID } from '@hezo/shared';
import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MasterKeyManager } from '../src/crypto/master-key';
import type { Db } from '../src/db/database';
import type { Env } from '../src/lib/types';
import { signChatSessionJwt } from '../src/middleware/auth';
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
let adminToken: string;
let masterKeyManager: MasterKeyManager;

let teamAId: string;
let captainAId: string;
let projectAId: string;
let projectASlug: string;
let taskInAId: string;

let teamBId: string;
let projectBId: string;
let taskInBId: string;

async function callMcp(token: string, toolName: string, args: Record<string, unknown>) {
	const res = await app.request('/mcp', {
		method: 'POST',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify({
			jsonrpc: '2.0',
			method: 'tools/call',
			params: { name: toolName, arguments: args },
			id: 1,
		}),
	});
	const body = (await res.json()) as {
		result: { content: Array<{ type: string; text: string }> };
	};
	return JSON.parse(body.result.content[0].text) as Record<string, unknown> | unknown[];
}

/** Call a paged list tool and return just its rows. */
async function callMcpList(token: string, toolName: string, args: Record<string, unknown>) {
	const page = (await callMcp(token, toolName, args)) as { items?: unknown[] };
	return page.items ?? [];
}

async function makeTeam(name: string): Promise<{ teamId: string; captainId: string }> {
	const teamRes = await createTestTeam(db, { name });
	const teamId = (await teamRes.json()).data.id as string;
	const captain = await db.query<{ id: string }>(
		`SELECT ma.id FROM member_agents ma JOIN members m ON m.id = ma.id
		 WHERE m.team_id = $1 AND ma.slug = 'captain'`,
		[teamId],
	);
	return { teamId, captainId: captain.rows[0].id };
}

beforeAll(async () => {
	const ctx = await createTestApp();
	app = ctx.app;
	db = ctx.db;
	adminToken = ctx.token;
	masterKeyManager = ctx.masterKeyManager;

	// Each team owns exactly one project (1:1). Cross-project access is therefore
	// always cross-team — two teams give us the scope boundary to test.
	const teamA = await makeTeam('Project Scope Test Co A');
	teamAId = teamA.teamId;
	captainAId = teamA.captainId;
	const projectARes = await createTestProject(db, teamAId, {
		name: 'Project A',
		description: 'team A project',
	});
	const projectAData = (await projectARes.json()).data;
	projectAId = projectAData.id;
	projectASlug = projectAData.slug;

	const teamB = await makeTeam('Project Scope Test Co B');
	teamBId = teamB.teamId;
	const projectBRes = await createTestProject(db, teamBId, {
		name: 'Project B',
		description: 'team B project',
	});
	const projectBData = (await projectBRes.json()).data;
	projectBId = projectBData.id;
	const projectBSlug = projectBData.slug;

	const taskARes = await app.request(`/api/projects/${projectASlug}/tasks`, {
		method: 'POST',
		headers: { ...authHeader(adminToken), 'Content-Type': 'application/json' },
		body: JSON.stringify({ project_id: projectAId, title: 'Task in A', assignee_id: captainAId }),
	});
	taskInAId = (await taskARes.json()).data.id;

	const taskBRes = await app.request(`/api/projects/${projectBSlug}/tasks`, {
		method: 'POST',
		headers: { ...authHeader(adminToken), 'Content-Type': 'application/json' },
		body: JSON.stringify({
			project_id: projectBId,
			title: 'Task in B',
			assignee_id: teamB.captainId,
		}),
	});
	taskInBId = (await taskBRes.json()).data.id;
});

afterAll(async () => {
	await safeClose(db);
});

describe('MCP project scope — agent run scoped to its project', () => {
	let scopedToken: string;

	beforeAll(async () => {
		const minted = await mintAgentToken(db, masterKeyManager, captainAId, teamAId, taskInAId, {
			projectId: projectAId,
			crossProject: false,
		});
		scopedToken = minted.token;
	});

	it('list_projects returns the run`s own project', async () => {
		const rows = (await callMcpList(scopedToken, 'list_projects', {})) as Array<{ id: string }>;
		expect(rows).toHaveLength(1);
		expect(rows[0].id).toBe(projectAId);
	});

	it('list_tasks with no project arg implicitly scopes to the run`s project', async () => {
		const rows = (await callMcpList(scopedToken, 'list_tasks', {})) as Array<{
			project_id: string;
		}>;
		expect(rows.length).toBeGreaterThan(0);
		for (const row of rows) expect(row.project_id).toBe(projectAId);
	});

	it('list_tasks pointed at a foreign project is denied', async () => {
		const result = (await callMcp(scopedToken, 'list_tasks', {
			project: projectBId,
		})) as { error: string };
		expect(result.error).toMatch(/not scoped/);
	});

	it('get_task on a foreign project task is denied', async () => {
		const result = (await callMcp(scopedToken, 'get_task', {
			task_id: taskInBId,
		})) as { id?: string } | null;
		expect(result?.id).toBeUndefined();
	});

	it('get_task on own project task succeeds', async () => {
		const result = (await callMcp(scopedToken, 'get_task', {
			task_id: taskInAId,
		})) as { id: string };
		expect(result.id).toBe(taskInAId);
	});

	it('read_project_doc on a foreign project is denied', async () => {
		const result = (await callMcp(scopedToken, 'read_project_doc', {
			project: projectBId,
			filename: 'spec.md',
		})) as { error: string };
		expect(result.error).toMatch(/not scoped/);
	});

	it('list_project_docs on a foreign project is denied', async () => {
		const result = (await callMcp(scopedToken, 'list_project_docs', {
			project: projectBId,
		})) as { error: string };
		expect(result.error).toMatch(/not scoped/);
	});

	it('create_task in another project is denied', async () => {
		const result = (await callMcp(scopedToken, 'create_task', {
			project: projectBId,
			title: 'should not work',
			assignee_slug: 'captain',
		})) as { error: string };
		expect(result.error).toMatch(/not scoped/);
	});

	it('list_comments on a foreign project`s task is denied', async () => {
		const result = (await callMcp(scopedToken, 'list_comments', {
			task_id: taskInBId,
		})) as { error: string };
		expect(result.error).toMatch(/not found|not scoped/);
	});

	it('cannot reach another project by naming it explicitly', async () => {
		const result = (await callMcp(scopedToken, 'get_task', {
			project: projectBId,
			task_id: taskInBId,
		})) as { error: string };
		expect(result.error).toMatch(/Access denied/);
	});
});

describe('MCP cross-team CEO — instance-wide discovery', () => {
	let ceoToken: string;

	beforeAll(async () => {
		// Mint a persistent CEO chat-session principal (cross_team + cross_project),
		// the same token the live chat box runs under.
		const ceo = await db.query<{ id: string }>(
			`SELECT m.id FROM members m JOIN member_agents ma ON ma.id = m.id
			 WHERE ma.slug = 'ceo' AND m.team_id = $1`,
			[DEFAULT_TEAM_ID],
		);
		const hqProject = await db.query<{ id: string }>(
			`SELECT id FROM projects WHERE team_id = $1 AND is_internal = true`,
			[DEFAULT_TEAM_ID],
		);
		const session = await db.query<{ id: string }>(
			`INSERT INTO chat_sessions (member_id, team_id, project_id, runtime_type, status)
			 VALUES ($1, $2, $3, 'claude_code', 'running') RETURNING id`,
			[ceo.rows[0].id, DEFAULT_TEAM_ID, hqProject.rows[0].id],
		);
		ceoToken = await signChatSessionJwt(
			masterKeyManager,
			ceo.rows[0].id,
			DEFAULT_TEAM_ID,
			session.rows[0].id,
			hqProject.rows[0].id,
			{ crossProject: true, crossTeam: true },
		);
	});

	it('list_teams returns every team in the instance, not just HQ', async () => {
		const rows = (await callMcpList(ceoToken, 'list_teams', {})) as Array<{ id: string }>;
		const ids = rows.map((r) => r.id);
		expect(ids).toContain(DEFAULT_TEAM_ID);
		expect(ids).toContain(teamAId);
		expect(ids).toContain(teamBId);
	});

	it('list_projects returns every project across all teams, with team_id but no team name or slug', async () => {
		const rows = (await callMcpList(ceoToken, 'list_projects', {})) as Array<{
			id: string;
			team_id: string;
			is_internal: boolean;
		}>;
		const ids = rows.map((r) => r.id);
		expect(ids).toContain(projectAId);
		expect(ids).toContain(projectBId);
		// HQ (the one internal project) is included so the CEO sees the whole picture.
		expect(rows.some((r) => r.is_internal)).toBe(true);
		// Every row still carries its owning team_id so the CEO can drill in by
		// project, but the human-readable team name/slug never leaks into output —
		// projects are the unit the CEO names; teams are just a part of them.
		const a = rows.find((r) => r.id === projectAId);
		expect(a?.team_id).toBe(teamAId);
		const aRecord = a as unknown as Record<string, unknown>;
		expect(aRecord.team_name).toBeUndefined();
		expect(aRecord.team_slug).toBeUndefined();
	});

	it('can list tasks in any project without being scoped to it', async () => {
		const rows = (await callMcpList(ceoToken, 'list_tasks', { project: projectBId })) as Array<{
			id: string;
		}>;
		expect(rows.some((r) => r.id === taskInBId)).toBe(true);
	});
});

describe('MCP project scope — admin / api-key auth bypasses the check', () => {
	it('admin token can read tasks from any project (regression guard)', async () => {
		const a = (await callMcp(adminToken, 'get_task', {
			project: projectAId,
			task_id: taskInAId,
		})) as { id: string };
		const b = (await callMcp(adminToken, 'get_task', {
			project: projectBId,
			task_id: taskInBId,
		})) as { id: string };
		expect(a.id).toBe(taskInAId);
		expect(b.id).toBe(taskInBId);
	});
});
