import { AiProvider, ContainerStatus, HeartbeatRunStatus } from '@hezo/shared';
import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { MasterKeyManager } from '../src/crypto/master-key';
import type { Db } from '../src/db/database';
import type { Env } from '../src/lib/types';
import { type RunnerDeps, runAgent } from '../src/services/agent-runner';
import type { DockerClient } from '../src/services/docker';
import { LogStreamBroker } from '../src/services/log-stream-broker';
import { safeClose } from './helpers';
import { authHeader, createTestApp, createTestProject, createTestTeam } from './helpers/app';
import { withRunUserStub } from './helpers/run-user-docker';

// The handoff-delivery guardrail: when a run ends (clean exit) with an active
// @-mention/handoff in its FINAL MESSAGE that it never posted as a comment, the
// runner auto-delivers it as a real comment so the mention actually wakes its
// target — the exact HM-103 failure (an @admin ask left only in the final
// message, delivered to no one). These tests boot a real app + PGlite and drive
// runAgent with a mock docker that streams a Claude Code `result` event.

let app: Hono<Env>;
let db: Db;
let masterKeyManager: MasterKeyManager;
let teamId: string;
let projectId: string;
let taskId: string;
let agentId: string;

const originalFetch = globalThis.fetch;

beforeAll(async () => {
	const ctx = await createTestApp();
	app = ctx.app;
	db = ctx.db;
	masterKeyManager = ctx.masterKeyManager;
	const adminToken = ctx.token;

	const typesRes = await app.request('/api/team-templates', { headers: authHeader(adminToken) });
	const typeId = (await typesRes.json()).data.find(
		(t: { name: string }) => t.name === 'Startup',
	).id;

	const teamRes = await createTestTeam(db, { name: 'Handoff Co', template_id: typeId });
	teamId = (await teamRes.json()).data.id;

	globalThis.fetch = vi.fn().mockResolvedValue({ ok: true }) as unknown as typeof fetch;
	await app.request('/api/ai-providers', {
		method: 'POST',
		headers: { ...authHeader(adminToken), 'Content-Type': 'application/json' },
		body: JSON.stringify({
			provider: AiProvider.Anthropic,
			api_key: 'sk-ant-test-handoff-key',
			label: 'anthropic-handoff',
		}),
	});
	globalThis.fetch = originalFetch;

	const projectRes = await createTestProject(db, teamId, { name: 'Handoff Project' });
	const projectData = (await projectRes.json()).data;
	projectId = projectData.id;
	const projectSlug = projectData.slug;

	const agentsRes = await app.request(`/api/projects/${projectSlug}/agents`, {
		headers: authHeader(adminToken),
	});
	agentId = (await agentsRes.json()).data[0].id;

	const taskRes = await app.request(`/api/projects/${projectSlug}/tasks`, {
		method: 'POST',
		headers: { ...authHeader(adminToken), 'Content-Type': 'application/json' },
		body: JSON.stringify({ project_id: projectId, title: 'Handoff Task', assignee_id: agentId }),
	});
	taskId = (await taskRes.json()).data.id;
});

afterAll(async () => {
	await safeClose(db);
});

// Mirror agent-runner.test.ts's mock: flip produced_output during exec (what the
// MCP write layer does mid-run) when `producesOutput`, and stream whatever the
// test's execStart emits via onChunk.
function createMockDocker(overrides: Record<string, unknown> = {}): DockerClient {
	const {
		execStart: execStartOverride,
		producesOutput = false,
		execInspect,
		...rest
	} = overrides as Record<string, unknown> & {
		execStart?: (...a: unknown[]) => unknown;
		producesOutput?: boolean;
		execInspect?: () => Promise<unknown>;
	};
	const innerExecStart =
		(execStartOverride as ((...a: unknown[]) => unknown) | undefined) ??
		(async () => ({ stdout: 'done', stderr: '' }));
	const base = {
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
		execInspect: execInspect ?? (async () => ({ ExitCode: 0, Running: false, Pid: 0 })),
		...rest,
		execStart: async (...args: unknown[]) => {
			if (producesOutput) {
				await db.query(
					`UPDATE heartbeat_runs SET produced_output = true WHERE task_id = $1 AND status = 'running'`,
					[taskId],
				);
			}
			return innerExecStart(...args);
		},
	} as unknown as DockerClient;
	return withRunUserStub(base);
}

function makeAgent() {
	return { id: agentId, title: 'Test Agent', team_id: teamId };
}

function makeTask() {
	return {
		id: taskId,
		identifier: 'HC-1',
		title: 'Handoff Task',
		description: null,
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
		slug: 'handoff-project',
		team_id: teamId,
		team_slug: 'handoff-co',
		container_id: 'container-123',
		container_status: ContainerStatus.Running,
		designated_repo_id: null,
		is_internal: false,
		...overrides,
	};
}

/** Stream a single Claude Code `result` event (its `result` is the final message). */
function streamResult(finalMessage: string, isError = false) {
	const event = JSON.stringify({
		type: 'result',
		subtype: isError ? 'error' : 'success',
		is_error: isError,
		result: finalMessage,
		usage: {},
	});
	return async (
		_execId: string,
		opts: { onChunk?: (c: { stream: string; text: string }) => Promise<void> },
	) => {
		await opts.onChunk?.({ stream: 'stdout', text: `${event}\n` });
		return { stdout: '', stderr: '' };
	};
}

function makeDeps(docker: DockerClient): RunnerDeps {
	return {
		db,
		docker,
		masterKeyManager,
		serverPort: 3000,
		dataDir: '/tmp/test-data-handoff',
		logs: new LogStreamBroker(),
	};
}

