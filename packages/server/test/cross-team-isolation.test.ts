import type { PGlite } from '@electric-sql/pglite';
import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MasterKeyManager } from '../src/crypto/master-key';
import type { Env } from '../src/lib/types';
import { signAdminJwt } from '../src/middleware/auth';
import { safeClose } from './helpers';
import {
	authHeader,
	createTestApp,
	createTestProject,
	mintAgentToken,
	projectSlugForTeamSlug,
} from './helpers/app';

let app: Hono<Env>;
let db: PGlite;
let superuserToken: string;
let masterKeyManager: MasterKeyManager;

// Team A
let teamAId: string;
let teamASlug: string;
let agentAId: string;
let agentAToken: string;
let projectAId: string;
let projectASlug: string;
let taskAId: string;

// Team B
let teamBId: string;
let teamBSlug: string;
let agentBId: string;
let agentBToken: string;

// Non-superuser the admin (member of Team A only)
let userAToken: string;

beforeAll(async () => {
	const ctx = await createTestApp();
	app = ctx.app;
	db = ctx.db;
	superuserToken = ctx.token;
	masterKeyManager = ctx.masterKeyManager;

	const typesRes = await app.request('/api/team-templates', {
		headers: authHeader(superuserToken),
	});
	const typeId = (await typesRes.json()).data.find((t: any) => t.name === 'Startup').id;

	// Create Team A
	const teamARes = await app.request('/api/teams', {
		method: 'POST',
		headers: { ...authHeader(superuserToken), 'Content-Type': 'application/json' },
		body: JSON.stringify({ name: 'Team Alpha', template_id: typeId }),
	});
	const teamA = (await teamARes.json()).data;
	teamAId = teamA.id;
	teamASlug = teamA.slug;

	// Create Team B
	const teamBRes = await app.request('/api/teams', {
		method: 'POST',
		headers: { ...authHeader(superuserToken), 'Content-Type': 'application/json' },
		body: JSON.stringify({ name: 'Team Beta', template_id: typeId }),
	});
	const teamB = (await teamBRes.json()).data;
	teamBId = teamB.id;
	teamBSlug = teamB.slug;

	// Get agents
	const agentsARes = await app.request(
		`/api/projects/${await projectSlugForTeamSlug(db, teamASlug)}/agents`,
		{
			headers: authHeader(superuserToken),
		},
	);
	agentAId = (await agentsARes.json()).data[0].id;
	const internalAId = (
		await db.query<{ id: string }>(
			'SELECT id FROM projects WHERE team_id = $1 AND is_internal = false',
			[teamAId],
		)
	).rows[0].id;
	({ token: agentAToken } = await mintAgentToken(db, masterKeyManager, agentAId, teamAId, null, {
		projectId: internalAId,
	}));

	const agentsBRes = await app.request(
		`/api/projects/${await projectSlugForTeamSlug(db, teamBSlug)}/agents`,
		{
			headers: authHeader(superuserToken),
		},
	);
	agentBId = (await agentsBRes.json()).data[0].id;
	const internalBId = (
		await db.query<{ id: string }>(
			'SELECT id FROM projects WHERE team_id = $1 AND is_internal = false',
			[teamBId],
		)
	).rows[0].id;
	({ token: agentBToken } = await mintAgentToken(db, masterKeyManager, agentBId, teamBId, null, {
		projectId: internalBId,
	}));

	// Create project in Team A
	const projectRes = await createTestProject(db, teamAId, {
		name: 'Alpha Project',
		description: 'Test project.',
	});
	const projectA = (await projectRes.json()).data;
	projectAId = projectA.id;
	projectASlug = projectA.slug;

	// Create task in Team A
	const taskRes = await app.request(`/api/projects/${projectASlug}/tasks`, {
		method: 'POST',
		headers: { ...authHeader(superuserToken), 'Content-Type': 'application/json' },
		body: JSON.stringify({ project_id: projectAId, title: 'Alpha Task', assignee_id: agentAId }),
	});
	taskAId = (await taskRes.json()).data.id;

	// Create a non-superuser who is a member of Team A only
	const userRes = await db.query<{ id: string }>(
		"INSERT INTO users (display_name, is_superuser) VALUES ('User A', false) RETURNING id",
	);
	const userAId = userRes.rows[0].id;
	userAToken = await signAdminJwt(masterKeyManager, userAId);

	// Add User A as a member of Team A
	const memberRes = await db.query<{ id: string }>(
		`INSERT INTO members (team_id, display_name, member_type)
		 VALUES ($1, 'User A', 'user') RETURNING id`,
		[teamAId],
	);
	await db.query('INSERT INTO member_users (id, user_id) VALUES ($1, $2)', [
		memberRes.rows[0].id,
		userAId,
	]);
});

