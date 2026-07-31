// Lifecycle-focused coverage for agent-runner.ts's runAgent orchestration:
// the full success bookkeeping (usage, cost, broadcasts, domain events, the
// backlog→in_progress flip), model override resolution, subscription
// credential locking + rotated-auth write-back, timeout/abort terminal
// statuses, and the egress/ssh setup+teardown. All docker interaction goes
// through createStubDocker + withRunUserStub — no container, git, or network.

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import {
	AiAuthMethod,
	AiProvider,
	ContainerStatus,
	HeartbeatRunStatus,
	TaskStatus,
	WakeupSource,
} from '@hezo/shared';
import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { decrypt } from '../src/crypto/encryption';
import type { MasterKeyManager } from '../src/crypto/master-key';
import type { Db } from '../src/db/database';
import { runLogTextSql } from '../src/db/run-log-chunks';
import { DomainEventBus } from '../src/events/bus';
import type { Env } from '../src/lib/types';
import {
	getHostPromptPath,
	getHostSubscriptionRoot,
	type RunnerDeps,
	recordRunCostAndEnforce,
	runAgent,
} from '../src/services/agent-runner';
import {
	ContainerConnectivityStatus,
	type ProbeResult,
} from '../src/services/container-connectivity-status';
import { ensureProjectContainerRunning } from '../src/services/containers';
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
let agentSlug: string | null;

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
	const teamRes = await createTestTeam(db, { name: 'Lifecycle Co', template_id: typeId });
	teamId = (await teamRes.json()).data.id;

	globalThis.fetch = vi.fn().mockResolvedValue({ ok: true }) as unknown as typeof fetch;
	await app.request('/api/ai-providers', {
		method: 'POST',
		headers: { ...authHeader(adminToken), 'Content-Type': 'application/json' },
		body: JSON.stringify({
			provider: 'anthropic',
			api_key: 'sk-ant-lifecycle-key',
			label: 'anthropic-lifecycle',
		}),
	});
	globalThis.fetch = originalFetch;

	const projectRes = await createTestProject(db, teamId, {
		name: 'Lifecycle Project',
		description: 'Lifecycle test project.',
	});
	const projectData = (await projectRes.json()).data;
	projectId = projectData.id;
	projectSlug = projectData.slug;

	const agentsRes = await app.request(`/api/projects/${projectSlug}/agents`, {
		headers: authHeader(adminToken),
	});
	const agentRow = (await agentsRes.json()).data[0];
	agentId = agentRow.id;
	agentSlug = agentRow.slug ?? null;

	const taskRes = await app.request(`/api/projects/${projectSlug}/tasks`, {
		method: 'POST',
		headers: { ...authHeader(adminToken), 'Content-Type': 'application/json' },
		body: JSON.stringify({
			project_id: projectId,
			title: 'Lifecycle Task',
			description: 'Lifecycle description',
			assignee_id: agentId,
		}),
	});
	taskId = (await taskRes.json()).data.id;
});

afterAll(async () => {
	await safeClose(db);
});

function makeAgent(overrides: Record<string, unknown> = {}) {
	return { id: agentId, title: 'Lifecycle Agent', slug: agentSlug, team_id: teamId, ...overrides };
}

function makeTask(overrides: Record<string, unknown> = {}) {
	return {
		id: taskId,
		identifier: 'LC-1',
		title: 'Lifecycle Task',
		description: 'Lifecycle description',
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
		team_slug: 'lifecycle-co',
		container_id: 'container-lc',
		container_status: ContainerStatus.Running,
		designated_repo_id: null,
		is_internal: false,
		...overrides,
	};
}

// Docker stub whose agent exec flips produced_output mid-run (the same write
// the MCP tool layer does) so exit-0 runs read as genuine successes.
function makeDocker(overrides: Record<string, any> = {}): ContainerEngine {
	const { execStart: execStartOverride, producesOutput = true, ...rest } = overrides;
	const innerExecStart = execStartOverride ?? (async () => ({ stdout: 'done', stderr: '' }));
	const base = createStubDocker({
		execCreate: async () => 'exec-lc',
		execInspect: async () => ({ ExitCode: 0, Running: false, Pid: 0 }),
		...rest,
		execStart: async (...args: unknown[]) => {
			if (producesOutput) {
				await db.query(
					`UPDATE heartbeat_runs SET produced_output = true WHERE member_id = $1 AND status = 'running'`,
					[agentId],
				);
			}
			return (innerExecStart as (...a: unknown[]) => unknown)(...args);
		},
	});
	return withRunUserStub(base as unknown as ContainerEngine);
}

function recordingWs() {
	const broadcasts: Array<{ room: string; event: any }> = [];
	const wsManager = {
		broadcast: (room: string, event: any) => broadcasts.push({ room, event }),
		subscribe: () => {},
		unsubscribe: () => {},
		unsubscribeAll: () => {},
		getRoomSize: () => 0,
		getTotalConnections: () => 0,
	} as any;
	return { broadcasts, wsManager };
}

function baseDeps(docker: ContainerEngine, extra: Partial<RunnerDeps> = {}): RunnerDeps {
	return {
		db,
		docker,
		masterKeyManager,
		serverPort: 3000,
		dataDir,
		logs: new LogStreamBroker(),
		...extra,
	};
}

