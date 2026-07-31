import { readFileSync, writeFileSync } from 'node:fs';
import {
	AiAuthMethod,
	AiProvider,
	ContainerStatus,
	HeartbeatRunStatus,
	WakeupSource,
} from '@hezo/shared';
import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { decrypt } from '../src/crypto/encryption';
import type { MasterKeyManager } from '../src/crypto/master-key';
import type { Db } from '../src/db/database';
import { DomainEventBus } from '../src/events/bus';
import type { Env } from '../src/lib/types';
import {
	buildTaskPrompt,
	getHostPromptPath,
	getHostSubscriptionRoot,
	loadMentionContext,
	loadReplyContext,
	loadSpawnedFromTask,
	type RunnerDeps,
	runAgent,
} from '../src/services/agent-runner';
import { NETWORKING_DOCS_URL } from '../src/services/container-connectivity-preflight';
import {
	type ConnectivityStatus,
	ContainerConnectivityStatus,
	type ProbeResult,
} from '../src/services/container-connectivity-status';
import { LogStreamBroker } from '../src/services/log-stream-broker';
import { PricingService, upsertManualRate } from '../src/services/pricing';
import type { ContainerEngine } from '../src/services/sandbox/types';
import { safeClose } from './helpers';
import { authHeader, createTestApp, createTestProject, createTestTeam } from './helpers/app';

// Read the prompt the run wrote to its host prompt file, located from the
// HEZO_PROMPT_FILE env var captured off the exec opts.
function readPromptFromExec(
	opts: { Env: string[] },
	dataDir: string,
	project: { team_id: string; id: string },
): string {
	const entry = opts.Env.find((e) => e.startsWith('HEZO_PROMPT_FILE='));
	if (!entry) throw new Error('HEZO_PROMPT_FILE env var missing from exec');
	const runId = entry
		.slice('HEZO_PROMPT_FILE='.length)
		.split('/')
		.pop()!
		.replace(/\.txt$/, '');
	return readFileSync(getHostPromptPath(dataDir, project.team_id, project.id, runId), 'utf8');
}

// Same exec-driven side effect the sibling agent-runner.test.ts uses: flip a
// run's produced_output (or reported_no_work) mid-exec so an exit-0 mock reads
// as a genuine success/no-op rather than tripping the "no output" failure path.
function createMockDocker(taskId: string, overrides: Record<string, any> = {}): ContainerEngine {
	const {
		execStart: execStartOverride,
		producesOutput = true,
		reportsNoWork = false,
		noWorkReason = 'nothing to do this run',
		...rest
	} = overrides;
	const innerExecStart = execStartOverride ?? (async () => ({ stdout: 'done', stderr: '' }));
	return {
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
			return (innerExecStart as (...a: unknown[]) => unknown)(...args);
		},
	} as unknown as ContainerEngine;
}

let app: Hono<Env>;
let db: Db;
let adminToken: string;
let masterKeyManager: MasterKeyManager;
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

	const typesRes = await app.request('/api/team-templates', { headers: authHeader(adminToken) });
	const typeId = (await typesRes.json()).data.find((t: any) => t.name === 'App Team').id;

	const teamRes = await createTestTeam(db, { name: 'Ext Co', template_id: typeId });
	teamId = (await teamRes.json()).data.id;

	globalThis.fetch = vi.fn().mockResolvedValue({ ok: true }) as unknown as typeof fetch;
	await app.request('/api/ai-providers', {
		method: 'POST',
		headers: { ...authHeader(adminToken), 'Content-Type': 'application/json' },
		body: JSON.stringify({
			provider: 'anthropic',
			api_key: 'sk-ant-ext-key',
			label: 'anthropic-ext',
		}),
	});
	globalThis.fetch = originalFetch;

	const projectRes = await createTestProject(db, teamId, {
		name: 'Ext Project',
		description: 'Extended test project.',
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
			title: 'Ext Task',
			description: 'Ext description',
			assignee_id: agentId,
		}),
	});
	taskId = (await taskRes.json()).data.id;
});

afterAll(async () => {
	await safeClose(db);
});

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
	return { id: agentId, title: 'Test Agent', slug: agentSlug, team_id: teamId };
}

function makeTask(overrides: Record<string, unknown> = {}) {
	return {
		id: taskId,
		identifier: 'EX-1',
		title: 'Ext Task',
		description: 'Ext description',
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
		team_slug: 'ext-co',
		container_id: 'container-123',
		container_status: ContainerStatus.Running,
		designated_repo_id: null,
		is_internal: false,
		...overrides,
	};
}

function baseDeps(docker: ContainerEngine, extra: Partial<RunnerDeps> = {}): RunnerDeps {
	return {
		db,
		docker,
		masterKeyManager,
		serverPort: 3000,
		dataDir: '/tmp/test-data',
		logs: new LogStreamBroker(),
		...extra,
	};
}

/** Minimal in-process fake of the egress proxy used by runAgent. */
function fakeEgressProxy() {
	const calls = { allocated: [] as string[], released: [] as string[] };
	return {
		calls,
		proxy: {
			allocateRunProxy: async (runId: string, _ctx: unknown) => {
				calls.allocated.push(runId);
				return { proxyHost: '127.0.0.1', proxyPort: 18080, token: 'testtoken0123456789abcdef' };
			},
			releaseRunProxy: async (runId: string) => {
				calls.released.push(runId);
			},
		} as any,
	};
}

