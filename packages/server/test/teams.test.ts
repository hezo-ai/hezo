import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../src/db/database';
import type { Env } from '../src/lib/types';
import { safeClose } from './helpers';
import { authHeader, createTestApp, createTestProject, createTestTeam } from './helpers/app';

let app: Hono<Env>;
let db: Db;
let token: string;
let builtinTypeId: string;

// A team is addressed through its single project. Create it and return its slug.
async function projectSlugFor(teamId: string): Promise<string> {
	const res = await createTestProject(db, teamId, { name: 'Work Project' });
	return (await res.json()).data.slug;
}

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

// Teams are provisioned by the createTeam service (reached via project creation,
// `POST /api/projects`); there is no bare `POST /api/teams` route anymore. These
// tests exercise that service via the `createTestTeam` helper and read the result
// back through the project-addressed team routes.
describe('team provisioning (createTeam service)', () => {
	it('creates a team from built-in template with auto-created agents and KB docs', async () => {
		const res = await createTestTeam(db, {
			name: 'NoteGenius AI',
			description: 'Build the #1 AI note-taking app',
			template_id: builtinTypeId,
		});
		expect(res.status).toBe(201);
		const body = await res.json();
		expect(body.data.name).toBe('NoteGenius AI');
		expect(body.data.slug).toBe('notegenius-ai');
		expect(body.data.agent_count).toBe(10);

		// Skills are instance-global now; the template's KB docs land in the shared
		// catalog. Assert presence (other tests may have seeded global skills too).
		const skillsRes = await app.request('/api/skills', {
			headers: authHeader(token),
		});
		const skillsBody = await skillsRes.json();
		const slugs = skillsBody.data.map((d: any) => d.slug);
		expect(slugs).toContain('code-review-standards.md');
		expect(slugs).toContain('development-workflow.md');
	});

	it('creates a team without a type and includes built-in agents', async () => {
		const res = await createTestTeam(db, { name: 'Solo Project' });
		expect(res.status).toBe(201);
		const body = await res.json();
		expect(body.data.agent_count).toBe(1);

		const projectSlug = await projectSlugFor(body.data.id);
		const agentsRes = await app.request(`/api/projects/${projectSlug}/agents`, {
			headers: authHeader(token),
		});
		const agents = (await agentsRes.json()).data;
		const slugs = agents
			.filter((a: any) => !a.is_instance)
			.map((a: any) => a.slug)
			.sort();
		expect(slugs).toEqual(['captain']);
	});

	it('exposes the team type (primary template name) on the project-addressed read', async () => {
		const createRes = await createTestTeam(db, {
			name: 'Typed Team Co',
			template_id: builtinTypeId,
		});
		const created = (await createRes.json()).data;

		const createdSlug = await projectSlugFor(created.id);
		const getRes = await app.request(`/api/projects/${createdSlug}/team`, {
			headers: authHeader(token),
		});
		expect((await getRes.json()).data.primary_template_name).toBe('Startup');

		// A team created without a template has no type.
		const blankRes = await createTestTeam(db, { name: 'Typeless Team Co' });
		const blank = (await blankRes.json()).data;
		const blankSlug = await projectSlugFor(blank.id);
		const blankGet = await app.request(`/api/projects/${blankSlug}/team`, {
			headers: authHeader(token),
		});
		expect((await blankGet.json()).data.primary_template_name).toBeNull();
	});

	it('gets a team by id', async () => {
		const createRes = await createTestTeam(db, { name: 'Get By Id Co' });
		const team = (await createRes.json()).data;
		const projectSlug = await projectSlugFor(team.id);

		const res = await app.request(`/api/projects/${projectSlug}/team`, {
			headers: authHeader(token),
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.data.id).toBe(team.id);
	});

	it('updates a team', async () => {
		const createRes = await createTestTeam(db, { name: 'Update Me Co' });
		const team = (await createRes.json()).data;
		const projectSlug = await projectSlugFor(team.id);

		const res = await app.request(`/api/projects/${projectSlug}/team`, {
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
		const createRes = await createTestTeam(db, { name: 'To Delete' });
		const created = (await createRes.json()).data;
		const projectSlug = await projectSlugFor(created.id);

		const res = await app.request(`/api/projects/${projectSlug}/team`, {
			method: 'DELETE',
			headers: authHeader(token),
		});
		expect(res.status).toBe(200);

		const getRes = await app.request(`/api/projects/${projectSlug}/team`, {
			headers: authHeader(token),
		});
		expect(getRes.status).toBe(404);
	});

	it('generates unique slugs for same-named teams', async () => {
		const res1 = await createTestTeam(db, { name: 'Duplicate Name' });
		const res2 = await createTestTeam(db, { name: 'Duplicate Name' });
		expect(res1.status).toBe(201);
		expect(res2.status).toBe(201);
		const slug1 = (await res1.json()).data.slug;
		const slug2 = (await res2.json()).data.slug;
		expect(slug1).toBe('duplicate-name');
		expect(slug2).toBe('duplicate-name-2');
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
					{ agent_type_id: captain.id, reports_to_slug: 'admin', sort_order: 0 },
					{ agent_type_id: researcher.id, reports_to_slug: 'captain', sort_order: 1 },
				],
			}),
		});
		expect(typeRes.status).toBe(201);
		const templateId = (await typeRes.json()).data.id;

		const res = await createTestTeam(db, { name: 'Research Co', template_id: templateId });
		expect(res.status).toBe(201);
		const body = await res.json();
		expect(body.data.agent_count).toBe(2);

		const projectSlug = await projectSlugFor(body.data.id);
		const agentsRes = await app.request(`/api/projects/${projectSlug}/agents`, {
			headers: authHeader(token),
		});
		const agents = (await agentsRes.json()).data;
		const slugs = agents
			.filter((a: any) => !a.is_instance)
			.map((a: any) => a.slug)
			.sort();
		expect(slugs).toEqual(['captain', 'researcher']);
	});

	it('creates only built-in agents without a template', async () => {
		const res = await createTestTeam(db, { name: 'Blank Co' });
		expect(res.status).toBe(201);
		const body = await res.json();
		expect(body.data.agent_count).toBe(1);

		const projectSlug = await projectSlugFor(body.data.id);
		const agentsRes = await app.request(`/api/projects/${projectSlug}/agents`, {
			headers: authHeader(token),
		});
		const agents = (await agentsRes.json()).data;
		const slugs = agents
			.filter((a: any) => !a.is_instance)
			.map((a: any) => a.slug)
			.sort();
		expect(slugs).toEqual(['captain']);
	});

	it('creates the Captain with the Blank template', async () => {
		const typesRes = await app.request('/api/team-templates', {
			headers: authHeader(token),
		});
		const blankType = (await typesRes.json()).data.find((t: any) => t.name === 'Blank');

		const res = await createTestTeam(db, { name: 'Blank Template Co', template_id: blankType.id });
		expect(res.status).toBe(201);
		const body = await res.json();
		expect(body.data.agent_count).toBe(1);

		const projectSlug = await projectSlugFor(body.data.id);
		const agentsRes = await app.request(`/api/projects/${projectSlug}/agents`, {
			headers: authHeader(token),
		});
		const agents = (await agentsRes.json()).data;
		const slugs = agents
			.filter((a: any) => !a.is_instance)
			.map((a: any) => a.slug)
			.sort();
		expect(slugs).toEqual(['captain']);
	});

	it('does not duplicate the Captain when the Startup template already includes it', async () => {
		const res = await createTestTeam(db, { name: 'Full Template Co', template_id: builtinTypeId });
		expect(res.status).toBe(201);
		const body = await res.json();
		expect(body.data.agent_count).toBe(10);

		const projectSlug = await projectSlugFor(body.data.id);
		const agentsRes = await app.request(`/api/projects/${projectSlug}/agents`, {
			headers: authHeader(token),
		});
		const agents = (await agentsRes.json()).data;
		const captains = agents.filter((a: any) => a.slug === 'captain' && !a.is_instance);
		// The Coach is instance-level (in HQ): it surfaces only as a virtual member,
		// never as a duplicated project-team member of its own.
		const ownCoaches = agents.filter((a: any) => a.slug === 'coach' && !a.is_instance);
		const virtualCoaches = agents.filter((a: any) => a.slug === 'coach' && a.is_instance);
		expect(captains).toHaveLength(1);
		expect(ownCoaches).toHaveLength(0);
		expect(virtualCoaches).toHaveLength(1);
	});

	it('creates the Captain for a custom template that omits it', async () => {
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

		const res = await createTestTeam(db, { name: 'Researcher Co', template_id: templateId });
		expect(res.status).toBe(201);
		const body = await res.json();
		expect(body.data.agent_count).toBe(2);

		const projectSlug = await projectSlugFor(body.data.id);
		const agentsRes = await app.request(`/api/projects/${projectSlug}/agents`, {
			headers: authHeader(token),
		});
		const agents = (await agentsRes.json()).data;
		const slugs = agents
			.filter((a: any) => !a.is_instance)
			.map((a: any) => a.slug)
			.sort();
		expect(slugs).toEqual(['captain', 'researcher']);
	});

	it('populates team_template_assignments join table', async () => {
		const res = await createTestTeam(db, { name: 'Join Table Co', template_id: builtinTypeId });
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

		const res = await createTestTeam(db, { name: 'Skills Co', template_id: templateId });
		expect(res.status).toBe(201);
		expect((await res.json()).data.id).toBeTruthy();

		const skillsRes = await app.request('/api/skills', {
			headers: authHeader(token),
		});
		const skillsBody = await skillsRes.json();
		const slugs = skillsBody.data.map((d: any) => d.slug);
		expect(slugs).toContain('api-guide');
		expect(slugs).toContain('getting-started');
	});
});