describe('runAgent lifecycle — full success bookkeeping', () => {
	it('records usage+cost, flips a backlog task in_progress, broadcasts, and emits domain events', async () => {
		const pricing = new PricingService(db);
		await upsertManualRate(db, {
			model_id: 'claude-opus-4-7',
			input_per_token: 0.0001,
			output_per_token: 0.0002,
		});
		await pricing.reload();
		await db.query(
			`UPDATE ai_provider_configs SET default_model = 'claude-opus-4-7' WHERE provider = 'anthropic'`,
		);
		await db.query('DELETE FROM cost_entries WHERE member_id = $1', [agentId]);

		// A fresh backlog task assigned to the agent so the run flips its status.
		const taskRes = await app.request(`/api/projects/${projectSlug}/tasks`, {
			method: 'POST',
			headers: { ...authHeader(adminToken), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				project_id: projectId,
				title: 'Flip Me',
				description: 'flip',
				assignee_id: agentId,
			}),
		});
		const flipTask = (await taskRes.json()).data;

		const initEvent = JSON.stringify({
			type: 'system',
			subtype: 'init',
			model: 'claude-opus-4-7',
			tools: [],
		});
		const resultEvent = JSON.stringify({
			type: 'result',
			subtype: 'success',
			num_turns: 1,
			is_error: false,
			usage: { input_tokens: 1000, output_tokens: 500 },
		});
		let capturedCmd: string[] = [];
		const docker = makeDocker({
			execCreate: async (_id: string, opts: any) => {
				capturedCmd = opts.Cmd;
				return 'exec-full';
			},
			execStart: async (_id: string, opts: any) => {
				if (opts?.onChunk) {
					await opts.onChunk({ stream: 'stdout', text: `${initEvent}\n` });
					await opts.onChunk({ stream: 'stdout', text: `${resultEvent}\n` });
				}
				return { stdout: '', stderr: '' };
			},
		});

		const { broadcasts, wsManager } = recordingWs();
		const events = new DomainEventBus();
		const captured: Array<Record<string, unknown>> = [];
		events.subscribe((e) => captured.push(e as unknown as Record<string, unknown>));
		const logs = new LogStreamBroker();
		logs.setWsManager(wsManager);
		const deps = baseDeps(docker, { pricing, wsManager, events, logs });

		const result = await runAgent(
			deps,
			makeAgent(),
			{
				...makeTask({
					id: flipTask.id,
					identifier: flipTask.identifier,
					title: 'Flip Me',
					assignee_id: agentId,
					status: TaskStatus.Backlog,
				}),
			},
			makeProject(),
		);

		expect(result.success).toBe(true);
		expect(result.exitCode).toBe(0);

		const run = await db.query<{
			status: string;
			exit_code: number;
			input_tokens: number | null;
			output_tokens: number | null;
			cost_cents: number | null;
			usage_partial: boolean;
			started_at: string | null;
			finished_at: string | null;
			invocation_command: string | null;
			working_dir: string | null;
			provider: string | null;
			ai_provider_config_id: string | null;
			kind: string;
		}>(
			`SELECT status, exit_code, input_tokens, output_tokens, cost_cents, usage_partial,
			        started_at::text, finished_at::text, invocation_command, working_dir,
			        provider::text, ai_provider_config_id, kind::text
			 FROM heartbeat_runs WHERE id = $1`,
			[result.heartbeatRunId],
		);
		const row = run.rows[0];
		expect(row.status).toBe(HeartbeatRunStatus.Succeeded);
		expect(row.exit_code).toBe(0);
		expect(row.input_tokens).toBe(1000);
		expect(row.output_tokens).toBe(500);
		expect(row.cost_cents).toBe(20);
		expect(row.usage_partial).toBe(false);
		expect(row.started_at).not.toBeNull();
		expect(row.finished_at).not.toBeNull();
		expect(row.working_dir).toBe('/workspace'); // no repos linked
		expect(row.provider).toBe('anthropic');
		expect(row.ai_provider_config_id).not.toBeNull();
		expect(row.kind).toBe('task');
		expect(row.invocation_command).toMatch(/^\$ claude/);
		expect(row.invocation_command).not.toMatch(/Bearer eyJ/);

		// Default model from the credential became the --model arg.
		const modelIdx = capturedCmd.indexOf('--model');
		expect(modelIdx).toBeGreaterThan(-1);
		expect(capturedCmd[modelIdx + 1]).toBe('claude-opus-4-7');

		// The assigned backlog task was flipped in_progress and the flip recorded.
		const taskRow = await db.query<{ status: string }>(
			'SELECT status::text AS status FROM tasks WHERE id = $1',
			[flipTask.id],
		);
		expect(taskRow.rows[0].status).toBe(TaskStatus.InProgress);

		// Run comment anchored on the task.
		const runComment = await db.query<{ content: Record<string, unknown> }>(
			`SELECT content FROM task_comments WHERE task_id = $1 AND content_type = 'run'`,
			[flipTask.id],
		);
		expect(runComment.rows.length).toBe(1);
		expect(runComment.rows[0].content.run_id).toBe(result.heartbeatRunId);

		// Cost entry recorded (1000*0.0001 + 500*0.0002 = 20 cents) and broadcast.
		const entry = await db.query<{ amount_cents: number }>(
			'SELECT amount_cents FROM cost_entries WHERE member_id = $1 ORDER BY created_at DESC LIMIT 1',
			[agentId],
		);
		expect(entry.rows[0].amount_cents).toBe(20);
		expect(
			broadcasts.some((b) => b.event?.table === 'cost_entries' && b.event?.action === 'INSERT'),
		).toBe(true);

		// heartbeat_runs INSERT (queued) + UPDATE broadcasts, and the task-status flip broadcast.
		const hbEvents = broadcasts.filter((b) => b.event?.table === 'heartbeat_runs');
		expect(hbEvents.some((b) => b.event.action === 'INSERT')).toBe(true);
		expect(hbEvents.some((b) => b.event.action === 'UPDATE')).toBe(true);
		expect(
			broadcasts.some(
				(b) =>
					b.event?.table === 'tasks' &&
					b.event?.action === 'UPDATE' &&
					b.event?.row?.status === TaskStatus.InProgress,
			),
		).toBe(true);

		// Domain events fired; the synthetic on-demand wakeup enriched the started event.
		const started = captured.find((c) => c.type === 'agent_run.started');
		const completed = captured.find((c) => c.type === 'agent_run.completed');
		expect(started).toBeDefined();
		expect(started!.runId).toBe(result.heartbeatRunId);
		expect(started!.triggerSource).toBe(WakeupSource.OnDemand);
		expect(completed).toBeDefined();
		expect(completed!.status).toBe(HeartbeatRunStatus.Succeeded);

		await db.query(
			`UPDATE ai_provider_configs SET default_model = NULL WHERE provider = 'anthropic'`,
		);
		await db.query('DELETE FROM cost_entries WHERE member_id = $1', [agentId]);
	});

	it("resolves the agent's model override provider+model into the CLI --model arg", async () => {
		let capturedCmd: string[] = [];
		const docker = makeDocker({
			execCreate: async (_id: string, opts: any) => {
				capturedCmd = opts.Cmd;
				return 'exec-override';
			},
		});
		const result = await runAgent(
			baseDeps(docker),
			makeAgent({
				model_override_provider: AiProvider.Anthropic,
				model_override_model: 'claude-sonnet-4-6',
			}),
			makeTask(),
			makeProject(),
		);
		expect(result.success).toBe(true);
		const modelIdx = capturedCmd.indexOf('--model');
		expect(modelIdx).toBeGreaterThan(-1);
		expect(capturedCmd[modelIdx + 1]).toBe('claude-sonnet-4-6');
	});

	it('fails fast when the model override references a provider with no adapter', async () => {
		const docker = makeDocker({
			execCreate: async () => {
				throw new Error('must not exec');
			},
		});
		const result = await runAgent(
			baseDeps(docker),
			makeAgent({ model_override_provider: 'dead-provider' as AiProvider }),
			makeTask(),
			makeProject(),
		);
		expect(result.success).toBe(false);
		expect(result.stderr).toContain('no longer supported');
		const run = await db.query<{ status: string; error: string | null }>(
			'SELECT status, error FROM heartbeat_runs WHERE id = $1',
			[result.heartbeatRunId],
		);
		expect(run.rows[0].status).toBe(HeartbeatRunStatus.Failed);
		expect(run.rows[0].error).toContain('dead-provider');
	});

	it('fails with a targeted message when the override provider has no credential', async () => {
		const docker = makeDocker();
		const result = await runAgent(
			baseDeps(docker),
			makeAgent({ model_override_provider: AiProvider.DeepSeek }),
			makeTask(),
			makeProject(),
		);
		expect(result.success).toBe(false);
		expect(result.stderr).toContain('No deepseek credential configured');
	});

	it('lazy-starts a stopped container and the run proceeds', async () => {
		// Runs never assume a running container: a stopped one is started in
		// place before the exec, and the start is stamped on the project row.
		await db.query(
			`UPDATE projects SET container_status = $1::container_status, container_id = $2,
			     container_error = NULL, container_last_started_at = NULL WHERE id = $3`,
			[ContainerStatus.Stopped, 'lazy-lc', projectId],
		);
		const startCalls: string[] = [];
		let started = false;
		const docker = makeDocker({
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
		const result = await runAgent(
			baseDeps(docker),
			makeAgent(),
			makeTask(),
			makeProject({ container_id: 'lazy-lc', container_status: ContainerStatus.Stopped }),
		);
		expect(result.success).toBe(true);
		expect(startCalls).toEqual(['lazy-lc']);

		const proj = await db.query<{
			container_status: string;
			container_last_started_at: string | null;
		}>('SELECT container_status, container_last_started_at FROM projects WHERE id = $1', [
			projectId,
		]);
		expect(proj.rows[0].container_status).toBe(ContainerStatus.Running);
		expect(proj.rows[0].container_last_started_at).not.toBeNull();
	});

	it('concurrent ensures serialize on the lifecycle lock — exactly one container is provisioned', async () => {
		await db.query(
			`UPDATE projects SET container_status = NULL, container_id = NULL,
			     container_error = NULL WHERE id = $1`,
			[projectId],
		);
		let createCalls = 0;
		const docker = makeDocker({
			inspectContainer: async (id: string) => ({
				Id: id,
				State: { Status: 'running', Running: true, Pid: 1, ExitCode: 0 },
				Config: { Image: 'test' },
			}),
			createContainer: async () => {
				createCalls++;
				return { Id: `once-lc-${createCalls}`, Warnings: [] };
			},
		});
		const containerDeps = { db, docker, dataDir };
		const [a, b] = await Promise.all([
			ensureProjectContainerRunning(containerDeps, projectId),
			ensureProjectContainerRunning(containerDeps, projectId),
		]);
		// The second ensure waited on the lock, re-read the row the first wrote,
		// found the container running, and reused it.
		expect(createCalls).toBe(1);
		expect(a).toBe('once-lc-1');
		expect(b).toBe('once-lc-1');
	});

	it('re-provisions a cached-running container that vanished from Docker and the run proceeds', async () => {
		await db.query(
			`UPDATE projects SET container_status = $1::container_status, container_id = $2,
			     container_error = NULL WHERE id = $3`,
			[ContainerStatus.Running, 'gone-lc', projectId],
		);
		const created: string[] = [];
		const docker = makeDocker({
			inspectContainer: async () => null,
			createContainer: async () => {
				created.push('reborn-lc');
				return { Id: 'reborn-lc', Warnings: [] };
			},
		});
		const result = await runAgent(
			baseDeps(docker),
			makeAgent(),
			makeTask(),
			makeProject({ container_id: 'gone-lc' }),
		);
		// The stale row is repaired by provisioning a fresh container — the run
		// rides it instead of failing.
		expect(result.success).toBe(true);
		expect(created).toEqual(['reborn-lc']);

		const proj = await db.query<{ container_status: string; container_id: string | null }>(
			'SELECT container_status, container_id FROM projects WHERE id = $1',
			[projectId],
		);
		expect(proj.rows[0].container_status).toBe(ContainerStatus.Running);
		expect(proj.rows[0].container_id).toBe('reborn-lc');
	});

	it('stamps triggered_by actor details on the run comment and skips the prompt directive at minimal effort', async () => {
		let capturedPrompt = '';
		const docker = makeDocker({
			execCreate: async (_id: string, opts: any) => {
				const entry = (opts.Env as string[]).find((e) => e.startsWith('HEZO_PROMPT_FILE='))!;
				const runId = entry
					.split('/')
					.pop()!
					.replace(/\.txt$/, '');
				capturedPrompt = readFileSync(getHostPromptPath(dataDir, teamId, projectId, runId), 'utf8');
				return 'exec-trig';
			},
		});
		const result = await runAgent(baseDeps(docker), makeAgent(), makeTask(), makeProject(), {
			triggered_by: { member_id: agentId, name: 'Casey Admin' },
			effort: 'minimal',
		});
		expect(result.success).toBe(true);
		const comment = await db.query<{ content: Record<string, unknown> }>(
			`SELECT content FROM task_comments WHERE content->>'run_id' = $1`,
			[result.heartbeatRunId],
		);
		expect(comment.rows.length).toBe(1);
		expect(comment.rows[0].content.actor_name).toBe('Casey Admin');
		expect(comment.rows[0].content.actor_id).toBe(agentId);

		// Minimal effort maps to an empty prompt directive → the prompt ends with
		// the base task instructions, not a thinking directive.
		expect(
			capturedPrompt.trim().endsWith('Post comments via the Agent API to report progress.'),
		).toBe(true);
	});

	it('serves a replace-snapshot to a late log subscriber mid-run', async () => {
		const snapshots: any[] = [];
		const logs = new LogStreamBroker();
		let deps: RunnerDeps;
		const docker = makeDocker({
			execStart: async (_id: string, opts: any) => {
				await opts.onChunk?.({ stream: 'stdout', text: 'streamed line\n' });
				// A viewer opening the runs page mid-run replays the buffered log.
				deps.logs.replay(`project-runs:${projectId}`, (payload) => snapshots.push(payload));
				return { stdout: '', stderr: '' };
			},
		});
		deps = baseDeps(docker, { logs });
		const result = await runAgent(deps, makeAgent(), makeTask(), makeProject());
		expect(result.success).toBe(true);
		expect(snapshots.length).toBe(1);
		expect(snapshots[0].replace).toBe(true);
		expect(snapshots[0].runId).toBe(result.heartbeatRunId);
		expect(snapshots[0].text).toContain('$ claude');
	});

	it('still succeeds when a run-artifact cleanup step fails (asserted error path)', async () => {
		const docker = makeDocker();
		const deps = baseDeps(docker, {
			sshAgentServer: {
				allocateRunSocket: async (_runId: string, _ident: unknown, hostPath: string) => ({
					socketHostPath: hostPath,
					tcpHostPort: 41002,
					tokenHex: 'c'.repeat(32),
				}),
				// Cleanup steps are isolated: a throwing release logs and continues.
				releaseRunSocket: async () => {
					throw new Error('socket release wedged');
				},
			} as any,
		});
		const result = await runAgent(deps, makeAgent(), makeTask(), makeProject());
		expect(result.success).toBe(true);
		const run = await db.query<{ status: string }>(
			'SELECT status FROM heartbeat_runs WHERE id = $1',
			[result.heartbeatRunId],
		);
		expect(run.rows[0].status).toBe(HeartbeatRunStatus.Succeeded);
	});

	it('emits agent_run.started even when the wakeup enrichment lookup fails', async () => {
		const events = new DomainEventBus();
		const captured: Array<Record<string, unknown>> = [];
		events.subscribe((e) => captured.push(e as unknown as Record<string, unknown>));
		// Poison only the enrichment SELECT; every other query passes through.
		const poisonedDb = new Proxy(db, {
			get(target, prop, receiver) {
				if (prop === 'query') {
					return (sql: string, params?: unknown[]) => {
						if (sql.includes('FROM agent_wakeup_requests WHERE id')) {
							return Promise.reject(new Error('enrichment unavailable'));
						}
						return target.query(sql as any, params as any);
					};
				}
				return Reflect.get(target, prop, receiver);
			},
		}) as Db;
		const result = await runAgent(
			baseDeps(makeDocker(), { db: poisonedDb, events }),
			makeAgent(),
			makeTask(),
			makeProject(),
		);
		expect(result.success).toBe(true);
		const started = captured.find((c) => c.type === 'agent_run.started');
		expect(started).toBeDefined();
		expect(started!.triggerSource).toBeNull();
	});

	it('qualifies the model and delivers the prompt as a trailing arg for the OpenCode runtime', async () => {
		globalThis.fetch = vi.fn().mockResolvedValue({ ok: true }) as unknown as typeof fetch;
		await app.request('/api/ai-providers', {
			method: 'POST',
			headers: { ...authHeader(adminToken), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				provider: 'openrouter',
				api_key: 'sk-or-test',
				label: 'openrouter-lc',
			}),
		});
		globalThis.fetch = originalFetch;
		await db.query(
			`UPDATE ai_provider_configs SET default_model = 'anthropic/claude-sonnet-4.5' WHERE provider = 'openrouter'`,
		);
		let capturedCmd: string[] = [];
		const docker = makeDocker({
			execCreate: async (_id: string, opts: any) => {
				capturedCmd = opts.Cmd;
				return 'exec-oc';
			},
		});
		try {
			const result = await runAgent(
				baseDeps(docker),
				makeAgent(),
				{ ...makeTask(), runtime_type: 'opencode' as const },
				makeProject(),
			);
			expect(result.success).toBe(true);

			const modelIdx = capturedCmd.indexOf('--model');
			expect(modelIdx).toBeGreaterThan(-1);
			expect(capturedCmd[modelIdx + 1]).toBe('openrouter/anthropic/claude-sonnet-4.5');

			// OpenCode takes the prompt as a trailing arg, not stdin.
			const row = await db.query<{ invocation_command: string | null }>(
				'SELECT invocation_command FROM heartbeat_runs WHERE id = $1',
				[result.heartbeatRunId],
			);
			expect(row.rows[0].invocation_command).toContain('"$(cat ');
			expect(row.rows[0].invocation_command).not.toContain(' < /workspace');
		} finally {
			await db.query(`DELETE FROM ai_provider_configs WHERE provider = 'openrouter'`);
		}
	});

	it('pauses the agent when the run pushes it over its daily budget', async () => {
		const pricing = new PricingService(db);
		await upsertManualRate(db, {
			model_id: 'claude-opus-4-7',
			input_per_token: 0.0001,
			output_per_token: 0.0002,
		});
		await pricing.reload();
		await db.query(
			`UPDATE ai_provider_configs SET default_model = 'claude-opus-4-7' WHERE provider = 'anthropic'`,
		);
		await db.query('DELETE FROM cost_entries WHERE member_id = $1', [agentId]);
		await db.query(
			`UPDATE member_agents SET daily_budget_cents = 1, weekly_budget_cents = 0, monthly_budget_cents = 0, runtime_status = 'idle'::agent_runtime_status WHERE id = $1`,
			[agentId],
		);
		const initEvent = JSON.stringify({
			type: 'system',
			subtype: 'init',
			model: 'claude-opus-4-7',
			tools: [],
		});
		const resultEvent = JSON.stringify({
			type: 'result',
			subtype: 'success',
			num_turns: 1,
			is_error: false,
			usage: { input_tokens: 1000, output_tokens: 500 },
		});
		const docker = makeDocker({
			execStart: async (_id: string, opts: any) => {
				await opts.onChunk?.({ stream: 'stdout', text: `${initEvent}\n` });
				await opts.onChunk?.({ stream: 'stdout', text: `${resultEvent}\n` });
				return { stdout: '', stderr: '' };
			},
		});
		try {
			const result = await runAgent(
				baseDeps(docker, { pricing }),
				makeAgent(),
				makeTask(),
				makeProject(),
			);
			expect(result.success).toBe(true);
			const agentRow = await db.query<{ runtime_status: string }>(
				'SELECT runtime_status FROM member_agents WHERE id = $1',
				[agentId],
			);
			expect(agentRow.rows[0].runtime_status).not.toBe('idle');
		} finally {
			await db.query(
				`UPDATE member_agents SET daily_budget_cents = 0, runtime_status = 'idle'::agent_runtime_status WHERE id = $1`,
				[agentId],
			);
			await db.query(
				`UPDATE ai_provider_configs SET default_model = NULL WHERE provider = 'anthropic'`,
			);
			await db.query('DELETE FROM cost_entries WHERE member_id = $1', [agentId]);
		}
	});

	it('fails with the instance-level message when no provider credentials exist at all', async () => {
		// Snapshot + clear every provider config, then restore afterwards.
		await db.query(`CREATE TEMP TABLE cfg_backup AS SELECT * FROM ai_provider_configs`);
		await db.query('DELETE FROM ai_provider_configs');
		try {
			const result = await runAgent(baseDeps(makeDocker()), makeAgent(), makeTask(), makeProject());
			expect(result.success).toBe(false);
			expect(result.stderr).toContain('No AI provider credentials configured');
		} finally {
			await db.query(`INSERT INTO ai_provider_configs SELECT * FROM cfg_backup`);
			await db.query('DROP TABLE cfg_backup');
		}
	});
});

