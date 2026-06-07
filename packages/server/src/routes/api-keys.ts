import { createHash, randomBytes } from 'node:crypto';
import { wsRoom } from '@hezo/shared';
import { Hono } from 'hono';
import { broadcastChange } from '../lib/broadcast';
import { err, ok } from '../lib/response';
import type { Env } from '../lib/types';

export const apiKeysRoutes = new Hono<Env>();

function hashKey(key: string): string {
	return createHash('sha256').update(key).digest('hex');
}

apiKeysRoutes.get('/projects/:projectId/api-keys', async (c) => {
	const teamId = c.get('teamId') as string;
	const db = c.get('db');

	const result = await db.query(
		`SELECT id, team_id, name, prefix, last_used_at, created_at
     FROM api_keys
     WHERE team_id = $1
     ORDER BY created_at DESC`,
		[teamId],
	);
	return ok(c, result.rows);
});

apiKeysRoutes.post('/projects/:projectId/api-keys', async (c) => {
	const teamId = c.get('teamId') as string;
	const db = c.get('db');

	const body = await c.req.json<{ name: string }>();
	if (!body.name?.trim()) {
		return err(c, 'INVALID_REQUEST', 'name is required', 400);
	}

	const rawKey = `hezo_${randomBytes(16).toString('hex')}`;
	const prefix = rawKey.slice(5, 13);
	const keyHash = hashKey(rawKey);

	const result = await db.query<{
		id: string;
		team_id: string;
		name: string;
		prefix: string;
		created_at: string;
	}>(
		`INSERT INTO api_keys (team_id, name, prefix, key_hash)
     VALUES ($1, $2, $3, $4)
     RETURNING id, team_id, name, prefix, created_at`,
		[teamId, body.name.trim(), prefix, keyHash],
	);

	const row = result.rows[0];
	broadcastChange(c, wsRoom.team(teamId), 'api_keys', 'INSERT', row as Record<string, unknown>);
	return ok(c, { ...row, key: rawKey }, 201);
});

apiKeysRoutes.delete('/projects/:projectId/api-keys/:apiKeyId', async (c) => {
	const teamId = c.get('teamId') as string;
	const db = c.get('db');
	const apiKeyId = c.req.param('apiKeyId');

	const existing = await db.query('SELECT id FROM api_keys WHERE id = $1 AND team_id = $2', [
		apiKeyId,
		teamId,
	]);
	if (existing.rows.length === 0) {
		return err(c, 'NOT_FOUND', 'API key not found', 404);
	}

	await db.query('DELETE FROM api_keys WHERE id = $1', [apiKeyId]);
	broadcastChange(c, wsRoom.team(teamId), 'api_keys', 'DELETE', { id: apiKeyId });
	return c.json({ data: null }, 200);
});
