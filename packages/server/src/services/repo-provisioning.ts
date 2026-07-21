import { RepoSetupStatus, repoNameFromIdentifier, wsRoom } from '@hezo/shared';
import type { Db } from '../db/database';
import { broadcastRowChange } from '../lib/broadcast';
import { withTransaction } from '../lib/sql';
import { logger } from '../logger';
import { resolveContainerRunUser } from './container-user';
import { type ContainerDeps, ensureProjectContainerRunning } from './containers';
import { ContainerGitExecutor, mintGitOpScopeId } from './git-executor';
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
				// provisioning bridge carries the project SSH key into the exec.
				const runUser = await resolveContainerRunUser(docker, containerId);
				const syncRepos = (bridge: BridgeRunnerArgs | null, scopeId: string) =>
					ensureProjectRepos(
						db,
						{ id: input.projectId, team_id: input.teamId },
						dataDir,
						ContainerGitExecutor.forPrep(docker, containerId, bridge, runUser, scopeId),
					);
				const syncRes = deps.sshAgentServer
					? await withProvisionBridge(
							deps.sshAgentServer,
							input.teamId,
							dataDir,
							runUser.name,
							({ bridge, scopeId }) => syncRepos(bridge, scopeId),
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

	if (setupError) {
		return finishFailed(deps, input, setupError);
	}
	return finishReady(deps, input);
}

async function finishReady(deps: RepoSetupDeps, input: RepoSetupInput): Promise<RepoSetupOutcome> {
	const { db, wsManager } = deps;

	const { repoRow, designated, finalizeResult } = await withTransaction(db, async () => {
		const updated = await db.query<RepoRowForBroadcast>(
			`UPDATE repos SET setup_status = $1::repo_setup_status, setup_error = NULL
			 WHERE id = $2
			 RETURNING id, project_id, repo_identifier, host_type, oauth_connection_id, created_at,
			           setup_status, setup_error`,
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
		           setup_status, setup_error`,
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
