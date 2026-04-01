import { existsSync, readFileSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';
import { Hono } from 'hono';
import { err } from '../lib/response';
import type { Env } from '../lib/types';
import { requireCompanyAccess } from '../middleware/auth';
import { getWorkspacePath } from '../services/workspace';

export const previewRoutes = new Hono<Env>();

const MIME_TYPES: Record<string, string> = {
	'.html': 'text/html',
	'.css': 'text/css',
	'.js': 'application/javascript',
	'.json': 'application/json',
	'.png': 'image/png',
	'.jpg': 'image/jpeg',
	'.jpeg': 'image/jpeg',
	'.gif': 'image/gif',
	'.svg': 'image/svg+xml',
	'.ico': 'image/x-icon',
	'.woff': 'font/woff',
	'.woff2': 'font/woff2',
	'.ttf': 'font/ttf',
};

previewRoutes.get('/companies/:companyId/projects/:projectId/preview/*', async (c) => {
	const access = await requireCompanyAccess(c);
	if (access instanceof Response) return access;

	const db = c.get('db');
	const dataDir = c.get('dataDir');
	const { companyId } = access;
	const projectId = c.req.param('projectId');

	if (!dataDir) {
		return err(c, 'NOT_CONFIGURED', 'Data directory not configured', 500);
	}

	const project = await db.query<{ slug: string }>(
		'SELECT slug FROM projects WHERE id = $1 AND company_id = $2',
		[projectId, companyId],
	);
	if (project.rows.length === 0) {
		return err(c, 'NOT_FOUND', 'Project not found', 404);
	}

	const company = await db.query<{ slug: string }>('SELECT slug FROM companies WHERE id = $1', [
		companyId,
	]);
	if (company.rows.length === 0) {
		return err(c, 'NOT_FOUND', 'Company not found', 404);
	}

	const workspacePath = getWorkspacePath(dataDir, company.rows[0].slug, project.rows[0].slug);
	const requestedPath = c.req.path.split('/preview/')[1] || 'index.html';
	const resolvedPath = resolve(join(workspacePath, requestedPath));

	const normalizedWorkspace = normalize(workspacePath);
	if (!resolvedPath.startsWith(normalizedWorkspace)) {
		return err(c, 'FORBIDDEN', 'Path traversal not allowed', 403);
	}

	if (!existsSync(resolvedPath)) {
		return err(c, 'NOT_FOUND', 'File not found', 404);
	}

	const ext = extname(resolvedPath).toLowerCase();
	const contentType = MIME_TYPES[ext] || 'application/octet-stream';

	const content = readFileSync(resolvedPath);
	return new Response(content, {
		headers: { 'Content-Type': contentType },
	});
});
