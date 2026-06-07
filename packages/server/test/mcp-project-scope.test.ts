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

let teamId: string;
let teamSlug: string;
let captainId: string;
let projectAId: string;
let projectASlug: string;
let projectBId: string;
let projectBSlug: string;
let internalProjectId: string;
let internalProjectSlug: string;
let taskInAId: string;
let taskInBId: string;
let taskInInternalId: string;

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

beforeAll(async () => {
	const ctx = await createTestApp();
	app = ctx.app;
	db = ctx.db;
	adminToken = ctx.token;
	masterKeyManager = ctx.masterKeyManager;

	const teamRes = await app.request('/api/teams', {
		method: 'POST',
		headers: { ...authHeader(adminToken), 'Content-Type': 'application/json' },
		body: JSON.stringify({ name: 'Project Scope Test Co' }),
	});
	const teamData = (await teamRes.json()).data;
	teamId = teamData.id;
	teamSlug = teamData.slug;
	internalProjectSlug = `internal-${teamSlug}`;

	const agentsRes = await app.request(`/api/projects/${internalProjectSlug}/agents`, {
		headers: authHeader(adminToken),
	});
	const captain = (await agentsRes.json()).data.find((a: { slug: string }) => a.slug === 'captain');
	captainId = captain.id;

	const internalProject = await db.query<{ id: string }>(
		`SELECT id FROM projects WHERE team_id = $1 AND is_internal = true`,
		[teamId],
	);
	internalProjectId = internalProject.rows[0].id;

	const projectARes = await createTestProject(db, teamId, {
		name: 'Project A',
		description: 'first user project',
	});
	const projectAData = (await projectARes.json()).data;
	projectAId = projectAData.id;
	projectASlug = projectAData.slug;

	const projectBRes = await createTestProject(db, teamId, {
		name: 'Project B',
		description: 'second user project',
	});
	const projectBData = (await projectBRes.json()).data;
	projectBId = projectBData.id;
	projectBSlug = projectBData.slug;

	const taskARes = await app.request(`/api/projects/${projectASlug}/tasks`, {
		method: 'POST',
		headers: { ...authHeader(adminToken), 'Content-Type': 'application/json' },
		body: JSON.stringify({
			project_id: projectAId,
			title: 'Task in A',
			assignee_id: captainId,
		}),
	});
	taskInAId = (await taskARes.json()).data.id;

	const taskBRes = await app.request(`/api/projects/${projectBSlug}/tasks`, {
		method: 'POST',
		headers: { ...authHeader(adminToken), 'Content-Type': 'application/json' },
		body: JSON.stringify({
			project_id: projectBId,
			title: 'Task in B',
			assignee_id: captainId,
		}),
	});
	taskInBId = (await taskBRes.json()).data.id;

	const taskInternalRes = await app.request(`/api/projects/${internalProjectSlug}/tasks`, {
		method: 'POST',
		headers: { ...authHeader(adminToken), 'Content-Type': 'application/json' },
		body: JSON.stringify({
			project_id: internalProjectId,
			title: 'Task in Internal',
			assignee_id: captainId,
		}),
	});
	taskInInternalId = (await taskInternalRes.json()).data.id;
});

afterAll(async () => {
	await safeClose(db);
});

