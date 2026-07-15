import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authHeader } from './helpers/app';
import { createTestContext, destroyTestContext, type ServerTestContext } from './helpers/context';

const NIL_UUID = '00000000-0000-0000-0000-000000000000';

let ctx: ServerTestContext;
let token: string;
let engineerTypeId: string;
let architectTypeId: string;

function jsonHeaders(t: string) {
	return { ...authHeader(t), 'Content-Type': 'application/json' };
}

beforeAll(async () => {
	ctx = await createTestContext();
	token = ctx.token;

	const types = await ctx.db.query<{ id: string; slug: string }>(
		`SELECT id, slug FROM agent_types WHERE slug IN ('engineer', 'architect')`,
	);
	engineerTypeId = types.rows.find((r) => r.slug === 'engineer')?.id as string;
	architectTypeId = types.rows.find((r) => r.slug === 'architect')?.id as string;
	expect(engineerTypeId).toBeTruthy();
	expect(architectTypeId).toBeTruthy();
});

afterAll(async () => {
	await destroyTestContext(ctx);
});

describe('GET /api/team-templates', () => {
	it('lists templates with aggregated agent_types and orders Blank last', async () => {
		const res = await ctx.app.request('/api/team-templates', { headers: authHeader(token) });
		expect(res.status).toBe(200);
		const data = (await res.json()).data as Array<Record<string, unknown>>;
		expect(data.length).toBeGreaterThanOrEqual(2);

		const startup = data.find((t) => t.name === 'Startup');
		expect(startup).toBeDefined();
		// Startup now comes from the marketplace (a non-builtin template); Blank is the
		// only surviving built-in template.
		expect(startup?.is_builtin).toBe(false);
		const agentTypes = startup?.agent_types as Array<Record<string, unknown>>;
		expect(agentTypes.length).toBeGreaterThanOrEqual(1);
		expect(agentTypes[0]).toHaveProperty('agent_type_id');
		expect(agentTypes[0]).toHaveProperty('slug');
		expect(agentTypes[0]).toHaveProperty('system_prompt');

		// ORDER BY (name = 'Blank') ASC pushes Blank to the very end.
		expect(data[data.length - 1].name).toBe('Blank');
	});
});

describe('POST /api/team-templates', () => {
	it('rejects a missing or blank name', async () => {
		const missing = await ctx.app.request('/api/team-templates', {
			method: 'POST',
			headers: jsonHeaders(token),
			body: JSON.stringify({ description: 'no name' }),
		});
		expect(missing.status).toBe(400);

		const blank = await ctx.app.request('/api/team-templates', {
			method: 'POST',
			headers: jsonHeaders(token),
			body: JSON.stringify({ name: '   ' }),
		});
		expect(blank.status).toBe(400);
	});

	it('creates a template with defaults when only a name is given', async () => {
		const res = await ctx.app.request('/api/team-templates', {
			method: 'POST',
			headers: jsonHeaders(token),
			body: JSON.stringify({ name: 'Minimal Fill Type' }),
		});
		expect(res.status).toBe(201);
		const data = (await res.json()).data;
		expect(data.name).toBe('Minimal Fill Type');
		expect(data.description).toBe('');
		expect(data.is_builtin).toBe(false);
		expect(data.agent_types).toEqual([]);
		expect(data.skills_config).toEqual([]);
		expect(data.preferences_config).toEqual({});
		expect(data.mcp_servers).toEqual([]);
		expect(data.mpp_config).toEqual({ enabled: false });
	});

	it('creates a template with a roster and returns it fully hydrated', async () => {
		const res = await ctx.app.request('/api/team-templates', {
			method: 'POST',
			headers: jsonHeaders(token),
			body: JSON.stringify({
				name: 'Roster Fill Type',
				description: 'Two roles',
				agent_types: [
					{ agent_type_id: architectTypeId, sort_order: 0 },
					{ agent_type_id: engineerTypeId, reports_to_slug: 'architect', sort_order: 1 },
				],
				skills_config: [{ slug: 'deploys' }],
				preferences_config: { tone: 'direct' },
				mpp_config: { enabled: true },
			}),
		});
		expect(res.status).toBe(201);
		const data = (await res.json()).data;
		expect(data.description).toBe('Two roles');
		expect(data.mpp_config).toEqual({ enabled: true });
		expect(data.preferences_config).toEqual({ tone: 'direct' });

		const roster = data.agent_types as Array<Record<string, unknown>>;
		expect(roster).toHaveLength(2);
		// Ordered by sort_order.
		expect(roster[0].slug).toBe('architect');
		expect(roster[1].slug).toBe('engineer');
		expect(roster[1].reports_to_slug).toBe('architect');

		const joins = await ctx.db.query(
			'SELECT 1 FROM team_template_agent_types WHERE team_template_id = $1',
			[data.id],
		);
		expect(joins.rows).toHaveLength(2);
	});
});

