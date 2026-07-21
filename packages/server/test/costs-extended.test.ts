import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../src/db/database';
import type { Env } from '../src/lib/types';
import { safeClose } from './helpers';
import {
	authHeader,
	createTestApp,
	createTestProject,
	createTestTeam,
	projectSlugFor,
} from './helpers/app';

let app: Hono<Env>;
let db: Db;
let token: string;
let teamId: string;
let projectSlug: string;
let agentId: string;
let agent2Id: string;
let projectId: string;
let taskId: string;
let anthropicConfigId: string;
let openaiConfigId: string;

beforeAll(async () => {
	const ctx = await createTestApp();
	app = ctx.app;
	db = ctx.db;
	token = ctx.token;

	// Create team with App Team template
	const typesRes = await app.request('/api/team-templates', {
		headers: authHeader(token),
	});
	const typeId = (await typesRes.json()).data.find((t: any) => t.name === 'App Team').id;

	const teamRes = await createTestTeam(db, {
		name: 'Extended Cost Co',
		template_id: typeId,
	});
	const team = (await teamRes.json()).data;
	teamId = team.id;

	// Get two agents to work with
	const agentsRes = await app.request(`/api/projects/${await projectSlugFor(db, teamId)}/agents`, {
		headers: authHeader(token),
	});
	const agents = (await agentsRes.json()).data;
	agentId = agents.find((a: Record<string, unknown>) => a.slug === 'engineer').id;
	agent2Id = agents.find((a: Record<string, unknown>) => a.slug === 'ui-designer').id;

	// All cost reads are project-scoped now; everything below belongs to this project.
	const proj1Res = await createTestProject(db, teamId, {
		name: 'Project Alpha',
		description: 'Test project.',
	});
	const proj1 = (await proj1Res.json()).data;
	projectId = proj1.id;
	projectSlug = proj1.slug;

	// Create an task under the project
	const taskRes = await app.request(`/api/projects/${projectSlug}/tasks`, {
		method: 'POST',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify({
			title: 'Test Task',
			project_id: projectId,
			assignee_id: agentId,
		}),
	});
	taskId = (await taskRes.json()).data.id;

	// Two AI adapter configs to exercise the per-adapter breakdown.
	const cfg = await db.query<{ id: string }>(
		`INSERT INTO ai_provider_configs (provider, auth_method, label, encrypted_credential)
		 VALUES ('anthropic', 'api_key', 'Anthropic Prod', 'x'),
		        ('openai', 'api_key', 'OpenAI Prod', 'y')
		 RETURNING id, provider`,
	);
	anthropicConfigId = (cfg.rows as any[]).find((r) => r.provider === 'anthropic').id;
	openaiConfigId = (cfg.rows as any[]).find((r) => r.provider === 'openai').id;

	// Insert cost entries with varied dates, agents, and adapters directly via DB
	// so we can control timestamps precisely for date-range tests. All belong to the
	// project above. Amounts stay small to stay within budget limits.
	await db.query(
		`INSERT INTO cost_entries (member_id, project_id, task_id, amount_cents, description, ai_provider_config_id, provider, created_at)
     VALUES
       ($2, $1, $3, 50,  'past entry',         $4, 'anthropic', '2024-01-15 10:00:00+00'),
       ($2, $1, NULL, 75, 'past no-task',       $4, 'anthropic', '2024-01-20 12:00:00+00'),
       ($5, $1, NULL, 120,'agent2 openai',      $6, 'openai',    '2024-02-10 08:00:00+00'),
       ($2, $1, NULL, 30, 'agent1 unattributed', NULL, NULL,     '2024-03-01 09:00:00+00')`,
		[projectId, agentId, taskId, anthropicConfigId, agent2Id, openaiConfigId],
	);
});

afterAll(async () => {
	await safeClose(db);
});

