import { DocumentType } from '@hezo/shared';
import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../src/db/database';
import type { Env } from '../src/lib/types';
import { getMarketplaceTeam } from '../src/services/marketplace';
import {
	applyMarketplaceRoleToTeam,
	applyMarketplaceTeamToTeam,
} from '../src/services/team-template-apply';
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
			id: string;
			slug: string;
			agent_type_id: string | null;
			reports_to: string | null;
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

		// The full reporting structure from the manifest is wired: the Captain leads
		// the team (the def's `reports_to_slug: "captain"` entries resolve even though
		// the Captain is provisioned as a builtin, outside the roster array), the
		// Architect leads the engineering roles, and the Captain reports to the CEO.
		const bySlug = new Map(agents.map((a) => [a.slug, a]));
		const architect = bySlug.get('architect');
		expect(architect?.reports_to).toBe(captain?.id);
		for (const lead of ['product-lead', 'marketing-lead', 'researcher']) {
			expect(bySlug.get(lead)?.reports_to).toBe(captain?.id);
		}
		for (const eng of [
			'engineer',
			'qa-engineer',
			'security-engineer',
			'ui-designer',
			'devops-engineer',
		]) {
			expect(bySlug.get(eng)?.reports_to).toBe(architect?.id);
		}
		const ceo = await db.query<{ id: string }>(
			`SELECT id FROM member_agents WHERE slug = 'ceo' LIMIT 1`,
		);
		expect(captain?.reports_to).toBe(ceo.rows[0].id);
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

