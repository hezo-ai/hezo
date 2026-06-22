import { repoNameFromIdentifier, wsRoom } from '@hezo/shared';
import { type Context, Hono } from 'hono';
import { broadcastChange } from '../lib/broadcast';
import { getProjectLocator, resolveProjectId } from '../lib/resolve';
import { err, ok } from '../lib/response';
import { isUniqueViolation, withTransaction } from '../lib/sql';
import type { Env } from '../lib/types';
import { logger } from '../logger';
import { provisionContainer } from '../services/containers';
import { ContainerGitExecutor } from '../services/git-executor';
import { createGitHubRepo, parseGitHubUrl, validateRepoAccess } from '../services/github';
import { getConnection } from '../services/oauth/connection-store';
import {
	enqueueRepoSetupResumeWakeups,
	finalizePendingRepoSetup,
	markRepoSetupFailed,
} from '../services/repo-setup';
import { ensureProjectRepos, removeRepoFromWorkspace } from '../services/repo-sync';
import { type BridgeRunnerArgs, withProvisionBridge } from '../services/ssh-agent';

const log = logger.child('routes');

export const reposRoutes = new Hono<Env>();

reposRoutes.get('/projects/:projectId/repos', async (c) => {
	const teamId = c.get('teamId') as string;
	const db = c.get('db');
	const projectId = await resolveProjectId(db, teamId, c.req.param('projectId'));
	if (!projectId) return err(c, 'NOT_FOUND', 'Project not found', 404);

	const result = await db.query(
		`SELECT r.id, r.project_id, r.repo_identifier, r.host_type,
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
		mode?: 'link' | 'create';
		url?: string;
		owner?: string;
		name?: string;
		private?: boolean;
		oauth_connection_id: string;
	}>();

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
	// Whether this repo would become the project's designated repo once its
	// checkout is in place. Designation is deferred until the clone/init
	// succeeds so a setup failure never leaves the gate half-open.
	let wouldDesignate = false;

	try {
		const txResult = await withTransaction(db, async () => {
			const lockRes = await db.query<{ id: string; designated_repo_id: string | null }>(
				'SELECT id, designated_repo_id FROM projects WHERE id = $1 FOR UPDATE',
				[projectId],
			);
			if (lockRes.rows.length === 0) throw new Error('project disappeared during insert');
			const projectRow = lockRes.rows[0];

			const insertRes = await db.query<InsertedRepo>(
				`INSERT INTO repos (project_id, repo_identifier, host_type, oauth_connection_id)
				 VALUES ($1, $2, 'github'::repo_host_type, $3)
				 RETURNING id, project_id, repo_identifier, host_type, oauth_connection_id, created_at`,
				[projectId, repoIdentifier, conn.id],
			);
			return { inserted: insertRes.rows[0], wouldDesignate: !projectRow.designated_repo_id };
		});
		insertedRepo = txResult.inserted;
		wouldDesignate = txResult.wouldDesignate;
	} catch (e) {
		if (isUniqueViolation(e)) {
			return err(
				c,
				'REPO_NAME_TAKEN',
				`a repository named "${repoName}" is already linked to this project`,
				409,
			);
		}
		const msg = e instanceof Error ? e.message : 'Failed to insert repo';
		return err(c, 'REPO_INSERT_FAILED', msg, 500);
	}

	const dataDir = c.get('dataDir');
	const docker = c.get('docker');
	let cloneStatus: 'skipped' | 'cloned' | 'failed' = 'skipped';
	let cloneError: string | undefined;

	if (dataDir && docker) {
		const locator = await getProjectLocator(db, projectId);
		if (locator) {
			// Git runs inside the project container, so bring it up first (provisioning
			// clones if it had to provision), then clone in-container. The host runs no git.
			await ensureProjectContainerUp(c, projectId);
			const containerRow = await db.query<{
				container_id: string | null;
				container_status: string | null;
			}>('SELECT container_id, container_status FROM projects WHERE id = $1', [projectId]);
			const containerId = containerRow.rows[0]?.container_id ?? null;
			const running = containerRow.rows[0]?.container_status === 'running';
			const sshAgentServer = c.get('sshAgentServer');

			if (containerId && running) {
				const syncRepos = (bridge: BridgeRunnerArgs | null) =>
					ensureProjectRepos(
						db,
						{ id: projectId, team_id: teamId },
						dataDir,
						ContainerGitExecutor.forPrep(docker, containerId, bridge),
					);
				const syncRes = sshAgentServer
					? await withProvisionBridge(sshAgentServer, teamId, dataDir, ({ bridge }) =>
							syncRepos(bridge),
						)
					: await syncRepos(null);
				const failed = syncRes.failed.find((f) => f.name === repoName);
				if (failed) {
					cloneStatus = 'failed';
					cloneError = failed.error;
					log.error(`Failed to clone ${repoIdentifier}:`, cloneError);
				} else if (syncRes.cloned.includes(repoName)) {
					cloneStatus = 'cloned';
				}
			} else {
				cloneStatus = 'failed';
				cloneError = 'project container is not running';
				log.error(`Cannot clone ${repoIdentifier}: container not running`);
			}
		}
	}

	if (wouldDesignate) {
		if (cloneStatus === 'failed') {
			// Setup never produced a usable checkout. Don't designate or persist the
			// repo; tell the operator on the gated task(s) and leave the approval
			// pending so a fixed retry resolves it. Agents stay correctly parked.
			const failure = await markRepoSetupFailed(db, {
				teamId,
				projectId,
				repoIdentifier,
				error: cloneError ?? 'unknown error',
			});
			await db.query('DELETE FROM repos WHERE id = $1', [insertedRepo.id]);
			for (const row of failure.systemCommentRows) {
				broadcastChange(c, wsRoom.team(teamId), 'task_comments', 'INSERT', row);
			}
			return err(
				c,
				'REPO_SETUP_FAILED',
				`Failed to set up ${repoIdentifier}: ${cloneError ?? 'unknown error'}`,
				500,
			);
		}

		finalizeResult = await withTransaction(db, async () => {
			await db.query('UPDATE projects SET designated_repo_id = $1 WHERE id = $2', [
				insertedRepo.id,
				projectId,
			]);
			return finalizePendingRepoSetup(db, {
				teamId,
				projectId,
				repoId: insertedRepo.id,
				repoIdentifier,
			});
		});
		becameDesignated = true;

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

	const result = await db.query<{ id: string; repo_identifier: string }>(
		'DELETE FROM repos WHERE id = $1 AND project_id = $2 RETURNING id, repo_identifier',
		[repoId, projectId],
	);

	if (result.rows.length === 0) {
		return err(c, 'NOT_FOUND', 'Repo not found', 404);
	}

	const dataDir = c.get('dataDir');
	if (dataDir) {
		const locator = await getProjectLocator(db, projectId);
		if (locator) {
			const repoName = repoNameFromIdentifier(result.rows[0].repo_identifier);
			try {
				removeRepoFromWorkspace(dataDir, locator.teamId, locator.id, repoName);
			} catch (error) {
				log.error(`Failed to clean up workspace for repo ${repoName}:`, error);
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
