import { Hono } from 'hono';
import { err, ok } from '../lib/response';
import type { Env } from '../lib/types';
import { getMarketplaceCatalog, getMarketplaceTeam } from '../services/marketplace';

/**
 * Read-only marketplace catalog surface. Any authenticated user may browse; the
 * provisioning actions (launch a project / add a team to a project) live on the
 * projects routes and are admin-gated. The catalog is fetched live (local folder
 * in dev, GitHub raw in prod) with the embedded snapshot as an offline fallback.
 */
export const marketplaceRoutes = new Hono<Env>();

marketplaceRoutes.get('/marketplace/teams', async (c) => {
	const force = c.req.query('refresh') === '1';
	const catalog = await getMarketplaceCatalog(force);
	return ok(c, catalog);
});

marketplaceRoutes.get('/marketplace/teams/:slug', async (c) => {
	const slug = c.req.param('slug');
	const force = c.req.query('refresh') === '1';
	const team = await getMarketplaceTeam(slug, force);
	if (!team) return err(c, 'NOT_FOUND', `Marketplace team "${slug}" not found`, 404);
	return ok(c, team);
});
