import { AuthType } from '@hezo/shared';
import { Hono } from 'hono';
import { ok } from '../lib/response';
import type { Env } from '../lib/types';

export const meRoutes = new Hono<Env>();

/**
 * Returns the authenticated caller's identity flags. Used by the web client to
 * gate superuser-only affordances (e.g. the "New team" button in the team rail).
 */
meRoutes.get('/me', (c) => {
	const auth = c.get('auth');
	const isSuperuser = auth.type === AuthType.Board ? auth.isSuperuser : false;
	return ok(c, { type: auth.type, is_superuser: isSuperuser });
});
