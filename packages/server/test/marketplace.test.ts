import { DocumentType } from '@hezo/shared';
import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../src/db/database';
import type { Env } from '../src/lib/types';
import { getMarketplaceTeam } from '../src/services/marketplace';
import { applyMarketplaceTeamToTeam } from '../src/services/team-template-apply';
import { safeClose } from './helpers';
import { authHeader, createTestApp, createTestTeam } from './helpers/app';

let app: Hono<Env>;
let db: Db;
let token: string;

beforeAll(async () => {
	const ctx = await createTestApp();
	app = ctx.app;
	db = ctx.db;
	token = ctx.token;
});

afterAll(async () => {
	await safeClose(db);
});

describe('marketplace loader', () => {
	it('reads the committed software-development team from the local folder', async () => {
		const def = await getMarketplaceTeam('software-development');
		expect(def).toBeTruthy();
		expect(def?.name).toBe('App Team');
		expect(def?.version).toBeGreaterThanOrEqual(1);
		expect(def?.roster.length).toBe(9);
		// Prompts are partial-resolved but keep the runtime placeholders.
		const engineer = def?.roster.find((r) => r.slug === 'engineer');
		expect(engineer?.system_prompt).toContain('{{team_name}}');
		expect(engineer?.system_prompt).not.toContain('{{> partials/');
		// The captain override rides separately from the roster.
		expect(def?.captain.system_prompt).toContain('You are the Captain of');
		expect(def?.roster.some((r) => r.slug === 'captain')).toBe(false);
	});

	it('returns null for an unknown team', async () => {
		expect(await getMarketplaceTeam('does-not-exist')).toBeNull();
	});
});

describe('GET /api/marketplace/teams', () => {
	it('lists the catalog', async () => {
		const res = await app.request('/api/marketplace/teams', { headers: authHeader(token) });
		expect(res.status).toBe(200);
		const data = (await res.json()).data as Array<Record<string, unknown>>;
		const sd = data.find((t) => t.slug === 'software-development');
		expect(sd).toBeDefined();
		expect(sd?.name).toBe('App Team');
		expect(sd?.roster_count).toBe(10);
	});

	it('returns a single team def', async () => {
		const res = await app.request('/api/marketplace/teams/software-development', {
			headers: authHeader(token),
		});
		expect(res.status).toBe(200);
		const def = (await res.json()).data;
		expect(def.slug).toBe('software-development');
		expect(def.roster).toHaveLength(9);
	});

	it('404s on an unknown slug', async () => {
		const res = await app.request('/api/marketplace/teams/nope', { headers: authHeader(token) });
		expect(res.status).toBe(404);
	});
});

describe('POST /api/projects with marketplace_slug', () => {
	it('provisions a full roster directly from the marketplace def', async () => {
		const res = await app.request('/api/projects', {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				name: 'Marketplace Launch Co',
				description: 'Launched from the marketplace.',
				marketplace_slug: 'software-development',
			}),
		});
		expect(res.status).toBe(201);
		const project = (await res.json()).data;
		const projectSlug = project.slug as string;

		const agentsRes = await app.request(`/api/projects/${projectSlug}/agents`, {
			headers: authHeader(token),
		});
		const agents = (await agentsRes.json()).data as Array<{
			slug: string;
			agent_type_id: string | null;
		}>;
		const slugs = agents.map((a) => a.slug);
		expect(slugs).toContain('captain');
		expect(slugs).toContain('engineer');
		expect(slugs).toContain('architect');
		expect(slugs).toContain('qa-engineer');

		// Marketplace roster members are inline agents (no catalog agent type); the
		// Captain keeps its builtin type.
		const engineer = agents.find((a) => a.slug === 'engineer');
		expect(engineer?.agent_type_id).toBeNull();
		const captain = agents.find((a) => a.slug === 'captain');
		expect(captain?.agent_type_id).not.toBeNull();
	});

	it('rejects combining marketplace_slug with template_id', async () => {
		const res = await app.request('/api/projects', {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				name: 'Conflict Co',
				description: 'x',
				marketplace_slug: 'software-development',
				template_id: '00000000-0000-0000-0000-000000000000',
			}),
		});
		expect(res.status).toBe(400);
	});

	it('404s on an unknown marketplace slug', async () => {
		const res = await app.request('/api/projects', {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ name: 'Missing Co', description: 'x', marketplace_slug: 'nope' }),
		});
		expect(res.status).toBe(404);
	});
});

