/**
 * A re-clone deletes the clone and its task worktrees, but the reset route checks
 * for active runs only when the request arrives. The wipe runs later, in the
 * background, so a run can start in between and prepare its repo first. These
 * cover the check that binds: the one the setup makes under the clone-store lock,
 * right before the wipe.
 */

import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CAPTAIN_AGENT_SLUG, RepoSetupStatus } from '@hezo/shared';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { MasterKeyManager } from '../src/crypto/master-key';
import type { Db } from '../src/db/database';
import { waitForBackground } from '../src/lib/background';
import { withRepoStoreLock } from '../src/lib/git-lock';
import { type ContainerDeps, holdProjectContainer } from '../src/services/containers';
import {
	performRepoSetup,
	type RepoSetupOutcome,
	recloneCalledOffError,
} from '../src/services/repo-provisioning';
import { repoStoreFor } from '../src/services/sandbox/repo-store';
import type { ContainerEngine } from '../src/services/sandbox/types';
import { getWorkspacePath, getWorktreesPath } from '../src/services/workspace';
import { safeClose } from './helpers';
import {
	createAgentRun,
	createStubDocker,
	createTestApp,
	createTestProject,
	createTestTeam,
	finalizeAgentRun,
} from './helpers/app';

let db: Db;
let dataDir: string;
let masterKeyManager: MasterKeyManager;

beforeAll(async () => {
	const ctx = await createTestApp();
	db = ctx.db;
	dataDir = ctx.dataDir;
	masterKeyManager = ctx.masterKeyManager;
});

afterAll(async () => {
	await waitForBackground();
	await safeClose(db);
});

const REPO = 'acme/raced';
const REPO_NAME = 'raced';

/** A complete stub engine that records every git command it is asked to run. */
function engine(): { docker: ContainerEngine; gitCommands: string[][] } {
	const gitCommands: string[][] = [];
	const docker = createStubDocker(
		{
			// Unique per spec: the stub's file seam finds a container's project by id.
			createContainer: vi.fn(async () => ({ Id: `race-${randomUUID()}`, Warnings: [] })),
			inspectContainer: vi.fn(async (id: string) => ({
				Id: id,
				State: { Status: 'running', Running: true, Pid: 1, ExitCode: 0 },
				Config: { Image: 'stub' },
				HostConfig: { MemoryBytes: null },
			})),
			execCreate: vi.fn(async (_id: string, opts: unknown) => {
				const cmd = (opts as { Cmd?: string[] }).Cmd ?? [];
				const git = cmd.indexOf('git');
				if (git >= 0) gitCommands.push(cmd.slice(git + 1));
				return 'exec-x';
			}),
		},
		{ db, dataDir },
	);
	return { docker, gitCommands };
}

interface Fixture {
	teamId: string;
	projectId: string;
	repoId: string;
	captainId: string;
	taskId: string;
	containerId: string;
	clonePath: string;
	worktreePath: string;
	deps: ContainerDeps;
	gitCommands: string[][];
	release(): void;
}

/**
 * A project with a ready repo, a running container, the clone on disk, and the
 * worktree a run's prep builds for its task.
 */
async function fixture(name: string): Promise<Fixture> {
	const team = (await (await createTestTeam(db, { name: `${name} Co` })).json()).data;
	const project = (await (await createTestProject(db, team.id, { name })).json()).data;
	const repo = await db.query<{ id: string }>(
		`INSERT INTO repos (project_id, repo_identifier, host_type, setup_status)
		 VALUES ($1, $2, 'github'::repo_host_type, 'ready'::repo_setup_status)
		 RETURNING id`,
		[project.id, REPO],
	);
	const captain = await db.query<{ id: string }>(
		`SELECT ma.id FROM member_agents ma JOIN members m ON m.id = ma.id
		 WHERE m.team_id = $1 AND ma.slug = $2 LIMIT 1`,
		[team.id, CAPTAIN_AGENT_SLUG],
	);
	const task = await db.query<{ identifier: string }>(
		'SELECT identifier FROM tasks WHERE id = $1',
		[project.planning_task_id],
	);

	const { docker, gitCommands } = engine();
	const deps: ContainerDeps = { db, docker, dataDir, masterKeyManager, poolLivenessIntervalMs: 0 };
	// Up before the reset, so the setup's own hold reuses it and the test knows
	// which clone store it locks.
	const hold = await holdProjectContainer(deps, project.id);

	const clonePath = join(getWorkspacePath(dataDir, team.id, project.id), REPO_NAME);
	mkdirSync(join(clonePath, '.git'), { recursive: true });
	writeFileSync(join(clonePath, '.git', 'HEAD'), 'ref: refs/heads/main\n');
	const worktreePath = join(
		getWorktreesPath(dataDir, team.id, project.id),
		task.rows[0].identifier,
		REPO_NAME,
	);

	return {
		teamId: team.id,
		projectId: project.id,
		repoId: repo.rows[0].id,
		captainId: captain.rows[0].id,
		taskId: project.planning_task_id as string,
		containerId: hold.containerId,
		clonePath,
		worktreePath,
		deps,
		gitCommands,
		release: () => hold.release(),
	};
}

