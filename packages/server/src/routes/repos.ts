import { ApprovalType, OAuthRequestReason, PlatformType } from '@hezo/shared';
import { type Context, Hono } from 'hono';
import { broadcastChange } from '../lib/broadcast';
import { getProjectLocator, resolveProjectId } from '../lib/resolve';
import { err, ok } from '../lib/response';
import type { Env } from '../lib/types';
import { logger } from '../logger';
import { requireCompanyAccess } from '../middleware/auth';
import { provisionContainer } from '../services/containers';
import {
	createGitHubRepo,
	listUserOrgs,
	parseGitHubUrl,
	validateRepoAccess,
} from '../services/github';
import { enqueueRepoSetupResumeWakeups, finalizePendingRepoSetup } from '../services/repo-setup';
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
		`SELECT r.id, r.project_id, r.short_name, r.repo_identifier, r.host_type, r.created_at,
		        (p.designated_repo_id = r.id) AS is_designated
		 FROM repos r
		 JOIN projects p ON p.id = r.project_id
		 WHERE r.project_id = $1
		 ORDER BY r.created_at ASC`,
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

	const body = await c.req.json<{
		short_name: string;
		mode?: 'link' | 'create';
		url?: string;
		owner?: string;
		name?: string;
		private?: boolean;
	}>();

	const mode = body.mode ?? 'link';
	if (!body.short_name) return err(c, 'INVALID_REQUEST', 'short_name is required', 400);

	if (mode === 'link') {
		if (!body.url) return err(c, 'INVALID_REQUEST', 'url is required for mode=link', 400);
		if (!parseGitHubUrl(body.url)) {
			return err(c, 'INVALID_URL', 'URL must be a valid GitHub repository URL', 400);
		}
	} else if (mode === 'create') {
		if (!body.owner || !body.name) {
			return err(c, 'INVALID_REQUEST', 'owner and name are required for mode=create', 400);
		}
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
				JSON.stringify({
					platform: PlatformType.GitHub,
					reason: OAuthRequestReason.RepoAdd,
					project_id: projectId,
				}),
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

	let repoOwner: string;
	let repoName: string;

	if (mode === 'create') {
		const owner = body.owner ?? '';
		const name = body.name ?? '';
		const orgs = await listUserOrgs(token);
		const ownerAllowed = orgs.some((o) => o.login.toLowerCase() === owner.toLowerCase());
		if (!ownerAllowed) {
			return err(
				c,
				'OWNER_NOT_ACCESSIBLE',
				`The authenticated GitHub user cannot create repos under ${owner}`,
				403,
			);
		}

		try {
			const created = await createGitHubRepo(owner, name, body.private !== false, token);
			repoOwner = created.owner;
			repoName = created.name;
		} catch (e) {
			const msg = e instanceof Error ? e.message : 'Failed to create GitHub repo';
			return err(c, 'REPO_CREATE_FAILED', msg, 422);
		}
	} else {
		const parsed = parseGitHubUrl(body.url ?? '');
		if (!parsed) {
			return err(c, 'INVALID_URL', 'URL must be a valid GitHub repository URL', 400);
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

		repoOwner = parsed.owner;
		repoName = parsed.repo;
	}

	const repoIdentifier = `${repoOwner}/${repoName}`;

	let insertedRepo: {
		id: string;
		project_id: string;
		short_name: string;
		repo_identifier: string;
		host_type: string;
		created_at: string;
	};
	let becameDesignated = false;
	let finalizeResult: Awaited<ReturnType<typeof finalizePendingRepoSetup>> = {
		resolvedApprovalId: null,
		affectedIssueIds: [],
		deferredWakeups: [],
	};

	await db.query('BEGIN');
	try {
		const lockRes = await db.query<{ id: string; designated_repo_id: string | null }>(
			'SELECT id, designated_repo_id FROM projects WHERE id = $1 FOR UPDATE',
			[projectId],
		);
		if (lockRes.rows.length === 0) throw new Error('project disappeared during insert');
		const projectRow = lockRes.rows[0];

		const insertRes = await db.query<typeof insertedRepo>(
			`INSERT INTO repos (project_id, short_name, repo_identifier, host_type)
			 VALUES ($1, $2, $3, 'github'::repo_host_type)
			 RETURNING id, project_id, short_name, repo_identifier, host_type, created_at`,
			[projectId, body.short_name, repoIdentifier],
		);
		insertedRepo = insertRes.rows[0];

		if (!projectRow.designated_repo_id) {
			await db.query('UPDATE projects SET designated_repo_id = $1 WHERE id = $2', [
				insertedRepo.id,
				projectId,
			]);
			becameDesignated = true;

			finalizeResult = await finalizePendingRepoSetup(db, {
				companyId,
				projectId,
				repoId: insertedRepo.id,
				repoIdentifier,
				shortName: insertedRepo.short_name,
			});
		}

		await db.query('COMMIT');
	} catch (e) {
		await db.query('ROLLBACK');
		const msg = e instanceof Error ? e.message : 'Failed to insert repo';
		if (msg.includes('unique') || msg.includes('duplicate')) {
			return err(c, 'SHORT_NAME_TAKEN', `short_name "${body.short_name}" already used`, 409);
		}
		return err(c, 'REPO_INSERT_FAILED', msg, 500);
	}

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
			const failed = syncRes.failed.find((f) => f.short_name === insertedRepo.short_name);
			if (failed) {
				cloneStatus = 'failed';
				cloneError = failed.error;
				log.error(`Failed to clone ${repoIdentifier}:`, cloneError);
			} else if (syncRes.cloned.includes(insertedRepo.short_name)) {
				cloneStatus = 'cloned';
			}
		}
	}

	if (becameDesignated && cloneStatus !== 'failed') {
		await ensureProjectContainerUp(c, projectId);
		if (finalizeResult.resolvedApprovalId) {
			await enqueueRepoSetupResumeWakeups(
				db,
				companyId,
				insertedRepo.id,
				finalizeResult.resolvedApprovalId,
				finalizeResult.deferredWakeups,
			);
		}
	}

	broadcastChange(c, `company:${companyId}`, 'repos', 'INSERT', {
		...insertedRepo,
		is_designated: becameDesignated,
	} as Record<string, unknown>);

	if (becameDesignated) {
		broadcastChange(c, `company:${companyId}`, 'projects', 'UPDATE', {
			id: projectId,
			designated_repo_id: insertedRepo.id,
		});
	}

	return ok(
		c,
		{
			...insertedRepo,
			is_designated: becameDesignated,
			clone_status: cloneStatus,
			clone_error: cloneError ?? null,
		},
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

	const project = await db.query<{ designated_repo_id: string | null }>(
		'SELECT designated_repo_id FROM projects WHERE id = $1',
		[projectId],
	);
	if (project.rows.length === 0) return err(c, 'NOT_FOUND', 'Project not found', 404);
	if (project.rows[0].designated_repo_id === repoId) {
		return err(c, 'DESIGNATED_REPO_IMMUTABLE', 'The designated repository cannot be removed', 409);
	}

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

async function ensureProjectContainerUp(c: Context<Env>, projectId: string): Promise<void> {
	const db = c.get('db');
	const docker = c.get('docker');
	const dataDir = c.get('dataDir');
	const masterKeyManager = c.get('masterKeyManager');
	const wsManager = c.get('wsManager');
	const logs = c.get('logs');

	if (!docker || !dataDir) return;

	const projectRes = await db.query<{
		id: string;
		company_id: string;
		slug: string;
		docker_base_image: string;
		container_id: string | null;
		container_status: string | null;
		dev_ports: Array<{ container: number; host: number }>;
		company_slug: string;
	}>(
		`SELECT p.id, p.company_id, p.slug, p.docker_base_image, p.container_id, p.container_status,
		        p.dev_ports, c.slug AS company_slug
		 FROM projects p JOIN companies c ON c.id = p.company_id
		 WHERE p.id = $1`,
		[projectId],
	);
	if (projectRes.rows.length === 0) return;
	const project = projectRes.rows[0];

	if (project.container_status === 'running' && project.container_id) return;

	try {
		await provisionContainer(
			{ db, docker, dataDir, wsManager, masterKeyManager, logs },
			{
				id: project.id,
				company_id: project.company_id,
				slug: project.slug,
				docker_base_image: project.docker_base_image,
				container_id: project.container_id,
				container_status: project.container_status,
				dev_ports: project.dev_ports,
			},
			project.company_slug,
		);
	} catch (e) {
		log.error(`Failed to provision container for project ${projectId}:`, e);
	}
}
