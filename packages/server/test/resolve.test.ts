import type { PGlite } from '@electric-sql/pglite';
import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resolveAgentId, resolveProjectId, resolveTeamId } from '../src/lib/resolve';
import type { Env } from '../src/lib/types';
import { safeClose } from './helpers';
import { authHeader, createTestApp, createTestProject, createTestTeam } from './helpers/app';

let app: Hono<Env>;
let db: PGlite;
let token: string;
let teamId: string;
let teamSlug: string;
let projectId: string;
let projectSlug: string;

beforeAll(async () => {
	const ctx = await createTestApp();
	app = ctx.app;
	db = ctx.db;
	token = ctx.token;

	const typesRes = await app.request('/api/team-templates', { headers: authHeader(token) });
	const typeId = (await typesRes.json()).data.find((t: any) => t.name === 'Startup').id;

	const teamRes = await createTestTeam(db, { name: 'Resolve Test Co', template_id: typeId });
	const teamData = (await teamRes.json()).data;
	teamId = teamData.id;
	teamSlug = teamData.slug;

	const projectRes = await createTestProject(db, teamId, {
		name: 'Resolve Project',
		description: 'Test project.',
	});
	const projectData = (await projectRes.json()).data;
	projectId = projectData.id;
	projectSlug = projectData.slug;
});

afterAll(async () => {
	await safeClose(db);
});

describe('resolveTeamId', () => {
	it('returns UUID directly when given a valid UUID', async () => {
		const result = await resolveTeamId(db, teamId);
		expect(result).toBe(teamId);
	});

	it('resolves slug to UUID', async () => {
		const result = await resolveTeamId(db, teamSlug);
		expect(result).toBe(teamId);
	});

	it('returns null for non-existent slug', async () => {
		const result = await resolveTeamId(db, 'nonexistent-team');
		expect(result).toBeNull();
	});

	it('returns raw UUID even if team does not exist', async () => {
		const fakeUuid = '00000000-0000-0000-0000-000000000099';
		const result = await resolveTeamId(db, fakeUuid);
		expect(result).toBe(fakeUuid);
	});
});

describe('resolveProjectId', () => {
	it('returns UUID directly when given a valid UUID', async () => {
		const result = await resolveProjectId(db, teamId, projectId);
		expect(result).toBe(projectId);
	});

	it('resolves slug to UUID', async () => {
		const result = await resolveProjectId(db, teamId, projectSlug);
		expect(result).toBe(projectId);
	});

	it('returns null for non-existent slug', async () => {
		const result = await resolveProjectId(db, teamId, 'nonexistent-project');
		expect(result).toBeNull();
	});

	it('returns null when project slug belongs to different team', async () => {
		const fakeTeam = '00000000-0000-0000-0000-000000000099';
		const result = await resolveProjectId(db, fakeTeam, projectSlug);
		expect(result).toBeNull();
	});

	it('returns raw UUID even if project does not exist', async () => {
		const fakeUuid = '00000000-0000-0000-0000-000000000088';
		const result = await resolveProjectId(db, teamId, fakeUuid);
		expect(result).toBe(fakeUuid);
	});
});

describe('resolveAgentId', () => {
	let architectId: string;

	beforeAll(async () => {
		const row = await db.query<{ id: string }>(
			'SELECT m.id FROM members m JOIN member_agents ma ON ma.id = m.id WHERE m.team_id = $1 AND ma.slug = $2',
			[teamId, 'architect'],
		);
		architectId = row.rows[0]?.id;
		expect(architectId).toBeTruthy();
	});

	it('resolves a slug to the agent UUID', async () => {
		const result = await resolveAgentId(db, teamId, 'architect');
		expect(result).toBe(architectId);
	});

	it('returns the UUID directly when given a valid agent UUID for the team', async () => {
		const result = await resolveAgentId(db, teamId, architectId);
		expect(result).toBe(architectId);
	});

	it('returns null for an unknown slug', async () => {
		const result = await resolveAgentId(db, teamId, 'definitely-not-a-real-slug');
		expect(result).toBeNull();
	});

	it('returns null for a UUID that belongs to another team', async () => {
		const otherTeam = '00000000-0000-0000-0000-000000000099';
		const result = await resolveAgentId(db, otherTeam, architectId);
		expect(result).toBeNull();
	});

	it('returns null for a slug that belongs to a different team', async () => {
		const otherTeam = '00000000-0000-0000-0000-000000000099';
		const result = await resolveAgentId(db, otherTeam, 'architect');
		expect(result).toBeNull();
	});
});
