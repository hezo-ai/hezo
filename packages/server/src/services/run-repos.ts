import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { repoNameFromIdentifier } from '@hezo/shared';
import type { MasterKeyManager } from '../crypto/master-key';
import type { Db } from '../db/database';
import { withProjectGitLock } from '../lib/git-lock';
import { logger } from '../logger';
import { type ContainerRunUser, chownToRunUser, ensureContainerDirReady } from './container-user';
import type { ContainerEngine } from './docker';
import { buildEgressProxyEnv, type EgressProxyEndpoint } from './egress';
import {
	clearPushErrors,
	ensurePushHook,
	ensureTaskWorktreeWithRetry,
	fastForwardFromRecovery,
	fastForwardLocalDefault,
	fetchRepo,
	getWorktreeHead,
	mergeDefaultIntoWorktree,
	type RepoLoc,
	seedInitialCommitIfEmpty,
	type WorktreeLoc,
} from './git';
import { ContainerGitExecutor, type GitExecutor, mintGitOpScopeId } from './git-executor';
import { buildGitIdentityEnv } from './git-identity';
import { ensureProjectRepos } from './repo-sync';
import { createBundleVault } from './sandbox/bundle-vault';
import { setPoolMemberDiskUsage } from './sandbox/pool-db';
import { restoreRecoveryBundle } from './sandbox/recovery';
import { collectFinishedWorktrees } from './sandbox/worktree-gc';
import type { BridgeRunnerArgs } from './ssh-agent';
import { CONTAINER_WORKSPACE_ROOT, CONTAINER_WORKTREES_ROOT, getWorktreesPath } from './workspace';

const log = logger.child('run-repos');

export interface RepoRow {
	id: string;
	repo_identifier: string;
}

/**
 * A clone, carrying the `repos` row it came from.
 *
 * The id rides along rather than being looked up again at finalize because the one
 * check that needs it - asking the git host what became of a branch the remote no
 * longer advertises - has only a container path to go on otherwise, and matching a
 * path back to a row by name is a second source of truth for something already known
 * here. Structurally still a {@link RepoLoc}, so every existing consumer is unchanged.
 */
export type CloneRef = RepoLoc & { repoId: string };

export interface WorktreeRef {
	loc: WorktreeLoc;
	/** The task branch tip once the worktree was ready, or null when not taken this run. */
	headBefore: string | null;
}

/** One repo's line in a `prepare_repos` answer. */
export interface PreparedRepo {
	name: string;
	repo: string;
	/** Where the agent works in it: the task worktree, on the task branch. */
	path: string;
	designated: boolean;
	ready: boolean;
	error?: string;
	/** Anything the agent should know before working in it, e.g. a catch-up merge that stopped. */
	notes: string[];
}

export interface PrepareReposResult {
	branch: string;
	repos: PreparedRepo[];
}

/** What finalize reads: every worktree of the task present in the container. */
export interface RunRepoView {
	executor: GitExecutor | null;
	worktrees: WorktreeRef[];
	clones: CloneRef[];
	/** Clones prepared this run, whose push-error log covers only this run. */
	preparedClones: CloneRef[];
	branch: string | null;
	recoveryFailed: Set<string>;
}

export const EMPTY_RUN_REPO_VIEW: RunRepoView = {
	executor: null,
	worktrees: [],
	clones: [],
	preparedClones: [],
	branch: null,
	recoveryFailed: new Set<string>(),
};

export interface RunRepoDeps {
	db: Db;
	docker: ContainerEngine;
	dataDir: string;
	masterKeyManager: MasterKeyManager;
}

export interface RunRepoSessionInit {
	project: { id: string; team_id: string; container_id: string; designated_repo_id: string | null };
	task: { identifier: string };
	repos: RepoRow[];
	bridge: BridgeRunnerArgs | null;
	runUser: ContainerRunUser;
	/**
	 * The run's egress proxy as the container reaches it. Clones and fetches
	 * authenticate with a placeholder only the proxy can substitute, so without
	 * this a private repo is refused upstream as a bad token.
	 */
	egress: EgressProxyEndpoint | null;
	emit: (stream: 'stdout' | 'stderr', text: string) => void;
	/** Stops prep work when the run ends early. */
	signal: AbortSignal;
}

interface ReadyRepo {
	result: PreparedRepo;
	worktree: WorktreeRef;
	clone: CloneRef;
}

