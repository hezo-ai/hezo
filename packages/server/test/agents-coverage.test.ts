import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../src/db/database';
import { appendRunLogChunks } from '../src/db/run-log-chunks';
import type { Env } from '../src/lib/types';
import { signAgentJwt } from '../src/middleware/auth';
import { safeClose } from './helpers';
import {
	authHeader,
	createAgentRun,
	createTestApp,
	createTestTeam,
	projectSlugFor,
} from './helpers/app';

/**
 * Branch-coverage tests for packages/server/src/routes/agents.ts. Targets
 * validation / 4xx / not-found / conflict paths the happy-path suites
 * (agents.test.ts, agents-extended.test.ts) don't reach: create-agent input
 * validation, system-prompt restore/revisions/preview 404s, the system-prompts
 * batch error matrix, PATCH validation edges, and the heartbeat-run
 * fetch/terminate not-found + conflict branches.
 */

let app: Hono<Env>;
let db: Db;
let token: string;
let masterKeyManager: Awaited<ReturnType<typeof createTestApp>>['masterKeyManager'];
let teamId: string;
let projectSlug: string;

async function listAgents(): Promise<Array<Record<string, unknown>>> {
	const res = await app.request(`/api/projects/${projectSlug}/agents`, {
		headers: authHeader(token),
	});
	return (await res.json()).data;
}

async function findAgent(slug: string): Promise<Record<string, unknown>> {
	const agents = await listAgents();
	const agent = agents.find((a) => a.slug === slug);
	if (!agent) throw new Error(`agent ${slug} not found`);
	return agent;
}

beforeAll(async () => {
	const ctx = await createTestApp();
	app = ctx.app;
	db = ctx.db;
	token = ctx.token;
	masterKeyManager = ctx.masterKeyManager;

	const typesRes = await app.request('/api/team-templates', { headers: authHeader(token) });
	const typeId = (await typesRes.json()).data.find(
		(t: Record<string, unknown>) => t.name === 'App Team',
	).id;

	const teamRes = await createTestTeam(db, { name: 'Agents Coverage Co', template_id: typeId });
	teamId = (await teamRes.json()).data.id;
	projectSlug = await projectSlugFor(db, teamId);
});

afterAll(async () => {
	await safeClose(db);
});

describe('POST /agents validation', () => {
	function post(body: Record<string, unknown>) {
		return app.request(`/api/projects/${projectSlug}/agents`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify(body),
		});
	}

	it('rejects a missing/blank title with 400', async () => {
		const res = await post({ title: '   ' });
		expect(res.status).toBe(400);
		expect((await res.json()).error.code).toBe('INVALID_REQUEST');
	});

	it('rejects an invalid default_effort with 400', async () => {
		const res = await post({ title: 'Effort Bot', default_effort: 'turbo' });
		expect(res.status).toBe(400);
		const body = await res.json();
		expect(body.error.code).toBe('INVALID_REQUEST');
		expect(body.error.message).toContain('default_effort');
	});

	it('rejects an incoherent budget trio with 400', async () => {
		// daily > weekly is a cross-window violation (0 = unlimited, so use non-zero).
		const res = await post({
			title: 'Budget Bot',
			daily_budget_cents: 5000,
			weekly_budget_cents: 100,
			monthly_budget_cents: 100,
		});
		expect(res.status).toBe(400);
		expect((await res.json()).error.code).toBe('INVALID_REQUEST');
	});

	it('rejects a system_prompt missing required substitution variables', async () => {
		const res = await post({ title: 'Prompt Bot', system_prompt: 'just some text, no vars' });
		expect(res.status).toBe(400);
		const body = await res.json();
		expect(body.error.message).toMatch(/substitution variable/i);
	});

	it('rejects a reserved slug (admin)', async () => {
		const res = await post({ title: 'Admin' });
		expect(res.status).toBe(400);
		expect((await res.json()).error.message).toMatch(/reserved/i);
	});

	it('returns 404 when the resolved team no longer exists', async () => {
		// Build a project that points at a team, then delete the team out from under
		// it so the POST handler's team existence check fails. Use a throwaway team.
		const throwaway = await createTestTeam(db, { name: 'Doomed Team Co' });
		const tId = (await throwaway.json()).data.id;
		const slug = await projectSlugFor(db, tId);
		// Drop the team's members + project FK chain, then the team row.
		await db.query('DELETE FROM tasks WHERE team_id = $1', [tId]);
		await db.query('DELETE FROM projects WHERE team_id = $1', [tId]);
		await db.query(
			'DELETE FROM member_agents WHERE id IN (SELECT id FROM members WHERE team_id = $1)',
			[tId],
		);
		await db.query('DELETE FROM members WHERE team_id = $1', [tId]);
		// The project is gone, so requireProjectAccess will 404 before the handler.
		const res = await app.request(`/api/projects/${slug}/agents`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ title: 'X' }),
		});
		expect(res.status).toBe(404);
	});
});