afterAll(async () => {
	await safeClose(db);
});

describe('Agent token cross-team isolation', () => {
	it('agent A cannot access Team B agents', async () => {
		const res = await app.request(
			`/api/projects/${await projectSlugForTeamSlug(db, teamBSlug)}/agents`,
			{
				headers: authHeader(agentAToken),
			},
		);
		expect(res.status).toBe(403);
	});

	it('agent A cannot access Team B tasks', async () => {
		const res = await app.request(
			`/api/projects/${await projectSlugForTeamSlug(db, teamBSlug)}/tasks`,
			{
				headers: authHeader(agentAToken),
			},
		);
		expect(res.status).toBe(403);
	});

	it('agent A cannot access Team B projects', async () => {
		const res = await app.request(`/api/projects/${await projectSlugForTeamSlug(db, teamBSlug)}`, {
			headers: authHeader(agentAToken),
		});
		expect(res.status).toBe(403);
	});

	it('agent B cannot access Team A agents', async () => {
		const res = await app.request(
			`/api/projects/${await projectSlugForTeamSlug(db, teamASlug)}/agents`,
			{
				headers: authHeader(agentBToken),
			},
		);
		expect(res.status).toBe(403);
	});

	it('agent B cannot create tasks in Team A', async () => {
		const res = await app.request(`/api/projects/${projectASlug}/tasks`, {
			method: 'POST',
			headers: { ...authHeader(agentBToken), 'Content-Type': 'application/json' },
			body: JSON.stringify({ project_id: projectAId, title: 'Unauthorized Task' }),
		});
		expect(res.status).toBe(403);
	});
});

describe('Admin user cross-team isolation', () => {
	it('user A (member of A only) cannot access Team B agents', async () => {
		const res = await app.request(
			`/api/projects/${await projectSlugForTeamSlug(db, teamBSlug)}/agents`,
			{
				headers: authHeader(userAToken),
			},
		);
		expect(res.status).toBe(403);
	});

	it('user A cannot access Team B tasks', async () => {
		const res = await app.request(
			`/api/projects/${await projectSlugForTeamSlug(db, teamBSlug)}/tasks`,
			{
				headers: authHeader(userAToken),
			},
		);
		expect(res.status).toBe(403);
	});

	it('user A cannot access Team B projects', async () => {
		const res = await app.request(`/api/projects/${await projectSlugForTeamSlug(db, teamBSlug)}`, {
			headers: authHeader(userAToken),
		});
		expect(res.status).toBe(403);
	});

	it('user A cannot create tasks in Team B', async () => {
		const res = await app.request(
			`/api/projects/${await projectSlugForTeamSlug(db, teamBSlug)}/tasks`,
			{
				method: 'POST',
				headers: { ...authHeader(userAToken), 'Content-Type': 'application/json' },
				body: JSON.stringify({ title: 'Unauthorized Task' }),
			},
		);
		expect(res.status).toBe(403);
	});

	it('user A can access Team A resources', async () => {
		const res = await app.request(
			`/api/projects/${await projectSlugForTeamSlug(db, teamASlug)}/agents`,
			{
				headers: authHeader(userAToken),
			},
		);
		expect(res.status).toBe(200);
	});

	it('user A can access Team A tasks', async () => {
		const res = await app.request(
			`/api/projects/${await projectSlugForTeamSlug(db, teamASlug)}/tasks`,
			{
				headers: authHeader(userAToken),
			},
		);
		expect(res.status).toBe(200);
	});

	it('GET /teams lists only the teams the non-superuser belongs to', async () => {
		const res = await app.request('/api/teams', { headers: authHeader(userAToken) });
		expect(res.status).toBe(200);
		const ids = ((await res.json()).data as { id: string }[]).map((t) => t.id);
		expect(ids).toContain(teamAId);
		expect(ids).not.toContain(teamBId);
	});

	it('GET /teams lists every team for the superuser', async () => {
		const res = await app.request('/api/teams', { headers: authHeader(superuserToken) });
		const ids = ((await res.json()).data as { id: string }[]).map((t) => t.id);
		expect(ids).toContain(teamAId);
		expect(ids).toContain(teamBId);
	});
});