describe('MCP project scope — agent run scoped to a non-internal project', () => {
	let scopedToken: string;

	beforeAll(async () => {
		const minted = await mintAgentToken(db, masterKeyManager, captainId, teamId, taskInAId, {
			projectId: projectAId,
			crossProject: false,
		});
		scopedToken = minted.token;
	});

	it('list_projects returns only the run`s own project', async () => {
		const rows = (await callMcp(scopedToken, 'list_projects', { team_id: teamId })) as Array<{
			id: string;
		}>;
		expect(rows).toHaveLength(1);
		expect(rows[0].id).toBe(projectAId);
	});

	it('list_tasks without project_id implicitly scopes to the run`s project', async () => {
		const rows = (await callMcp(scopedToken, 'list_tasks', { team_id: teamId })) as Array<{
			project_id: string;
		}>;
		expect(rows.length).toBeGreaterThan(0);
		for (const row of rows) expect(row.project_id).toBe(projectAId);
	});

	it('list_tasks with another project_id is denied', async () => {
		const result = (await callMcp(scopedToken, 'list_tasks', {
			team_id: teamId,
			project_id: projectBId,
		})) as { error: string };
		expect(result.error).toMatch(/not scoped/);
	});

	it('get_task on a foreign project task is denied', async () => {
		const result = (await callMcp(scopedToken, 'get_task', {
			team_id: teamId,
			task_id: taskInBId,
		})) as { error: string };
		expect(result.error).toMatch(/not scoped/);
	});

	it('get_task on own project task succeeds', async () => {
		const result = (await callMcp(scopedToken, 'get_task', {
			team_id: teamId,
			task_id: taskInAId,
		})) as { id: string };
		expect(result.id).toBe(taskInAId);
	});

	it('read_project_doc on a foreign project is denied', async () => {
		const result = (await callMcp(scopedToken, 'read_project_doc', {
			team_id: teamId,
			project_id: projectBId,
			filename: 'spec.md',
		})) as { error: string };
		expect(result.error).toMatch(/not scoped/);
	});

	it('list_project_docs on a foreign project is denied', async () => {
		const result = (await callMcp(scopedToken, 'list_project_docs', {
			team_id: teamId,
			project_id: projectBId,
		})) as { error: string };
		expect(result.error).toMatch(/not scoped/);
	});

	it('create_task in another project is denied', async () => {
		const result = (await callMcp(scopedToken, 'create_task', {
			team_id: teamId,
			project_id: projectBId,
			title: 'should not work',
			assignee_slug: 'captain',
		})) as { error: string };
		expect(result.error).toMatch(/not scoped/);
	});

	it('list_comments on a foreign project`s task is denied', async () => {
		const result = (await callMcp(scopedToken, 'list_comments', {
			team_id: teamId,
			task_id: taskInBId,
		})) as { error: string };
		expect(result.error).toMatch(/not scoped/);
	});

	it('create_project is rejected for project-scoped agents', async () => {
		const result = (await callMcp(scopedToken, 'create_project', {
			team_id: teamId,
			name: 'Should Not Land',
		})) as { error: string };
		expect(result.error).toMatch(/not scoped/);
	});
});

describe('MCP project scope — agent run in the Internal project has cross-project access', () => {
	let internalToken: string;

	beforeAll(async () => {
		const minted = await mintAgentToken(db, masterKeyManager, captainId, teamId, taskInInternalId);
		internalToken = minted.token;
	});

	it('list_projects returns every project in the team', async () => {
		const rows = (await callMcp(internalToken, 'list_projects', {
			team_id: teamId,
		})) as Array<{ id: string }>;
		const ids = rows.map((r) => r.id).sort();
		const expected = [internalProjectId, projectAId, projectBId].sort();
		expect(ids).toEqual(expected);
	});

	it('get_task on any project succeeds', async () => {
		const a = (await callMcp(internalToken, 'get_task', {
			team_id: teamId,
			task_id: taskInAId,
		})) as { id: string };
		const b = (await callMcp(internalToken, 'get_task', {
			team_id: teamId,
			task_id: taskInBId,
		})) as { id: string };
		expect(a.id).toBe(taskInAId);
		expect(b.id).toBe(taskInBId);
	});

	it('list_tasks with another project_id is allowed', async () => {
		const rows = (await callMcp(internalToken, 'list_tasks', {
			team_id: teamId,
			project_id: projectBId,
		})) as Array<{ project_id: string }>;
		for (const row of rows) expect(row.project_id).toBe(projectBId);
	});
});

describe('MCP project scope — admin / api-key auth bypasses the new check', () => {
	it('admin token can read tasks from any project (regression guard)', async () => {
		const a = (await callMcp(adminToken, 'get_task', {
			team_id: teamId,
			task_id: taskInAId,
		})) as { id: string };
		const b = (await callMcp(adminToken, 'get_task', {
			team_id: teamId,
			task_id: taskInBId,
		})) as { id: string };
		expect(a.id).toBe(taskInAId);
		expect(b.id).toBe(taskInBId);
	});
});
