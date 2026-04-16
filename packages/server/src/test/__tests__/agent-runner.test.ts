import type { PGlite } from '@electric-sql/pglite';
import { AgentEffort, ContainerStatus, HeartbeatRunStatus } from '@hezo/shared';
import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
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
		body: JSON.stringify({ name: 'Runner Co', template_id: typeId, issue_prefix: 'RC' }),
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
		company_id: companyId,
		company_slug: 'runner-co',
		container_id: 'container-123',
		container_status: ContainerStatus.Running,
		designated_repo_id: null,
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
				const prompt = opts.Cmd[opts.Cmd.length - 1];
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
				capturedPrompt = opts.Cmd[opts.Cmd.length - 1];
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

	describe('effort configuration', () => {
		it('appends the ultrathink directive when the wakeup asks for max effort', async () => {
			let capturedPrompt = '';
			const docker = createMockDocker({
				execCreate: async (_id: string, opts: any) => {
					capturedPrompt = opts.Cmd[opts.Cmd.length - 1];
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
			};

			await runAgent(deps, makeAgent(), makeIssue(), makeProject(), {
				effort: AgentEffort.Max,
			});

			expect(capturedPrompt.trim().endsWith('ultrathink')).toBe(true);
		});

		it("uses the agent's default_effort when the wakeup carries no override", async () => {
			let capturedPrompt = '';
			const docker = createMockDocker({
				execCreate: async (_id: string, opts: any) => {
					capturedPrompt = opts.Cmd[opts.Cmd.length - 1];
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
			};

			await runAgent(
				deps,
				{ ...makeAgent(), default_effort: AgentEffort.High },
				makeIssue(),
				makeProject(),
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
				{ ...makeAgent(), runtime_type: 'codex' as any },
				makeIssue(),
				makeProject(),
				{ effort: AgentEffort.High },
			);

			expect(capturedCmd[0]).toBe('codex');
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
			};

			await runAgent(deps, makeAgent(), makeIssue(), makeProject());

			expect(capturedCmd).toContain('--mcp-config');
			expect(capturedCmd).toContain('--strict-mcp-config');
			const mcpIdx = capturedCmd.indexOf('--mcp-config');
			const mcpJson = capturedCmd[mcpIdx + 1];
			const parsed = JSON.parse(mcpJson) as {
				mcpServers: { hezo: { type: string; url: string; headers: Record<string, string> } };
			};
			expect(parsed.mcpServers.hezo.type).toBe('http');
			expect(parsed.mcpServers.hezo.url).toBe('http://host.docker.internal:3100/mcp');
			expect(parsed.mcpServers.hezo.headers.Authorization).toMatch(/^Bearer /);
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
			};

			await runAgent(
				deps,
				{ ...makeAgent(), runtime_type: 'codex' as any },
				makeIssue(),
				makeProject(),
			);

			expect(capturedCmd).not.toContain('--mcp-config');
			expect(capturedCmd).not.toContain('--strict-mcp-config');
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

			const deps: RunnerDeps = {
				db,
				docker,
				masterKeyManager,
				serverPort: 3000,
				dataDir: '/tmp/test-data',
				wsManager,
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
			};

			await runAgent(
				deps,
				{ ...makeAgent(), runtime_type: 'codex' as any },
				makeIssue(),
				makeProject(),
			);

			expect(capturedCmd[0]).toBe('codex');
			expect(capturedCmd).toContain('--dangerously-bypass-approvals-and-sandbox');
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
});
