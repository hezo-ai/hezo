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
	const isSuperuser = auth.type === AuthType.Admin ? auth.isSuperuser : false;
	// The human user's id (Admin only) — used to link an external chat identity to
	// the current operator on the chat-channels settings page.
	const userId = auth.type === AuthType.Admin ? auth.userId : null;
	return ok(c, { type: auth.type, is_superuser: isSuperuser, user_id: userId });
});
