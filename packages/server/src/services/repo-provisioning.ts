import { RepoSetupStatus, repoNameFromIdentifier, wsRoom } from '@hezo/shared';
import type { Db } from '../db/database';
import { broadcastRowChange } from '../lib/broadcast';
import { withTransaction } from '../lib/sql';
import { logger } from '../logger';
import { resolveContainerRunUser } from './container-user';
import { type ContainerDeps, ensureProjectContainerRunning } from './containers';
import { ContainerGitExecutor, mintGitOpScopeId } from './git-executor';
import { refreshRepoPushAccess } from './repo-push-access';
import {
	enqueueRepoSetupResumeWakeups,
	finalizePendingRepoSetup,
	markRepoSetupFailed,
} from './repo-setup';
import { ensureProjectRepos } from './repo-sync';
import { type BridgeRunnerArgs, withProvisionBridge } from './ssh-agent';

const log = logger.child('repo-provisioning');

/**
 * `ContainerDeps` minus the hard docker/data-dir requirement: a deployment
 * shape without Docker or a data dir has nothing to clone, and setup settles
 * straight to ready.
 */
export type RepoSetupDeps = Omit<ContainerDeps, 'docker' | 'dataDir'> & {
	docker?: ContainerDeps['docker'] | null;
	dataDir?: ContainerDeps['dataDir'] | null;
};

export interface RepoSetupInput {
	teamId: string;
	projectId: string;
	repoId: string;
	repoIdentifier: string;
	/**
	 * Replace whatever is already cloned rather than adopting it - the reset
	 * route's `reclone` action.
	 *
	 * Carried as intent rather than performed by the caller: the sync decides
	 * clone-vs-adopt by reading the container, so only a removal on that side can
	 * change its mind, and only the sync is on that side.
	 */
	freshClone?: boolean;
}

export interface RepoSetupOutcome {
	status: RepoSetupStatus;
	designated: boolean;
	error: string | null;
}

interface RepoRowForBroadcast {
	id: string;
	project_id: string;
	repo_identifier: string;
	host_type: string;
	oauth_connection_id: string | null;
	created_at: string;
	setup_status: string;
	setup_error: string | null;
	can_push: boolean | null;
}

/**
 * Runs the slow half of adding a repo — container up, in-container clone,
 * first-repo designation — for a `repos` row already inserted in `pending`
 * state. POST /repos returns before this runs (wrap the call in
 * `trackBackground`), so every state change here is pushed to clients over
 * the team room: `repos` UPDATE when the row settles, plus the designation
 * family (`projects`, `approvals`, `task_comments`) when the gate resolves.
 *
 * Failures never delete the row: the row parks in `failed` with the error on
 * it, the designated-repo approval stays pending (agents stay parked), and a
 * retry POST for the same repo re-enters `pending` and runs this again.
 */
