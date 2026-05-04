import { wsRoom } from '@hezo/shared';
import { type Context, Hono } from 'hono';
import { broadcastChange } from '../lib/broadcast';
import { getProjectLocator, resolveProjectId } from '../lib/resolve';
import { err, ok } from '../lib/response';
import type { Env } from '../lib/types';
import { logger } from '../logger';
import { requireCompanyAccess } from '../middleware/auth';
import { provisionContainer } from '../services/containers';
import { parseGitHubUrl } from '../services/github';
import { enqueueRepoSetupResumeWakeups, finalizePendingRepoSetup } from '../services/repo-setup';
import { ensureProjectRepos, removeRepoFromWorkspace } from '../services/repo-sync';

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

/**
 * Add a GitHub repository to the project. The user supplies a GitHub URL
 * (HTTPS or SSH form, or `owner/repo`); the server records the repo, lets
 * the agent's `setup_github_repo` MCP tool drive deploy-key onboarding,
 * and clones over SSH using the per-run signing socket.
 */
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
		url: string;
	}>();

	if (!body.short_name?.trim()) {
		return err(c, 'INVALID_REQUEST', 'short_name is required', 400);
	}
	if (!body.url?.trim()) {
		return err(c, 'INVALID_REQUEST', 'url is required', 400);
	}

	const parsed = parseGitHubUrl(body.url);
	if (!parsed) {
		return err(
			c,
			'INVALID_URL',
			'url must be a valid GitHub repository URL (https://github.com/owner/repo or git@github.com:owner/repo.git or owner/repo)',
			400,
		);
	}
	const repoIdentifier = `${parsed.owner}/${parsed.repo}`;

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
			[projectId, body.short_name.trim(), repoIdentifier],
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
				c.get('sshAgentServer'),
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

	broadcastChange(c, wsRoom.company(companyId), 'repos', 'INSERT', {
		...insertedRepo,
		is_designated: becameDesignated,
	} as Record<string, unknown>);

	if (becameDesignated) {
		broadcastChange(c, wsRoom.company(companyId), 'projects', 'UPDATE', {
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

	broadcastChange(c, wsRoom.company(companyId), 'repos', 'DELETE', { id: repoId });
	return ok(c, { deleted: true });
});

async function ensureProjectContainerUp(c: Context<Env>, projectId: string): Promise<void> {
	const db = c.get('db');
	const docker = c.get('docker');
	const dataDir = c.get('dataDir');
	const masterKeyManager = c.get('masterKeyManager');
	const wsManager = c.get('wsManager');
	const logs = c.get('logs');
	const sshAgentServer = c.get('sshAgentServer');
	const egressProxy = c.get('egressProxy');

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
	const proj = projectRes.rows[0];
	if (proj.container_status === 'running') return;

	try {
		await provisionContainer(
			{
				db,
				docker,
				dataDir,
				wsManager,
				masterKeyManager,
				logs,
				sshAgentServer,
				egressCAPath: egressProxy?.caCertPath ?? null,
			},
			proj,
			proj.company_slug,
		);
	} catch (e) {
		log.error('Failed to auto-start container after repo add:', e);
	}
}
