import { AuthType } from '@hezo/shared';
import { Hono } from 'hono';
import { err, ok } from '../lib/response';
import type { Env } from '../lib/types';
import { requireSuperuser } from '../middleware/auth';
import {
	approveApiKey,
	createApiKey,
	deleteApiKey,
	getApiKeyStatusByToken,
	listApiKeys,
	registerApiKey,
} from '../services/api-keys';

export const apiKeysRoutes = new Hono<Env>();

// --- Public onboarding (no auth; see PUBLIC_PATHS in middleware/auth.ts) ---

// Self-registration by an external MCP client. Returns the raw token exactly once;
// the key is `pending` and grants no access until an admin approves it.
apiKeysRoutes.post('/api-keys/register', async (c) => {
	const db = c.get('db');
	const body = await c.req.json<{ name?: string; client_info?: Record<string, unknown> }>();
	if (!body.name?.trim()) {
		return err(c, 'INVALID_REQUEST', 'name is required', 400);
	}
	const result = await registerApiKey(db, { name: body.name, clientInfo: body.client_info });
	return ok(c, result, 201);
});

// Poll approval status with the registered token (works while still pending).
apiKeysRoutes.get('/api-keys/status', async (c) => {
	const db = c.get('db');
	const header = c.req.header('Authorization');
	const token = header?.startsWith('Bearer ') ? header.slice(7) : null;
	if (!token) {
		return err(c, 'UNAUTHORIZED', 'Missing bearer token', 401);
	}
	const status = await getApiKeyStatusByToken(db, token);
	if (!status) {
		return err(c, 'NOT_FOUND', 'Not a registered API key', 404);
	}
	return ok(c, status);
});

// --- Management (human superuser only — an API key cannot manage keys) ---

apiKeysRoutes.get('/api-keys', async (c) => {
	const denied = requireSuperuser(c);
	if (denied) return denied;
	const db = c.get('db');
	return ok(c, await listApiKeys(db));
});

// Admin-minted key: active immediately. Returns the raw key once.
apiKeysRoutes.post('/api-keys', async (c) => {
	const denied = requireSuperuser(c);
	if (denied) return denied;
	const db = c.get('db');
	const auth = c.get('auth');
	const body = await c.req.json<{ name: string }>();
	if (!body.name?.trim()) {
		return err(c, 'INVALID_REQUEST', 'name is required', 400);
	}
	const userId = auth.type === AuthType.Admin ? auth.userId : '';
	const row = await createApiKey(db, { name: body.name, createdByUserId: userId });
	return ok(c, row, 201);
});

apiKeysRoutes.post('/api-keys/:id/approve', async (c) => {
	const denied = requireSuperuser(c);
	if (denied) return denied;
	const db = c.get('db');
	const auth = c.get('auth');
	const userId = auth.type === AuthType.Admin ? auth.userId : '';
	const row = await approveApiKey(db, c.req.param('id'), userId);
	if (!row) {
		return err(c, 'NOT_FOUND', 'API key not found', 404);
	}
	return ok(c, row);
});

apiKeysRoutes.delete('/api-keys/:id', async (c) => {
	const denied = requireSuperuser(c);
	if (denied) return denied;
	const db = c.get('db');
	const removed = await deleteApiKey(db, c.req.param('id'));
	if (!removed) {
		return err(c, 'NOT_FOUND', 'API key not found', 404);
	}
	return c.json({ data: null }, 200);
});
