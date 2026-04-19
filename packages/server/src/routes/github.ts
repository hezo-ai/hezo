import { PlatformType } from '@hezo/shared';
import { Hono } from 'hono';
import { err, ok } from '../lib/response';
import type { Env } from '../lib/types';
import { requireCompanyAccess } from '../middleware/auth';
import { listAccessibleRepos, listUserOrgs } from '../services/github';
import { getOAuthToken } from '../services/token-store';

export const githubRoutes = new Hono<Env>();

githubRoutes.get('/companies/:companyId/github/orgs', async (c) => {
	const access = await requireCompanyAccess(c);
	if (access instanceof Response) return access;

	const db = c.get('db');
	const masterKeyManager = c.get('masterKeyManager');
	const { companyId } = access;

	const token = await getOAuthToken(db, masterKeyManager, companyId, PlatformType.GitHub);
	if (!token) return err(c, 'GITHUB_NOT_CONNECTED', 'GitHub is not connected', 422);

	try {
		const orgs = await listUserOrgs(token);
		return ok(c, orgs);
	} catch {
		return err(c, 'GITHUB_REQUEST_FAILED', 'Failed to fetch orgs from GitHub', 503);
	}
});

githubRoutes.get('/companies/:companyId/github/repos', async (c) => {
	const access = await requireCompanyAccess(c);
	if (access instanceof Response) return access;

	const db = c.get('db');
	const masterKeyManager = c.get('masterKeyManager');
	const { companyId } = access;

	const owner = c.req.query('owner');
	const query = c.req.query('query') ?? '';
	if (!owner) return err(c, 'INVALID_REQUEST', 'owner query param is required', 400);

	const token = await getOAuthToken(db, masterKeyManager, companyId, PlatformType.GitHub);
	if (!token) return err(c, 'GITHUB_NOT_CONNECTED', 'GitHub is not connected', 422);

	try {
		const repos = await listAccessibleRepos(owner, query, token);
		return ok(c, repos);
	} catch {
		return err(c, 'GITHUB_REQUEST_FAILED', 'Failed to fetch repos from GitHub', 503);
	}
});
