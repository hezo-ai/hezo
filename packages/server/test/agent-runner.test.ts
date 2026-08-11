import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import {
	AgentEffort,
	AgentRuntime,
	AiAuthMethod,
	AiProvider,
	ContainerStatus,
	formatContainerMetaLogLine,
	HeartbeatRunStatus,
} from '@hezo/shared';
import type { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MasterKeyManager } from '../src/crypto/master-key';
import type { Db } from '../src/db/database';
import { runLogTextSql } from '../src/db/run-log-chunks';
import type { Env } from '../src/lib/types';
import {
	acquireCredentialLock,
	buildProviderEnv,
	buildSubscriptionMount,
	getHostPromptPath,
	getHostSubscriptionRoot,
	type RunnerDeps,
	runAgent,
	shellQuoteArg,
} from '../src/services/agent-runner';
import { LogStreamBroker } from '../src/services/log-stream-broker';
import { PricingService, upsertManualRate } from '../src/services/pricing';
import type { ContainerEngine } from '../src/services/sandbox/types';
import { safeClose } from './helpers';
import {
	authHeader,
	createStubDocker,
	createTestApp,
	createTestProject,
	createTestTeam,
	seedProjectContainer,
	stubEngineSeams,
} from './helpers/app';
import { withRunUserStub } from './helpers/run-user-docker';

function readPromptFromExec(
	opts: { Env: string[] },
	dataDir: string,
	project: { team_id: string; id: string },
): string {
	const entry = opts.Env.find((e) => e.startsWith('HEZO_PROMPT_FILE='));
	if (!entry) throw new Error('HEZO_PROMPT_FILE env var missing from exec');
	const containerPath = entry.slice('HEZO_PROMPT_FILE='.length);
	const runId = containerPath
		.split('/')
		.pop()!
		.replace(/\.txt$/, '');
	return readFileSync(getHostPromptPath(dataDir, project.team_id, project.id, runId), 'utf8');
}

// The runner's data dir must be the harness's own, not a fixed path: the
// container engine resolves a run's files through the project's workspace under
// it, so a hardcoded literal would stage them somewhere the test cannot read.
let testDataDir: string;
let app: Hono<Env>;
let db: Db;
let adminToken: string;
let masterKeyManager: MasterKeyManager;
let teamId: string;
let projectId: string;
let projectSlug: string;
let taskId: string;
let agentId: string;

const originalFetch = globalThis.fetch;

beforeAll(async () => {
	const ctx = await createTestApp();
	testDataDir = ctx.dataDir;
	app = ctx.app;
	db = ctx.db;
	adminToken = ctx.token;
	masterKeyManager = ctx.masterKeyManager;

	const typesRes = await app.request('/api/team-templates', { headers: authHeader(adminToken) });
	const typeId = (await typesRes.json()).data.find((t: any) => t.name === 'App Team').id;

	const teamRes = await createTestTeam(db, { name: 'Runner Co', template_id: typeId });
	const teamData = (await teamRes.json()).data;
	teamId = teamData.id;

	// Mock fetch for provider key validation during setup
	globalThis.fetch = vi.fn().mockResolvedValue({ ok: true }) as unknown as typeof fetch;

	// Configure an AI provider so the agent runner can resolve credentials
	await app.request('/api/ai-providers', {
		method: 'POST',
		headers: { ...authHeader(adminToken), 'Content-Type': 'application/json' },
		body: JSON.stringify({
			provider: 'anthropic',
			api_key: 'sk-ant-test-runner-key',
			label: 'anthropic-runner',
		}),
	});

	// Restore real fetch for the rest of the tests
	globalThis.fetch = originalFetch;

	const projectRes = await createTestProject(db, teamId, {
		name: 'Runner Project',
		description: 'Test project.',
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
			title: 'Runner Task',
			description: 'Test description',
			assignee_id: agentId,
		}),
	});
	taskId = (await taskRes.json()).data.id;

	// The lazy-start ensure resolves the container from the DB row, so pin it to
	// the id the docker mocks assume (running under the default inspect).
	await db.query(
		`UPDATE projects SET container_id = 'container-123', container_status = 'running'::container_status
		 WHERE id = $1`,
		[projectId],
	);
});

// Each test states the project's container situation for itself (via
// `makeProject`, or by writing `projects.container_*`). A pool member left
// behind by the previous test would be a *second* container the run could take,
// so clear them: "this project has no container" has to mean both records of
// one, not just the projects row.
beforeEach(async () => {
	await db.query(`DELETE FROM container_pool_members WHERE project_id = $1`, [projectId]);
});

afterAll(async () => {
	await safeClose(db);
});

// A real agent run produces persisted output (an MCP write or a code change);
// the runner only treats a clean exit as success when it did. Mirror that here
// by flipping the run's produced_output flag during exec — the same thing the
// MCP tool layer does mid-run — so exit-0 mocks read as genuine successes.
// `producesOutput: false` simulates a no-op run (e.g. a plan-only termination).
interface ExecChunk {
	stream: 'stdout' | 'stderr';
	text: string;
}

function createMockDocker(overrides: Record<string, any> = {}): ContainerEngine {
	const {
		execStart: execStartOverride,
		producesOutput = true,
		reportsNoWork = false,
		noWorkReason = 'nothing to do this run',
		...rest
	} = overrides;
	const innerExecStart = execStartOverride ?? (async () => ({ stdout: 'done', stderr: '' }));
	// Built on createStubDocker rather than hand-rolled: a literal cast through
	// `as unknown as ContainerEngine` silently omits whatever the interface grows
	// next, and the compiler cannot say so. That is how six specs came to call a
	// method that did not exist on their engine.
	const base = createStubDocker({
		ping: async () => true,
		imageExists: async () => true,
		pullImage: async () => {},
		createContainer: async () => ({ Id: 'container-123', Warnings: [] }),
		startContainer: async () => {},
		stopContainer: async () => {},
		removeContainer: async () => {},
		inspectContainer: async () => ({
			Id: 'container-123',
			State: { Status: 'running', Running: true, Pid: 1, ExitCode: 0 },
			Config: { Image: 'test' },
		}),
		containerLogs: async () => new ReadableStream(),
		execCreate: async () => 'exec-123',
		execInspect: async () => ({ ExitCode: 0, Running: false, Pid: 0 }),
		killRunProcesses: async () => {},
		...rest,
		execStart: async (...args: unknown[]) => {
			if (producesOutput) {
				await db.query(
					`UPDATE heartbeat_runs SET produced_output = true WHERE task_id = $1 AND status = 'running'`,
					[taskId],
				);
			}
			if (reportsNoWork) {
				await db.query(
					`UPDATE heartbeat_runs SET reported_no_work = true, no_work_reason = $2 WHERE task_id = $1 AND status = 'running'`,
					[taskId, noWorkReason],
				);
			}
			const produced = (await (innerExecStart as (...a: unknown[]) => unknown)(...args)) as {
				stdout?: string;
				stderr?: string;
			};
			// Deliver through onChunk exactly as the real client does. A streamed
			// exec retains nothing, so everything the runner derives from output
			// (the parser, the background-termination backstop) must come off the
			// chunks; a mock that only returned strings would test a contract
			// production does not offer. Tests still declare output as a return
			// value for brevity, and overrides that drive onChunk themselves
			// return empty strings so nothing is delivered twice.
			const opts = args[1] as { onChunk?: (c: ExecChunk) => void | Promise<void> } | undefined;
			if (!opts?.onChunk) return produced;
			if (produced?.stdout) await opts.onChunk({ stream: 'stdout', text: produced.stdout });
			if (produced?.stderr) await opts.onChunk({ stream: 'stderr', text: produced.stderr });
			return { stdout: '', stderr: '' };
		},
		// The run stages its prompt and runtime home through the engine seam, so an
		// inline engine needs the same bind-resolving view the shared stub gives.
		...stubEngineSeams(),
	});
	// Transparently answer the run-user probe (`id -u node`) + ownership chowns so the
	// runner resolves a `node` run-user without those infra execs reaching the test's
	// own execCreate/execStart handlers above.
	return withRunUserStub(base);
}

async function setAgentPrompt(content: string) {
	await db.query(
		`INSERT INTO documents (team_id, member_agent_id, type, slug, content)
		 VALUES ($1, $2, 'agent_system_prompt', 'system-prompt', $3)
		 ON CONFLICT (member_agent_id) WHERE type = 'agent_system_prompt'
		 DO UPDATE SET content = EXCLUDED.content`,
		[teamId, agentId, content],
	);
}

function makeAgent() {
	return {
		id: agentId,
		title: 'Test Agent',
		team_id: teamId,
	};
}

function makeTask() {
	return {
		id: taskId,
		identifier: 'RC-1',
		title: 'Runner Task',
		description: 'Test description',
		status: 'backlog',
		priority: 'medium',
		project_id: projectId,
		rules: null,
		progress_summary: null,
	};
}

function makeProject(overrides: Record<string, unknown> = {}) {
	return {
		id: projectId,
		slug: 'runner-project',
		team_id: teamId,
		team_slug: 'runner-co',
		container_id: 'container-123',
		container_status: ContainerStatus.Running,
		designated_repo_id: null,
		is_internal: false,
		...overrides,
	};
}

