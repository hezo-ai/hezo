import { DEFAULT_TEAM_ID, MemberType } from '@hezo/shared';
import { Hono } from 'hono';
import { requestOrigin } from '../lib/request-origin';
import { err, ok } from '../lib/response';
import {
	getSystemMeta,
	INSTANCE_BASE_URL_KEY,
	normalizeBaseUrl,
	setSystemMeta,
} from '../lib/system-meta';
import type { Env } from '../lib/types';
import { logger } from '../logger';
import { signAdminJwt } from '../middleware/auth';

const log = logger.child('routes');

export const authRoutes = new Hono<Env>();

// Bootstrap endpoint: exchange master key for a admin JWT (Phase 2 dev convenience)
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

	// Capture the public base URL of this instance from the URL the operator
	// used to reach it. Only when unset — a configured or previously captured
	// value is never clobbered (it stays editable in global settings). Awaited
	// so the settings page the operator lands on next reflects it.
	try {
		if (!(await getSystemMeta(db, INSTANCE_BASE_URL_KEY))) {
			const origin = normalizeBaseUrl(requestOrigin(c));
			if (origin) await setSystemMeta(db, INSTANCE_BASE_URL_KEY, origin);
		}
	} catch (e) {
		log.error('Failed to capture instance base URL:', e);
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
		await addUserToDefaultTeam(db, userId);
	}

	const token = await signAdminJwt(masterKeyManager, userId);
	return ok(c, { token }, 200);
});

async function addUserToDefaultTeam(
	db: import('@electric-sql/pglite').PGlite,
	userId: string,
): Promise<void> {
	const existing = await db.query(
		`SELECT m.id FROM members m
		 JOIN member_users mu ON mu.id = m.id
		 WHERE mu.user_id = $1 AND m.team_id = $2`,
		[userId, DEFAULT_TEAM_ID],
	);
	if (existing.rows.length > 0) return;

	const member = await db.query<{ id: string }>(
		`INSERT INTO members (team_id, member_type, display_name)
		 VALUES ($1, $2, (SELECT display_name FROM users WHERE id = $3))
		 RETURNING id`,
		[DEFAULT_TEAM_ID, MemberType.User, userId],
	);
	await db.query(`INSERT INTO member_users (id, user_id, role) VALUES ($1, $2, 'admin')`, [
		member.rows[0].id,
		userId,
	]);
}