/** Minimal in-process fake of the SSH agent server used by runAgent. */
function fakeSshAgentServer() {
	const calls = { allocated: [] as string[], released: [] as string[] };
	return {
		calls,
		server: {
			allocateRunSocket: async (runId: string, _ident: unknown, hostPath: string) => {
				calls.allocated.push(runId);
				return {
					socketHostPath: hostPath,
					tcpHostPort: 41000,
					tokenHex: 'a'.repeat(32),
				};
			},
			releaseRunSocket: async (runId: string) => {
				calls.released.push(runId);
			},
		} as any,
	};
}

describe('runAgent — egress proxy + ssh agent env injection', () => {
	it('injects proxy/CA/SSH env vars and allocates+releases both run-scoped resources', async () => {
		let capturedEnv: string[] = [];
		const docker = createMockDocker(taskId, {
			execCreate: async (_id: string, opts: any) => {
				capturedEnv = opts.Env;
				return 'exec-egress';
			},
			execStart: async () => ({ stdout: 'ok', stderr: '' }),
			execInspect: async () => ({ ExitCode: 0, Running: false, Pid: 0 }),
		});

		const egress = fakeEgressProxy();
		const ssh = fakeSshAgentServer();
		const deps = baseDeps(docker, {
			egressProxy: egress.proxy,
			egressCAPath: '/tmp/test-data/egress-ca.crt',
			sshAgentServer: ssh.server,
		});

		const result = await runAgent(deps, makeAgent(), makeTask(), makeProject());
		expect(result.success).toBe(true);

		// Egress proxy env: both upper- and lower-case proxy vars, NO_PROXY, and the
		// three CA-bundle pointers the in-container tooling reads. The per-run token
		// rides the URL userinfo so the client sends it as Proxy-Authorization.
		const proxyUrl = 'http://run:testtoken0123456789abcdef@127.0.0.1:18080';
		expect(capturedEnv).toContain(`HTTP_PROXY=${proxyUrl}`);
		expect(capturedEnv).toContain(`http_proxy=${proxyUrl}`);
		expect(capturedEnv).toContain(`HTTPS_PROXY=${proxyUrl}`);
		expect(capturedEnv).toContain(`https_proxy=${proxyUrl}`);
		// Node ≥24 safety net so spawned Node processes without their own dispatcher
		// route through the proxy (connector auth is a placeholder that MUST traverse it).
		expect(capturedEnv).toContain('NODE_USE_ENV_PROXY=1');
		// NO_PROXY excludes the proxy host itself + loopback + the host origin that
		// serves the Hezo MCP endpoint and signed asset URLs (host.docker.internal —
		// real-JWT / signed, no secret to substitute), plus the provider's direct
		// upstream hosts.
		expect(
			capturedEnv.some(
				(e) =>
					e.startsWith('NO_PROXY=') &&
					e.includes('127.0.0.1') &&
					e.includes('localhost') &&
					e.includes('host.docker.internal'),
			),
		).toBe(true);
		expect(
			capturedEnv.some((e) => e.startsWith('no_proxy=') && e.includes('host.docker.internal')),
		).toBe(true);
		expect(
			capturedEnv.some(
				(e) => e === 'NODE_EXTRA_CA_CERTS=/usr/local/share/ca-certificates/hezo-egress.crt',
			),
		).toBe(true);
		expect(
			capturedEnv.some(
				(e) => e === 'CURL_CA_BUNDLE=/usr/local/share/ca-certificates/hezo-egress.crt',
			),
		).toBe(true);
		expect(
			capturedEnv.some(
				(e) => e === 'GIT_SSL_CAINFO=/usr/local/share/ca-certificates/hezo-egress.crt',
			),
		).toBe(true);

		// SSH socket env points at the per-run bridge socket.
		expect(
			capturedEnv.some((e) => e === `SSH_AUTH_SOCK=/run/hezo/${result.heartbeatRunId}.sock`),
		).toBe(true);

		// Both resources allocated then released for this run.
		expect(egress.calls.allocated).toContain(result.heartbeatRunId);
		expect(egress.calls.released).toContain(result.heartbeatRunId);
		expect(ssh.calls.allocated).toContain(result.heartbeatRunId);
		expect(ssh.calls.released).toContain(result.heartbeatRunId);
	});

	it('wraps the exec command with the ssh bridge runner argv when an agent server is present', async () => {
		let capturedExecCmd: string[] = [];
		const docker = createMockDocker(taskId, {
			execCreate: async (_id: string, opts: any) => {
				capturedExecCmd = opts.Cmd;
				return 'exec-bridge';
			},
			execStart: async () => ({ stdout: 'ok', stderr: '' }),
			execInspect: async () => ({ ExitCode: 0, Running: false, Pid: 0 }),
		});

		const ssh = fakeSshAgentServer();
		const deps = baseDeps(docker, { sshAgentServer: ssh.server });

		const result = await runAgent(deps, makeAgent(), makeTask(), makeProject());
		expect(result.success).toBe(true);

		// With a bridge, the wrapper is the bridge-runner binary, not the bare
		// `sh -c PROMPT_DELIVERY_SH` form (which is asserted in the sibling file).
		expect(capturedExecCmd[0]).not.toBe('sh');
		// The bridge runner forwards the per-run socket path as one of its argv.
		expect(capturedExecCmd).toContain(`/run/hezo/${result.heartbeatRunId}.sock`);
		expect(ssh.calls.released).toContain(result.heartbeatRunId);
	});
});

