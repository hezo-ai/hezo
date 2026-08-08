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
	mintAgentToken,
	projectSlugForTeamSlug,
} from './helpers/app';

let app: Hono<Env>;
let db: Db;
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
	const typeId = (await typesRes.json()).data.find((t: any) => t.name === 'App Team').id;

	// Create Team A
	const teamARes = await createTestTeam(db, { name: 'Team Alpha', template_id: typeId });
	const teamA = (await teamARes.json()).data;
	teamAId = teamA.id;
	teamASlug = teamA.slug;

	// Create Team B
	const teamBRes = await createTestTeam(db, { name: 'Team Beta', template_id: typeId });
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

	it('GET /projects lists only the projects whose team the non-superuser belongs to', async () => {
		const res = await app.request('/api/projects', { headers: authHeader(userAToken) });
		expect(res.status).toBe(200);
		const teamIds = ((await res.json()).data as { team_id: string }[]).map((p) => p.team_id);
		expect(teamIds).toContain(teamAId);
		expect(teamIds).not.toContain(teamBId);
	});

	it('GET /projects lists every team’s project for the superuser', async () => {
		const res = await app.request('/api/projects', { headers: authHeader(superuserToken) });
		const teamIds = ((await res.json()).data as { team_id: string }[]).map((p) => p.team_id);
		expect(teamIds).toContain(teamAId);
		expect(teamIds).toContain(teamBId);
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

describe('API key is instance-wide (MCP surface)', () => {
	let apiKey: string;

	async function listAgentsViaMcp(authToken: string, projectSlug: string): Promise<unknown> {
		const res = await app.request('/mcp', {
			method: 'POST',
			headers: { Authorization: `Bearer ${authToken}`, 'Content-Type': 'application/json' },
			body: JSON.stringify({
				jsonrpc: '2.0',
				method: 'tools/call',
				params: { name: 'list_agents', arguments: { project: projectSlug } },
				id: 1,
			}),
		});
		const body = (await res.json()) as { result: { content: Array<{ text: string }> } };
		// list_agents pages: the roster rows live under `items`.
		const page = JSON.parse(body.result.content[0].text) as { items?: unknown };
		return page.items ?? page;
	}

	beforeAll(async () => {
		// A single instance-scoped key (minted in Global Settings), not bound to a team.
		const res = await app.request('/api/api-keys', {
			method: 'POST',
			headers: { ...authHeader(superuserToken), 'Content-Type': 'application/json' },
			body: JSON.stringify({ name: 'instance-key' }),
		});
		apiKey = (await res.json()).data.key;
	});

	it('reaches Team A via MCP', async () => {
		const result = await listAgentsViaMcp(apiKey, await projectSlugForTeamSlug(db, teamASlug));
		expect(Array.isArray(result)).toBe(true);
	});

	it('reaches Team B via MCP', async () => {
		const result = await listAgentsViaMcp(apiKey, await projectSlugForTeamSlug(db, teamBSlug));
		expect(Array.isArray(result)).toBe(true);
	});

	it('is rejected on the REST surface', async () => {
		const res = await app.request(`/api/projects/${projectASlug}/tasks`, {
			headers: { Authorization: `Bearer ${apiKey}` },
		});
		expect(res.status).toBe(401);
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
