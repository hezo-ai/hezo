import { RepoSetupStatus, repoNameFromIdentifier, wsRoom } from '@hezo/shared';
import { Hono } from 'hono';
import { trackBackground } from '../lib/background';
import { broadcastChange } from '../lib/broadcast';
import { getProjectLocator, resolveProjectId } from '../lib/resolve';
import { err, ok } from '../lib/response';
import { isUniqueViolation } from '../lib/sql';
import type { Env } from '../lib/types';
import { logger } from '../logger';
import type { ContainerDeps } from '../services/containers';
import { createGitHubRepo, parseGitHubUrl, validateRepoAccess } from '../services/github';
import { getConnection } from '../services/oauth/connection-store';
import { performRepoSetup } from '../services/repo-provisioning';
import { removeRepoFromWorkspace } from '../services/repo-sync';

const log = logger.child('routes');

export const reposRoutes = new Hono<Env>();

reposRoutes.get('/projects/:projectId/repos', async (c) => {
	const teamId = c.get('teamId') as string;
	const db = c.get('db');
	const projectId = await resolveProjectId(db, teamId, c.req.param('projectId'));
	if (!projectId) return err(c, 'NOT_FOUND', 'Project not found', 404);

	const result = await db.query(
		`SELECT r.id, r.project_id, r.repo_identifier, r.host_type,
		        r.oauth_connection_id, r.created_at, r.setup_status, r.setup_error,
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
 * id, and the server validates access (mode=link) or creates the repo on
 * GitHub (mode=create) via the corresponding token before recording the row.
 * The row is returned `pending`; the checkout itself (container up +
 * in-container clone + first-repo designation) settles in the background —
 * see `performRepoSetup`.
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
		setup_status: string;
		setup_error: string | null;
	};
	const REPO_COLUMNS = `id, project_id, repo_identifier, host_type, oauth_connection_id,
	                      created_at, setup_status, setup_error`;

	// The row is inserted `pending` and the response returns immediately; the
	// slow half (container up + in-container clone + first-repo designation)
	// runs in the background and settles the row to ready/failed, broadcast to
	// the team room. Holding the request open for that work is not an option —
	// it can take minutes (image pull, provisioning), which outlives HTTP
	// timeouts, and a connection or server death mid-flight used to strand a
	// half-set-up row that 409'd every retry.
	let insertedRepo: InsertedRepo;
	try {
		const insertRes = await db.query<InsertedRepo>(
			`INSERT INTO repos (project_id, repo_identifier, host_type, oauth_connection_id, setup_status)
			 VALUES ($1, $2, 'github'::repo_host_type, $3, $4::repo_setup_status)
			 RETURNING ${REPO_COLUMNS}`,
			[projectId, repoIdentifier, conn.id, RepoSetupStatus.Pending],
		);
		insertedRepo = insertRes.rows[0];
	} catch (e) {
		if (!isUniqueViolation(e)) {
			const msg = e instanceof Error ? e.message : 'Failed to insert repo';
			return err(c, 'REPO_INSERT_FAILED', msg, 500);
		}
		// A repo with this name is already on the project. A `failed` row for the
		// same repo is a retry: reclaim it to pending and run setup again (rows
		// stranded pending by a restart are marked failed at startup, so a live
		// `pending` row really is in flight).
		const existing = await db.query<InsertedRepo>(
			`SELECT ${REPO_COLUMNS} FROM repos
			 WHERE project_id = $1 AND split_part(repo_identifier, '/', 2) = $2`,
			[projectId, repoName],
		);
		const row = existing.rows[0];
		if (
			!row ||
			row.repo_identifier !== repoIdentifier ||
			row.setup_status === RepoSetupStatus.Ready
		) {
			return err(
				c,
				'REPO_NAME_TAKEN',
				`a repository named "${repoName}" is already linked to this project`,
				409,
			);
		}
		const reclaimed = await db.query<InsertedRepo>(
			`UPDATE repos
			 SET setup_status = $1::repo_setup_status, setup_error = NULL, oauth_connection_id = $2
			 WHERE id = $3 AND setup_status = $4::repo_setup_status
			 RETURNING ${REPO_COLUMNS}`,
			[RepoSetupStatus.Pending, conn.id, row.id, RepoSetupStatus.Failed],
		);
		if (reclaimed.rows.length === 0) {
			return err(c, 'REPO_SETUP_IN_PROGRESS', `${repoIdentifier} is already being set up`, 409);
		}
		insertedRepo = reclaimed.rows[0];
	}

	const dataDir = c.get('dataDir');
	const docker = c.get('docker');
	const setupDeps: Omit<ContainerDeps, 'docker' | 'dataDir'> = {
		db,
		wsManager: c.get('wsManager'),
		masterKeyManager: c.get('masterKeyManager'),
		logs: c.get('logs'),
		containerLogStreamer: c.get('containerLogStreamer'),
		sshAgentServer: c.get('sshAgentServer'),
		egressCAPath: c.get('egressProxy')?.caCertPath ?? null,
	};
	trackBackground(
		performRepoSetup(
			{ ...setupDeps, docker, dataDir },
			{ teamId, projectId, repoId: insertedRepo.id, repoIdentifier },
		).catch((e) => log.error(`Background repo setup for ${repoIdentifier} failed:`, e)),
	);

	broadcastChange(c, wsRoom.team(teamId), 'repos', 'INSERT', {
		...insertedRepo,
		is_designated: false,
	} as Record<string, unknown>);

	return ok(c, { ...insertedRepo, is_designated: false }, 201);
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
	db: import('../db/database').Db,
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
