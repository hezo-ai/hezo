import { ApprovalType, PlatformType } from '@hezo/shared';
import { Hono } from 'hono';
import { broadcastChange } from '../lib/broadcast';
import { getProjectLocator, resolveProjectId } from '../lib/resolve';
import { err, ok } from '../lib/response';
import type { Env } from '../lib/types';
import { logger } from '../logger';
import { requireCompanyAccess } from '../middleware/auth';
import { parseGitHubUrl, validateRepoAccess } from '../services/github';
import { ensureProjectRepos, removeRepoFromWorkspace } from '../services/repo-sync';
import { getOAuthToken } from '../services/token-store';

const log = logger.child('routes');

export const reposRoutes = new Hono<Env>();

reposRoutes.get('/companies/:companyId/projects/:projectId/repos', async (c) => {
	const access = await requireCompanyAccess(c);
	if (access instanceof Response) return access;

	const db = c.get('db');
	const { companyId } = access;
	const projectId = await resolveProjectId(db, companyId, c.req.param('projectId'));
	if (!projectId) return err(c, 'NOT_FOUND', 'Project not found', 404);

	const result = await db.query(
		`SELECT id, project_id, short_name, repo_identifier, host_type, created_at
		 FROM repos WHERE project_id = $1 ORDER BY created_at ASC`,
		[projectId],
	);

	return ok(c, result.rows);
});

reposRoutes.post('/companies/:companyId/projects/:projectId/repos', async (c) => {
	const access = await requireCompanyAccess(c);
	if (access instanceof Response) return access;

	const db = c.get('db');
	const masterKeyManager = c.get('masterKeyManager');
	const { companyId } = access;
	const projectId = await resolveProjectId(db, companyId, c.req.param('projectId'));
	if (!projectId) return err(c, 'NOT_FOUND', 'Project not found', 404);

	const body = await c.req.json<{ short_name: string; url: string }>();

	if (!body.short_name || !body.url) {
		return err(c, 'INVALID_REQUEST', 'short_name and url are required', 400);
	}

	const parsed = parseGitHubUrl(body.url);
	if (!parsed) {
		return err(c, 'INVALID_URL', 'URL must be a valid GitHub repository URL', 400);
	}

	const connection = await db.query<{
		id: string;
		metadata: { username?: string };
	}>(
		`SELECT id, metadata FROM connected_platforms
		 WHERE company_id = $1 AND platform = $2 AND status = 'active'`,
		[companyId, PlatformType.GitHub],
	);

	if (connection.rows.length === 0) {
		await db.query(
			`INSERT INTO approvals (company_id, type, payload)
			 VALUES ($1, $2::approval_type, $3::jsonb)`,
			[
				companyId,
				ApprovalType.OauthRequest,
				JSON.stringify({ platform: PlatformType.GitHub, reason: 'repo_add', repo_url: body.url }),
			],
		);

		return err(
			c,
			'GITHUB_NOT_CONNECTED',
			'Connect GitHub in company settings before adding repos',
			422,
		);
	}

	const token = await getOAuthToken(db, masterKeyManager, companyId, PlatformType.GitHub);
	if (!token) {
		return err(c, 'GITHUB_NOT_CONNECTED', 'GitHub token not found', 422);
	}

	const repoAccess = await validateRepoAccess(parsed.owner, parsed.repo, token);
	if (!repoAccess.accessible) {
		const username = connection.rows[0].metadata?.username || 'the connected account';
		return err(
			c,
			'REPO_ACCESS_FAILED',
			`Cannot access this repo — the GitHub user '${username}' needs to be added to ${parsed.owner}/${parsed.repo}`,
			422,
		);
	}

	const repoIdentifier = `${parsed.owner}/${parsed.repo}`;

	const result = await db.query<Record<string, unknown>>(
		`INSERT INTO repos (project_id, short_name, repo_identifier, host_type)
		 VALUES ($1, $2, $3, 'github'::repo_host_type)
		 RETURNING *`,
		[projectId, body.short_name, repoIdentifier],
	);

	const dataDir = c.get('dataDir');
	let cloneStatus: 'skipped' | 'cloned' | 'failed' = 'skipped';
	let cloneError: string | undefined;

	if (dataDir) {
		const locator = await getProjectLocator(db, projectId);
		if (locator) {
			const syncRes = await ensureProjectRepos(
				db,
				masterKeyManager,
				{
					id: projectId,
					company_id: companyId,
					companySlug: locator.companySlug,
					projectSlug: locator.slug,
				},
				dataDir,
			);
			const failed = syncRes.failed.find((f) => f.short_name === body.short_name);
			if (failed) {
				cloneStatus = 'failed';
				cloneError = failed.error;
				log.error(`Failed to clone ${repoIdentifier}:`, cloneError);
			} else if (syncRes.cloned.includes(body.short_name)) {
				cloneStatus = 'cloned';
			}
		}
	}

	broadcastChange(
		c,
		`company:${companyId}`,
		'repos',
		'INSERT',
		result.rows[0] as Record<string, unknown>,
	);

	return ok(
		c,
		{ ...result.rows[0], clone_status: cloneStatus, clone_error: cloneError ?? null },
		201,
	);
});

reposRoutes.delete('/companies/:companyId/projects/:projectId/repos/:repoId', async (c) => {
	const access = await requireCompanyAccess(c);
	if (access instanceof Response) return access;

	const db = c.get('db');
	const { companyId } = access;
	const projectId = await resolveProjectId(db, companyId, c.req.param('projectId'));
	if (!projectId) return err(c, 'NOT_FOUND', 'Project not found', 404);
	const repoId = c.req.param('repoId');

	const result = await db.query<{ id: string; short_name: string }>(
		'DELETE FROM repos WHERE id = $1 AND project_id = $2 RETURNING id, short_name',
		[repoId, projectId],
	);

	if (result.rows.length === 0) {
		return err(c, 'NOT_FOUND', 'Repo not found', 404);
	}

	const dataDir = c.get('dataDir');
	if (dataDir) {
		const locator = await getProjectLocator(db, projectId);
		if (locator) {
			try {
				removeRepoFromWorkspace(
					dataDir,
					locator.companySlug,
					locator.slug,
					result.rows[0].short_name,
				);
			} catch (error) {
				log.error(`Failed to clean up workspace for repo ${result.rows[0].short_name}:`, error);
			}
		}
	}

	broadcastChange(c, `company:${companyId}`, 'repos', 'DELETE', { id: repoId });
	return ok(c, { deleted: true });
});