export async function performRepoSetup(
	deps: RepoSetupDeps,
	input: RepoSetupInput,
): Promise<RepoSetupOutcome> {
	const { db, docker, dataDir } = deps;
	const repoName = repoNameFromIdentifier(input.repoIdentifier);

	let setupError: string | null = null;
	if (docker && dataDir) {
		const containerDeps: ContainerDeps = { ...deps, docker, dataDir };
		try {
			try {
				await ensureProjectContainerRunning(containerDeps, input.projectId);
			} catch (e) {
				log.error('Failed to auto-start container during repo setup:', e);
			}

			const containerRow = await db.query<{
				container_id: string | null;
				container_status: string | null;
			}>('SELECT container_id, container_status FROM projects WHERE id = $1', [input.projectId]);
			const containerId = containerRow.rows[0]?.container_id ?? null;
			const running = containerRow.rows[0]?.container_status === 'running';

			if (containerId && running) {
				// Git runs inside the project container; the host runs no git. The
				// provisioning bridge carries the project SSH key for commit signing,
				// and the egress proxy substitutes the clone's credential placeholder.
				const runUser = await resolveContainerRunUser(docker, containerId);
				const syncRepos = (
					bridge: BridgeRunnerArgs | null,
					scopeId: string,
					proxyEnv: string[] = [],
				) =>
					ensureProjectRepos(
						db,
						{ id: input.projectId, team_id: input.teamId },
						dataDir,
						ContainerGitExecutor.forPrep(docker, containerId, bridge, runUser, scopeId, proxyEnv),
						undefined,
						undefined,
						{ freshClone: input.freshClone ? new Set([input.repoIdentifier]) : undefined },
					);
				const syncRes =
					deps.sshAgentServer && deps.egressProxy
						? await withProvisionBridge(
								deps.sshAgentServer,
								{
									engine: docker,
									containerId,
									teamId: input.teamId,
									dataDir,
									runUser,
									db,
									egressProxy: deps.egressProxy,
									projectId: input.projectId,
								},
								({ bridge, scopeId, proxyEnv }) => syncRepos(bridge, scopeId, proxyEnv),
							)
						: await syncRepos(null, mintGitOpScopeId());
				const failed = syncRes.failed.find((f) => f.name === repoName);
				if (failed) {
					setupError = failed.error;
					log.error(`Failed to clone ${input.repoIdentifier}:`, failed.error);
				}
			} else {
				setupError = 'project container is not running';
				log.error(`Cannot clone ${input.repoIdentifier}: container not running`);
			}
		} catch (e) {
			setupError = e instanceof Error ? e.message : 'unknown error';
			log.error(`Repo setup for ${input.repoIdentifier} threw:`, e);
		}
	}

	const outcome = setupError
		? await finishFailed(deps, input, setupError)
		: await finishReady(deps, input);

	// Re-read push access so the card and the agent's Repository prompt block
	// reflect the account's current rights rather than whatever was true when the
	// repo was first linked (the reclone/retry paths have no link-time check at
	// all). Deliberately **after** the settle: this is a GitHub round trip, and
	// designation — which unblocks the tasks gated on the repo — must never wait
	// on it. Best-effort; a changed verdict broadcasts its own `repos` UPDATE.
	await refreshAndBroadcastPushAccess(deps, input);

	return outcome;
}

/**
 * Refresh `repos.can_push` and, when the verdict actually changed, push the new
 * row to the team room so an open Git settings page updates without a reload.
 * Never throws — a failed check leaves the stored value and says nothing.
 */
async function refreshAndBroadcastPushAccess(
	deps: RepoSetupDeps,
	input: RepoSetupInput,
): Promise<void> {
	const { db, wsManager } = deps;
	const before = await db.query<{ can_push: boolean | null }>(
		'SELECT can_push FROM repos WHERE id = $1',
		[input.repoId],
	);
	if (before.rows.length === 0) return; // deleted while setup ran

	const after = await refreshRepoPushAccess(deps, input.repoId);
	if (after === (before.rows[0].can_push ?? null)) return;

	const row = await db.query<Record<string, unknown>>(
		`SELECT r.id, r.project_id, r.repo_identifier, r.host_type, r.oauth_connection_id,
		        r.created_at, r.setup_status, r.setup_error, r.can_push,
		        (p.designated_repo_id = r.id) AS is_designated
		 FROM repos r JOIN projects p ON p.id = r.project_id
		 WHERE r.id = $1`,
		[input.repoId],
	);
	if (row.rows[0]) {
		broadcastRowChange(wsManager, wsRoom.team(input.teamId), 'repos', 'UPDATE', row.rows[0]);
	}
}

