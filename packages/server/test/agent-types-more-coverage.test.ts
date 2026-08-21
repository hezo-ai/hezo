import { DEFAULT_MONTHLY_BUDGET_CENTS } from '@hezo/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authHeader } from './helpers/app';
import { createTestContext, destroyTestContext, type ServerTestContext } from './helpers/context';

/**
 * Coverage suite for packages/server/src/routes/agent-types.ts: catalog listing
 * (with source filters), custom-type creation and validation, fetch-by-id,
 * PATCH field handling incl. the builtin field restrictions, and delete rules.
 */

let ctx: ServerTestContext;

const json = () => ({ ...authHeader(ctx.token), 'Content-Type': 'application/json' });

async function createCustomType(
	overrides: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
	const res = await ctx.app.request('/api/agent-types', {
		method: 'POST',
		headers: json(),
		body: JSON.stringify({ name: 'Custom Analyst', ...overrides }),
	});
	expect(res.status).toBe(201);
	return (await res.json()).data;
}

beforeAll(async () => {
	ctx = await createTestContext();
});

afterAll(async () => {
	await destroyTestContext(ctx);
});

describe('GET /agent-types', () => {
	it('lists the catalog with builtins first and never the CEO', async () => {
		const res = await ctx.app.request('/api/agent-types', { headers: authHeader(ctx.token) });
		expect(res.status).toBe(200);
		const types = (await res.json()).data as Array<Record<string, unknown>>;
		expect(types.length).toBeGreaterThan(0);
		expect(types.some((t) => t.slug === 'ceo')).toBe(false);
		// Builtins sort before customs.
		const firstCustomIdx = types.findIndex((t) => !t.is_builtin);
		if (firstCustomIdx !== -1) {
			expect(types.slice(firstCustomIdx).every((t) => !t.is_builtin)).toBe(true);
		}
	});

	it('filters by a comma-separated source list', async () => {
		await createCustomType({ name: 'Sourced Type' });
		const res = await ctx.app.request('/api/agent-types?source=custom', {
			headers: authHeader(ctx.token),
		});
		expect(res.status).toBe(200);
		const types = (await res.json()).data as Array<Record<string, unknown>>;
		expect(types.length).toBeGreaterThan(0);
		expect(types.every((t) => t.source === 'custom')).toBe(true);

		const both = await ctx.app.request('/api/agent-types?source=custom,builtin', {
			headers: authHeader(ctx.token),
		});
		expect(both.status).toBe(200);
		const all = (await both.json()).data as Array<Record<string, unknown>>;
		expect(all.some((t) => t.source === 'builtin')).toBe(true);
		expect(all.some((t) => t.source === 'custom')).toBe(true);
	});
});

describe('POST /agent-types', () => {
	it('rejects a missing name', async () => {
		const res = await ctx.app.request('/api/agent-types', {
			method: 'POST',
			headers: json(),
			body: JSON.stringify({ name: '   ' }),
		});
		expect(res.status).toBe(400);
		expect((await res.json()).error.message).toContain('name is required');
	});

	it('rejects a name that yields no valid slug', async () => {
		const res = await ctx.app.request('/api/agent-types', {
			method: 'POST',
			headers: json(),
			body: JSON.stringify({ name: '!!!' }),
		});
		expect(res.status).toBe(400);
		expect((await res.json()).error.message).toContain('slug');
	});

	it('creates a custom type with defaults and a generated slug', async () => {
		const created = await createCustomType({ name: 'Growth Hacker' });
		expect(created.slug).toBe('growth-hacker');
		expect(created.source).toBe('custom');
		expect(created.is_builtin).toBe(false);
		expect(created.run_timeout_min).toBe(60);
		expect(created.monthly_budget_cents).toBe(DEFAULT_MONTHLY_BUDGET_CENTS);
		expect(created.touches_code).toBe(false);
	});

	it('honours an explicit slug and field values', async () => {
		const created = await createCustomType({
			name: 'Ops Person',
			slug: 'ops-custom',
			description: 'desc',
			role_description: 'role',
			system_prompt_template: 'prompt',
			heartbeat_interval_min: 120,
			run_timeout_min: 30,
			monthly_budget_cents: 9000,
			touches_code: true,
		});
		expect(created.slug).toBe('ops-custom');
		expect(created.description).toBe('desc');
		expect(created.role_description).toBe('role');
		expect(created.system_prompt_template).toBe('prompt');
		expect(created.heartbeat_interval_min).toBe(120);
		expect(created.run_timeout_min).toBe(30);
		expect(created.monthly_budget_cents).toBe(9000);
		expect(created.touches_code).toBe(true);
	});
});

