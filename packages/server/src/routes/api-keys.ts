import { createHash, randomBytes } from 'node:crypto';
import { wsRoom } from '@hezo/shared';
import { Hono } from 'hono';
import { z } from 'zod';
import { broadcastChange } from '../lib/broadcast';
import { requireResourceInTeam } from '../lib/resource';
import { ok } from '../lib/response';
import type { Env } from '../lib/types';
import { validateBody } from '../lib/validate';
import { deleteApiKey, insertApiKey, listTeamApiKeys } from '../repositories/api-keys';

export const apiKeysRoutes = new Hono<Env>();

function hashKey(key: string): string {
	return createHash('sha256').update(key).digest('hex');
}

apiKeysRoutes.get('/projects/:projectId/api-keys', async (c) => {
	const teamId = c.get('teamId') as string;
	const db = c.get('db');

	const rows = await listTeamApiKeys(db, teamId);
	return ok(c, rows);
});

apiKeysRoutes.post('/projects/:projectId/api-keys', async (c) => {
	const teamId = c.get('teamId') as string;
	const db = c.get('db');

	const body = await validateBody(
		c,
		z.object({ name: z.string().trim().min(1, 'name is required') }),
	);
	if (body instanceof Response) return body;

	const rawKey = `hezo_${randomBytes(16).toString('hex')}`;
	const prefix = rawKey.slice(5, 13);
	const keyHash = hashKey(rawKey);

	const row = await insertApiKey(db, { teamId, name: body.name, prefix, keyHash });

	broadcastChange(c, wsRoom.team(teamId), 'api_keys', 'INSERT', row as Record<string, unknown>);
	return ok(c, { ...row, key: rawKey }, 201);
});

apiKeysRoutes.delete('/projects/:projectId/api-keys/:apiKeyId', async (c) => {
	const teamId = c.get('teamId') as string;
	const db = c.get('db');
	const apiKeyId = c.req.param('apiKeyId');

	const existing = await requireResourceInTeam<{ id: string }>(c, 'api_keys', apiKeyId, teamId, {
		resourceName: 'API key',
	});
	if (existing instanceof Response) return existing;

	await deleteApiKey(db, apiKeyId);
	broadcastChange(c, wsRoom.team(teamId), 'api_keys', 'DELETE', { id: apiKeyId });
	return c.json({ data: null }, 200);
});
