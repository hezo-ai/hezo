import type { PGlite } from '@electric-sql/pglite';
import { HQ_PROJECT_SLUG } from '@hezo/shared';
import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Env } from '../src/lib/types';
import { safeClose } from './helpers';
import { authHeader, createTestApp, createTestTeam, projectSlugFor } from './helpers/app';

let app: Hono<Env>;
let db: PGlite;
let token: string;
let teamId: string;
let projectSlug: string;

beforeAll(async () => {
	const ctx = await createTestApp();
	app = ctx.app;
	db = ctx.db;
	token = ctx.token;

	const typesRes = await app.request('/api/team-templates', {
		headers: authHeader(token),
	});
	const typeId = (await typesRes.json()).data.find(
		(t: Record<string, unknown>) => t.name === 'Startup',
	).id;

	const teamRes = await createTestTeam(db, {
		name: 'Agent Test Co',
		template_id: typeId,
	});
	const team = (await teamRes.json()).data;
	teamId = team.id;
	projectSlug = `${await projectSlugFor(db, team.id)}`;
});

afterAll(async () => {
	await safeClose(db);
});

describe('agents CRUD', () => {
	it('lists all auto-created agents plus HQ virtual members', async () => {
		const res = await app.request(`/api/projects/${projectSlug}/agents`, {
			headers: authHeader(token),
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		const own = body.data.filter((a: Record<string, unknown>) => !a.is_instance);
		const instance = body.data.filter((a: Record<string, unknown>) => a.is_instance);
		expect(own).toHaveLength(10);
		// HQ agents (CEO + Coach) surface as virtual members, ordered last.
		expect(instance.map((a: Record<string, unknown>) => a.slug).sort()).toEqual(['ceo', 'coach']);
	});

	it('all agents start with idle runtime_status and enabled admin_status', async () => {
		const res = await app.request(`/api/projects/${projectSlug}/agents`, {
			headers: authHeader(token),
		});
		const body = await res.json();
		for (const agent of body.data) {
			expect(agent.runtime_status).toBe('idle');
			expect(agent.admin_status).toBe('enabled');
		}
	});

	it('filters agents by admin_status', async () => {
		const res = await app.request(`/api/projects/${projectSlug}/agents?admin_status=enabled`, {
			headers: authHeader(token),
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.data.length).toBeGreaterThanOrEqual(1);
		expect(body.data.every((a: Record<string, unknown>) => a.admin_status === 'enabled')).toBe(
			true,
		);
	});

	it('gets an agent by id with full detail', async () => {
		const listRes = await app.request(`/api/projects/${projectSlug}/agents`, {
			headers: authHeader(token),
		});
		const agents = (await listRes.json()).data;
		const captain = agents.find((a: Record<string, unknown>) => a.slug === 'captain');

		const res = await app.request(`/api/projects/${projectSlug}/agents/${captain.id}`, {
			headers: authHeader(token),
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.data.title).toBe('Captain');
		expect(body.data).toHaveProperty('mcp_servers');
		expect(body.data).toHaveProperty('runtime_status');
		expect(body.data).toHaveProperty('admin_status');
	});

	it('resolves an HQ virtual member (CEO) by slug under a non-HQ project', async () => {
		const res = await app.request(`/api/projects/${projectSlug}/agents/ceo`, {
			headers: authHeader(token),
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.data.slug).toBe('ceo');
		expect(body.data.is_instance).toBe(true);
	});

	it('gets an agent by slug', async () => {
		const res = await app.request(`/api/projects/${projectSlug}/agents/architect`, {
			headers: authHeader(token),
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.data.slug).toBe('architect');
	});

	it('returns 404 for an unknown agent slug', async () => {
		const res = await app.request(`/api/projects/${projectSlug}/agents/no-such-agent`, {
			headers: authHeader(token),
		});
		expect(res.status).toBe(404);
	});

	it('fetches the system prompt by agent slug', async () => {
		const res = await app.request(`/api/projects/${projectSlug}/agents/architect/system-prompt`, {
			headers: authHeader(token),
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(typeof body.data.content).toBe('string');
	});

	it('preview endpoint resolves placeholders and omits Run Context', async () => {
		const rawRes = await app.request(
			`/api/projects/${projectSlug}/agents/architect/system-prompt`,
			{
				headers: authHeader(token),
			},
		);
		const raw = ((await rawRes.json()).data?.content ?? '') as string;

		const res = await app.request(
			`/api/projects/${projectSlug}/agents/architect/system-prompt/preview`,
			{
				headers: authHeader(token),
			},
		);
		expect(res.status).toBe(200);
		const resolved = ((await res.json()).data?.content ?? '') as string;

		expect(resolved).not.toMatch(/\{\{[a-z_]+\}\}/);
		expect(resolved).not.toContain('## Run Context');
		expect(resolved).toContain('## Teammates');
		expect(resolved).toContain('## Working Guidelines');
		if (raw.includes('{{team_name}}')) {
			expect(resolved).toContain('Agent Test Co');
		}
	});

	it('preview endpoint 404s for unknown agent', async () => {
		const res = await app.request(
			`/api/projects/${projectSlug}/agents/no-such-agent/system-prompt/preview`,
			{ headers: authHeader(token) },
		);
		expect(res.status).toBe(404);
	});

	it('seeds the architect with a PRD gate instruction', async () => {
		const listRes = await app.request(`/api/projects/${projectSlug}/agents`, {
			headers: authHeader(token),
		});
		const agents = (await listRes.json()).data;
		const architect = agents.find((a: Record<string, unknown>) => a.slug === 'architect');

		const promptRes = await app.request(
			`/api/projects/${projectSlug}/agents/${architect.id}/system-prompt`,
			{ headers: authHeader(token) },
		);
		const prompt = (await promptRes.json()).data.content as string;

		expect(prompt).toMatch(/read_project_doc/);
		expect(prompt).toMatch(/prd\.md/);
		expect(prompt).toMatch(/add_task_blocker/);
		expect(prompt).toMatch(/PRD gate/i);
	});

	it('seeds the architect with a deploy-ticket gate on the reviews', async () => {
		const listRes = await app.request(`/api/projects/${projectSlug}/agents`, {
			headers: authHeader(token),
		});
		const agents = (await listRes.json()).data;
		const architect = agents.find((a: Record<string, unknown>) => a.slug === 'architect');

		const promptRes = await app.request(
			`/api/projects/${projectSlug}/agents/${architect.id}/system-prompt`,
			{ headers: authHeader(token) },
		);
		const prompt = (await promptRes.json()).data.content as string;

		// The architect pre-files the deploy ticket for DevOps, gated on the reviews,
		// so DevOps is only woken once the codebase has passed QA + security review.
		expect(prompt).toMatch(/devops-engineer/);
		expect(prompt).toMatch(/blocked_by_task_ids/);
		expect(prompt).toMatch(/deploy/i);
		expect(prompt).toMatch(/security review/i);
	});

	it('seeds the marketing lead with a deployment publish gate', async () => {
		const listRes = await app.request(`/api/projects/${projectSlug}/agents`, {
			headers: authHeader(token),
		});
		const agents = (await listRes.json()).data;
		const marketing = agents.find((a: Record<string, unknown>) => a.slug === 'marketing-lead');

		const promptRes = await app.request(
			`/api/projects/${projectSlug}/agents/${marketing.id}/system-prompt`,
			{ headers: authHeader(token) },
		);
		const prompt = (await promptRes.json()).data.content as string;

		// Launch comms are held (add_task_blocker on the deploy ticket) until deploy closes.
		expect(prompt).toMatch(/deploy/i);
		expect(prompt).toMatch(/add_task_blocker/);
		expect(prompt).toMatch(/publish/i);
	});

	it('no agent system prompt references a .dev/ path for project docs', async () => {
		const listRes = await app.request(`/api/projects/${projectSlug}/agents`, {
			headers: authHeader(token),
		});
		const agents = (await listRes.json()).data;
		const anyDevFolderRef = /\.dev\//;
		for (const summary of agents) {
			const promptRes = await app.request(
				`/api/projects/${projectSlug}/agents/${summary.id}/system-prompt`,
				{ headers: authHeader(token) },
			);
			const prompt = ((await promptRes.json()).data?.content ?? '') as string;
			expect(prompt).not.toMatch(anyDevFolderRef);
		}
	});

	it('creates (hires) a custom agent', async () => {
		const res = await app.request(`/api/projects/${projectSlug}/agents`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				title: 'Data Scientist',
				role_description: 'Analyzes data and builds ML models',
				monthly_budget_cents: 4000,
			}),
		});
		expect(res.status).toBe(201);
		const body = await res.json();
		expect(body.data.title).toBe('Data Scientist');
		expect(body.data.slug).toBe('data-scientist');
		expect(body.data.runtime_status).toBe('idle');
		expect(body.data.admin_status).toBe('enabled');
	});

	it('updates an agent', async () => {
		const listRes = await app.request(`/api/projects/${projectSlug}/agents`, {
			headers: authHeader(token),
		});
		const agents = (await listRes.json()).data;
		const engineer = agents.find((a: Record<string, unknown>) => a.slug === 'engineer');

		const res = await app.request(`/api/projects/${projectSlug}/agents/${engineer.id}`, {
			method: 'PATCH',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ monthly_budget_cents: 8000 }),
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.data.monthly_budget_cents).toBe(8000);
	});

	it('disables an enabled agent', async () => {
		const listRes = await app.request(`/api/projects/${projectSlug}/agents`, {
			headers: authHeader(token),
		});
		const agents = (await listRes.json()).data;
		const researcher = agents.find((a: Record<string, unknown>) => a.slug === 'researcher');

		const res = await app.request(`/api/projects/${projectSlug}/agents/${researcher.id}/disable`, {
			method: 'POST',
			headers: authHeader(token),
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.data.admin_status).toBe('disabled');
	});

	it('rejects disabling an already disabled agent', async () => {
		const listRes = await app.request(`/api/projects/${projectSlug}/agents`, {
			headers: authHeader(token),
		});
		const agents = (await listRes.json()).data;
		const researcher = agents.find((a: Record<string, unknown>) => a.slug === 'researcher');

		const res = await app.request(`/api/projects/${projectSlug}/agents/${researcher.id}/disable`, {
			method: 'POST',
			headers: authHeader(token),
		});
		expect(res.status).toBe(409);
	});

	it('enables a disabled agent', async () => {
		const listRes = await app.request(`/api/projects/${projectSlug}/agents`, {
			headers: authHeader(token),
		});
		const agents = (await listRes.json()).data;
		const researcher = agents.find((a: Record<string, unknown>) => a.slug === 'researcher');

		const res = await app.request(`/api/projects/${projectSlug}/agents/${researcher.id}/enable`, {
			method: 'POST',
			headers: authHeader(token),
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.data.admin_status).toBe('enabled');
	});

	it('rejects enabling an already enabled agent', async () => {
		const listRes = await app.request(`/api/projects/${projectSlug}/agents`, {
			headers: authHeader(token),
		});
		const agents = (await listRes.json()).data;
		const researcher = agents.find((a: Record<string, unknown>) => a.slug === 'researcher');

		const res = await app.request(`/api/projects/${projectSlug}/agents/${researcher.id}/enable`, {
			method: 'POST',
			headers: authHeader(token),
		});
		expect(res.status).toBe(409);
	});

	it('disabling an agent unassigns its open tasks', async () => {
		const listRes = await app.request(`/api/projects/${projectSlug}/agents`, {
			headers: authHeader(token),
		});
		const agents = (await listRes.json()).data;
		const marketingLead = agents.find((a: Record<string, unknown>) => a.slug === 'marketing-lead');

		const res = await app.request(
			`/api/projects/${projectSlug}/agents/${marketingLead.id}/disable`,
			{
				method: 'POST',
				headers: authHeader(token),
			},
		);
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.data.admin_status).toBe('disabled');
	});

	it.each([
		'ceo',
		'coach',
	])('refuses to disable the HQ instance %s, even for the admin', async (slug) => {
		const res = await app.request(`/api/projects/${HQ_PROJECT_SLUG}/agents/${slug}/disable`, {
			method: 'POST',
			headers: authHeader(token),
		});
		expect(res.status).toBe(403);
		const body = await res.json();
		expect(body.error.code).toBe('FORBIDDEN');

		// The instance agent stays enabled after the rejected attempt.
		const listRes = await app.request(`/api/projects/${HQ_PROJECT_SLUG}/agents`, {
			headers: authHeader(token),
		});
		const agent = (await listRes.json()).data.find((a: Record<string, unknown>) => a.slug === slug);
		expect(agent.admin_status).toBe('enabled');
	});

	it('returns org chart with runtime_status and admin_status', async () => {
		const res = await app.request(`/api/projects/${projectSlug}/org-chart`, {
			headers: authHeader(token),
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.data.admin).toBeDefined();
		expect(body.data.admin.children.length).toBeGreaterThan(0);
		const captain = body.data.admin.children.find(
			(c: Record<string, unknown>) => c.title === 'Captain',
		);
		expect(captain).toBeDefined();
		expect(captain).toHaveProperty('runtime_status');
		expect(captain).toHaveProperty('admin_status');
		expect(captain).toHaveProperty('role_description');
		expect(captain.children.length).toBeGreaterThan(0);
	});

	it('rejects duplicate agent slug', async () => {
		const res = await app.request(`/api/projects/${projectSlug}/agents`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ title: 'Captain' }),
		});
		expect(res.status).toBe(409);
	});
});

describe('heartbeat runs', () => {
	it('returns empty array when no runs exist', async () => {
		const listRes = await app.request(`/api/projects/${projectSlug}/agents`, {
			headers: authHeader(token),
		});
		const agents = (await listRes.json()).data;
		const agent = agents[0];

		const res = await app.request(
			`/api/projects/${projectSlug}/agents/${agent.id}/heartbeat-runs`,
			{
				headers: authHeader(token),
			},
		);
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.data).toEqual([]);
	});

	it('returns runs after inserting heartbeat records', async () => {
		const listRes = await app.request(`/api/projects/${projectSlug}/agents`, {
			headers: authHeader(token),
		});
		const agents = (await listRes.json()).data;
		const agent = agents[0];

		await db.query(
			`INSERT INTO heartbeat_runs (member_id, team_id, status, started_at, finished_at, exit_code, log_text)
			 VALUES ($1, $2, 'succeeded', now() - interval '5 minutes', now(), 0, 'All done')`,
			[agent.id, teamId],
		);

		const res = await app.request(
			`/api/projects/${projectSlug}/agents/${agent.id}/heartbeat-runs`,
			{
				headers: authHeader(token),
			},
		);
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.data.length).toBeGreaterThanOrEqual(1);
		expect(body.data[0].status).toBe('succeeded');
		expect(body.data[0].exit_code).toBe(0);
		expect(body.data[0].log_text).toBe('All done');
	});
});