describe('slug-based access', () => {
	it('gets a team by slug', async () => {
		const team = (
			await db.query<{ id: string; slug: string }>('SELECT id, slug FROM teams WHERE slug = $1', [
				'notegenius-ai',
			])
		).rows[0];

		const projectSlug = await projectSlugFor(team.id);
		const res = await app.request(`/api/projects/${projectSlug}/team`, {
			headers: authHeader(token),
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.data.id).toBe(team.id);
		expect(body.data.slug).toBe('notegenius-ai');
	});

	it('returns 404 for non-existent slug', async () => {
		const res = await app.request('/api/projects/nonexistent-slug/team', {
			headers: authHeader(token),
		});
		expect(res.status).toBe(404);
	});

	it('accesses team sub-resources via slug', async () => {
		const team = (
			await db.query<{ id: string; slug: string }>('SELECT id, slug FROM teams WHERE slug = $1', [
				'notegenius-ai',
			])
		).rows[0];

		const projectSlug = await projectSlugFor(team.id);
		const agentsRes = await app.request(`/api/projects/${projectSlug}/agents`, {
			headers: authHeader(token),
		});
		expect(agentsRes.status).toBe(200);
		const agentsBody = await agentsRes.json();
		const own = agentsBody.data.filter((a: any) => !a.is_instance);
		expect(own.length).toBe(10);
	});
});

describe('removed bare team routes', () => {
	it('GET /api/teams is no longer routed', async () => {
		const res = await app.request('/api/teams', { headers: authHeader(token) });
		expect(res.status).toBe(404);
	});

	it('POST /api/teams is no longer routed', async () => {
		const res = await app.request('/api/teams', {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ name: 'Should Not Work' }),
		});
		expect(res.status).toBe(404);
	});
});
