import type { SearchScope } from '@hezo/shared';
import { Hono } from 'hono';
import { err, ok } from '../lib/response';
import type { Env } from '../lib/types';
import { getAccessibleTeamIds } from '../middleware/auth';
import { fullTextSearch } from '../services/search';

export const searchRoutes = new Hono<Env>();

// Project-scoped search (team resolved by requireProjectAccessMiddleware).
searchRoutes.get('/projects/:projectId/search', async (c) => {
	const teamId = c.get('teamId') as string;
	const db = c.get('db');
	const query = c.req.query('q');
	const scope = (c.req.query('scope') as SearchScope) || 'all';
	const limit = Number.parseInt(c.req.query('limit') || '10', 10);

	if (!query?.trim()) {
		return err(c, 'INVALID_REQUEST', 'q parameter is required', 400);
	}

	const results = await fullTextSearch(db, [teamId], query.trim(), { scope, limit });
	return ok(c, { results });
});

// Global search across every team the caller can access (powers the Cmd/Ctrl+K
// palette). Authed but not project-scoped — HQ is included like any other team.
searchRoutes.get('/search', async (c) => {
	const db = c.get('db');
	const auth = c.get('auth');
	const query = c.req.query('q');
	const scope = (c.req.query('scope') as SearchScope) || 'all';
	const limit = Number.parseInt(c.req.query('limit') || '20', 10);

	if (!query?.trim()) {
		return err(c, 'INVALID_REQUEST', 'q parameter is required', 400);
	}

	const teamIds = await getAccessibleTeamIds(db, auth);
	const results = await fullTextSearch(db, teamIds, query.trim(), { scope, limit });
	return ok(c, { results });
});