describe('runAgent — egress connectivity gate', () => {
	// A status holder preset to `s` (fresh). `unknown` is left unset.
	function presetStatus(s: ConnectivityStatus): ContainerConnectivityStatus {
		const status = new ContainerConnectivityStatus('127.0.0.1');
		if (s !== 'unknown') status.set(s, '127.0.0.1');
		return status;
	}

	// A fake run-time probe (stands in for the auto-rebind closure from startup).
	function fakeProbe(result: ProbeResult) {
		const calls = { count: 0 };
		return {
			calls,
			fn: async () => {
				calls.count++;
				return result;
			},
		};
	}

	const okDocker = () =>
		createMockDocker(taskId, {
			execCreate: async () => 'exec-gate',
			execStart: async () => ({ stdout: 'ok', stderr: '' }),
			execInspect: async () => ({ ExitCode: 0, Running: false, Pid: 0 }),
		});

	it('self-heals a stale/race-poisoned bind-loopback cache by re-probing the live bind host', async () => {
		// The production bug: connectivityStatus stuck at bind-loopback@127.0.0.1 while
		// the proxy is actually bound+reachable at the gateway. A bad cache must re-probe,
		// and the auto-rebind probe reports ok@172.17.0.1 → the run proceeds.
		const egress = fakeEgressProxy();
		const ssh = fakeSshAgentServer();
		const probe = fakeProbe({ status: 'ok', bindHost: '172.17.0.1' });
		const deps = baseDeps(okDocker(), {
			egressProxy: egress.proxy,
			egressCAPath: '/tmp/test-data/egress-ca.crt',
			sshAgentServer: ssh.server,
			connectivityStatus: presetStatus('bind-loopback'),
			connectivityProbe: probe.fn,
		});

		const result = await runAgent(deps, makeAgent(), makeTask(), makeProject());

		expect(result.success).toBe(true);
		expect(probe.calls.count).toBe(1); // bad cache forced a re-probe
		expect(egress.calls.allocated).toContain(result.heartbeatRunId);
	});

	it.each([
		'bind-loopback',
		'bind-firewalled',
		'mcp-unreachable',
	] as const)('aborts (without allocating egress) when the proxy is genuinely unreachable: %s', async (bad) => {
		const egress = fakeEgressProxy();
		const ssh = fakeSshAgentServer();
		const probe = fakeProbe({ status: bad, bindHost: '127.0.0.1' });
		const deps = baseDeps(okDocker(), {
			egressProxy: egress.proxy,
			egressCAPath: '/tmp/test-data/egress-ca.crt',
			sshAgentServer: ssh.server,
			connectivityStatus: presetStatus(bad),
			connectivityProbe: probe.fn,
		});

		const result = await runAgent(deps, makeAgent(), makeTask(), makeProject());

		expect(result.success).toBe(false);
		// The operator-actionable guidance (with the docs pointer) is surfaced.
		expect(result.stderr).toContain(NETWORKING_DOCS_URL);
		// Egress was never allocated; the ssh socket allocated above was released.
		expect(egress.calls.allocated).not.toContain(result.heartbeatRunId);
		expect(ssh.calls.released).toContain(result.heartbeatRunId);
	});

	it('short-circuits a fresh good cache without re-probing', async () => {
		const egress = fakeEgressProxy();
		const ssh = fakeSshAgentServer();
		const status = new ContainerConnectivityStatus('172.17.0.1');
		status.set('ok', '172.17.0.1'); // fresh ok
		const probe = fakeProbe({ status: 'mcp-unreachable', bindHost: '127.0.0.1' }); // would abort if called
		const deps = baseDeps(okDocker(), {
			egressProxy: egress.proxy,
			egressCAPath: '/tmp/test-data/egress-ca.crt',
			sshAgentServer: ssh.server,
			connectivityStatus: status,
			connectivityProbe: probe.fn,
		});

		const result = await runAgent(deps, makeAgent(), makeTask(), makeProject());

		expect(result.success).toBe(true);
		expect(probe.calls.count).toBe(0); // fresh ok → no probe
		expect(egress.calls.allocated).toContain(result.heartbeatRunId);
	});

	it('fails open (allocates egress) when the probe is not wired (back-compat)', async () => {
		const egress = fakeEgressProxy();
		const ssh = fakeSshAgentServer();
		const deps = baseDeps(okDocker(), {
			egressProxy: egress.proxy,
			egressCAPath: '/tmp/test-data/egress-ca.crt',
			sshAgentServer: ssh.server,
			connectivityStatus: presetStatus('bind-loopback'), // present, but no probe → gate skipped
		});

		const result = await runAgent(deps, makeAgent(), makeTask(), makeProject());

		expect(result.success).toBe(true);
		expect(egress.calls.allocated).toContain(result.heartbeatRunId);
	});

	it('fails open when no connectivity status holder is wired', async () => {
		const egress = fakeEgressProxy();
		const ssh = fakeSshAgentServer();
		const deps = baseDeps(okDocker(), {
			egressProxy: egress.proxy,
			egressCAPath: '/tmp/test-data/egress-ca.crt',
			sshAgentServer: ssh.server,
		});

		const result = await runAgent(deps, makeAgent(), makeTask(), makeProject());

		expect(result.success).toBe(true);
		expect(egress.calls.allocated).toContain(result.heartbeatRunId);
	});
});