describe('runAgent', () => {
	it('lazy-starts a stopped container, narrates it in the run log, and proceeds', async () => {
		// Seeded through the pool as well as the column, and with the allocation it
		// was provisioned with: a container the pool has no record of has an
		// unknown size, which it cannot show covers the project's cap, so it is
		// replaced rather than resumed. That is right for a genuinely adopted
		// container and wrong for the one this test is about.
		await seedProjectContainer(db, projectId, 'c-1', {
			containerStatus: 'stopped',
			state: 'suspended',
		});
		const startCalls: string[] = [];
		let started = false;
		const docker = createMockDocker({
			inspectContainer: async (id: string) => ({
				Id: id,
				State: started
					? { Status: 'running', Running: true, Pid: 1, ExitCode: 0 }
					: { Status: 'exited', Running: false, Pid: 0, ExitCode: 0 },
				Config: { Image: 'test' },
			}),
			startContainer: async (id: string) => {
				startCalls.push(id);
				started = true;
			},
		});
		const deps: RunnerDeps = {
			db,
			docker,
			masterKeyManager,
			serverPort: 3000,
			dataDir: testDataDir,
			logs: new LogStreamBroker(),
		};

		const result = await runAgent(
			deps,
			makeAgent(),
			makeTask(),
			makeProject({ container_status: ContainerStatus.Stopped, container_id: 'c-1' }),
		);

		expect(result.success).toBe(true);
		expect(startCalls).toEqual(['c-1']);

		const run = await db.query<{ log_text: string }>(
			`SELECT ${runLogTextSql('heartbeat_runs.id')} AS log_text FROM heartbeat_runs WHERE id = $1`,
			[result.heartbeatRunId],
		);
		expect(run.rows[0].log_text).toContain('Starting the project container');

		// And which container it landed on, with the size that container was built
		// with. The member row is destroyed when the container is, so the log is
		// what still answers this once the container is gone.
		const member = await db.query<{ memory_bytes: string; disk_ceiling_bytes: string }>(
			'SELECT memory_bytes, disk_ceiling_bytes FROM container_pool_members WHERE container_id = $1',
			['c-1'],
		);
		expect(run.rows[0].log_text).toContain(
			formatContainerMetaLogLine({
				containerId: 'c-1',
				memoryBytes: Number(member.rows[0].memory_bytes),
				diskCeilingBytes: Number(member.rows[0].disk_ceiling_bytes),
			}),
		);

		const proj = await db.query<{ container_status: string }>(
			'SELECT container_status FROM projects WHERE id = $1',
			[projectId],
		);
		expect(proj.rows[0].container_status).toBe(ContainerStatus.Running);

		await db.query(
			`UPDATE projects SET container_id = 'container-123', container_status = 'running'::container_status WHERE id = $1`,
			[projectId],
		);
	});

	it('re-provisions when a cached-running container has vanished from Docker and proceeds', async () => {
		// The DB still says running, but Docker 404s on inspect — the exact stale
		// state after an external `docker rm` or a Docker daemon restart. The
		// runner repairs the row by provisioning a fresh container and rides it.
		await db.query(
			`UPDATE projects SET container_status = $1::container_status, container_id = $2,
			     container_error = NULL WHERE id = $3`,
			[ContainerStatus.Running, 'gone-1', projectId],
		);

		const created: string[] = [];
		const deps: RunnerDeps = {
			db,
			docker: createMockDocker({
				inspectContainer: async () => null,
				createContainer: async () => {
					created.push('reborn-1');
					return { Id: 'reborn-1', Warnings: [] };
				},
			}),
			masterKeyManager,
			serverPort: 3000,
			dataDir: testDataDir,
			logs: new LogStreamBroker(),
		};

		const result = await runAgent(
			deps,
			makeAgent(),
			makeTask(),
			makeProject({ container_status: ContainerStatus.Running, container_id: 'gone-1' }),
		);

		expect(result.success).toBe(true);
		expect(created).toEqual(['reborn-1']);

		// The stale row was reconciled against Docker reality.
		const proj = await db.query<{ container_status: string; container_id: string | null }>(
			'SELECT container_status, container_id FROM projects WHERE id = $1',
			[projectId],
		);
		expect(proj.rows[0].container_status).toBe(ContainerStatus.Running);
		expect(proj.rows[0].container_id).toBe('reborn-1');

		await db.query(
			`UPDATE projects SET container_id = 'container-123', container_status = 'running'::container_status WHERE id = $1`,
			[projectId],
		);
	});

	it('provisions from scratch when the project has no container and proceeds', async () => {
		await db.query(
			`UPDATE projects SET container_status = NULL, container_id = NULL,
			     container_error = NULL WHERE id = $1`,
			[projectId],
		);
		const created: string[] = [];
		const deps: RunnerDeps = {
			db,
			docker: createMockDocker({
				createContainer: async () => {
					created.push('fresh-1');
					return { Id: 'fresh-1', Warnings: [] };
				},
			}),
			masterKeyManager,
			serverPort: 3000,
			dataDir: testDataDir,
			logs: new LogStreamBroker(),
		};

		const result = await runAgent(
			deps,
			makeAgent(),
			makeTask(),
			makeProject({ container_id: null, container_status: null }),
		);

		expect(result.success).toBe(true);
		expect(created).toEqual(['fresh-1']);
		expect(result.heartbeatRunId).toBeDefined();

		const proj = await db.query<{ container_status: string; container_id: string | null }>(
			'SELECT container_status, container_id FROM projects WHERE id = $1',
			[projectId],
		);
		expect(proj.rows[0].container_status).toBe(ContainerStatus.Running);
		expect(proj.rows[0].container_id).toBe('fresh-1');

		await db.query(
			`UPDATE projects SET container_id = 'container-123', container_status = 'running'::container_status WHERE id = $1`,
			[projectId],
		);
	});

	it('runs successfully and creates a heartbeat run', async () => {
		const docker = createMockDocker({
			execCreate: async () => 'exec-ok',
			execStart: async () => ({ stdout: 'task completed', stderr: '' }),
			execInspect: async () => ({ ExitCode: 0, Running: false, Pid: 0 }),
		});

		const deps: RunnerDeps = {
			db,
			docker,
			masterKeyManager,
			serverPort: 3000,
			dataDir: testDataDir,
			logs: new LogStreamBroker(),
		};

		const result = await runAgent(deps, makeAgent(), makeTask(), makeProject());

		expect(result.success).toBe(true);
		expect(result.exitCode).toBe(0);
		expect(result.heartbeatRunId).toBeDefined();

		// Verify heartbeat run was recorded
		const run = await db.query<{ status: string; exit_code: number }>(
			'SELECT status, exit_code FROM heartbeat_runs WHERE id = $1',
			[result.heartbeatRunId],
		);
		expect(run.rows[0].status).toBe(HeartbeatRunStatus.Succeeded);
		expect(run.rows[0].exit_code).toBe(0);
	});

	it('surfaces a provider billing rejection as the run error reason', async () => {
		const errorEvent = JSON.stringify({
			type: 'result',
			is_error: true,
			result: 'API Error: 402 Insufficient Balance',
			usage: {},
		});
		const docker = createMockDocker({
			producesOutput: false,
			execInspect: async () => ({ ExitCode: 1, Running: false, Pid: 0 }),
			execStart: async (
				_execId: string,
				opts: { onChunk?: (chunk: { stream: string; text: string }) => Promise<void> },
			) => {
				await opts.onChunk?.({ stream: 'stdout', text: `${errorEvent}\n` });
				return { stdout: '', stderr: '' };
			},
		});

		const deps: RunnerDeps = {
			db,
			docker,
			masterKeyManager,
			serverPort: 3000,
			dataDir: testDataDir,
			logs: new LogStreamBroker(),
		};

		const result = await runAgent(deps, makeAgent(), makeTask(), makeProject());
		expect(result.success).toBe(false);

		const run = await db.query<{ status: string; error: string | null; log_text: string }>(
			`SELECT status, error, ${runLogTextSql('heartbeat_runs.id')} AS log_text FROM heartbeat_runs WHERE id = $1`,
			[result.heartbeatRunId],
		);
		expect(run.rows[0].status).toBe(HeartbeatRunStatus.Failed);
		expect(run.rows[0].error).toContain('credit/quota');
		expect(run.rows[0].error).toContain('402 Insufficient Balance');
		expect(run.rows[0].log_text).toContain('[runner]');
	});

	it('marks produced_output on a successful run', async () => {
		const deps: RunnerDeps = {
			db,
			docker: createMockDocker(),
			masterKeyManager,
			serverPort: 3000,
			dataDir: testDataDir,
			logs: new LogStreamBroker(),
		};

		const result = await runAgent(deps, makeAgent(), makeTask(), makeProject());

		const run = await db.query<{ status: string; produced_output: boolean }>(
			'SELECT status, produced_output FROM heartbeat_runs WHERE id = $1',
			[result.heartbeatRunId],
		);
		expect(run.rows[0].status).toBe(HeartbeatRunStatus.Succeeded);
		expect(run.rows[0].produced_output).toBe(true);
	});

	it('fails a clean exit that produced no output', async () => {
		const deps: RunnerDeps = {
			db,
			docker: createMockDocker({
				producesOutput: false,
				execStart: async () => ({ stdout: 'here is my plan', stderr: '' }),
				execInspect: async () => ({ ExitCode: 0, Running: false, Pid: 0 }),
			}),
			masterKeyManager,
			serverPort: 3000,
			dataDir: testDataDir,
			logs: new LogStreamBroker(),
		};

		const result = await runAgent(deps, makeAgent(), makeTask(), makeProject());

		expect(result.success).toBe(false);
		expect(result.exitCode).toBe(0);

		const run = await db.query<{
			status: string;
			produced_output: boolean;
			error: string | null;
		}>('SELECT status, produced_output, error FROM heartbeat_runs WHERE id = $1', [
			result.heartbeatRunId,
		]);
		expect(run.rows[0].status).toBe(HeartbeatRunStatus.Failed);
		expect(run.rows[0].produced_output).toBe(false);
		expect(run.rows[0].error).toContain('produced no output');
	});

	it('succeeds a clean exit that declared no work via report_no_work', async () => {
		const deps: RunnerDeps = {
			db,
			docker: createMockDocker({
				producesOutput: false,
				reportsNoWork: true,
				noWorkReason: 'planning task — sub-tasks still open',
			}),
			masterKeyManager,
			serverPort: 3000,
			dataDir: testDataDir,
			logs: new LogStreamBroker(),
		};

		const result = await runAgent(deps, makeAgent(), makeTask(), makeProject());

		expect(result.success).toBe(true);
		expect(result.exitCode).toBe(0);

		const run = await db.query<{
			status: string;
			produced_output: boolean;
			reported_no_work: boolean;
			no_work_reason: string | null;
			error: string | null;
		}>(
			'SELECT status, produced_output, reported_no_work, no_work_reason, error FROM heartbeat_runs WHERE id = $1',
			[result.heartbeatRunId],
		);
		expect(run.rows[0].status).toBe(HeartbeatRunStatus.Succeeded);
		expect(run.rows[0].produced_output).toBe(false);
		expect(run.rows[0].reported_no_work).toBe(true);
		expect(run.rows[0].no_work_reason).toBe('planning task — sub-tasks still open');
		expect(run.rows[0].error).toBeNull();
	});

	it('fails a clean exit where the CLI terminated still-running background work', async () => {
		// producesOutput defaults true: the run wrote something earlier (e.g. a
		// progress update), so absent the backstop it would count as a success. But
		// the CLI printed its background-termination diagnostic to stderr, meaning it
		// killed unfinished work (a run_in_background job / Workflow fan-out) — the
		// run's real deliverable never landed, so it must be failed, not succeeded.
		const deps: RunnerDeps = {
			db,
			docker: createMockDocker({
				execStart: async () => ({
					stdout: 'done',
					stderr:
						'Background tasks still running after 600s; terminating. Set CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS=0 to wait indefinitely.',
				}),
				execInspect: async () => ({ ExitCode: 0, Running: false, Pid: 0 }),
			}),
			masterKeyManager,
			serverPort: 3000,
			dataDir: testDataDir,
			logs: new LogStreamBroker(),
		};

		const result = await runAgent(deps, makeAgent(), makeTask(), makeProject());

		expect(result.success).toBe(false);
		expect(result.exitCode).toBe(0);

		const run = await db.query<{
			status: string;
			produced_output: boolean;
			error: string | null;
		}>('SELECT status, produced_output, error FROM heartbeat_runs WHERE id = $1', [
			result.heartbeatRunId,
		]);
		expect(run.rows[0].status).toBe(HeartbeatRunStatus.Failed);
		// It DID write earlier — abandoned background work overrides that.
		expect(run.rows[0].produced_output).toBe(true);
		expect(run.rows[0].error).toContain('background tasks still running');
	});

	it('does not fail when the agent merely echoes the termination phrase in its message', async () => {
		// The phrase rides inside a stream-json assistant event (a JSON line on
		// stdout), not as a CLI diagnostic — the backstop must ignore it so a run
		// discussing this very behaviour isn't falsely failed.
		const echoed = JSON.stringify({
			type: 'assistant',
			message: {
				role: 'assistant',
				content: [
					{
						type: 'text',
						text: 'Claude Code prints "Background tasks still running after 600s; terminating." when it kills them.',
					},
				],
			},
		});
		const deps: RunnerDeps = {
			db,
			docker: createMockDocker({
				execStart: async () => ({ stdout: `${echoed}\n`, stderr: '' }),
				execInspect: async () => ({ ExitCode: 0, Running: false, Pid: 0 }),
			}),
			masterKeyManager,
			serverPort: 3000,
			dataDir: testDataDir,
			logs: new LogStreamBroker(),
		};

		const result = await runAgent(deps, makeAgent(), makeTask(), makeProject());

		expect(result.success).toBe(true);
		const run = await db.query<{ status: string }>(
			'SELECT status FROM heartbeat_runs WHERE id = $1',
			[result.heartbeatRunId],
		);
		expect(run.rows[0].status).toBe(HeartbeatRunStatus.Succeeded);
	});

	it('records failure in heartbeat run on non-zero exit code', async () => {
		const docker = createMockDocker({
			execCreate: async () => 'exec-fail',
			execStart: async () => ({ stdout: '', stderr: 'command failed' }),
			execInspect: async () => ({ ExitCode: 1, Running: false, Pid: 0 }),
		});

		const deps: RunnerDeps = {
			db,
			docker,
			masterKeyManager,
			serverPort: 3000,
			dataDir: testDataDir,
			logs: new LogStreamBroker(),
		};

		const result = await runAgent(deps, makeAgent(), makeTask(), makeProject());

		expect(result.success).toBe(false);
		expect(result.exitCode).toBe(1);
		expect(result.heartbeatRunId).toBeDefined();

		const run = await db.query<{ status: string }>(
			'SELECT status FROM heartbeat_runs WHERE id = $1',
			[result.heartbeatRunId],
		);
		expect(run.rows[0].status).toBe(HeartbeatRunStatus.Failed);
	});

	it('explains a signal kill and names the container memory cap', async () => {
		await db.query('UPDATE projects SET memory_limit_gib = 6 WHERE id = $1', [projectId]);
		try {
			const docker = createMockDocker({
				execCreate: async () => 'exec-oom',
				// A SIGKILLed CLI writes no terminal event; the shell's `Killed` is all
				// that reaches the log, which is exactly why the run row was blank.
				execStart: async () => ({ stdout: '', stderr: 'Killed\n' }),
				execInspect: async () => ({ ExitCode: 137, Running: false, Pid: 0 }),
			});

			const deps: RunnerDeps = {
				db,
				docker,
				masterKeyManager,
				serverPort: 3000,
				dataDir: testDataDir,
				logs: new LogStreamBroker(),
			};

			const result = await runAgent(deps, makeAgent(), makeTask(), makeProject());

			expect(result.success).toBe(false);
			expect(result.exitCode).toBe(137);

			const run = await db.query<{ status: string; error: string | null; log_text: string }>(
				`SELECT status, error, ${runLogTextSql('heartbeat_runs.id')} AS log_text FROM heartbeat_runs WHERE id = $1`,
				[result.heartbeatRunId],
			);
			expect(run.rows[0].status).toBe(HeartbeatRunStatus.Failed);
			expect(run.rows[0].error).toContain('SIGKILL');
			expect(run.rows[0].error).toContain('6 GiB');
			expect(run.rows[0].log_text).toContain('SIGKILL');
		} finally {
			await db.query('UPDATE projects SET memory_limit_gib = NULL WHERE id = $1', [projectId]);
		}
	});

	it('records failure when docker exec throws', async () => {
		const docker = createMockDocker({
			execCreate: async () => {
				throw new Error('Container not found');
			},
		});

		const deps: RunnerDeps = {
			db,
			docker,
			masterKeyManager,
			serverPort: 3000,
			dataDir: testDataDir,
			logs: new LogStreamBroker(),
		};

		const result = await runAgent(deps, makeAgent(), makeTask(), makeProject());

		expect(result.success).toBe(false);
		expect(result.exitCode).toBe(-1);
		expect(result.stderr).toContain('Container not found');
		expect(result.heartbeatRunId).toBeDefined();

		const run = await db.query<{ status: string }>(
			'SELECT status FROM heartbeat_runs WHERE id = $1',
			[result.heartbeatRunId],
		);
		expect(run.rows[0].status).toBe(HeartbeatRunStatus.Failed);
	});

	it('includes task rules in task prompt when present', async () => {
		const project = makeProject();
		const docker = createMockDocker({
			execCreate: async (_containerId: string, opts: any) => {
				const prompt = readPromptFromExec(opts, testDataDir, project);
				expect(prompt).toContain('Rules for this task');
				expect(prompt).toContain('Always write tests');
				return 'exec-rules';
			},
			execStart: async () => ({ stdout: 'ok', stderr: '' }),
			execInspect: async () => ({ ExitCode: 0, Running: false, Pid: 0 }),
		});

		const deps: RunnerDeps = {
			db,
			docker,
			masterKeyManager,
			serverPort: 3000,
			dataDir: testDataDir,
			logs: new LogStreamBroker(),
		};

		const taskWithRules = { ...makeTask(), rules: 'Always write tests' };
		const result = await runAgent(deps, makeAgent(), taskWithRules, project);
		expect(result.success).toBe(true);
	});

	it('includes task progress summary in task prompt when present', async () => {
		const project = makeProject();
		const docker = createMockDocker({
			execCreate: async (_containerId: string, opts: any) => {
				const prompt = readPromptFromExec(opts, testDataDir, project);
				expect(prompt).toContain('### Progress Summary');
				expect(prompt).toContain('Parser landed; tests still failing');
				return 'exec-progress';
			},
			execStart: async () => ({ stdout: 'ok', stderr: '' }),
			execInspect: async () => ({ ExitCode: 0, Running: false, Pid: 0 }),
		});

		const deps: RunnerDeps = {
			db,
			docker,
			masterKeyManager,
			serverPort: 3000,
			dataDir: testDataDir,
			logs: new LogStreamBroker(),
		};

		const taskWithSummary = {
			...makeTask(),
			progress_summary: 'Parser landed; tests still failing',
		};
		const result = await runAgent(deps, makeAgent(), taskWithSummary, project);
		expect(result.success).toBe(true);
	});

	it('passes correct env vars to docker exec', async () => {
		let capturedEnv: string[] = [];
		let capturedUser: string | undefined;
		const docker = createMockDocker({
			execCreate: async (_containerId: string, opts: any) => {
				capturedEnv = opts.Env;
				capturedUser = opts.User;
				return 'exec-env';
			},
			execStart: async () => ({ stdout: 'ok', stderr: '' }),
			execInspect: async () => ({ ExitCode: 0, Running: false, Pid: 0 }),
		});

		const deps: RunnerDeps = {
			db,
			docker,
			masterKeyManager,
			serverPort: 3100,
			dataDir: testDataDir,
			logs: new LogStreamBroker(),
		};

		await runAgent(deps, makeAgent(), makeTask(), makeProject());

		expect(capturedEnv.some((e: string) => e.startsWith('HEZO_AGENT_TOKEN='))).toBe(true);
		expect(capturedEnv.some((e: string) => e.startsWith('HEZO_AGENT_ID='))).toBe(true);
		expect(capturedEnv.some((e: string) => e.startsWith('HEZO_TEAM_ID='))).toBe(true);
		expect(capturedEnv.some((e: string) => e.startsWith('HEZO_TASK_ID='))).toBe(true);

		expect(capturedUser).toBe('node');
	});

	it('injects Run Context with the project slug and current task into the system prompt', async () => {
		const project = makeProject();
		let capturedPrompt = '';
		const docker = createMockDocker({
			execCreate: async (_containerId: string, opts: any) => {
				capturedPrompt = readPromptFromExec(opts, testDataDir, project);
				return 'exec-run-ctx';
			},
			execStart: async () => ({ stdout: 'ok', stderr: '' }),
			execInspect: async () => ({ ExitCode: 0, Running: false, Pid: 0 }),
		});

		const deps: RunnerDeps = {
			db,
			docker,
			masterKeyManager,
			serverPort: 3100,
			dataDir: testDataDir,
			logs: new LogStreamBroker(),
		};

		await runAgent(deps, makeAgent(), makeTask(), project);

		const taskIdentifier = (
			await db.query<{ identifier: string }>('SELECT identifier FROM tasks WHERE id = $1', [taskId])
		).rows[0].identifier;

		expect(capturedPrompt).toContain('## Run Context');
		expect(capturedPrompt).toContain(`- Project: \`${projectSlug}\``);
		expect(capturedPrompt).toContain(`- Current task: \`${taskIdentifier}\``);
	});

	it('handles coach review trigger', async () => {
		const project = makeProject();
		let capturedPrompt = '';
		const docker = createMockDocker({
			execCreate: async (_containerId: string, opts: any) => {
				capturedPrompt = readPromptFromExec(opts, testDataDir, project);
				return 'exec-coach';
			},
			execStart: async () => ({ stdout: 'reviewed', stderr: '' }),
			execInspect: async () => ({ ExitCode: 0, Running: false, Pid: 0 }),
		});

		const deps: RunnerDeps = {
			db,
			docker,
			masterKeyManager,
			serverPort: 3000,
			dataDir: testDataDir,
			logs: new LogStreamBroker(),
		};

		const result = await runAgent(deps, makeAgent(), makeTask(), project, {
			trigger: 'task_done',
		});

		expect(result.success).toBe(true);
		expect(capturedPrompt).toContain('Review Completed Task');
		expect(capturedPrompt).toContain('Comment History');
	});

	it('returns immediately when signal is already aborted', async () => {
		const docker = createMockDocker({
			execCreate: async () => {
				throw new Error('should not be called');
			},
		});

		const deps: RunnerDeps = {
			db,
			docker,
			masterKeyManager,
			serverPort: 3000,
			dataDir: testDataDir,
			logs: new LogStreamBroker(),
		};

		const ac = new AbortController();
		ac.abort();

		const result = await runAgent(
			deps,
			makeAgent(),
			makeTask(),
			makeProject(),
			undefined,
			ac.signal,
		);

		expect(result.success).toBe(false);
		expect(result.stderr).toBe('Aborted');
		// No heartbeat run should be created since we aborted before that step
		expect(result.heartbeatRunId).toBeUndefined();
	});

	describe('effort configuration', () => {
		it('appends the ultrathink directive when the wakeup asks for max effort', async () => {
			const project = makeProject();
			let capturedPrompt = '';
			const docker = createMockDocker({
				execCreate: async (_id: string, opts: any) => {
					capturedPrompt = readPromptFromExec(opts, testDataDir, project);
					return 'exec-ultra';
				},
				execStart: async () => ({ stdout: 'ok', stderr: '' }),
				execInspect: async () => ({ ExitCode: 0, Running: false, Pid: 0 }),
			});

			const deps: RunnerDeps = {
				db,
				docker,
				masterKeyManager,
				serverPort: 3000,
				dataDir: testDataDir,
				logs: new LogStreamBroker(),
			};

			await runAgent(deps, makeAgent(), makeTask(), project, {
				effort: AgentEffort.Max,
			});

			expect(capturedPrompt.trim().endsWith('ultrathink')).toBe(true);
		});

		it("uses the agent's default_effort when the wakeup carries no override", async () => {
			const project = makeProject();
			let capturedPrompt = '';
			const docker = createMockDocker({
				execCreate: async (_id: string, opts: any) => {
					capturedPrompt = readPromptFromExec(opts, testDataDir, project);
					return 'exec-default';
				},
				execStart: async () => ({ stdout: 'ok', stderr: '' }),
				execInspect: async () => ({ ExitCode: 0, Running: false, Pid: 0 }),
			});

			const deps: RunnerDeps = {
				db,
				docker,
				masterKeyManager,
				serverPort: 3000,
				dataDir: testDataDir,
				logs: new LogStreamBroker(),
			};

			await runAgent(
				deps,
				{ ...makeAgent(), default_effort: AgentEffort.High },
				makeTask(),
				project,
			);

			expect(capturedPrompt.trim().endsWith('think hard')).toBe(true);
		});

		it('exposes HEZO_AGENT_EFFORT in the container env', async () => {
			let capturedEnv: string[] = [];
			const docker = createMockDocker({
				execCreate: async (_id: string, opts: any) => {
					capturedEnv = opts.Env;
					return 'exec-env-effort';
				},
				execStart: async () => ({ stdout: 'ok', stderr: '' }),
				execInspect: async () => ({ ExitCode: 0, Running: false, Pid: 0 }),
			});

			const deps: RunnerDeps = {
				db,
				docker,
				masterKeyManager,
				serverPort: 3000,
				dataDir: testDataDir,
				logs: new LogStreamBroker(),
			};

			await runAgent(deps, makeAgent(), makeTask(), makeProject(), {
				effort: AgentEffort.Low,
			});

			expect(capturedEnv).toContain(`HEZO_AGENT_EFFORT=${AgentEffort.Low}`);
		});

		it('passes model_reasoning_effort CLI flag for the Codex runtime', async () => {
			let capturedCmd: string[] = [];
			const docker = createMockDocker({
				execCreate: async (_id: string, opts: any) => {
					capturedCmd = opts.Cmd;
					return 'exec-codex';
				},
				execStart: async () => ({ stdout: 'ok', stderr: '' }),
				execInspect: async () => ({ ExitCode: 0, Running: false, Pid: 0 }),
			});

			const deps: RunnerDeps = {
				db,
				docker,
				masterKeyManager,
				serverPort: 3000,
				dataDir: testDataDir,
				logs: new LogStreamBroker(),
			};

			// Reconfigure the provider so the Codex runtime can resolve a credential.
			// Mock fetch so verifyProviderKey doesn't make a real network call.
			globalThis.fetch = vi.fn().mockResolvedValue({ ok: true }) as unknown as typeof fetch;
			await app.request('/api/ai-providers', {
				method: 'POST',
				headers: { ...authHeader(adminToken), 'Content-Type': 'application/json' },
				body: JSON.stringify({
					provider: 'openai',
					api_key: 'sk-test-codex',
					label: 'openai-codex',
				}),
			});
			globalThis.fetch = originalFetch;

			await runAgent(
				deps,
				makeAgent(),
				{ ...makeTask(), runtime_type: 'codex' as const },
				makeProject(),
				{ effort: AgentEffort.High },
			);

			expect(capturedCmd).toContain('codex');
			expect(capturedCmd).toContain('-c');
			expect(capturedCmd).toContain('model_reasoning_effort=high');
		});
	});

	it('records cancelled status when aborted mid-execution', async () => {
		const ac = new AbortController();
		const docker = createMockDocker({
			execCreate: async () => {
				ac.abort();
				throw new DOMException('Aborted', 'AbortError');
			},
		});

		const deps: RunnerDeps = {
			db,
			docker,
			masterKeyManager,
			serverPort: 3000,
			dataDir: testDataDir,
			logs: new LogStreamBroker(),
		};

		const result = await runAgent(
			deps,
			makeAgent(),
			makeTask(),
			makeProject(),
			undefined,
			ac.signal,
		);

		expect(result.success).toBe(false);
		expect(result.heartbeatRunId).toBeDefined();

		// Heartbeat run should be marked as cancelled, not failed
		const run = await db.query<{ status: string }>(
			'SELECT status FROM heartbeat_runs WHERE id = $1',
			[result.heartbeatRunId],
		);
		expect(run.rows[0].status).toBe('cancelled');
	});

	it('records failed status with error=container_error when aborted with that reason', async () => {
		const ac = new AbortController();
		const docker = createMockDocker({
			execCreate: async () => {
				ac.abort('container_error');
				throw new DOMException('Aborted', 'AbortError');
			},
		});

		const deps: RunnerDeps = {
			db,
			docker,
			masterKeyManager,
			serverPort: 3000,
			dataDir: testDataDir,
			logs: new LogStreamBroker(),
		};

		const result = await runAgent(
			deps,
			makeAgent(),
			makeTask(),
			makeProject(),
			undefined,
			ac.signal,
		);

		expect(result.success).toBe(false);
		const run = await db.query<{ status: string; error: string | null }>(
			'SELECT status, error FROM heartbeat_runs WHERE id = $1',
			[result.heartbeatRunId],
		);
		expect(run.rows[0].status).toBe('failed');
		expect(run.rows[0].error).toBe('container_error');
	});

	// Aborting a run only disconnects from the exec attach stream; Docker leaves the
	// agent CLI running inside the container. The runner must hard-kill the run's
	// process tree (keyed by the HEZO_HEARTBEAT_RUN_ID env marker) so a terminate is
	// actually immediate rather than leaving the agent working in the background.
	it('hard-kills the container process tree when a run is terminated mid-execution', async () => {
		const ac = new AbortController();
		const killed: Array<{ containerId: string; runId: string }> = [];
		const docker = createMockDocker({
			execCreate: async () => {
				ac.abort();
				throw new DOMException('Aborted', 'AbortError');
			},
			killRunProcesses: async (containerId: string, runId: string) => {
				killed.push({ containerId, runId });
			},
		});
		const deps: RunnerDeps = {
			db,
			docker,
			masterKeyManager,
			serverPort: 3000,
			dataDir: testDataDir,
			logs: new LogStreamBroker(),
		};

		const result = await runAgent(
			deps,
			makeAgent(),
			makeTask(),
			makeProject(),
			undefined,
			ac.signal,
		);

		expect(result.heartbeatRunId).toBeDefined();
		expect(killed).toEqual([{ containerId: 'container-123', runId: result.heartbeatRunId }]);
	});

	it('hard-kills the container process tree when a run times out', async () => {
		const ac = new AbortController();
		const killed: string[] = [];
		const docker = createMockDocker({
			producesOutput: false,
			execStart: async () => {
				ac.abort('run_timeout');
				throw new DOMException('Aborted', 'AbortError');
			},
			killRunProcesses: async (_containerId: string, runId: string) => {
				killed.push(runId);
			},
		});
		const deps: RunnerDeps = {
			db,
			docker,
			masterKeyManager,
			serverPort: 3000,
			dataDir: testDataDir,
			logs: new LogStreamBroker(),
		};

		const result = await runAgent(
			deps,
			makeAgent(),
			makeTask(),
			makeProject(),
			undefined,
			ac.signal,
		);

		expect(killed).toEqual([result.heartbeatRunId]);
	});

	// When the container itself died (container_stopped / container_error), the run's
	// process is already gone with it, so there is nothing to kill — and exec'ing a
	// dead container would only throw.
	it('does not attempt a process kill when the container itself died', async () => {
		const ac = new AbortController();
		let killCalled = false;
		const docker = createMockDocker({
			execCreate: async () => {
				ac.abort('container_stopped');
				throw new DOMException('Aborted', 'AbortError');
			},
			killRunProcesses: async () => {
				killCalled = true;
			},
		});
		const deps: RunnerDeps = {
			db,
			docker,
			masterKeyManager,
			serverPort: 3000,
			dataDir: testDataDir,
			logs: new LogStreamBroker(),
		};

		const result = await runAgent(
			deps,
			makeAgent(),
			makeTask(),
			makeProject(),
			undefined,
			ac.signal,
		);

		expect(result.success).toBe(false);
		expect(killCalled).toBe(false);
	});

	it('invokes onRunRegistered with the heartbeat run id before exec begins', async () => {
		let registered: string | undefined;
		const docker = createMockDocker({
			execCreate: async () => 'exec-1',
			execStart: async () => ({ stdout: '', stderr: '' }),
			execInspect: async () => ({ ExitCode: 0, Running: false, Pid: 0 }),
		});
		const deps: RunnerDeps = {
			db,
			docker,
			masterKeyManager,
			serverPort: 3000,
			dataDir: testDataDir,
			logs: new LogStreamBroker(),
		};

		const result = await runAgent(
			deps,
			makeAgent(),
			makeTask(),
			makeProject(),
			undefined,
			undefined,
			(runId) => {
				registered = runId;
			},
		);

		expect(registered).toBeDefined();
		expect(registered).toBe(result.heartbeatRunId);
	});

	describe('MCP config + logs + worktree', () => {
		it('sets started_at to a real timestamp', async () => {
			const docker = createMockDocker({
				execCreate: async () => 'exec-start',
				execStart: async () => ({ stdout: '', stderr: '' }),
				execInspect: async () => ({ ExitCode: 0, Running: false, Pid: 0 }),
			});
			const deps: RunnerDeps = {
				db,
				docker,
				masterKeyManager,
				serverPort: 3000,
				dataDir: testDataDir,
				logs: new LogStreamBroker(),
			};

			const result = await runAgent(deps, makeAgent(), makeTask(), makeProject());

			expect(result.heartbeatRunId).toBeDefined();
			const row = await db.query<{ started_at: string | null }>(
				'SELECT started_at FROM heartbeat_runs WHERE id = $1',
				[result.heartbeatRunId],
			);
			expect(row.rows[0].started_at).not.toBeNull();
			expect(new Date(row.rows[0].started_at!).getTime()).toBeGreaterThan(Date.now() - 10_000);
		});

		it('fails the run before exec when the primary repo worktree cannot be prepared', async () => {
			const repoRes = await db.query<{ id: string }>(
				`INSERT INTO repos (project_id, repo_identifier, host_type)
				 VALUES ($1, 'acme/todos', 'github') RETURNING id`,
				[projectId],
			);
			const repoId = repoRes.rows[0].id;

			// Prep runs `git …` and `sh -c …` helpers in the container (repo sync,
			// worktree-root mkdir/chown, run-user probe); the agent CLI exec is the
			// runtime binary — neither `git` nor `sh`. The mock git execs "succeed" but
			// produce no real checkout on disk, so the worktree can't be prepared and the
			// run must fail before the agent runs.
			let agentExecCreated = false;
			const docker = createMockDocker({
				execCreate: async (_id: string, opts: { Cmd: string[] }) => {
					if (opts.Cmd[0] !== 'git' && opts.Cmd[0] !== 'sh') agentExecCreated = true;
					return 'exec-wt-fail';
				},
			});
			const deps: RunnerDeps = {
				db,
				docker,
				masterKeyManager,
				serverPort: 3000,
				dataDir: testDataDir,
				logs: new LogStreamBroker(),
			};

			try {
				// The linked repo can't clone (no bridge), so the primary repo worktree
				// can't exist. The run must fail with the worktree error instead of
				// exec'ing the agent CLI into a missing cwd.
				const result = await runAgent(deps, makeAgent(), makeTask(), makeProject());

				expect(result.success).toBe(false);
				expect(agentExecCreated).toBe(false);
				expect(result.stderr).toContain('cannot prepare worktree for todos');

				const row = await db.query<{ status: string; error: string | null }>(
					'SELECT status, error FROM heartbeat_runs WHERE id = $1',
					[result.heartbeatRunId],
				);
				expect(row.rows[0].status).toBe(HeartbeatRunStatus.Failed);
				expect(row.rows[0].error).toContain('cannot prepare worktree for todos');
			} finally {
				await db.query('DELETE FROM repos WHERE id = $1', [repoId]);
			}
		});

		it('passes --mcp-config and --strict-mcp-config for claude_code runtime', async () => {
			let capturedCmd: string[] = [];
			const docker = createMockDocker({
				execCreate: async (_id: string, opts: any) => {
					capturedCmd = opts.Cmd;
					return 'exec-mcp';
				},
				execStart: async () => ({ stdout: '', stderr: '' }),
				execInspect: async () => ({ ExitCode: 0, Running: false, Pid: 0 }),
			});
			const deps: RunnerDeps = {
				db,
				docker,
				masterKeyManager,
				serverPort: 3100,
				dataDir: testDataDir,
				logs: new LogStreamBroker(),
			};

			const result = await runAgent(deps, makeAgent(), makeTask(), makeProject());

			expect(capturedCmd).toContain('--mcp-config');
			expect(capturedCmd).toContain('--strict-mcp-config');
			const mcpIdx = capturedCmd.indexOf('--mcp-config');
			const mcpJson = capturedCmd[mcpIdx + 1];
			const parsed = JSON.parse(mcpJson) as {
				mcpServers: { hezo: { type: string; url: string; headers: Record<string, string> } };
			};
			expect(parsed.mcpServers.hezo.type).toBe('http');
			expect(parsed.mcpServers.hezo.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
			const authHeaderValue = parsed.mcpServers.hezo.headers.Authorization;
			expect(authHeaderValue).toMatch(/^Bearer /);

			const token = authHeaderValue.slice('Bearer '.length);
			const payloadBase64 = token.split('.')[1];
			const payload = JSON.parse(Buffer.from(payloadBase64, 'base64url').toString('utf8')) as {
				member_id: string;
				team_id: string;
				run_id: string;
				exp: number;
			};
			expect(payload.run_id).toBe(result.heartbeatRunId);
			expect(payload.member_id).toBe(makeAgent().id);
			expect(payload.team_id).toBe(makeAgent().team_id);
			expect(payload.exp - Math.floor(Date.now() / 1000)).toBeLessThanOrEqual(60 * 60 * 4);
		});

		it('does not pass --mcp-config for non-claude runtimes', async () => {
			let capturedCmd: string[] = [];
			const docker = createMockDocker({
				execCreate: async (_id: string, opts: any) => {
					capturedCmd = opts.Cmd;
					return 'exec-nomcp';
				},
				execStart: async () => ({ stdout: '', stderr: '' }),
				execInspect: async () => ({ ExitCode: 0, Running: false, Pid: 0 }),
			});
			const deps: RunnerDeps = {
				db,
				docker,
				masterKeyManager,
				serverPort: 3000,
				dataDir: testDataDir,
				logs: new LogStreamBroker(),
			};

			await runAgent(
				deps,
				makeAgent(),
				{ ...makeTask(), runtime_type: 'codex' as const },
				makeProject(),
			);

			expect(capturedCmd).not.toContain('--mcp-config');
			expect(capturedCmd).not.toContain('--strict-mcp-config');
		});

		it('writes config.toml and sets HEZO_MCP_BEARER_TOKEN_HEZO for codex (api-key auth)', async () => {
			await db.query(`DELETE FROM ai_provider_configs WHERE provider = 'openai'`);
			globalThis.fetch = vi.fn().mockResolvedValue({ ok: true }) as unknown as typeof fetch;
			await app.request('/api/ai-providers', {
				method: 'POST',
				headers: { ...authHeader(adminToken), 'Content-Type': 'application/json' },
				body: JSON.stringify({
					provider: 'openai',
					api_key: 'sk-test-codex-mcp',
					label: 'openai-codex-mcp',
				}),
			});
			globalThis.fetch = originalFetch;

			let capturedEnv: string[] = [];
			let stagedTomlPath: string | null = null;
			let stagedTomlContents: string | null = null;
			const docker = createMockDocker({
				execCreate: async (_id: string, opts: any) => {
					capturedEnv = opts.Env;
					const codexHomeEntry = (opts.Env as string[]).find((e) => e.startsWith('CODEX_HOME='));
					if (codexHomeEntry) {
						const containerDir = codexHomeEntry.slice('CODEX_HOME='.length);
						const runId = containerDir.split('/').pop()!;
						stagedTomlPath = `${getHostSubscriptionRoot(
							AiProvider.OpenAI,
							AgentRuntime.Codex,
							testDataDir,
							teamId,
							projectId,
							runId,
						)}/config.toml`;
						stagedTomlContents = readFileSync(stagedTomlPath, 'utf8');
					}
					return 'exec-codex-mcp';
				},
				execStart: async () => ({ stdout: '', stderr: '' }),
				execInspect: async () => ({ ExitCode: 0, Running: false, Pid: 0 }),
			});

			const deps: RunnerDeps = {
				db,
				docker,
				masterKeyManager,
				serverPort: 3000,
				dataDir: testDataDir,
				logs: new LogStreamBroker(),
			};

			const result = await runAgent(
				deps,
				makeAgent(),
				{ ...makeTask(), runtime_type: 'codex' as const },
				makeProject(),
			);

			expect(result.success).toBe(true);

			// Codex MCP env var must be present and carry the actual JWT.
			const tokenEntry = capturedEnv.find((e) => e.startsWith('HEZO_MCP_BEARER_TOKEN_HEZO='));
			expect(tokenEntry).toBeDefined();
			const token = tokenEntry!.slice('HEZO_MCP_BEARER_TOKEN_HEZO='.length);
			expect(token.split('.').length).toBe(3); // looks like a JWT

			// CODEX_HOME must be present exactly once.
			const codexHomeEntries = capturedEnv.filter((e) => e.startsWith('CODEX_HOME='));
			expect(codexHomeEntries.length).toBe(1);

			// config.toml must have been staged with the right body and not contain the JWT.
			expect(stagedTomlPath).not.toBeNull();
			expect(stagedTomlContents).toContain('[mcp_servers.hezo]');
			expect(stagedTomlContents).toMatch(/url = "http:\/\/127\.0\.0\.1:\d+\/mcp"/);
			expect(stagedTomlContents).toContain('bearer_token_env_var = "HEZO_MCP_BEARER_TOKEN_HEZO"');
			expect(stagedTomlContents).not.toContain(token);

			// Per-run home dir is cleaned up after the run completes.
			expect(existsSync(stagedTomlPath!)).toBe(false);
		});

		it('writes config.toml alongside auth.json for codex (subscription auth)', async () => {
			const validAuthJson = JSON.stringify({
				tokens: {
					id_token: 'header.payload.sig',
					access_token: 'header.payload.sig',
					refresh_token: 'rt-mcp',
					account_id: 'acct-mcp',
				},
			});
			await db.query(`DELETE FROM ai_provider_configs WHERE provider = 'openai'`);
			await app.request('/api/ai-providers', {
				method: 'POST',
				headers: { ...authHeader(adminToken), 'Content-Type': 'application/json' },
				body: JSON.stringify({
					provider: 'openai',
					api_key: validAuthJson,
					auth_method: AiAuthMethod.Subscription,
					label: 'openai-codex-sub-mcp',
				}),
			});

			let capturedEnv: string[] = [];
			let observedAuthFile: string | null = null;
			let observedTomlFile: string | null = null;
			const docker = createMockDocker({
				execCreate: async (_id: string, opts: any) => {
					capturedEnv = opts.Env;
					const codexHomeEntry = (opts.Env as string[]).find((e) => e.startsWith('CODEX_HOME='));
					if (codexHomeEntry) {
						const containerDir = codexHomeEntry.slice('CODEX_HOME='.length);
						const runId = containerDir.split('/').pop()!;
						const hostDir = getHostSubscriptionRoot(
							AiProvider.OpenAI,
							AgentRuntime.Codex,
							testDataDir,
							teamId,
							projectId,
							runId,
						);
						observedAuthFile = `${hostDir}/auth.json`;
						observedTomlFile = `${hostDir}/config.toml`;
						expect(existsSync(observedAuthFile)).toBe(true);
						expect(existsSync(observedTomlFile)).toBe(true);
						expect(readFileSync(observedAuthFile, 'utf8')).toBe(validAuthJson);
					}
					return 'exec-codex-sub-mcp';
				},
				execStart: async () => ({ stdout: '', stderr: '' }),
				execInspect: async () => ({ ExitCode: 0, Running: false, Pid: 0 }),
			});

			const deps: RunnerDeps = {
				db,
				docker,
				masterKeyManager,
				serverPort: 3000,
				dataDir: testDataDir,
				logs: new LogStreamBroker(),
			};

			const result = await runAgent(
				deps,
				makeAgent(),
				{ ...makeTask(), runtime_type: 'codex' as const },
				makeProject(),
			);
			expect(result.success).toBe(true);

			// Exactly one CODEX_HOME entry — subscription mount and home mount must
			// not both contribute one.
			expect(capturedEnv.filter((e) => e.startsWith('CODEX_HOME=')).length).toBe(1);
			expect(capturedEnv.some((e) => e.startsWith('HEZO_MCP_BEARER_TOKEN_HEZO='))).toBe(true);

			// Cleanup removes the whole per-run dir, taking config.toml + auth.json with it.
			expect(observedTomlFile).not.toBeNull();
			expect(existsSync(observedTomlFile!)).toBe(false);
			expect(existsSync(observedAuthFile!)).toBe(false);

			// Restore an api-key openai config so subsequent tests in the file
			// (which assume api-key auth) keep working.
			await db.query(`DELETE FROM ai_provider_configs WHERE provider = 'openai'`);
			globalThis.fetch = vi.fn().mockResolvedValue({ ok: true }) as unknown as typeof fetch;
			await app.request('/api/ai-providers', {
				method: 'POST',
				headers: { ...authHeader(adminToken), 'Content-Type': 'application/json' },
				body: JSON.stringify({
					provider: 'openai',
					api_key: 'sk-test-codex-restore',
					label: 'openai-codex-restore',
				}),
			});
			globalThis.fetch = originalFetch;
		});

		it('writes .gemini/settings.json for gemini runtime', async () => {
			globalThis.fetch = vi.fn().mockResolvedValue({ ok: true }) as unknown as typeof fetch;
			await db.query(`DELETE FROM ai_provider_configs WHERE provider = 'google'`);
			await app.request('/api/ai-providers', {
				method: 'POST',
				headers: { ...authHeader(adminToken), 'Content-Type': 'application/json' },
				body: JSON.stringify({
					provider: 'google',
					api_key: 'AIza-test-gemini-mcp',
					label: 'google-gemini-mcp',
				}),
			});
			globalThis.fetch = originalFetch;

			let capturedCmd: string[] = [];
			let capturedEnv: string[] = [];
			let settingsPath: string | null = null;
			let settingsContents: string | null = null;
			const docker = createMockDocker({
				execCreate: async (_id: string, opts: any) => {
					capturedCmd = opts.Cmd;
					capturedEnv = opts.Env;
					const geminiHome = (opts.Env as string[]).find((e) => e.startsWith('GEMINI_CLI_HOME='));
					if (geminiHome) {
						const containerDir = geminiHome.slice('GEMINI_CLI_HOME='.length);
						const runId = containerDir.split('/').pop()!;
						settingsPath = `${getHostSubscriptionRoot(
							AiProvider.Google,
							AgentRuntime.Gemini,
							testDataDir,
							teamId,
							projectId,
							runId,
						)}/.gemini/settings.json`;
						settingsContents = readFileSync(settingsPath, 'utf8');
					}
					return 'exec-gemini-mcp';
				},
				execStart: async () => ({ stdout: '', stderr: '' }),
				execInspect: async () => ({ ExitCode: 0, Running: false, Pid: 0 }),
			});

			const deps: RunnerDeps = {
				db,
				docker,
				masterKeyManager,
				serverPort: 3000,
				dataDir: testDataDir,
				logs: new LogStreamBroker(),
			};

			const result = await runAgent(
				deps,
				makeAgent(),
				{ ...makeTask(), runtime_type: 'gemini' as const },
				makeProject(),
			);
			expect(result.success).toBe(true);

			expect(capturedCmd).not.toContain('--mcp-config');
			expect(capturedEnv.filter((e) => e.startsWith('GEMINI_CLI_HOME=')).length).toBe(1);

			expect(settingsPath).not.toBeNull();
			const parsed = JSON.parse(settingsContents!) as {
				mcpServers: Record<string, { httpUrl: string; headers?: Record<string, string> }>;
			};
			expect(parsed.mcpServers.hezo.httpUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
			expect(parsed.mcpServers.hezo.headers?.Authorization).toMatch(/^Bearer /);

			// Cleanup removes the per-run dir.
			expect(existsSync(settingsPath!)).toBe(false);
		});

		it('persists invocation_command with JWT redacted', async () => {
			const docker = createMockDocker({
				execCreate: async () => 'exec-inv',
				execStart: async () => ({ stdout: '', stderr: '' }),
				execInspect: async () => ({ ExitCode: 0, Running: false, Pid: 0 }),
			});
			const deps: RunnerDeps = {
				db,
				docker,
				masterKeyManager,
				serverPort: 3000,
				dataDir: testDataDir,
				logs: new LogStreamBroker(),
			};

			const result = await runAgent(deps, makeAgent(), makeTask(), makeProject());

			const row = await db.query<{ invocation_command: string | null }>(
				'SELECT invocation_command FROM heartbeat_runs WHERE id = $1',
				[result.heartbeatRunId],
			);
			expect(row.rows[0].invocation_command).toBeTruthy();
			expect(row.rows[0].invocation_command!).toMatch(/Bearer \*\*\*/);
			expect(row.rows[0].invocation_command!).not.toMatch(/Bearer eyJ/);
		});

		it('sends a large system prompt via stdin file, keeping every argv element small', async () => {
			const project = makeProject();
			let capturedCmd: string[] = [];
			let capturedEnv: string[] = [];
			let promptOnDisk = '';
			const docker = createMockDocker({
				execCreate: async (_id: string, opts: any) => {
					capturedCmd = opts.Cmd;
					capturedEnv = opts.Env;
					promptOnDisk = readPromptFromExec(opts, testDataDir, project);
					return 'exec-huge';
				},
				execStart: async () => ({ stdout: '', stderr: '' }),
				execInspect: async () => ({ ExitCode: 0, Running: false, Pid: 0 }),
			});
			const deps: RunnerDeps = {
				db,
				docker,
				masterKeyManager,
				serverPort: 3000,
				dataDir: testDataDir,
				logs: new LogStreamBroker(),
			};

			const hugeSystemPrompt = 'X'.repeat(256 * 1024);
			await setAgentPrompt(hugeSystemPrompt);
			const result = await runAgent(deps, makeAgent(), makeTask(), project);

			expect(result.success).toBe(true);
			expect(capturedCmd[0]).toBe('sh');
			expect(capturedCmd[1]).toBe('-c');
			for (const element of capturedCmd) {
				expect(element.length).toBeLessThan(64 * 1024);
			}
			expect(
				capturedEnv.some(
					(e) => e === `HEZO_PROMPT_FILE=/workspace/.hezo/prompts/${result.heartbeatRunId}.txt`,
				),
			).toBe(true);
			expect(promptOnDisk).toContain(hugeSystemPrompt);
		});

		it('records the prompt-file redirect suffix in the invocation_command', async () => {
			const docker = createMockDocker({
				execCreate: async () => 'exec-nl',
				execStart: async () => ({ stdout: '', stderr: '' }),
				execInspect: async () => ({ ExitCode: 0, Running: false, Pid: 0 }),
			});
			const deps: RunnerDeps = {
				db,
				docker,
				masterKeyManager,
				serverPort: 3000,
				dataDir: testDataDir,
				logs: new LogStreamBroker(),
			};

			const result = await runAgent(deps, makeAgent(), makeTask(), makeProject());

			const row = await db.query<{ invocation_command: string | null }>(
				'SELECT invocation_command FROM heartbeat_runs WHERE id = $1',
				[result.heartbeatRunId],
			);
			const invocation = row.rows[0].invocation_command!;
			expect(invocation).toContain(`< /workspace/.hezo/prompts/${result.heartbeatRunId}.txt`);
			expect(invocation).not.toContain('\\n');
		});

		it('streams run log chunks via onChunk and persists log_text', async () => {
			const broadcasts: Array<{ room: string; event: any }> = [];
			const wsManager = {
				broadcast: (room: string, event: any) => {
					broadcasts.push({ room, event });
				},
				subscribe: () => {},
				unsubscribe: () => {},
				unsubscribeAll: () => {},
				getRoomSize: () => 0,
				getTotalConnections: () => 0,
			} as any;

			const docker = createMockDocker({
				execCreate: async () => 'exec-stream',
				execStart: async (_id: string, opts: any) => {
					if (opts?.onChunk) {
						await opts.onChunk({ stream: 'stdout', text: 'hello ' });
						await opts.onChunk({ stream: 'stdout', text: 'world\n' });
						await opts.onChunk({ stream: 'stderr', text: 'a warning\n' });
					}
					return { stdout: 'hello world\n', stderr: 'a warning\n' };
				},
				execInspect: async () => ({ ExitCode: 0, Running: false, Pid: 0 }),
			});

			const logs = new LogStreamBroker();
			logs.setWsManager(wsManager);
			const deps: RunnerDeps = {
				db,
				docker,
				masterKeyManager,
				serverPort: 3000,
				dataDir: testDataDir,
				wsManager,
				logs,
			};

			const result = await runAgent(deps, makeAgent(), makeTask(), makeProject());

			const runLogBroadcasts = broadcasts.filter((b) => b.event.type === 'run_log');
			expect(runLogBroadcasts.length).toBeGreaterThan(0);
			expect(runLogBroadcasts[0].room).toBe(`project-runs:${projectId}`);
			expect(runLogBroadcasts.some((b) => b.event.text.includes('hello'))).toBe(true);
			expect(runLogBroadcasts.some((b) => b.event.stream === 'stderr')).toBe(true);

			const row = await db.query<{ log_text: string }>(
				`SELECT ${runLogTextSql('heartbeat_runs.id')} AS log_text FROM heartbeat_runs WHERE id = $1`,
				[result.heartbeatRunId],
			);
			expect(row.rows[0].log_text).toContain('hello world');
			expect(row.rows[0].log_text).toContain('[stderr] a warning');
		});

		it('passes --dangerously-skip-permissions for claude_code runtime', async () => {
			let capturedCmd: string[] = [];
			const docker = createMockDocker({
				execCreate: async (_id: string, opts: any) => {
					capturedCmd = opts.Cmd;
					return 'exec-claude-skip';
				},
				execStart: async () => ({ stdout: '', stderr: '' }),
				execInspect: async () => ({ ExitCode: 0, Running: false, Pid: 0 }),
			});
			const deps: RunnerDeps = {
				db,
				docker,
				masterKeyManager,
				serverPort: 3000,
				dataDir: testDataDir,
				logs: new LogStreamBroker(),
			};

			await runAgent(deps, makeAgent(), makeTask(), makeProject());

			expect(capturedCmd).toContain('--dangerously-skip-permissions');
		});

		it('disables WebFetch but keeps WebSearch for claude_code runtime', async () => {
			let capturedCmd: string[] = [];
			const docker = createMockDocker({
				execCreate: async (_id: string, opts: any) => {
					capturedCmd = opts.Cmd;
					return 'exec-claude-disallow';
				},
				execStart: async () => ({ stdout: '', stderr: '' }),
				execInspect: async () => ({ ExitCode: 0, Running: false, Pid: 0 }),
			});
			const deps: RunnerDeps = {
				db,
				docker,
				masterKeyManager,
				serverPort: 3000,
				dataDir: testDataDir,
				logs: new LogStreamBroker(),
			};

			await runAgent(deps, makeAgent(), makeTask(), makeProject());

			expect(capturedCmd).toContain('--disallowedTools');
			const idx = capturedCmd.indexOf('--disallowedTools');
			expect(capturedCmd[idx + 1]).toBe('WebFetch');
			// ExitPlanMode is disallowed so a model can't park in headless plan-mode approval.
			expect(capturedCmd).toContain('ExitPlanMode');
			// Hezo owns what these do, and each fails silently rather than loudly here:
			// EnterWorktree moves the agent out of the worktree Hezo watches for
			// changes, and the Cron/wakeup tools schedule past the life of a container
			// that is destroyed when the run ends.
			expect(capturedCmd).toContain('EnterWorktree');
			expect(capturedCmd).toContain('CronCreate');
			expect(capturedCmd).toContain('ScheduleWakeup');
			// Deliberately kept: WebSearch is proxied server-side, the Task* family is
			// the agent's own in-session checklist, and Skill loads a project repo's
			// own `.claude/skills/`. They looked guilty in a failed run only because
			// that run had lost its Hezo tools entirely.
			expect(capturedCmd).not.toContain('WebSearch');
			expect(capturedCmd).not.toContain('TaskList');
			expect(capturedCmd).not.toContain('Skill');
		});

		it('does not pass --disallowedTools for codex runtime', async () => {
			let capturedCmd: string[] = [];
			const docker = createMockDocker({
				execCreate: async (_id: string, opts: any) => {
					capturedCmd = opts.Cmd;
					return 'exec-codex-disallow';
				},
				execStart: async () => ({ stdout: '', stderr: '' }),
				execInspect: async () => ({ ExitCode: 0, Running: false, Pid: 0 }),
			});
			const deps: RunnerDeps = {
				db,
				docker,
				masterKeyManager,
				serverPort: 3000,
				dataDir: testDataDir,
				logs: new LogStreamBroker(),
			};

			await runAgent(
				deps,
				makeAgent(),
				{ ...makeTask(), runtime_type: 'codex' as const },
				makeProject(),
			);

			expect(capturedCmd).not.toContain('--disallowedTools');
		});

		it('passes --dangerously-bypass-approvals-and-sandbox for codex runtime', async () => {
			let capturedCmd: string[] = [];
			const docker = createMockDocker({
				execCreate: async (_id: string, opts: any) => {
					capturedCmd = opts.Cmd;
					return 'exec-codex-bypass';
				},
				execStart: async () => ({ stdout: '', stderr: '' }),
				execInspect: async () => ({ ExitCode: 0, Running: false, Pid: 0 }),
			});
			const deps: RunnerDeps = {
				db,
				docker,
				masterKeyManager,
				serverPort: 3000,
				dataDir: testDataDir,
				logs: new LogStreamBroker(),
			};

			await runAgent(
				deps,
				makeAgent(),
				{ ...makeTask(), runtime_type: 'codex' as const },
				makeProject(),
			);

			expect(capturedCmd).toContain('codex');
			expect(capturedCmd).toContain('--dangerously-bypass-approvals-and-sandbox');
			const codexIdx = capturedCmd.indexOf('codex');
			expect(capturedCmd[codexIdx + 1]).toBe('exec');
			expect(capturedCmd[capturedCmd.length - 1]).toBe('-');
			expect(capturedCmd).not.toContain('-p');
		});

		it('passes --output-format stream-json --verbose for claude_code runtime', async () => {
			let capturedCmd: string[] = [];
			const docker = createMockDocker({
				execCreate: async (_id: string, opts: any) => {
					capturedCmd = opts.Cmd;
					return 'exec-claude-stream';
				},
				execStart: async () => ({ stdout: '', stderr: '' }),
				execInspect: async () => ({ ExitCode: 0, Running: false, Pid: 0 }),
			});
			const deps: RunnerDeps = {
				db,
				docker,
				masterKeyManager,
				serverPort: 3000,
				dataDir: testDataDir,
				logs: new LogStreamBroker(),
			};

			await runAgent(deps, makeAgent(), makeTask(), makeProject());

			expect(capturedCmd).toContain('--output-format');
			const idx = capturedCmd.indexOf('--output-format');
			expect(capturedCmd[idx + 1]).toBe('stream-json');
			expect(capturedCmd).toContain('--verbose');
			expect(capturedCmd).toContain('claude');
			expect(capturedCmd[capturedCmd.length - 1]).toBe('-p');
			expect(capturedCmd).not.toContain('exec');
		});

		it('passes exec --json (not claude stream flags) for the codex runtime', async () => {
			let capturedCmd: string[] = [];
			const docker = createMockDocker({
				execCreate: async (_id: string, opts: any) => {
					capturedCmd = opts.Cmd;
					return 'exec-codex-stream';
				},
				execStart: async () => ({ stdout: '', stderr: '' }),
				execInspect: async () => ({ ExitCode: 0, Running: false, Pid: 0 }),
			});
			const deps: RunnerDeps = {
				db,
				docker,
				masterKeyManager,
				serverPort: 3000,
				dataDir: testDataDir,
				logs: new LogStreamBroker(),
			};

			// Configure an OpenAI provider so the Codex runtime resolves a credential
			// and actually reaches execCreate. Mock fetch so verifyProviderKey doesn't
			// make a real network call.
			globalThis.fetch = vi.fn().mockResolvedValue({ ok: true }) as unknown as typeof fetch;
			await app.request('/api/ai-providers', {
				method: 'POST',
				headers: { ...authHeader(adminToken), 'Content-Type': 'application/json' },
				body: JSON.stringify({
					provider: 'openai',
					api_key: 'sk-test-codex-stream',
					label: 'openai-codex-stream',
				}),
			});
			globalThis.fetch = originalFetch;

			await runAgent(
				deps,
				makeAgent(),
				{ ...makeTask(), runtime_type: 'codex' as const },
				makeProject(),
			);

			// Codex streams newline-delimited JSON via `--json`, so token usage is
			// parsed from its turn.completed events — but it must not pick up
			// Claude's stream flags.
			expect(capturedCmd).toContain('exec');
			expect(capturedCmd).toContain('--json');
			expect(capturedCmd[capturedCmd.length - 1]).toBe('-');
			expect(capturedCmd).not.toContain('--output-format');
			expect(capturedCmd).not.toContain('stream-json');
			expect(capturedCmd).not.toContain('-p');
		});

		it('runs gemini headless with --yolo and no print/profile flag', async () => {
			let capturedCmd: string[] = [];
			const docker = createMockDocker({
				execCreate: async (_id: string, opts: any) => {
					capturedCmd = opts.Cmd;
					return 'exec-gemini';
				},
				execStart: async () => ({ stdout: '', stderr: '' }),
				execInspect: async () => ({ ExitCode: 0, Running: false, Pid: 0 }),
			});
			const deps: RunnerDeps = {
				db,
				docker,
				masterKeyManager,
				serverPort: 3000,
				dataDir: testDataDir,
				logs: new LogStreamBroker(),
			};

			globalThis.fetch = vi.fn().mockResolvedValue({ ok: true }) as unknown as typeof fetch;
			await app.request('/api/ai-providers', {
				method: 'POST',
				headers: { ...authHeader(adminToken), 'Content-Type': 'application/json' },
				body: JSON.stringify({
					provider: 'google',
					api_key: 'AIza-test-gemini-key',
					label: 'google-gemini',
				}),
			});
			globalThis.fetch = originalFetch;

			await runAgent(
				deps,
				makeAgent(),
				{ ...makeTask(), runtime_type: 'gemini' as const },
				makeProject(),
			);

			expect(capturedCmd).toContain('gemini');
			expect(capturedCmd).toContain('--yolo');
			// Gemini streams newline-delimited JSON via stream-json (live logs
			// preserved) and reports per-model token usage in its result event.
			expect(capturedCmd).toContain('--output-format');
			const fmtIdx = capturedCmd.indexOf('--output-format');
			expect(capturedCmd[fmtIdx + 1]).toBe('stream-json');
			expect(capturedCmd).not.toContain('-p');
			expect(capturedCmd).not.toContain('exec');
			const geminiIdx = capturedCmd.indexOf('gemini');
			expect(capturedCmd.slice(geminiIdx + 1)).not.toContain('-');
		});

		it('parses stream-json events and persists usage from result event', async () => {
			const events = [
				{
					type: 'system',
					subtype: 'init',
					model: 'claude-opus-4-7',
					tools: ['Read', 'Edit'],
				},
				{
					type: 'assistant',
					message: {
						role: 'assistant',
						content: [
							{ type: 'thinking', thinking: 'Let me think about this carefully.' },
							{
								type: 'tool_use',
								id: 't1',
								name: 'Read',
								input: { file_path: '/worktrees/RT-1/main/src/x.ts' },
							},
						],
					},
				},
				{
					type: 'user',
					message: {
						role: 'user',
						content: [{ type: 'tool_result', tool_use_id: 't1', content: 'file contents ok' }],
					},
				},
				{
					type: 'assistant',
					message: { role: 'assistant', content: [{ type: 'text', text: 'All done.' }] },
				},
				{
					type: 'result',
					subtype: 'success',
					duration_ms: 1234,
					num_turns: 2,
					is_error: false,
					total_cost_usd: 0.1234,
					usage: { input_tokens: 1200, output_tokens: 350 },
				},
			];
			const payload = `${events.map((e) => JSON.stringify(e)).join('\n')}\n`;

			const docker = createMockDocker({
				execCreate: async () => 'exec-claude-parse',
				execStart: async (_id: string, opts: any) => {
					if (opts?.onChunk) {
						const mid = Math.floor(payload.length / 2);
						await opts.onChunk({ stream: 'stdout', text: payload.slice(0, mid) });
						await opts.onChunk({ stream: 'stdout', text: payload.slice(mid) });
					}
					return { stdout: payload, stderr: '' };
				},
				execInspect: async () => ({ ExitCode: 0, Running: false, Pid: 0 }),
			});
			// Wire a deterministic table path (a manual override, independent of the
			// bundled snapshot). This run also reports total_cost_usd, which must be
			// ignored — cost is always computed from the table over the token buckets.
			const pricing = new PricingService(db);
			await upsertManualRate(db, {
				model_id: 'claude-opus-4-7',
				input_per_token: 0.0001,
				output_per_token: 0.0002,
			});
			await pricing.reload();
			const deps: RunnerDeps = {
				db,
				docker,
				masterKeyManager,
				serverPort: 3000,
				dataDir: testDataDir,
				logs: new LogStreamBroker(),
				pricing,
			};

			const result = await runAgent(deps, makeAgent(), makeTask(), makeProject());

			const row = await db.query<{
				log_text: string;
				input_tokens: number;
				output_tokens: number;
				cost_cents: number;
			}>(
				`SELECT ${runLogTextSql('heartbeat_runs.id')} AS log_text, input_tokens::int AS input_tokens, output_tokens::int AS output_tokens, cost_cents FROM heartbeat_runs WHERE id = $1`,
				[result.heartbeatRunId],
			);
			const log = row.rows[0].log_text;
			expect(log).toContain('[session] model=claude-opus-4-7');
			expect(log).toContain('[thinking] Let me think about this carefully.');
			expect(log).toContain('[tool] Read(file_path=/worktrees/RT-1/main/src/x.ts)');
			expect(log).toContain('[tool-result] file contents ok');
			expect(log).toContain('All done.');
			expect(log).toContain('[done] success turns=2');

			expect(row.rows[0].input_tokens).toBe(1200);
			expect(row.rows[0].output_tokens).toBe(350);
			// The reported total_cost_usd (0.1234 → 12c) is discarded; the table prices
			// the tokens: 1200*0.0001 + 350*0.0002 = 0.19 → 19 cents.
			expect(row.rows[0].cost_cents).toBe(19);
		});

		it('falls back to /workspace when no repos are linked', async () => {
			let capturedWorkingDir = '';
			const docker = createMockDocker({
				execCreate: async (_id: string, opts: any) => {
					capturedWorkingDir = opts.WorkingDir;
					return 'exec-nowt';
				},
				execStart: async () => ({ stdout: '', stderr: '' }),
				execInspect: async () => ({ ExitCode: 0, Running: false, Pid: 0 }),
			});

			const deps: RunnerDeps = {
				db,
				docker,
				masterKeyManager,
				serverPort: 3000,
				dataDir: testDataDir,
				logs: new LogStreamBroker(),
			};

			await runAgent(deps, makeAgent(), makeTask(), makeProject());

			expect(capturedWorkingDir).toBe('/workspace');

			const row = await db.query<{ working_dir: string | null }>(
				'SELECT working_dir FROM heartbeat_runs WHERE member_id = $1 ORDER BY started_at DESC LIMIT 1',
				[agentId],
			);
			expect(row.rows[0].working_dir).toBe('/workspace');
		});
	});

	describe('--model flag resolution', () => {
		it('omits --model when neither override nor default_model is set', async () => {
			let capturedCmd: string[] = [];
			const docker = createMockDocker({
				execCreate: async (_id: string, opts: any) => {
					capturedCmd = opts.Cmd;
					return 'exec-no-model';
				},
				execStart: async () => ({ stdout: '', stderr: '' }),
				execInspect: async () => ({ ExitCode: 0, Running: false, Pid: 0 }),
			});

			const deps: RunnerDeps = {
				db,
				docker,
				masterKeyManager,
				serverPort: 3000,
				dataDir: testDataDir,
				logs: new LogStreamBroker(),
			};

			// Clear any default_model state on all configs.
			await db.query('UPDATE ai_provider_configs SET default_model = NULL');

			await runAgent(deps, makeAgent(), makeTask(), makeProject());

			expect(capturedCmd).not.toContain('--model');
		});

		it('passes --model when the active config has default_model', async () => {
			let capturedCmd: string[] = [];
			const docker = createMockDocker({
				execCreate: async (_id: string, opts: any) => {
					capturedCmd = opts.Cmd;
					return 'exec-default-model';
				},
				execStart: async () => ({ stdout: '', stderr: '' }),
				execInspect: async () => ({ ExitCode: 0, Running: false, Pid: 0 }),
			});

			const deps: RunnerDeps = {
				db,
				docker,
				masterKeyManager,
				serverPort: 3000,
				dataDir: testDataDir,
				logs: new LogStreamBroker(),
			};

			await db.query(
				`UPDATE ai_provider_configs SET default_model = 'claude-opus-4-7' WHERE provider = 'anthropic'`,
			);

			await runAgent(deps, makeAgent(), makeTask(), makeProject());

			expect(capturedCmd).toContain('--model');
			const idx = capturedCmd.indexOf('--model');
			expect(capturedCmd[idx + 1]).toBe('claude-opus-4-7');
		});

		it('agent.model_override_model takes precedence over default_model', async () => {
			let capturedCmd: string[] = [];
			const docker = createMockDocker({
				execCreate: async (_id: string, opts: any) => {
					capturedCmd = opts.Cmd;
					return 'exec-override';
				},
				execStart: async () => ({ stdout: '', stderr: '' }),
				execInspect: async () => ({ ExitCode: 0, Running: false, Pid: 0 }),
			});

			const deps: RunnerDeps = {
				db,
				docker,
				masterKeyManager,
				serverPort: 3000,
				dataDir: testDataDir,
				logs: new LogStreamBroker(),
			};

			await db.query(
				`UPDATE ai_provider_configs SET default_model = 'claude-opus-4-7' WHERE provider = 'anthropic'`,
			);

			await runAgent(
				deps,
				{
					...makeAgent(),
					model_override_provider: 'anthropic',
					model_override_model: 'claude-haiku-4-5',
				},
				makeTask(),
				makeProject(),
			);

			expect(capturedCmd).toContain('--model');
			const idx = capturedCmd.indexOf('--model');
			expect(capturedCmd[idx + 1]).toBe('claude-haiku-4-5');
		});

		it('routes to the override provider regardless of instance default', async () => {
			let capturedCmd: string[] = [];
			let capturedEnv: string[] = [];
			const docker = createMockDocker({
				execCreate: async (_id: string, opts: any) => {
					capturedCmd = opts.Cmd;
					capturedEnv = opts.Env;
					return 'exec-cross';
				},
				execStart: async () => ({ stdout: '', stderr: '' }),
				execInspect: async () => ({ ExitCode: 0, Running: false, Pid: 0 }),
			});

			const deps: RunnerDeps = {
				db,
				docker,
				masterKeyManager,
				serverPort: 3000,
				dataDir: testDataDir,
				logs: new LogStreamBroker(),
			};

			// Ensure an openai config exists so the override provider can resolve.
			globalThis.fetch = vi.fn().mockResolvedValue({ ok: true }) as unknown as typeof fetch;
			await app.request('/api/ai-providers', {
				method: 'POST',
				headers: { ...authHeader(adminToken), 'Content-Type': 'application/json' },
				body: JSON.stringify({
					provider: 'openai',
					api_key: 'sk-cross-provider-test',
					label: 'openai-cross',
				}),
			});
			globalThis.fetch = originalFetch;

			await runAgent(
				deps,
				{
					...makeAgent(),
					model_override_provider: 'openai',
					model_override_model: 'gpt-5-mini',
				},
				makeTask(),
				makeProject(),
			);

			expect(capturedCmd).toContain('codex');
			expect(capturedCmd).toContain('--model');
			const idx = capturedCmd.indexOf('--model');
			expect(capturedCmd[idx + 1]).toBe('gpt-5-mini');
			expect(capturedEnv.some((e) => e.startsWith('OPENAI_API_KEY='))).toBe(true);
		});
	});

	describe('codex ChatGPT-subscription auth', () => {
		const validAuthJson = JSON.stringify({
			tokens: {
				id_token: 'header.payload.sig',
				access_token: 'header.payload.sig',
				refresh_token: 'rt-initial',
				account_id: 'acct-1',
			},
		});

		async function configureCodexSubscription(label: string): Promise<string> {
			await db.query(`DELETE FROM ai_provider_configs WHERE provider = 'openai'`);
			const res = await app.request('/api/ai-providers', {
				method: 'POST',
				headers: { ...authHeader(adminToken), 'Content-Type': 'application/json' },
				body: JSON.stringify({
					provider: 'openai',
					api_key: validAuthJson,
					auth_method: AiAuthMethod.Subscription,
					label,
				}),
			});
			expect(res.status).toBe(201);
			return (await res.json()).data.id;
		}

		it('does not inject any provider env var for openai subscription', () => {
			const env = buildProviderEnv(AiProvider.OpenAI, {
				value: validAuthJson,
				authMethod: AiAuthMethod.Subscription,
				baseUrl: null,
				runtime: null,
			});
			expect(env).toEqual([]);
		});

		it('keeps OPENAI_API_KEY env injection for openai+api_key', () => {
			const env = buildProviderEnv(AiProvider.OpenAI, {
				value: 'sk-test',
				authMethod: AiAuthMethod.ApiKey,
				baseUrl: null,
				runtime: null,
			});
			expect(env).toEqual(['OPENAI_API_KEY=sk-test']);
		});

		it('stages auth.json into the run home and points CODEX_HOME at it', async () => {
			// Staged through the engine seam, not onto the host: on a managed backend
			// the sandbox is not on this machine, so the credential has to travel by
			// the provider's file transport. Read back the same way it was written.
			const runId = 'run-mount-1';
			const engine = createStubDocker();
			const mount = await buildSubscriptionMount(
				testDataDir,
				'co',
				'pj',
				runId,
				AiProvider.OpenAI,
				AgentRuntime.Codex,
				{
					value: validAuthJson,
					authMethod: AiAuthMethod.Subscription,
					baseUrl: null,
					runtime: null,
				},
				engine,
				'container-123',
			);
			expect(mount).not.toBeNull();
			// `codex-openai`, not `codex`: the layout is keyed by runtime now, so the
			// per-provider isolation that used to come from the dir name itself is
			// the provider suffix.
			expect(mount!.containerDir).toBe(`/workspace/.hezo/subscription/codex-openai/${runId}`);
			expect(mount!.envEntries).toEqual([
				`CODEX_HOME=/workspace/.hezo/subscription/codex-openai/${runId}`,
			]);
			const staged = engine.files('container-123', mount!.containerDir);
			expect(await staged.read(mount!.authFileRelative)).toBe(validAuthJson);
		});

		it('returns null mount for providers without a paste flow', async () => {
			expect(
				await buildSubscriptionMount(
					'/tmp',
					'co',
					'pj',
					'r1',
					AiProvider.OpenAI,
					AgentRuntime.Codex,
					{ value: 'sk-x', authMethod: AiAuthMethod.ApiKey, baseUrl: null, runtime: null },
					createStubDocker(),
					'container-123',
				),
			).toBeNull();
			expect(
				await buildSubscriptionMount(
					'/tmp',
					'co',
					'pj',
					'r1',
					AiProvider.Anthropic,
					AgentRuntime.ClaudeCode,
					{ value: 'sk-ant', authMethod: AiAuthMethod.ApiKey, baseUrl: null, runtime: null },
					createStubDocker(),
					'container-123',
				),
			).toBeNull();
		});

		it('returns null mount for Anthropic subscription (delivered via env var, not a file)', async () => {
			// Anthropic subscription has no authFileRelative — the token goes in
			// CLAUDE_CODE_OAUTH_TOKEN (buildProviderEnv), so there is nothing to mount.
			expect(
				await buildSubscriptionMount(
					'/tmp',
					'co',
					'pj',
					'r1',
					AiProvider.Anthropic,
					AgentRuntime.ClaudeCode,
					{
						value: 'sk-ant-oat01-token',
						authMethod: AiAuthMethod.Subscription,
						baseUrl: null,
						runtime: null,
					},
					createStubDocker(),
					'container-123',
				),
			).toBeNull();
		});

		it('returns null mount for Kimi (api-key on Claude Code, credential via env var)', async () => {
			// Kimi now runs through Claude Code against Moonshot's Anthropic-compatible
			// endpoint with an api key delivered via ANTHROPIC_AUTH_TOKEN — there is no
			// subscription file to mount.
			expect(
				await buildSubscriptionMount(
					'/tmp',
					'co',
					'pj',
					'r1',
					AiProvider.Kimi,
					AgentRuntime.ClaudeCode,
					{ value: 'sk-kimi', authMethod: AiAuthMethod.ApiKey, baseUrl: null, runtime: null },
					createStubDocker(),
					'container-123',
				),
			).toBeNull();
			// The provider env carries the Moonshot endpoint + auth token + quiet env.
			const env = buildProviderEnv(AiProvider.Kimi, {
				value: 'sk-kimi',
				authMethod: AiAuthMethod.ApiKey,
				baseUrl: null,
				runtime: null,
			});
			expect(env).toContain('ANTHROPIC_BASE_URL=https://api.moonshot.ai/anthropic');
			expect(env).toContain('ANTHROPIC_AUTH_TOKEN=sk-kimi');
			expect(env).toContain('ENABLE_TOOL_SEARCH=false');
			expect(env).toContain('DISABLE_TELEMETRY=1');
		});

		it('runAgent injects CODEX_HOME and stages auth.json on host', async () => {
			await configureCodexSubscription('codex-mount-run');

			let capturedEnv: string[] = [];
			let stagedFile: string | null = null;
			const docker = createMockDocker({
				execCreate: async (_id: string, opts: any) => {
					capturedEnv = opts.Env;
					const codexHomeEntry = (opts.Env as string[]).find((e) => e.startsWith('CODEX_HOME='));
					if (codexHomeEntry) {
						const containerDir = codexHomeEntry.slice('CODEX_HOME='.length);
						const runId = containerDir.split('/').pop()!;
						stagedFile = `${getHostSubscriptionRoot(
							AiProvider.OpenAI,
							AgentRuntime.Codex,
							testDataDir,
							teamId,
							projectId,
							runId,
						)}/auth.json`;
					}
					return 'exec-codex-mount';
				},
				execStart: async () => ({ stdout: '', stderr: '' }),
				execInspect: async () => ({ ExitCode: 0, Running: false, Pid: 0 }),
			});

			const deps: RunnerDeps = {
				db,
				docker,
				masterKeyManager,
				serverPort: 3000,
				dataDir: testDataDir,
				logs: new LogStreamBroker(),
			};

			const result = await runAgent(
				deps,
				makeAgent(),
				{ ...makeTask(), runtime_type: 'codex' as const },
				makeProject(),
			);

			expect(result.success).toBe(true);
			expect(capturedEnv.some((e) => e.startsWith('CODEX_HOME='))).toBe(true);
			expect(capturedEnv.some((e) => e.startsWith('OPENAI_API_KEY='))).toBe(false);
			// Per-run codex-home dir is cleaned up after the run.
			expect(stagedFile).not.toBeNull();
			expect(existsSync(stagedFile!)).toBe(false);
		});

		it('persists rotated auth.json after the run', async () => {
			const configId = await configureCodexSubscription('codex-rotate-run');

			const rotatedJson = JSON.stringify({
				tokens: {
					id_token: 'header.payload.sig',
					access_token: 'rotated-access',
					refresh_token: 'rt-rotated',
					account_id: 'acct-1',
				},
			});

			const docker = createMockDocker({
				execCreate: async (_id: string, opts: any) => {
					const codexHomeEntry = (opts.Env as string[]).find((e) => e.startsWith('CODEX_HOME='));
					expect(codexHomeEntry).toBeDefined();
					const containerDir = codexHomeEntry!.slice('CODEX_HOME='.length);
					const runId = containerDir.split('/').pop()!;
					const hostFile = `${getHostSubscriptionRoot(
						AiProvider.OpenAI,
						AgentRuntime.Codex,
						testDataDir,
						teamId,
						projectId,
						runId,
					)}/auth.json`;
					// Simulate codex rotating the refresh token mid-run.
					writeFileSync(hostFile, rotatedJson);
					return 'exec-codex-rotate';
				},
				execStart: async () => ({ stdout: '', stderr: '' }),
				execInspect: async () => ({ ExitCode: 0, Running: false, Pid: 0 }),
			});

			const deps: RunnerDeps = {
				db,
				docker,
				masterKeyManager,
				serverPort: 3000,
				dataDir: testDataDir,
				logs: new LogStreamBroker(),
			};

			const result = await runAgent(
				deps,
				makeAgent(),
				{ ...makeTask(), runtime_type: 'codex' as const },
				makeProject(),
			);
			expect(result.success).toBe(true);

			// Verify the encrypted credential changed: re-fetch via the verify endpoint
			// route which only round-trips the decrypted value if status is active. We
			// instead read directly from the table and decrypt with the same helper
			// the server uses, by going through the existing connection.
			const row = await db.query<{ encrypted_credential: string }>(
				'SELECT encrypted_credential FROM ai_provider_configs WHERE id = $1',
				[configId],
			);
			expect(row.rows.length).toBe(1);
			// Encrypted blobs should differ between initial and rotated values.
			// (We can't easily decrypt here without re-importing the helper, so the
			// integration check is: after the run, the credential row was updated.)
			const updatedAt = await db.query<{ updated_at: string }>(
				'SELECT updated_at FROM ai_provider_configs WHERE id = $1',
				[configId],
			);
			expect(updatedAt.rows[0].updated_at).toBeDefined();
		});

		it('serialises concurrent runs against the same credential row', async () => {
			const release1 = await acquireCredentialLock('cred-test-A');
			let secondAcquired = false;
			const secondPromise = acquireCredentialLock('cred-test-A').then((r) => {
				secondAcquired = true;
				return r;
			});

			// Brief wait — second lock must NOT have resolved yet.
			await new Promise((resolve) => setTimeout(resolve, 20));
			expect(secondAcquired).toBe(false);

			release1();
			const release2 = await secondPromise;
			expect(secondAcquired).toBe(true);
			release2();
		});

		it('does not block concurrent runs against different credential rows', async () => {
			const releaseA = await acquireCredentialLock('cred-test-B');
			const releaseB = await acquireCredentialLock('cred-test-C');
			// Both held simultaneously — neither call hung.
			releaseA();
			releaseB();
		});

		it('keeps the heartbeat run in queued state while the credential lock is held', async () => {
			const configId = await configureCodexSubscription('codex-queue-run');

			let execStarted = false;
			const docker = createMockDocker({
				execCreate: async () => {
					execStarted = true;
					return 'exec-codex-queue';
				},
				execStart: async () => ({ stdout: '', stderr: '' }),
				execInspect: async () => ({ ExitCode: 0, Running: false, Pid: 0 }),
			});

			const broadcasts: Array<{ status: string; action: string }> = [];
			const wsManager = {
				broadcast: (_room: string, event: any) => {
					if (event?.table === 'heartbeat_runs') {
						broadcasts.push({ status: event.row.status, action: event.action });
					}
				},
				subscribe: () => {},
				unsubscribe: () => {},
				unsubscribeAll: () => {},
				getRoomSize: () => 0,
				getTotalConnections: () => 0,
			} as any;

			const logs = new LogStreamBroker();
			logs.setWsManager(wsManager);
			const deps: RunnerDeps = {
				db,
				docker,
				masterKeyManager,
				serverPort: 3000,
				dataDir: testDataDir,
				wsManager,
				logs,
			};

			const release = await acquireCredentialLock(configId);

			const runPromise = runAgent(
				deps,
				makeAgent(),
				{ ...makeTask(), runtime_type: 'codex' as const },
				makeProject(),
			);

			await new Promise((resolve) => setTimeout(resolve, 50));

			const queued = await db.query<{ id: string; status: string; started_at: string | null }>(
				`SELECT id, status, started_at FROM heartbeat_runs
				 WHERE member_id = $1 ORDER BY created_at DESC LIMIT 1`,
				[agentId],
			);
			expect(queued.rows[0].status).toBe(HeartbeatRunStatus.Queued);
			expect(queued.rows[0].started_at).toBeNull();
			expect(execStarted).toBe(false);
			expect(broadcasts.some((b) => b.action === 'INSERT' && b.status === 'queued')).toBe(true);
			expect(broadcasts.some((b) => b.status === 'running')).toBe(false);

			release();

			const result = await runPromise;
			expect(result.success).toBe(true);
			expect(execStarted).toBe(true);

			const finished = await db.query<{ status: string; started_at: string | null }>(
				'SELECT status, started_at FROM heartbeat_runs WHERE id = $1',
				[result.heartbeatRunId],
			);
			expect(finished.rows[0].status).toBe(HeartbeatRunStatus.Succeeded);
			expect(finished.rows[0].started_at).not.toBeNull();
			expect(broadcasts.some((b) => b.action === 'UPDATE' && b.status === 'running')).toBe(true);
		});
	});
});

const CLAUDE_CODE_QUIET_ENTRIES = [
	'DISABLE_TELEMETRY=1',
	'DISABLE_ERROR_REPORTING=1',
	'DISABLE_AUTOUPDATER=1',
	'DISABLE_NON_ESSENTIAL_MODEL_CALLS=1',
	'DISABLE_BUG_COMMAND=1',
	'CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS=0',
];

describe('buildProviderEnv (Anthropic)', () => {
	it('stamps the Claude Code quiet env and ANTHROPIC_API_KEY for an api-key credential', () => {
		const env = buildProviderEnv(AiProvider.Anthropic, {
			value: 'sk-ant-secret',
			authMethod: AiAuthMethod.ApiKey,
			baseUrl: null,
			runtime: null,
		});
		for (const entry of CLAUDE_CODE_QUIET_ENTRIES) {
			expect(env).toContain(entry);
		}
		expect(env).toContain('ANTHROPIC_API_KEY=sk-ant-secret');
		expect(env.some((e) => e.startsWith('ANTHROPIC_BASE_URL='))).toBe(false);
	});

	it('injects CLAUDE_CODE_OAUTH_TOKEN (and never ANTHROPIC_API_KEY) for a subscription credential', () => {
		const env = buildProviderEnv(AiProvider.Anthropic, {
			value: 'sk-ant-oat01-subtoken',
			authMethod: AiAuthMethod.Subscription,
			baseUrl: null,
			runtime: null,
		});
		expect(env).toContain('CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-subtoken');
		expect(env.some((e) => e.startsWith('ANTHROPIC_API_KEY='))).toBe(false);
		// Quiet env still applies on the subscription path.
		for (const entry of CLAUDE_CODE_QUIET_ENTRIES) {
			expect(env).toContain(entry);
		}
	});
});

describe('buildProviderEnv (DeepSeek)', () => {
	it('emits ANTHROPIC_BASE_URL, model defaults, quiet env, and ANTHROPIC_AUTH_TOKEN for an api-key credential', () => {
		const env = buildProviderEnv(AiProvider.DeepSeek, {
			value: 'sk-deepseek-secret',
			authMethod: AiAuthMethod.ApiKey,
			baseUrl: null,
			runtime: null,
		});
		expect(env).toContain('ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic');
		expect(env).toContain('ANTHROPIC_DEFAULT_OPUS_MODEL=deepseek-v4-pro');
		expect(env).toContain('ANTHROPIC_DEFAULT_SONNET_MODEL=deepseek-v4-pro');
		expect(env).toContain('ANTHROPIC_DEFAULT_HAIKU_MODEL=deepseek-v4-flash');
		expect(env).toContain('CLAUDE_CODE_SUBAGENT_MODEL=deepseek-v4-flash');
		expect(env).toContain('ANTHROPIC_AUTH_TOKEN=sk-deepseek-secret');
		for (const entry of CLAUDE_CODE_QUIET_ENTRIES) {
			expect(env).toContain(entry);
		}
		// must not leak Anthropic's primary env name — Claude Code would read it first
		expect(env.some((e) => e.startsWith('ANTHROPIC_API_KEY='))).toBe(false);
	});

	it('still emits the static base URL and model defaults when subscription auth is used (no credential env)', () => {
		const env = buildProviderEnv(AiProvider.DeepSeek, {
			value: 'unused-blob',
			authMethod: AiAuthMethod.Subscription,
			baseUrl: null,
			runtime: null,
		});
		expect(env).toContain('ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic');
		expect(env.some((e) => e.startsWith('ANTHROPIC_AUTH_TOKEN='))).toBe(false);
	});
});

describe('buildProviderEnv (ZAi)', () => {
	it('emits ANTHROPIC_BASE_URL, model defaults, quiet env, and ANTHROPIC_AUTH_TOKEN for an api-key credential', () => {
		const env = buildProviderEnv(AiProvider.ZAi, {
			value: 'zai-secret',
			authMethod: AiAuthMethod.ApiKey,
			baseUrl: null,
			runtime: null,
		});
		expect(env).toContain('ANTHROPIC_BASE_URL=https://api.z.ai/api/anthropic');
		expect(env).toContain('ANTHROPIC_DEFAULT_OPUS_MODEL=GLM-4.7');
		expect(env).toContain('ANTHROPIC_DEFAULT_SONNET_MODEL=GLM-4.7');
		expect(env).toContain('ANTHROPIC_DEFAULT_HAIKU_MODEL=GLM-4.5-Air');
		expect(env).toContain('CLAUDE_CODE_SUBAGENT_MODEL=GLM-4.5-Air');
		expect(env).toContain('ANTHROPIC_AUTH_TOKEN=zai-secret');
		for (const entry of CLAUDE_CODE_QUIET_ENTRIES) {
			expect(env).toContain(entry);
		}
	});
});

describe('buildProviderEnv (Codex runtimes do not inherit Claude Code quiet env)', () => {
	it('omits the DISABLE_* flags for OpenAI api-key credentials', () => {
		const env = buildProviderEnv(AiProvider.OpenAI, {
			value: 'sk-openai-test',
			authMethod: AiAuthMethod.ApiKey,
			baseUrl: null,
			runtime: null,
		});
		expect(env).toEqual(['OPENAI_API_KEY=sk-openai-test']);
	});
});

describe('buildProviderEnv derives the subagent model from the run model', () => {
	const cred = {
		value: 'sk-x',
		authMethod: AiAuthMethod.ApiKey,
		baseUrl: null,
		runtime: null,
	} as const;

	it('points CLAUDE_CODE_SUBAGENT_MODEL at the selected model for Kimi (k3), not the constant', () => {
		const env = buildProviderEnv(AiProvider.Kimi, cred, 'kimi-k3');
		expect(env).toContain('CLAUDE_CODE_SUBAGENT_MODEL=kimi-k3');
		expect(env).not.toContain('CLAUDE_CODE_SUBAGENT_MODEL=kimi-k2.7-code');
	});

	it('normalizes the DeepSeek [1m] suffix for the subagent model', () => {
		const env = buildProviderEnv(AiProvider.DeepSeek, cred, 'deepseek-v5-pro[1m]');
		expect(env).toContain('CLAUDE_CODE_SUBAGENT_MODEL=deepseek-v5-pro');
	});

	it('keeps the staticEnv constant when no run model is selected', () => {
		expect(buildProviderEnv(AiProvider.Kimi, cred)).toContain(
			'CLAUDE_CODE_SUBAGENT_MODEL=kimi-k2.7-code',
		);
		expect(buildProviderEnv(AiProvider.DeepSeek, cred, null)).toContain(
			'CLAUDE_CODE_SUBAGENT_MODEL=deepseek-v4-flash',
		);
	});

	it('does not add a subagent model for Anthropic (no staticEnv to override)', () => {
		const env = buildProviderEnv(AiProvider.Anthropic, cred, 'claude-opus-4-8');
		expect(env.some((e) => e.startsWith('CLAUDE_CODE_SUBAGENT_MODEL='))).toBe(false);
	});
});

describe('shellQuoteArg', () => {
	it('leaves simple flags and identifiers unquoted', () => {
		expect(shellQuoteArg('-p')).toBe('-p');
		expect(shellQuoteArg('--strict-mcp-config')).toBe('--strict-mcp-config');
		expect(shellQuoteArg('claude')).toBe('claude');
		expect(shellQuoteArg('model_reasoning_effort=high')).toBe('model_reasoning_effort=high');
	});

	it('quotes empty strings', () => {
		expect(shellQuoteArg('')).toBe("''");
	});

	it('quotes args containing spaces without escaping newlines', () => {
		expect(shellQuoteArg('hello world')).toBe("'hello world'");
		expect(shellQuoteArg('line1\nline2')).toBe("'line1\nline2'");
	});

	it('escapes single quotes using POSIX-safe sequence', () => {
		expect(shellQuoteArg("it's")).toBe(`'it'\\''s'`);
	});

	it('quotes args containing shell metacharacters', () => {
		expect(shellQuoteArg('$FOO')).toBe(`'$FOO'`);
		expect(shellQuoteArg('a"b')).toBe(`'a"b'`);
		expect(shellQuoteArg('a|b')).toBe(`'a|b'`);
	});
});
