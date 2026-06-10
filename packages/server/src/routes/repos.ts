import { wsRoom } from '@hezo/shared';
import { type Context, Hono } from 'hono';
import { broadcastChange } from '../lib/broadcast';
import { getProjectLocator, resolveProjectId } from '../lib/resolve';
import { err, ok } from '../lib/response';
import { isUniqueViolation, withTransaction } from '../lib/sql';
import type { Env } from '../lib/types';
import { logger } from '../logger';
import { provisionContainer } from '../services/containers';
import { createGitHubRepo, parseGitHubUrl, validateRepoAccess } from '../services/github';
import { getConnection } from '../services/oauth/connection-store';
import { enqueueRepoSetupResumeWakeups, finalizePendingRepoSetup } from '../services/repo-setup';
import { ensureProjectRepos, removeRepoFromWorkspace } from '../services/repo-sync';

const log = logger.child('routes');

export const reposRoutes = new Hono<Env>();

reposRoutes.get('/projects/:projectId/repos', async (c) => {
	const teamId = c.get('teamId') as string;
	const db = c.get('db');
	const projectId = await resolveProjectId(db, teamId, c.req.param('projectId'));
	if (!projectId) return err(c, 'NOT_FOUND', 'Project not found', 404);

	const result = await db.query(
		`SELECT r.id, r.project_id, r.short_name, r.repo_identifier, r.host_type,
		        r.oauth_connection_id, r.created_at,
		        (p.designated_repo_id = r.id) AS is_designated,
		        oc.provider_account_label AS oauth_account_label
		 FROM repos r
		 JOIN projects p ON p.id = r.project_id
		 LEFT JOIN oauth_connections oc ON oc.id = r.oauth_connection_id
		 WHERE r.project_id = $1
		 ORDER BY r.created_at ASC`,
		[projectId],
	);

	return ok(c, result.rows);
});

/**
 * Add a GitHub repository to the project. The user must already have an
 * active GitHub OAuth connection for this team; the request supplies its
 * id, and the server validates access via the corresponding token before
 * recording the repo. Clones run over HTTPS, with the proxy substituting
 * the access-token placeholder at request time.
 */
