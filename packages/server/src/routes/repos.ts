import { join } from 'node:path';
import { ApprovalType, PlatformType } from '@hezo/shared';
import { Hono } from 'hono';
import { broadcastChange } from '../lib/broadcast';
import { resolveProjectId } from '../lib/resolve';
import { err, ok } from '../lib/response';
import type { Env } from '../lib/types';
import { logger } from '../logger';
import { requireCompanyAccess } from '../middleware/auth';
import { cloneRepo } from '../services/git';
import { parseGitHubUrl, validateRepoAccess } from '../services/github';
import { removeRepoFromWorkspace } from '../services/repo-sync';
import { getCompanySSHKey } from '../services/ssh-keys';
import { getOAuthToken } from '../services/token-store';
import { getWorkspacePath } from '../services/workspace';

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
		const projectResult = await db.query<{ slug: string; company_id: string }>(
			'SELECT slug, company_id FROM projects WHERE id = $1',
			[projectId],
		);
		const companySlugResult = await db.query<{ slug: string }>(
			'SELECT slug FROM companies WHERE id = $1',
			[projectResult.rows[0]?.company_id],
		);

		if (projectResult.rows[0] && companySlugResult.rows[0]) {
			const workspacePath = getWorkspacePath(
				dataDir,
				companySlugResult.rows[0].slug,
				projectResult.rows[0].slug,
			);
			const masterKeyManager = c.get('masterKeyManager');
			const sshKey = await getCompanySSHKey(db, companyId, masterKeyManager);

			if (sshKey) {
				const targetDir = join(workspacePath, body.short_name);
				const cloneResult = await cloneRepo(repoIdentifier, targetDir, sshKey.privateKey);
				if (cloneResult.success) {
					cloneStatus = 'cloned';
				} else {
					cloneStatus = 'failed';
					cloneError = cloneResult.error ?? 'unknown error';
					log.error(`Failed to clone ${repoIdentifier}:`, cloneError);
				}
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
		const pc = await db.query<{ project_slug: string; company_slug: string }>(
			`SELECT p.slug AS project_slug, c.slug AS company_slug
			 FROM projects p JOIN companies c ON c.id = p.company_id
			 WHERE p.id = $1`,
			[projectId],
		);
		if (pc.rows[0]) {
			try {
				removeRepoFromWorkspace(
					dataDir,
					pc.rows[0].company_slug,
					pc.rows[0].project_slug,
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
