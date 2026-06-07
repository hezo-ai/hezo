import { Hono } from 'hono';
import { err, ok } from '../lib/response';
import type { Env } from '../lib/types';
import { isModelReady, semanticSearch } from '../services/embeddings';

export const searchRoutes = new Hono<Env>();

searchRoutes.get('/projects/:projectId/search', async (c) => {
	const teamId = c.get('teamId') as string;
	const db = c.get('db');
	const query = c.req.query('q');
	const scope = (c.req.query('scope') as 'all' | 'tasks' | 'skills' | 'project_docs') || 'all';
	const limit = Number.parseInt(c.req.query('limit') || '10', 10);

	if (!query?.trim()) {
		return err(c, 'INVALID_REQUEST', 'q parameter is required', 400);
	}

	if (!isModelReady()) {
		return ok(c, {
			results: [],
			message: 'Embedding model is loading. Search will be available shortly.',
		});
	}

	const results = await semanticSearch(db, teamId, query.trim(), { scope, limit });
	return ok(c, { results });
});