describe('GET /agent-types/:id', () => {
	it('404s for an unknown id', async () => {
		const res = await ctx.app.request('/api/agent-types/00000000-0000-4000-8000-000000000000', {
			headers: authHeader(ctx.token),
		});
		expect(res.status).toBe(404);
	});

	it('returns a type by id', async () => {
		const created = await createCustomType({ name: 'Fetch Me' });
		const res = await ctx.app.request(`/api/agent-types/${created.id}`, {
			headers: authHeader(ctx.token),
		});
		expect(res.status).toBe(200);
		expect((await res.json()).data.id).toBe(created.id);
	});
});

describe('PATCH /agent-types/:id', () => {
	it('404s for an unknown id', async () => {
		const res = await ctx.app.request('/api/agent-types/00000000-0000-4000-8000-000000000000', {
			method: 'PATCH',
			headers: json(),
			body: JSON.stringify({ name: 'X' }),
		});
		expect(res.status).toBe(404);
	});

	it('updates every editable field on a custom type', async () => {
		const created = await createCustomType({ name: 'Editable Type' });
		const res = await ctx.app.request(`/api/agent-types/${created.id}`, {
			method: 'PATCH',
			headers: json(),
			body: JSON.stringify({
				name: '  Edited Type  ',
				description: 'new desc',
				role_description: 'new role',
				system_prompt_template: 'new prompt',
				heartbeat_interval_min: 240,
				run_timeout_min: 15,
				monthly_budget_cents: 500,
			}),
		});
		expect(res.status).toBe(200);
		const updated = (await res.json()).data;
		expect(updated.name).toBe('Edited Type');
		expect(updated.description).toBe('new desc');
		expect(updated.role_description).toBe('new role');
		expect(updated.system_prompt_template).toBe('new prompt');
		expect(updated.heartbeat_interval_min).toBe(240);
		expect(updated.run_timeout_min).toBe(15);
		expect(updated.monthly_budget_cents).toBe(500);
	});

	it('ignores schedule/budget fields on a builtin type but applies prose edits', async () => {
		const list = await ctx.app.request('/api/agent-types?source=builtin', {
			headers: authHeader(ctx.token),
		});
		const builtin = ((await list.json()).data as Array<Record<string, unknown>>)[0];
		const res = await ctx.app.request(`/api/agent-types/${builtin.id}`, {
			method: 'PATCH',
			headers: json(),
			body: JSON.stringify({
				description: 'builtin desc edit',
				heartbeat_interval_min: 777,
				run_timeout_min: 777,
				monthly_budget_cents: 777,
			}),
		});
		expect(res.status).toBe(200);
		const updated = (await res.json()).data;
		expect(updated.description).toBe('builtin desc edit');
		expect(updated.heartbeat_interval_min).toBe(builtin.heartbeat_interval_min);
		expect(updated.run_timeout_min).toBe(builtin.run_timeout_min);
		expect(updated.monthly_budget_cents).toBe(builtin.monthly_budget_cents);
	});

	it('returns the row unchanged when no editable fields are supplied', async () => {
		const created = await createCustomType({ name: 'Untouched Type' });
		const res = await ctx.app.request(`/api/agent-types/${created.id}`, {
			method: 'PATCH',
			headers: json(),
			body: JSON.stringify({}),
		});
		expect(res.status).toBe(200);
		expect((await res.json()).data.name).toBe('Untouched Type');
	});
});

describe('DELETE /agent-types/:id', () => {
	it('404s for an unknown id', async () => {
		const res = await ctx.app.request('/api/agent-types/00000000-0000-4000-8000-000000000000', {
			method: 'DELETE',
			headers: authHeader(ctx.token),
		});
		expect(res.status).toBe(404);
	});

	it('refuses to delete a builtin type', async () => {
		const list = await ctx.app.request('/api/agent-types?source=builtin', {
			headers: authHeader(ctx.token),
		});
		const builtin = ((await list.json()).data as Array<Record<string, unknown>>)[0];
		const res = await ctx.app.request(`/api/agent-types/${builtin.id}`, {
			method: 'DELETE',
			headers: authHeader(ctx.token),
		});
		expect(res.status).toBe(403);
		expect((await res.json()).error.code).toBe('FORBIDDEN');
	});

	it('deletes a custom type', async () => {
		const created = await createCustomType({ name: 'Deletable Type' });
		const res = await ctx.app.request(`/api/agent-types/${created.id}`, {
			method: 'DELETE',
			headers: authHeader(ctx.token),
		});
		expect(res.status).toBe(200);
		expect((await res.json()).data).toBeNull();

		const gone = await ctx.db.query('SELECT 1 FROM agent_types WHERE id = $1', [created.id]);
		expect(gone.rows).toHaveLength(0);
	});
});