describe('POST /api/projects/:projectId/marketplace-team with a role subset', () => {
	async function blankProject(name: string): Promise<string> {
		const res = await app.request('/api/projects', {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ name, description: 'Start blank.' }),
		});
		return (await res.json()).data.slug as string;
	}
	function addRoles(projectSlug: string, body: Record<string, unknown>): Promise<Response> {
		return app.request(`/api/projects/${projectSlug}/marketplace-team`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ slug: 'software-development', ...body }),
		});
	}

	it('kicks off a CEO task naming only the chosen roles', async () => {
		const projectSlug = await blankProject('Subset Co');
		const res = await addRoles(projectSlug, { roles: ['security-engineer', 'qa-engineer'] });
		expect(res.status).toBe(201);
		const added = (await res.json()).data;

		const task = await db.query<{ title: string; description: string; labels: string[] }>(
			`SELECT title, description, labels FROM tasks WHERE id = $1`,
			[added.task_id],
		);
		const { title, description, labels } = task.rows[0];
		expect(labels).toContain('add-marketplace-roles');
		expect(labels).not.toContain('add-marketplace-team');
		expect(title).toBe('Add 2 roles from the App Team team');
		// One apply_marketplace_agent call per chosen role, and nothing about the rest.
		expect(description).toContain('role="security-engineer"');
		expect(description).toContain('role="qa-engineer"');
		expect(description).not.toContain('role="engineer"');
		expect(description).not.toContain('apply_marketplace_team');
		// Asking the admin when a role does not fit is part of the instructions.
		expect(description).toContain('@admin');
	});

	it('titles a single-role add after the role', async () => {
		const projectSlug = await blankProject('Single Role Co');
		const res = await addRoles(projectSlug, { roles: ['researcher'] });
		expect(res.status).toBe(201);
		const task = await db.query<{ title: string }>(`SELECT title FROM tasks WHERE id = $1`, [
			(await res.json()).data.task_id,
		]);
		expect(task.rows[0].title).toBe('Add the "Researcher" role from the App Team team');
	});

	it('404s on a role that is not in the roster', async () => {
		const projectSlug = await blankProject('Bad Role Co');
		const res = await addRoles(projectSlug, { roles: ['engineer', 'nope'] });
		expect(res.status).toBe(404);
		expect((await res.json()).error.message).toContain('nope');
	});

	it('rejects the Captain, which is never a roster role', async () => {
		const projectSlug = await blankProject('Captain Pick Co');
		const res = await addRoles(projectSlug, { roles: ['captain'] });
		expect(res.status).toBe(404);
	});

	it('rejects an explicit empty roles array rather than adding the whole team', async () => {
		const projectSlug = await blankProject('Empty Roles Co');
		const res = await addRoles(projectSlug, { roles: [] });
		expect(res.status).toBe(400);
		// Nothing was enqueued.
		const tasks = await db.query<{ n: number }>(
			`SELECT COUNT(*)::int AS n FROM tasks t
			 JOIN projects p ON p.id = t.project_id
			 WHERE p.slug = $1 AND t.labels::jsonb ? 'add-marketplace-roles'`,
			[projectSlug],
		);
		expect(tasks.rows[0].n).toBe(0);
	});

	it('rejects a non-array roles value', async () => {
		const projectSlug = await blankProject('Bad Roles Type Co');
		const res = await addRoles(projectSlug, { roles: 'engineer' });
		expect(res.status).toBe(400);
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

describe('applyMarketplaceRoleToTeam (single role onto an existing team)', () => {
	async function blankTeam(name: string): Promise<string> {
		const res = await createTestTeam(db, { name });
		return (await res.json()).data.id as string;
	}
	async function agentSlugs(teamId: string): Promise<string[]> {
		const r = await db.query<{ slug: string }>(
			`SELECT ma.slug FROM member_agents ma JOIN members m ON m.id = ma.id
			 WHERE m.team_id = $1 ORDER BY ma.slug`,
			[teamId],
		);
		return r.rows.map((x) => x.slug);
	}
	async function promptOf(teamId: string, slug: string): Promise<string | undefined> {
		const r = await db.query<{ content: string }>(
			`SELECT d.content FROM documents d
			 JOIN member_agents ma ON ma.id = d.member_agent_id
			 WHERE d.type = $1 AND d.team_id = $2 AND ma.slug = $3`,
			[DocumentType.AgentSystemPrompt, teamId, slug],
		);
		return r.rows[0]?.content;
	}
	async function managerSlugOf(teamId: string, slug: string): Promise<string | null> {
		const r = await db.query<{ manager: string | null }>(
			`SELECT mgr.slug AS manager FROM member_agents ma
			 JOIN members m ON m.id = ma.id
			 LEFT JOIN member_agents mgr ON mgr.id = ma.reports_to
			 WHERE m.team_id = $1 AND ma.slug = $2`,
			[teamId, slug],
		);
		return r.rows[0]?.manager ?? null;
	}

	it('adds exactly one inline role and leaves the Captain untouched', async () => {
		const teamId = await blankTeam('One Role Co');
		const def = await getMarketplaceTeam('software-development');
		if (!def) throw new Error('missing def');

		const before = await agentSlugs(teamId);
		expect(before).toContain('captain');
		const captainPromptBefore = await promptOf(teamId, 'captain');

		const res = await applyMarketplaceRoleToTeam(db, teamId, def, 'security-engineer');
		expect(res).toEqual({
			added: true,
			skipped: false,
			reports_to_slug: 'captain',
			reports_to_fell_back: true,
		});

		// Exactly one new member, and it is the one asked for.
		const after = await agentSlugs(teamId);
		expect(after).toEqual([...before, 'security-engineer'].sort());

		// Provisioned inline, like a hire — not as a catalog agent type.
		const row = await db.query<{ agent_type_id: string | null; title: string }>(
			`SELECT ma.agent_type_id, ma.title FROM member_agents ma JOIN members m ON m.id = ma.id
			 WHERE m.team_id = $1 AND ma.slug = 'security-engineer'`,
			[teamId],
		);
		expect(row.rows[0].agent_type_id).toBeNull();
		expect(row.rows[0].title).toBe('Security Engineer');
		expect(await promptOf(teamId, 'security-engineer')).toContain('{{team_name}}');

		// The whole-team path applies the def's Captain override; this one must not.
		expect(await promptOf(teamId, 'captain')).toBe(captainPromptBefore);
	});

	it('wires the real manager when the role reports to someone already on the team', async () => {
		const teamId = await blankTeam('Real Manager Co');
		const def = await getMarketplaceTeam('software-development');
		if (!def) throw new Error('missing def');

		// The engineer reports to the architect, so add the architect first.
		const first = await applyMarketplaceRoleToTeam(db, teamId, def, 'architect');
		expect(first).toMatchObject({ added: true, reports_to_slug: 'captain' });

		const second = await applyMarketplaceRoleToTeam(db, teamId, def, 'engineer');
		expect(second).toMatchObject({
			added: true,
			reports_to_slug: 'architect',
			reports_to_fell_back: false,
		});
		expect(await managerSlugOf(teamId, 'engineer')).toBe('architect');
	});

	it('skips a slug the team already has instead of duplicating it', async () => {
		const teamId = await blankTeam('Dup Role Co');
		const def = await getMarketplaceTeam('software-development');
		if (!def) throw new Error('missing def');

		await applyMarketplaceRoleToTeam(db, teamId, def, 'researcher');
		const again = await applyMarketplaceRoleToTeam(db, teamId, def, 'researcher');
		expect(again).toMatchObject({ added: false, skipped: true, reports_to_slug: null });

		const count = await db.query<{ n: number }>(
			`SELECT COUNT(*)::int AS n FROM member_agents ma JOIN members m ON m.id = ma.id
			 WHERE m.team_id = $1 AND ma.slug = 'researcher'`,
			[teamId],
		);
		expect(count.rows[0].n).toBe(1);
	});

	it('errors on a role that is not in the roster', async () => {
		const teamId = await blankTeam('Unknown Role Co');
		const def = await getMarketplaceTeam('software-development');
		if (!def) throw new Error('missing def');

		const res = await applyMarketplaceRoleToTeam(db, teamId, def, 'captain');
		expect(res).toHaveProperty('error');
		expect(await agentSlugs(teamId)).not.toContain('security-engineer');
	});
});
