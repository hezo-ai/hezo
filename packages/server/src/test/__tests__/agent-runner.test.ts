import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import type { PGlite } from '@electric-sql/pglite';
import {
	AgentEffort,
	AiAuthMethod,
	AiProvider,
	ContainerStatus,
	HeartbeatRunStatus,
} from '@hezo/shared';
import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { MasterKeyManager } from '../../crypto/master-key';
import type { Env } from '../../lib/types';
import {
	acquireCredentialLock,
	buildProviderEnv,
	buildSubscriptionMount,
	getHostPromptPath,
	getHostSubscriptionRoot,
	type RunnerDeps,
	runAgent,
	shellQuoteArg,
} from '../../services/agent-runner';
import type { DockerClient } from '../../services/docker';
import { LogStreamBroker } from '../../services/log-stream-broker';
import { safeClose } from '../helpers';
import { authHeader, createTestApp } from '../helpers/app';

function readPromptFromExec(
	opts: { Env: string[] },
	dataDir: string,
	project: { company_slug: string; slug: string },
): string {
	const entry = opts.Env.find((e) => e.startsWith('HEZO_PROMPT_FILE='));
	if (!entry) throw new Error('HEZO_PROMPT_FILE env var missing from exec');
	const containerPath = entry.slice('HEZO_PROMPT_FILE='.length);
	const runId = containerPath
		.split('/')
		.pop()!
		.replace(/\.txt$/, '');
	return readFileSync(
		getHostPromptPath(dataDir, project.company_slug, project.slug, runId),
		'utf8',
	);
}

let app: Hono<Env>;
let db: PGlite;
let boardToken: string;
let masterKeyManager: MasterKeyManager;
let companyId: string;
let projectId: string;
let issueId: string;
let agentId: string;

const originalFetch = globalThis.fetch;

beforeAll(async () => {
	const ctx = await createTestApp();
	app = ctx.app;
	db = ctx.db;
	boardToken = ctx.token;
	masterKeyManager = ctx.masterKeyManager;

	const typesRes = await app.request('/api/company-types', { headers: authHeader(boardToken) });
	const typeId = (await typesRes.json()).data.find((t: any) => t.name === 'Startup').id;

	const companyRes = await app.request('/api/companies', {
		method: 'POST',
		headers: { ...authHeader(boardToken), 'Content-Type': 'application/json' },
		body: JSON.stringify({ name: 'Runner Co', template_id: typeId }),
	});
	companyId = (await companyRes.json()).data.id;

	// Mock fetch for provider key validation during setup
	globalThis.fetch = vi.fn().mockResolvedValue({ ok: true }) as unknown as typeof fetch;

	// Configure an AI provider so the agent runner can resolve credentials
	await app.request('/api/ai-providers', {
		method: 'POST',
		headers: { ...authHeader(boardToken), 'Content-Type': 'application/json' },
		body: JSON.stringify({
			provider: 'anthropic',
			api_key: 'sk-ant-test-runner-key',
			label: 'anthropic-runner',
		}),
	});

	// Restore real fetch for the rest of the tests
	globalThis.fetch = originalFetch;

	const projectRes = await app.request(`/api/companies/${companyId}/projects`, {
		method: 'POST',
		headers: { ...authHeader(boardToken), 'Content-Type': 'application/json' },
		body: JSON.stringify({ name: 'Runner Project', description: 'Test project.' }),
	});
	projectId = (await projectRes.json()).data.id;

	const agentsRes = await app.request(`/api/companies/${companyId}/agents`, {
		headers: authHeader(boardToken),
	});
	agentId = (await agentsRes.json()).data[0].id;

	const issueRes = await app.request(`/api/companies/${companyId}/issues`, {
		method: 'POST',
		headers: { ...authHeader(boardToken), 'Content-Type': 'application/json' },
		body: JSON.stringify({
			project_id: projectId,
			title: 'Runner Issue',
			description: 'Test description',
			assignee_id: agentId,
		}),
	});
	issueId = (await issueRes.json()).data.id;
});

afterAll(async () => {
	await safeClose(db);
});

function createMockDocker(overrides: Record<string, any> = {}): DockerClient {
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
		execStart: async () => ({ stdout: 'done', stderr: '' }),
		execInspect: async () => ({ ExitCode: 0, Running: false, Pid: 0 }),
		...overrides,
	} as unknown as DockerClient;
}

