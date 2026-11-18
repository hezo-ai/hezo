// Repo prep coverage: a run starts in its task root with no git work, and the
// agent's `prepare_repos` call runs the repo-sync + fetch + fast-forward +
// worktree add/reuse + catch-up-merge pipeline mid-run. Also the finalize scans
// and run-success detection driven by worktree changes. Git never actually runs
// — a scripted docker answers each `git …` exec by rule, while the host
// filesystem (clone `.git` dirs, worktree dirs) is staged per scenario. The
// agent's call goes over the MCP endpoint with its run token, as a real one does.

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ContainerStatus, HeartbeatRunStatus } from '@hezo/shared';
import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { MasterKeyManager } from '../src/crypto/master-key';
import type { Db } from '../src/db/database';
import { runLogTextSql } from '../src/db/run-log-chunks';
import type { Env } from '../src/lib/types';
import { DEFERRED_WORKING_DIR, type RunnerDeps, runAgent } from '../src/services/agent-runner';
import { resolveContainerRunUser } from '../src/services/container-user';
import { RECOVERY_BUNDLE_REL_PATH } from '../src/services/git';
import { LogStreamBroker } from '../src/services/log-stream-broker';
import { type PrepareReposResult, RunRepoSession } from '../src/services/run-repos';
import { createBundleVault } from '../src/services/sandbox/bundle-vault';
import type { ContainerEngine } from '../src/services/sandbox/types';
import { getWorkspacePath, getWorktreesPath } from '../src/services/workspace';
import { safeClose } from './helpers';
import {
	authHeader,
	createStubDocker,
	createTestApp,
	createTestProject,
	createTestTeam,
} from './helpers/app';
import { callMcpTool } from './helpers/mcp-call';
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

function baseDeps(docker: ContainerEngine): RunnerDeps {
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
	onGitExec?: (config: { Cmd: string[]; Env: string[]; WorkingDir?: string }) => void;
	/** Milliseconds a `git <args>` exec takes before it answers. */
	slowGit?: (argLine: string) => number;
	agentExitCode?: number;
}): ContainerEngine {
	const delays = new Map<string, number>();
	const results = new Map<string, { exitCode: number; stdout: string; stderr: string }>();
	let seq = 0;
	const base = createStubDocker({
		execCreate: async (_cid: string, config: any) => {
			const cmd: string[] = config.Cmd ?? [];
			const id = `exec-wt-${seq++}`;
			if (cmd[0] === 'git') {
				opts.onGitExec?.(config);
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
				const delay = opts.slowGit?.(argLine) ?? 0;
				if (delay > 0) delays.set(id, delay);
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
			const delay = delays.get(id);
			if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
			const r = results.get(id) ?? { stdout: '', stderr: '', exitCode: 0 };
			return { stdout: r.stdout, stderr: r.stderr };
		},
		execInspect: async (id: string) => ({
			ExitCode: results.get(id)?.exitCode ?? 0,
			Running: false,
			Pid: 0,
		}),
	});
	return withRunUserStub(base as unknown as ContainerEngine);
}

/**
 * Stage a task worktree on the host as git leaves one: a `.git` file pointing at
 * the clone's admin entry. A `.git` directory there is a separate checkout.
 */
function stageWorktree(dir: string): void {
	const [identifier, repo] = dir.split('/').slice(-2);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, '.git'), `gitdir: /workspace/${repo}/.git/worktrees/${identifier}\n`);
	// The clone's admin entry for it, so the worktree reads as healthy.
	const admin = join(
		getWorkspacePath(dataDir, teamId, projectId),
		repo,
		'.git',
		'worktrees',
		identifier,
	);
	mkdirSync(admin, { recursive: true });
	writeFileSync(join(admin, 'HEAD'), 'ref: refs/heads/main\n');
}

async function insertRepo(identifier: string): Promise<string> {
	const r = await db.query<{ id: string }>(
		`INSERT INTO repos (project_id, repo_identifier, host_type)
		 VALUES ($1, $2, 'github') RETURNING id`,
		[projectId, identifier],
	);
	return r.rows[0].id;
}

type PrepareReply = PrepareReposResult | { error: string };

/** The agent's `prepare_repos` call, over the MCP endpoint with its run token. */
async function prepareRepos(config: { Env: string[] }, repos?: string[]): Promise<PrepareReply> {
	const token = config.Env.find((e) => e.startsWith('HEZO_AGENT_TOKEN='))?.slice(17) ?? '';
	return callMcpTool<PrepareReply>(app, token, 'prepare_repos', repos ? { repos } : {});
}