describe('POST /api/project-intakes with marketplace_slug', () => {
	it('records the marketplace team as the CEO baseline', async () => {
		const res = await app.request('/api/project-intakes', {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				name: 'Intake Co',
				description: 'Scope with the CEO.',
				marketplace_slug: 'software-development',
			}),
		});
		expect(res.status).toBe(201);
		const intake = (await res.json()).data as { intake_task_id: string };
		// The intake ticket embeds the marketplace baseline for the CEO.
		const task = await db.query<{ description: string }>(
			`SELECT description FROM tasks WHERE id = $1`,
			[intake.intake_task_id],
		);
		expect(task.rows[0].description).toContain('marketplace_slug');
		expect(task.rows[0].description).toContain('software-development');
	});

	it('404s on an unknown marketplace slug', async () => {
		const res = await app.request('/api/project-intakes', {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ name: 'Intake Co 2', description: 'x', marketplace_slug: 'nope' }),
		});
		expect(res.status).toBe(404);
	});
});

describe('POST /api/projects/:projectId/marketplace-team', () => {
	it('kicks off a CEO task to add the roster to an existing project', async () => {
		// Create a Blank project first (Captain only), then add the sw-dev team.
		const projRes = await app.request('/api/projects', {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ name: 'Add Team Co', description: 'Start blank.' }),
		});
		const project = (await projRes.json()).data;
		const projectSlug = project.slug as string;

		const addRes = await app.request(`/api/projects/${projectSlug}/marketplace-team`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ slug: 'software-development' }),
		});
		expect(addRes.status).toBe(201);
		const added = (await addRes.json()).data;
		expect(added.task_id).toBeTruthy();
		expect(added.task_identifier).toBeTruthy();

		// The task exists, is CEO-owned, and instructs the apply_marketplace_team call.
		const task = await db.query<{ description: string; labels: string[] }>(
			`SELECT description, labels FROM tasks WHERE id = $1`,
			[added.task_id],
		);
		expect(task.rows[0].description).toContain('apply_marketplace_team');
		expect(task.rows[0].labels).toContain('add-marketplace-team');
	});

	it('404s on an unknown slug', async () => {
		const projRes = await app.request('/api/projects', {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ name: 'Add Team Co 2', description: 'Start blank.' }),
		});
		const projectSlug = (await projRes.json()).data.slug as string;
		const res = await app.request(`/api/projects/${projectSlug}/marketplace-team`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ slug: 'nope' }),
		});
		expect(res.status).toBe(404);
	});
});

describe('applyMarketplaceTeamToTeam re-import (version update)', () => {
	async function engineerPrompt(teamId: string): Promise<string | undefined> {
		const r = await db.query<{ content: string }>(
			`SELECT d.content FROM documents d
			 JOIN member_agents ma ON ma.id = d.member_agent_id
			 WHERE d.type = $1 AND d.team_id = $2 AND ma.slug = 'engineer'`,
			[DocumentType.AgentSystemPrompt, teamId],
		);
		return r.rows[0]?.content;
	}
	async function engineerCount(teamId: string): Promise<number> {
		const r = await db.query<{ n: number }>(
			`SELECT COUNT(*)::int AS n FROM member_agents ma
			 JOIN members m ON m.id = ma.id
			 WHERE m.team_id = $1 AND ma.slug = 'engineer'`,
			[teamId],
		);
		return r.rows[0].n;
	}

	it('skips existing roles by default, but refreshes their prompts with refreshExisting', async () => {
		const teamRes = await createTestTeam(db, {
			name: 'Reimport Co',
			marketplace_slug: 'software-development',
		});
		const teamId = (await teamRes.json()).data.id as string;
		const def = await getMarketplaceTeam('software-development');
		if (!def) throw new Error('missing def');

		// Simulate a locally-drifted engineer prompt.
		await db.query(
			`UPDATE documents SET content = 'STALE ENGINEER PROMPT'
			 FROM member_agents ma
			 WHERE documents.member_agent_id = ma.id AND ma.slug = 'engineer'
			   AND documents.type = $1 AND documents.team_id = $2`,
			[DocumentType.AgentSystemPrompt, teamId],
		);
		expect(await engineerPrompt(teamId)).toBe('STALE ENGINEER PROMPT');

		// Default: existing roles are skipped, no duplicate, prompt untouched.
		const skipRes = await applyMarketplaceTeamToTeam(db, teamId, def, {});
		expect(skipRes.created_slugs).not.toContain('engineer');
		expect(skipRes.skipped_slugs).toContain('engineer');
		expect(await engineerCount(teamId)).toBe(1);
		expect(await engineerPrompt(teamId)).toBe('STALE ENGINEER PROMPT');

		// refreshExisting: the role's prompt is updated in place (no duplicate).
		const refreshRes = await applyMarketplaceTeamToTeam(db, teamId, def, { refreshExisting: true });
		expect(refreshRes.updated_slugs).toContain('engineer');
		expect(await engineerCount(teamId)).toBe(1);
		const refreshed = await engineerPrompt(teamId);
		expect(refreshed).not.toBe('STALE ENGINEER PROMPT');
		expect(refreshed).toContain('You are an Engineer at');
	});
});