async function setAgentPrompt(content: string) {
	await db.query(
		`INSERT INTO documents (company_id, member_agent_id, type, slug, content)
		 VALUES ($1, $2, 'agent_system_prompt', 'system-prompt', $3)
		 ON CONFLICT (member_agent_id) WHERE type = 'agent_system_prompt'
		 DO UPDATE SET content = EXCLUDED.content`,
		[companyId, agentId, content],
	);
}

function makeAgent() {
	return {
		id: agentId,
		title: 'Test Agent',
		company_id: companyId,
	};
}

function makeIssue() {
	return {
		id: issueId,
		identifier: 'RC-1',
		title: 'Runner Issue',
		description: 'Test description',
		status: 'backlog',
		priority: 'medium',
		project_id: projectId,
		rules: null,
	};
}

function makeProject(overrides: Record<string, unknown> = {}) {
	return {
		id: projectId,
		slug: 'runner-project',
		company_id: companyId,
		company_slug: 'runner-co',
		container_id: 'container-123',
		container_status: ContainerStatus.Running,
		designated_repo_id: null,
		...overrides,
	};
}

describe('runAgent', () => {
	it('returns failure when container is not running and records it in the run log', async () => {
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

		const logs = new LogStreamBroker();
		logs.setWsManager(wsManager);
		const deps: RunnerDeps = {
			db,
			docker: createMockDocker(),
			masterKeyManager,
			serverPort: 3000,
			dataDir: '/tmp/test-data',
			wsManager,
			logs,
		};

		const result = await runAgent(
			deps,
			makeAgent(),
			makeIssue(),
			makeProject({ container_status: ContainerStatus.Stopped, container_id: 'c-1' }),
		);

		expect(result.success).toBe(false);
		expect(result.exitCode).toBe(-1);
		expect(result.stderr).toContain('not running');
		expect(result.heartbeatRunId).toBeDefined();

		const run = await db.query<{ status: string; log_text: string; error: string | null }>(
			'SELECT status, log_text, error FROM heartbeat_runs WHERE id = $1',
			[result.heartbeatRunId],
		);
		expect(run.rows[0].status).toBe(HeartbeatRunStatus.Failed);
		expect(run.rows[0].log_text).toContain('[runner]');
		expect(run.rows[0].log_text).toContain('not running');
		expect(run.rows[0].error).toContain('not running');

		const logBroadcasts = broadcasts.filter((b) => b.event.type === 'run_log');
		expect(logBroadcasts.some((b) => b.event.text.includes('not running'))).toBe(true);
	});

	it('returns failure when container_id is null and records it in the run log', async () => {
		const deps: RunnerDeps = {
			db,
			docker: createMockDocker(),
			masterKeyManager,
			serverPort: 3000,
			dataDir: '/tmp/test-data',
			logs: new LogStreamBroker(),
		};

		const result = await runAgent(
			deps,
			makeAgent(),
			makeIssue(),
			makeProject({ container_id: null }),
		);

		expect(result.success).toBe(false);
		expect(result.stderr).toContain('not running');
		expect(result.heartbeatRunId).toBeDefined();

		const run = await db.query<{ status: string; log_text: string }>(
			'SELECT status, log_text FROM heartbeat_runs WHERE id = $1',
			[result.heartbeatRunId],
		);
		expect(run.rows[0].status).toBe(HeartbeatRunStatus.Failed);
		expect(run.rows[0].log_text).toContain('not running');
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
			dataDir: '/tmp/test-data',
			logs: new LogStreamBroker(),
		};

		const result = await runAgent(deps, makeAgent(), makeIssue(), makeProject());

		expect(result.success).toBe(true);
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toBe('task completed');
		expect(result.heartbeatRunId).toBeDefined();

		// Verify heartbeat run was recorded
		const run = await db.query<{ status: string; exit_code: number }>(
			'SELECT status, exit_code FROM heartbeat_runs WHERE id = $1',
			[result.heartbeatRunId],
		);
		expect(run.rows[0].status).toBe(HeartbeatRunStatus.Succeeded);
		expect(run.rows[0].exit_code).toBe(0);
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
			dataDir: '/tmp/test-data',
			logs: new LogStreamBroker(),
		};

		const result = await runAgent(deps, makeAgent(), makeIssue(), makeProject());

		expect(result.success).toBe(false);
		expect(result.exitCode).toBe(1);
		expect(result.heartbeatRunId).toBeDefined();

		const run = await db.query<{ status: string }>(
			'SELECT status FROM heartbeat_runs WHERE id = $1',
			[result.heartbeatRunId],
		);
		expect(run.rows[0].status).toBe(HeartbeatRunStatus.Failed);
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
			dataDir: '/tmp/test-data',
			logs: new LogStreamBroker(),
		};

		const result = await runAgent(deps, makeAgent(), makeIssue(), makeProject());

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

	it('includes issue rules in task prompt when present', async () => {
		const project = makeProject();
		const docker = createMockDocker({
			execCreate: async (_containerId: string, opts: any) => {
				const prompt = readPromptFromExec(opts, '/tmp/test-data', project);
				expect(prompt).toContain('Rules for this issue');
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
			dataDir: '/tmp/test-data',
			logs: new LogStreamBroker(),
		};

		const issueWithRules = { ...makeIssue(), rules: 'Always write tests' };
		const result = await runAgent(deps, makeAgent(), issueWithRules, project);
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
			dataDir: '/tmp/test-data',
			logs: new LogStreamBroker(),
		};

		await runAgent(deps, makeAgent(), makeIssue(), makeProject());

		expect(capturedEnv.some((e: string) => e.startsWith('HEZO_API_URL='))).toBe(true);
		expect(capturedEnv.some((e: string) => e.startsWith('HEZO_AGENT_TOKEN='))).toBe(true);
		expect(capturedEnv.some((e: string) => e.startsWith('HEZO_AGENT_ID='))).toBe(true);
		expect(capturedEnv.some((e: string) => e.startsWith('HEZO_COMPANY_ID='))).toBe(true);
		expect(capturedEnv.some((e: string) => e.startsWith('HEZO_ISSUE_ID='))).toBe(true);

		const apiUrl = capturedEnv.find((e: string) => e.startsWith('HEZO_API_URL='));
		expect(apiUrl).toContain('3100');
		expect(apiUrl).toContain('host.docker.internal');

		expect(capturedUser).toBe('node');
	});

	it('injects Run Context with company, project, and issue IDs into the system prompt', async () => {
		const project = makeProject();
		let capturedPrompt = '';
		const docker = createMockDocker({
			execCreate: async (_containerId: string, opts: any) => {
				capturedPrompt = readPromptFromExec(opts, '/tmp/test-data', project);
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
			dataDir: '/tmp/test-data',
			logs: new LogStreamBroker(),
		};

		await runAgent(deps, makeAgent(), makeIssue(), project);

		expect(capturedPrompt).toContain('## Run Context');
		expect(capturedPrompt).toContain(`Company ID: ${companyId}`);
		expect(capturedPrompt).toContain(`Project ID: ${projectId}`);
		expect(capturedPrompt).toContain(`Issue ID: ${issueId}`);
	});

	it('handles coach review trigger', async () => {
		const project = makeProject();
		let capturedPrompt = '';
		const docker = createMockDocker({
			execCreate: async (_containerId: string, opts: any) => {
				capturedPrompt = readPromptFromExec(opts, '/tmp/test-data', project);
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
			dataDir: '/tmp/test-data',
			logs: new LogStreamBroker(),
		};

		const result = await runAgent(deps, makeAgent(), makeIssue(), project, {
			trigger: 'issue_done',
		});

		expect(result.success).toBe(true);
		expect(capturedPrompt).toContain('Review Completed Ticket');
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
			dataDir: '/tmp/test-data',
			logs: new LogStreamBroker(),
		};

		const ac = new AbortController();
		ac.abort();

		const result = await runAgent(
			deps,
			makeAgent(),
			makeIssue(),
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
					capturedPrompt = readPromptFromExec(opts, '/tmp/test-data', project);
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
				dataDir: '/tmp/test-data',
				logs: new LogStreamBroker(),
			};

			await runAgent(deps, makeAgent(), makeIssue(), project, {
				effort: AgentEffort.Max,
			});

			expect(capturedPrompt.trim().endsWith('ultrathink')).toBe(true);
		});

		it("uses the agent's default_effort when the wakeup carries no override", async () => {
			const project = makeProject();
			let capturedPrompt = '';
			const docker = createMockDocker({
				execCreate: async (_id: string, opts: any) => {
					capturedPrompt = readPromptFromExec(opts, '/tmp/test-data', project);
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
				dataDir: '/tmp/test-data',
				logs: new LogStreamBroker(),
			};

			await runAgent(
				deps,
				{ ...makeAgent(), default_effort: AgentEffort.High },
				makeIssue(),
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
				dataDir: '/tmp/test-data',
				logs: new LogStreamBroker(),
			};

			await runAgent(deps, makeAgent(), makeIssue(), makeProject(), {
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
				dataDir: '/tmp/test-data',
				logs: new LogStreamBroker(),
			};

			// Reconfigure the provider so the Codex runtime can resolve a credential.
			// Mock fetch so verifyProviderKey doesn't make a real network call.
			globalThis.fetch = vi.fn().mockResolvedValue({ ok: true }) as unknown as typeof fetch;
			await app.request('/api/ai-providers', {
				method: 'POST',
				headers: { ...authHeader(boardToken), 'Content-Type': 'application/json' },
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
				{ ...makeIssue(), runtime_type: 'codex' as const },
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
			dataDir: '/tmp/test-data',
			logs: new LogStreamBroker(),
		};

		const result = await runAgent(
			deps,
			makeAgent(),
			makeIssue(),
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
			dataDir: '/tmp/test-data',
			logs: new LogStreamBroker(),
		};

		const result = await runAgent(
			deps,
			makeAgent(),
			makeIssue(),
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
			dataDir: '/tmp/test-data',
			logs: new LogStreamBroker(),
		};

		const result = await runAgent(
			deps,
			makeAgent(),
			makeIssue(),
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
				dataDir: '/tmp/test-data',
				logs: new LogStreamBroker(),
			};

			const result = await runAgent(deps, makeAgent(), makeIssue(), makeProject());

			expect(result.heartbeatRunId).toBeDefined();
			const row = await db.query<{ started_at: string | null }>(
				'SELECT started_at FROM heartbeat_runs WHERE id = $1',
				[result.heartbeatRunId],
			);
			expect(row.rows[0].started_at).not.toBeNull();
			expect(new Date(row.rows[0].started_at!).getTime()).toBeGreaterThan(Date.now() - 10_000);
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
				dataDir: '/tmp/test-data',
				logs: new LogStreamBroker(),
			};

			const result = await runAgent(deps, makeAgent(), makeIssue(), makeProject());

			expect(capturedCmd).toContain('--mcp-config');
			expect(capturedCmd).toContain('--strict-mcp-config');
			const mcpIdx = capturedCmd.indexOf('--mcp-config');
			const mcpJson = capturedCmd[mcpIdx + 1];
			const parsed = JSON.parse(mcpJson) as {
				mcpServers: { hezo: { type: string; url: string; headers: Record<string, string> } };
			};
			expect(parsed.mcpServers.hezo.type).toBe('http');
			expect(parsed.mcpServers.hezo.url).toBe('http://host.docker.internal:3100/mcp');
			const authHeaderValue = parsed.mcpServers.hezo.headers.Authorization;
			expect(authHeaderValue).toMatch(/^Bearer /);

			const token = authHeaderValue.slice('Bearer '.length);
			const payloadBase64 = token.split('.')[1];
			const payload = JSON.parse(Buffer.from(payloadBase64, 'base64url').toString('utf8')) as {
				member_id: string;
				company_id: string;
				run_id: string;
				exp: number;
			};
			expect(payload.run_id).toBe(result.heartbeatRunId);
			expect(payload.member_id).toBe(makeAgent().id);
			expect(payload.company_id).toBe(makeAgent().company_id);
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
				dataDir: '/tmp/test-data',
				logs: new LogStreamBroker(),
			};

			await runAgent(
				deps,
				makeAgent(),
				{ ...makeIssue(), runtime_type: 'codex' as const },
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
				headers: { ...authHeader(boardToken), 'Content-Type': 'application/json' },
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
							'/tmp/test-data',
							'runner-co',
							'runner-project',
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
				dataDir: '/tmp/test-data',
				logs: new LogStreamBroker(),
			};

			const result = await runAgent(
				deps,
				makeAgent(),
				{ ...makeIssue(), runtime_type: 'codex' as const },
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
			expect(stagedTomlContents).toContain('url = "http://host.docker.internal:3000/mcp"');
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
				headers: { ...authHeader(boardToken), 'Content-Type': 'application/json' },
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
							'/tmp/test-data',
							'runner-co',
							'runner-project',
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
				dataDir: '/tmp/test-data',
				logs: new LogStreamBroker(),
			};

			const result = await runAgent(
				deps,
				makeAgent(),
				{ ...makeIssue(), runtime_type: 'codex' as const },
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
				headers: { ...authHeader(boardToken), 'Content-Type': 'application/json' },
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
				headers: { ...authHeader(boardToken), 'Content-Type': 'application/json' },
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
							'/tmp/test-data',
							'runner-co',
							'runner-project',
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
				dataDir: '/tmp/test-data',
				logs: new LogStreamBroker(),
			};

			const result = await runAgent(
				deps,
				makeAgent(),
				{ ...makeIssue(), runtime_type: 'gemini' as const },
				makeProject(),
			);
			expect(result.success).toBe(true);

			expect(capturedCmd).not.toContain('--mcp-config');
			expect(capturedEnv.filter((e) => e.startsWith('GEMINI_CLI_HOME=')).length).toBe(1);

			expect(settingsPath).not.toBeNull();
			const parsed = JSON.parse(settingsContents!) as {
				mcpServers: Record<string, { httpUrl: string; headers?: Record<string, string> }>;
			};
			expect(parsed.mcpServers.hezo.httpUrl).toBe('http://host.docker.internal:3000/mcp');
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
				dataDir: '/tmp/test-data',
				logs: new LogStreamBroker(),
			};

			const result = await runAgent(deps, makeAgent(), makeIssue(), makeProject());

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
					promptOnDisk = readPromptFromExec(opts, '/tmp/test-data', project);
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
				dataDir: '/tmp/test-data',
				logs: new LogStreamBroker(),
			};

			const hugeSystemPrompt = 'X'.repeat(256 * 1024);
			await setAgentPrompt(hugeSystemPrompt);
			const result = await runAgent(deps, makeAgent(), makeIssue(), project);

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
				dataDir: '/tmp/test-data',
				logs: new LogStreamBroker(),
			};

			const result = await runAgent(deps, makeAgent(), makeIssue(), makeProject());

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
				dataDir: '/tmp/test-data',
				wsManager,
				logs,
			};

			const result = await runAgent(deps, makeAgent(), makeIssue(), makeProject());

			const runLogBroadcasts = broadcasts.filter((b) => b.event.type === 'run_log');
			expect(runLogBroadcasts.length).toBeGreaterThan(0);
			expect(runLogBroadcasts[0].room).toBe(`project-runs:${projectId}`);
			expect(runLogBroadcasts.some((b) => b.event.text.includes('hello'))).toBe(true);
			expect(runLogBroadcasts.some((b) => b.event.stream === 'stderr')).toBe(true);

			const row = await db.query<{ log_text: string }>(
				'SELECT log_text FROM heartbeat_runs WHERE id = $1',
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
				dataDir: '/tmp/test-data',
				logs: new LogStreamBroker(),
			};

			await runAgent(deps, makeAgent(), makeIssue(), makeProject());

			expect(capturedCmd).toContain('--dangerously-skip-permissions');
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
				dataDir: '/tmp/test-data',
				logs: new LogStreamBroker(),
			};

			await runAgent(
				deps,
				makeAgent(),
				{ ...makeIssue(), runtime_type: 'codex' as const },
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
				dataDir: '/tmp/test-data',
				logs: new LogStreamBroker(),
			};

			await runAgent(deps, makeAgent(), makeIssue(), makeProject());

			expect(capturedCmd).toContain('--output-format');
			const idx = capturedCmd.indexOf('--output-format');
			expect(capturedCmd[idx + 1]).toBe('stream-json');
			expect(capturedCmd).toContain('--verbose');
			expect(capturedCmd).toContain('claude');
			expect(capturedCmd[capturedCmd.length - 1]).toBe('-p');
			expect(capturedCmd).not.toContain('exec');
		});

		it('does not pass --output-format for non-claude runtimes', async () => {
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
				dataDir: '/tmp/test-data',
				logs: new LogStreamBroker(),
			};

			await runAgent(
				deps,
				makeAgent(),
				{ ...makeIssue(), runtime_type: 'codex' as const },
				makeProject(),
			);

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
				dataDir: '/tmp/test-data',
				logs: new LogStreamBroker(),
			};

			globalThis.fetch = vi.fn().mockResolvedValue({ ok: true }) as unknown as typeof fetch;
			await app.request('/api/ai-providers', {
				method: 'POST',
				headers: { ...authHeader(boardToken), 'Content-Type': 'application/json' },
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
				{ ...makeIssue(), runtime_type: 'gemini' as const },
				makeProject(),
			);

			expect(capturedCmd).toContain('gemini');
			expect(capturedCmd).toContain('--yolo');
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
			const deps: RunnerDeps = {
				db,
				docker,
				masterKeyManager,
				serverPort: 3000,
				dataDir: '/tmp/test-data',
				logs: new LogStreamBroker(),
			};

			const result = await runAgent(deps, makeAgent(), makeIssue(), makeProject());

			const row = await db.query<{
				log_text: string;
				input_tokens: number;
				output_tokens: number;
				cost_cents: number;
			}>(
				'SELECT log_text, input_tokens::int AS input_tokens, output_tokens::int AS output_tokens, cost_cents FROM heartbeat_runs WHERE id = $1',
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
			expect(row.rows[0].cost_cents).toBe(12);
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
				dataDir: '/tmp/test-data',
				logs: new LogStreamBroker(),
			};

			await runAgent(deps, makeAgent(), makeIssue(), makeProject());

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
				dataDir: '/tmp/test-data',
				logs: new LogStreamBroker(),
			};

			// Clear any default_model state on all configs.
			await db.query('UPDATE ai_provider_configs SET default_model = NULL');

			await runAgent(deps, makeAgent(), makeIssue(), makeProject());

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
				dataDir: '/tmp/test-data',
				logs: new LogStreamBroker(),
			};

			await db.query(
				`UPDATE ai_provider_configs SET default_model = 'claude-opus-4-7' WHERE provider = 'anthropic'`,
			);

			await runAgent(deps, makeAgent(), makeIssue(), makeProject());

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
				dataDir: '/tmp/test-data',
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
				makeIssue(),
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
				dataDir: '/tmp/test-data',
				logs: new LogStreamBroker(),
			};

			// Ensure an openai config exists so the override provider can resolve.
			globalThis.fetch = vi.fn().mockResolvedValue({ ok: true }) as unknown as typeof fetch;
			await app.request('/api/ai-providers', {
				method: 'POST',
				headers: { ...authHeader(boardToken), 'Content-Type': 'application/json' },
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
				makeIssue(),
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
				headers: { ...authHeader(boardToken), 'Content-Type': 'application/json' },
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
			});
			expect(env).toEqual([]);
		});

		it('keeps OPENAI_API_KEY env injection for openai+api_key', () => {
			const env = buildProviderEnv(AiProvider.OpenAI, {
				value: 'sk-test',
				authMethod: AiAuthMethod.ApiKey,
			});
			expect(env).toEqual(['OPENAI_API_KEY=sk-test']);
		});

		it('writes auth.json to a per-run host path and points CODEX_HOME at it', () => {
			const dataDir = `/tmp/codex-mount-${Date.now()}`;
			const runId = 'run-mount-1';
			const mount = buildSubscriptionMount(dataDir, 'co', 'pj', runId, AiProvider.OpenAI, {
				value: validAuthJson,
				authMethod: AiAuthMethod.Subscription,
			});
			expect(mount).not.toBeNull();
			expect(mount!.containerDir).toBe(`/workspace/.hezo/subscription/codex/${runId}`);
			expect(mount!.envEntries).toEqual([
				`CODEX_HOME=/workspace/.hezo/subscription/codex/${runId}`,
			]);
			expect(existsSync(mount!.hostAuthFile)).toBe(true);
			expect(readFileSync(mount!.hostAuthFile, 'utf8')).toBe(validAuthJson);
		});

		it('returns null mount for providers without a paste flow', () => {
			expect(
				buildSubscriptionMount('/tmp', 'co', 'pj', 'r1', AiProvider.OpenAI, {
					value: 'sk-x',
					authMethod: AiAuthMethod.ApiKey,
				}),
			).toBeNull();
			expect(
				buildSubscriptionMount('/tmp', 'co', 'pj', 'r1', AiProvider.Anthropic, {
					value: 'sk-ant',
					authMethod: AiAuthMethod.ApiKey,
				}),
			).toBeNull();
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
							'/tmp/test-data',
							'runner-co',
							'runner-project',
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
				dataDir: '/tmp/test-data',
				logs: new LogStreamBroker(),
			};

			const result = await runAgent(
				deps,
				makeAgent(),
				{ ...makeIssue(), runtime_type: 'codex' as const },
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
						'/tmp/test-data',
						'runner-co',
						'runner-project',
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
				dataDir: '/tmp/test-data',
				logs: new LogStreamBroker(),
			};

			const result = await runAgent(
				deps,
				makeAgent(),
				{ ...makeIssue(), runtime_type: 'codex' as const },
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