async function textComments(runId: string) {
	return db.query<{ id: string; author_member_id: string; content: unknown }>(
		`SELECT id, author_member_id, content FROM task_comments
		 WHERE task_id = $1 AND content_type = 'text' AND created_by_run_id = $2`,
		[taskId, runId],
	);
}

describe('runAgent handoff-delivery guardrail', () => {
	it('delivers an unposted @admin final message as a comment and flips the no-op run to success', async () => {
		const deps = makeDeps(
			createMockDocker({
				producesOutput: false,
				execStart: streamResult('@admin — Higgsfield is broken, which way do you want to go?'),
			}),
		);

		const result = await runAgent(deps, makeAgent(), makeTask(), makeProject());
		const runId = result.heartbeatRunId;

		// The no-op run became a success because the guardrail produced a comment.
		expect(result.success).toBe(true);
		const run = await db.query<{ status: string; produced_output: boolean; log_text: string }>(
			'SELECT status, produced_output, log_text FROM heartbeat_runs WHERE id = $1',
			[runId],
		);
		expect(run.rows[0].status).toBe(HeartbeatRunStatus.Succeeded);
		expect(run.rows[0].produced_output).toBe(true);
		expect(run.rows[0].log_text).toContain('auto-delivered stranded handoff');

		// A text comment, authored by the run's agent, carrying the @admin ask.
		const comments = await textComments(runId);
		expect(comments.rows.length).toBe(1);
		expect(comments.rows[0].author_member_id).toBe(agentId);
		expect(JSON.stringify(comments.rows[0].content)).toContain('@admin');

		// The @admin mention fanned out to the human inbox (superuser recipient).
		const mentions = await db.query(
			'SELECT 1 FROM admin_mentions WHERE task_id = $1 AND comment_id = $2',
			[taskId, comments.rows[0].id],
		);
		expect(mentions.rows.length).toBeGreaterThan(0);
	});

	it('does not double-post when the handoff was already posted via create_comment this run', async () => {
		const deps = makeDeps(
			createMockDocker({
				producesOutput: true,
				execStart: async (
					_execId: string,
					opts: { onChunk?: (c: { stream: string; text: string }) => Promise<void> },
				) => {
					// Simulate the agent posting the handoff itself this run, then echoing
					// the same @admin ask in its final message.
					const runRow = await db.query<{ id: string }>(
						`SELECT id FROM heartbeat_runs WHERE task_id = $1 AND status = 'running'`,
						[taskId],
					);
					await db.query(
						`INSERT INTO task_comments (task_id, author_member_id, content_type, content, created_by_run_id)
						 VALUES ($1, $2, 'text', $3::jsonb, $4)`,
						[
							taskId,
							agentId,
							JSON.stringify({ text: 'Posted the @admin question — awaiting your call.' }),
							runRow.rows[0].id,
						],
					);
					const event = JSON.stringify({
						type: 'result',
						is_error: false,
						result: '@admin — awaiting your call on Higgsfield.',
						usage: {},
					});
					await opts.onChunk?.({ stream: 'stdout', text: `${event}\n` });
					return { stdout: '', stderr: '' };
				},
			}),
		);

		const result = await runAgent(deps, makeAgent(), makeTask(), makeProject());

		// Exactly one comment — the one the agent posted; the guardrail added none.
		const comments = await textComments(result.heartbeatRunId);
		expect(comments.rows.length).toBe(1);
		expect(JSON.stringify(comments.rows[0].content)).toContain('awaiting your call');
	});

	it('posts nothing when the final message carries no active mention', async () => {
		const deps = makeDeps(
			createMockDocker({ producesOutput: true, execStart: streamResult('Done — all tests pass.') }),
		);

		const result = await runAgent(deps, makeAgent(), makeTask(), makeProject());
		expect(result.success).toBe(true);
		const comments = await textComments(result.heartbeatRunId);
		expect(comments.rows.length).toBe(0);
	});

	it('does not deliver on a non-clean exit even with an @admin final message', async () => {
		const deps = makeDeps(
			createMockDocker({
				producesOutput: false,
				execInspect: async () => ({ ExitCode: 1, Running: false, Pid: 0 }),
				execStart: streamResult('@admin — the build crashed, need a decision.', true),
			}),
		);

		const result = await runAgent(deps, makeAgent(), makeTask(), makeProject());
		expect(result.success).toBe(false);
		const comments = await textComments(result.heartbeatRunId);
		expect(comments.rows.length).toBe(0);
	});

	it('delivers a stranded @agent handoff (waking that agent) even when the run already produced output', async () => {
		const other = await db.query<{ id: string; slug: string }>(
			`SELECT ma.id, ma.slug FROM member_agents ma
			 JOIN members m ON m.id = ma.id
			 WHERE m.team_id = $1 AND ma.id <> $2 LIMIT 1`,
			[teamId, agentId],
		);
		expect(other.rows.length).toBe(1);
		const { id: otherId, slug: otherSlug } = other.rows[0];

		const deps = makeDeps(
			createMockDocker({
				producesOutput: true,
				execStart: streamResult(`Changes pushed — over to you @${otherSlug} for review.`),
			}),
		);

		const result = await runAgent(deps, makeAgent(), makeTask(), makeProject());
		expect(result.success).toBe(true);

		// The guardrail fired even though the run already produced output.
		const comments = await textComments(result.heartbeatRunId);
		expect(comments.rows.length).toBe(1);
		expect(JSON.stringify(comments.rows[0].content)).toContain(`@${otherSlug}`);

		// And the mentioned agent got a wakeup.
		const wakeups = await db.query(
			`SELECT 1 FROM agent_wakeup_requests WHERE member_id = $1 AND source = 'mention'`,
			[otherId],
		);
		expect(wakeups.rows.length).toBeGreaterThan(0);
	});
});
