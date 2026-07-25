// prepareWorktrees coverage: the repo-sync + fetch + fast-forward + worktree
// add/reuse + catch-up-merge pipeline runAgent runs before the agent exec, and
// the run-success detection driven by worktree changes. Git never actually
// runs — a scripted docker answers each `git …` exec by rule, while the host
// filesystem (clone `.git` dirs, worktree dirs) is staged per scenario.

import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { ContainerStatus, HeartbeatRunStatus } from '@hezo/shared';
import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { MasterKeyManager } from '../src/crypto/master-key';
import type { Db } from '../src/db/database';
import { runLogTextSql } from '../src/db/run-log-chunks';
import type { Env } from '../src/lib/types';
import { type RunnerDeps, runAgent } from '../src/services/agent-runner';
import type { DockerClient } from '../src/services/docker';
import { LogStreamBroker } from '../src/services/log-stream-broker';
import { getWorkspacePath, getWorktreesPath } from '../src/services/workspace';
import { safeClose } from './helpers';
import {
	authHeader,
	createStubDocker,
	createTestApp,
	createTestProject,
	createTestTeam,
} from './helpers/app';
import { withRunUserStub } from './helpers/run-user-docker';

let app: Hono<Env>;
let db: Db;
let adminToken: string;
let masterKeyManager: MasterKeyManager;
let dataDir: string;
let teamId: string;
let projectId: string;
let projectSlug: string;
let taskId: string;
let agentId: string;

const originalFetch = globalThis.fetch;

beforeAll(async () => {
	const ctx = await createTestApp();
	app = ctx.app;
	db = ctx.db;
	adminToken = ctx.token;
	masterKeyManager = ctx.masterKeyManager;
	dataDir = ctx.dataDir;

	const typesRes = await app.request('/api/team-templates', { headers: authHeader(adminToken) });
	const typeId = (await typesRes.json()).data.find((t: any) => t.name === 'App Team').id;
	const teamRes = await createTestTeam(db, { name: 'Worktree Co', template_id: typeId });
	teamId = (await teamRes.json()).data.id;

	globalThis.fetch = vi.fn().mockResolvedValue({ ok: true }) as unknown as typeof fetch;
	await app.request('/api/ai-providers', {
		method: 'POST',
		headers: { ...authHeader(adminToken), 'Content-Type': 'application/json' },
		body: JSON.stringify({
			provider: 'anthropic',
			api_key: 'sk-ant-worktree-key',
			label: 'anthropic-worktree',
		}),
	});
	globalThis.fetch = originalFetch;

	const projectRes = await createTestProject(db, teamId, {
		name: 'Worktree Project',
		description: 'Worktree test project.',
	});
	const projectData = (await projectRes.json()).data;
	projectId = projectData.id;
	projectSlug = projectData.slug;

	const agentsRes = await app.request(`/api/projects/${projectSlug}/agents`, {
		headers: authHeader(adminToken),
	});
	agentId = (await agentsRes.json()).data[0].id;

	const taskRes = await app.request(`/api/projects/${projectSlug}/tasks`, {
		method: 'POST',
		headers: { ...authHeader(adminToken), 'Content-Type': 'application/json' },
		body: JSON.stringify({
			project_id: projectId,
			title: 'Worktree Task',
			description: 'Worktree description',
			assignee_id: agentId,
		}),
	});
	taskId = (await taskRes.json()).data.id;
});

afterAll(async () => {
	await safeClose(db);
});

function makeAgent() {
	return { id: agentId, title: 'Worktree Agent', slug: 'wt-agent', team_id: teamId };
}

function makeTask(identifier: string, overrides: Record<string, unknown> = {}) {
	return {
		id: taskId,
		identifier,
		title: 'Worktree Task',
		description: 'Worktree description',
		status: 'backlog',
		priority: 'medium',
		project_id: projectId,
		rules: null,
		progress_summary: null,
		...overrides,
	};
}

function makeProject(overrides: Record<string, unknown> = {}) {
	return {
		id: projectId,
		slug: projectSlug,
		team_id: teamId,
		team_slug: 'worktree-co',
		container_id: 'container-wt',
		container_status: ContainerStatus.Running,
		designated_repo_id: null,
		is_internal: false,
		...overrides,
	};
}

function baseDeps(docker: DockerClient): RunnerDeps {
	return {
		db,
		docker,
		masterKeyManager,
		serverPort: 3000,
		dataDir,
		logs: new LogStreamBroker(),
	};
}

