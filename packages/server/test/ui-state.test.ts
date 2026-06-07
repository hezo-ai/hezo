import type { PGlite } from '@electric-sql/pglite';
import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MasterKeyManager } from '../src/crypto/master-key';
import type { Env } from '../src/lib/types';
import { safeClose } from './helpers';
import { authHeader, createTestApp, mintAgentToken } from './helpers/app';

let app: Hono<Env>;
let db: PGlite;
let token: string;
let masterKeyManager: MasterKeyManager;
let teamId: string;
let team2Id: string;
let projectSlug: string;
let project2Slug: string;

beforeAll(async () => {
	const ctx = await createTestApp();
	app = ctx.app;
	db = ctx.db;
	token = ctx.token;
	masterKeyManager = ctx.masterKeyManager;

	const teamRes = await app.request('/api/teams', {
		method: 'POST',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify({ name: 'UI State Co' }),
	});
	const team = (await teamRes.json()).data;
	teamId = team.id;
	projectSlug = `internal-${team.slug}`;

	const team2Res = await app.request('/api/teams', {
		method: 'POST',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify({ name: 'UI State Co 2' }),
	});
	const team2 = (await team2Res.json()).data;
	team2Id = team2.id;
	project2Slug = `internal-${team2.slug}`;
});

afterAll(async () => {
	await safeClose(db);
});

describe('UI state', () => {
	it('GET returns empty object when no settings set', async () => {
		const res = await app.request(`/api/projects/${projectSlug}/ui-state`, {
			headers: authHeader(token),
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.data).toEqual({});
	});

	it('PATCH sets sidebar.team_expanded', async () => {
		const res = await app.request(`/api/projects/${projectSlug}/ui-state`, {
			method: 'PATCH',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ sidebar: { team_expanded: false } }),
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.data.sidebar.team_expanded).toBe(false);
	});

	it('GET returns persisted state after PATCH', async () => {
		const res = await app.request(`/api/projects/${projectSlug}/ui-state`, {
			headers: authHeader(token),
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.data.sidebar.team_expanded).toBe(false);
	});

	it('PATCH merges state without replacing other keys', async () => {
		await app.request(`/api/projects/${projectSlug}/ui-state`, {
			method: 'PATCH',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ other_setting: 'hello' }),
		});

		const res = await app.request(`/api/projects/${projectSlug}/ui-state`, {
			headers: authHeader(token),
		});
		const body = await res.json();
		expect(body.data.sidebar.team_expanded).toBe(false);
		expect(body.data.other_setting).toBe('hello');
	});

	it('PATCH updates existing nested value', async () => {
		const res = await app.request(`/api/projects/${projectSlug}/ui-state`, {
			method: 'PATCH',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ sidebar: { team_expanded: true } }),
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.data.sidebar.team_expanded).toBe(true);
	});

	it('state is per-team', async () => {
		await app.request(`/api/projects/${project2Slug}/ui-state`, {
			method: 'PATCH',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ sidebar: { team_expanded: false } }),
		});

		const res1 = await app.request(`/api/projects/${projectSlug}/ui-state`, {
			headers: authHeader(token),
		});
		const body1 = await res1.json();
		expect(body1.data.sidebar.team_expanded).toBe(true);

		const res2 = await app.request(`/api/projects/${project2Slug}/ui-state`, {
			headers: authHeader(token),
		});
		const body2 = await res2.json();
		expect(body2.data.sidebar.team_expanded).toBe(false);
	});

	it('rejects agent auth with 403', async () => {
		const agentRes = await app.request(`/api/projects/${projectSlug}/agents`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ title: 'Test Agent' }),
		});
		const agentId = (await agentRes.json()).data.id;
		const projectRow = await db.query<{ id: string }>(`SELECT id FROM projects WHERE slug = $1`, [
			projectSlug,
		]);
		const { token: agentToken } = await mintAgentToken(
			db,
			masterKeyManager,
			agentId,
			teamId,
			null,
			{
				projectId: projectRow.rows[0].id,
			},
		);

		const getRes = await app.request(`/api/projects/${projectSlug}/ui-state`, {
			headers: authHeader(agentToken),
		});
		expect(getRes.status).toBe(403);

		const patchRes = await app.request(`/api/projects/${projectSlug}/ui-state`, {
			method: 'PATCH',
			headers: { ...authHeader(agentToken), 'Content-Type': 'application/json' },
			body: JSON.stringify({ sidebar: { team_expanded: false } }),
		});
		expect(patchRes.status).toBe(403);
	});

	it('rejects access to team user is not a member of', async () => {
		const otherTeamRes = await app.request('/api/teams', {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ name: 'UI State Outsider Co' }),
		});
		const otherTeam = (await otherTeamRes.json()).data;
		// Drop the creator's membership so the superuser can resolve the project
		// (access check bypassed) but has no member_users row for its UI state.
		await db.query(
			`DELETE FROM member_users WHERE id IN (SELECT id FROM members WHERE team_id = $1)`,
			[otherTeam.id],
		);

		const res = await app.request(`/api/projects/internal-${otherTeam.slug}/ui-state`, {
			headers: authHeader(token),
		});
		// Superuser bypasses team access check but has no member_users row
		expect(res.status).toBe(403);
	});
});