describe('runAgent — provider/credential resolution failures', () => {
	it('fails with a clear message when no AI provider credentials exist at all', async () => {
		// Stand up an isolated team/project with NO provider configured so resolution
		// returns null. (The instance-wide configs live in the shared db, so we must
		// route through a fresh app+db to get a clean "no providers" state.)
		const isoCtx = await createTestApp();
		try {
			const typesRes = await isoCtx.app.request('/api/team-templates', {
				headers: authHeader(isoCtx.token),
			});
			const typeId = (await typesRes.json()).data.find((t: any) => t.name === 'App Team').id;
			const teamRes = await createTestTeam(isoCtx.db, { name: 'No Prov', template_id: typeId });
			const isoTeamId = (await teamRes.json()).data.id;
			const projRes = await createTestProject(isoCtx.db, isoTeamId, { name: 'No Prov Proj' });
			const proj = (await projRes.json()).data;
			const agentsRes = await isoCtx.app.request(`/api/projects/${proj.slug}/agents`, {
				headers: authHeader(isoCtx.token),
			});
			const iAgent = (await agentsRes.json()).data[0];
			const taskRes = await isoCtx.app.request(`/api/projects/${proj.slug}/tasks`, {
				method: 'POST',
				headers: { ...authHeader(isoCtx.token), 'Content-Type': 'application/json' },
				body: JSON.stringify({
					project_id: proj.id,
					title: 'T',
					description: 'd',
					assignee_id: iAgent.id,
				}),
			});
			const iTaskId = (await taskRes.json()).data.id;

			const docker = createMockDocker(iTaskId, {
				execCreate: async () => {
					throw new Error('should not exec when no provider resolves');
				},
			});
			const deps: RunnerDeps = {
				db: isoCtx.db,
				docker,
				masterKeyManager: isoCtx.masterKeyManager,
				serverPort: 3000,
				dataDir: isoCtx.dataDir,
				logs: new LogStreamBroker(),
			};

			const result = await runAgent(
				deps,
				{ id: iAgent.id, title: 'A', slug: iAgent.slug, team_id: isoTeamId },
				{
					id: iTaskId,
					identifier: 'NP-1',
					title: 'T',
					description: 'd',
					status: 'backlog',
					priority: 'medium',
					project_id: proj.id,
					rules: null,
					progress_summary: null,
				},
				{
					id: proj.id,
					slug: proj.slug,
					team_id: isoTeamId,
					team_slug: 'no-prov',
					container_id: 'container-123',
					container_status: ContainerStatus.Running,
					designated_repo_id: null,
					is_internal: false,
				},
			);

			expect(result.success).toBe(false);
			const run = await isoCtx.db.query<{ status: string; error: string | null }>(
				'SELECT status, error FROM heartbeat_runs WHERE id = $1',
				[result.heartbeatRunId],
			);
			expect(run.rows[0].status).toBe(HeartbeatRunStatus.Failed);
			expect(run.rows[0].error).toContain('No AI provider credentials configured');
		} finally {
			await safeClose(isoCtx.db);
		}
	});

	it('fails when the override provider has no credential configured', async () => {
		// google is not configured in this suite's db, so a google override resolves
		// a runtime but finds no credential.
		await db.query(`DELETE FROM ai_provider_configs WHERE provider = 'google'`);

		const docker = createMockDocker(taskId, {
			execCreate: async () => {
				throw new Error('should not exec without a credential');
			},
		});
		const deps = baseDeps(docker);

		const result = await runAgent(
			deps,
			{ ...makeAgent(), model_override_provider: 'google', model_override_model: 'gemini-x' },
			makeTask(),
			makeProject(),
		);

		expect(result.success).toBe(false);
		const run = await db.query<{ status: string; error: string | null }>(
			'SELECT status, error FROM heartbeat_runs WHERE id = $1',
			[result.heartbeatRunId],
		);
		expect(run.rows[0].status).toBe(HeartbeatRunStatus.Failed);
		expect(run.rows[0].error).toContain('No google credential configured');
	});
});