describe('runAgent lifecycle — aborts and timeout', () => {
	it('returns the bare aborted result when the signal is aborted before any bookkeeping', async () => {
		const ac = new AbortController();
		ac.abort();
		const result = await runAgent(
			baseDeps(makeDocker()),
			makeAgent(),
			makeTask(),
			makeProject(),
			undefined,
			ac.signal,
		);
		expect(result.success).toBe(false);
		expect(result.stderr).toBe('Aborted');
		expect(result.heartbeatRunId).toBeUndefined();
	});

	it('marks the run timed_out with the friendly error when aborted with run_timeout mid-exec', async () => {
		const ac = new AbortController();
		const docker = makeDocker({
			producesOutput: false,
			execStart: async () => {
				ac.abort('run_timeout');
				throw new DOMException('Aborted', 'AbortError');
			},
		});
		const result = await runAgent(
			baseDeps(docker),
			makeAgent(),
			makeTask(),
			makeProject(),
			undefined,
			ac.signal,
		);
		expect(result.success).toBe(false);
		expect(result.timedOut).toBe(true);
		expect(result.stderr).toBe('run reached its time limit');
		const run = await db.query<{ status: string; error: string | null }>(
			'SELECT status, error FROM heartbeat_runs WHERE id = $1',
			[result.heartbeatRunId],
		);
		expect(run.rows[0].status).toBe(HeartbeatRunStatus.TimedOut);
		expect(run.rows[0].error).toBe('run reached its time limit');
	});

	it('finalizes a cancelled run when the abort lands between run creation and credential lock', async () => {
		const ac = new AbortController();
		let execCreated = false;
		const docker = makeDocker({
			// syncContainerStatus's inspect is the last await before the post-credential
			// abort checkpoint; aborting here exercises that early finalizeAbort.
			inspectContainer: async () => {
				ac.abort();
				return {
					Id: 'container-lc',
					State: { Status: 'running', Running: true, Pid: 1, ExitCode: 0 },
					Config: { Image: 'test' },
				};
			},
			execCreate: async () => {
				execCreated = true;
				return 'exec-nope';
			},
		});
		const result = await runAgent(
			baseDeps(docker),
			makeAgent(),
			makeTask(),
			makeProject(),
			undefined,
			ac.signal,
		);
		expect(result.success).toBe(false);
		expect(execCreated).toBe(false);
		const run = await db.query<{ status: string }>(
			'SELECT status FROM heartbeat_runs WHERE id = $1',
			[result.heartbeatRunId],
		);
		expect(run.rows[0].status).toBe(HeartbeatRunStatus.Cancelled);
	});

	it('cleans up run artifacts and finalizes an abort landed during egress allocation', async () => {
		const ac = new AbortController();
		const released: string[] = [];
		const docker = makeDocker({
			execCreate: async () => {
				throw new Error('must not exec after abort');
			},
		});
		const deps = baseDeps(docker, {
			egressProxy: {
				allocateRunProxy: async () => {
					ac.abort('container_stopped');
					return { proxyHost: '127.0.0.1', proxyPort: 9 };
				},
				releaseRunProxy: async (runId: string) => {
					released.push(runId);
				},
			} as any,
			egressCAPath: `${dataDir}/egress-ca.crt`,
		});
		const result = await runAgent(
			deps,
			makeAgent(),
			makeTask(),
			makeProject(),
			undefined,
			ac.signal,
		);
		expect(result.success).toBe(false);
		expect(result.stderr).toBe('container_stopped');
		expect(released).toContain(result.heartbeatRunId);
		const run = await db.query<{ status: string; error: string | null }>(
			'SELECT status, error FROM heartbeat_runs WHERE id = $1',
			[result.heartbeatRunId],
		);
		expect(run.rows[0].status).toBe(HeartbeatRunStatus.Failed);
		expect(run.rows[0].error).toBe('container_stopped');
	});

	it('persists partial usage captured before an exec transport failure', async () => {
		const pricing = new PricingService(db);
		await upsertManualRate(db, {
			model_id: 'claude-opus-4-7',
			input_per_token: 0.0001,
			output_per_token: 0.0002,
		});
		await pricing.reload();
		await db.query(
			`UPDATE ai_provider_configs SET default_model = 'claude-opus-4-7' WHERE provider = 'anthropic'`,
		);
		const initEvent = JSON.stringify({
			type: 'system',
			subtype: 'init',
			model: 'claude-opus-4-7',
			tools: [],
		});
		const resultEvent = JSON.stringify({
			type: 'result',
			subtype: 'success',
			num_turns: 1,
			is_error: false,
			usage: { input_tokens: 400, output_tokens: 100 },
		});
		const docker = makeDocker({
			producesOutput: false,
			execStart: async (_id: string, opts: any) => {
				await opts.onChunk?.({ stream: 'stdout', text: `${initEvent}\n` });
				await opts.onChunk?.({ stream: 'stdout', text: `${resultEvent}\n` });
				throw new Error('exec transport died');
			},
		});
		const result = await runAgent(
			baseDeps(docker, { pricing }),
			makeAgent(),
			makeTask(),
			makeProject(),
		);
		expect(result.success).toBe(false);
		expect(result.stderr).toBe('exec transport died');
		const run = await db.query<{
			status: string;
			error: string | null;
			input_tokens: number | null;
			output_tokens: number | null;
			usage_partial: boolean;
		}>(
			'SELECT status, error, input_tokens, output_tokens, usage_partial FROM heartbeat_runs WHERE id = $1',
			[result.heartbeatRunId],
		);
		expect(run.rows[0].status).toBe(HeartbeatRunStatus.Failed);
		expect(run.rows[0].error).toBe('exec transport died');
		expect(run.rows[0].input_tokens).toBe(400);
		expect(run.rows[0].output_tokens).toBe(100);
		await db.query(
			`UPDATE ai_provider_configs SET default_model = NULL WHERE provider = 'anthropic'`,
		);
		await db.query('DELETE FROM cost_entries WHERE member_id = $1', [agentId]);
	});
});

