import { AiProvider, ContainerStatus, HeartbeatRunStatus, WakeupSource } from '@hezo/shared';
import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { MasterKeyManager } from '../src/crypto/master-key';
import type { Db } from '../src/db/database';
import { runLogTextSql } from '../src/db/run-log-chunks';
import type { Env } from '../src/lib/types';
import { type RunnerDeps, runAgent } from '../src/services/agent-runner';
import { LogStreamBroker } from '../src/services/log-stream-broker';
import type { ContainerEngine } from '../src/services/sandbox/types';
import { safeClose } from './helpers';
import {
	authHeader,
	createStubDocker,
	createTestApp,
	createTestProject,
	createTestTeam,
	stubEngineSeams,
} from './helpers/app';
import { withRunUserStub } from './helpers/run-user-docker';

// The handoff-delivery guardrail: when a run ends (clean exit) with a reply in
// its FINAL MESSAGE that it never posted as a comment. Three stranded forms are
// handled differently: an active @-mention (the HM-103 failure — an @admin ask
// left only in the final message) is auto-delivered verbatim as a real comment so
// it actually wakes its target; an UNLINKED bold/leading address that reads as an
// ask (`**slug** — … when you resume …`) is NOT rewritten or delivered (that would
// guess intent and force a wake) — instead the runner surfaces a warning in the
// run log, matching create_comment's interactive warning for the path that skips
// it; and a plain DIRECT ANSWER to a human who replied to / @-mentioned the agent
// (the "give me the link" case) is delivered as a reply threaded under the waking
// comment, so the asker sees it in the thread. These tests boot a real app +
// PGlite and drive runAgent with a mock docker that streams a Claude Code
// `result` event.

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
		(t: { name: string }) => t.name === 'App Team',
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
function createMockDocker(overrides: Record<string, unknown> = {}): ContainerEngine {
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
		execInspect: execInspect ?? (async () => ({ ExitCode: 0, Running: false, Pid: 0 })),
		killRunProcesses: async () => {},
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
		// The run stages its prompt and runtime home through the engine seam, so an
		// inline engine needs the same bind-resolving view the shared stub gives.
		...stubEngineSeams(),
	});
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
		description: '',
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

function makeDeps(docker: ContainerEngine): RunnerDeps {
	return {
		db,
		docker,
		masterKeyManager,
		serverPort: 3000,
		dataDir: '/tmp/test-data-handoff',
		logs: new LogStreamBroker(),
	};
}

/**
 * `RunResult.heartbeatRunId` is optional - a run that never got as far as
 * registering has none - so narrow it here rather than at a dozen call sites.
 * A missing id in these tests means the run did not start, which is a failure
 * worth naming rather than a comment query returning nothing.
 */
function runIdOf(result: { heartbeatRunId?: string }): string {
	const id = result.heartbeatRunId;
	if (!id) throw new Error('run produced no heartbeat run id');
	return id;
}

async function textComments(runId: string) {
	return db.query<{
		id: string;
		author_member_id: string;
		content: unknown;
		parent_comment_id: string | null;
	}>(
		`SELECT id, author_member_id, content, parent_comment_id FROM task_comments
		 WHERE task_id = $1 AND content_type = 'text' AND created_by_run_id = $2`,
		[taskId, runId],
	);
}

/** Insert a text comment on the shared task, returning its id. `author` null = admin/human. */
async function seedComment(
	author: string | null,
	text: string,
	parentCommentId: string | null = null,
): Promise<string> {
	const r = await db.query<{ id: string }>(
		`INSERT INTO task_comments (task_id, author_member_id, parent_comment_id, content_type, content)
		 VALUES ($1, $2, $3, 'text', $4::jsonb) RETURNING id`,
		[taskId, author, parentCommentId, JSON.stringify({ text })],
	);
	return r.rows[0].id;
}