describe('system-prompt revisions / restore / preview 404s', () => {
	it('GET system-prompt 404s for an unknown agent', async () => {
		const res = await app.request(`/api/projects/${projectSlug}/agents/no-such/system-prompt`, {
			headers: authHeader(token),
		});
		expect(res.status).toBe(404);
	});

	it('GET revisions 404s for an unknown agent', async () => {
		const res = await app.request(
			`/api/projects/${projectSlug}/agents/no-such/system-prompt/revisions`,
			{ headers: authHeader(token) },
		);
		expect(res.status).toBe(404);
	});

	it('GET revisions returns the revision list for a real agent', async () => {
		const captain = await findAgent('captain');
		const res = await app.request(
			`/api/projects/${projectSlug}/agents/${captain.id}/system-prompt/revisions`,
			{ headers: authHeader(token) },
		);
		expect(res.status).toBe(200);
		expect(Array.isArray((await res.json()).data)).toBe(true);
	});

	it('restore 404s for an unknown agent', async () => {
		const res = await app.request(
			`/api/projects/${projectSlug}/agents/no-such/system-prompt/restore`,
			{
				method: 'POST',
				headers: { ...authHeader(token), 'Content-Type': 'application/json' },
				body: JSON.stringify({ revision_number: 1 }),
			},
		);
		expect(res.status).toBe(404);
	});

	it('restore rejects a non-numeric revision_number with 400', async () => {
		const captain = await findAgent('captain');
		const res = await app.request(
			`/api/projects/${projectSlug}/agents/${captain.id}/system-prompt/restore`,
			{
				method: 'POST',
				headers: { ...authHeader(token), 'Content-Type': 'application/json' },
				body: JSON.stringify({}),
			},
		);
		expect(res.status).toBe(400);
		expect((await res.json()).error.message).toMatch(/revision_number/);
	});

	it('restore 404s for an unknown revision number', async () => {
		const captain = await findAgent('captain');
		const res = await app.request(
			`/api/projects/${projectSlug}/agents/${captain.id}/system-prompt/restore`,
			{
				method: 'POST',
				headers: { ...authHeader(token), 'Content-Type': 'application/json' },
				body: JSON.stringify({ revision_number: 99999 }),
			},
		);
		expect(res.status).toBe(404);
	});

	it('restore is forbidden for an agent JWT', async () => {
		const captain = await findAgent('captain');
		const runId = await createAgentRun(db, captain.id as string, teamId);
		const projectRow = await db.query<{ id: string }>('SELECT id FROM projects WHERE slug = $1', [
			projectSlug,
		]);
		const agentToken = await signAgentJwt(
			masterKeyManager,
			captain.id as string,
			teamId,
			runId,
			projectRow.rows[0].id,
			false,
		);
		const res = await app.request(
			`/api/projects/${projectSlug}/agents/${captain.id}/system-prompt/restore`,
			{
				method: 'POST',
				headers: { ...authHeader(agentToken), 'Content-Type': 'application/json' },
				body: JSON.stringify({ revision_number: 1 }),
			},
		);
		expect(res.status).toBe(403);
		expect((await res.json()).error.code).toBe('FORBIDDEN');
	});

	it('preview 404s for an unknown agent', async () => {
		const res = await app.request(
			`/api/projects/${projectSlug}/agents/no-such/system-prompt/preview`,
			{ headers: authHeader(token) },
		);
		expect(res.status).toBe(404);
	});
});