describe('runAgent lifecycle — subscription credential lock + rotation', () => {
	it('records the queued_reason while waiting on the rotating credential and persists a valid rotated auth blob', async () => {
		const originalAuthJson = JSON.stringify({
			tokens: {
				id_token: 'header.payload.sig',
				access_token: 'header.payload.sig',
				refresh_token: 'rt-original-lc',
				account_id: 'acct-lc',
			},
		});
		const rotatedAuthJson = JSON.stringify({
			tokens: {
				id_token: 'header.payload.sig2',
				access_token: 'header.payload.sig2',
				refresh_token: 'rt-rotated-lc',
				account_id: 'acct-lc',
			},
		});
		await db.query(`DELETE FROM ai_provider_configs WHERE provider = 'openai'`);
		await app.request('/api/ai-providers', {
			method: 'POST',
			headers: { ...authHeader(adminToken), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				provider: 'openai',
				api_key: originalAuthJson,
				auth_method: AiAuthMethod.Subscription,
				label: 'openai-rotate-lc',
			}),
		});
		const configId = (
			await db.query<{ id: string }>(
				`SELECT id FROM ai_provider_configs WHERE provider = 'openai' LIMIT 1`,
			)
		).rows[0].id;

		const docker = makeDocker({
			execCreate: async (_id: string, opts: any) => {
				const codexHomeEntry = (opts.Env as string[]).find((e: string) =>
					e.startsWith('CODEX_HOME='),
				)!;
				const runId = codexHomeEntry.slice('CODEX_HOME='.length).split('/').pop()!;
				const hostFile = `${getHostSubscriptionRoot(
					AiProvider.OpenAI,
					dataDir,
					teamId,
					projectId,
					runId,
				)}/auth.json`;
				// The CLI rotated the credential mid-run.
				writeFileSync(hostFile, rotatedAuthJson);
				return 'exec-rotate';
			},
		});

		const result = await runAgent(
			baseDeps(docker),
			makeAgent(),
			{ ...makeTask(), runtime_type: 'codex' as const },
			makeProject(),
		);
		expect(result.success).toBe(true);

		// The lock wait was recorded on the queued row.
		const run = await db.query<{ queued_reason: string | null }>(
			'SELECT queued_reason FROM heartbeat_runs WHERE id = $1',
			[result.heartbeatRunId],
		);
		expect(run.rows[0].queued_reason).toBe('waiting for prior run on this credential');

		// The rotated credential (valid blob) was written back encrypted.
		const cfg = await db.query<{ encrypted_credential: string }>(
			'SELECT encrypted_credential FROM ai_provider_configs WHERE id = $1',
			[configId],
		);
		expect(decrypt(cfg.rows[0].encrypted_credential, masterKeyManager.getKey())).toBe(
			rotatedAuthJson,
		);

		await db.query(`DELETE FROM ai_provider_configs WHERE id = $1`, [configId]);
	});

	it('skips write-back of an invalid rotated blob and survives an unreadable auth file', async () => {
		const originalAuthJson = JSON.stringify({
			tokens: {
				id_token: 'header.payload.sig',
				access_token: 'header.payload.sig',
				refresh_token: 'rt-keep-lc',
				account_id: 'acct-keep',
			},
		});
		await db.query(`DELETE FROM ai_provider_configs WHERE provider = 'openai'`);
		await app.request('/api/ai-providers', {
			method: 'POST',
			headers: { ...authHeader(adminToken), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				provider: 'openai',
				api_key: originalAuthJson,
				auth_method: AiAuthMethod.Subscription,
				label: 'openai-tomb-lc',
			}),
		});
		const configId = (
			await db.query<{ id: string }>(
				`SELECT id FROM ai_provider_configs WHERE provider = 'openai' LIMIT 1`,
			)
		).rows[0].id;

		const authFileOf = (env: string[]) => {
			const codexHomeEntry = env.find((e) => e.startsWith('CODEX_HOME='))!;
			const runId = codexHomeEntry.slice('CODEX_HOME='.length).split('/').pop()!;
			return `${getHostSubscriptionRoot(AiProvider.OpenAI, dataDir, teamId, projectId, runId)}/auth.json`;
		};

		// Run 1: the CLI leaves an empty-token tombstone → must not be persisted.
		const tombstoneDocker = makeDocker({
			execCreate: async (_id: string, opts: any) => {
				writeFileSync(
					authFileOf(opts.Env),
					JSON.stringify({ tokens: { access_token: '', refresh_token: '', account_id: '' } }),
				);
				return 'exec-tomb';
			},
		});
		const r1 = await runAgent(
			baseDeps(tombstoneDocker),
			makeAgent(),
			{ ...makeTask(), runtime_type: 'codex' as const },
			makeProject(),
		);
		expect(r1.success).toBe(true);
		// (The skip breadcrumb is emitted after the log stream has ended, so the
		// durable assertion is the credential row staying untouched — below.)

		// Run 2: the auth path is unreadable as a file (a directory) → the
		// write-back catch swallows it and the run still completes.
		const unreadableDocker = makeDocker({
			execCreate: async (_id: string, opts: any) => {
				const file = authFileOf(opts.Env);
				rmSync(file, { force: true });
				mkdirSync(file, { recursive: true });
				return 'exec-eisdir';
			},
		});
		const r2 = await runAgent(
			baseDeps(unreadableDocker),
			makeAgent(),
			{ ...makeTask(), runtime_type: 'codex' as const },
			makeProject(),
		);
		expect(r2.success).toBe(true);

		// In both cases the stored credential is untouched.
		const cfg = await db.query<{ encrypted_credential: string }>(
			'SELECT encrypted_credential FROM ai_provider_configs WHERE id = $1',
			[configId],
		);
		expect(decrypt(cfg.rows[0].encrypted_credential, masterKeyManager.getKey())).toBe(
			originalAuthJson,
		);
		await db.query(`DELETE FROM ai_provider_configs WHERE id = $1`, [configId]);
	});
});