describe('GET /api/team-templates/:id', () => {
	it('returns a single template with its roster', async () => {
		const startup = await ctx.db.query<{ id: string }>(
			"SELECT id FROM team_templates WHERE name = 'Startup'",
		);
		const res = await ctx.app.request(`/api/team-templates/${startup.rows[0].id}`, {
			headers: authHeader(token),
		});
		expect(res.status).toBe(200);
		const data = (await res.json()).data;
		expect(data.name).toBe('Startup');
		expect((data.agent_types as unknown[]).length).toBeGreaterThanOrEqual(1);
	});

	it('404s on an unknown id', async () => {
		const res = await ctx.app.request(`/api/team-templates/${NIL_UUID}`, {
			headers: authHeader(token),
		});
		expect(res.status).toBe(404);
	});
});

describe('PATCH /api/team-templates/:id', () => {
	let customId: string;

	beforeAll(async () => {
		const res = await ctx.app.request('/api/team-templates', {
			method: 'POST',
			headers: jsonHeaders(token),
			body: JSON.stringify({
				name: 'Patchable Fill Type',
				description: 'before',
				agent_types: [{ agent_type_id: engineerTypeId, sort_order: 0 }],
			}),
		});
		customId = (await res.json()).data.id;
	});

	it('404s on an unknown id', async () => {
		const res = await ctx.app.request(`/api/team-templates/${NIL_UUID}`, {
			method: 'PATCH',
			headers: jsonHeaders(token),
			body: JSON.stringify({ name: 'Nope' }),
		});
		expect(res.status).toBe(404);
	});

	it('updates scalar and jsonb fields', async () => {
		const res = await ctx.app.request(`/api/team-templates/${customId}`, {
			method: 'PATCH',
			headers: jsonHeaders(token),
			body: JSON.stringify({
				name: 'Patched Fill Type',
				description: 'after',
				skills_config: [{ slug: 'sre' }],
				preferences_config: { verbosity: 'low' },
				mcp_servers: [{ url: 'https://mcp.example.com' }],
				mpp_config: { enabled: true },
			}),
		});
		expect(res.status).toBe(200);
		const data = (await res.json()).data;
		expect(data.name).toBe('Patched Fill Type');
		expect(data.description).toBe('after');
		expect(data.skills_config).toEqual([{ slug: 'sre' }]);
		expect(data.preferences_config).toEqual({ verbosity: 'low' });
		expect(data.mcp_servers).toEqual([{ url: 'https://mcp.example.com' }]);
		expect(data.mpp_config).toEqual({ enabled: true });
		// Roster untouched when agent_types is omitted.
		expect((data.agent_types as unknown[]).length).toBe(1);
	});

	it('replaces the roster when agent_types is provided', async () => {
		const res = await ctx.app.request(`/api/team-templates/${customId}`, {
			method: 'PATCH',
			headers: jsonHeaders(token),
			body: JSON.stringify({
				agent_types: [
					{ agent_type_id: architectTypeId, sort_order: 0 },
					{ agent_type_id: engineerTypeId, reports_to_slug: 'architect', sort_order: 1 },
				],
			}),
		});
		expect(res.status).toBe(200);
		const roster = (await res.json()).data.agent_types as Array<Record<string, unknown>>;
		expect(roster).toHaveLength(2);
		expect(roster.map((r) => r.slug)).toEqual(['architect', 'engineer']);
	});

	it('clears the roster with an empty agent_types array', async () => {
		const res = await ctx.app.request(`/api/team-templates/${customId}`, {
			method: 'PATCH',
			headers: jsonHeaders(token),
			body: JSON.stringify({ agent_types: [] }),
		});
		expect(res.status).toBe(200);
		expect((await res.json()).data.agent_types).toEqual([]);

		const joins = await ctx.db.query(
			'SELECT 1 FROM team_template_agent_types WHERE team_template_id = $1',
			[customId],
		);
		expect(joins.rows).toHaveLength(0);
	});

	it('returns the template unchanged for an empty patch body', async () => {
		const res = await ctx.app.request(`/api/team-templates/${customId}`, {
			method: 'PATCH',
			headers: jsonHeaders(token),
			body: JSON.stringify({}),
		});
		expect(res.status).toBe(200);
		expect((await res.json()).data.name).toBe('Patched Fill Type');
	});
});

describe('DELETE /api/team-templates/:id', () => {
	it('404s on an unknown id', async () => {
		const res = await ctx.app.request(`/api/team-templates/${NIL_UUID}`, {
			method: 'DELETE',
			headers: authHeader(token),
		});
		expect(res.status).toBe(404);
	});

	it('refuses to delete a built-in template', async () => {
		const startup = await ctx.db.query<{ id: string }>(
			'SELECT id FROM team_templates WHERE is_builtin = true LIMIT 1',
		);
		const res = await ctx.app.request(`/api/team-templates/${startup.rows[0].id}`, {
			method: 'DELETE',
			headers: authHeader(token),
		});
		expect(res.status).toBe(403);
	});

	it('deletes a custom template', async () => {
		const created = await ctx.app.request('/api/team-templates', {
			method: 'POST',
			headers: jsonHeaders(token),
			body: JSON.stringify({ name: 'Disposable Fill Type' }),
		});
		const id = (await created.json()).data.id;

		const res = await ctx.app.request(`/api/team-templates/${id}`, {
			method: 'DELETE',
			headers: authHeader(token),
		});
		expect(res.status).toBe(200);

		const gone = await ctx.app.request(`/api/team-templates/${id}`, {
			headers: authHeader(token),
		});
		expect(gone.status).toBe(404);
	});
});