/**
 * A task run's repositories. Nothing is fetched or checked out when the run
 * starts: the agent asks with `prepare_repos`, and only then does the run sync,
 * fetch, build the task worktree and catch it up, under the project git lock.
 * All git runs inside the project container.
 *
 * The session's git executor carries its own process-scope id, never the run id:
 * the agent CLI is stamped with the run id, so a prep op's marker kill on a
 * timeout would otherwise kill the running agent too.
 */
export class RunRepoSession {
	readonly branch: string;
	/** The run's working directory: each prepared repo becomes a folder in it. */
	readonly taskRoot: string;
	readonly recoveryFailed = new Set<string>();
	private readonly ready = new Map<string, ReadyRepo>();
	private readonly inFlight = new Set<Promise<unknown>>();
	private identityEnv: Promise<string[]> | null = null;
	private closed = false;

	private constructor(
		private readonly deps: RunRepoDeps,
		private readonly init: RunRepoSessionInit,
	) {
		this.branch = `hezo/${init.task.identifier}`;
		this.taskRoot = `${CONTAINER_WORKTREES_ROOT}/${init.task.identifier}`;
	}

	/**
	 * Create the task root the run starts in. No git: the directory only has to
	 * exist and belong to the run user before the agent CLI is started in it.
	 */
	static async open(deps: RunRepoDeps, init: RunRepoSessionInit): Promise<RunRepoSession> {
		const session = new RunRepoSession(deps, init);
		const { project } = init;
		mkdirSync(
			join(getWorktreesPath(deps.dataDir, project.team_id, project.id), init.task.identifier),
			{ recursive: true },
		);
		// Also created from inside the container and confirmed visible there: the
		// host mkdir may not have propagated through the bind mount yet (most
		// visibly right after a reprovision), and the chown is skipped for a root
		// run user.
		await ensureContainerDirReady(deps.docker, project.container_id, session.taskRoot);
		await chownToRunUser(deps.docker, project.container_id, init.runUser, [session.taskRoot]);
		return session;
	}

	/** The names an agent may pass, in link order. */
	linkedNames(): string[] {
		return this.init.repos.map((r) => repoNameFromIdentifier(r.repo_identifier));
	}

	/**
	 * Prepare the named repos (all linked repos when none are named), returning
	 * one line per requested repo. Idempotent: a repo already prepared this run
	 * is answered without git work; a failed one is tried again.
	 */
	prepare(requested?: string[]): Promise<PrepareReposResult | { error: string }> {
		if (this.closed)
			return Promise.resolve({ error: 'This run is finishing; nothing can be prepared now.' });
		const picked = this.pick(requested);
		if ('error' in picked) return Promise.resolve(picked);
		const work = this.prepareUnderLock(picked.repos).catch((e: unknown) => {
			log.warn(`Project ${this.init.project.id}: preparing repositories failed:`, e);
			return {
				error: `Preparing repositories failed: ${e instanceof Error ? e.message : String(e)}`,
			};
		});
		this.inFlight.add(work);
		void work.finally(() => this.inFlight.delete(work));
		return work;
	}

	/** Wait for any prep still running. Bounded by git's per-op timeouts and the run signal. */
	async settle(): Promise<void> {
		while (this.inFlight.size > 0) {
			await Promise.allSettled([...this.inFlight]);
		}
	}

	/** Refuse further prep; the run is finishing. */
	close(): void {
		this.closed = true;
	}

	/**
	 * Every worktree of this task present in the container, prepared this run or
	 * left by an earlier one. An agent can work in a folder an earlier run built
	 * without asking for it again, and its commits must still be scanned and
	 * vaulted. Waits for in-flight prep first. `signal` bounds the finalize git
	 * work, and is not the run's own: a run stopped at a ceiling still gets its scans.
	 */
	async view(signal: AbortSignal | undefined): Promise<RunRepoView> {
		await this.settle();
		const worktrees: WorktreeRef[] = [];
		const clones: CloneRef[] = [];
		const preparedClones: CloneRef[] = [];
		for (const repo of this.init.repos) {
			const ready = this.ready.get(repo.id);
			if (ready) {
				worktrees.push(ready.worktree);
				clones.push(ready.clone);
				preparedClones.push(ready.clone);
				continue;
			}
			const name = repoNameFromIdentifier(repo.repo_identifier);
			const loc = this.worktreeLoc(name);
			if (!(await loc.files.exists('.git'))) continue;
			worktrees.push({ loc, headBefore: null });
			clones.push({ ...this.cloneLoc(name), repoId: repo.id });
		}
		if (worktrees.length === 0) return { ...EMPTY_RUN_REPO_VIEW, branch: this.branch };
		return {
			executor: await this.executor(signal),
			worktrees,
			clones,
			preparedClones,
			branch: this.branch,
			recoveryFailed: this.recoveryFailed,
		};
	}