function prepared(reply: PrepareReply): PrepareReposResult {
	if ('error' in reply) throw new Error(`prepare_repos refused: ${reply.error}`);
	return reply;
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

describe('repo prep on demand', () => {
	it('starts the agent in its task root with no git work done', async () => {
		const repoId = await insertRepo('acme/todos');
		mkdirSync(join(getWorkspacePath(dataDir, teamId, projectId), 'todos', '.git'), {
			recursive: true,
		});
		try {
			let gitExecs = 0;
			let gitExecsBeforeAgent = -1;
			const docker = scriptedGitDocker({
				rules: [],
				onGitExec: () => {
					gitExecs++;
				},
				onAgentExec: async () => {
					gitExecsBeforeAgent = gitExecs;
					await markProducedOutput();
				},
			});

			const result = await runAgent(
				baseDeps(docker),
				makeAgent(),
				makeTask('WT-LAZY'),
				makeProject(),
			);
			expect(result.success).toBe(true);
			expect(gitExecsBeforeAgent).toBe(0);
			expect(gitExecs).toBe(0);

			const run = await db.query<{ working_dir: string | null }>(
				'SELECT working_dir FROM heartbeat_runs WHERE id = $1',
				[result.heartbeatRunId],
			);
			expect(run.rows[0].working_dir).toBe('/worktrees/WT-LAZY');
			expect(await runLog(result.heartbeatRunId!)).not.toContain('(syncing repos...)');
		} finally {
			await db.query('DELETE FROM repos WHERE id = $1', [repoId]);
		}
	});

	it('answers a repeat call without git work, and runs prep under its own process scope', async () => {
		const repoId = await insertRepo('acme/todos');
		mkdirSync(join(getWorkspacePath(dataDir, teamId, projectId), 'todos', '.git'), {
			recursive: true,
		});
		stageWorktree(join(getWorktreesPath(dataDir, teamId, projectId), 'WT-TWICE', 'todos'));
		try {
			let gitExecs = 0;
			const gitScopes = new Set<string>();
			let agentRunId = '';
			let first: PrepareReply | null = null;
			let second: PrepareReply | null = null;
			let gitExecsForSecond = -1;
			const docker = scriptedGitDocker({
				rules: [
					when((a) => a === 'remote get-url origin', {
						stdout: 'https://github.com/acme/todos.git\n',
					}),
					when((a) => a === 'merge-base --is-ancestor origin/main HEAD', { exitCode: 0 }),
					when((a) => a === 'rev-parse HEAD', { stdout: 'eee555\n' }),
				],
				onGitExec: (config) => {
					gitExecs++;
					const scope = config.Env.find((e) => e.startsWith('HEZO_HEARTBEAT_RUN_ID='));
					if (scope) gitScopes.add(scope.slice(22));
				},
				onAgentExec: async (config) => {
					agentRunId =
						config.Env.find((e) => e.startsWith('HEZO_HEARTBEAT_RUN_ID='))?.slice(22) ?? '';
					first = await prepareRepos(config);
					const before = gitExecs;
					second = await prepareRepos(config, ['todos']);
					gitExecsForSecond = gitExecs - before;
					await markProducedOutput();
				},
			});

			const result = await runAgent(
				baseDeps(docker),
				makeAgent(),
				makeTask('WT-TWICE'),
				makeProject({ designated_repo_id: repoId }),
			);
			expect(result.success).toBe(true);

			expect(prepared(first!).repos).toEqual([
				{
					name: 'todos',
					repo: 'acme/todos',
					path: '/worktrees/WT-TWICE/todos',
					designated: true,
					ready: true,
					notes: [],
					instructions: [],
				},
			]);
			expect(prepared(first!).branch).toBe('hezo/WT-TWICE');
			expect(second).toEqual(first);
			expect(gitExecsForSecond).toBe(0);
			// The agent CLI carries the run id as its kill marker; a prep op that
			// timed out mid-run must not take the agent down with it.
			expect(agentRunId.length).toBeGreaterThan(0);
			expect(gitScopes.size).toBeGreaterThan(0);
			expect(gitScopes.has(agentRunId)).toBe(false);
		} finally {
			await db.query('DELETE FROM repos WHERE id = $1', [repoId]);
		}
	});

	it('prepares only the repos the agent names, and refuses a name that is not linked', async () => {
		const libId = await insertRepo('acme/only-lib');
		const appId = await insertRepo('acme/only-app');
		const ws = getWorkspacePath(dataDir, teamId, projectId);
		mkdirSync(join(ws, 'only-lib', '.git'), { recursive: true });
		mkdirSync(join(ws, 'only-app', '.git'), { recursive: true });
		try {
			const gitCwds: string[] = [];
			let unknown: PrepareReply | null = null;
			let onlyApp: PrepareReply | null = null;
			const docker = scriptedGitDocker({
				rules: [
					when((a, cwd) => a === 'remote get-url origin' && cwd.endsWith('/only-app'), {
						stdout: 'https://github.com/acme/only-app.git\n',
					}),
					when((a) => a === 'merge-base --is-ancestor origin/main HEAD', { exitCode: 0 }),
				],
				onGitExec: (config) => {
					gitCwds.push(config.WorkingDir ?? '');
				},
				onAgentExec: async (config) => {
					unknown = await prepareRepos(config, ['nope']);
					onlyApp = await prepareRepos(config, ['acme/only-app']);
					await markProducedOutput();
				},
			});

			const result = await runAgent(
				baseDeps(docker),
				makeAgent(),
				makeTask('WT-ONLY'),
				makeProject(),
			);
			expect(result.success).toBe(true);
			expect(unknown).toEqual({
				error: 'No linked repository is named "nope". Linked repositories: only-lib, only-app.',
			});
			expect(prepared(onlyApp!).repos.map((r) => [r.name, r.ready])).toEqual([['only-app', true]]);
			expect(gitCwds.some((cwd) => cwd.includes('only-lib'))).toBe(false);
		} finally {
			await db.query('DELETE FROM repos WHERE id = ANY($1::uuid[])', [[libId, appId]]);
		}
	});

	it("hands the agent the repo's own instruction files, which its CLI no longer loads", async () => {
		const repoId = await insertRepo('acme/todos');
		mkdirSync(join(getWorkspacePath(dataDir, teamId, projectId), 'todos', '.git'), {
			recursive: true,
		});
		const wt = join(getWorktreesPath(dataDir, teamId, projectId), 'WT-RULES', 'todos');
		stageWorktree(wt);
		writeFileSync(join(wt, 'AGENTS.md'), '# conventions');
		writeFileSync(join(wt, 'CLAUDE.md'), '# more conventions');
		try {
			let reply: PrepareReply | null = null;
			const docker = scriptedGitDocker({
				rules: [
					when((a) => a === 'remote get-url origin', {
						stdout: 'https://github.com/acme/todos.git\n',
					}),
					when((a) => a === 'merge-base --is-ancestor origin/main HEAD', { exitCode: 0 }),
				],
				onAgentExec: async (config) => {
					reply = await prepareRepos(config);
					await markProducedOutput();
				},
			});

			await runAgent(baseDeps(docker), makeAgent(), makeTask('WT-RULES'), makeProject());

			expect(prepared(reply!).repos[0].instructions).toEqual([
				'/worktrees/WT-RULES/todos/AGENTS.md',
				'/worktrees/WT-RULES/todos/CLAUDE.md',
			]);
		} finally {
			await db.query('DELETE FROM repos WHERE id = $1', [repoId]);
		}
	});

	it('refuses to adopt a checkout the agent made itself, and warns about it at the end', async () => {
		const repoId = await insertRepo('acme/todos');
		mkdirSync(join(getWorkspacePath(dataDir, teamId, projectId), 'todos', '.git'), {
			recursive: true,
		});
		// An agent ran `git clone` into the task folder: a `.git` directory, not a
		// worktree's `.git` file.
		mkdirSync(join(getWorktreesPath(dataDir, teamId, projectId), 'WT-OWNCLONE', 'todos', '.git'), {
			recursive: true,
		});
		try {
			let reply: PrepareReply | null = null;
			const docker = scriptedGitDocker({
				rules: [
					when((a) => a === 'remote get-url origin', {
						stdout: 'https://github.com/acme/todos.git\n',
					}),
				],
				onAgentExec: async (config) => {
					reply = await prepareRepos(config);
					await markProducedOutput();
				},
			});

			const result = await runAgent(
				baseDeps(docker),
				makeAgent(),
				makeTask('WT-OWNCLONE'),
				makeProject(),
			);

			const [todos] = prepared(reply!).repos;
			expect(todos.ready).toBe(false);
			expect(todos.error).toContain('separate git checkout');
			expect(await runLog(result.heartbeatRunId!)).toContain(
				'/worktrees/WT-OWNCLONE/todos is a separate git checkout',
			);
		} finally {
			await db.query('DELETE FROM repos WHERE id = $1', [repoId]);
		}
	});

	it('warns when a project doc is written as a file into the task folder', async () => {
		// The task folder is the working directory, so a relative write of a
		// doc-named file lands there, outside every worktree.
		const repoId = await insertRepo('acme/todos');
		const docRes = await app.request(`/api/projects/${projectSlug}/docs/prd.md`, {
			method: 'PUT',
			headers: { ...authHeader(adminToken), 'Content-Type': 'application/json' },
			body: JSON.stringify({ content: '# PRD' }),
		});
		expect(docRes.status).toBeLessThan(300);
		try {
			const docker = scriptedGitDocker({
				rules: [],
				onAgentExec: async () => {
					writeFileSync(
						join(getWorktreesPath(dataDir, teamId, projectId), 'WT-ROOTDOC', 'prd.md'),
						'# PRD, edited on disk',
					);
					await markProducedOutput();
				},
			});

			const result = await runAgent(
				baseDeps(docker),
				makeAgent(),
				makeTask('WT-ROOTDOC'),
				makeProject(),
			);

			expect(await runLog(result.heartbeatRunId!)).toContain(
				'this run wrote /worktrees/WT-ROOTDOC/prd.md to disk, but that filename is a project doc',
			);
		} finally {
			await db.query('DELETE FROM repos WHERE id = $1', [repoId]);
			await app.request(`/api/projects/${projectSlug}/docs/prd.md`, {
				method: 'DELETE',
				headers: authHeader(adminToken),
			});
		}
	});

	/** A session on the stub container, outside a run, for prep-only scenarios. */
	async function openSession(
		docker: ContainerEngine,
		identifier: string,
		repos: Array<{ id: string; repo_identifier: string }>,
		bridge: { socketPath: string } | null = null,
	): Promise<RunRepoSession> {
		// The stub engine resolves a container's files through the project row that
		// names it, as a run's acquisition leaves it.
		const containerId = 'stub-container';
		await db.query('UPDATE projects SET container_id = $1 WHERE id = $2', [containerId, projectId]);
		return RunRepoSession.open(
			{ db, docker, dataDir, masterKeyManager },
			{
				project: {
					id: projectId,
					team_id: teamId,
					container_id: containerId,
					designated_repo_id: null,
				},
				task: { identifier },
				repos,
				bridge: bridge
					? {
							socketPath: bridge.socketPath,
							socketUser: 'node',
							tokenHex: 'ab'.repeat(16),
							hostName: '127.0.0.1',
							hostPort: 45678,
						}
					: null,
				runUser: await resolveContainerRunUser(docker, containerId),
				egress: null,
				emit: () => {},
				signal: new AbortController().signal,
				startedAt: new Date(),
			},
		);
	}

	it("runs prep git bare, signing through the agent's own socket, never a second bridge", async () => {
		// The agent CLI's bridge runner already serves the run's socket. A second
		// runner on that path deletes it, and every later commit fails to sign.
		const repoId = await insertRepo('acme/todos');
		mkdirSync(join(getWorkspacePath(dataDir, teamId, projectId), 'todos', '.git'), {
			recursive: true,
		});
		try {
			const gitEnvs: string[][] = [];
			let otherExecs = 0;
			const docker = scriptedGitDocker({
				rules: [
					when((a) => a === 'remote get-url origin', {
						stdout: 'https://github.com/acme/todos.git\n',
					}),
				],
				onGitExec: (config) => {
					gitEnvs.push(config.Env);
				},
				// Anything that is neither bare git nor the dir-ready check lands here,
				// a bridge-wrapped git included.
				onAgentExec: () => {
					otherExecs++;
				},
			});
			const bridged = await openSession(
				docker,
				'WT-BRIDGE',
				[{ id: repoId, repo_identifier: 'acme/todos' }],
				{ socketPath: '/run/hezo/run-bridge.sock' },
			);

			const reply = await bridged.prepare();

			expect(prepared(reply).repos[0].ready).toBe(true);
			expect(otherExecs).toBe(0);
			expect(gitEnvs.length).toBeGreaterThan(0);
			for (const env of gitEnvs) expect(env).toContain('SSH_AUTH_SOCK=/run/hezo/run-bridge.sock');
		} finally {
			await db.query('DELETE FROM repos WHERE id = $1', [repoId]);
		}
	});

	it('answers "still preparing" past the wait, and the next call gets the result', async () => {
		const repoId = await insertRepo('acme/todos');
		mkdirSync(join(getWorkspacePath(dataDir, teamId, projectId), 'todos', '.git'), {
			recursive: true,
		});
		try {
			const docker = scriptedGitDocker({
				rules: [
					when((a) => a === 'remote get-url origin', {
						stdout: 'https://github.com/acme/todos.git\n',
					}),
				],
				slowGit: (a) => (a === 'fetch --prune origin' ? 300 : 0),
			});
			const session = await openSession(docker, 'WT-SLOW', [
				{ id: repoId, repo_identifier: 'acme/todos' },
			]);

			const first = await session.prepareWithin(undefined, 20);
			expect(first).toMatchObject({ branch: 'hezo/WT-SLOW', pending: true });
			expect((first as { message: string }).message).toContain('Call prepare_repos again');

			const second = await session.prepareWithin(undefined, 5_000);
			expect(prepared(second as PrepareReply).repos[0].ready).toBe(true);
			await session.settle();
		} finally {
			await db.query('DELETE FROM repos WHERE id = $1', [repoId]);
		}
	});

	it('never deletes an existing worktree because a check of it failed for another reason', async () => {
		// Prep now runs mid-run, so the worktree may hold the agent's uncommitted
		// edits. Only git saying the admin entry is gone licenses removing it.
		const repoId = await insertRepo('acme/todos');
		mkdirSync(join(getWorkspacePath(dataDir, teamId, projectId), 'todos', '.git'), {
			recursive: true,
		});
		const wt = join(getWorktreesPath(dataDir, teamId, projectId), 'WT-KEEPEDITS', 'todos');
		stageWorktree(wt);
		writeFileSync(join(wt, 'work-in-progress.ts'), 'export const x = 1;');
		try {
			const docker = scriptedGitDocker({
				rules: [
					when((a) => a === 'remote get-url origin', {
						stdout: 'https://github.com/acme/todos.git\n',
					}),
					when((a) => a === 'rev-parse --git-dir', { exitCode: 1, stderr: 'timed out after 30s' }),
				],
			});
			const session = await openSession(docker, 'WT-KEEPEDITS', [
				{ id: repoId, repo_identifier: 'acme/todos' },
			]);

			const reply = prepared(await session.prepare());

			expect(reply.repos[0].ready).toBe(false);
			expect(reply.repos[0].error).toContain('could not check the existing worktree');
			expect(existsSync(join(wt, 'work-in-progress.ts'))).toBe(true);
		} finally {
			await db.query('DELETE FROM repos WHERE id = $1', [repoId]);
		}
	});

	it('tells a run on a project with no linked repo that there is nothing to prepare', async () => {
		let reply: PrepareReply | null = null;
		const docker = scriptedGitDocker({
			rules: [],
			onAgentExec: async (config) => {
				reply = await prepareRepos(config);
				await markProducedOutput();
			},
		});

		const result = await runAgent(
			baseDeps(docker),
			makeAgent(),
			makeTask('WT-NONE'),
			makeProject(),
		);
		expect(result.success).toBe(true);
		expect(reply).toEqual({
			error:
				'This run has no repositories to prepare: its project has no linked repository, or the run is not working on a task.',
		});
		const run = await db.query<{ working_dir: string | null }>(
			'SELECT working_dir FROM heartbeat_runs WHERE id = $1',
			[result.heartbeatRunId],
		);
		expect(run.rows[0].working_dir).toBe('/workspace');
	});

	it('creates a fresh task worktree off origin default, surfacing fetch/ff/merge warnings non-fatally', async () => {
		const repoId = await insertRepo('acme/todos');
		const clone = join(getWorkspacePath(dataDir, teamId, projectId), 'todos');
		mkdirSync(join(clone, '.git'), { recursive: true });
		try {
			let reply: PrepareReply | null = null;
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
				onAgentExec: async (config) => {
					reply = await prepareRepos(config);
					await markProducedOutput();
				},
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
			expect(run.rows[0].working_dir).toBe('/worktrees/WT-CREATE');

			// The warnings reach the agent as well as the log: it is the one that
			// has to resolve the conflict the catch-up merge stopped on.
			const [todos] = prepared(reply!).repos;
			expect(todos.ready).toBe(true);
			expect(todos.path).toBe('/worktrees/WT-CREATE/todos');
			expect(todos.notes.join('\n')).toContain('git fetch failed: network down');
			expect(todos.notes.join('\n')).toContain('could not merge origin/main');

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
		stageWorktree(wt);
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
				onAgentExec: async (config) => {
					prepared(await prepareRepos(config));
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
			expect(run.rows[0].working_dir).toBe('/worktrees/WT-REUSE');
			// No MCP write happened; the worktree diff alone made this a success.
			expect(run.rows[0].produced_output).toBe(false);

			const log = await runLog(result.heartbeatRunId!);
			expect(log).toContain('caught up hezo/WT-REUSE to origin default');
		} finally {
			await db.query('DELETE FROM repos WHERE id = $1', [repoId]);
		}
	});

	it('gives the runtime the task root it runs in, decided after its argv was built', async () => {
		// Antigravity is the runtime that takes its working directory on argv.
		globalThis.fetch = vi.fn().mockResolvedValue({ ok: true }) as unknown as typeof fetch;
		await app.request('/api/ai-providers', {
			method: 'POST',
			headers: { ...authHeader(adminToken), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				provider: 'google',
				api_key: 'AIza-worktree-key',
				label: 'google-worktree',
			}),
		});
		globalThis.fetch = originalFetch;
		const repoId = await insertRepo('acme/todos');
		const clone = join(getWorkspacePath(dataDir, teamId, projectId), 'todos');
		mkdirSync(join(clone, '.git'), { recursive: true });
		const wt = join(getWorktreesPath(dataDir, teamId, projectId), 'WT-AGY', 'todos');
		stageWorktree(wt);
		try {
			let agentCmd: string[] = [];
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
					when((a) => a === 'status --porcelain', { stdout: '' }),
					when((a) => a === 'rev-parse HEAD', { stdout: 'ccc333\n' }),
				],
				onAgentExec: async (config) => {
					agentCmd = config.Cmd;
					await markProducedOutput();
				},
			});

			const result = await runAgent(
				baseDeps(docker),
				makeAgent(),
				makeTask('WT-AGY', { runtime_type: 'antigravity' }),
				makeProject(),
			);
			expect(result.success).toBe(true);

			// The task root, so a repo prepared mid-run is inside the directory agy may use.
			expect(agentCmd[agentCmd.indexOf('--add-dir') + 1]).toBe('/worktrees/WT-AGY');
			expect(agentCmd.some((a) => a.includes(DEFERRED_WORKING_DIR))).toBe(false);
			const run = await db.query<{ invocation_command: string; working_dir: string }>(
				'SELECT invocation_command, working_dir FROM heartbeat_runs WHERE id = $1',
				[result.heartbeatRunId],
			);
			expect(run.rows[0].working_dir).toBe('/worktrees/WT-AGY');
			expect(run.rows[0].invocation_command).toContain('--add-dir /worktrees/WT-AGY');
		} finally {
			await db.query('DELETE FROM repos WHERE id = $1', [repoId]);
			await db.query(`DELETE FROM ai_provider_configs WHERE provider = 'google'`);
		}
	});

	it('clones a missing repo on demand, reports one it could not set up, and marks the designated repo', async () => {
		const libId = await insertRepo('acme/lib');
		const appId = await insertRepo('acme/app');
		const appClone = join(getWorkspacePath(dataDir, teamId, projectId), 'app');
		mkdirSync(join(appClone, '.git'), { recursive: true });
		const wt = join(getWorktreesPath(dataDir, teamId, projectId), 'WT-DESIG', 'app');
		stageWorktree(wt);
		try {
			let reply: PrepareReply | null = null;
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
				onAgentExec: async (config) => {
					reply = await prepareRepos(config);
					await markProducedOutput();
				},
			});

			const result = await runAgent(
				baseDeps(docker),
				makeAgent(),
				makeTask('WT-DESIG'),
				makeProject({ designated_repo_id: appId }),
			);
			expect(result.success).toBe(true);

			const repos = prepared(reply!).repos;
			expect(repos.map((r) => [r.name, r.designated, r.ready])).toEqual([
				['lib', false, false],
				['app', true, true],
			]);
			expect(repos[0].error).toContain('not cloned');

			const log = await runLog(result.heartbeatRunId!);
			expect(log).toContain('(cloned 1 repo(s) on demand)');
			expect(log).toContain('(skipping worktree for lib — not cloned)');
		} finally {
			await db.query('DELETE FROM repos WHERE id = ANY($1::uuid[])', [[libId, appId]]);
		}
	});

	it('tells the agent a repo it could not prepare, and keeps the run going', async () => {
		const repoId = await insertRepo('acme/ghost');
		try {
			let reply: PrepareReply | null = null;
			const docker = scriptedGitDocker({
				rules: [],
				onAgentExec: async (config) => {
					reply = await prepareRepos(config);
					await markProducedOutput();
				},
			});
			const result = await runAgent(
				baseDeps(docker),
				makeAgent(),
				makeTask('WT-GHOST'),
				makeProject(),
			);
			expect(result.success).toBe(true);
			const [ghost] = prepared(reply!).repos;
			expect(ghost.ready).toBe(false);
			expect(ghost.error).toContain('not cloned');
			expect(await runLog(result.heartbeatRunId!)).toContain(
				'(skipping worktree for ghost — not cloned)',
			);
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
			let reply: PrepareReply | null = null;
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
				onAgentExec: async (config) => {
					reply = await prepareRepos(config);
					await markProducedOutput();
				},
			});

			const result = await runAgent(
				baseDeps(docker),
				makeAgent(),
				makeTask('WT-RETRY'),
				makeProject(),
			);
			expect(result.success).toBe(true);
			expect(todosAddAttempts).toBe(2);

			const repos = prepared(reply!).repos;
			expect(repos.map((r) => [r.name, r.ready])).toEqual([
				['todos', true],
				['extra', false],
			]);
			expect(repos[1].error).toContain('fatal: not a git repository');

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
		stageWorktree(wt);
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
				// The agent prepares its repo, then exits 0 without flagging any Hezo
				// write and without touching the worktree — a no-op run that must read
				// as failed.
				onAgentExec: async (config) => {
					prepared(await prepareRepos(config));
				},
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

	/**
	 * Committed work that reached no remote must not read as a successful run, and
	 * the container holding it must be pinned against the idle cron. Nothing fails
	 * at one container per project - the next run hits the same `.git` and the ref
	 * is still there - so this is the regression that only appears once a project
	 * has several containers, which is exactly why it needs its own test.
	 */
	describe('stranded commits', () => {
		/** Rules that carry prep through to a successful agent exec, as above. */
		const preparedRepo = (extra: GitRule[]): GitRule[] => [
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
			when((a) => a === 'status --porcelain', { stdout: ' M src/app.ts\n' }),
			when((a) => a === 'rev-parse HEAD', { stdout: 'ddd444\n' }),
			...extra,
		];

		async function stageRun(identifier: string): Promise<{ repoId: string }> {
			const repoId = await insertRepo('acme/todos');
			mkdirSync(join(getWorkspacePath(dataDir, teamId, projectId), 'todos', '.git'), {
				recursive: true,
			});
			stageWorktree(join(getWorktreesPath(dataDir, teamId, projectId), identifier, 'todos'));
			return { repoId };
		}

		/** The agent prepares its repo, as a coding run does before it touches code. */
		const agentPrepares = async (config: { Env: string[] }) => {
			prepared(await prepareRepos(config));
		};

		// The pool member is keyed on the *engine's* container id, which is what
		// `ensureProjectContainerRunning` returns — the stub engine's fixed
		// `stub-container`, not the id `makeProject()` reports.
		const POOL_CONTAINER_ID = 'stub-container';

		const memberFlag = async (): Promise<boolean | null> => {
			const r = await db.query<{ has_unpushed_commits: boolean }>(
				'SELECT has_unpushed_commits FROM container_pool_members WHERE container_id = $1',
				[POOL_CONTAINER_ID],
			);
			return r.rows[0]?.has_unpushed_commits ?? null;
		};

		beforeAll(async () => {
			await db.query(
				`INSERT INTO container_pool_members (project_id, container_id, state)
				 VALUES ($1, $2, 'busy') ON CONFLICT (container_id) DO NOTHING`,
				[projectId, POOL_CONTAINER_ID],
			);
		});

		it('fails a clean run that leaves commits reaching no remote, and pins the container', async () => {
			const { repoId } = await stageRun('WT-STRANDED');
			try {
				const docker = scriptedGitDocker({
					onAgentExec: agentPrepares,
					rules: preparedRepo([
						when((a) => a.startsWith('rev-parse --verify --quiet refs/heads/hezo/'), {
							exitCode: 0,
						}),
						when((a) => a.startsWith('rev-list --count'), { stdout: '2\n' }),
					]),
				});

				const result = await runAgent(
					baseDeps(docker),
					makeAgent(),
					makeTask('WT-STRANDED'),
					makeProject(),
				);

				// The worktree is dirty, so this run DID produce output — it fails
				// purely because the work exists only in this container.
				expect(result.success).toBe(false);
				expect(result.exitCode).toBe(0);

				const run = await db.query<{ status: string; error: string | null }>(
					'SELECT status, error FROM heartbeat_runs WHERE id = $1',
					[result.heartbeatRunId],
				);
				expect(run.rows[0].status).toBe(HeartbeatRunStatus.Failed);
				expect(run.rows[0].error).toContain('reached no remote');
				expect(run.rows[0].error).toContain('hezo/WT-STRANDED');

				expect(await memberFlag()).toBe(true);
				expect(await runLog(result.heartbeatRunId!)).toContain('reached no remote');
			} finally {
				await db.query('DELETE FROM repos WHERE id = $1', [repoId]);
			}
		});

		it('scans a worktree an earlier run left, even when this run never prepared it', async () => {
			// A resumed task already has its folder. An agent that works there
			// without asking for it again must not leave its commits unseen.
			const { repoId } = await stageRun('WT-LEFTOVER');
			try {
				const docker = scriptedGitDocker({
					rules: preparedRepo([
						when((a) => a.startsWith('rev-parse --verify --quiet refs/heads/hezo/'), {
							exitCode: 0,
						}),
						when((a) => a.startsWith('rev-list --count'), { stdout: '2\n' }),
					]),
				});

				const result = await runAgent(
					baseDeps(docker),
					makeAgent(),
					makeTask('WT-LEFTOVER'),
					makeProject(),
				);

				expect(result.success).toBe(false);
				const run = await db.query<{ error: string | null }>(
					'SELECT error FROM heartbeat_runs WHERE id = $1',
					[result.heartbeatRunId],
				);
				expect(run.rows[0].error).toContain('reached no remote');
				expect(await memberFlag()).toBe(true);
				// Scanned, not prepared: no fetch or sync ran for it.
				expect(await runLog(result.heartbeatRunId!)).not.toContain('(syncing repos...)');
			} finally {
				await db.query('DELETE FROM repos WHERE id = $1', [repoId]);
			}
		});

		it('ignores a leftover worktree this run never touched, however its stale refs read', async () => {
			// Never fetched this run, so its tracking refs may be stale. Work an
			// earlier run left there was that run's to report; this run must not fail
			// or pin the container over it.
			await db.query(
				'UPDATE container_pool_members SET has_unpushed_commits = false WHERE container_id = $1',
				[POOL_CONTAINER_ID],
			);
			const { repoId } = await stageRun('WT-UNTOUCHED');
			try {
				const docker = scriptedGitDocker({
					rules: [
						when((a) => a === 'status --porcelain', { stdout: '' }),
						when((a) => a.startsWith('rev-list --count --since='), { stdout: '0\n' }),
						when((a) => a.startsWith('rev-parse --verify --quiet refs/heads/hezo/'), {
							exitCode: 0,
						}),
						when((a) => a.startsWith('rev-list --count'), { stdout: '3\n' }),
					],
					onAgentExec: markProducedOutput,
				});

				const result = await runAgent(
					baseDeps(docker),
					makeAgent(),
					makeTask('WT-UNTOUCHED'),
					makeProject(),
				);

				expect(result.success).toBe(true);
				expect(await memberFlag()).toBe(false);
			} finally {
				await db.query('DELETE FROM repos WHERE id = $1', [repoId]);
			}
		});

		it('counts a pushed commit made this run in an unprepared leftover worktree as output', async () => {
			// No pre-run head exists for a worktree the run never prepared, so a commit
			// the agent made and auto-pushed there must still read as the run's work.
			const { repoId } = await stageRun('WT-LEFTCOMMIT');
			let sinceArg = '';
			try {
				const docker = scriptedGitDocker({
					rules: [
						when((a) => a === 'status --porcelain', { stdout: '' }),
						when(
							(a) => a.startsWith('rev-list --count --since='),
							() => {
								sinceArg = 'seen';
								return { stdout: '1\n' };
							},
						),
						when((a) => a.startsWith('rev-parse --verify --quiet refs/heads/hezo/'), {
							exitCode: 0,
						}),
						when((a) => a.startsWith('rev-list --count'), { stdout: '0\n' }),
					],
					// Deliberately no Hezo write: the commit alone is the output.
				});

				const result = await runAgent(
					baseDeps(docker),
					makeAgent(),
					makeTask('WT-LEFTCOMMIT'),
					makeProject(),
				);

				expect(sinceArg).toBe('seen');
				expect(result.success).toBe(true);
			} finally {
				await db.query('DELETE FROM repos WHERE id = $1', [repoId]);
			}
		});

		it('leaves a stored bundle alone when only an unprepared leftover worktree was scanned', async () => {
			// The leftover worktree never had the stored bundle restored into it, so
			// its clean scan says nothing about the bundle's commits: dropping the
			// bundle here would destroy the only copy.
			const { repoId } = await stageRun('WT-LEFTCLEAN');
			try {
				const vault = createBundleVault(dataDir);
				const bundleKey = { projectId, repoName: 'todos', branch: 'hezo/WT-LEFTCLEAN' };
				await vault.put(bundleKey, new TextEncoder().encode('commits from another container'));

				const docker = scriptedGitDocker({
					rules: preparedRepo([
						when((a) => a.startsWith('rev-parse --verify --quiet refs/heads/hezo/'), {
							exitCode: 0,
						}),
						when((a) => a.startsWith('rev-list --count'), { stdout: '0\n' }),
					]),
				});

				await runAgent(baseDeps(docker), makeAgent(), makeTask('WT-LEFTCLEAN'), makeProject());

				expect(await vault.has(bundleKey)).toBe(true);
			} finally {
				await db.query('DELETE FROM repos WHERE id = $1', [repoId]);
			}
		});

		it('never replaces a stored bundle with commits from an unprepared leftover worktree', async () => {
			// A newer bundle from another container must not be overwritten by the
			// older commits a stale leftover worktree still holds.
			await db.query(
				'UPDATE container_pool_members SET has_unpushed_commits = false WHERE container_id = $1',
				[POOL_CONTAINER_ID],
			);
			const { repoId } = await stageRun('WT-LEFTSTALE');
			try {
				const vault = createBundleVault(dataDir);
				const bundleKey = { projectId, repoName: 'todos', branch: 'hezo/WT-LEFTSTALE' };
				await vault.put(bundleKey, new TextEncoder().encode('the newer bundle'));
				let bundleCreated = false;

				const docker = scriptedGitDocker({
					rules: preparedRepo([
						when((a) => a.startsWith('rev-parse --verify --quiet refs/heads/hezo/'), {
							exitCode: 0,
						}),
						when((a) => a.startsWith('rev-list --count'), { stdout: '1\n' }),
						when(
							(a) => a.startsWith('bundle create'),
							() => {
								bundleCreated = true;
								return { exitCode: 0 };
							},
						),
					]),
				});

				const result = await runAgent(
					baseDeps(docker),
					makeAgent(),
					makeTask('WT-LEFTSTALE'),
					makeProject(),
				);

				expect(result.success).toBe(false);
				expect(bundleCreated).toBe(false);
				expect(new TextDecoder().decode((await vault.get(bundleKey)) ?? new Uint8Array())).toBe(
					'the newer bundle',
				);
				// The container holds the only copy of those commits Hezo knows of.
				expect(await memberFlag()).toBe(true);
				expect(await runLog(result.heartbeatRunId!)).toContain('this run did not prepare');
			} finally {
				await db.query('DELETE FROM repos WHERE id = $1', [repoId]);
			}
		});

		it('succeeds and releases the pin once the commits are on the remote', async () => {
			const { repoId } = await stageRun('WT-PUSHED');
			try {
				const docker = scriptedGitDocker({
					onAgentExec: agentPrepares,
					rules: preparedRepo([
						when((a) => a.startsWith('rev-parse --verify --quiet refs/heads/hezo/'), {
							exitCode: 0,
						}),
						when((a) => a.startsWith('rev-list --count'), { stdout: '0\n' }),
					]),
				});

				const result = await runAgent(
					baseDeps(docker),
					makeAgent(),
					makeTask('WT-PUSHED'),
					makeProject(),
				);
				expect(result.success).toBe(true);
				// A later run getting the commits out is what releases the pin;
				// leaving it set would strand the container forever on one denied push.
				expect(await memberFlag()).toBe(false);
			} finally {
				await db.query('DELETE FROM repos WHERE id = $1', [repoId]);
			}
		});

		it('leaves the pin alone when the check could not answer', async () => {
			await db.query(
				'UPDATE container_pool_members SET has_unpushed_commits = true WHERE container_id = $1',
				[POOL_CONTAINER_ID],
			);
			const { repoId } = await stageRun('WT-UNKNOWN');
			try {
				const docker = scriptedGitDocker({
					onAgentExec: agentPrepares,
					rules: preparedRepo([
						when((a) => a.startsWith('rev-parse --verify --quiet refs/heads/hezo/'), {
							exitCode: 0,
						}),
						// git failed, so the run knows nothing about what is unpushed.
						when((a) => a.startsWith('rev-list --count'), {
							exitCode: 128,
							stderr: 'fatal: bad revision',
						}),
					]),
				});

				const result = await runAgent(
					baseDeps(docker),
					makeAgent(),
					makeTask('WT-UNKNOWN'),
					makeProject(),
				);
				// An unanswerable check must neither fail the run nor release the pin —
				// releasing it would destroy the container the pin exists to protect.
				expect(result.success).toBe(true);
				expect(await memberFlag()).toBe(true);
			} finally {
				await db.query('DELETE FROM repos WHERE id = $1', [repoId]);
			}
		});

		it('releases the pin once the commits are copied out, but still fails the run', async () => {
			await db.query(
				'UPDATE container_pool_members SET has_unpushed_commits = false WHERE container_id = $1',
				[POOL_CONTAINER_ID],
			);
			const { repoId } = await stageRun('WT-VAULTED');
			try {
				const clone = join(getWorkspacePath(dataDir, teamId, projectId), 'todos');
				const docker = scriptedGitDocker({
					onAgentExec: agentPrepares,
					rules: preparedRepo([
						when((a) => a.startsWith('rev-parse --verify --quiet refs/heads/hezo/'), {
							exitCode: 0,
						}),
						when((a) => a.startsWith('rev-list --count'), { stdout: '2\n' }),
						// Stand in for a real `git bundle create`: the bytes are what the
						// vault copies out, so the file has to actually appear.
						when(
							(a) => a.startsWith('bundle create'),
							() => {
								writeFileSync(join(clone, RECOVERY_BUNDLE_REL_PATH), 'PACK-ish bytes');
								return { exitCode: 0 };
							},
						),
					]),
				});

				const result = await runAgent(
					baseDeps(docker),
					makeAgent(),
					makeTask('WT-VAULTED'),
					makeProject(),
				);

				// The two halves are decided by different things and this is the case
				// that separates them: Hezo holds a copy, so the container is no longer
				// the only place the work exists and may be reused or destroyed — but
				// the work still never reached the remote, so the run is not a success.
				expect(result.success).toBe(false);
				expect(await memberFlag()).toBe(false);

				const log = await runLog(result.heartbeatRunId!);
				expect(log).toContain('kept a recovery copy');
				expect(log).toContain('still not on the remote');
				// The bundle is copied out of the clone, not left to be restored over a
				// newer one on the next run.
				expect(existsSync(join(clone, RECOVERY_BUNDLE_REL_PATH))).toBe(false);
			} finally {
				await db.query('DELETE FROM repos WHERE id = $1', [repoId]);
			}
		});

		it('keeps a stored bundle when the restore failed, rather than dropping the last copy', async () => {
			// The data-loss path: container A's commits are in the vault and A is
			// gone. A run here cannot apply the bundle, so its clone genuinely has
			// nothing unpushed - and reading that as "the work reached origin" would
			// delete the only surviving copy.
			const { repoId } = await stageRun('WT-KEEPBUNDLE');
			try {
				const vault = createBundleVault(dataDir);
				const bundleKey = {
					projectId,
					repoName: 'todos',
					branch: 'hezo/WT-KEEPBUNDLE',
				};
				await vault.put(bundleKey, new TextEncoder().encode('a stored bundle'));

				const docker = scriptedGitDocker({
					onAgentExec: agentPrepares,
					rules: preparedRepo([
						when((a) => a.startsWith('rev-parse --verify --quiet refs/heads/hezo/'), {
							exitCode: 0,
						}),
						// The restore cannot be applied in this container.
						when((a) => a.startsWith('fetch --no-write-fetch-head'), {
							exitCode: 128,
							stderr: 'fatal: failed to read bundle',
						}),
						// ...so this clone reports a perfectly clean branch.
						when((a) => a.startsWith('rev-list --count'), { stdout: '0\n' }),
					]),
				});

				await runAgent(baseDeps(docker), makeAgent(), makeTask('WT-KEEPBUNDLE'), makeProject());

				expect(await vault.has(bundleKey)).toBe(true);
			} finally {
				await db.query('DELETE FROM repos WHERE id = $1', [repoId]);
			}
		});

		/**
		 * A run whose prep restores a stored bundle. The stub writes the bundle file
		 * and answers the bundle fetch with exit 0, so the restore succeeds and the
		 * commits land under the recovery ref.
		 */
		async function runWithRestoredBundle(
			identifier: string,
			extra: GitRule[],
		): Promise<{
			kept: boolean;
			success: boolean;
			error: string | null;
			log: string;
			pinned: boolean | null;
		}> {
			await db.query(
				'UPDATE container_pool_members SET has_unpushed_commits = false WHERE container_id = $1',
				[POOL_CONTAINER_ID],
			);
			const { repoId } = await stageRun(identifier);
			try {
				const vault = createBundleVault(dataDir);
				const bundleKey = { projectId, repoName: 'todos', branch: `hezo/${identifier}` };
				await vault.put(bundleKey, new TextEncoder().encode('commits from another container'));

				const docker = scriptedGitDocker({
					onAgentExec: agentPrepares,
					rules: preparedRepo([
						when((a) => a.startsWith('rev-parse --verify --quiet refs/heads/hezo/'), {
							exitCode: 0,
						}),
						...extra,
						// The task branch itself carries nothing unpushed.
						when((a) => a.startsWith('rev-list --count'), { stdout: '0\n' }),
					]),
				});
				const result = await runAgent(
					baseDeps(docker),
					makeAgent(),
					makeTask(identifier),
					makeProject(),
				);
				const row = await db.query<{ error: string | null }>(
					'SELECT error FROM heartbeat_runs WHERE id = $1',
					[result.heartbeatRunId],
				);
				return {
					kept: await vault.has(bundleKey),
					success: result.success,
					error: row.rows[0]?.error ?? null,
					log: await runLog(result.heartbeatRunId!),
					pinned: await memberFlag(),
				};
			} finally {
				await db.query('DELETE FROM repos WHERE id = $1', [repoId]);
			}
		}

		const replayRefused = when((a) => a.startsWith('merge --ff-only refs/remotes/hezo-recovery/'), {
			exitCode: 128,
			stderr: 'fatal: Not possible to fast-forward, aborting.',
		});
		const recoveredTipCheck = (res: GitResult) =>
			when((a) => a.startsWith('merge-base --is-ancestor refs/remotes/hezo-recovery/'), res);

		it('keeps the stored bundle and fails the run when the recovered commits never reached the branch', async () => {
			// The restore worked, so the commits are in this clone - but only under
			// the recovery ref. The branch scan is clean because the commits are not on
			// the branch, and reading that as "the work reached origin" would drop the
			// only copy outside a container nothing pins.
			const out = await runWithRestoredBundle('WT-NOREPLAY', [
				replayRefused,
				recoveredTipCheck({ exitCode: 1 }),
			]);

			expect(out.kept).toBe(true);
			expect(out.success).toBe(false);
			expect(out.error).toContain('refs/remotes/hezo-recovery/hezo/WT-NOREPLAY');
			// Hezo still holds the stored copy, so this container is not the only
			// place the commits exist.
			expect(out.pinned).toBe(false);
		});

		it('drops the stored bundle once its commits are replayed onto a branch with nothing unpushed', async () => {
			const out = await runWithRestoredBundle('WT-REPLAYED', []);

			expect(out.kept).toBe(false);
			expect(out.success).toBe(true);
		});

		it('judges the replay at the end of the run, so an agent that merged the commits in is not failed', async () => {
			// The fast-forward failed at prep, and the agent then merged the recovery
			// ref into the branch itself and pushed it.
			const out = await runWithRestoredBundle('WT-AGENTMERGED', [
				replayRefused,
				recoveredTipCheck({ exitCode: 0 }),
			]);

			expect(out.kept).toBe(false);
			expect(out.success).toBe(true);
		});

		it('keeps the stored bundle without failing the run when the end-of-run check cannot answer', async () => {
			const out = await runWithRestoredBundle('WT-REPLAYUNKNOWN', [
				replayRefused,
				recoveredTipCheck({ exitCode: 128, stderr: 'fatal: Not a valid object name' }),
			]);

			expect(out.kept).toBe(true);
			expect(out.success).toBe(true);
			expect(out.log).toContain('could not check whether the recovered commits are on');
		});

		it('records the task on the container only when the run left its worktree there', async () => {
			const lastTask = async (): Promise<string | null> => {
				const r = await db.query<{ last_task_id: string | null }>(
					'SELECT last_task_id FROM container_pool_members WHERE container_id = $1',
					[POOL_CONTAINER_ID],
				);
				return r.rows[0]?.last_task_id ?? null;
			};
			const repoId = await insertRepo('acme/todos');
			mkdirSync(join(getWorkspacePath(dataDir, teamId, projectId), 'todos', '.git'), {
				recursive: true,
			});
			try {
				await db.query(
					'UPDATE container_pool_members SET last_task_id = NULL WHERE container_id = $1',
					[POOL_CONTAINER_ID],
				);
				// A run that never prepares a repo builds nothing here.
				await runAgent(
					baseDeps(scriptedGitDocker({ rules: [], onAgentExec: markProducedOutput })),
					makeAgent(),
					makeTask('WT-NOAFFINITY'),
					makeProject(),
				);
				expect(await lastTask()).toBeNull();

				// A run that prepares one leaves the task's worktree warm.
				await runAgent(
					baseDeps(
						scriptedGitDocker({
							rules: [
								when((a) => a === 'remote get-url origin', {
									stdout: 'https://github.com/acme/todos.git\n',
								}),
							],
							onAgentExec: async (config) => {
								prepared(await prepareRepos(config));
								await markProducedOutput();
							},
						}),
					),
					makeAgent(),
					makeTask('WT-AFFINITY'),
					makeProject(),
				);
				expect(await lastTask()).toBe(taskId);
			} finally {
				await db.query('DELETE FROM repos WHERE id = $1', [repoId]);
			}
		});

		it('keeps the container pinned when the commits could not be copied out', async () => {
			await db.query(
				'UPDATE container_pool_members SET has_unpushed_commits = false WHERE container_id = $1',
				[POOL_CONTAINER_ID],
			);
			const { repoId } = await stageRun('WT-VAULTFAIL');
			try {
				const docker = scriptedGitDocker({
					onAgentExec: agentPrepares,
					rules: preparedRepo([
						when((a) => a.startsWith('rev-parse --verify --quiet refs/heads/hezo/'), {
							exitCode: 0,
						}),
						when((a) => a.startsWith('rev-list --count'), { stdout: '2\n' }),
						when((a) => a.startsWith('bundle create'), {
							exitCode: 128,
							stderr: 'fatal: Refusing to create empty bundle.',
						}),
					]),
				});

				const result = await runAgent(
					baseDeps(docker),
					makeAgent(),
					makeTask('WT-VAULTFAIL'),
					makeProject(),
				);

				// No copy means the container really is the only place the work exists,
				// so the pin stays — failing closed, rather than releasing a container
				// on the strength of a recovery that did not happen.
				expect(result.success).toBe(false);
				expect(await memberFlag()).toBe(true);
				expect(await runLog(result.heartbeatRunId!)).toContain('could not keep a recovery copy');
			} finally {
				await db.query('DELETE FROM repos WHERE id = $1', [repoId]);
			}
		});
	});

	it('cancels the run when it is aborted while the agent is preparing a repo', async () => {
		const repoId = await insertRepo('acme/todos');
		const clone = join(getWorkspacePath(dataDir, teamId, projectId), 'todos');
		mkdirSync(join(clone, '.git'), { recursive: true });
		const wt = join(getWorktreesPath(dataDir, teamId, projectId), 'WT-LOOPAB', 'todos');
		stageWorktree(wt);
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
					// Abort mid-prep, while the agent waits on its tool call.
					when(
						(a) => a === 'merge-base --is-ancestor origin/main HEAD',
						() => {
							ac.abort();
							return { exitCode: 0 };
						},
					),
				],
				onAgentExec: async (config) => {
					await prepareRepos(config);
					// What Docker's exec does once the run's abort tears its attach down.
					if (ac.signal.aborted) throw new DOMException('Aborted', 'AbortError');
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

	it('stops preparing the remaining repos once the run is aborted during repo sync', async () => {
		const todosId = await insertRepo('acme/todos');
		const extraId = await insertRepo('acme/extra');
		const ws = getWorkspacePath(dataDir, teamId, projectId);
		mkdirSync(join(ws, 'todos', '.git'), { recursive: true });
		mkdirSync(join(ws, 'extra', '.git'), { recursive: true });
		const ac = new AbortController();
		try {
			let reply: PrepareReply | null = null;
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
				onAgentExec: async (config) => {
					reply = await prepareRepos(config);
					if (ac.signal.aborted) throw new DOMException('Aborted', 'AbortError');
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
			expect(prepared(reply!).repos.every((r) => !r.ready)).toBe(true);
			const log = await runLog(result.heartbeatRunId!);
			expect(log).toContain('(syncing repos...)');
			expect(log).not.toContain('git fetch todos');
		} finally {
			await db.query('DELETE FROM repos WHERE id = ANY($1::uuid[])', [[todosId, extraId]]);
		}
	});
});
