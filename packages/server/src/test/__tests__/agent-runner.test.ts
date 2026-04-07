import type { PGlite } from '@electric-sql/pglite';
import { ContainerStatus, HeartbeatRunStatus } from '@hezo/shared';
import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MasterKeyManager } from '../../crypto/master-key';
import type { Env } from '../../lib/types';
import { type RunnerDeps, type RunResult, runAgent } from '../../services/agent-runner';
import type { DockerClient } from '../../services/docker';
import { safeClose } from '../helpers';
import { authHeader, createTestApp } from '../helpers/app';

let app: Hono<Env>;
let db: PGlite;
let boardToken: string;
let masterKeyManager: MasterKeyManager;
let companyId: string;
let projectId: string;
let issueId: string;
let agentId: string;

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
		body: JSON.stringify({ name: 'Runner Co', template_id: typeId, issue_prefix: 'RC' }),
	});
	companyId = (await companyRes.json()).data.id;

	// Configure an AI provider so the agent runner can resolve credentials
	await app.request(`/api/companies/${companyId}/ai-providers`, {
		method: 'POST',
		headers: { ...authHeader(boardToken), 'Content-Type': 'application/json' },
		body: JSON.stringify({
			provider: 'anthropic',
			api_key: 'sk-ant-test-runner-key',
		}),
	});

	const projectRes = await app.request(`/api/companies/${companyId}/projects`, {
		method: 'POST',
		headers: { ...authHeader(boardToken), 'Content-Type': 'application/json' },
		body: JSON.stringify({ name: 'Runner Project' }),
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

function makeAgent() {
	return {
		id: agentId,
		title: 'Test Agent',
		system_prompt: 'You are a helpful agent. Today is {{current_date}}.',
		company_id: companyId,
		runtime_type: 'claude_code' as const,
	};
}

function makeIssue() {
	return {
		id: issueId,
		identifier: 'RC-1',
		title: 'Runner Issue',
		description: 'Test description',
		status: 'open',
		priority: 'medium',
		project_id: projectId,
		rules: null,
	};
}

function makeProject(overrides: Record<string, unknown> = {}) {
	return {
		id: projectId,
		slug: 'runner-project',
		container_id: 'container-123',
		container_status: ContainerStatus.Running,
		...overrides,
	};
}

describe('runAgent', () => {
	it('returns failure when container is not running', async () => {
		const deps: RunnerDeps = {
			db,
			docker: createMockDocker(),
			masterKeyManager,
			serverPort: 3000,
			dataDir: '/tmp/test-data',
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
	});

	it('returns failure when container_id is null', async () => {
		const deps: RunnerDeps = {
			db,
			docker: createMockDocker(),
			masterKeyManager,
			serverPort: 3000,
			dataDir: '/tmp/test-data',
		};

		const result = await runAgent(
			deps,
			makeAgent(),
			makeIssue(),
			makeProject({ container_id: null }),
		);

		expect(result.success).toBe(false);
		expect(result.stderr).toContain('not running');
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
		const docker = createMockDocker({
			execCreate: async (_containerId: string, opts: any) => {
				// Verify the prompt includes rules
				const prompt = opts.Cmd[2];
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
		};

		const issueWithRules = { ...makeIssue(), rules: 'Always write tests' };
		const result = await runAgent(deps, makeAgent(), issueWithRules, makeProject());
		expect(result.success).toBe(true);
	});

	it('passes correct env vars to docker exec', async () => {
		let capturedEnv: string[] = [];
		const docker = createMockDocker({
			execCreate: async (_containerId: string, opts: any) => {
				capturedEnv = opts.Env;
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
	});

	it('handles coach review trigger', async () => {
		let capturedPrompt = '';
		const docker = createMockDocker({
			execCreate: async (_containerId: string, opts: any) => {
				capturedPrompt = opts.Cmd[2];
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
		};

		const result = await runAgent(deps, makeAgent(), makeIssue(), makeProject(), {
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
});