	private pick(requested?: string[]): { repos: RepoRow[] } | { error: string } {
		if (!requested || requested.length === 0) return { repos: this.init.repos };
		const picked: RepoRow[] = [];
		for (const want of requested) {
			const repo = this.init.repos.find(
				(r) => r.repo_identifier === want || repoNameFromIdentifier(r.repo_identifier) === want,
			);
			if (!repo) {
				return {
					error: `No linked repository is named "${want}". Linked repositories: ${this.linkedNames().join(', ')}.`,
				};
			}
			if (!picked.includes(repo)) picked.push(repo);
		}
		return { repos: picked };
	}

	private async executor(signal: AbortSignal | undefined): Promise<GitExecutor> {
		const { deps, init } = this;
		// The team's git identity (and signing) lets the catch-up merge record a
		// verified merge commit, matching the agent's own in-container commits.
		this.identityEnv ??= buildGitIdentityEnv(deps.db, deps.masterKeyManager, {
			projectId: init.project.id,
			teamId: init.project.team_id,
		});
		const identity = await this.identityEnv;
		const env = init.egress ? [...identity, ...buildEgressProxyEnv(init.egress)] : identity;
		return ContainerGitExecutor.forPrep(
			deps.docker,
			init.project.container_id,
			init.bridge,
			init.runUser,
			mintGitOpScopeId(),
			env,
			signal,
		);
	}

	private cloneLoc(name: string): RepoLoc {
		const containerPath = `${CONTAINER_WORKSPACE_ROOT}/${name}`;
		return {
			containerPath,
			files: this.deps.docker.files(this.init.project.container_id, containerPath),
		};
	}

	private worktreeLoc(name: string): WorktreeLoc {
		const containerPath = `${this.taskRoot}/${name}`;
		return {
			containerPath,
			files: this.deps.docker.files(this.init.project.container_id, containerPath),
		};
	}

	private describe(repo: RepoRow): Omit<PreparedRepo, 'ready' | 'notes'> {
		const name = repoNameFromIdentifier(repo.repo_identifier);
		return {
			name,
			repo: repo.repo_identifier,
			path: `${this.taskRoot}/${name}`,
			designated: repo.id === this.init.project.designated_repo_id,
		};
	}

	private async prepareUnderLock(picked: RepoRow[]): Promise<PrepareReposResult> {
		const { deps, init } = this;
		const emitSystem = (stream: 'stdout' | 'stderr', text: string) =>
			init.emit(stream, `[system] ${text}\n`);

		return withProjectGitLock(init.project.id, async () => {
			const failed = new Map<string, PreparedRepo>();
			// Checked under the lock, so a concurrent call that prepared a repo
			// while this one waited is answered from its result.
			const todo = picked.filter((r) => !this.ready.has(r.id));
			if (todo.length > 0 && !init.signal.aborted) {
				const executor = await this.executor(init.signal);
				emitSystem('stdout', '(syncing repos...)');
				const syncRes = await ensureProjectRepos(
					deps.db,
					{ id: init.project.id, team_id: init.project.team_id },
					deps.dataDir,
					executor,
					emitSystem,
					undefined,
					{ only: new Set(todo.map((r) => r.repo_identifier)) },
				);
				if (syncRes.cloned.length > 0) {
					emitSystem('stdout', `(cloned ${syncRes.cloned.length} repo(s) on demand)`);
				}
				if (syncRes.repaired.length > 0) {
					emitSystem(
						'stdout',
						`(repaired ${syncRes.repaired.length} repo(s) with a broken origin)`,
					);
				}

				const syncFailures = new Map(syncRes.failed.map((f) => [f.name, f.error]));
				for (const repo of todo) {
					if (init.signal.aborted) break;
					const outcome = await this.prepareOne(executor, repo, emitSystem, syncFailures);
					if ('error' in outcome) {
						failed.set(repo.id, {
							...this.describe(repo),
							ready: false,
							error: outcome.error,
							notes: outcome.notes,
						});
					}
				}
				if (this.ready.size > 0) await this.housekeep(executor);
			}

			return {
				branch: this.branch,
				repos: picked.map(
					(repo) =>
						this.ready.get(repo.id)?.result ??
						failed.get(repo.id) ?? {
							...this.describe(repo),
							ready: false,
							error: 'the run was stopped before this repository was prepared',
							notes: [],
						},
				),
			};
		});
	}

