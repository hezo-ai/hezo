import { Hono } from 'hono';
import { err, ok } from '../lib/response';
import { toSlug } from '../lib/slug';
import type { Env } from '../lib/types';

export const agentTypesRoutes = new Hono<Env>();

agentTypesRoutes.get('/agent-types', async (c) => {
	const db = c.get('db');
	const source = c.req.query('source');

	let query = 'SELECT * FROM agent_types';
	const params: string[] = [];

	if (source) {
		const sources = source.split(',').map((s) => s.trim());
		const placeholders = sources.map((_, i) => `$${i + 1}::agent_type_source`);
		query += ` WHERE source IN (${placeholders.join(', ')})`;
		params.push(...sources);
	}

	query += ' ORDER BY is_builtin DESC, name ASC';
	const result = await db.query(query, params);
	return ok(c, result.rows);
});

agentTypesRoutes.post('/agent-types', async (c) => {
	const body = await c.req.json<{
		name: string;
		slug?: string;
		description?: string;
		role_description?: string;
		system_prompt_template?: string;
		heartbeat_interval_min?: number;
		monthly_budget_cents?: number;
	}>();

	if (!body.name?.trim()) {
		return err(c, 'INVALID_REQUEST', 'name is required', 400);
	}

	const slug = body.slug?.trim() || toSlug(body.name);
	if (!slug) {
		return err(c, 'INVALID_REQUEST', 'Could not generate a valid slug from name', 400);
	}

	const db = c.get('db');
	const result = await db.query(
		`INSERT INTO agent_types (name, slug, description, role_description, system_prompt_template,
		                          heartbeat_interval_min, monthly_budget_cents,
		                          source)
		 VALUES ($1, $2, $3, $4, $5, $6, $7, 'custom'::agent_type_source)
		 RETURNING *`,
		[
			body.name.trim(),
			slug,
			body.description ?? '',
			body.role_description ?? '',
			body.system_prompt_template ?? '',
			body.heartbeat_interval_min ?? 60,
			body.monthly_budget_cents ?? 3000,
		],
	);

	return ok(c, result.rows[0], 201);
});

agentTypesRoutes.get('/agent-types/:id', async (c) => {
	const db = c.get('db');
	const result = await db.query('SELECT * FROM agent_types WHERE id = $1', [c.req.param('id')]);

	if (result.rows.length === 0) {
		return err(c, 'NOT_FOUND', 'Agent type not found', 404);
	}

	return ok(c, result.rows[0]);
});

agentTypesRoutes.patch('/agent-types/:id', async (c) => {
	const db = c.get('db');
	const id = c.req.param('id');

	const existing = await db.query<{ is_builtin: boolean }>(
		'SELECT is_builtin FROM agent_types WHERE id = $1',
		[id],
	);
	if (existing.rows.length === 0) {
		return err(c, 'NOT_FOUND', 'Agent type not found', 404);
	}

	const body = await c.req.json<{
		name?: string;
		description?: string;
		role_description?: string;
		system_prompt_template?: string;
		heartbeat_interval_min?: number;
		monthly_budget_cents?: number;
	}>();

	const isBuiltin = existing.rows[0].is_builtin;

	const sets: string[] = [];
	const params: unknown[] = [];
	let idx = 1;

	const addField = (field: string, value: unknown, cast?: string) => {
		if (value !== undefined) {
			sets.push(`${field} = $${idx}${cast ? `::${cast}` : ''}`);
			params.push(value);
			idx++;
		}
	};

	addField('name', body.name?.trim());
	addField('description', body.description);
	addField('role_description', body.role_description);
	addField('system_prompt_template', body.system_prompt_template);
	if (!isBuiltin) {
		addField('heartbeat_interval_min', body.heartbeat_interval_min);
		addField('monthly_budget_cents', body.monthly_budget_cents);
	}

	if (sets.length === 0) {
		const full = await db.query('SELECT * FROM agent_types WHERE id = $1', [id]);
		return ok(c, full.rows[0]);
	}

	params.push(id);
	const result = await db.query(
		`UPDATE agent_types SET ${sets.join(', ')} WHERE id = $${idx} RETURNING *`,
		params,
	);

	return ok(c, result.rows[0]);
});

agentTypesRoutes.delete('/agent-types/:id', async (c) => {
	const db = c.get('db');
	const id = c.req.param('id');

	const existing = await db.query<{ is_builtin: boolean }>(
		'SELECT is_builtin FROM agent_types WHERE id = $1',
		[id],
	);

	if (existing.rows.length === 0) {
		return err(c, 'NOT_FOUND', 'Agent type not found', 404);
	}

	if (existing.rows[0].is_builtin) {
		return err(c, 'FORBIDDEN', 'Cannot delete built-in agent types', 403);
	}

	await db.query('DELETE FROM agent_types WHERE id = $1', [id]);
	return c.json({ data: null }, 200);
});
