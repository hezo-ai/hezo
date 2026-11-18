/**
 * A re-clone deletes the clone and its task worktrees, but the reset route checks
 * for active runs only when the request arrives. The wipe runs later, in the
 * background, so a run can start in between and prepare its repo first. These
 * cover the check that binds - the one the setup makes under the clone-store lock,
 * right before the wipe - and the wait that holds back a run starting after it.
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
import { RunRepoSession } from '../src/services/run-repos';
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

/**
 * A complete stub engine that records every git command it is asked to run, and
 * awaits `onGit` before answering one.
 */
function engine(onGit?: (args: string[]) => Promise<void>): {
	docker: ContainerEngine;
	gitCommands: string[][];
} {
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
				if (git >= 0) {
					gitCommands.push(cmd.slice(git + 1));
					await onGit?.(cmd.slice(git + 1));
				}
				return 'exec-x';
			}),
		},
		{ db, dataDir },
	);
	return { docker, gitCommands };
}

/** A promise with its resolver, for holding one side of a race open. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve!: () => void;
	const promise = new Promise<void>((r) => {
		resolve = r;
	});
	return { promise, resolve };
}

interface Fixture {
	teamId: string;
	projectId: string;
	repoId: string;
	captainId: string;
	taskId: string;
	taskIdentifier: string;
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
async function fixture(name: string, onGit?: (args: string[]) => Promise<void>): Promise<Fixture> {
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

	const { docker, gitCommands } = engine(onGit);
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
		taskIdentifier: task.rows[0].identifier,
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

	it('holds a run that starts after the check until the fresh clone is in place', async () => {
		const cloneStarted = deferred();
		const finishClone = deferred();
		const f = await fixture('Reclone Late Run', async (args) => {
			if (args[0] !== 'clone') return;
			cloneStarted.resolve();
			await finishClone.promise;
		});
		const abort = new AbortController();
		let runId: string | null = null;
		try {
			await markPending(f);
			const setup = reclone(f);
			// The count found no run and the old copy is gone: the clone is under way.
			await cloneStarted.promise;

			runId = await createAgentRun(db, f.captainId, f.teamId, f.taskId);
			const waiting = deferred();
			let cloneFinished = false;
			let openedAfterClone: boolean | null = null;
			const opened = RunRepoSession.open(
				{ db, docker: f.deps.docker, dataDir, masterKeyManager },
				{
					runId,
					project: {
						id: f.projectId,
						team_id: f.teamId,
						container_id: f.containerId,
						designated_repo_id: null,
					},
					task: { id: f.taskId, identifier: f.taskIdentifier },
					repos: [{ id: f.repoId, repo_identifier: REPO }],
					bridge: null,
					runUser: { name: 'root', uid: 0, gid: 0 },
					egress: null,
					emit: (_stream, text) => {
						if (text.includes('waiting for a re-clone')) waiting.resolve();
					},
					signal: abort.signal,
					startedAt: new Date(),
				},
			).then(() => {
				openedAfterClone = cloneFinished;
			});

			// The run says why it waits, and its start cannot finish before the clone.
			// Raced, so a start that does not wait fails here rather than hanging.
			await Promise.race([waiting.promise, opened]);
			expect(openedAfterClone).toBeNull();

			cloneFinished = true;
			finishClone.resolve();
			expect((await setup).status).toBe(RepoSetupStatus.Ready);
			await opened;
			expect(openedAfterClone).toBe(true);
		} finally {
			finishClone.resolve();
			abort.abort();
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