	private async prepareOne(
		executor: GitExecutor,
		repo: RepoRow,
		emitSystem: (stream: 'stdout' | 'stderr', text: string) => void,
		syncFailures: ReadonlyMap<string, string>,
	): Promise<{ ok: true } | { error: string; notes: string[] }> {
		const { deps, init } = this;
		const name = repoNameFromIdentifier(repo.repo_identifier);
		const repoLoc = this.cloneLoc(name);
		const wtLoc = this.worktreeLoc(name);
		const notes: string[] = [];
		const warn = (text: string) => {
			notes.push(text);
			emitSystem('stderr', `${name}: ${text}`);
		};

		if (!(await repoLoc.files.exists('.git'))) {
			emitSystem('stderr', `(skipping worktree for ${name} — not cloned)`);
			const why = syncFailures.get(name);
			return {
				error: `the repository is not cloned in this container${why ? `: ${why}` : ''}`,
				notes,
			};
		}

		// Install/refresh the auto-push post-commit hook so every commit the agent
		// makes is pushed to origin immediately — committed work then survives an
		// aborted or timed-out run instead of dying with the ephemeral worktree.
		// Clearing the hook's error log here scopes what the run reports at
		// finalize to this run's own failed pushes.
		await ensurePushHook(repoLoc);
		await clearPushErrors(repoLoc);

		// A connected repo with no commits yet: `git worktree add` can't branch off
		// an unborn HEAD, so seed a minimal initial commit and push it. No-op when
		// the remote already has commits.
		const seed = await seedInitialCommitIfEmpty(executor, repo.repo_identifier, repoLoc, true);
		if (seed.seeded) {
			emitSystem('stdout', `seeded initial commit for ${name} (remote was empty)`);
		} else if (seed.error) {
			warn(`could not seed initial commit: ${seed.error}`);
		}

		emitSystem('stdout', `git fetch ${name}...`);
		const fetchRes = await fetchRepo(executor, repoLoc);
		if (fetchRes.success) {
			emitSystem('stdout', `git fetch ${name} done`);
		} else {
			notes.push(`git fetch failed: ${fetchRes.error ?? '?'}`);
			emitSystem('stderr', `git fetch ${name} failed: ${fetchRes.error ?? '?'}`);
		}

		// Keep the clone's local default branch current with the remote — a clean
		// fast-forward, since the clone holds no local commits on its default.
		const ffWarn = await fastForwardLocalDefault(executor, repoLoc);
		if (ffWarn) warn(ffWarn);

		// Recover commits an earlier run left in a DIFFERENT container because its
		// push was denied. Strictly after the origin fetch: the stored bundle is a
		// delta whose prerequisites are the remote tips, so git refuses to apply it
		// to a clone that has not caught up.
		const recovered = await restoreRecoveryBundle(
			createBundleVault(deps.dataDir),
			deps.docker.files(init.project.container_id, repoLoc.containerPath),
			executor,
			repoLoc,
			{ projectId: init.project.id, repoName: name, branch: this.branch },
		);
		if (!recovered.ok) {
			// A bundle exists for this branch and this clone does not have its
			// commits. Recorded so finalize does not mistake "nothing unpushed here"
			// for "the work is safely on origin" and drop the only copy.
			this.recoveryFailed.add(repoLoc.containerPath);
			warn(recovered.reason);
		} else if (recovered.bytes !== null) {
			emitSystem(
				'stdout',
				`${name}: recovered commits an earlier run could not push (${recovered.bytes} bytes)`,
			);
		}

		emitSystem('stdout', `git worktree ${name}...`);
		const wt = await ensureTaskWorktreeWithRetry(
			executor,
			repoLoc,
			wtLoc,
			this.branch,
			async () => {
				// A transient bind-mount ENOENT right after a reprovision — re-assert the
				// task root is visible in-container before git retries the add.
				await ensureContainerDirReady(deps.docker, init.project.container_id, this.taskRoot);
				emitSystem('stderr', `git worktree ${name}: mount not ready, retrying`);
			},
		);
		if (!wt.success) {
			emitSystem('stderr', `git worktree for ${name} failed: ${wt.error ?? 'unknown'}`);
			return { error: `the task worktree could not be created: ${wt.error ?? 'unknown'}`, notes };
		}
		if (wt.created) emitSystem('stdout', `git worktree add ${name} @ ${this.branch}`);

		// Bring any recovered commits onto the task branch itself, so they are the
		// agent's starting point rather than a ref it would have to know to look for.
		const replayed = await fastForwardFromRecovery(executor, wtLoc, this.branch);
		if (replayed.warning) {
			warn(replayed.warning);
		} else if (replayed.merged) {
			emitSystem('stdout', `${name}: replayed recovered commits onto ${this.branch}`);
		}

		// Catch the task branch up to the freshly-fetched trunk so a resumed task
		// starts from the current default. A merge failure is non-fatal: the
		// worktree is still usable and the agent reconciles.
		const caughtUp = await mergeDefaultIntoWorktree(executor, repoLoc, wtLoc);
		if (caughtUp.warning) {
			warn(caughtUp.warning);
		} else if (caughtUp.merged) {
			emitSystem('stdout', `${name}: caught up ${this.branch} to origin default`);
		}

		// Taken after the catch-up, so a pure catch-up with no agent work is not
		// mistaken for produced output.
		const headBefore = await getWorktreeHead(executor, wtLoc);
		this.ready.set(repo.id, {
			result: { ...this.describe(repo), ready: true, notes },
			worktree: { loc: wtLoc, headBefore },
			clone: { ...repoLoc, repoId: repo.id },
		});
		return { ok: true };
	}

