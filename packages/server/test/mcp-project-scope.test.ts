import type { PGlite } from '@electric-sql/pglite';
import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MasterKeyManager } from '../src/crypto/master-key';
import type { Env } from '../src/lib/types';
import { safeClose } from './helpers';
import { authHeader, createTestApp, createTestProject, mintAgentToken } from './helpers/app';

let app: Hono<Env>;
let db: PGlite;
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

async function makeTeam(name: string): Promise<{ teamId: string; captainId: string }> {
	const teamRes = await app.request('/api/teams', {
		method: 'POST',
		headers: { ...authHeader(adminToken), 'Content-Type': 'application/json' },
		body: JSON.stringify({ name }),
	});
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

describe('MCP project scope — agent run scoped to its team`s project', () => {
	let scopedToken: string;

	beforeAll(async () => {
		const minted = await mintAgentToken(db, masterKeyManager, captainAId, teamAId, taskInAId, {
			projectId: projectAId,
			crossProject: false,
		});
		scopedToken = minted.token;
	});

	it('list_projects returns the run`s own project', async () => {
		const rows = (await callMcp(scopedToken, 'list_projects', { team_id: teamAId })) as Array<{
			id: string;
		}>;
		expect(rows).toHaveLength(1);
		expect(rows[0].id).toBe(projectAId);
	});

	it('list_tasks without project_id implicitly scopes to the run`s project', async () => {
		const rows = (await callMcp(scopedToken, 'list_tasks', { team_id: teamAId })) as Array<{
			project_id: string;
		}>;
		expect(rows.length).toBeGreaterThan(0);
		for (const row of rows) expect(row.project_id).toBe(projectAId);
	});

	it('list_tasks pointed at a foreign project is denied', async () => {
		const result = (await callMcp(scopedToken, 'list_tasks', {
			team_id: teamAId,
			project_id: projectBId,
		})) as { error: string };
		expect(result.error).toMatch(/not scoped/);
	});

	it('get_task on a foreign project task is denied', async () => {
		const result = (await callMcp(scopedToken, 'get_task', {
			team_id: teamAId,
			task_id: taskInBId,
		})) as { id?: string } | null;
		expect(result?.id).toBeUndefined();
	});

	it('get_task on own project task succeeds', async () => {
		const result = (await callMcp(scopedToken, 'get_task', {
			team_id: teamAId,
			task_id: taskInAId,
		})) as { id: string };
		expect(result.id).toBe(taskInAId);
	});

	it('read_project_doc on a foreign project is denied', async () => {
		const result = (await callMcp(scopedToken, 'read_project_doc', {
			team_id: teamAId,
			project_id: projectBId,
			filename: 'spec.md',
		})) as { error: string };
		expect(result.error).toMatch(/not scoped/);
	});

	it('list_project_docs on a foreign project is denied', async () => {
		const result = (await callMcp(scopedToken, 'list_project_docs', {
			team_id: teamAId,
			project_id: projectBId,
		})) as { error: string };
		expect(result.error).toMatch(/not scoped/);
	});

	it('create_task in another project is denied', async () => {
		const result = (await callMcp(scopedToken, 'create_task', {
			team_id: teamAId,
			project_id: projectBId,
			title: 'should not work',
			assignee_slug: 'captain',
		})) as { error: string };
		expect(result.error).toMatch(/not scoped/);
	});

	it('list_comments on a foreign project`s task is denied', async () => {
		const result = (await callMcp(scopedToken, 'list_comments', {
			team_id: teamAId,
			task_id: taskInBId,
		})) as { error: string };
		expect(result.error).toMatch(/not found|not scoped/);
	});

	it('create_project is rejected for project-scoped agents', async () => {
		const result = (await callMcp(scopedToken, 'create_project', {
			team_id: teamAId,
			name: 'Should Not Land',
		})) as { error: string };
		expect(result.error).toMatch(/not scoped/);
	});

	it('cannot reach another team', async () => {
		const result = (await callMcp(scopedToken, 'get_task', {
			team_id: teamBId,
			task_id: taskInBId,
		})) as { error: string };
		expect(result.error).toMatch(/Access denied/);
	});
});

describe('MCP project scope — admin / api-key auth bypasses the check', () => {
	it('admin token can read tasks from any project (regression guard)', async () => {
		const a = (await callMcp(adminToken, 'get_task', {
			team_id: teamAId,
			task_id: taskInAId,
		})) as { id: string };
		const b = (await callMcp(adminToken, 'get_task', {
			team_id: teamBId,
			task_id: taskInBId,
		})) as { id: string };
		expect(a.id).toBe(taskInAId);
		expect(b.id).toBe(taskInBId);
	});
});