interface GitResult {
	exitCode?: number;
	stdout?: string;
	stderr?: string;
}
/** Returns a scripted result for a `git <args>` exec, or null to fall through. */
type GitRule = (argLine: string, cwd: string) => GitResult | null;

const when =
	(pred: (argLine: string, cwd: string) => boolean, res: GitResult | (() => GitResult)): GitRule =>
	(argLine, cwd) =>
		pred(argLine, cwd) ? (typeof res === 'function' ? res() : res) : null;

/**
 * Docker stub that dispatches `git …` execs through the given rules (default:
 * exit 0, empty output), answers the runner's `sh -c 'mkdir -p …'` dir-ready
 * checks, and treats everything else as the agent CLI exec.
 */
function scriptedGitDocker(opts: {
	rules: GitRule[];
	onAgentExec?: (config: { Cmd: string[]; Env: string[] }) => Promise<void> | void;
	agentExitCode?: number;
}): DockerClient {
	const results = new Map<string, { exitCode: number; stdout: string; stderr: string }>();
	let seq = 0;
	const base = createStubDocker({
		execCreate: async (_cid: string, config: any) => {
			const cmd: string[] = config.Cmd ?? [];
			const id = `exec-wt-${seq++}`;
			if (cmd[0] === 'git') {
				const argLine = cmd.slice(1).join(' ');
				let res: GitResult | null = null;
				for (const rule of opts.rules) {
					res = rule(argLine, config.WorkingDir ?? '');
					if (res) break;
				}
				results.set(id, {
					exitCode: res?.exitCode ?? 0,
					stdout: res?.stdout ?? '',
					stderr: res?.stderr ?? '',
				});
			} else if (
				cmd[0] === 'sh' &&
				cmd[1] === '-c' &&
				typeof cmd[2] === 'string' &&
				cmd[2].startsWith('mkdir -p')
			) {
				results.set(id, { exitCode: 0, stdout: '', stderr: '' });
			} else {
				// The agent CLI exec (prompt-delivery wrapper).
				await opts.onAgentExec?.(config);
				results.set(id, { exitCode: opts.agentExitCode ?? 0, stdout: 'done', stderr: '' });
			}
			return id;
		},
		execStart: async (id: string) => {
			const r = results.get(id) ?? { stdout: '', stderr: '', exitCode: 0 };
			return { stdout: r.stdout, stderr: r.stderr };
		},
		execInspect: async (id: string) => ({
			ExitCode: results.get(id)?.exitCode ?? 0,
			Running: false,
			Pid: 0,
		}),
	});
	return withRunUserStub(base as unknown as DockerClient);
}

async function insertRepo(identifier: string): Promise<string> {
	const r = await db.query<{ id: string }>(
		`INSERT INTO repos (project_id, repo_identifier, host_type)
		 VALUES ($1, $2, 'github') RETURNING id`,
		[projectId, identifier],
	);
	return r.rows[0].id;
}

async function markProducedOutput() {
	await db.query(
		`UPDATE heartbeat_runs SET produced_output = true WHERE member_id = $1 AND status = 'running'`,
		[agentId],
	);
}

async function runLog(runId: string): Promise<string> {
	const r = await db.query<{ log_text: string | null; working_dir: string | null }>(
		`SELECT ${runLogTextSql('heartbeat_runs.id')} AS log_text, working_dir FROM heartbeat_runs WHERE id = $1`,
		[runId],
	);
	return r.rows[0].log_text ?? '';
}