/** Create a real wakeup row so runAgent has a valid wakeup_id to attach the run to. */
async function createWakeupRow(
	source: WakeupSource,
	payload: Record<string, unknown>,
	key: string,
): Promise<string> {
	const r = await db.query<{ id: string }>(
		`INSERT INTO agent_wakeup_requests (member_id, team_id, source, payload, idempotency_key)
		 VALUES ($1, $2, $3::wakeup_source, $4::jsonb, $5) RETURNING id`,
		[agentId, teamId, source, JSON.stringify(payload), key],
	);
	return r.rows[0].id;
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
		const runId = runIdOf(result);

		// The no-op run became a success because the guardrail produced a comment.
		expect(result.success).toBe(true);
		const run = await db.query<{ status: string; produced_output: boolean; log_text: string }>(
			`SELECT status, produced_output, ${runLogTextSql('heartbeat_runs.id')} AS log_text FROM heartbeat_runs WHERE id = $1`,
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
		const comments = await textComments(runIdOf(result));
		expect(comments.rows.length).toBe(1);
		expect(JSON.stringify(comments.rows[0].content)).toContain('awaiting your call');
	});

	it('posts nothing when the final message carries no active mention', async () => {
		const deps = makeDeps(
			createMockDocker({ producesOutput: true, execStart: streamResult('Done — all tests pass.') }),
		);

		const result = await runAgent(deps, makeAgent(), makeTask(), makeProject());
		expect(result.success).toBe(true);
		const comments = await textComments(runIdOf(result));
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
		const comments = await textComments(runIdOf(result));
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
		const comments = await textComments(runIdOf(result));
		expect(comments.rows.length).toBe(1);
		expect(JSON.stringify(comments.rows[0].content)).toContain(`@${otherSlug}`);

		// And the mentioned agent got a wakeup.
		const wakeups = await db.query(
			`SELECT 1 FROM agent_wakeup_requests WHERE member_id = $1 AND source = 'mention'`,
			[otherId],
		);
		expect(wakeups.rows.length).toBeGreaterThan(0);
	});

	it('warns about a stranded bold-name handoff but does not deliver or wake', async () => {
		const other = await db.query<{ id: string; slug: string }>(
			`SELECT ma.id, ma.slug FROM member_agents ma
			 JOIN members m ON m.id = ma.id
			 WHERE m.team_id = $1 AND ma.id <> $2 LIMIT 1`,
			[teamId, agentId],
		);
		const { id: otherId, slug: otherSlug } = other.rows[0];
		// Clear any mention wakeups a prior test in this file left for this agent —
		// tests share one db/task, so we assert on wakeups this run creates, not the
		// accumulated total.
		await db.query(`DELETE FROM agent_wakeup_requests WHERE member_id = $1`, [otherId]);

		// The exact screenshot failure: a bold-name handoff that reads as an ask
		// ("when you resume …") but carries no `@`, so it wakes no one as-is.
		const deps = makeDeps(
			createMockDocker({
				producesOutput: true,
				execStart: streamResult(
					`Assessment complete. **${otherSlug}** — the tracker is ready for you to incorporate when you resume HC-1.`,
				),
			}),
		);

		const result = await runAgent(deps, makeAgent(), makeTask(), makeProject());
		expect(result.success).toBe(true);

		// The runner did NOT rewrite the message or auto-deliver it: no comment posted.
		const comments = await textComments(runIdOf(result));
		expect(comments.rows.length).toBe(0);

		// No teammate was force-woken.
		const wakeups = await db.query(
			`SELECT 1 FROM agent_wakeup_requests WHERE member_id = $1 AND source = 'mention'`,
			[otherId],
		);
		expect(wakeups.rows.length).toBe(0);

		// Instead, the stranded handoff is surfaced as a warning in the run log,
		// naming the teammate and the active-mention fix.
		const run = await db.query<{ log_text: string }>(
			`SELECT ${runLogTextSql('heartbeat_runs.id')} AS log_text FROM heartbeat_runs WHERE id = $1`,
			[result.heartbeatRunId],
		);
		expect(run.rows[0].log_text).toContain('wakes no one');
		expect(run.rows[0].log_text).toContain(`@${otherSlug}`);
	});

	it('warns about a stranded "awaiting <slug> sign-off" recap but does not deliver or wake', async () => {
		const other = await db.query<{ id: string; slug: string }>(
			`SELECT ma.id, ma.slug FROM member_agents ma
			 JOIN members m ON m.id = ma.id
			 WHERE m.team_id = $1 AND ma.id <> $2 LIMIT 1`,
			[teamId, agentId],
		);
		const { id: otherId, slug: otherSlug } = other.rows[0];
		await db.query(`DELETE FROM agent_wakeup_requests WHERE member_id = $1`, [otherId]);

		// The exact screenshot incident: a completion report that correctly leaves the
		// ticket in `review` but hands off via a stative "awaiting <slug> sign-off"
		// recap — the name is mid-sentence, bound to the sign-off gate, no `@`, so it
		// wakes no one as-is. detectUnlinkedTeammateAsks now catches this bound form.
		const deps = makeDeps(
			createMockDocker({
				producesOutput: true,
				execStart: streamResult(
					`Review complete. Draft passes all checks. The ticket stays in review awaiting ${otherSlug} sign-off.`,
				),
			}),
		);

		const result = await runAgent(deps, makeAgent(), makeTask(), makeProject());
		expect(result.success).toBe(true);

		// Not delivered, not rewritten (the "agent posts it itself" posture): no
		// comment posted, no teammate force-woken.
		const comments = await textComments(runIdOf(result));
		expect(comments.rows.length).toBe(0);
		const wakeups = await db.query(
			`SELECT 1 FROM agent_wakeup_requests WHERE member_id = $1 AND source = 'mention'`,
			[otherId],
		);
		expect(wakeups.rows.length).toBe(0);

		// Surfaced as a run-log warning naming the teammate and the active-mention fix.
		const run = await db.query<{ log_text: string }>(
			`SELECT ${runLogTextSql('heartbeat_runs.id')} AS log_text FROM heartbeat_runs WHERE id = $1`,
			[result.heartbeatRunId],
		);
		expect(run.rows[0].log_text).toContain('wakes no one');
		expect(run.rows[0].log_text).toContain(`@${otherSlug}`);
	});

	it('warns about a stranded PASSIVE "Ready for @@<slug> review" verdict but does not deliver or wake', async () => {
		const other = await db.query<{ id: string; slug: string }>(
			`SELECT ma.id, ma.slug FROM member_agents ma
			 JOIN members m ON m.id = ma.id
			 WHERE m.team_id = $1 AND ma.id <> $2 LIMIT 1`,
			[teamId, agentId],
		);
		const { id: otherId, slug: otherSlug } = other.rows[0];
		await db.query(`DELETE FROM agent_wakeup_requests WHERE member_id = $1`, [otherId]);

		// The passive spelling of the same stranded handoff. `@@<slug>` renders as a
		// delivered-looking chip, so the verdict reads as routed while waking nobody —
		// the net has to treat it exactly like the bare name above, or the `@@` form
		// becomes the way around the check.
		const deps = makeDeps(
			createMockDocker({
				producesOutput: true,
				execStart: streamResult(
					`**Verdict:** APPROVED — the fix is correct and complete. Ready for @@${otherSlug} review.`,
				),
			}),
		);

		const result = await runAgent(deps, makeAgent(), makeTask(), makeProject());
		expect(result.success).toBe(true);

		// Not delivered, not rewritten, nobody force-woken.
		const comments = await textComments(runIdOf(result));
		expect(comments.rows.length).toBe(0);
		const wakeups = await db.query(
			`SELECT 1 FROM agent_wakeup_requests WHERE member_id = $1 AND source = 'mention'`,
			[otherId],
		);
		expect(wakeups.rows.length).toBe(0);

		const run = await db.query<{ log_text: string }>(
			`SELECT ${runLogTextSql('heartbeat_runs.id')} AS log_text FROM heartbeat_runs WHERE id = $1`,
			[result.heartbeatRunId],
		);
		expect(run.rows[0].log_text).toContain('wakes no one');
		expect(run.rows[0].log_text).toContain(`@${otherSlug}`);
	});

	it('does not warn about the sign-off recap when the run already posted the @-mention ask this turn', async () => {
		const other = await db.query<{ id: string; slug: string }>(
			`SELECT ma.id, ma.slug FROM member_agents ma
			 JOIN members m ON m.id = ma.id
			 WHERE m.team_id = $1 AND ma.id <> $2 LIMIT 1`,
			[teamId, agentId],
		);
		const { slug: otherSlug } = other.rows[0];

		const deps = makeDeps(
			createMockDocker({
				producesOutput: true,
				execStart: async (
					_execId: string,
					opts: { onChunk?: (c: { stream: string; text: string }) => Promise<void> },
				) => {
					// The agent DID post the active sign-off ask this run, then echoed the
					// stative recap in its final message — the delivered set must suppress it.
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
							JSON.stringify({ text: `@${otherSlug} — please sign off so I can close this.` }),
							runRow.rows[0].id,
						],
					);
					const event = JSON.stringify({
						type: 'result',
						is_error: false,
						result: `Review complete. The ticket stays in review awaiting ${otherSlug} sign-off.`,
						usage: {},
					});
					await opts.onChunk?.({ stream: 'stdout', text: `${event}\n` });
					return { stdout: '', stderr: '' };
				},
			}),
		);

		const result = await runAgent(deps, makeAgent(), makeTask(), makeProject());

		// Exactly one comment — the agent's own active ask; the guardrail added none.
		const comments = await textComments(runIdOf(result));
		expect(comments.rows.length).toBe(1);

		// And no stranded-handoff warning, because the ask was already delivered.
		const run = await db.query<{ log_text: string }>(
			`SELECT ${runLogTextSql('heartbeat_runs.id')} AS log_text FROM heartbeat_runs WHERE id = $1`,
			[result.heartbeatRunId],
		);
		expect(run.rows[0].log_text).not.toContain('wakes no one');
	});

	it("delivers a stranded direct answer to a human's reply as a threaded reply comment", async () => {
		// The screenshot case: admin replies asking for the link; the agent computes
		// it but leaves it only in its final message. It must land in the thread.
		const original = await seedComment(agentId, 'Draft is ready for the Indie Hackers launch.');
		const adminReply = await seedComment(
			null,
			"i'm adding hezo to indiehackers — give me the hezo.ai link with utm tags",
			original,
		);
		const wakeupPayload = {
			source: WakeupSource.Reply,
			task_id: taskId,
			comment_id: adminReply,
			triggering_comment_id: original,
		};
		const wakeupId = await createWakeupRow(
			WakeupSource.Reply,
			wakeupPayload,
			`reply:${adminReply}`,
		);

		const link =
			'https://hezo.ai/?utm_source=indiehackers&utm_medium=community&utm_campaign=launch';
		const deps = makeDeps(
			createMockDocker({
				producesOutput: false,
				execStart: streamResult(`Here's the link: ${link}`),
			}),
		);

		const result = await runAgent(
			deps,
			makeAgent(),
			makeTask(),
			makeProject(),
			wakeupPayload,
			undefined,
			undefined,
			wakeupId,
		);
		expect(result.success).toBe(true);

		const comments = await textComments(runIdOf(result));
		expect(comments.rows.length).toBe(1);
		expect(comments.rows[0].author_member_id).toBe(agentId);
		expect(JSON.stringify(comments.rows[0].content)).toContain(link);
		// Threaded under the admin's question, not posted top-level.
		expect(comments.rows[0].parent_comment_id).toBe(adminReply);

		const run = await db.query<{ produced_output: boolean; log_text: string }>(
			`SELECT produced_output, ${runLogTextSql('heartbeat_runs.id')} AS log_text FROM heartbeat_runs WHERE id = $1`,
			[result.heartbeatRunId],
		);
		expect(run.rows[0].produced_output).toBe(true);
		expect(run.rows[0].log_text).toContain('answered a direct question');
	});

	it('delivers a stranded direct answer to a human @-mention as a reply', async () => {
		const mention = await seedComment(null, "what's the launch link?");
		const wakeupPayload = {
			source: WakeupSource.Mention,
			task_id: taskId,
			comment_id: mention,
		};
		const wakeupId = await createWakeupRow(
			WakeupSource.Mention,
			wakeupPayload,
			`mention:${mention}`,
		);

		const deps = makeDeps(
			createMockDocker({
				producesOutput: false,
				execStart: streamResult('The launch link is https://hezo.ai/?utm_campaign=launch'),
			}),
		);

		const result = await runAgent(
			deps,
			makeAgent(),
			makeTask(),
			makeProject(),
			wakeupPayload,
			undefined,
			undefined,
			wakeupId,
		);
		expect(result.success).toBe(true);
		const comments = await textComments(runIdOf(result));
		expect(comments.rows.length).toBe(1);
		expect(comments.rows[0].parent_comment_id).toBe(mention);
	});

	it('does not deliver a direct answer the run already posted itself', async () => {
		const adminReply = await seedComment(null, 'give me the link again please');
		const wakeupPayload = {
			source: WakeupSource.Reply,
			task_id: taskId,
			comment_id: adminReply,
			triggering_comment_id: adminReply,
		};
		const wakeupId = await createWakeupRow(
			WakeupSource.Reply,
			wakeupPayload,
			`reply-posted:${adminReply}`,
		);

		const deps = makeDeps(
			createMockDocker({
				producesOutput: true,
				execStart: async (
					_execId: string,
					opts: { onChunk?: (c: { stream: string; text: string }) => Promise<void> },
				) => {
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
							JSON.stringify({ text: 'Posted it here: https://hezo.ai/?utm_campaign=launch' }),
							runRow.rows[0].id,
						],
					);
					const event = JSON.stringify({
						type: 'result',
						is_error: false,
						result: 'Sent the link.',
						usage: {},
					});
					await opts.onChunk?.({ stream: 'stdout', text: `${event}\n` });
					return { stdout: '', stderr: '' };
				},
			}),
		);

		const result = await runAgent(
			deps,
			makeAgent(),
			makeTask(),
			makeProject(),
			wakeupPayload,
			undefined,
			undefined,
			wakeupId,
		);
		// Exactly the one comment the run posted itself — no auto-delivered echo.
		const comments = await textComments(runIdOf(result));
		expect(comments.rows.length).toBe(1);
		expect(JSON.stringify(comments.rows[0].content)).toContain('Posted it here');
	});

	it('does not auto-deliver a direct answer to an agent-to-agent reply', async () => {
		const other = await db.query<{ id: string }>(
			`SELECT ma.id FROM member_agents ma
			 JOIN members m ON m.id = ma.id
			 WHERE m.team_id = $1 AND ma.id <> $2 LIMIT 1`,
			[teamId, agentId],
		);
		const otherId = other.rows[0].id;
		const agentReply = await seedComment(otherId, 'can you resend the link?');
		const wakeupPayload = {
			source: WakeupSource.Reply,
			task_id: taskId,
			comment_id: agentReply,
			triggering_comment_id: agentReply,
		};
		const wakeupId = await createWakeupRow(
			WakeupSource.Reply,
			wakeupPayload,
			`reply-agent:${agentReply}`,
		);

		const deps = makeDeps(
			createMockDocker({
				producesOutput: true,
				execStart: streamResult('The link is https://hezo.ai/?utm_campaign=launch'),
			}),
		);

		const result = await runAgent(
			deps,
			makeAgent(),
			makeTask(),
			makeProject(),
			wakeupPayload,
			undefined,
			undefined,
			wakeupId,
		);
		expect(result.success).toBe(true);
		// Agent-to-agent chatter is not auto-posted — the run left no comment.
		const comments = await textComments(runIdOf(result));
		expect(comments.rows.length).toBe(0);
	});

	it('does not warn on a bold teammate name used without ask intent', async () => {
		const other = await db.query<{ slug: string }>(
			`SELECT ma.slug FROM member_agents ma
			 JOIN members m ON m.id = ma.id
			 WHERE m.team_id = $1 AND ma.id <> $2 LIMIT 1`,
			[teamId, agentId],
		);
		const { slug: otherSlug } = other.rows[0];

		// Bold name used to credit/attribute, no directed ask → left alone entirely.
		const deps = makeDeps(
			createMockDocker({
				producesOutput: true,
				execStart: streamResult(`Shipped. Credit to **${otherSlug}** for the earlier analysis.`),
			}),
		);

		const result = await runAgent(deps, makeAgent(), makeTask(), makeProject());
		expect(result.success).toBe(true);
		const comments = await textComments(runIdOf(result));
		expect(comments.rows.length).toBe(0);
		const run = await db.query<{ log_text: string }>(
			`SELECT ${runLogTextSql('heartbeat_runs.id')} AS log_text FROM heartbeat_runs WHERE id = $1`,
			[result.heartbeatRunId],
		);
		expect(run.rows[0].log_text).not.toContain('wakes no one');
	});
});

