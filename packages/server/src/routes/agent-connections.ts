import { AuthType } from '@hezo/shared';
import { Hono } from 'hono';
import { err, ok } from '../lib/response';
import type { Env } from '../lib/types';
import { requireSuperuser } from '../middleware/auth';
import {
	approveConnectedAgent,
	deleteConnectedAgent,
	getConnectionStatusByToken,
	listConnectedAgents,
	registerConnectedAgent,
} from '../services/connected-agents';

export const agentConnectionsRoutes = new Hono<Env>();

// --- Public onboarding (no auth; see PUBLIC_PATHS in middleware/auth.ts) ---

// Self-registration. Returns the raw `hezoc_` token exactly once; the connection
// is `pending` and grants no access until an admin approves it.
agentConnectionsRoutes.post('/agent-connections/register', async (c) => {
	const db = c.get('db');
	const body = await c.req.json<{ name?: string; client_info?: Record<string, unknown> }>();
	if (!body.name?.trim()) {
		return err(c, 'INVALID_REQUEST', 'name is required', 400);
	}
	const result = await registerConnectedAgent(db, {
		name: body.name,
		clientInfo: body.client_info,
	});
	return ok(c, result, 201);
});

// Poll approval status with the registered token (works while still pending).
agentConnectionsRoutes.get('/agent-connections/status', async (c) => {
	const db = c.get('db');
	const header = c.req.header('Authorization');
	const token = header?.startsWith('Bearer ') ? header.slice(7) : null;
	if (!token) {
		return err(c, 'UNAUTHORIZED', 'Missing bearer token', 401);
	}
	const status = await getConnectionStatusByToken(db, token);
	if (!status) {
		return err(c, 'NOT_FOUND', 'Not a registered connected agent', 404);
	}
	return ok(c, status);
});

// --- Management (human superuser only — connected agents cannot manage agents) ---

agentConnectionsRoutes.get('/agent-connections', async (c) => {
	const denied = requireSuperuser(c);
	if (denied) return denied;
	const db = c.get('db');
	return ok(c, await listConnectedAgents(db));
});

agentConnectionsRoutes.post('/agent-connections/:id/approve', async (c) => {
	const denied = requireSuperuser(c);
	if (denied) return denied;
	const db = c.get('db');
	const auth = c.get('auth');
	const userId = auth.type === AuthType.Admin ? auth.userId : '';
	const row = await approveConnectedAgent(db, c.req.param('id'), userId);
	if (!row) {
		return err(c, 'NOT_FOUND', 'Connected agent not found', 404);
	}
	return ok(c, row);
});

agentConnectionsRoutes.delete('/agent-connections/:id', async (c) => {
	const denied = requireSuperuser(c);
	if (denied) return denied;
	const db = c.get('db');
	const removed = await deleteConnectedAgent(db, c.req.param('id'));
	if (!removed) {
		return err(c, 'NOT_FOUND', 'Connected agent not found', 404);
	}
	return c.json({ data: null }, 200);
});
