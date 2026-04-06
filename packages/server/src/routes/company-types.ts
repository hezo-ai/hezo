import type { PGlite } from '@electric-sql/pglite';
import { Hono } from 'hono';
import { err, ok } from '../lib/response';
import type { Env } from '../lib/types';

export const companyTypesRoutes = new Hono<Env>();

companyTypesRoutes.get('/company-types', async (c) => {
	const db = c.get('db');
	const result = await db.query(
		`SELECT ct.*,
		    COALESCE(
		        json_agg(json_build_object(
		            'agent_type_id', at.id,
		            'name', at.name,
		            'slug', at.slug,
		            'role_description', at.role_description,
		            'runtime_type', at.runtime_type,
		            'heartbeat_interval_min', at.heartbeat_interval_min,
		            'monthly_budget_cents', at.monthly_budget_cents,
		            'reports_to_slug', ctat.reports_to_slug,
		            'runtime_type_override', ctat.runtime_type_override,
		            'heartbeat_interval_override', ctat.heartbeat_interval_override,
		            'monthly_budget_override', ctat.monthly_budget_override,
		            'sort_order', ctat.sort_order,
		            'system_prompt', at.system_prompt_template
		        ) ORDER BY ctat.sort_order) FILTER (WHERE at.id IS NOT NULL),
		        '[]'
		    ) AS agent_types
		 FROM company_types ct
		 LEFT JOIN company_type_agent_types ctat ON ctat.company_type_id = ct.id
		 LEFT JOIN agent_types at ON at.id = ctat.agent_type_id
		 GROUP BY ct.id
		 ORDER BY ct.is_builtin DESC, ct.name ASC`,
	);
	return ok(c, result.rows);
});

companyTypesRoutes.post('/company-types', async (c) => {
	const body = await c.req.json<{
		name: string;
		description?: string;
		agent_types?: { agent_type_id: string; reports_to_slug?: string; sort_order?: number }[];
		kb_docs_config?: unknown[];
		skills_config?: unknown[];
		preferences_config?: Record<string, unknown>;
		mcp_servers?: unknown[];
		mpp_config?: Record<string, unknown>;
	}>();

	if (!body.name?.trim()) {
		return err(c, 'INVALID_REQUEST', 'name is required', 400);
	}

	const db = c.get('db');

	await db.query('BEGIN');

	const ctResult = await db.query(
		`INSERT INTO company_types (name, description, kb_docs_config, skills_config, preferences_config, mcp_servers, mpp_config)
		 VALUES ($1, $2, $3::jsonb, $4::jsonb, $5::jsonb, $6::jsonb, $7::jsonb)
		 RETURNING *`,
		[
			body.name.trim(),
			body.description ?? '',
			JSON.stringify(body.kb_docs_config ?? []),
			JSON.stringify(body.skills_config ?? []),
			JSON.stringify(body.preferences_config ?? {}),
			JSON.stringify(body.mcp_servers ?? []),
			JSON.stringify(body.mpp_config ?? { enabled: false }),
		],
	);

	const companyType = ctResult.rows[0] as Record<string, unknown>;

	if (body.agent_types?.length) {
		for (const at of body.agent_types) {
			await db.query(
				`INSERT INTO company_type_agent_types (company_type_id, agent_type_id, reports_to_slug, sort_order)
				 VALUES ($1, $2, $3, $4)`,
				[companyType.id, at.agent_type_id, at.reports_to_slug ?? null, at.sort_order ?? 0],
			);
		}
	}

	await db.query('COMMIT');

	const full = await getCompanyTypeWithAgentTypes(db, companyType.id as string);
	return ok(c, full, 201);
});

companyTypesRoutes.get('/company-types/:id', async (c) => {
	const db = c.get('db');
	const full = await getCompanyTypeWithAgentTypes(db, c.req.param('id'));

	if (!full) {
		return err(c, 'NOT_FOUND', 'Company type not found', 404);
	}

	return ok(c, full);
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
		agent_types?: { agent_type_id: string; reports_to_slug?: string; sort_order?: number }[];
		kb_docs_config?: unknown[];
		skills_config?: unknown[];
		preferences_config?: Record<string, unknown>;
		mcp_servers?: unknown[];
		mpp_config?: Record<string, unknown>;
	}>();

	await db.query('BEGIN');

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
	addField('kb_docs_config', body.kb_docs_config, true);
	addField('skills_config', body.skills_config, true);
	addField('preferences_config', body.preferences_config, true);
	addField('mcp_servers', body.mcp_servers, true);
	addField('mpp_config', body.mpp_config, true);

	if (sets.length > 0) {
		params.push(id);
		await db.query(`UPDATE company_types SET ${sets.join(', ')} WHERE id = $${idx}`, params);
	}

	if (body.agent_types !== undefined) {
		await db.query('DELETE FROM company_type_agent_types WHERE company_type_id = $1', [id]);
		for (const at of body.agent_types) {
			await db.query(
				`INSERT INTO company_type_agent_types (company_type_id, agent_type_id, reports_to_slug, sort_order)
				 VALUES ($1, $2, $3, $4)`,
				[id, at.agent_type_id, at.reports_to_slug ?? null, at.sort_order ?? 0],
			);
		}
	}

	await db.query('COMMIT');

	const full = await getCompanyTypeWithAgentTypes(db, id);
	return ok(c, full);
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

async function getCompanyTypeWithAgentTypes(db: PGlite, id: string) {
	const result = await db.query(
		`SELECT ct.*,
		    COALESCE(
		        json_agg(json_build_object(
		            'agent_type_id', at.id,
		            'name', at.name,
		            'slug', at.slug,
		            'role_description', at.role_description,
		            'runtime_type', at.runtime_type,
		            'heartbeat_interval_min', at.heartbeat_interval_min,
		            'monthly_budget_cents', at.monthly_budget_cents,
		            'reports_to_slug', ctat.reports_to_slug,
		            'runtime_type_override', ctat.runtime_type_override,
		            'heartbeat_interval_override', ctat.heartbeat_interval_override,
		            'monthly_budget_override', ctat.monthly_budget_override,
		            'sort_order', ctat.sort_order,
			            'system_prompt', at.system_prompt_template
		        ) ORDER BY ctat.sort_order) FILTER (WHERE at.id IS NOT NULL),
		        '[]'
		    ) AS agent_types
		 FROM company_types ct
		 LEFT JOIN company_type_agent_types ctat ON ctat.company_type_id = ct.id
		 LEFT JOIN agent_types at ON at.id = ctat.agent_type_id
		 WHERE ct.id = $1
		 GROUP BY ct.id`,
		[id],
	);
	return result.rows[0] ?? null;
}