	/**
	 * Reclaim finished tasks' worktrees, then measure the container's disk.
	 * Worktrees are kept after a run (a task gets many runs), so a container
	 * serving many tasks accumulates them; a managed sandbox has a few GB in
	 * total. Bounded per repo and best-effort: reclaimed disk is never worth
	 * failing a prep over. The measurement follows the reclaim so the figure the
	 * pool recycles on is the disk actually unavailable.
	 */
	private async housekeep(executor: GitExecutor): Promise<void> {
		const { deps, init } = this;
		const clones = [...this.ready.values()].map((r) => r.clone);
		try {
			const gc = await collectFinishedWorktrees(
				deps.db,
				executor,
				init.project.id,
				clones,
				undefined,
				undefined,
				// Never this run's own worktree: a run on a closed task (a comment, a
				// mention, a Coach review) would otherwise delete the folder it works in.
				init.task.identifier,
			);
			if (gc.removed.length > 0) {
				init.emit(
					'stdout',
					`[system] (reclaimed ${gc.removed.length} finished task worktree(s)${gc.deferred ? ', more remain for the next run' : ''})\n`,
				);
			}
		} catch (e) {
			log.error(`Project ${init.project.id}: worktree GC failed:`, e);
		}
		// Null means the measurement could not be taken, which leaves the previous
		// figure alone - reporting an unmeasurable container as empty would defeat
		// the recycle rung entirely.
		try {
			const used = await deps.docker.diskUsedBytes(
				init.project.container_id,
				CONTAINER_WORKSPACE_ROOT,
			);
			if (used !== null) await setPoolMemberDiskUsage(deps.db, init.project.container_id, used);
		} catch (e) {
			log.error(`Project ${init.project.id}: disk measurement failed:`, e);
		}
	}
}

/**
 * The live sessions, by run id, so the `prepare_repos` tool reaches the run it
 * is called from. Bounded by the runs in flight: a run registers before its
 * CLI starts and removes itself in its cleanup, on every exit path.
 */
const sessions = new Map<string, RunRepoSession>();

export function registerRunRepoSession(runId: string, session: RunRepoSession): () => void {
	sessions.set(runId, session);
	return () => {
		session.close();
		if (sessions.get(runId) === session) sessions.delete(runId);
	};
}

export function getRunRepoSession(runId: string): RunRepoSession | null {
	return sessions.get(runId) ?? null;
}
