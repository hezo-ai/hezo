import { Hono } from 'hono';
import { err, ok } from '../lib/response';
import type { Env } from '../lib/types';

export const secretsRoutes = new Hono<Env>();

secretsRoutes.get('/companies/:companyId/secrets', async (c) => {
	const db = c.get('db');
	const companyId = c.req.param('companyId');
	const projectId = c.req.query('project_id');

	let query = `
    SELECT s.id, s.company_id, s.project_id, s.name, s.category, s.created_at, s.updated_at,
           p.name AS project_name,
           (SELECT count(*) FROM secret_grants sg WHERE sg.secret_id = s.id AND sg.revoked_at IS NULL)::int AS grant_count
    FROM secrets s
    LEFT JOIN projects p ON p.id = s.project_id
    WHERE s.company_id = $1`;
	const params: unknown[] = [companyId];

	if (projectId) {
		query += ` AND s.project_id = $2`;
		params.push(projectId);
	}

	query += ' ORDER BY s.name ASC';
	const result = await db.query(query, params);
	return ok(c, result.rows);
});

secretsRoutes.post('/companies/:companyId/secrets', async (c) => {
	const db = c.get('db');
	const companyId = c.req.param('companyId');
	const masterKeyManager = c.get('masterKeyManager');

	const body = await c.req.json<{
		name: string;
		value: string;
		project_id?: string;
		category?: string;
	}>();

	if (!body.name?.trim() || !body.value) {
		return err(c, 'INVALID_REQUEST', 'name and value are required', 400);
	}

	const key = masterKeyManager.getKey();
	if (!key) {
		return err(c, 'LOCKED', 'Server must be unlocked to manage secrets', 401);
	}

	const { encrypt } = await import('../crypto/encryption');
	const encryptedValue = encrypt(body.value, key);

	const result = await db.query(
		`INSERT INTO secrets (company_id, project_id, name, encrypted_value, category)
     VALUES ($1, $2, $3, $4, $5::secret_category)
     RETURNING id, company_id, project_id, name, category, created_at, updated_at`,
		[
			companyId,
			body.project_id ?? null,
			body.name.trim(),
			encryptedValue,
			body.category ?? 'other',
		],
	);

	return ok(c, result.rows[0], 201);
});

secretsRoutes.patch('/companies/:companyId/secrets/:secretId', async (c) => {
	const db = c.get('db');
	const secretId = c.req.param('secretId');
	const companyId = c.req.param('companyId');
	const masterKeyManager = c.get('masterKeyManager');

	const existing = await db.query('SELECT id FROM secrets WHERE id = $1 AND company_id = $2', [
		secretId,
		companyId,
	]);
	if (existing.rows.length === 0) {
		return err(c, 'NOT_FOUND', 'Secret not found', 404);
	}

	const body = await c.req.json<{
		value?: string;
		category?: string;
	}>();

	const sets: string[] = [];
	const params: unknown[] = [];
	let idx = 1;

	if (body.value !== undefined) {
		const key = masterKeyManager.getKey();
		if (!key) {
			return err(c, 'LOCKED', 'Server must be unlocked to manage secrets', 401);
		}
		const { encrypt } = await import('../crypto/encryption');
		sets.push(`encrypted_value = $${idx}`);
		params.push(encrypt(body.value, key));
		idx++;
	}

	if (body.category !== undefined) {
		sets.push(`category = $${idx}::secret_category`);
		params.push(body.category);
		idx++;
	}

	if (sets.length === 0) {
		return ok(c, existing.rows[0]);
	}

	params.push(secretId);
	const result = await db.query(
		`UPDATE secrets SET ${sets.join(', ')} WHERE id = $${idx}
     RETURNING id, company_id, project_id, name, category, created_at, updated_at`,
		params,
	);

	return ok(c, result.rows[0]);
});

secretsRoutes.delete('/companies/:companyId/secrets/:secretId', async (c) => {
	const db = c.get('db');
	const secretId = c.req.param('secretId');
	const companyId = c.req.param('companyId');

	const existing = await db.query('SELECT id FROM secrets WHERE id = $1 AND company_id = $2', [
		secretId,
		companyId,
	]);
	if (existing.rows.length === 0) {
		return err(c, 'NOT_FOUND', 'Secret not found', 404);
	}

	await db.query('DELETE FROM secrets WHERE id = $1', [secretId]);
	return c.json({ data: null }, 200);
});

// Secret Grants
secretsRoutes.get('/companies/:companyId/secrets/:secretId/grants', async (c) => {
	const db = c.get('db');
	const result = await db.query(
		`SELECT sg.id, sg.secret_id, sg.member_id AS agent_id, sg.scope, sg.granted_at, sg.revoked_at,
            ma.title AS agent_title
     FROM secret_grants sg
     LEFT JOIN member_agents ma ON ma.id = sg.member_id
     WHERE sg.secret_id = $1
     ORDER BY sg.granted_at DESC`,
		[c.req.param('secretId')],
	);
	return ok(c, result.rows);
});

secretsRoutes.post('/companies/:companyId/secrets/:secretId/grants', async (c) => {
	const db = c.get('db');
	const secretId = c.req.param('secretId');

	const body = await c.req.json<{
		agent_id: string;
		scope?: string;
	}>();

	if (!body.agent_id) {
		return err(c, 'INVALID_REQUEST', 'agent_id is required', 400);
	}

	const result = await db.query(
		`INSERT INTO secret_grants (secret_id, member_id, scope)
     VALUES ($1, $2, $3::grant_scope)
     ON CONFLICT (secret_id, member_id) DO UPDATE SET revoked_at = NULL
     RETURNING *`,
		[secretId, body.agent_id, body.scope ?? 'single'],
	);

	return ok(c, result.rows[0], 201);
});

secretsRoutes.delete('/companies/:companyId/secret-grants/:grantId', async (c) => {
	const db = c.get('db');
	const result = await db.query(
		'UPDATE secret_grants SET revoked_at = now() WHERE id = $1 RETURNING *',
		[c.req.param('grantId')],
	);

	if (result.rows.length === 0) {
		return err(c, 'NOT_FOUND', 'Grant not found', 404);
	}

	return ok(c, result.rows[0]);
});