describe('Superuser cross-team access', () => {
	it('superuser can access Team A', async () => {
		const res = await app.request(
			`/api/projects/${await projectSlugForTeamSlug(db, teamASlug)}/agents`,
			{
				headers: authHeader(superuserToken),
			},
		);
		expect(res.status).toBe(200);
	});

	it('superuser can access Team B', async () => {
		const res = await app.request(
			`/api/projects/${await projectSlugForTeamSlug(db, teamBSlug)}/agents`,
			{
				headers: authHeader(superuserToken),
			},
		);
		expect(res.status).toBe(200);
	});
});

describe('API key cross-team isolation', () => {
	let apiKeyA: string;
	let apiKeyB: string;

	beforeAll(async () => {
		const resA = await app.request(
			`/api/projects/${await projectSlugForTeamSlug(db, teamASlug)}/api-keys`,
			{
				method: 'POST',
				headers: { ...authHeader(superuserToken), 'Content-Type': 'application/json' },
				body: JSON.stringify({ name: 'key-a' }),
			},
		);
		apiKeyA = (await resA.json()).data.key;

		const resB = await app.request(
			`/api/projects/${await projectSlugForTeamSlug(db, teamBSlug)}/api-keys`,
			{
				method: 'POST',
				headers: { ...authHeader(superuserToken), 'Content-Type': 'application/json' },
				body: JSON.stringify({ name: 'key-b' }),
			},
		);
		apiKeyB = (await resB.json()).data.key;
	});

	it('API key A cannot access Team B', async () => {
		const res = await app.request(
			`/api/projects/${await projectSlugForTeamSlug(db, teamBSlug)}/agents`,
			{
				headers: authHeader(apiKeyA),
			},
		);
		expect(res.status).toBe(403);
	});

	it('API key B cannot access Team A', async () => {
		const res = await app.request(
			`/api/projects/${await projectSlugForTeamSlug(db, teamASlug)}/agents`,
			{
				headers: authHeader(apiKeyB),
			},
		);
		expect(res.status).toBe(403);
	});

	it('API key A can access Team A', async () => {
		const res = await app.request(
			`/api/projects/${await projectSlugForTeamSlug(db, teamASlug)}/agents`,
			{
				headers: authHeader(apiKeyA),
			},
		);
		expect(res.status).toBe(200);
	});

	it('API key B can access Team B', async () => {
		const res = await app.request(
			`/api/projects/${await projectSlugForTeamSlug(db, teamBSlug)}/agents`,
			{
				headers: authHeader(apiKeyB),
			},
		);
		expect(res.status).toBe(200);
	});
});

describe('Resource ownership isolation', () => {
	it('Team B agent cannot access Team A task via Team A routes', async () => {
		// Agent B is scoped to Team B, so accessing Team A returns 403
		const res = await app.request(`/api/projects/${projectASlug}/tasks/${taskAId}`, {
			headers: authHeader(agentBToken),
		});
		expect(res.status).toBe(403);
	});

	it('Team A task not found under Team B routes', async () => {
		// Even with superuser, task A doesn't belong to Team B
		const res = await app.request(
			`/api/projects/${await projectSlugForTeamSlug(db, teamBSlug)}/tasks/${taskAId}`,
			{
				headers: authHeader(superuserToken),
			},
		);
		// Returns 404 because WHERE clause filters by team_id
		expect(res.status).toBe(404);
	});

	it('Agent A accessing own team task succeeds', async () => {
		const res = await app.request(`/api/projects/${projectASlug}/tasks/${taskAId}`, {
			headers: authHeader(agentAToken),
		});
		expect(res.status).toBe(200);
	});
});
