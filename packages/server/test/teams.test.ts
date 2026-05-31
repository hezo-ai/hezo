import type { PGlite } from '@electric-sql/pglite';
import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Env } from '../src/lib/types';
import { safeClose } from './helpers';
import { authHeader, createTestApp } from './helpers/app';

let app: Hono<Env>;
let db: PGlite;
let token: string;
let builtinTypeId: string;

beforeAll(async () => {
	const ctx = await createTestApp();
	app = ctx.app;
	db = ctx.db;
	token = ctx.token;

	// Get the built-in type ID for team creation
	const res = await app.request('/api/team-templates', {
		headers: authHeader(token),
	});
	const types = (await res.json()).data;
	builtinTypeId = types.find((t: any) => t.name === 'Startup').id;
});

afterAll(async () => {
	await safeClose(db);
});

describe('teams CRUD', () => {
	it('creates a team from built-in template with auto-created agents and KB docs', async () => {
		const res = await app.request('/api/teams', {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				name: 'NoteGenius AI',
				description: 'Build the #1 AI note-taking app',
				template_id: builtinTypeId,
			}),
		});
		expect(res.status).toBe(201);
		const body = await res.json();
		expect(body.data.name).toBe('NoteGenius AI');
		expect(body.data.slug).toBe('notegenius-ai');
		expect(body.data.agent_count).toBe(11);

		const internalPrefix = await db.query<{ task_prefix: string }>(
			"SELECT task_prefix FROM projects WHERE team_id = $1 AND slug = 'internal'",
			[body.data.id],
		);
		expect(internalPrefix.rows[0].task_prefix).toBe('IN');

		const skillsRes = await app.request(`/api/teams/${body.data.id}/skills`, {
			headers: authHeader(token),
		});
		const skillsBody = await skillsRes.json();
		expect(skillsBody.data.length).toBe(2);
		const slugs = skillsBody.data.map((d: any) => d.slug).sort();
		expect(slugs).toEqual(['code-review-standards.md', 'development-workflow.md']);
	});

	it('creates a team without a type and includes built-in agents', async () => {
		const res = await app.request('/api/teams', {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				name: 'Solo Project',
			}),
		});
		expect(res.status).toBe(201);
		const body = await res.json();
		expect(body.data.agent_count).toBe(2);

		const agentsRes = await app.request(`/api/teams/${body.data.id}/agents`, {
			headers: authHeader(token),
		});
		const agents = (await agentsRes.json()).data;
		const slugs = agents.map((a: any) => a.slug).sort();
		expect(slugs).toEqual(['captain', 'coach']);
	});

	it('lists teams with counts', async () => {
		const res = await app.request('/api/teams', {
			headers: authHeader(token),
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.data.length).toBeGreaterThanOrEqual(2);
		expect(body.data[0]).toHaveProperty('agent_count');
		expect(body.data[0]).toHaveProperty('open_task_count');
	});

	it('gets a team by id', async () => {
		const listRes = await app.request('/api/teams', {
			headers: authHeader(token),
		});
		const teams = (await listRes.json()).data;
		const id = teams[0].id;

		const res = await app.request(`/api/teams/${id}`, {
			headers: authHeader(token),
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.data.id).toBe(id);
	});

	it('updates a team', async () => {
		const listRes = await app.request('/api/teams', {
			headers: authHeader(token),
		});
		const team = (await listRes.json()).data[0];

		const res = await app.request(`/api/teams/${team.id}`, {
			method: 'PATCH',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ description: 'Updated description' }),
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.data.description).toBe('Updated description');
	});

	it('deletes a team', async () => {
		// Create a throwaway team
		const createRes = await app.request('/api/teams', {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ name: 'To Delete' }),
		});
		const created = (await createRes.json()).data;

		const res = await app.request(`/api/teams/${created.id}`, {
			method: 'DELETE',
			headers: authHeader(token),
		});
		expect(res.status).toBe(200);

		const getRes = await app.request(`/api/teams/${created.id}`, {
			headers: authHeader(token),
		});
		expect(getRes.status).toBe(404);
	});

	it('generates unique slugs for same-named teams', async () => {
		const res1 = await app.request('/api/teams', {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ name: 'Duplicate Name' }),
		});
		const res2 = await app.request('/api/teams', {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ name: 'Duplicate Name' }),
		});
		expect(res1.status).toBe(201);
		expect(res2.status).toBe(201);
		const slug1 = (await res1.json()).data.slug;
		const slug2 = (await res2.json()).data.slug;
		expect(slug1).toBe('duplicate-name');
		expect(slug2).toBe('duplicate-name-2');
	});

	it('auto-provisions a container for the Internal project', async () => {
		const res = await app.request('/api/teams', {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ name: 'Provision Test Co' }),
		});
		expect(res.status).toBe(201);
		const teamId = (await res.json()).data.id;

		// Wait for async provisionContainer to attempt
		await new Promise((r) => setTimeout(r, 200));

		const internalProject = await db.query<{ container_status: string | null }>(
			"SELECT container_status FROM projects WHERE team_id = $1 AND slug = 'internal'",
			[teamId],
		);
		expect(internalProject.rows.length).toBe(1);
		expect(internalProject.rows[0].container_status).not.toBeNull();
	});

	it('seeds the Internal project with an IN task prefix', async () => {
		const res = await app.request('/api/teams', {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ name: 'Acme Corp Industries' }),
		});
		expect(res.status).toBe(201);
		const body = await res.json();
		const internalPrefix = await db.query<{ task_prefix: string }>(
			"SELECT task_prefix FROM projects WHERE team_id = $1 AND slug = 'internal'",
			[body.data.id],
		);
		expect(internalPrefix.rows[0].task_prefix).toBe('IN');
	});
});

