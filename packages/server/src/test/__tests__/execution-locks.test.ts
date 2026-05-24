import type { PGlite } from '@electric-sql/pglite';
import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Env } from '../../lib/types';
import { safeClose } from '../helpers';
import { authHeader, createTestApp } from '../helpers/app';

let app: Hono<Env>;
let db: PGlite;
let token: string;
let teamId: string;
let projectId: string;
let taskId: string;
let agentId: string;
let secondAgentId: string;

beforeAll(async () => {
	const ctx = await createTestApp();
	app = ctx.app;
	db = ctx.db;
	token = ctx.token;

	const typesRes = await app.request('/api/team-templates', { headers: authHeader(token) });
	const teamTemplateId = (await typesRes.json()).data.find((t: any) => t.name === 'Startup').id;

	const teamRes = await app.request('/api/teams', {
		method: 'POST',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify({
			name: 'Lock Test Co',

			template_id: teamTemplateId,
		}),
	});
	teamId = (await teamRes.json()).data.id;

	const projectRes = await app.request(`/api/teams/${teamId}/projects`, {
		method: 'POST',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify({ name: 'Lock Test Project', description: 'Test project.' }),
	});
	projectId = (await projectRes.json()).data.id;

	const agentsRes = await app.request(`/api/teams/${teamId}/agents`, {
		headers: authHeader(token),
	});
	const agents = (await agentsRes.json()).data;
	agentId = agents[0].id;
	secondAgentId = agents[1].id;

	const taskRes = await app.request(`/api/teams/${teamId}/tasks`, {
		method: 'POST',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify({ project_id: projectId, title: 'Lock Test Task', assignee_id: agentId }),
	});
	taskId = (await taskRes.json()).data.id;
});

afterAll(async () => {
	await safeClose(db);
});

describe('execution locks', () => {
	it('returns empty locks when no lock exists', async () => {
		const res = await app.request(`/api/teams/${teamId}/tasks/${taskId}/lock`, {
			headers: authHeader(token),
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.data.locks).toEqual([]);
	});

	it('creates a lock', async () => {
		const res = await app.request(`/api/teams/${teamId}/tasks/${taskId}/lock`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ member_id: agentId }),
		});
		expect(res.status).toBe(201);
		const body = await res.json();
		expect(body.data.task_id).toBe(taskId);
		expect(body.data.member_id).toBe(agentId);
	});

	it('prevents the same member re-acquiring while its lock is active', async () => {
		const res = await app.request(`/api/teams/${teamId}/tasks/${taskId}/lock`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ member_id: agentId }),
		});
		expect(res.status).toBe(409);
	});

	it('allows a different member to acquire concurrently', async () => {
		const res = await app.request(`/api/teams/${teamId}/tasks/${taskId}/lock`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ member_id: secondAgentId }),
		});
		expect(res.status).toBe(201);
	});

	it('returns all active locks for the task', async () => {
		const res = await app.request(`/api/teams/${teamId}/tasks/${taskId}/lock`, {
			headers: authHeader(token),
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.data.locks.length).toBe(2);
		const memberIds = body.data.locks.map((l: { member_id: string }) => l.member_id).sort();
		expect(memberIds).toEqual([agentId, secondAgentId].sort());
		expect(body.data.locks[0]).toHaveProperty('member_name');
	});

	it('releases all locks on the task', async () => {
		const res = await app.request(`/api/teams/${teamId}/tasks/${taskId}/lock`, {
			method: 'DELETE',
			headers: authHeader(token),
		});
		expect(res.status).toBe(200);

		const checkRes = await app.request(`/api/teams/${teamId}/tasks/${taskId}/lock`, {
			headers: authHeader(token),
		});
		const body = await checkRes.json();
		expect(body.data.locks).toEqual([]);
	});

	it('allows re-acquiring after release', async () => {
		const res = await app.request(`/api/teams/${teamId}/tasks/${taskId}/lock`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ member_id: agentId }),
		});
		expect(res.status).toBe(201);

		await app.request(`/api/teams/${teamId}/tasks/${taskId}/lock`, {
			method: 'DELETE',
			headers: authHeader(token),
		});
	});
});
