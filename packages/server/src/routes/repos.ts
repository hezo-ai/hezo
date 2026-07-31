import { join } from 'node:path';
import { ContainerStatus, RepoSetupStatus, repoNameFromIdentifier, wsRoom } from '@hezo/shared';
import { Hono } from 'hono';
import { trackBackground } from '../lib/background';
import { broadcastChange } from '../lib/broadcast';
import { withProjectGitLock } from '../lib/git-lock';
import { getProjectLocator, resolveProjectId } from '../lib/resolve';
import { err, ok } from '../lib/response';
import { isUniqueViolation } from '../lib/sql';
import type { Env } from '../lib/types';
import { logger } from '../logger';
import { requireSuperuser } from '../middleware/auth';
import { resolveContainerRunUser } from '../services/container-user';
import type { ContainerDeps } from '../services/containers';
import {
	getCloneState,
	getWorktreeState,
	listWorktrees,
	type RepoLoc,
	resetCloneToOrigin,
	type WorktreeLoc,
} from '../services/git';
import { ContainerGitExecutor, mintGitOpScopeId } from '../services/git-executor';
import { createGitHubRepo, parseGitHubUrl, validateRepoAccess } from '../services/github';
import { getConnection } from '../services/oauth/connection-store';
import { performRepoSetup } from '../services/repo-provisioning';
import { refreshRepoPushAccess } from '../services/repo-push-access';
import { removeRepoFromWorkspace } from '../services/repo-sync';
import { countActiveRunsInProject } from '../services/run-concurrency';
import { collectFinishedWorktrees } from '../services/sandbox/worktree-gc';
import { type BridgeRunnerArgs, withProvisionBridge } from '../services/ssh-agent';
import {
	CONTAINER_WORKSPACE_ROOT,
	CONTAINER_WORKTREES_ROOT,
	getWorkspacePath,
	getWorktreesPath,
} from '../services/workspace';

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
		        r.can_push,
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
	if (!conn || (conn.projectId !== null && conn.projectId !== projectId)) {
		return err(c, 'NOT_FOUND', 'oauth connection not found', 404);
	}
	if (conn.provider !== 'github') {
		return err(c, 'INVALID_REQUEST', 'oauth connection is not for GitHub', 400);
	}

	const accessToken = await loadOAuthAccessToken(db, masterKeyManager, conn.id);
	if (!accessToken) {
		return err(c, 'OAUTH_TOKEN_UNAVAILABLE', 'master key locked or token missing', 503);
	}

	let owner: string;
	let repoName: string;
	// Whether the connected account can push. A read-only repo is still a valid
	// link — agents read connected repos from disk — so this never blocks the
	// link; it is recorded so the repo card and the agent's Repository prompt
	// block can say so up front instead of the gap surfacing as a silently
	// denied push mid-run. `null` = unknown (see `repos.can_push`).
	let canPush: boolean | null;

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
		canPush = access2.canPush;
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
		// We just created it through this token's account, so it can push.
		canPush = true;
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
		can_push: boolean | null;
	};
	const REPO_COLUMNS = `id, project_id, repo_identifier, host_type, oauth_connection_id,
	                      created_at, setup_status, setup_error, can_push`;

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
			`INSERT INTO repos (project_id, repo_identifier, host_type, oauth_connection_id, setup_status, can_push)
			 VALUES ($1, $2, 'github'::repo_host_type, $3, $4::repo_setup_status, $5)
			 RETURNING ${REPO_COLUMNS}`,
			[projectId, repoIdentifier, conn.id, RepoSetupStatus.Pending, canPush],
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
			 SET setup_status = $1::repo_setup_status, setup_error = NULL, oauth_connection_id = $2,
			     can_push = $5
			 WHERE id = $3 AND setup_status = $4::repo_setup_status
			 RETURNING ${REPO_COLUMNS}`,
			[RepoSetupStatus.Pending, conn.id, row.id, RepoSetupStatus.Failed, canPush],
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

/**
 * Admin-only live git state for one repository's clone: the default branch, HEAD,
 * clean/dirty, ahead/behind origin (all read locally — no network fetch), plus the
 * active per-task worktrees. Git runs inside the project container, so this
 * requires the container running; a stopped container returns
 * `{ container_running: false }` rather than auto-starting one (a passive inspect
 * must never trigger a minutes-long provision). Reads run under the project git
 * lock so they never interleave with a run's worktree prep on the shared `.git`.
 */
reposRoutes.get('/projects/:projectId/repos/:repoId/git-state', async (c) => {
	const denied = requireSuperuser(c);
	if (denied) return denied;

	const teamId = c.get('teamId') as string;
	const db = c.get('db');
	const projectId = await resolveProjectId(db, teamId, c.req.param('projectId'));
	if (!projectId) return err(c, 'NOT_FOUND', 'Project not found', 404);
	const dataDir = c.get('dataDir');
	if (!dataDir)
		return err(c, 'GIT_STATE_UNSUPPORTED', 'git state unavailable in this deployment', 400);

	const repo = await loadRepoForGit(db, dataDir, teamId, projectId, c.req.param('repoId'));
	if (!repo) return err(c, 'NOT_FOUND', 'Repo not found', 404);

	// Re-check the connected account's write access here rather than trusting
	// link-time truth — a permission change on GitHub is otherwise invisible
	// until an agent's push is denied. Needs no container, so it runs before the
	// container-gated branch below and is reported either way.
	const canPush = await refreshRepoPushAccess(
		{ db, masterKeyManager: c.get('masterKeyManager') },
		repo.repoId,
	);

	if (!repo.containerId || !repo.containerRunning) {
		return ok(c, { container_running: false, can_push: canPush });
	}
	const containerId = repo.containerId;

	const docker = c.get('docker');
	const runUser = await resolveContainerRunUser(docker, containerId);
	const executor = ContainerGitExecutor.forPrep(
		docker,
		containerId,
		null,
		runUser,
		mintGitOpScopeId(),
	);
	const worktreesPath = getWorktreesPath(dataDir, teamId, projectId);
	const wtPrefix = `${CONTAINER_WORKTREES_ROOT}/`;

	const state = await withProjectGitLock(projectId, async () => {
		const clone = await getCloneState(executor, repo.repoLoc);
		const entries = await listWorktrees(executor, repo.repoLoc);
		const worktrees: {
			taskIdentifier: string;
			branch: string | null;
			head: string | null;
			dirty: boolean;
		}[] = [];
		for (const entry of entries) {
			// Skip the main worktree (the clone itself, under /workspace/<repo>); only
			// list the per-task worktrees under /worktrees/<taskId>/<repo>.
			if (!entry.path.startsWith(wtPrefix)) continue;
			const taskIdentifier = entry.path.slice(wtPrefix.length).split('/')[0];
			if (!taskIdentifier) continue;
			const wtLoc: WorktreeLoc = {
				hostPath: join(worktreesPath, taskIdentifier, repo.repoName),
				containerPath: entry.path,
			};
			const wt = await getWorktreeState(executor, wtLoc);
			worktrees.push({
				taskIdentifier,
				branch: entry.branch ? entry.branch.replace(/^refs\/heads\//, '') : null,
				head: wt.head,
				dirty: wt.dirty,
			});
		}
		return { clone, worktrees };
	});

	// Attach each worktree's task title/status in one query.
	const identifiers = [...new Set(state.worktrees.map((w) => w.taskIdentifier))];
	const taskMap = new Map<string, { title: string; status: string }>();
	if (identifiers.length > 0) {
		const tasks = await db.query<{ identifier: string; title: string; status: string }>(
			'SELECT identifier, title, status FROM tasks WHERE project_id = $1 AND identifier = ANY($2)',
			[projectId, identifiers],
		);
		for (const t of tasks.rows) taskMap.set(t.identifier, { title: t.title, status: t.status });
	}

	// Reset actions are blocked while any run is active on the project; surface the
	// count so the panel can gate its buttons instead of failing the reset reactively.
	const active = await countActiveRunsInProject(db, projectId);

	return ok(c, {
		container_running: true,
		can_push: canPush,
		clone: state.clone,
		worktrees: state.worktrees.map((w) => ({ ...w, task: taskMap.get(w.taskIdentifier) ?? null })),
		active_runs: active,
	});
});

const RESET_ACTIONS = ['discard_local', 'prune_worktrees', 'reclone'] as const;
type ResetAction = (typeof RESET_ACTIONS)[number];

/**
 * Admin-only recovery for a wedged repository. Actions:
 * - `discard_local`: `git reset --hard` + `clean -fd` on the clone (best-effort
 *   fetch first) — unsticks the "local changes would be overwritten" sync failure.
 * - `prune_worktrees`: `git worktree prune` — clears stale worktrees from crashed runs.
 * - `reclone`: wipe the on-disk clone and re-run the standard provisioning path.
 *
 * All are blocked (409) while any agent run is active on the project — reset
 * mutates the shared `.git` a live run's worktree prep also touches, and reclone
 * deletes worktrees a run may hold. `discard_local`/`prune_worktrees` additionally
 * require a running container; `reclone` starts one as part of provisioning.
 */
reposRoutes.post('/projects/:projectId/repos/:repoId/reset', async (c) => {
	const denied = requireSuperuser(c);
	if (denied) return denied;

	const teamId = c.get('teamId') as string;
	const db = c.get('db');
	const projectId = await resolveProjectId(db, teamId, c.req.param('projectId'));
	if (!projectId) return err(c, 'NOT_FOUND', 'Project not found', 404);
	const dataDir = c.get('dataDir');
	if (!dataDir)
		return err(c, 'GIT_RESET_UNSUPPORTED', 'git reset unavailable in this deployment', 400);

	const body = await c.req.json<{ action?: string }>().catch(() => ({}) as { action?: string });
	if (!body.action || !RESET_ACTIONS.includes(body.action as ResetAction)) {
		return err(c, 'INVALID_REQUEST', `action must be one of: ${RESET_ACTIONS.join(', ')}`, 400);
	}
	const action = body.action as ResetAction;

	const repo = await loadRepoForGit(db, dataDir, teamId, projectId, c.req.param('repoId'));
	if (!repo) return err(c, 'NOT_FOUND', 'Repo not found', 404);

	// Never reset while a run may hold a worktree in this project's shared .git.
	const active = await countActiveRunsInProject(db, projectId);
	if (active > 0) {
		return err(
			c,
			'RUN_IN_PROGRESS',
			`Cannot reset while ${active} agent run(s) are active on this project; stop or wait for them to finish first`,
			409,
		);
	}

	const docker = c.get('docker');

	if (action === 'reclone') {
		// Wipe the clone (+ this repo's worktrees) and re-run the standard repo-setup
		// path, which re-clones and settles the row to ready/failed. The frontend
		// already renders `setup_status === 'pending'` as "Setting up…".
		try {
			removeRepoFromWorkspace(dataDir, teamId, projectId, repo.repoName);
		} catch (e) {
			log.error(`Failed to wipe workspace for reclone of ${repo.repoName}:`, e);
			return err(c, 'RECLONE_FAILED', 'failed to remove existing clone', 500);
		}
		const updated = await db.query<Record<string, unknown>>(
			`UPDATE repos r SET setup_status = $1::repo_setup_status, setup_error = NULL
			 WHERE r.id = $2 AND r.project_id = $3
			 RETURNING r.id, r.project_id, r.repo_identifier, r.host_type, r.oauth_connection_id,
			           r.created_at, r.setup_status, r.setup_error,
			           (SELECT p.designated_repo_id = r.id FROM projects p WHERE p.id = r.project_id)
			             AS is_designated`,
			[RepoSetupStatus.Pending, repo.repoId, projectId],
		);
		if (updated.rows[0]) {
			broadcastChange(c, wsRoom.team(teamId), 'repos', 'UPDATE', updated.rows[0]);
		}
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
				{ teamId, projectId, repoId: repo.repoId, repoIdentifier: repo.repoIdentifier },
			).catch((e) => log.error(`Background reclone for ${repo.repoIdentifier} failed:`, e)),
		);
		return ok(c, { reset: true, action });
	}

	// discard_local / prune_worktrees run git in the container → require it running.
	if (!repo.containerId || !repo.containerRunning) {
		return err(c, 'CONTAINER_NOT_RUNNING', 'Start the project container before resetting', 409);
	}
	const containerId = repo.containerId;
	const runUser = await resolveContainerRunUser(docker, containerId);

	const result = await withProjectGitLock(
		projectId,
		async (): Promise<{
			success: boolean;
			error?: string;
			warning?: string;
			removed?: string[];
		}> => {
			if (action === 'prune_worktrees') {
				const executor = ContainerGitExecutor.forPrep(
					docker,
					containerId,
					null,
					runUser,
					mintGitOpScopeId(),
				);
				// Remove worktrees whose task is closed (terminal) or no longer exists —
				// finished tickets plus leftovers from crashed/interrupted runs. Open
				// tasks' worktrees are left intact; reset is already 409-gated on active
				// runs, so nothing live is touched. Committed work survives on the pushed
				// `hezo/<identifier>` branch refs. The sweep also runs the plain
				// `git worktree prune` afterward to clear any dangling metadata.
				//
				// Same policy as the automatic per-run sweep, and unbounded here: a human
				// asked for this and is waiting on the result, so it clears everything
				// rather than leaving a remainder for later.
				const { removed } = await collectFinishedWorktrees(
					db,
					executor,
					projectId,
					[repo.repoLoc],
					undefined,
				);
				return { success: true, removed };
			}
			// discard_local: the best-effort fetch needs the SSH bridge.
			const sshAgentServer = c.get('sshAgentServer');
			const runReset = (bridge: BridgeRunnerArgs | null, scopeId: string) =>
				resetCloneToOrigin(
					ContainerGitExecutor.forPrep(docker, containerId, bridge, runUser, scopeId),
					repo.repoLoc,
				);
			return sshAgentServer
				? withProvisionBridge(
						sshAgentServer,
						teamId,
						dataDir,
						runUser.name,
						({ bridge, scopeId }) => runReset(bridge, scopeId),
					)
				: runReset(null, mintGitOpScopeId());
		},
	);

	if (!result.success) {
		return err(c, 'RESET_FAILED', result.error ?? 'git reset failed', 500);
	}
	return ok(c, {
		reset: true,
		action,
		warning: result.warning ?? null,
		removed: result.removed ?? [],
	});
});

reposRoutes.get('/projects/:projectId/oauth-connections/:id/orgs', async (c) => {
	const db = c.get('db');
	const projectId = c.get('projectId') as string;
	const masterKeyManager = c.get('masterKeyManager');
	const conn = await getConnection({ db, masterKeyManager }, c.req.param('id'));
	if (
		!conn ||
		conn.provider !== 'github' ||
		(conn.projectId !== null && conn.projectId !== projectId)
	)
		return err(c, 'NOT_FOUND', 'github connection not found', 404);

	const token = await loadOAuthAccessToken(db, masterKeyManager, conn.id);
	if (!token) return err(c, 'OAUTH_TOKEN_UNAVAILABLE', 'token unavailable', 503);

	const { listUserOrgs } = await import('../services/github');
	const orgs = await listUserOrgs(token);
	return ok(c, orgs);
});

reposRoutes.get('/projects/:projectId/oauth-connections/:id/repos', async (c) => {
	const owner = c.req.query('owner');
	const query = c.req.query('q') ?? undefined;
	if (!owner) return err(c, 'INVALID_REQUEST', 'owner query parameter is required', 400);
	const db = c.get('db');
	const projectId = c.get('projectId') as string;
	const masterKeyManager = c.get('masterKeyManager');
	const conn = await getConnection({ db, masterKeyManager }, c.req.param('id'));
	if (
		!conn ||
		conn.provider !== 'github' ||
		(conn.projectId !== null && conn.projectId !== projectId)
	)
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

interface RepoGitTarget {
	repoId: string;
	repoIdentifier: string;
	repoName: string;
	repoLoc: RepoLoc;
	containerId: string | null;
	containerRunning: boolean;
}

/**
 * Resolve a repo row scoped to its project plus the addressing the container git
 * executor needs: the clone's host/container paths and the project container's
 * id + running state. Returns null when the repo isn't on the project.
 */
async function loadRepoForGit(
	db: import('../db/database').Db,
	dataDir: string,
	teamId: string,
	projectId: string,
	repoId: string,
): Promise<RepoGitTarget | null> {
	const repoRes = await db.query<{ repo_identifier: string }>(
		'SELECT repo_identifier FROM repos WHERE id = $1 AND project_id = $2',
		[repoId, projectId],
	);
	if (repoRes.rows.length === 0) return null;
	const repoIdentifier = repoRes.rows[0].repo_identifier;
	const repoName = repoNameFromIdentifier(repoIdentifier);

	const containerRes = await db.query<{
		container_id: string | null;
		container_status: string | null;
	}>('SELECT container_id, container_status FROM projects WHERE id = $1', [projectId]);

	return {
		repoId,
		repoIdentifier,
		repoName,
		repoLoc: {
			hostPath: join(getWorkspacePath(dataDir, teamId, projectId), repoName),
			containerPath: `${CONTAINER_WORKSPACE_ROOT}/${repoName}`,
		},
		containerId: containerRes.rows[0]?.container_id ?? null,
		containerRunning: containerRes.rows[0]?.container_status === ContainerStatus.Running,
	};
}