describe('POST system-prompts/batch error matrix', () => {
	function batch(body: Record<string, unknown>) {
		return app.request(`/api/projects/${projectSlug}/agents/system-prompts/batch`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify(body),
		});
	}

	it('rejects a non-array items field', async () => {
		const res = await batch({ items: 'nope' });
		expect(res.status).toBe(400);
		expect((await res.json()).error.message).toMatch(/array/);
	});

	it('rejects an empty items array', async () => {
		const res = await batch({ items: [] });
		expect(res.status).toBe(400);
		expect((await res.json()).error.message).toMatch(/at least one/);
	});

	it('rejects an items array over the limit', async () => {
		const items = Array.from({ length: 51 }, () => ({ agent_id: 'captain' }));
		const res = await batch({ items });
		expect(res.status).toBe(400);
		expect((await res.json()).error.message).toMatch(/may not exceed/);
	});

	it('returns per-item failures for missing agent_id and unknown agent, success for a real one', async () => {
		const res = await batch({
			items: [
				{ agent_id: '' },
				{ agent_id: 'no-such-agent' },
				{ agent_id: 'captain', mode: 'raw' },
			],
		});
		expect(res.status).toBe(200);
		const results = (await res.json()).data as Array<{
			index: number;
			ok: boolean;
			error?: string;
		}>;
		expect(results[0].ok).toBe(false);
		expect(results[0].error).toMatch(/agent_id is required/);
		expect(results[1].ok).toBe(false);
		expect(results[2].ok).toBe(true);
	});

	it('defaults to placeholders mode when an invalid mode is supplied', async () => {
		const res = await batch({ items: [{ agent_id: 'captain', mode: 'bogus' }] });
		expect(res.status).toBe(200);
		const results = (await res.json()).data as Array<{ ok: boolean }>;
		expect(results[0].ok).toBe(true);
	});
});

describe('PATCH /agents validation', () => {
	async function patch(slug: string, body: Record<string, unknown>) {
		const agent = await findAgent(slug);
		return app.request(`/api/projects/${projectSlug}/agents/${agent.id}`, {
			method: 'PATCH',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify(body),
		});
	}

	it('404s for a non-existent agent', async () => {
		const res = await app.request(`/api/projects/${projectSlug}/agents/no-such`, {
			method: 'PATCH',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ title: 'X' }),
		});
		expect(res.status).toBe(404);
	});

	it('rejects an invalid default_effort', async () => {
		const res = await patch('engineer', { default_effort: 'ludicrous' });
		expect(res.status).toBe(400);
		expect((await res.json()).error.message).toContain('default_effort');
	});

	it('rejects a non-string model_override_model', async () => {
		const res = await patch('engineer', { model_override_model: 12345 });
		expect(res.status).toBe(400);
		expect((await res.json()).error.message).toMatch(/model_override_model/);
	});

	it('rejects a model_override_model with no provider stored or supplied', async () => {
		// engineer has no provider override by default.
		const res = await patch('engineer', { model_override_model: 'gpt-5' });
		expect(res.status).toBe(400);
		expect((await res.json()).error.message).toMatch(/requires model_override_provider/);
	});

	it('rejects an unknown model_override_provider', async () => {
		const res = await patch('engineer', { model_override_provider: 'not-a-provider' });
		expect(res.status).toBe(400);
		expect((await res.json()).error.message).toMatch(/model_override_provider/);
	});

	it('rejects an incoherent merged budget trio', async () => {
		const res = await patch('engineer', { daily_budget_cents: 999999, weekly_budget_cents: 1 });
		expect(res.status).toBe(400);
		expect((await res.json()).error.code).toBe('INVALID_REQUEST');
	});

	it('rejects a system_prompt missing required vars for a non-instance agent', async () => {
		const res = await patch('engineer', { system_prompt: 'no template vars here' });
		expect(res.status).toBe(400);
		expect((await res.json()).error.message).toMatch(/substitution variable/i);
	});

	it('clears the model override when provider is set to null (also clears model)', async () => {
		const res = await patch('engineer', { model_override_provider: null });
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.data.model_override_provider).toBeNull();
		expect(body.data.model_override_model).toBeNull();
	});
});

