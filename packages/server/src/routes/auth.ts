import { Hono } from 'hono';
import { err, ok } from '../lib/response';
import type { Env } from '../lib/types';
import { signBoardJwt } from '../middleware/auth';

export const authRoutes = new Hono<Env>();

// Bootstrap endpoint: exchange master key for a board JWT (Phase 2 dev convenience)
authRoutes.post('/auth/token', async (c) => {
	const body = await c.req.json<{ master_key?: string }>();

	if (!body.master_key) {
		return err(c, 'INVALID_REQUEST', 'master_key is required', 400);
	}

	const masterKeyManager = c.get('masterKeyManager');
	const db = c.get('db');
	const unlocked = await masterKeyManager.unlock(db, body.master_key);

	if (!unlocked) {
		return err(c, 'UNAUTHORIZED', 'Invalid master key', 401);
	}

	const existing = await db.query<{ id: string }>(
		'SELECT id FROM users WHERE is_superuser = true LIMIT 1',
	);
	let userId: string;
	if (existing.rows.length > 0) {
		userId = existing.rows[0].id;
	} else {
		const inserted = await db.query<{ id: string }>(
			"INSERT INTO users (display_name, is_superuser) VALUES ('Admin', true) RETURNING id",
		);
		userId = inserted.rows[0].id;
	}

	const token = await signBoardJwt(masterKeyManager, userId);
	return ok(c, { token }, 200);
});
