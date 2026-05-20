import type { PGlite } from '@electric-sql/pglite';
import type { Hono } from 'hono';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../../lib/types';
import { safeClose } from '../helpers';
import { authHeader, createTestApp } from '../helpers/app';

let app: Hono<Env>;
let db: PGlite;
let token: string;

const originalFetch = globalThis.fetch;

beforeAll(async () => {
	const ctx = await createTestApp();
	app = ctx.app;
	db = ctx.db;
	token = ctx.token;
});

beforeEach(async () => {
	globalThis.fetch = vi.fn().mockResolvedValue({ ok: true }) as unknown as typeof fetch;
	await db.query('DELETE FROM ai_provider_configs');
	await db.query('DELETE FROM teams');
});

afterEach(() => {
	globalThis.fetch = originalFetch;
});

afterAll(async () => {
	await safeClose(db);
});

describe('onboarding team auto-create', () => {
	it('creates default Team from Blank template when the first provider is added', async () => {
		const teamsBefore = await app.request('/api/teams', { headers: authHeader(token) });
		expect((await teamsBefore.json()).data).toEqual([]);

		const res = await app.request('/api/ai-providers', {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				provider: 'anthropic',
				api_key: 'sk-ant-onboarding-team-key',
				label: 'onboarding-primary',
			}),
		});
		expect(res.status).toBe(201);

		const teamsAfter = await app.request('/api/teams', { headers: authHeader(token) });
		const teams = (await teamsAfter.json()).data as Array<{
			name: string;
			slug: string;
			agent_count: number;
		}>;
		expect(teams).toHaveLength(1);
		expect(teams[0].name).toBe('Team');
		expect(teams[0].slug).toBe('team');
		expect(teams[0].agent_count).toBe(2);

		const agentsRes = await app.request(`/api/teams/${teams[0].slug}/agents`, {
			headers: authHeader(token),
		});
		const slugs = ((await agentsRes.json()).data as Array<{ slug: string }>)
			.map((a) => a.slug)
			.sort();
		expect(slugs).toEqual(['captain', 'coach']);

		const intakeRes = await app.request(`/api/teams/${teams[0].slug}/requirements-intake`, {
			headers: authHeader(token),
		});
		expect(intakeRes.status).toBe(200);
		const intake = (await intakeRes.json()).data as {
			issue_identifier: string;
			captain_greeting: string;
		};
		expect(intake.issue_identifier).toMatch(/^OP-\d+$/);
		expect(intake.captain_greeting).toContain('Captain');
	});

	it('does not create another team when a second provider is added', async () => {
		await app.request('/api/ai-providers', {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				provider: 'anthropic',
				api_key: 'sk-ant-onboarding-first',
				label: 'first',
			}),
		});

		const res = await app.request('/api/ai-providers', {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				provider: 'openai',
				api_key: 'sk-openai-second-provider',
				label: 'openai-secondary',
			}),
		});
		expect(res.status).toBe(201);

		const teamsRes = await app.request('/api/teams', { headers: authHeader(token) });
		expect((await teamsRes.json()).data).toHaveLength(1);
	});
});
