import { Hono } from 'hono';
import { err, ok } from '../lib/response';
import type { Env } from '../lib/types';

export const companyTypesRoutes = new Hono<Env>();

companyTypesRoutes.get('/company-types', async (c) => {
	const db = c.get('db');
	const result = await db.query('SELECT * FROM company_types ORDER BY is_builtin DESC, name ASC');
	return ok(c, result.rows);
});

companyTypesRoutes.post('/company-types', async (c) => {
	const body = await c.req.json<{
		name: string;
		description?: string;
		agents_config?: unknown[];
		kb_docs_config?: unknown[];
		preferences_config?: Record<string, unknown>;
		mcp_servers?: unknown[];
		mpp_config?: Record<string, unknown>;
	}>();

	if (!body.name?.trim()) {
		return err(c, 'INVALID_REQUEST', 'name is required', 400);
	}

	const db = c.get('db');
	const result = await db.query(
		`INSERT INTO company_types (name, description, agents_config, kb_docs_config, preferences_config, mcp_servers, mpp_config)
     VALUES ($1, $2, $3::jsonb, $4::jsonb, $5::jsonb, $6::jsonb, $7::jsonb)
     RETURNING *`,
		[
			body.name.trim(),
			body.description ?? '',
			JSON.stringify(body.agents_config ?? []),
			JSON.stringify(body.kb_docs_config ?? []),
			JSON.stringify(body.preferences_config ?? {}),
			JSON.stringify(body.mcp_servers ?? []),
			JSON.stringify(body.mpp_config ?? { enabled: false }),
		],
	);

	return ok(c, result.rows[0], 201);
});

companyTypesRoutes.get('/company-types/:id', async (c) => {
	const db = c.get('db');
	const result = await db.query('SELECT * FROM company_types WHERE id = $1', [c.req.param('id')]);

	if (result.rows.length === 0) {
		return err(c, 'NOT_FOUND', 'Company type not found', 404);
	}

	return ok(c, result.rows[0]);
});

companyTypesRoutes.patch('/company-types/:id', async (c) => {
	const db = c.get('db');
	const id = c.req.param('id');

	const existing = await db.query('SELECT * FROM company_types WHERE id = $1', [id]);
	if (existing.rows.length === 0) {
		return err(c, 'NOT_FOUND', 'Company type not found', 404);
	}

	const body = await c.req.json<{
		name?: string;
		description?: string;
		agents_config?: unknown[];
		kb_docs_config?: unknown[];
		preferences_config?: Record<string, unknown>;
		mcp_servers?: unknown[];
		mpp_config?: Record<string, unknown>;
	}>();

	const sets: string[] = [];
	const params: unknown[] = [];
	let idx = 1;

	const addField = (field: string, value: unknown, jsonb = false) => {
		if (value !== undefined) {
			sets.push(`${field} = $${idx}${jsonb ? '::jsonb' : ''}`);
			params.push(jsonb ? JSON.stringify(value) : value);
			idx++;
		}
	};

	addField('name', body.name?.trim());
	addField('description', body.description);
	addField('agents_config', body.agents_config, true);
	addField('kb_docs_config', body.kb_docs_config, true);
	addField('preferences_config', body.preferences_config, true);
	addField('mcp_servers', body.mcp_servers, true);
	addField('mpp_config', body.mpp_config, true);

	if (sets.length === 0) {
		return ok(c, existing.rows[0]);
	}

	params.push(id);
	const result = await db.query(
		`UPDATE company_types SET ${sets.join(', ')}, updated_at = now() WHERE id = $${idx} RETURNING *`,
		params,
	);

	return ok(c, result.rows[0]);
});

companyTypesRoutes.delete('/company-types/:id', async (c) => {
	const db = c.get('db');
	const id = c.req.param('id');

	const existing = await db.query<{ is_builtin: boolean }>(
		'SELECT is_builtin FROM company_types WHERE id = $1',
		[id],
	);

	if (existing.rows.length === 0) {
		return err(c, 'NOT_FOUND', 'Company type not found', 404);
	}

	if (existing.rows[0].is_builtin) {
		return err(c, 'FORBIDDEN', 'Cannot delete built-in company types', 403);
	}

	await db.query('DELETE FROM company_types WHERE id = $1', [id]);
	return c.json({ data: null }, 200);
});
