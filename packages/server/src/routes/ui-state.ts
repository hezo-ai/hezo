import { AuthType } from '@hezo/shared';
import { Hono } from 'hono';
import { err, ok } from '../lib/response';
import type { Env } from '../lib/types';
import { findMemberUserForTeam, mergeMemberUserSettings } from '../repositories/ui-state';

export const uiStateRoutes = new Hono<Env>();

async function resolveMemberUser(c: import('hono').Context<Env>, teamId: string) {
	const auth = c.get('auth');
	if (auth.type !== AuthType.Admin) return null;
	return (await findMemberUserForTeam(c.get('db'), auth.userId, teamId)) ?? null;
}

uiStateRoutes.get('/projects/:projectId/ui-state', async (c) => {
	const teamId = c.get('teamId') as string;

	const member = await resolveMemberUser(c, teamId);
	if (!member) {
		return err(c, 'FORBIDDEN', 'Only the admin have UI state', 403);
	}

	return ok(c, member.settings);
});

uiStateRoutes.patch('/projects/:projectId/ui-state', async (c) => {
	const teamId = c.get('teamId') as string;

	const member = await resolveMemberUser(c, teamId);
	if (!member) {
		return err(c, 'FORBIDDEN', 'Only the admin have UI state', 403);
	}

	const body = await c.req.json();
	const settings = await mergeMemberUserSettings(c.get('db'), member.id, body);
	return ok(c, settings);
});