describe('costs – date range filtering', () => {
	it('filters by from date (inclusive)', async () => {
		const res = await app.request(`/api/projects/${projectSlug}/costs?from=2024-02-01`, {
			headers: authHeader(token),
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		// Only entries on/after 2024-02-01: agent2 (120) + agent1 unattributed (30)
		expect(body.data.entries.length).toBe(2);
		expect(body.data.total_cents).toBe(150);
	});

	it('filters by to date (inclusive)', async () => {
		const res = await app.request(`/api/projects/${projectSlug}/costs?to=2024-01-31`, {
			headers: authHeader(token),
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		// Only entries on/before 2024-01-31: past entry (50) + past no-task (75)
		expect(body.data.entries.length).toBe(2);
		expect(body.data.total_cents).toBe(125);
	});

	it('filters by from and to range together', async () => {
		const res = await app.request(
			`/api/projects/${projectSlug}/costs?from=2024-01-18&to=2024-02-28`,
			{
				headers: authHeader(token),
			},
		);
		expect(res.status).toBe(200);
		const body = await res.json();
		// Entries in range: past no-task (75, Jan 20) + agent2 openai (120, Feb 10)
		expect(body.data.entries.length).toBe(2);
		expect(body.data.total_cents).toBe(195);
	});
});

describe('costs – project scoping', () => {
	it('returns only entries for the path project', async () => {
		const res = await app.request(`/api/projects/${projectSlug}/costs`, {
			headers: authHeader(token),
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.data.entries.length).toBe(4);
		for (const entry of body.data.entries) {
			expect(entry.project_id).toBe(projectId);
		}
		expect(body.data.total_cents).toBe(275);
	});

	it('returns no entries for a different project', async () => {
		// A team owns exactly one project (1:1), so a second project needs its own
		// team. None of our cost entries belong to it, so it should read empty.
		const typesRes = await app.request('/api/team-templates', { headers: authHeader(token) });
		const typeId = (await typesRes.json()).data.find((t: any) => t.name === 'App Team').id;
		const team2Res = await createTestTeam(db, { name: 'Other Cost Co', template_id: typeId });
		const team2Id = (await team2Res.json()).data.id;
		const other = await createTestProject(db, team2Id, { name: 'Project Beta' });
		const otherSlug = (await other.json()).data.slug;
		const res = await app.request(`/api/projects/${otherSlug}/costs`, {
			headers: authHeader(token),
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.data.entries.length).toBe(0);
		expect(body.data.total_cents).toBe(0);
	});
});

describe('costs – task_id filter', () => {
	it('returns only entries linked to the specified task', async () => {
		const res = await app.request(`/api/projects/${projectSlug}/costs?task_id=${taskId}`, {
			headers: authHeader(token),
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		// Only "past entry" (50) has task_id set
		expect(body.data.entries.length).toBe(1);
		expect(body.data.entries[0].task_id).toBe(taskId);
		expect(body.data.total_cents).toBe(50);
	});
});

describe('costs – group_by=day', () => {
	it('groups cost entries by day with correct totals', async () => {
		const res = await app.request(`/api/projects/${projectSlug}/costs?group_by=day`, {
			headers: authHeader(token),
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.data.summary).toBeDefined();
		// We have 4 entries across 4 distinct days
		expect(body.data.summary.length).toBe(4);
		// Days are ordered ascending
		const days = body.data.summary.map((r: any) => r.day);
		expect(days).toEqual([...days].sort());
		// Regression: `day` must be a date-only "YYYY-MM-DD" string, never a full ISO
		// timestamp. A Postgres `date` deserializes to a JS Date that c.json() renders as
		// "2024-01-15T00:00:00.000Z", which the chart can't parse (new Date(`${day}T00:00:00Z`)
		// => Invalid Date). The route casts `::date::text` to keep it date-only.
		for (const d of days) expect(d).toMatch(/^\d{4}-\d{2}-\d{2}$/);
		expect(days).toEqual(['2024-01-15', '2024-01-20', '2024-02-10', '2024-03-01']);
		// Total across all days
		expect(body.data.total_cents).toBe(275); // 50+75+120+30
	});

	it('group_by=day with date range returns subset', async () => {
		const res = await app.request(
			`/api/projects/${projectSlug}/costs?group_by=day&from=2024-02-01&to=2024-03-31`,
			{ headers: authHeader(token) },
		);
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.data.summary.length).toBe(2);
		expect(body.data.total_cents).toBe(150); // 120+30
	});
});

describe('costs – group_by=day&breakdown=agent', () => {
	it('returns per-day spend split by agent', async () => {
		const res = await app.request(
			`/api/projects/${projectSlug}/costs?group_by=day&breakdown=agent`,
			{ headers: authHeader(token) },
		);
		expect(res.status).toBe(200);
		const body = await res.json();
		const rows: any[] = body.data.summary;
		// 4 (day, agent) cells; each row carries the agent's title.
		expect(rows.length).toBe(4);
		for (const r of rows) expect(typeof r.agent_title).toBe('string');
		// `day` stays a date-only string in the breakdown too (chart parses it as such).
		for (const r of rows) expect(r.day).toMatch(/^\d{4}-\d{2}-\d{2}$/);

		const byAgent = (id: string) =>
			rows.filter((r) => r.agent_id === id).reduce((s, r) => s + r.total_cents, 0);
		expect(byAgent(agentId)).toBe(155); // 50 + 75 + 30
		expect(byAgent(agent2Id)).toBe(120);
		expect(body.data.total_cents).toBe(275);
	});
});

describe('costs – group_by=day&breakdown=adapter', () => {
	it('returns per-day spend split by AI adapter config', async () => {
		const res = await app.request(
			`/api/projects/${projectSlug}/costs?group_by=day&breakdown=adapter`,
			{ headers: authHeader(token) },
		);
		expect(res.status).toBe(200);
		const body = await res.json();
		const rows: any[] = body.data.summary;
		// `day` stays a date-only string in the breakdown too (chart parses it as such).
		for (const r of rows) expect(r.day).toMatch(/^\d{4}-\d{2}-\d{2}$/);

		const byConfig = (id: string | null) =>
			rows.filter((r) => r.ai_provider_config_id === id).reduce((s, r) => s + r.total_cents, 0);
		expect(byConfig(anthropicConfigId)).toBe(125); // 50 + 75
		expect(byConfig(openaiConfigId)).toBe(120);
		expect(byConfig(null)).toBe(30); // unattributed

		const anthropicRow = rows.find((r) => r.ai_provider_config_id === anthropicConfigId);
		expect(anthropicRow.adapter_label).toBe('Anthropic Prod');
		expect(anthropicRow.provider).toBe('anthropic');
		expect(body.data.total_cents).toBe(275);
	});
});

describe('costs – POST validation', () => {
	it('returns 400 when member_id is missing', async () => {
		const res = await app.request(`/api/projects/${projectSlug}/costs`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ amount_cents: 100 }),
		});
		expect(res.status).toBe(400);
		const body = await res.json();
		expect(body.error.code).toBe('INVALID_REQUEST');
	});

	it('returns 400 when amount_cents is zero', async () => {
		const res = await app.request(`/api/projects/${projectSlug}/costs`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ member_id: agentId, amount_cents: 0 }),
		});
		expect(res.status).toBe(400);
		const body = await res.json();
		expect(body.error.code).toBe('INVALID_REQUEST');
	});

	it('returns 400 when amount_cents is negative', async () => {
		const res = await app.request(`/api/projects/${projectSlug}/costs`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ member_id: agentId, amount_cents: -50 }),
		});
		expect(res.status).toBe(400);
		const body = await res.json();
		expect(body.error.code).toBe('INVALID_REQUEST');
	});

	it('returns 400 when amount_cents is missing', async () => {
		const res = await app.request(`/api/projects/${projectSlug}/costs`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ member_id: agentId }),
		});
		expect(res.status).toBe(400);
		const body = await res.json();
		expect(body.error.code).toBe('INVALID_REQUEST');
	});
});