// The structural backstop, which reads no prose at all: a run that ends having
// woken NOBODY, on a task it left open, after naming a teammate in a form that
// notifies no one. It exists because the guardrails above only inspect the FINAL
// MESSAGE and create_comment only inspects one comment at a time, so nothing
// looked at what a run achieved in aggregate — which is where a passively
// addressed ask posted as a comment lives.
describe('no-wake exit check', () => {
	async function otherAgent(): Promise<{ id: string; slug: string }> {
		const r = await db.query<{ id: string; slug: string }>(
			`SELECT ma.id, ma.slug FROM member_agents ma
			 JOIN members m ON m.id = ma.id
			 WHERE m.team_id = $1 AND ma.id <> $2 LIMIT 1`,
			[teamId, agentId],
		);
		return r.rows[0];
	}

	async function logFor(runId: string): Promise<string> {
		const r = await db.query<{ log_text: string }>(
			`SELECT ${runLogTextSql('heartbeat_runs.id')} AS log_text FROM heartbeat_runs WHERE id = $1`,
			[runId],
		);
		return r.rows[0].log_text;
	}

	it('warns when a run wakes no one on an open task while naming a teammate', async () => {
		const { slug } = await otherAgent();
		await db.query(`UPDATE tasks SET status = 'in_progress'::task_status WHERE id = $1`, [taskId]);
		// Deliberately carries NO ask vocabulary — none of the phrase-based
		// detectors fire on it, which is exactly what this check is for.
		const deps = makeDeps(
			createMockDocker({
				producesOutput: true,
				execStart: streamResult(`Analysis complete, alongside @@${slug}'s earlier notes.`),
			}),
		);
		const result = await runAgent(deps, makeAgent(), makeTask(), makeProject());
		expect(result.success).toBe(true);

		const log = await logFor(runIdOf(result));
		expect(log).toContain('woke no one');
		expect(log).toContain(`@${slug}`);
	});

	it('stays silent when the run actually woke someone', async () => {
		const { slug } = await otherAgent();
		await db.query(`UPDATE tasks SET status = 'in_progress'::task_status WHERE id = $1`, [taskId]);
		// An active mention is auto-delivered as a real comment by the guardrail
		// above, so the run HAS woken someone and this check must not fire.
		const deps = makeDeps(
			createMockDocker({
				producesOutput: true,
				execStart: streamResult(`@${slug} - please re-run the fixture.`),
			}),
		);
		const result = await runAgent(deps, makeAgent(), makeTask(), makeProject());
		expect(result.success).toBe(true);
		expect(await logFor(runIdOf(result))).not.toContain('woke no one');
	});

	it('stays silent when the task was closed', async () => {
		const { slug } = await otherAgent();
		await db.query(`UPDATE tasks SET status = 'done'::task_status WHERE id = $1`, [taskId]);
		// A terminal task routes through the status cascade, so naming a teammate
		// in the wrap-up is attribution and not a stranded handoff.
		const deps = makeDeps(
			createMockDocker({
				producesOutput: true,
				execStart: streamResult(`Shipped. Thanks to @@${slug} for the review.`),
			}),
		);
		const result = await runAgent(deps, makeAgent(), makeTask(), makeProject());
		expect(result.success).toBe(true);
		expect(await logFor(runIdOf(result))).not.toContain('woke no one');
		await db.query(`UPDATE tasks SET status = 'in_progress'::task_status WHERE id = $1`, [taskId]);
	});

	it('stays silent when the run names nobody', async () => {
		await db.query(`UPDATE tasks SET status = 'in_progress'::task_status WHERE id = $1`, [taskId]);
		const deps = makeDeps(
			createMockDocker({
				producesOutput: true,
				execStart: streamResult('Rebuilt the index and re-ran the import. No errors.'),
			}),
		);
		const result = await runAgent(deps, makeAgent(), makeTask(), makeProject());
		expect(result.success).toBe(true);
		expect(await logFor(runIdOf(result))).not.toContain('woke no one');
	});
});
