import { Hono } from 'hono';
import { err, ok } from '../lib/response';
import type { Env } from '../lib/types';
import { parseGitHubUrl, validateRepoAccess } from '../services/github';
import { getOAuthToken } from '../services/token-store';

export const reposRoutes = new Hono<Env>();

reposRoutes.get('/companies/:companyId/projects/:projectId/repos', async (c) => {
	const db = c.get('db');
	const projectId = c.req.param('projectId');

	const result = await db.query(
		`SELECT id, project_id, short_name, repo_identifier, host_type, created_at
		 FROM repos WHERE project_id = $1 ORDER BY created_at ASC`,
		[projectId],
	);

	return ok(c, result.rows);
});

reposRoutes.post('/companies/:companyId/projects/:projectId/repos', async (c) => {
	const db = c.get('db');
	const masterKeyManager = c.get('masterKeyManager');
	const companyId = c.req.param('companyId');
	const projectId = c.req.param('projectId');

	const body = await c.req.json<{ short_name: string; url: string }>();

	if (!body.short_name || !body.url) {
		return err(c, 'INVALID_REQUEST', 'short_name and url are required', 400);
	}

	const parsed = parseGitHubUrl(body.url);
	if (!parsed) {
		return err(c, 'INVALID_URL', 'URL must be a valid GitHub repository URL', 400);
	}

	// Check if GitHub is connected
	const connection = await db.query<{
		id: string;
		metadata: { username?: string };
	}>(
		`SELECT id, metadata FROM connected_platforms
		 WHERE company_id = $1 AND platform = 'github' AND status = 'active'`,
		[companyId],
	);

	if (connection.rows.length === 0) {
		// Create an oauth_request approval item
		await db.query(
			`INSERT INTO approvals (company_id, type, payload)
			 VALUES ($1, 'oauth_request'::approval_type, $2::jsonb)`,
			[companyId, JSON.stringify({ platform: 'github', reason: 'repo_add', repo_url: body.url })],
		);

		return err(
			c,
			'GITHUB_NOT_CONNECTED',
			'Connect GitHub in company settings before adding repos',
			422,
		);
	}

	// Validate access via GitHub API
	const token = await getOAuthToken(db, masterKeyManager, companyId, 'github');
	if (!token) {
		return err(c, 'GITHUB_NOT_CONNECTED', 'GitHub token not found', 422);
	}

	const access = await validateRepoAccess(parsed.owner, parsed.repo, token);
	if (!access.accessible) {
		const username = connection.rows[0].metadata?.username || 'the connected account';
		return err(
			c,
			'REPO_ACCESS_FAILED',
			`Cannot access this repo — the GitHub user '${username}' needs to be added to ${parsed.owner}/${parsed.repo}`,
			422,
		);
	}

	const repoIdentifier = `${parsed.owner}/${parsed.repo}`;

	const result = await db.query(
		`INSERT INTO repos (project_id, short_name, repo_identifier, host_type)
		 VALUES ($1, $2, $3, 'github'::repo_host_type)
		 RETURNING *`,
		[projectId, body.short_name, repoIdentifier],
	);

	return ok(c, result.rows[0], 201);
});

reposRoutes.delete('/companies/:companyId/projects/:projectId/repos/:repoId', async (c) => {
	const db = c.get('db');
	const projectId = c.req.param('projectId');
	const repoId = c.req.param('repoId');

	const result = await db.query(
		'DELETE FROM repos WHERE id = $1 AND project_id = $2 RETURNING id',
		[repoId, projectId],
	);

	if (result.rows.length === 0) {
		return err(c, 'NOT_FOUND', 'Repo not found', 404);
	}

	return ok(c, { deleted: true });
});
