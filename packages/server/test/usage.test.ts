import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../src/db/database';
import type { Env } from '../src/lib/types';
import { safeClose } from './helpers';
import {
	authHeader,
	createTestApp,
	createTestTeam,
	projectSlugFor,
	projectSlugForTeamSlug,
} from './helpers/app';

let app: Hono<Env>;
let db: Db;
let token: string;
let teamSlug: string;
let agentId: string;

beforeAll(async () => {
	const ctx = await createTestApp();
	app = ctx.app;
	db = ctx.db;
	token = ctx.token;

	const typesRes = await app.request('/api/team-templates', {
		headers: authHeader(token),
	});
	const typeId = (await typesRes.json()).data.find((t: any) => t.name === 'App Team').id;

	const teamRes = await createTestTeam(db, {
		name: 'Usage Co',
		template_id: typeId,
	});
	teamSlug = (await teamRes.json()).data.slug;

	const agentsRes = await app.request(
		`/api/projects/${await projectSlugForTeamSlug(db, teamSlug)}/agents`,
		{
			headers: authHeader(token),
		},
	);
	agentId = (await agentsRes.json()).data.find(
		(a: Record<string, unknown>) => a.slug === 'engineer',
	).id;
});

afterAll(async () => {
	await safeClose(db);
});

describe('usage CRUD', () => {
	it('records a usage entry', async () => {
		const res = await app.request(
			`/api/projects/${await projectSlugForTeamSlug(db, teamSlug)}/usage`,
			{
				method: 'POST',
				headers: { ...authHeader(token), 'Content-Type': 'application/json' },
				body: JSON.stringify({
					member_id: agentId,
					input_tokens: 100,
					description: 'Tool call',
				}),
			},
		);
		expect(res.status).toBe(201);
		const body = await res.json();
		expect(body.data.input_tokens).toBe(100);
	});

	it('lists usage entries', async () => {
		const res = await app.request(
			`/api/projects/${await projectSlugForTeamSlug(db, teamSlug)}/usage`,
			{
				headers: authHeader(token),
			},
		);
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.data.entries.length).toBeGreaterThanOrEqual(1);
		expect(body.data.total_tokens).toBeGreaterThan(0);
	});

	it('groups usage by agent', async () => {
		const res = await app.request(
			`/api/projects/${await projectSlugForTeamSlug(db, teamSlug)}/usage?group_by=agent`,
			{
				headers: authHeader(token),
			},
		);
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.data.summary.length).toBeGreaterThanOrEqual(1);
		expect(body.data.total_tokens).toBeGreaterThan(0);
	});

	it('records over-budget usage and pauses the agent', async () => {
		const slug = await projectSlugForTeamSlug(db, teamSlug);
		// Give the agent a window to blow. Agents ship uncapped now, and an
		// unlimited window never trips - so without this there is no over-budget
		// state for the usage below to reach.
		await db.query(`UPDATE member_agents SET monthly_budget_tokens = 3000 WHERE id = $1`, [
			agentId,
		]);
		// Far exceeds any monthly limit. Usage is always recorded (no 402), but the
		// agent is reactively paused since this pushes it over budget.
		const res = await app.request(`/api/projects/${slug}/usage`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				member_id: agentId,
				input_tokens: 9_999_999,
				description: 'Way over budget',
			}),
		});
		expect(res.status).toBe(201);

		const agentRes = await app.request(`/api/projects/${slug}/agents/${agentId}`, {
			headers: authHeader(token),
		});
		const agent = (await agentRes.json()).data;
		// The agent's own monthly window trips (the project is unlimited), so it
		// lands in the scoped budget-pause state — not a manual `paused`.
		expect(agent.runtime_status).toBe('out_of_agent_budget');
	});
});

describe('usage entry validation and paging', () => {
	it('refuses a dollar amount and names the token fields that replace it', async () => {
		const slug = await projectSlugForTeamSlug(db, teamSlug);
		const res = await app.request(`/api/projects/${slug}/usage`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ member_id: agentId, amount_cents: 250 }),
		});
		expect(res.status).toBe(400);
		const body = await res.json();
		expect(body.error.message).toContain('input_tokens');
		expect(body.error.message).toContain('amount_cents');
	});

	it('counts output tokens in the totals alongside input', async () => {
		const slug = await projectSlugForTeamSlug(db, teamSlug);
		const before = (
			await (
				await app.request(`/api/projects/${slug}/usage`, { headers: authHeader(token) })
			).json()
		).data;
		const res = await app.request(`/api/projects/${slug}/usage`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ member_id: agentId, input_tokens: 40, output_tokens: 60 }),
		});
		expect(res.status).toBe(201);
		const after = (
			await (
				await app.request(`/api/projects/${slug}/usage`, { headers: authHeader(token) })
			).json()
		).data;
		expect(after.input_tokens - before.input_tokens).toBe(40);
		expect(after.output_tokens - before.output_tokens).toBe(60);
		expect(after.total_tokens - before.total_tokens).toBe(100);
	});

	it('pages the entries by cursor while the totals cover every entry', async () => {
		const slug = await projectSlugForTeamSlug(db, teamSlug);
		const all = (
			await (
				await app.request(`/api/projects/${slug}/usage`, { headers: authHeader(token) })
			).json()
		).data;
		expect(all.entries.length).toBeGreaterThanOrEqual(2);

		const first = (
			await (
				await app.request(`/api/projects/${slug}/usage?limit=1`, { headers: authHeader(token) })
			).json()
		).data;
		expect(first.entries).toHaveLength(1);
		expect(first.has_more).toBe(true);
		expect(first.total_tokens).toBe(all.total_tokens);

		const second = (
			await (
				await app.request(
					`/api/projects/${slug}/usage?limit=1&cursor=${encodeURIComponent(first.next_cursor)}`,
					{ headers: authHeader(token) },
				)
			).json()
		).data;
		expect(second.entries).toHaveLength(1);
		expect(second.entries[0].id).toBe(all.entries[1].id);
	});

	it('rejects a malformed cursor rather than restarting from the first page', async () => {
		const slug = await projectSlugForTeamSlug(db, teamSlug);
		const res = await app.request(`/api/projects/${slug}/usage?cursor=not-a-cursor`, {
			headers: authHeader(token),
		});
		expect(res.status).toBe(400);
		expect((await res.json()).error.code).toBe('invalid_cursor');
	});
});