describe('runAgent lifecycle — egress + ssh wiring', () => {
	it('injects proxy/CA/ssh env, wraps the exec with the bridge, and releases both resources', async () => {
		const egressCalls = { allocated: [] as string[], released: [] as string[] };
		const sshCalls = { allocated: [] as string[], released: [] as string[] };
		let capturedEnv: string[] = [];
		let capturedExecCmd: string[] = [];
		const docker = makeDocker({
			execCreate: async (_id: string, opts: any) => {
				capturedEnv = opts.Env;
				capturedExecCmd = opts.Cmd;
				return 'exec-egress';
			},
		});
		const deps = baseDeps(docker, {
			egressProxy: {
				allocateRunProxy: async (runId: string) => {
					egressCalls.allocated.push(runId);
					return { proxyHost: '172.17.0.1', proxyPort: 18080 };
				},
				releaseRunProxy: async (runId: string) => {
					egressCalls.released.push(runId);
				},
			} as any,
			egressCAPath: `${dataDir}/egress-ca.crt`,
			sshAgentServer: {
				allocateRunSocket: async (runId: string, _ident: unknown, hostPath: string) => {
					sshCalls.allocated.push(runId);
					return { socketHostPath: hostPath, tcpHostPort: 41000, tokenHex: 'a'.repeat(32) };
				},
				releaseRunSocket: async (runId: string) => {
					sshCalls.released.push(runId);
				},
			} as any,
		});

		const result = await runAgent(deps, makeAgent(), makeTask(), makeProject());
		expect(result.success).toBe(true);

		expect(capturedEnv).toContain('HTTP_PROXY=http://172.17.0.1:18080');
		expect(capturedEnv).toContain('HTTPS_PROXY=http://172.17.0.1:18080');
		expect(capturedEnv.some((e) => e.startsWith('NO_PROXY=') && e.includes('172.17.0.1'))).toBe(
			true,
		);
		expect(capturedEnv).toContain(
			'NODE_EXTRA_CA_CERTS=/usr/local/share/ca-certificates/hezo-egress.crt',
		);
		expect(capturedEnv).toContain(
			'CURL_CA_BUNDLE=/usr/local/share/ca-certificates/hezo-egress.crt',
		);
		expect(capturedEnv).toContain(
			'GIT_SSL_CAINFO=/usr/local/share/ca-certificates/hezo-egress.crt',
		);
		expect(capturedEnv.some((e) => e.startsWith('SSH_AUTH_SOCK=/run/hezo/'))).toBe(true);
		// Bridge wrapper (not the bare sh prompt-delivery wrapper) leads the exec argv.
		expect(capturedExecCmd[0]).not.toBe('claude');
		expect(capturedExecCmd.join(' ')).toContain('claude');

		expect(egressCalls.allocated).toContain(result.heartbeatRunId);
		expect(egressCalls.released).toContain(result.heartbeatRunId);
		expect(sshCalls.allocated).toContain(result.heartbeatRunId);
		expect(sshCalls.released).toContain(result.heartbeatRunId);
	});

	it('aborts before allocating egress and releases the ssh socket when the proxy is unreachable', async () => {
		const egressCalls = { allocated: [] as string[] };
		const sshCalls = { released: [] as string[] };
		const status = new ContainerConnectivityStatus('127.0.0.1');
		status.set('bind-loopback', '127.0.0.1');
		const probe = async (): Promise<ProbeResult> => ({
			status: 'bind-loopback',
			bindHost: '127.0.0.1',
		});
		const docker = makeDocker({
			execCreate: async () => {
				throw new Error('must not exec');
			},
		});
		const deps = baseDeps(docker, {
			egressProxy: {
				allocateRunProxy: async (runId: string) => {
					egressCalls.allocated.push(runId);
					return { proxyHost: '127.0.0.1', proxyPort: 18080 };
				},
				releaseRunProxy: async () => {},
			} as any,
			egressCAPath: `${dataDir}/egress-ca.crt`,
			sshAgentServer: {
				allocateRunSocket: async (_runId: string, _ident: unknown, hostPath: string) => ({
					socketHostPath: hostPath,
					tcpHostPort: 41001,
					tokenHex: 'b'.repeat(32),
				}),
				releaseRunSocket: async (runId: string) => {
					sshCalls.released.push(runId);
				},
			} as any,
			connectivityStatus: status,
			connectivityProbe: probe,
		});

		const result = await runAgent(deps, makeAgent(), makeTask(), makeProject());
		expect(result.success).toBe(false);
		expect(result.stderr).toContain('Egress proxy unreachable from agent containers');
		expect(egressCalls.allocated).not.toContain(result.heartbeatRunId);
		expect(sshCalls.released).toContain(result.heartbeatRunId);
		const run = await db.query<{ status: string }>(
			'SELECT status FROM heartbeat_runs WHERE id = $1',
			[result.heartbeatRunId],
		);
		expect(run.rows[0].status).toBe(HeartbeatRunStatus.Failed);
	});
});