describe('template-based team creation', () => {
	it('creates agents from a custom template plus missing built-in agents', async () => {
		const agentTypesRes = await app.request('/api/agent-types', {
			headers: authHeader(token),
		});
		const agentTypes = (await agentTypesRes.json()).data;
		const captain = agentTypes.find((a: any) => a.slug === 'captain');
		const researcher = agentTypes.find((a: any) => a.slug === 'researcher');

		const typeRes = await app.request('/api/team-templates', {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				name: 'Research Lab',
				description: 'Research-focused team',
				agent_types: [
					{ agent_type_id: captain.id, reports_to_slug: 'board', sort_order: 0 },
					{ agent_type_id: researcher.id, reports_to_slug: 'captain', sort_order: 1 },
				],
			}),
		});
		expect(typeRes.status).toBe(201);
		const templateId = (await typeRes.json()).data.id;

		const res = await app.request('/api/teams', {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				name: 'Research Co',

				template_id: templateId,
			}),
		});
		expect(res.status).toBe(201);
		const body = await res.json();
		expect(body.data.agent_count).toBe(3);

		const agentsRes = await app.request(`/api/teams/${body.data.id}/agents`, {
			headers: authHeader(token),
		});
		const agents = (await agentsRes.json()).data;
		const slugs = agents.map((a: any) => a.slug).sort();
		expect(slugs).toEqual(['captain', 'coach', 'researcher']);
	});

	it('creates only built-in agents without a template', async () => {
		const res = await app.request('/api/teams', {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				name: 'Blank Co',
			}),
		});
		expect(res.status).toBe(201);
		const body = await res.json();
		expect(body.data.agent_count).toBe(2);

		const agentsRes = await app.request(`/api/teams/${body.data.id}/agents`, {
			headers: authHeader(token),
		});
		const agents = (await agentsRes.json()).data;
		const slugs = agents.map((a: any) => a.slug).sort();
		expect(slugs).toEqual(['captain', 'coach']);
	});

	it('creates Captain and Coach with Blank template', async () => {
		const typesRes = await app.request('/api/team-templates', {
			headers: authHeader(token),
		});
		const blankType = (await typesRes.json()).data.find((t: any) => t.name === 'Blank');

		const res = await app.request('/api/teams', {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				name: 'Blank Template Co',

				template_id: blankType.id,
			}),
		});
		expect(res.status).toBe(201);
		const body = await res.json();
		expect(body.data.agent_count).toBe(2);

		const agentsRes = await app.request(`/api/teams/${body.data.id}/agents`, {
			headers: authHeader(token),
		});
		const agents = (await agentsRes.json()).data;
		const slugs = agents.map((a: any) => a.slug).sort();
		expect(slugs).toEqual(['captain', 'coach']);
	});

	it('does not duplicate Captain/Coach when Startup template already includes them', async () => {
		const res = await app.request('/api/teams', {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				name: 'Full Template Co',

				template_id: builtinTypeId,
			}),
		});
		expect(res.status).toBe(201);
		const body = await res.json();
		expect(body.data.agent_count).toBe(11);

		const agentsRes = await app.request(`/api/teams/${body.data.id}/agents`, {
			headers: authHeader(token),
		});
		const agents = (await agentsRes.json()).data;
		const ceos = agents.filter((a: any) => a.slug === 'captain');
		const coaches = agents.filter((a: any) => a.slug === 'coach');
		expect(ceos).toHaveLength(1);
		expect(coaches).toHaveLength(1);
	});

	it('creates Captain/Coach for custom template that omits them', async () => {
		const agentTypesRes = await app.request('/api/agent-types', {
			headers: authHeader(token),
		});
		const agentTypes = (await agentTypesRes.json()).data;
		const researcher = agentTypes.find((a: any) => a.slug === 'researcher');

		const typeRes = await app.request('/api/team-templates', {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				name: 'Researcher Only',
				description: 'Only a researcher',
				agent_types: [{ agent_type_id: researcher.id, sort_order: 0 }],
			}),
		});
		expect(typeRes.status).toBe(201);
		const templateId = (await typeRes.json()).data.id;

		const res = await app.request('/api/teams', {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				name: 'Researcher Co',

				template_id: templateId,
			}),
		});
		expect(res.status).toBe(201);
		const body = await res.json();
		expect(body.data.agent_count).toBe(3);

		const agentsRes = await app.request(`/api/teams/${body.data.id}/agents`, {
			headers: authHeader(token),
		});
		const agents = (await agentsRes.json()).data;
		const slugs = agents.map((a: any) => a.slug).sort();
		expect(slugs).toEqual(['captain', 'coach', 'researcher']);
	});

	it('populates team_template_assignments join table', async () => {
		const res = await app.request('/api/teams', {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				name: 'Join Table Co',

				template_id: builtinTypeId,
			}),
		});
		expect(res.status).toBe(201);
		const teamId = (await res.json()).data.id;

		const joinRows = await db.query('SELECT * FROM team_template_assignments WHERE team_id = $1', [
			teamId,
		]);
		expect(joinRows.rows.length).toBe(1);
	});

	it('creates skills from template with inline skills_config', async () => {
		const typeRes = await app.request('/api/team-templates', {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				name: 'Skills Template',
				description: 'Template with starter skills',
				skills_config: [
					{
						name: 'Getting Started',
						slug: 'getting-started',
						content: '# Getting Started\n\nWelcome!',
					},
					{ name: 'API Guide', slug: 'api-guide', content: '# API Guide\n\nEndpoints...' },
				],
			}),
		});
		expect(typeRes.status).toBe(201);
		const templateId = (await typeRes.json()).data.id;

		const res = await app.request('/api/teams', {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				name: 'Skills Co',
				template_id: templateId,
			}),
		});
		expect(res.status).toBe(201);
		const teamId = (await res.json()).data.id;

		const skillsRes = await app.request(`/api/teams/${teamId}/skills`, {
			headers: authHeader(token),
		});
		const skillsBody = await skillsRes.json();
		expect(skillsBody.data.map((d: any) => d.slug).sort()).toEqual([
			'api-guide',
			'getting-started',
		]);
	});
});

describe('slug-based access', () => {
	it('gets a team by slug', async () => {
		const listRes = await app.request('/api/teams', {
			headers: authHeader(token),
		});
		const teams = (await listRes.json()).data;
		const team = teams.find((c: any) => c.slug === 'notegenius-ai');

		const res = await app.request(`/api/teams/${team.slug}`, {
			headers: authHeader(token),
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.data.id).toBe(team.id);
		expect(body.data.slug).toBe('notegenius-ai');
	});

	it('returns 404 for non-existent slug', async () => {
		const res = await app.request('/api/teams/nonexistent-slug', {
			headers: authHeader(token),
		});
		expect(res.status).toBe(404);
	});

	it('accesses team sub-resources via slug', async () => {
		const listRes = await app.request('/api/teams', {
			headers: authHeader(token),
		});
		const teams = (await listRes.json()).data;
		const team = teams.find((c: any) => c.slug === 'notegenius-ai');

		const agentsRes = await app.request(`/api/teams/${team.slug}/agents`, {
			headers: authHeader(token),
		});
		expect(agentsRes.status).toBe(200);
		const agentsBody = await agentsRes.json();
		expect(agentsBody.data.length).toBe(11);
	});
});