describe('prepareWorktrees', () => {
	it('creates a fresh task worktree off origin default, surfacing fetch/ff/merge warnings non-fatally', async () => {
		const repoId = await insertRepo('acme/todos');
		const clone = join(getWorkspacePath(dataDir, teamId, projectId), 'todos');
		mkdirSync(join(clone, '.git'), { recursive: true });
		try {
			const docker = scriptedGitDocker({
				rules: [
					// Origin points at the wrong repo → repo-sync repoints it (repaired).
					when((a) => a === 'remote get-url origin', {
						stdout: 'git@github.com:someone-else/old.git\n',
					}),
					when((a) => a.startsWith('remote set-url origin'), { exitCode: 0 }),
					when((a) => a === 'fetch --prune origin', { exitCode: 1, stderr: 'network down' }),
					when((a) => a === 'symbolic-ref --short refs/remotes/origin/HEAD', {
						stdout: 'origin/main\n',
					}),
					when((a) => a.startsWith('rev-parse --verify --quiet refs/remotes/origin/main'), {
						exitCode: 0,
					}),
					when((a) => a === 'symbolic-ref --quiet --short HEAD', { stdout: 'main\n' }),
					when((a) => a === 'merge --ff-only origin/main', {
						exitCode: 1,
						stderr: 'fatal: not possible to fast-forward',
					}),
					when((a) => a.startsWith('show-ref --verify --quiet refs/heads/hezo/'), {
						exitCode: 1,
					}),
					when((a) => a.startsWith('rev-parse --verify origin/hezo/'), { exitCode: 1 }),
					when((a) => a === 'merge-base --is-ancestor origin/main HEAD', { exitCode: 1 }),
					when((a) => a === 'status --porcelain', { stdout: '' }),
					when((a) => a === 'merge --no-edit origin/main', {
						exitCode: 1,
						stderr: 'CONFLICT (content): merge conflict in src/app.ts',
					}),
				],
				onAgentExec: markProducedOutput,
			});

			const result = await runAgent(
				baseDeps(docker),
				makeAgent(),
				makeTask('WT-CREATE'),
				makeProject(),
			);
			expect(result.success).toBe(true);

			const run = await db.query<{ status: string; working_dir: string | null }>(
				'SELECT status, working_dir FROM heartbeat_runs WHERE id = $1',
				[result.heartbeatRunId],
			);
			expect(run.rows[0].status).toBe(HeartbeatRunStatus.Succeeded);
			expect(run.rows[0].working_dir).toBe('/worktrees/WT-CREATE/todos');

			const log = await runLog(result.heartbeatRunId!);
			expect(log).toContain('(syncing repos...)');
			expect(log).toContain('(repaired 1 repo(s) with a broken origin)');
			expect(log).toContain('git fetch todos failed: network down');
			expect(log).toContain('could not fast-forward main');
			expect(log).toContain('git worktree add todos @ hezo/WT-CREATE');
			expect(log).toContain('could not merge origin/main');

			// The durability post-commit hook was installed into the clone.
			expect(existsSync(join(clone, '.git', 'hooks', 'post-commit'))).toBe(true);
		} finally {
			await db.query('DELETE FROM repos WHERE id = $1', [repoId]);
		}
	});

	it('reuses an existing worktree, merges trunk in, and counts a dirty tree as produced output', async () => {
		const repoId = await insertRepo('acme/todos');
		const clone = join(getWorkspacePath(dataDir, teamId, projectId), 'todos');
		mkdirSync(join(clone, '.git'), { recursive: true });
		const wt = join(getWorktreesPath(dataDir, teamId, projectId), 'WT-REUSE', 'todos');
		mkdirSync(join(wt, '.git'), { recursive: true });
		try {
			let agentRan = false;
			const docker = scriptedGitDocker({
				rules: [
					when((a) => a === 'remote get-url origin', {
						stdout: 'git@github.com:acme/todos.git\n',
					}),
					when((a) => a === 'symbolic-ref --short refs/remotes/origin/HEAD', {
						stdout: 'origin/main\n',
					}),
					when((a) => a.startsWith('rev-parse --verify --quiet refs/remotes/origin/main'), {
						exitCode: 0,
					}),
					when((a) => a === 'symbolic-ref --quiet --short HEAD', { stdout: 'main\n' }),
					when((a) => a === 'rev-parse --git-dir', { stdout: '.git\n' }),
					when((a) => a === 'merge-base --is-ancestor origin/main HEAD', { exitCode: 1 }),
					// Clean before the agent runs (so the catch-up merge proceeds),
					// dirty after (so the run counts as a code change).
					when(
						(a) => a === 'status --porcelain',
						() => ({ stdout: agentRan ? ' M src/app.ts\n' : '' }),
					),
					when((a) => a === 'merge --no-edit origin/main', { exitCode: 0 }),
					when((a) => a === 'rev-parse HEAD', { stdout: 'aaa111\n' }),
				],
				onAgentExec: () => {
					// Deliberately NOT flagging produced_output — success must come from
					// the detected worktree change alone.
					agentRan = true;
				},
			});

			const result = await runAgent(
				baseDeps(docker),
				makeAgent(),
				makeTask('WT-REUSE'),
				makeProject(),
			);
			expect(result.success).toBe(true);

			const run = await db.query<{
				status: string;
				working_dir: string | null;
				produced_output: boolean;
			}>('SELECT status, working_dir, produced_output FROM heartbeat_runs WHERE id = $1', [
				result.heartbeatRunId,
			]);
			expect(run.rows[0].status).toBe(HeartbeatRunStatus.Succeeded);
			expect(run.rows[0].working_dir).toBe('/worktrees/WT-REUSE/todos');
			// No MCP write happened; the worktree diff alone made this a success.
			expect(run.rows[0].produced_output).toBe(false);

			const log = await runLog(result.heartbeatRunId!);
			expect(log).toContain('caught up hezo/WT-REUSE to origin default');
		} finally {
			await db.query('DELETE FROM repos WHERE id = $1', [repoId]);
		}
	});

	it('clones a missing repo on demand, skips its worktree, and runs in the designated repo', async () => {
		const libId = await insertRepo('acme/lib');
		const appId = await insertRepo('acme/app');
		const appClone = join(getWorkspacePath(dataDir, teamId, projectId), 'app');
		mkdirSync(join(appClone, '.git'), { recursive: true });
		const wt = join(getWorktreesPath(dataDir, teamId, projectId), 'WT-DESIG', 'app');
		mkdirSync(join(wt, '.git'), { recursive: true });
		try {
			const docker = scriptedGitDocker({
				rules: [
					when((a, cwd) => a === 'remote get-url origin' && cwd.endsWith('/app'), {
						stdout: 'git@github.com:acme/app.git\n',
					}),
					// `git clone …` for acme/lib "succeeds" (default exit 0) but writes no
					// host .git — the worktree step must then skip it as not cloned.
					when((a) => a === 'symbolic-ref --short refs/remotes/origin/HEAD', {
						stdout: 'origin/main\n',
					}),
					when((a) => a.startsWith('rev-parse --verify --quiet refs/remotes/origin/main'), {
						exitCode: 0,
					}),
					when((a) => a === 'symbolic-ref --quiet --short HEAD', { stdout: 'main\n' }),
					when((a) => a === 'rev-parse --git-dir', { stdout: '.git\n' }),
					// Worktree already contains origin/main → no catch-up merge needed.
					when((a) => a === 'merge-base --is-ancestor origin/main HEAD', { exitCode: 0 }),
					when((a) => a === 'status --porcelain', { stdout: '' }),
					when((a) => a === 'rev-parse HEAD', { stdout: 'bbb222\n' }),
				],
				onAgentExec: markProducedOutput,
			});

			const result = await runAgent(
				baseDeps(docker),
				makeAgent(),
				makeTask('WT-DESIG'),
				makeProject({ designated_repo_id: appId }),
			);
			expect(result.success).toBe(true);

			const run = await db.query<{ working_dir: string | null }>(
				'SELECT working_dir FROM heartbeat_runs WHERE id = $1',
				[result.heartbeatRunId],
			);
			// The designated repo (not the first-created `lib`) hosts the run cwd.
			expect(run.rows[0].working_dir).toBe('/worktrees/WT-DESIG/app');

			const log = await runLog(result.heartbeatRunId!);
			expect(log).toContain('(cloned 1 repo(s) on demand)');
			expect(log).toContain('(skipping worktree for lib — not cloned)');
		} finally {
			await db.query('DELETE FROM repos WHERE id = ANY($1::uuid[])', [[libId, appId]]);
		}
	});

	it('fails the run before the agent exec when the primary repo worktree cannot be prepared', async () => {
		const repoId = await insertRepo('acme/ghost');
		try {
			let agentExeced = false;
			const docker = scriptedGitDocker({
				rules: [],
				onAgentExec: () => {
					agentExeced = true;
				},
			});
			const result = await runAgent(
				baseDeps(docker),
				makeAgent(),
				makeTask('WT-GHOST'),
				makeProject(),
			);
			expect(result.success).toBe(false);
			expect(agentExeced).toBe(false);
			expect(result.stderr).toContain('cannot prepare worktree for ghost');
			const run = await db.query<{ status: string; error: string | null }>(
				'SELECT status, error FROM heartbeat_runs WHERE id = $1',
				[result.heartbeatRunId],
			);
			expect(run.rows[0].status).toBe(HeartbeatRunStatus.Failed);
			expect(run.rows[0].error).toContain('cannot prepare worktree for ghost');
		} finally {
			await db.query('DELETE FROM repos WHERE id = $1', [repoId]);
		}
	});

	it('retries a transient mount ENOENT on worktree add and records a non-transient secondary failure', async () => {
		const todosId = await insertRepo('acme/todos');
		const extraId = await insertRepo('acme/extra');
		const ws = getWorkspacePath(dataDir, teamId, projectId);
		mkdirSync(join(ws, 'todos', '.git'), { recursive: true });
		mkdirSync(join(ws, 'extra', '.git'), { recursive: true });
		try {
			let todosAddAttempts = 0;
			const docker = scriptedGitDocker({
				rules: [
					when((a, cwd) => a === 'remote get-url origin' && cwd.endsWith('/todos'), {
						stdout: 'git@github.com:acme/todos.git\n',
					}),
					when((a, cwd) => a === 'remote get-url origin' && cwd.endsWith('/extra'), {
						stdout: 'git@github.com:acme/extra.git\n',
					}),
					when((a) => a === 'symbolic-ref --short refs/remotes/origin/HEAD', {
						stdout: 'origin/main\n',
					}),
					when((a) => a.startsWith('rev-parse --verify --quiet refs/remotes/origin/main'), {
						exitCode: 0,
					}),
					when((a) => a === 'symbolic-ref --quiet --short HEAD', { stdout: 'main\n' }),
					when((a) => a === 'merge --ff-only origin/main', { exitCode: 0 }),
					when((a) => a.startsWith('show-ref --verify --quiet refs/heads/hezo/'), {
						exitCode: 1,
					}),
					when((a) => a.startsWith('rev-parse --verify origin/hezo/'), { exitCode: 1 }),
					// todos: first add fails with a transient mount ENOENT, retry succeeds.
					when(
						(a) => a.startsWith('worktree add') && a.includes('/todos'),
						() => {
							todosAddAttempts++;
							return todosAddAttempts === 1
								? {
										exitCode: 1,
										stderr:
											"fatal: could not open '/worktrees/WT-RETRY/todos/.git' for writing: No such file or directory",
									}
								: { exitCode: 0 };
						},
					),
					// extra: fails hard (non-transient) → recorded, run proceeds on primary.
					when((a) => a.startsWith('worktree add') && a.includes('/extra'), {
						exitCode: 1,
						stderr: 'fatal: not a git repository',
					}),
					when((a) => a === 'merge-base --is-ancestor origin/main HEAD', { exitCode: 0 }),
					when((a) => a === 'status --porcelain', { stdout: '' }),
				],
				onAgentExec: markProducedOutput,
			});

			const result = await runAgent(
				baseDeps(docker),
				makeAgent(),
				makeTask('WT-RETRY'),
				makeProject(),
			);
			expect(result.success).toBe(true);
			expect(todosAddAttempts).toBe(2);

			const run = await db.query<{ working_dir: string | null }>(
				'SELECT working_dir FROM heartbeat_runs WHERE id = $1',
				[result.heartbeatRunId],
			);
			expect(run.rows[0].working_dir).toBe('/worktrees/WT-RETRY/todos');

			const log = await runLog(result.heartbeatRunId!);
			expect(log).toContain('git worktree todos: mount not ready, retrying');
			expect(log).toContain('git worktree for extra failed: fatal: not a git repository');
		} finally {
			await db.query('DELETE FROM repos WHERE id = ANY($1::uuid[])', [[todosId, extraId]]);
		}
	});

	it('fails a clean exit whose worktree is unchanged and produced no other output', async () => {
		const repoId = await insertRepo('acme/todos');
		const clone = join(getWorkspacePath(dataDir, teamId, projectId), 'todos');
		mkdirSync(join(clone, '.git'), { recursive: true });
		const wt = join(getWorktreesPath(dataDir, teamId, projectId), 'WT-NOOP', 'todos');
		mkdirSync(join(wt, '.git'), { recursive: true });
		try {
			const docker = scriptedGitDocker({
				rules: [
					when((a) => a === 'remote get-url origin', {
						stdout: 'git@github.com:acme/todos.git\n',
					}),
					when((a) => a === 'symbolic-ref --short refs/remotes/origin/HEAD', {
						stdout: 'origin/main\n',
					}),
					when((a) => a.startsWith('rev-parse --verify --quiet refs/remotes/origin/main'), {
						exitCode: 0,
					}),
					when((a) => a === 'symbolic-ref --quiet --short HEAD', { stdout: 'main\n' }),
					when((a) => a === 'rev-parse --git-dir', { stdout: '.git\n' }),
					when((a) => a === 'merge-base --is-ancestor origin/main HEAD', { exitCode: 0 }),
					// Clean tree and an unmoved HEAD before and after the run.
					when((a) => a === 'status --porcelain', { stdout: '' }),
					when((a) => a === 'rev-parse HEAD', { stdout: 'ccc333\n' }),
				],
				// The agent exits 0 without flagging any Hezo write and without
				// touching the worktree — a no-op run that must read as failed.
			});

			const result = await runAgent(
				baseDeps(docker),
				makeAgent(),
				makeTask('WT-NOOP'),
				makeProject(),
			);
			expect(result.success).toBe(false);
			expect(result.exitCode).toBe(0);

			const run = await db.query<{ status: string; error: string | null }>(
				'SELECT status, error FROM heartbeat_runs WHERE id = $1',
				[result.heartbeatRunId],
			);
			expect(run.rows[0].status).toBe(HeartbeatRunStatus.Failed);
			expect(run.rows[0].error).toContain('produced no output');
		} finally {
			await db.query('DELETE FROM repos WHERE id = $1', [repoId]);
		}
	});

	it('returns to /workspace when the abort lands during the worktree loop itself', async () => {
		const repoId = await insertRepo('acme/todos');
		const clone = join(getWorkspacePath(dataDir, teamId, projectId), 'todos');
		mkdirSync(join(clone, '.git'), { recursive: true });
		const wt = join(getWorktreesPath(dataDir, teamId, projectId), 'WT-LOOPAB', 'todos');
		mkdirSync(join(wt, '.git'), { recursive: true });
		const ac = new AbortController();
		try {
			const docker = scriptedGitDocker({
				rules: [
					when((a) => a === 'remote get-url origin', {
						stdout: 'git@github.com:acme/todos.git\n',
					}),
					when((a) => a === 'symbolic-ref --short refs/remotes/origin/HEAD', {
						stdout: 'origin/main\n',
					}),
					when((a) => a.startsWith('rev-parse --verify --quiet refs/remotes/origin/main'), {
						exitCode: 0,
					}),
					when((a) => a === 'symbolic-ref --quiet --short HEAD', { stdout: 'main\n' }),
					when((a) => a === 'rev-parse --git-dir', { stdout: '.git\n' }),
					// Abort mid-iteration: the loop finishes this repo, then the
					// post-loop abort check returns the /workspace fallback.
					when(
						(a) => a === 'merge-base --is-ancestor origin/main HEAD',
						() => {
							ac.abort();
							return { exitCode: 0 };
						},
					),
				],
				onAgentExec: () => {
					throw new Error('agent must not exec after abort');
				},
			});
			const result = await runAgent(
				baseDeps(docker),
				makeAgent(),
				makeTask('WT-LOOPAB'),
				makeProject(),
				undefined,
				ac.signal,
			);
			expect(result.success).toBe(false);
			const run = await db.query<{ status: string }>(
				'SELECT status FROM heartbeat_runs WHERE id = $1',
				[result.heartbeatRunId],
			);
			expect(run.rows[0].status).toBe(HeartbeatRunStatus.Cancelled);
		} finally {
			await db.query('DELETE FROM repos WHERE id = $1', [repoId]);
		}
	});

	it('bails out of worktree prep and cancels the run when aborted during repo sync', async () => {
		const repoId = await insertRepo('acme/todos');
		const clone = join(getWorkspacePath(dataDir, teamId, projectId), 'todos');
		mkdirSync(join(clone, '.git'), { recursive: true });
		const ac = new AbortController();
		try {
			const docker = scriptedGitDocker({
				rules: [
					when(
						(a) => a === 'remote get-url origin',
						() => {
							ac.abort();
							return { stdout: 'git@github.com:acme/todos.git\n' };
						},
					),
				],
				onAgentExec: () => {
					throw new Error('agent must not exec after abort');
				},
			});
			const result = await runAgent(
				baseDeps(docker),
				makeAgent(),
				makeTask('WT-ABORT'),
				makeProject(),
				undefined,
				ac.signal,
			);
			expect(result.success).toBe(false);
			const run = await db.query<{ status: string }>(
				'SELECT status FROM heartbeat_runs WHERE id = $1',
				[result.heartbeatRunId],
			);
			expect(run.rows[0].status).toBe(HeartbeatRunStatus.Cancelled);
			const log = await runLog(result.heartbeatRunId!);
			expect(log).toContain('(syncing repos...)');
		} finally {
			await db.query('DELETE FROM repos WHERE id = $1', [repoId]);
		}
	});
});