describe('recordRunCostAndEnforce', () => {
	it('returns without writing when the run carried no usage or zero cost', async () => {
		const before = await db.query<{ c: number }>(
			'SELECT COUNT(*)::int AS c FROM cost_entries WHERE member_id = $1',
			[agentId],
		);
		await recordRunCostAndEnforce(db, 'ignored-run-id', null, {
			teamId,
			taskId: null,
			memberId: agentId,
		});
		await recordRunCostAndEnforce(
			db,
			'ignored-run-id',
			{ inputTokens: 10, outputTokens: 10, costCents: 0 },
			{ teamId, taskId: null, memberId: agentId },
		);
		const after = await db.query<{ c: number }>(
			'SELECT COUNT(*)::int AS c FROM cost_entries WHERE member_id = $1',
			[agentId],
		);
		expect(after.rows[0].c).toBe(before.rows[0].c);
	});

	it('swallows a storage failure instead of failing the completed run (asserted error path)', async () => {
		const throwingDb = {
			query: async () => {
				throw new Error('db exploded');
			},
		} as unknown as Db;
		// Must resolve — a cost bookkeeping failure never turns a completed run
		// into a failed one. (This intentionally logs one [error] line.)
		await expect(
			recordRunCostAndEnforce(
				throwingDb,
				'run-x',
				{ inputTokens: 1, outputTokens: 1, costCents: 5 },
				{ teamId, taskId: null, memberId: agentId },
			),
		).resolves.toBeUndefined();
	});
});