reposRoutes.post('/projects/:projectId/repos', async (c) => {
	const teamId = c.get('teamId') as string;
	const db = c.get('db');
	const masterKeyManager = c.get('masterKeyManager');
	const projectId = await resolveProjectId(db, teamId, c.req.param('projectId'));
	if (!projectId) return err(c, 'NOT_FOUND', 'Project not found', 404);

	const body = await c.req.json<{
		short_name: string;
		mode?: 'link' | 'create';
		url?: string;
		owner?: string;
		name?: string;
		private?: boolean;
		oauth_connection_id: string;
	}>();

	if (!body.short_name?.trim()) {
		return err(c, 'INVALID_REQUEST', 'short_name is required', 400);
	}

	const mode = body.mode ?? 'link';
	let parsedOwner: string | null = null;
	let parsedRepo: string | null = null;
	if (mode === 'link') {
		if (!body.url?.trim()) return err(c, 'INVALID_REQUEST', 'url is required for mode=link', 400);
		const parsed = parseGitHubUrl(body.url);
		if (!parsed) return err(c, 'INVALID_URL', 'url must be a valid GitHub repository URL', 400);
		parsedOwner = parsed.owner;
		parsedRepo = parsed.repo;
	} else if (mode === 'create') {
		if (!body.owner?.trim() || !body.name?.trim()) {
			return err(c, 'INVALID_REQUEST', 'owner and name are required for mode=create', 400);
		}
	} else {
		return err(c, 'INVALID_REQUEST', 'mode must be "link" or "create"', 400);
	}

	if (!body.oauth_connection_id?.trim()) {
		return err(c, 'INVALID_REQUEST', 'oauth_connection_id is required', 400);
	}

	const conn = await getConnection({ db, masterKeyManager }, body.oauth_connection_id);
	if (!conn) return err(c, 'NOT_FOUND', 'oauth connection not found', 404);
	if (conn.provider !== 'github') {
		return err(c, 'INVALID_REQUEST', 'oauth connection is not for GitHub', 400);
	}

	const accessToken = await loadOAuthAccessToken(db, masterKeyManager, conn.id);
	if (!accessToken) {
		return err(c, 'OAUTH_TOKEN_UNAVAILABLE', 'master key locked or token missing', 503);
	}

	let owner: string;
	let repoName: string;

	if (mode === 'link') {
		owner = parsedOwner as string;
		repoName = parsedRepo as string;

		const access2 = await validateRepoAccess(owner, repoName, accessToken);
		if (!access2.accessible) {
			return err(
				c,
				'REPO_NOT_ACCESSIBLE',
				`cannot access ${owner}/${repoName} with this OAuth token (status ${access2.status})`,
				403,
			);
		}
	} else {
		let created: Awaited<ReturnType<typeof createGitHubRepo>>;
		try {
			created = await createGitHubRepo(body.owner!, body.name!, body.private ?? true, accessToken);
		} catch (e) {
			return err(c, 'REPO_CREATE_FAILED', (e as Error).message, 500);
		}
		if (created.status === 'already_exists') {
			return err(
				c,
				'GITHUB_REPO_EXISTS',
				`A repository named "${created.owner}/${created.name}" already exists on GitHub.`,
				409,
			);
		}
		owner = created.owner;
		repoName = created.name;
	}
	const repoIdentifier = `${owner}/${repoName}`;

	type InsertedRepo = {
		id: string;
		project_id: string;
		short_name: string;
		repo_identifier: string;
		host_type: string;
		oauth_connection_id: string | null;
		created_at: string;
	};
	const emptyFinalize: Awaited<ReturnType<typeof finalizePendingRepoSetup>> = {
		resolvedApprovalId: null,
		affectedTaskIds: [],
		deferredWakeups: [],
		approvalRow: null,
		updatedCommentRows: [],
		systemCommentRows: [],
	};

	let insertedRepo: InsertedRepo;
	let becameDesignated = false;
	let finalizeResult = emptyFinalize;

	try {
		const txResult = await withTransaction(db, async () => {
			const lockRes = await db.query<{ id: string; designated_repo_id: string | null }>(
				'SELECT id, designated_repo_id FROM projects WHERE id = $1 FOR UPDATE',
				[projectId],
			);
			if (lockRes.rows.length === 0) throw new Error('project disappeared during insert');
			const projectRow = lockRes.rows[0];

			const insertRes = await db.query<InsertedRepo>(
				`INSERT INTO repos (project_id, short_name, repo_identifier, host_type, oauth_connection_id)
				 VALUES ($1, $2, $3, 'github'::repo_host_type, $4)
				 RETURNING id, project_id, short_name, repo_identifier, host_type, oauth_connection_id, created_at`,
				[projectId, body.short_name.trim(), repoIdentifier, conn.id],
			);
			const inserted = insertRes.rows[0];

			let becameDesignated = false;
			let finalize = emptyFinalize;
			if (!projectRow.designated_repo_id) {
				await db.query('UPDATE projects SET designated_repo_id = $1 WHERE id = $2', [
					inserted.id,
					projectId,
				]);
				becameDesignated = true;

				finalize = await finalizePendingRepoSetup(db, {
					teamId,
					projectId,
					repoId: inserted.id,
					repoIdentifier,
					shortName: inserted.short_name,
				});
			}
			return { inserted, becameDesignated, finalize };
		});
		insertedRepo = txResult.inserted;
		becameDesignated = txResult.becameDesignated;
		finalizeResult = txResult.finalize;
	} catch (e) {
		if (isUniqueViolation(e)) {
			return err(c, 'SHORT_NAME_TAKEN', `short_name "${body.short_name}" already used`, 409);
		}
		const msg = e instanceof Error ? e.message : 'Failed to insert repo';
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
					team_id: teamId,
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
				teamId,
				insertedRepo.id,
				finalizeResult.resolvedApprovalId,
				finalizeResult.deferredWakeups,
			);
		}
	}

	broadcastChange(c, wsRoom.team(teamId), 'repos', 'INSERT', {
		...insertedRepo,
		is_designated: becameDesignated,
	} as Record<string, unknown>);

	if (becameDesignated) {
		broadcastChange(c, wsRoom.team(teamId), 'projects', 'UPDATE', {
			id: projectId,
			designated_repo_id: insertedRepo.id,
		});
		if (finalizeResult.approvalRow) {
			broadcastChange(c, wsRoom.team(teamId), 'approvals', 'UPDATE', finalizeResult.approvalRow);
		}
		for (const row of finalizeResult.updatedCommentRows) {
			broadcastChange(c, wsRoom.team(teamId), 'task_comments', 'UPDATE', row);
		}
		for (const row of finalizeResult.systemCommentRows) {
			broadcastChange(c, wsRoom.team(teamId), 'task_comments', 'INSERT', row);
		}
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

reposRoutes.delete('/projects/:projectId/repos/:repoId', async (c) => {
	const teamId = c.get('teamId') as string;
	const db = c.get('db');
	const projectId = await resolveProjectId(db, teamId, c.req.param('projectId'));
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
				removeRepoFromWorkspace(dataDir, locator.teamId, locator.id, result.rows[0].short_name);
			} catch (error) {
				log.error(`Failed to clean up workspace for repo ${result.rows[0].short_name}:`, error);
			}
		}
	}

	broadcastChange(c, wsRoom.team(teamId), 'repos', 'DELETE', { id: repoId });
	return ok(c, { deleted: true });
});

