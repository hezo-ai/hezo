import { createHash, randomBytes } from 'node:crypto';
import { Hono } from 'hono';
import { err, ok } from '../lib/response';
import type { Env } from '../lib/types';

export const apiKeysRoutes = new Hono<Env>();

function hashKey(key: string): string {
	return createHash('sha256').update(key).digest('hex');
}

apiKeysRoutes.get('/companies/:companyId/api-keys', async (c) => {
	const db = c.get('db');
	const result = await db.query(
		`SELECT id, company_id, name, prefix, last_used_at, created_at
     FROM api_keys
     WHERE company_id = $1
     ORDER BY created_at DESC`,
		[c.req.param('companyId')],
	);
	return ok(c, result.rows);
});

apiKeysRoutes.post('/companies/:companyId/api-keys', async (c) => {
	const db = c.get('db');
	const companyId = c.req.param('companyId');

	const body = await c.req.json<{ name: string }>();
	if (!body.name?.trim()) {
		return err(c, 'INVALID_REQUEST', 'name is required', 400);
	}

	// Generate key: hezo_ + 32 random hex chars
	const rawKey = `hezo_${randomBytes(16).toString('hex')}`;
	const prefix = rawKey.slice(5, 13); // 8 chars after hezo_
	const keyHash = hashKey(rawKey);

	const result = await db.query<{
		id: string;
		company_id: string;
		name: string;
		prefix: string;
		created_at: string;
	}>(
		`INSERT INTO api_keys (company_id, name, prefix, key_hash)
     VALUES ($1, $2, $3, $4)
     RETURNING id, company_id, name, prefix, created_at`,
		[companyId, body.name.trim(), prefix, keyHash],
	);

	// Return the raw key once
	return ok(c, { ...result.rows[0], key: rawKey }, 201);
});

apiKeysRoutes.delete('/companies/:companyId/api-keys/:apiKeyId', async (c) => {
	const db = c.get('db');
	const apiKeyId = c.req.param('apiKeyId');
	const companyId = c.req.param('companyId');

	const existing = await db.query('SELECT id FROM api_keys WHERE id = $1 AND company_id = $2', [
		apiKeyId,
		companyId,
	]);
	if (existing.rows.length === 0) {
		return err(c, 'NOT_FOUND', 'API key not found', 404);
	}

	await db.query('DELETE FROM api_keys WHERE id = $1', [apiKeyId]);
	return c.json({ data: null }, 200);
});
