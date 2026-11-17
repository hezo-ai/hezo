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
	worktreeHasChanges,
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
	/** With no `headBefore`: commits dated from here on count as this run's work. */
	since?: Date;
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
	/**
	 * The repository's own instruction files at its root. A CLI loads these only
	 * when it starts inside the repo, and a run now starts in the task folder, so
	 * the agent is handed them to read instead.
	 */
	instructions?: string[];
}

/**
 * Whether a folder is a linked worktree: its `.git` is a file pointing at the
 * clone's admin entry. A `.git` directory is a separate clone or `git init` an
 * agent made itself, which Hezo neither pushes from nor scans.
 */
async function isLinkedWorktree(loc: WorktreeLoc): Promise<boolean> {
	if (!(await loc.files.exists('.git'))) return false;
	try {
		return (await loc.files.read('.git')).startsWith('gitdir:');
	} catch {
		return false;
	}
}

/** What sits in the task folder outside the worktrees Hezo manages. */
export interface TaskRootStrays {
	/** Folders holding a git checkout that is not a task worktree. */
	checkouts: string[];
	/** The task folder itself is a git repository. */
	rootIsRepo: boolean;
	/** Plain entries directly in the task folder, by name. */
	entries: string[];
}

/** Root files a repo keeps its agent conventions in, across the runtimes Hezo drives. */
const REPO_INSTRUCTION_FILES = ['AGENTS.md', 'CLAUDE.md', 'GEMINI.md'] as const;

export interface PrepareReposResult {
	branch: string;
	repos: PreparedRepo[];
}

/** The answer while a prep is still running past {@link PREPARE_REPLY_WAIT_MS}. */
export interface PrepareReposPending {
	branch: string;
	pending: true;
	message: string;
}

/**
 * How long a `prepare_repos` call waits before answering "still preparing".
 * The tool call is one HTTP request, and the server cuts a request idle for 120 s
 * (`idleTimeout` in `index.ts`); a first clone on a fresh container, or one queued
 * behind another run's prep on the project git lock, can take longer. The prep
 * keeps running, and the agent's next call waits for it again.
 */
