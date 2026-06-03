import { AuthType } from '@hezo/shared';
import { Hono } from 'hono';
import { err, ok } from '../lib/response';
import type { Env } from '../lib/types';

export const uiStateRoutes = new Hono<Env>();

async function resolveMemberUser(c: import('hono').Context<Env>, teamId: string) {
	const auth = c.get('auth');
	if (auth.type !== AuthType.Admin) return null;

	const db = c.get('db');
	const result = await db.query<{ id: string; settings: Record<string, unknown> }>(
		`SELECT mu.id, mu.settings
		 FROM members m JOIN member_users mu ON mu.id = m.id
		 WHERE mu.user_id = $1 AND m.team_id = $2`,
		[auth.userId, teamId],
	);
	return result.rows[0] ?? null;
}

uiStateRoutes.get('/teams/:teamId/ui-state', async (c) => {
	const teamId = c.get('teamId') as string;

	const member = await resolveMemberUser(c, teamId);
	if (!member) {
		return err(c, 'FORBIDDEN', 'Only the admin have UI state', 403);
	}

	return ok(c, member.settings);
});

uiStateRoutes.patch('/teams/:teamId/ui-state', async (c) => {
	const teamId = c.get('teamId') as string;

	const member = await resolveMemberUser(c, teamId);
	if (!member) {
		return err(c, 'FORBIDDEN', 'Only the admin have UI state', 403);
	}

	const body = await c.req.json();
	const db = c.get('db');

	const result = await db.query<{ settings: Record<string, unknown> }>(
		`UPDATE member_users SET settings = settings || $1::jsonb WHERE id = $2 RETURNING settings`,
		[JSON.stringify(body), member.id],
	);

	return ok(c, result.rows[0].settings);
});