reposRoutes.get('/projects/:projectId/oauth-connections/:id/orgs', async (c) => {
	const teamId = c.get('teamId') as string;
	const db = c.get('db');
	const masterKeyManager = c.get('masterKeyManager');
	const conn = await getConnection({ db, masterKeyManager }, c.req.param('id'));
	if (!conn || conn.provider !== 'github')
		return err(c, 'NOT_FOUND', 'github connection not found', 404);

	const token = await loadOAuthAccessToken(db, masterKeyManager, conn.id);
	if (!token) return err(c, 'OAUTH_TOKEN_UNAVAILABLE', 'token unavailable', 503);

	const { listUserOrgs } = await import('../services/github');
	const orgs = await listUserOrgs(token);
	return ok(c, orgs);
});

reposRoutes.get('/projects/:projectId/oauth-connections/:id/repos', async (c) => {
	const teamId = c.get('teamId') as string;
	const owner = c.req.query('owner');
	const query = c.req.query('q') ?? undefined;
	if (!owner) return err(c, 'INVALID_REQUEST', 'owner query parameter is required', 400);
	const db = c.get('db');
	const masterKeyManager = c.get('masterKeyManager');
	const conn = await getConnection({ db, masterKeyManager }, c.req.param('id'));
	if (!conn || conn.provider !== 'github')
		return err(c, 'NOT_FOUND', 'github connection not found', 404);
	const token = await loadOAuthAccessToken(db, masterKeyManager, conn.id);
	if (!token) return err(c, 'OAUTH_TOKEN_UNAVAILABLE', 'token unavailable', 503);

	const { listAccessibleRepos } = await import('../services/github');
	const repos = await listAccessibleRepos(owner, query, token);
	return ok(c, repos);
});

async function loadOAuthAccessToken(
	db: import('@electric-sql/pglite').PGlite,
	masterKeyManager: import('../crypto/master-key').MasterKeyManager,
	oauthConnectionId: string,
): Promise<string | null> {
	const key = masterKeyManager.getKey();
	if (!key) return null;
	const result = await db.query<{ encrypted_value: string }>(
		`SELECT s.encrypted_value
		 FROM oauth_connections oc
		 JOIN secrets s ON s.id = oc.access_token_secret_id
		 WHERE oc.id = $1`,
		[oauthConnectionId],
	);
	if (result.rows.length === 0) return null;
	const { decrypt } = await import('../crypto/encryption');
	return decrypt(result.rows[0].encrypted_value, key);
}

async function ensureProjectContainerUp(c: Context<Env>, projectId: string): Promise<void> {
	const db = c.get('db');
	const docker = c.get('docker');
	const dataDir = c.get('dataDir');
	const masterKeyManager = c.get('masterKeyManager');
	const wsManager = c.get('wsManager');
	const logs = c.get('logs');
	const containerLogStreamer = c.get('containerLogStreamer');
	const sshAgentServer = c.get('sshAgentServer');
	const egressProxy = c.get('egressProxy');

	if (!docker || !dataDir) return;

	const projectRes = await db.query<{
		id: string;
		team_id: string;
		slug: string;
		docker_base_image: string;
		container_id: string | null;
		container_status: string | null;
		dev_ports: Array<{ container: number; host: number }>;
		team_slug: string;
	}>(
		`SELECT p.id, p.team_id, p.slug, p.docker_base_image, p.container_id, p.container_status,
		        p.dev_ports, c.slug AS team_slug
		 FROM projects p JOIN teams c ON c.id = p.team_id
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
				containerLogStreamer,
				sshAgentServer,
				egressCAPath: egressProxy?.caCertPath ?? null,
			},
			proj,
			proj.team_slug,
		);
	} catch (e) {
		log.error('Failed to auto-start container after repo add:', e);
	}
}
