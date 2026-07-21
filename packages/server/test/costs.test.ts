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
		name: 'Cost Co',
		template_id: typeId,
	});
	teamSlug = (await teamRes.json()).data.slug;

	const agentsRes = await app.request(
		`/api/projects/${await projectSlugForTeamSlug(db, teamSlug)}/agents`,
		{
			headers: authHeader(token),
		},
	);
	// Use the engineer (has 5000 budget)
	agentId = (await agentsRes.json()).data.find(
		(a: Record<string, unknown>) => a.slug === 'engineer',
	).id;
});

afterAll(async () => {
	await safeClose(db);
});

describe('costs CRUD', () => {
	it('creates a cost entry with budget debit', async () => {
		const res = await app.request(
			`/api/projects/${await projectSlugForTeamSlug(db, teamSlug)}/costs`,
			{
				method: 'POST',
				headers: { ...authHeader(token), 'Content-Type': 'application/json' },
				body: JSON.stringify({
					member_id: agentId,
					amount_cents: 100,
					description: 'Tool call cost',
				}),
			},
		);
		expect(res.status).toBe(201);
		const body = await res.json();
		expect(body.data.amount_cents).toBe(100);
	});

	it('lists cost entries', async () => {
		const res = await app.request(
			`/api/projects/${await projectSlugForTeamSlug(db, teamSlug)}/costs`,
			{
				headers: authHeader(token),
			},
		);
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.data.entries.length).toBeGreaterThanOrEqual(1);
		expect(body.data.total_cents).toBeGreaterThan(0);
	});

	it('groups costs by agent', async () => {
		const res = await app.request(
			`/api/projects/${await projectSlugForTeamSlug(db, teamSlug)}/costs?group_by=agent`,
			{
				headers: authHeader(token),
			},
		);
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.data.summary.length).toBeGreaterThanOrEqual(1);
		expect(body.data.total_cents).toBeGreaterThan(0);
	});

	it('records an over-budget cost and pauses the agent', async () => {
		const slug = await projectSlugForTeamSlug(db, teamSlug);
		// Far exceeds any monthly limit. Spend is always recorded (no 402), but the
		// agent is reactively paused since this pushes it over budget.
		const res = await app.request(`/api/projects/${slug}/costs`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				member_id: agentId,
				amount_cents: 9_999_999,
				description: 'Way too expensive',
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