/** What the reset route does once its own active-run check has passed. */
async function markPending(f: Fixture): Promise<void> {
	await db.query(
		`UPDATE repos SET setup_status = $1::repo_setup_status, setup_error = NULL WHERE id = $2`,
		[RepoSetupStatus.Pending, f.repoId],
	);
}

function reclone(f: Fixture): Promise<RepoSetupOutcome> {
	return performRepoSetup(f.deps, {
		teamId: f.teamId,
		projectId: f.projectId,
		repoId: f.repoId,
		repoIdentifier: REPO,
		freshClone: true,
	});
}

async function repoRow(
	repoId: string,
): Promise<{ setup_status: string; setup_error: string | null }> {
	const res = await db.query<{ setup_status: string; setup_error: string | null }>(
		'SELECT setup_status::text AS setup_status, setup_error FROM repos WHERE id = $1',
		[repoId],
	);
	return res.rows[0];
}

const sentClone = (f: Fixture) => f.gitCommands.some((c) => c[0] === 'clone');

describe('re-clone and a run that starts after the request', () => {
	it('keeps the clone and the run worktree when the run prepared first', async () => {
		const f = await fixture('Reclone Race');
		let runId: string | null = null;
		try {
			await markPending(f);

			// The run's prep holds the clone-store lock, as `prepare_repos` does, and
			// builds its worktree under it. The re-clone is queued behind it.
			let setup!: Promise<RepoSetupOutcome>;
			await withRepoStoreLock(await repoStoreFor(db, f.projectId, f.containerId), async () => {
				setup = reclone(f);
				runId = await createAgentRun(db, f.captainId, f.teamId, f.taskId);
				mkdirSync(f.worktreePath, { recursive: true });
				writeFileSync(join(f.worktreePath, '.git'), `gitdir: ${f.clonePath}/.git/worktrees/x\n`);
			});
			const outcome = await setup;

			expect(outcome.status).toBe(RepoSetupStatus.Failed);
			expect(outcome.error).toBe(recloneCalledOffError(1));
			// Nothing was deleted or re-cloned under the run.
			expect(existsSync(join(f.clonePath, '.git', 'HEAD'))).toBe(true);
			expect(existsSync(join(f.worktreePath, '.git'))).toBe(true);
			expect(sentClone(f)).toBe(false);
			// The Git settings page shows why, from the row.
			expect(await repoRow(f.repoId)).toEqual({
				setup_status: RepoSetupStatus.Failed,
				setup_error: recloneCalledOffError(1),
			});
		} finally {
			if (runId) await finalizeAgentRun(db, runId);
			f.release();
			await waitForBackground();
		}
	});

	it('wipes and re-clones once no run is active', async () => {
		const f = await fixture('Reclone Idle');
		try {
			mkdirSync(f.worktreePath, { recursive: true });
			writeFileSync(join(f.worktreePath, '.git'), `gitdir: ${f.clonePath}/.git/worktrees/x\n`);
			const runId = await createAgentRun(db, f.captainId, f.teamId, f.taskId);
			await finalizeAgentRun(db, runId);
			await markPending(f);

			const outcome = await reclone(f);

			expect(outcome.status).toBe(RepoSetupStatus.Ready);
			expect(existsSync(join(f.clonePath, '.git', 'HEAD'))).toBe(false);
			expect(existsSync(f.worktreePath)).toBe(false);
			expect(sentClone(f)).toBe(true);
			expect(await repoRow(f.repoId)).toEqual({
				setup_status: RepoSetupStatus.Ready,
				setup_error: null,
			});
		} finally {
			f.release();
			await waitForBackground();
		}
	});
});