export const PREPARE_REPLY_WAIT_MS = 90_000;

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
	/** When the run started, for change detection in a worktree it did not prepare. */
	startedAt: Date;
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

	/**
	 * {@link prepare}, answering "still preparing" once `waitMs` passes. The prep
	 * is not abandoned: it stays in flight, finalize waits for it, and a repeat
	 * call queues behind it on the lock and answers from its result.
	 */
	async prepareWithin(
		requested: string[] | undefined,
		waitMs: number = PREPARE_REPLY_WAIT_MS,
	): Promise<PrepareReposResult | PrepareReposPending | { error: string }> {
		let timer: ReturnType<typeof setTimeout> | undefined;
		const pending = new Promise<PrepareReposPending>((resolve) => {
			timer = setTimeout(
				() =>
					resolve({
						branch: this.branch,
						pending: true,
						message:
							'Still preparing: a clone or fetch is taking a while. Call prepare_repos again with the same repositories to wait for it.',
					}),
				waitMs,
			);
		});
		try {
			return await Promise.race([this.prepare(requested), pending]);
		} finally {
			clearTimeout(timer);
		}
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
		const leftovers: Array<{ worktree: WorktreeRef; clone: CloneRef }> = [];
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
			if (!(await isLinkedWorktree(loc))) continue;
			leftovers.push({
				worktree: { loc, headBefore: null, since: this.init.startedAt },
				clone: { ...this.cloneLoc(name), repoId: repo.id },
			});
		}
		if (worktrees.length === 0 && leftovers.length === 0) {
			return { ...EMPTY_RUN_REPO_VIEW, branch: this.branch };
		}
		const executor = await this.executor(signal);
		// A leftover worktree counts only when this run touched it (a dirty tree,
		// or a commit dated from the run's start). It was never fetched this run,
		// so its tracking refs may be stale: scanning one this run never touched
		// would report, and pin the container for, work an earlier run already
		// accounted for.
		for (const { worktree, clone } of leftovers) {
			if (!(await worktreeHasChanges(executor, worktree.loc, null, worktree.since))) continue;
			worktrees.push(worktree);
			clones.push(clone);
		}
		if (worktrees.length === 0) return { ...EMPTY_RUN_REPO_VIEW, branch: this.branch };
		return {
			executor,
			worktrees,
			clones,
			preparedClones,
			branch: this.branch,
			recoveryFailed: this.recoveryFailed,
		};
	}

	/**
	 * What an agent left in the task folder outside the worktrees: a checkout it
	 * cloned or initialised itself (never pushed, never scanned, lost with the
	 * container), and the plain files a finalize check reads by name.
	 */
	async strays(): Promise<TaskRootStrays> {
		const root = this.deps.docker.files(this.init.project.container_id, this.taskRoot);
		const entries = await root.list('.');
		const checkouts: string[] = [];
		for (const name of entries) {
			if (name === '.git') continue;
			const loc = this.worktreeLoc(name);
			if ((await loc.files.exists('.git')) && !(await isLinkedWorktree(loc))) {
				checkouts.push(loc.containerPath);
			}
		}
		return { checkouts, rootIsRepo: entries.includes('.git'), entries };
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
		const env = [...identity, ...(init.egress ? buildEgressProxyEnv(init.egress) : [])];
		// No bridge runner of its own: prep runs while the agent CLI's runner is
		// live on the run's socket, and a second runner on that path (socat
		// `unlink-early`, then its exit trap) would delete the agent's socket and
		// leave every later commit unable to sign. Remote git rides HTTPS through
		// the egress proxy and needs no socket; a catch-up merge commit signs
		// through the agent's own live socket.
		if (init.bridge) env.push(`SSH_AUTH_SOCK=${init.bridge.socketPath}`);
		return ContainerGitExecutor.forPrep(
			deps.docker,
			init.project.container_id,
			null,
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

		// A checkout the agent made itself at the worktree's path would otherwise be
		// adopted as the task worktree (it answers `rev-parse --git-dir`), then
		// pushed from and scanned as if it were one.
		if ((await wtLoc.files.exists('.git')) && !(await isLinkedWorktree(wtLoc))) {
			emitSystem('stderr', `${name}: ${wtLoc.containerPath} holds a separate checkout`);
			return {
				error: `${wtLoc.containerPath} holds a separate git checkout, not the task worktree. Move anything you need out of it, delete the folder, and call prepare_repos again.`,
				notes,
			};
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
		const instructions: string[] = [];
		for (const file of REPO_INSTRUCTION_FILES) {
			if (await wtLoc.files.exists(file)) instructions.push(`${wtLoc.containerPath}/${file}`);
		}
		this.ready.set(repo.id, {
			result: { ...this.describe(repo), ready: true, notes, instructions },
			worktree: { loc: wtLoc, headBefore },
			clone: { ...repoLoc, repoId: repo.id },
		});
		return { ok: true };
	}

	/**
	 * Reclaim finished tasks' worktrees. Worktrees are kept after a run (a task
	 * gets many runs), so a container serving many tasks accumulates them; a
	 * managed sandbox has a few GB in total. Bounded per repo and best-effort:
	 * reclaimed disk is never worth failing a prep over.
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
	}

	/**
	 * Record how much of the container's disk is in use, at the end of every task
	 * run whether or not it prepared a repo, so the pool's recycle rung sees what
	 * runs actually leave behind. After any reclaim, so the figure is disk that is
	 * really unavailable. Null (an unreadable measurement) leaves the previous
	 * figure alone - reporting an unmeasurable container as empty would defeat the
	 * rung entirely.
	 */
	async measureDisk(): Promise<void> {
		const { deps, init } = this;
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