async function finishReady(deps: RepoSetupDeps, input: RepoSetupInput): Promise<RepoSetupOutcome> {
	const { db, wsManager } = deps;

	const { repoRow, designated, finalizeResult } = await withTransaction(db, async () => {
		const updated = await db.query<RepoRowForBroadcast>(
			`UPDATE repos SET setup_status = $1::repo_setup_status, setup_error = NULL
			 WHERE id = $2
			 RETURNING id, project_id, repo_identifier, host_type, oauth_connection_id, created_at,
			           setup_status, setup_error, can_push`,
			[RepoSetupStatus.Ready, input.repoId],
		);
		// The repo was deleted while its setup ran — nothing to settle.
		if (updated.rows.length === 0)
			return { repoRow: null, designated: false, finalizeResult: null };

		const projectRow = await db.query<{ designated_repo_id: string | null }>(
			'SELECT designated_repo_id FROM projects WHERE id = $1 FOR UPDATE',
			[input.projectId],
		);
		if (projectRow.rows.length === 0 || projectRow.rows[0].designated_repo_id) {
			return { repoRow: updated.rows[0], designated: false, finalizeResult: null };
		}

		await db.query('UPDATE projects SET designated_repo_id = $1 WHERE id = $2', [
			input.repoId,
			input.projectId,
		]);
		const finalizeResult = await finalizePendingRepoSetup(db, {
			teamId: input.teamId,
			projectId: input.projectId,
			repoId: input.repoId,
			repoIdentifier: input.repoIdentifier,
		});
		return { repoRow: updated.rows[0], designated: true, finalizeResult };
	});

	if (!repoRow) return { status: RepoSetupStatus.Ready, designated: false, error: null };

	if (finalizeResult?.resolvedApprovalId) {
		await enqueueRepoSetupResumeWakeups(
			db,
			input.teamId,
			input.repoId,
			finalizeResult.resolvedApprovalId,
			finalizeResult.deferredWakeups,
		);
	}

	const room = wsRoom.team(input.teamId);
	broadcastRowChange(wsManager, room, 'repos', 'UPDATE', {
		...repoRow,
		is_designated: designated,
	});
	if (designated) {
		broadcastRowChange(wsManager, room, 'projects', 'UPDATE', {
			id: input.projectId,
			designated_repo_id: input.repoId,
		});
		if (finalizeResult?.approvalRow) {
			broadcastRowChange(wsManager, room, 'approvals', 'UPDATE', finalizeResult.approvalRow);
		}
		for (const row of finalizeResult?.updatedCommentRows ?? []) {
			broadcastRowChange(wsManager, room, 'task_comments', 'UPDATE', row);
		}
		for (const row of finalizeResult?.systemCommentRows ?? []) {
			broadcastRowChange(wsManager, room, 'task_comments', 'INSERT', row);
		}
	}

	return { status: RepoSetupStatus.Ready, designated, error: null };
}

async function finishFailed(
	deps: RepoSetupDeps,
	input: RepoSetupInput,
	error: string,
): Promise<RepoSetupOutcome> {
	const { db, wsManager } = deps;

	const updated = await db.query<RepoRowForBroadcast>(
		`UPDATE repos SET setup_status = $1::repo_setup_status, setup_error = $2
		 WHERE id = $3
		 RETURNING id, project_id, repo_identifier, host_type, oauth_connection_id, created_at,
		           setup_status, setup_error, can_push`,
		[RepoSetupStatus.Failed, error, input.repoId],
	);
	if (updated.rows.length === 0) {
		// Deleted while its setup ran — nothing to report.
		return { status: RepoSetupStatus.Failed, designated: false, error };
	}

	// If the designated-repo gate is still open this failure blocks it; tell the
	// gated task(s) so the operator can fix the cause and retry. The approval
	// stays pending, so agents stay correctly parked.
	const project = await db.query<{ designated_repo_id: string | null }>(
		'SELECT designated_repo_id FROM projects WHERE id = $1',
		[input.projectId],
	);
	const room = wsRoom.team(input.teamId);
	if (project.rows.length > 0 && !project.rows[0].designated_repo_id) {
		const failure = await markRepoSetupFailed(db, {
			teamId: input.teamId,
			projectId: input.projectId,
			repoIdentifier: input.repoIdentifier,
			error,
		});
		for (const row of failure.systemCommentRows) {
			broadcastRowChange(wsManager, room, 'task_comments', 'INSERT', row);
		}
	}

	broadcastRowChange(wsManager, room, 'repos', 'UPDATE', {
		...updated.rows[0],
		is_designated: false,
	});

	return { status: RepoSetupStatus.Failed, designated: false, error };
}
