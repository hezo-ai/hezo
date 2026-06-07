import { existsSync, readFileSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';
import { Hono } from 'hono';
import { resolveProjectId } from '../lib/resolve';
import { err } from '../lib/response';
import type { Env } from '../lib/types';
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

previewRoutes.get('/projects/:projectId/preview/*', async (c) => {
	const teamId = c.get('teamId') as string;
	const db = c.get('db');
	const dataDir = c.get('dataDir');
	const projectId = await resolveProjectId(db, teamId, c.req.param('projectId'));
	if (!projectId) return err(c, 'NOT_FOUND', 'Project not found', 404);

	if (!dataDir) {
		return err(c, 'NOT_CONFIGURED', 'Data directory not configured', 500);
	}

	const workspacePath = getWorkspacePath(dataDir, teamId, projectId);
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