describe('runAgent — abort with a terminal container reason', () => {
	it('records failed status with error=container_stopped when aborted at the pre-exec checkpoint', async () => {
		// Abort with a terminal reason during prepareWorktrees-adjacent setup: the
		// signal is already aborted by the time the post-context cleanup checkpoint
		// runs, so finalizeAbort maps the reason to a Failed status.
		const ac = new AbortController();
		const docker = createMockDocker(taskId, {
			// execCreate would only run after the abort checkpoints; assert it doesn't.
			execCreate: async () => {
				throw new Error('exec must not run after abort');
			},
		});

		// A fake egress proxy whose allocate aborts the signal — by the time
		// buildRunContext returns and the cleanup checkpoint is evaluated, the
		// signal carries the container_stopped reason.
		const deps = baseDeps(docker, {
			egressProxy: {
				allocateRunProxy: async () => {
					ac.abort('container_stopped');
					return { proxyHost: '127.0.0.1', proxyPort: 9 };
				},
				releaseRunProxy: async () => {},
			} as any,
			egressCAPath: '/tmp/test-data/egress-ca.crt',
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
		const run = await db.query<{ status: string; error: string | null }>(
			'SELECT status, error FROM heartbeat_runs WHERE id = $1',
			[result.heartbeatRunId],
		);
		expect(run.rows[0].status).toBe(HeartbeatRunStatus.Failed);
		expect(run.rows[0].error).toBe('container_stopped');
	});

	it('records cancelled status when aborted at the pre-exec checkpoint without a terminal reason', async () => {
		const ac = new AbortController();
		const docker = createMockDocker(taskId, {
			execCreate: async () => {
				throw new Error('exec must not run after abort');
			},
		});

		const deps = baseDeps(docker, {
			egressProxy: {
				allocateRunProxy: async () => {
					ac.abort(); // no reason → plain cancellation
					return { proxyHost: '127.0.0.1', proxyPort: 9 };
				},
				releaseRunProxy: async () => {},
			} as any,
			egressCAPath: '/tmp/test-data/egress-ca.crt',
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
		expect(result.stderr).toBe('Aborted');
		const run = await db.query<{ status: string }>(
			'SELECT status FROM heartbeat_runs WHERE id = $1',
			[result.heartbeatRunId],
		);
		expect(run.rows[0].status).toBe(HeartbeatRunStatus.Cancelled);
	});
});

describe('runAgent — requester_context substitution', () => {
	it('replaces {{requester_context}} with the task creator description', async () => {
		await setAgentPrompt('System prelude.\n\nRequester: {{requester_context}}');
		// Point the task's creator at a known member (the agent) so the join in the
		// substitution query resolves a display_name + member_type row.
		await db.query('UPDATE tasks SET created_by_member_id = $1 WHERE id = $2', [agentId, taskId]);
		const project = makeProject();
		let capturedPrompt = '';
		const docker = createMockDocker(taskId, {
			execCreate: async (_id: string, opts: any) => {
				capturedPrompt = readPromptFromExec(opts, '/tmp/test-data', project);
				return 'exec-req-ctx';
			},
			execStart: async () => ({ stdout: 'ok', stderr: '' }),
			execInspect: async () => ({ ExitCode: 0, Running: false, Pid: 0 }),
		});

		const deps = baseDeps(docker);
		const result = await runAgent(deps, makeAgent(), makeTask(), project);
		expect(result.success).toBe(true);

		// The substitution executes and strips the raw placeholder. (The rendered
		// requester text is empty here because the makeTask() object runAgent uses
		// is distinct from the DB row updated above, so the creator join resolves
		// no display_name — the point of this case is that the {{requester_context}}
		// branch in agent-runner runs and removes the token.)
		expect(capturedPrompt).not.toContain('{{requester_context}}');

		// Restore the default (empty) prompt + creator so later tests are unaffected.
		await db.query('UPDATE tasks SET created_by_member_id = NULL WHERE id = $1', [taskId]);
		await setAgentPrompt('');
	});
});

describe('runAgent — mention handoff', () => {
	it('renders the mention handoff block from a triggering comment', async () => {
		// Seed a human comment that @-mentions the agent, then wake the agent with a
		// mention payload pointing at it.
		const commentRes = await db.query<{ id: string }>(
			`INSERT INTO task_comments (task_id, author_member_id, content_type, content)
			 VALUES ($1, NULL, 'text', $2::jsonb)
			 RETURNING id`,
			[taskId, JSON.stringify({ text: 'Hey @agent please look into the parser bug.' })],
		);
		const commentId = commentRes.rows[0].id;

		const project = makeProject();
		let capturedPrompt = '';
		const docker = createMockDocker(taskId, {
			execCreate: async (_id: string, opts: any) => {
				capturedPrompt = readPromptFromExec(opts, '/tmp/test-data', project);
				return 'exec-mention';
			},
			execStart: async () => ({ stdout: 'ok', stderr: '' }),
			execInspect: async () => ({ ExitCode: 0, Running: false, Pid: 0 }),
		});

		const deps = baseDeps(docker);
		const result = await runAgent(deps, makeAgent(), makeTask(), project, {
			source: WakeupSource.Mention,
			comment_id: commentId,
		});
		expect(result.success).toBe(true);

		expect(capturedPrompt).toContain('## Mention Handoff');
		expect(capturedPrompt).toContain('please look into the parser bug');
		expect(capturedPrompt).toContain(`add_reaction(comment_id='${commentId}', kind='ack')`);

		await db.query('DELETE FROM task_comments WHERE id = $1', [commentId]);
	});

	it('loadMentionContext returns null when the payload has no comment id', async () => {
		const ctx = await loadMentionContext(db, agentId, teamId, {});
		expect(ctx).toBeNull();
	});

	it('loadMentionContext loads the author, excerpt, and open tickets', async () => {
		const commentRes = await db.query<{ id: string }>(
			`INSERT INTO task_comments (task_id, author_member_id, content_type, content)
			 VALUES ($1, NULL, 'text', $2::jsonb)
			 RETURNING id`,
			[taskId, JSON.stringify({ text: 'Direct mention body.' })],
		);
		const commentId = commentRes.rows[0].id;

		const ctx = await loadMentionContext(db, agentId, teamId, { comment_id: commentId });
		expect(ctx).not.toBeNull();
		expect(ctx!.excerpt).toBe('Direct mention body.');
		expect(ctx!.triggeringCommentId).toBe(commentId);
		// The seeded task is assigned to this agent and not terminal → appears.
		expect(ctx!.openTickets.some((t) => t.identifier === 'EX-1' || t.title === 'Ext Task')).toBe(
			true,
		);

		await db.query('DELETE FROM task_comments WHERE id = $1', [commentId]);
	});
});

describe('runAgent — reply handoff', () => {
	it('renders the reply handoff block from a reply + triggering comment', async () => {
		// The agent posted an original comment; a human replied referencing a ticket.
		const original = await db.query<{ id: string }>(
			`INSERT INTO task_comments (task_id, author_member_id, content_type, content)
			 VALUES ($1, $2, 'text', $3::jsonb) RETURNING id`,
			[taskId, agentId, JSON.stringify({ text: 'My original question about EX-1.' })],
		);
		const originalId = original.rows[0].id;
		const reply = await db.query<{ id: string }>(
			`INSERT INTO task_comments (task_id, author_member_id, content_type, content)
			 VALUES ($1, NULL, 'text', $2::jsonb) RETURNING id`,
			[taskId, JSON.stringify({ text: 'Replying — see EX-1 for the answer.' })],
		);
		const replyId = reply.rows[0].id;

		const project = makeProject();
		let capturedPrompt = '';
		const docker = createMockDocker(taskId, {
			execCreate: async (_id: string, opts: any) => {
				capturedPrompt = readPromptFromExec(opts, '/tmp/test-data', project);
				return 'exec-reply';
			},
			execStart: async () => ({ stdout: 'ok', stderr: '' }),
			execInspect: async () => ({ ExitCode: 0, Running: false, Pid: 0 }),
		});

		const deps = baseDeps(docker);
		const result = await runAgent(deps, makeAgent(), makeTask(), project, {
			source: WakeupSource.Reply,
			comment_id: replyId,
			triggering_comment_id: originalId,
		});
		expect(result.success).toBe(true);

		expect(capturedPrompt).toContain('## Reply Received');
		expect(capturedPrompt).toContain('My original question about EX-1');
		expect(capturedPrompt).toContain('Replying — see EX-1 for the answer');
		// The reply references EX-1, which resolves to a known ticket row.
		expect(capturedPrompt).toContain('### Tickets referenced by the reply');

		await db.query('DELETE FROM task_comments WHERE id = ANY($1::uuid[])', [[originalId, replyId]]);
	});

	it('loadReplyContext returns null when the triggering comment id is missing', async () => {
		const ctx = await loadReplyContext(db, { comment_id: 'x' });
		expect(ctx).toBeNull();
	});
});

describe('runAgent — spawned-from / parent provenance', () => {
	it('loadSpawnedFromTask returns null when the task has neither parent nor spawning run', async () => {
		const out = await loadSpawnedFromTask(db, makeTask());
		expect(out).toBeNull();
	});

	it('renders parent + spawned-from lines in the task prompt', async () => {
		// Create a parent task and a run on it; mark the seeded task as spawned from
		// that run with a distinct parent, so both provenance lines render.
		const parentRes = await app.request(`/api/projects/${projectSlug}/tasks`, {
			method: 'POST',
			headers: { ...authHeader(adminToken), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				project_id: projectId,
				title: 'Parent Ticket',
				description: 'p',
				assignee_id: agentId,
			}),
		});
		const parent = (await parentRes.json()).data;

		// A separate "spawning" task + a completed run on it.
		const spawnTaskRes = await app.request(`/api/projects/${projectSlug}/tasks`, {
			method: 'POST',
			headers: { ...authHeader(adminToken), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				project_id: projectId,
				title: 'Spawning Ticket',
				description: 's',
				assignee_id: agentId,
			}),
		});
		const spawnTask = (await spawnTaskRes.json()).data;
		const wakeup = await db.query<{ id: string }>(
			`INSERT INTO agent_wakeup_requests (member_id, team_id, source, status, payload, claimed_at)
			 VALUES ($1, $2, 'on_demand'::wakeup_source, 'claimed'::wakeup_status, '{}'::jsonb, now())
			 RETURNING id`,
			[agentId, teamId],
		);
		const spawnRun = await db.query<{ id: string }>(
			`INSERT INTO heartbeat_runs (member_id, team_id, task_id, wakeup_id, status)
			 VALUES ($1, $2, $3, $4, 'succeeded'::heartbeat_run_status) RETURNING id`,
			[agentId, teamId, spawnTask.id, wakeup.rows[0].id],
		);

		const taskInfo = makeTask({
			parent_task_id: parent.id,
			created_by_run_id: spawnRun.rows[0].id,
		});

		const out = await loadSpawnedFromTask(db, taskInfo);
		expect(out).not.toBeNull();
		expect(out!.parentLine).toContain('Parent ticket');
		expect(out!.parentLine).toContain('Parent Ticket');
		expect(out!.spawnLine).toContain('Spawned from');
		expect(out!.spawnLine).toContain('Spawning Ticket');

		// And through buildTaskPrompt the lines land in the rendered prompt.
		const prompt = buildTaskPrompt('SYS', taskInfo, undefined, { spawnedFrom: out });
		expect(prompt).toContain('**Parent ticket:** ');
		expect(prompt).toContain('**Spawned from:** ');

		await db.query('DELETE FROM heartbeat_runs WHERE id = $1', [spawnRun.rows[0].id]);
		await db.query('DELETE FROM tasks WHERE id = ANY($1::uuid[])', [[parent.id, spawnTask.id]]);
	});

	it('collapses to a single parent line when parent == spawning task', async () => {
		const parentRes = await app.request(`/api/projects/${projectSlug}/tasks`, {
			method: 'POST',
			headers: { ...authHeader(adminToken), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				project_id: projectId,
				title: 'Combined Parent',
				description: 'c',
				assignee_id: agentId,
			}),
		});
		const parent = (await parentRes.json()).data;
		const wakeup = await db.query<{ id: string }>(
			`INSERT INTO agent_wakeup_requests (member_id, team_id, source, status, payload, claimed_at)
			 VALUES ($1, $2, 'on_demand'::wakeup_source, 'claimed'::wakeup_status, '{}'::jsonb, now())
			 RETURNING id`,
			[agentId, teamId],
		);
		// Run lives on the parent task itself, so spawning task id == parent id.
		const run = await db.query<{ id: string }>(
			`INSERT INTO heartbeat_runs (member_id, team_id, task_id, wakeup_id, status)
			 VALUES ($1, $2, $3, $4, 'succeeded'::heartbeat_run_status) RETURNING id`,
			[agentId, teamId, parent.id, wakeup.rows[0].id],
		);

		const out = await loadSpawnedFromTask(
			db,
			makeTask({ parent_task_id: parent.id, created_by_run_id: run.rows[0].id }),
		);
		expect(out).not.toBeNull();
		expect(out!.parentLine).toContain('Combined Parent');
		expect(out!.spawnLine).toBeNull();

		await db.query('DELETE FROM heartbeat_runs WHERE id = $1', [run.rows[0].id]);
		await db.query('DELETE FROM tasks WHERE id = $1', [parent.id]);
	});
});

describe('buildTaskPrompt — retry block', () => {
	it('renders the previous-failure retry section', () => {
		const prompt = buildTaskPrompt('SYS', makeTask(), {
			retry_count: 2,
			max_retries: 3,
			previous_failure: {
				exit_code: 1,
				stderr_tail: 'TypeError: boom',
				stdout_tail: 'partial output',
			},
		});
		expect(prompt).toContain('## Retry Attempt 2/3');
		expect(prompt).toContain('The previous attempt FAILED');
		expect(prompt).toContain('**Exit code:** 1');
		expect(prompt).toContain('TypeError: boom');
		expect(prompt).toContain('partial output');
	});
});

describe('runAgent — domain events', () => {
	it('emits agent_run.started and agent_run.completed with enrichment from the wakeup', async () => {
		const events = new DomainEventBus();
		const captured: Array<Record<string, unknown>> = [];
		events.subscribe((e) => captured.push(e as unknown as Record<string, unknown>));

		const docker = createMockDocker(taskId, {
			execCreate: async () => 'exec-events',
			execStart: async () => ({ stdout: 'ok', stderr: '' }),
			execInspect: async () => ({ ExitCode: 0, Running: false, Pid: 0 }),
		});
		const deps = baseDeps(docker, { events });

		const result = await runAgent(deps, makeAgent(), makeTask(), makeProject(), {
			source: WakeupSource.Mention,
			author_member_id: agentId,
		});
		expect(result.success).toBe(true);

		// Both lifecycle events fire and carry the run id + terminal status. (The
		// triggerSource/triggeredBy enrichment is sourced from the persisted wakeup
		// row, not this passed object, so it defaults here — asserting it would
		// require seeding the heartbeat_runs/wakeup rows the enrichment reads.)
		const started = captured.find((c) => c.type === 'agent_run.started');
		const completed = captured.find((c) => c.type === 'agent_run.completed');
		expect(started).toBeDefined();
		expect(started!.runId).toBe(result.heartbeatRunId);
		expect(completed).toBeDefined();
		expect(completed!.status).toBe(HeartbeatRunStatus.Succeeded);
		expect(completed!.exitCode).toBe(0);
	});
});

describe('runAgent — cost recording + budget enforcement', () => {
	it('records the run cost as a cost_entries row and broadcasts it', async () => {
		const pricing = new PricingService(db);
		await upsertManualRate(db, {
			model_id: 'claude-opus-4-7',
			input_per_token: 0.0001,
			output_per_token: 0.0002,
		});
		await pricing.reload();

		// Ensure this run uses the priced model and a generous budget so it is not
		// paused. Clear prior cost rows to assert on exactly this run's entry.
		await db.query(
			`UPDATE ai_provider_configs SET default_model = 'claude-opus-4-7' WHERE provider = 'anthropic'`,
		);
		await db.query('DELETE FROM cost_entries WHERE member_id = $1', [agentId]);
		await db.query(
			`UPDATE member_agents SET daily_budget_cents = 0, weekly_budget_cents = 0, monthly_budget_cents = 0 WHERE id = $1`,
			[agentId],
		);

		// The Claude Code parser sources the model id from the system/init event;
		// cost is only computed when a priced model is known.
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
		const docker = createMockDocker(taskId, {
			execCreate: async () => 'exec-cost',
			execStart: async (_id: string, opts: any) => {
				if (opts?.onChunk) {
					await opts.onChunk({ stream: 'stdout', text: `${initEvent}\n` });
					await opts.onChunk({ stream: 'stdout', text: `${resultEvent}\n` });
				}
				return { stdout: '', stderr: '' };
			},
			execInspect: async () => ({ ExitCode: 0, Running: false, Pid: 0 }),
		});

		const broadcasts: Array<{ table?: string; action?: string; row?: any }> = [];
		const wsManager = {
			broadcast: (_room: string, event: any) => broadcasts.push(event),
			subscribe: () => {},
			unsubscribe: () => {},
			unsubscribeAll: () => {},
			getRoomSize: () => 0,
			getTotalConnections: () => 0,
		} as any;
		const logs = new LogStreamBroker();
		logs.setWsManager(wsManager);
		const deps = baseDeps(docker, { pricing, wsManager, logs });

		const result = await runAgent(deps, makeAgent(), makeTask(), makeProject());
		expect(result.success).toBe(true);

		// 1000*0.0001 + 500*0.0002 = 0.10 + 0.10 = 0.20 → 20 cents.
		const entry = await db.query<{ amount_cents: number }>(
			'SELECT amount_cents FROM cost_entries WHERE member_id = $1 ORDER BY created_at DESC LIMIT 1',
			[agentId],
		);
		expect(entry.rows[0].amount_cents).toBe(20);

		// A cost_entries INSERT was broadcast.
		expect(broadcasts.some((b) => b?.table === 'cost_entries' && b?.action === 'INSERT')).toBe(
			true,
		);

		await db.query(
			`UPDATE ai_provider_configs SET default_model = NULL WHERE provider = 'anthropic'`,
		);
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
		// A 1-cent daily cap that this ~20c run will blow past.
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
		const docker = createMockDocker(taskId, {
			execCreate: async () => 'exec-budget',
			execStart: async (_id: string, opts: any) => {
				if (opts?.onChunk) {
					await opts.onChunk({ stream: 'stdout', text: `${initEvent}\n` });
					await opts.onChunk({ stream: 'stdout', text: `${resultEvent}\n` });
				}
				return { stdout: '', stderr: '' };
			},
			execInspect: async () => ({ ExitCode: 0, Running: false, Pid: 0 }),
		});
		const deps = baseDeps(docker, { pricing });

		const result = await runAgent(deps, makeAgent(), makeTask(), makeProject());
		expect(result.success).toBe(true);

		const agentRow = await db.query<{ runtime_status: string }>(
			'SELECT runtime_status FROM member_agents WHERE id = $1',
			[agentId],
		);
		// Over-budget → runtime_status flipped to a budget-pause state (not idle).
		expect(agentRow.rows[0].runtime_status).not.toBe('idle');

		// Reset for any later tests.
		await db.query(
			`UPDATE member_agents SET daily_budget_cents = 0, runtime_status = 'idle'::agent_runtime_status WHERE id = $1`,
			[agentId],
		);
		await db.query(
			`UPDATE ai_provider_configs SET default_model = NULL WHERE provider = 'anthropic'`,
		);
		await db.query('DELETE FROM cost_entries WHERE member_id = $1', [agentId]);
	});
});

describe('runAgent — rotated subscription auth tombstone', () => {
	it('skips write-back when the CLI rewrites auth.json with an invalid (tombstone) credential', async () => {
		const validAuthJson = JSON.stringify({
			tokens: {
				id_token: 'header.payload.sig',
				access_token: 'header.payload.sig',
				refresh_token: 'rt-original',
				account_id: 'acct-tomb',
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
				label: 'openai-tombstone',
			}),
		});
		const configId = (
			await db.query<{ id: string }>(
				`SELECT id FROM ai_provider_configs WHERE provider = 'openai' LIMIT 1`,
			)
		).rows[0].id;

		const docker = createMockDocker(taskId, {
			execCreate: async (_id: string, opts: any) => {
				const codexHomeEntry = (opts.Env as string[]).find((e: string) =>
					e.startsWith('CODEX_HOME='),
				)!;
				const runId = codexHomeEntry.slice('CODEX_HOME='.length).split('/').pop()!;
				const hostFile = `${getHostSubscriptionRoot(
					AiProvider.OpenAI,
					'/tmp/test-data',
					teamId,
					projectId,
					runId,
				)}/auth.json`;
				// CLI writes an empty-token tombstone (a failed refresh): differs from the
				// stored credential but does NOT validate, so it must not be persisted.
				writeFileSync(
					hostFile,
					JSON.stringify({ tokens: { access_token: '', refresh_token: '', account_id: '' } }),
				);
				return 'exec-tombstone';
			},
			execStart: async () => ({ stdout: '', stderr: '' }),
			execInspect: async () => ({ ExitCode: 0, Running: false, Pid: 0 }),
		});

		const deps = baseDeps(docker);
		const result = await runAgent(
			deps,
			makeAgent(),
			{ ...makeTask(), runtime_type: 'codex' as const },
			makeProject(),
		);
		expect(result.success).toBe(true);

		// The stored credential must be unchanged: the tombstone failed validation, so
		// the write-back was skipped. Decrypt the row and confirm it is still the
		// original valid blob (a persisted tombstone would have wiped the tokens).
		const cfg = await db.query<{ encrypted_credential: string; status: string }>(
			'SELECT encrypted_credential, status FROM ai_provider_configs WHERE id = $1',
			[configId],
		);
		expect(cfg.rows[0].status).toBe('verified');
		expect(decrypt(cfg.rows[0].encrypted_credential, masterKeyManager.getKey())).toBe(
			validAuthJson,
		);

		// Restore an api-key openai config so the suite's other state stays sane.
		await db.query(`DELETE FROM ai_provider_configs WHERE provider = 'openai'`);
		globalThis.fetch = vi.fn().mockResolvedValue({ ok: true }) as unknown as typeof fetch;
		await app.request('/api/ai-providers', {
			method: 'POST',
			headers: { ...authHeader(adminToken), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				provider: 'openai',
				api_key: 'sk-test-restore-tomb',
				label: 'openai-restore-tomb',
			}),
		});
		globalThis.fetch = originalFetch;
	});
});
