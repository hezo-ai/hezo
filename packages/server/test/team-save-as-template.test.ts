import type { PGlite } from '@electric-sql/pglite';
import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Env } from '../src/lib/types';
import { safeClose } from './helpers';
import { authHeader, createTestApp, createTestTeam, projectSlugFor } from './helpers/app';

let app: Hono<Env>;
let db: PGlite;
let token: string;
let projectSlug: string;
let startupTemplateId: string;

beforeAll(async () => {
	const ctx = await createTestApp();
	app = ctx.app;
	db = ctx.db;
	token = ctx.token;
	const res = await app.request('/api/team-templates', { headers: authHeader(token) });
	const startup = (await res.json()).data.find((t: { name: string }) => t.name === 'Startup');
	startupTemplateId = startup.id;
});

afterAll(async () => {
	await safeClose(db);
});

// Creates a team and returns the slug of its single project — the public handle
// for the team-wide endpoints (agents, save-as-template, apply-type). The
// createTeam service makes the roster but no project, so we materialize the
// team's one project here (idempotently) and address everything through it.
async function createTeam(name: string, templateId?: string): Promise<string> {
	const res = await createTestTeam(db, templateId ? { name, template_id: templateId } : { name });
	expect(res.status).toBe(201);
	const teamId = (await res.json()).data.id as string;
	return projectSlugFor(db, teamId);
}

async function agentSlugs(projectSlug: string): Promise<string[]> {
	const res = await app.request(`/api/projects/${projectSlug}/agents`, {
		headers: authHeader(token),
	});
	const agents = (await res.json()).data as { slug: string; is_instance?: boolean }[];
	return agents
		.filter((a) => !a.is_instance)
		.map((a) => a.slug)
		.sort();
}

describe('save team as a type (template snapshot)', () => {
	it('round-trips a team roster through save-as-template', async () => {
		const source = await createTeam('Snapshot Source Co', startupTemplateId);
		const sourceSlugs = await agentSlugs(source);
		expect(sourceSlugs).toContain('captain');
		expect(sourceSlugs).toContain('engineer');
		expect(sourceSlugs).toHaveLength(10);

		// Snapshot the live team into a new custom type.
		const saveRes = await app.request(`/api/projects/${source}/save-as-template`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ name: 'My Saved Org', description: 'snapshot' }),
		});
		expect(saveRes.status).toBe(201);
		const saved = (await saveRes.json()).data;
		expect(saved.template_id).toBeTruthy();
		expect(saved.skipped_agents).toEqual([]);

		// The new type lists the captured roster.
		const tplRes = await app.request(`/api/team-templates/${saved.template_id}`, {
			headers: authHeader(token),
		});
		const tpl = (await tplRes.json()).data;
		expect(tpl.name).toBe('My Saved Org');
		expect(tpl.agent_types).toHaveLength(10);

		// Reporting structure round-trips (architect reports to the captain).
		const architect = await db.query<{ reports_to_slug: string | null }>(
			`SELECT ctat.reports_to_slug FROM team_template_agent_types ctat
			 JOIN agent_types at ON at.id = ctat.agent_type_id
			 WHERE ctat.team_template_id = $1 AND at.slug = 'architect'`,
			[saved.template_id],
		);
		expect(architect.rows[0].reports_to_slug).toBe('captain');

		// Creating a team from the saved type reproduces the roster.
		const clone = await createTeam('Cloned Co', saved.template_id);
		expect(await agentSlugs(clone)).toEqual(sourceSlugs);
	});

	it('rejects an empty template name', async () => {
		const source = await createTeam('Snapshot Reject Co');
		const res = await app.request(`/api/projects/${source}/save-as-template`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ name: '  ' }),
		});
		expect(res.status).toBe(400);
	});
});

describe('apply a team type (refresh / merge)', () => {
	it('merges a type onto an existing team — adds missing roles, keeps built-ins', async () => {
		const team = await createTeam('Apply Type Co'); // no template → captain only
		expect(await agentSlugs(team)).toEqual(['captain']);

		const res = await app.request(`/api/projects/${team}/apply-type`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ template_id: startupTemplateId }),
		});
		expect(res.status).toBe(200);

		const after = await agentSlugs(team);
		// Merge is additive: the built-in Captain is preserved, Startup roles added.
		expect(after).toContain('captain');
		expect(after).toContain('architect');
		expect(after).toContain('engineer');
		expect(after.length).toBeGreaterThan(1);
	});

	it('404s for an unknown type', async () => {
		const team = await createTeam('Apply Type 404 Co');
		const res = await app.request(`/api/projects/${team}/apply-type`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ template_id: '00000000-0000-0000-0000-000000000000' }),
		});
		expect(res.status).toBe(404);
	});
});