describe('heartbeat-runs not-found / terminate branches', () => {
	it('heartbeat-runs list 404s for an unknown agent', async () => {
		const res = await app.request(`/api/projects/${projectSlug}/agents/no-such/heartbeat-runs`, {
			headers: authHeader(token),
		});
		expect(res.status).toBe(404);
	});

	it('single heartbeat-run 404s for an unknown agent', async () => {
		const res = await app.request(
			`/api/projects/${projectSlug}/agents/no-such/heartbeat-runs/00000000-0000-0000-0000-000000000000`,
			{ headers: authHeader(token) },
		);
		expect(res.status).toBe(404);
	});

	it('single heartbeat-run 404s for an unknown run id on a real agent', async () => {
		const captain = await findAgent('captain');
		const res = await app.request(
			`/api/projects/${projectSlug}/agents/${captain.id}/heartbeat-runs/00000000-0000-0000-0000-000000000000`,
			{ headers: authHeader(token) },
		);
		expect(res.status).toBe(404);
	});

	it('terminate 404s for an unknown agent', async () => {
		const res = await app.request(
			`/api/projects/${projectSlug}/agents/no-such/heartbeat-runs/00000000-0000-0000-0000-000000000000/terminate`,
			{ method: 'POST', headers: authHeader(token) },
		);
		expect(res.status).toBe(404);
	});

	it('terminate 404s for an unknown run id', async () => {
		const captain = await findAgent('captain');
		const res = await app.request(
			`/api/projects/${projectSlug}/agents/${captain.id}/heartbeat-runs/00000000-0000-0000-0000-000000000000/terminate`,
			{ method: 'POST', headers: authHeader(token) },
		);
		expect(res.status).toBe(404);
	});

	it('terminate 409s for a run already in a terminal status', async () => {
		const captain = await findAgent('captain');
		const inserted = await db.query<{ id: string }>(
			`INSERT INTO heartbeat_runs (member_id, team_id, status, started_at, finished_at, exit_code)
			 VALUES ($1, $2, 'succeeded', now() - interval '1 minute', now(), 0)
			 RETURNING id`,
			[captain.id, teamId],
		);
		const runId = inserted.rows[0].id;
		const res = await app.request(
			`/api/projects/${projectSlug}/agents/${captain.id}/heartbeat-runs/${runId}/terminate`,
			{ method: 'POST', headers: authHeader(token) },
		);
		expect(res.status).toBe(409);
		expect((await res.json()).error.message).toMatch(/already succeeded/);
	});

	it('single heartbeat-run returns a real run', async () => {
		const captain = await findAgent('captain');
		const inserted = await db.query<{ id: string }>(
			`INSERT INTO heartbeat_runs (member_id, team_id, status, started_at, finished_at, exit_code)
			 VALUES ($1, $2, 'succeeded', now() - interval '2 minutes', now(), 0)
			 RETURNING id`,
			[captain.id, teamId],
		);
		await appendRunLogChunks(db, inserted.rows[0].id, 'done');
		const res = await app.request(
			`/api/projects/${projectSlug}/agents/${captain.id}/heartbeat-runs/${inserted.rows[0].id}`,
			{ headers: authHeader(token) },
		);
		expect(res.status).toBe(200);
		expect((await res.json()).data.log_text).toBe('done');
	});
});
