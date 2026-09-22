import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../src/db/database';
import type { Env } from '../src/lib/types';
import { safeClose } from './helpers';
import { authHeader, createTestApp, createTestTeam, projectSlugForTeamSlug } from './helpers/app';

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

/** A usage row for the engineer in the team's project, as a finished run records one. */
async function seedUsage(inputTokens: number, outputTokens = 0): Promise<string> {
	const slug = await projectSlugForTeamSlug(db, teamSlug);
	const r = await db.query<{ id: string }>(
		`INSERT INTO usage_entries (member_id, project_id, input_tokens, output_tokens, description)
		 SELECT $1, p.id, $2, $3, 'Agent run' FROM projects p WHERE p.slug = $4
		 RETURNING id`,
		[agentId, inputTokens, outputTokens, slug],
	);
	return r.rows[0].id;
}

async function getUsage(query = ''): Promise<Record<string, any>> {
	const slug = await projectSlugForTeamSlug(db, teamSlug);
	const res = await app.request(`/api/projects/${slug}/usage${query}`, {
		headers: authHeader(token),
	});
	expect(res.status).toBe(200);
	return (await res.json()).data;
}

describe('usage reads', () => {
	it('lists usage entries with input, output and total tokens', async () => {
		const before = await getUsage();
		await seedUsage(40, 60);
		const after = await getUsage();
		expect(after.entries.length).toBeGreaterThanOrEqual(1);
		expect(after.input_tokens - before.input_tokens).toBe(40);
		expect(after.output_tokens - before.output_tokens).toBe(60);
		expect(after.total_tokens - before.total_tokens).toBe(100);
	});

	it('groups usage by agent', async () => {
		await seedUsage(100);
		const data = await getUsage('?group_by=agent');
		expect(data.summary.length).toBeGreaterThanOrEqual(1);
		expect(data.total_tokens).toBeGreaterThan(0);
	});

	it('has no write route: usage is recorded by runs and chat turns only', async () => {
		const slug = await projectSlugForTeamSlug(db, teamSlug);
		const res = await app.request(`/api/projects/${slug}/usage`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ member_id: agentId, input_tokens: 100 }),
		});
		expect(res.status).toBe(404);
	});

	it('pages the entries by cursor while the totals cover every entry', async () => {
		await seedUsage(10);
		await seedUsage(20);
		const all = await getUsage();
		expect(all.entries.length).toBeGreaterThanOrEqual(2);

		const first = await getUsage('?limit=1');
		expect(first.entries).toHaveLength(1);
		expect(first.has_more).toBe(true);
		expect(first.total_tokens).toBe(all.total_tokens);

		const second = await getUsage(`?limit=1&cursor=${encodeURIComponent(first.next_cursor)}`);
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
