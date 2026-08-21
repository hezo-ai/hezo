// Prompt-assembly coverage for agent-runner.ts: the progress-update run (no
// task), the coach review prompt, mention/reply handoffs, requester-context
// and spawned-from substitution — all driven through the real runAgent path —
// plus direct branch tests for the pure builders and small helpers.

import { readFileSync } from 'node:fs';
import {
	AiAuthMethod,
	AiProvider,
	ContainerStatus,
	HeartbeatRunStatus,
	WakeupSource,
} from '@hezo/shared';
import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { MasterKeyManager } from '../src/crypto/master-key';
import type { Db } from '../src/db/database';
import type { Env } from '../src/lib/types';
import {
	buildProgressUpdatePrompt,
	buildProviderEnv,
	buildTaskPrompt,
	formatReactionLine,
	getContainerPromptPath,
	getHostPromptPath,
	loadAgentAttachmentsForComments,
	loadMentionContext,
	loadReplyContext,
	loadSpawnedFromTask,
	type RunnerDeps,
	runAgent,
	shellQuoteArg,
	type TaskInfo,
} from '../src/services/agent-runner';
import { LogStreamBroker } from '../src/services/log-stream-broker';
import type { ReactionGroup } from '../src/services/reactions';
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
let taskIdentifier: string;
let agentId: string;
let agentSlug: string | null;
let agentTitle: string;

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
	const teamRes = await createTestTeam(db, { name: 'Prompt Co', template_id: typeId });
	teamId = (await teamRes.json()).data.id;

	globalThis.fetch = vi.fn().mockResolvedValue({ ok: true }) as unknown as typeof fetch;
	await app.request('/api/ai-providers', {
		method: 'POST',
		headers: { ...authHeader(adminToken), 'Content-Type': 'application/json' },
		body: JSON.stringify({
			provider: 'anthropic',
			api_key: 'sk-ant-prompt-key',
			label: 'anthropic-prompt',
		}),
	});
	globalThis.fetch = originalFetch;

	const projectRes = await createTestProject(db, teamId, {
		name: 'Prompt Project',
		description: 'Prompt test project.',
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
	agentTitle = agentRow.title;

	const taskRes = await app.request(`/api/projects/${projectSlug}/tasks`, {
		method: 'POST',
		headers: { ...authHeader(adminToken), 'Content-Type': 'application/json' },
		body: JSON.stringify({
			project_id: projectId,
			title: 'Prompt Task',
			description: 'Prompt description',
			assignee_id: agentId,
		}),
	});
	const taskData = (await taskRes.json()).data;
	taskId = taskData.id;
	taskIdentifier = taskData.identifier;
});

afterAll(async () => {
	await safeClose(db);
});

function makeAgent(overrides: Record<string, unknown> = {}) {
	return { id: agentId, title: 'Prompt Agent', slug: agentSlug, team_id: teamId, ...overrides };
}

function makeTask(overrides: Partial<TaskInfo> = {}): TaskInfo {
	return {
		id: taskId,
		identifier: taskIdentifier,
		title: 'Prompt Task',
		description: 'Prompt description',
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
		team_slug: 'prompt-co',
		container_id: 'container-pr',
		container_status: ContainerStatus.Running,
		designated_repo_id: null,
		is_internal: false,
		...overrides,
	};
}

function readPromptFromExec(opts: { Env: string[] }): string {
	const entry = opts.Env.find((e) => e.startsWith('HEZO_PROMPT_FILE='));
	if (!entry) throw new Error('HEZO_PROMPT_FILE env var missing from exec');
	const runId = entry
		.slice('HEZO_PROMPT_FILE='.length)
		.split('/')
		.pop()!
		.replace(/\.txt$/, '');
	return readFileSync(getHostPromptPath(dataDir, teamId, projectId, runId), 'utf8');
}

function promptCaptureDocker(capture: { prompt: string; env: string[] }): ContainerEngine {
	const base = createStubDocker({
		execCreate: async (_id: string, opts: any) => {
			capture.prompt = readPromptFromExec(opts);
			capture.env = opts.Env;
			return 'exec-prompt';
		},
		execInspect: async () => ({ ExitCode: 0, Running: false, Pid: 0 }),
		execStart: async () => {
			await db.query(
				`UPDATE heartbeat_runs SET produced_output = true WHERE member_id = $1 AND status = 'running'`,
				[agentId],
			);
			return { stdout: 'ok', stderr: '' };
		},
	});
	return withRunUserStub(base as unknown as ContainerEngine);
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

describe('runAgent — per-runtime prompt notes', () => {
	it('appends the Codex tool-namespace note, and leaves other runtimes without it', async () => {
		// Codex exposes its own signed-in account's apps as tools beside the MCP
		// servers Hezo configures, and its config file offers no way to suppress
		// them. Its GitHub app is authorized against that account rather than this
		// project's connection, so it 404s on the project's repos - which reads as a
		// Hezo fault. Two runs lost themselves that way. No structural lever exists
		// (the tools cannot be turned off), so the note is the fix and this asserts
		// it reaches the prompt.
		await db.query(`DELETE FROM ai_provider_configs WHERE provider = 'openai'`);
		globalThis.fetch = vi.fn().mockResolvedValue({ ok: true }) as unknown as typeof fetch;
		await app.request('/api/ai-providers', {
			method: 'POST',
			headers: { ...authHeader(adminToken), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				provider: 'openai',
				api_key: 'sk-test-runtime-note',
				label: 'openai-runtime-note',
			}),
		});
		globalThis.fetch = originalFetch;

		const codex = { prompt: '', env: [] as string[] };
		await runAgent(
			baseDeps(promptCaptureDocker(codex)),
			makeAgent(),
			{ ...makeTask(), runtime_type: 'codex' as const },
			makeProject(),
		);
		expect(codex.prompt).toContain('Tool namespaces:');
		// The identification rule is the load-bearing half. A note that only says
		// "prefer the Hezo ones" is unusable: the Hezo prefix is the operator's
		// connector name, which need not mention the service, while Codex's own
		// family is literally `codex_apps` with `github` in the tool name. An agent
		// scanning for the service name therefore finds exactly one match and it is
		// the wrong one - which is how this failed in production.
		expect(codex.prompt).toContain('mcp__<connector>__<tool>');
		expect(codex.prompt).toContain('list_connectors');
		expect(codex.prompt).toContain('codex_apps');
		// The keep-set must be `A-Za-z0-9_` with NO hyphen. Two sanitizers compose:
		// Hezo's `safeName` keeps hyphens, then Codex's own replaces them with `_`
		// (openai/codex#14605, v0.116.0). `register_connector` slugs are hyphenated
		// by construction, so the earlier `A-Za-z0-9_-` wording misdescribed exactly
		// the connectors agents create - it sent them looking for a prefix that
		// never exists.
		expect(codex.prompt).toContain('`A-Za-z0-9_`');
		expect(codex.prompt).not.toContain('A-Za-z0-9_-');
		expect(codex.prompt).toContain('hyphens become underscores');

		// The default runtime ships no competing family, so it must not carry the
		// note. Guidance reaching a runtime it does not apply to is noise in every
		// prompt that runtime ever runs.
		const other = { prompt: '', env: [] as string[] };
		await runAgent(baseDeps(promptCaptureDocker(other)), makeAgent(), makeTask(), makeProject());
		expect(other.prompt).not.toContain('Tool namespaces:');
	});
});

describe('runAgent — progress-update run (no task)', () => {
	it('runs a task-less goal check with the progress prompt, env marker, and no run comment', async () => {
		const capture = { prompt: '', env: [] as string[] };
		const result = await runAgent(
			baseDeps(promptCaptureDocker(capture)),
			makeAgent(),
			null,
			makeProject(),
			undefined,
			undefined,
			undefined,
			undefined,
			{
				goals: [
					{
						id: 'goal-1',
						title: 'Ship v2',
						measurement: 'v2 is launched',
						actions: 'Cut the release',
						progress_percent: 40,
						health: 'on_track',
						status_blurb: 'Going fine',
						check_frequency: 'weekly',
						target_date: '2026-08-01',
					},
				],
			},
		);
		expect(result.success).toBe(true);

		expect(capture.prompt).toContain('## Progress Update');
		expect(capture.prompt).toContain('1 goal is also due for a progress check');
		expect(capture.prompt).toContain('### Ship v2  `goal-1`');
		expect(capture.prompt).toContain('deadline 2026-08-01');
		expect(capture.prompt).toContain('- Last status: Going fine');
		expect(capture.prompt).toContain('- Achieved when: v2 is launched');
		expect(capture.prompt).toContain('- Suggested actions: Cut the release');

		expect(capture.env).toContain('HEZO_PROGRESS_UPDATE=1');
		expect(capture.env.some((e) => e.startsWith('HEZO_TASK_ID='))).toBe(false);

		const run = await db.query<{ kind: string; task_id: string | null; status: string }>(
			'SELECT kind::text AS kind, task_id, status FROM heartbeat_runs WHERE id = $1',
			[result.heartbeatRunId],
		);
		expect(run.rows[0].kind).toBe('progress_update');
		expect(run.rows[0].task_id).toBeNull();
		expect(run.rows[0].status).toBe(HeartbeatRunStatus.Succeeded);

		// No Run comment is anchored anywhere for a task-less run.
		const comments = await db.query<{ c: number }>(
			`SELECT COUNT(*)::int AS c FROM task_comments WHERE content->>'run_id' = $1`,
			[result.heartbeatRunId],
		);
		expect(comments.rows[0].c).toBe(0);
	});
});

describe('runAgent — coach review prompt', () => {
	it('assembles the review prompt with agents involved, reactions, attachments, and non-text comments', async () => {
		const revRes = await app.request(`/api/projects/${projectSlug}/tasks`, {
			method: 'POST',
			headers: { ...authHeader(adminToken), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				project_id: projectId,
				title: 'Reviewed Task',
				description: 'Review me',
				assignee_id: agentId,
			}),
		});
		const rev = (await revRes.json()).data;

		const textComment = await db.query<{ id: string }>(
			`INSERT INTO task_comments (task_id, author_member_id, content_type, content)
			 VALUES ($1, $2, 'text', $3::jsonb) RETURNING id`,
			[rev.id, agentId, JSON.stringify({ text: 'Work finished after two attempts.' })],
		);
		const textId = textComment.rows[0].id;
		await db.query(
			`INSERT INTO task_comments (task_id, author_member_id, content_type, content)
			 VALUES ($1, $2, 'system'::comment_content_type, $3::jsonb)`,
			[rev.id, agentId, JSON.stringify({ from: 'backlog', to: 'done' })],
		);
		await db.query(
			`INSERT INTO comment_reactions (comment_id, member_id, kind) VALUES ($1, $2, 'ack')`,
			[textId, agentId],
		);
		const asset = await db.query<{ id: string }>(
			`INSERT INTO assets (team_id, project_id, original_filename, content_type, byte_size, sha256, uploaded_by_member_id)
			 VALUES ($1, $2, 'trace.log', 'text/plain', 512, $3, NULL) RETURNING id`,
			[teamId, projectId, `sha-${rev.id}-trace`],
		);
		await db.query(`INSERT INTO comment_attachments (comment_id, asset_id) VALUES ($1, $2)`, [
			textId,
			asset.rows[0].id,
		]);

		const capture = { prompt: '', env: [] as string[] };
		const result = await runAgent(
			baseDeps(promptCaptureDocker(capture)),
			makeAgent(),
			makeTask({
				id: rev.id,
				identifier: rev.identifier,
				title: 'Reviewed Task',
				description: 'Review me',
				status: 'done',
				rules: 'Be kind',
				progress_summary: 'All done',
			}),
			makeProject(),
			{ trigger: 'task_done' },
		);
		expect(result.success).toBe(true);

		expect(capture.prompt).toContain(`## Review Completed Task: ${rev.identifier} — Reviewed Task`);
		expect(capture.prompt).toContain('**Final Status:** done');
		expect(capture.prompt).toContain('### Rules\nBe kind');
		expect(capture.prompt).toContain('### Progress Summary\nAll done');
		expect(capture.prompt).toContain('### Agents Involved');
		expect(capture.prompt).toContain(`(slug: ${agentSlug}, id: ${agentId})`);
		expect(capture.prompt).toContain('Work finished after two attempts.');
		// The system comment renders as raw JSON.
		expect(capture.prompt).toContain('"from":"backlog"');
		// Reaction + attachment lines.
		expect(capture.prompt).toContain('Reactions: ✓');
		expect(capture.prompt).toContain('attachment: trace.log (text/plain, 512 bytes) → download:');
	});
});

describe('runAgent — mention and reply handoffs', () => {
	it('renders the mention handoff with the author fallback, quoted excerpt, and open tasks', async () => {
		const comment = await db.query<{ id: string }>(
			`INSERT INTO task_comments (task_id, author_member_id, content_type, content)
			 VALUES ($1, NULL, 'text', $2::jsonb) RETURNING id`,
			[taskId, JSON.stringify({ text: 'Please look\nat the flaky test.' })],
		);
		const commentId = comment.rows[0].id;

		const capture = { prompt: '', env: [] as string[] };
		const result = await runAgent(
			baseDeps(promptCaptureDocker(capture)),
			makeAgent(),
			makeTask(),
			makeProject(),
			{ source: WakeupSource.Mention, comment_id: commentId },
		);
		expect(result.success).toBe(true);

		expect(capture.prompt).toContain('## Mention Handoff');
		expect(capture.prompt).toContain(`You were mentioned by Admin in ${taskIdentifier}`);
		// Multi-line excerpt rendered as a quote block.
		expect(capture.prompt).toContain('> Please look\n> at the flaky test.');
		expect(capture.prompt).toContain('### Your open tasks');
		expect(capture.prompt).toContain(`- ${taskIdentifier} — Prompt Task`);
		expect(capture.prompt).toContain(`add_reaction(comment_id='${commentId}', kind='ack')`);
		expect(capture.prompt).toContain(`parent_task_id = ${taskId}`);

		await db.query('DELETE FROM task_comments WHERE id = $1', [commentId]);
	});

	it('renders the reply handoff with the agent responder label and referenced tasks', async () => {
		const original = await db.query<{ id: string }>(
			`INSERT INTO task_comments (task_id, author_member_id, content_type, content)
			 VALUES ($1, NULL, 'text', $2::jsonb) RETURNING id`,
			[taskId, JSON.stringify({ text: 'What is the plan?' })],
		);
		const reply = await db.query<{ id: string }>(
			`INSERT INTO task_comments (task_id, author_member_id, content_type, content)
			 VALUES ($1, $2, 'text', $3::jsonb) RETURNING id`,
			[taskId, agentId, JSON.stringify({ text: `The plan is tracked in ${taskIdentifier}.` })],
		);

		const capture = { prompt: '', env: [] as string[] };
		const result = await runAgent(
			baseDeps(promptCaptureDocker(capture)),
			makeAgent(),
			makeTask(),
			makeProject(),
			{
				source: WakeupSource.Reply,
				comment_id: reply.rows[0].id,
				triggering_comment_id: original.rows[0].id,
			},
		);
		expect(result.success).toBe(true);

		expect(capture.prompt).toContain('## Reply Received');
		// Agent-authored reply → member_agents title + @slug label.
		expect(capture.prompt).toContain(`${agentTitle} (@${agentSlug}) replied on ${taskIdentifier}`);
		expect(capture.prompt).toContain('> What is the plan?');
		expect(capture.prompt).toContain(`> The plan is tracked in ${taskIdentifier}.`);
		expect(capture.prompt).toContain('### Tasks referenced by the reply');
		expect(capture.prompt).toContain(`- ${taskIdentifier} — Prompt Task`);

		await db.query('DELETE FROM task_comments WHERE id = ANY($1::uuid[])', [
			[original.rows[0].id, reply.rows[0].id],
		]);
	});

	it('substitutes {{requester_context}} with the task creator line', async () => {
		await db.query(
			`INSERT INTO documents (team_id, member_agent_id, type, slug, content)
			 VALUES ($1, $2, 'agent_system_prompt', 'system-prompt', $3)
			 ON CONFLICT (member_agent_id) WHERE type = 'agent_system_prompt'
			 DO UPDATE SET content = EXCLUDED.content`,
			[teamId, agentId, 'You are an agent.\n\n{{requester_context}}\n'],
		);
		// Point the creator at a member whose display_name resolves in the join.
		await db.query(`UPDATE members SET display_name = 'Casey Requester' WHERE id = $1`, [agentId]);
		await db.query('UPDATE tasks SET created_by_member_id = $1 WHERE id = $2', [agentId, taskId]);
		const capture = { prompt: '', env: [] as string[] };
		const result = await runAgent(
			baseDeps(promptCaptureDocker(capture)),
			makeAgent(),
			makeTask(),
			makeProject(),
		);
		expect(result.success).toBe(true);
		// resolveSystemPrompt (template-resolver.ts) strips {{requester_context}}
		// before agent-runner's own substitution branch can see it, so the marker
		// must be gone from the delivered prompt. (agent-runner.ts's creator-line
		// substitution at buildRunContext is unreachable as a result — see the
		// unconditional strip at template-resolver.ts:354.)
		expect(capture.prompt).not.toContain('{{requester_context}}');
		expect(capture.prompt).not.toContain('This task was created by');

		await db.query('UPDATE tasks SET created_by_member_id = NULL WHERE id = $1', [taskId]);
		await db.query(
			`DELETE FROM documents WHERE member_agent_id = $1 AND type = 'agent_system_prompt'`,
			[agentId],
		);
	});

	it('renders parent + spawned-from provenance lines in the task prompt', async () => {
		const mk = async (title: string) => {
			const res = await app.request(`/api/projects/${projectSlug}/tasks`, {
				method: 'POST',
				headers: { ...authHeader(adminToken), 'Content-Type': 'application/json' },
				body: JSON.stringify({
					project_id: projectId,
					title,
					description: 'd',
					assignee_id: agentId,
				}),
			});
			const body = await res.json();
			expect(res.status).toBe(201);
			return body.data as { id: string; identifier: string };
		};
		const parent = await mk('Parent Work');
		const spawner = await mk('Spawning Work');
		const wakeup = await db.query<{ id: string }>(
			`INSERT INTO agent_wakeup_requests (member_id, team_id, source, status, payload, claimed_at)
			 VALUES ($1, $2, 'on_demand'::wakeup_source, 'claimed'::wakeup_status, '{}'::jsonb, now())
			 RETURNING id`,
			[agentId, teamId],
		);
		const spawnRun = await db.query<{ id: string }>(
			`INSERT INTO heartbeat_runs (member_id, team_id, task_id, wakeup_id, status)
			 VALUES ($1, $2, $3, $4, 'succeeded'::heartbeat_run_status) RETURNING id`,
			[agentId, teamId, spawner.id, wakeup.rows[0].id],
		);

		const capture = { prompt: '', env: [] as string[] };
		const result = await runAgent(
			baseDeps(promptCaptureDocker(capture)),
			makeAgent(),
			makeTask({ parent_task_id: parent.id, created_by_run_id: spawnRun.rows[0].id }),
			makeProject(),
		);
		expect(result.success).toBe(true);
		expect(capture.prompt).toContain(`**Parent task:** ${parent.identifier} — Parent Work`);
		expect(capture.prompt).toContain(
			`**Spawned from:** ${spawner.identifier} — Spawning Work (provenance only`,
		);

		await db.query('DELETE FROM heartbeat_runs WHERE id = $1', [spawnRun.rows[0].id]);
		await db.query('DELETE FROM tasks WHERE id = ANY($1::uuid[])', [[parent.id, spawner.id]]);
	});
});

describe('prompt builders (direct)', () => {
	it('buildProgressUpdatePrompt uses plural phrasing and omits optional lines for sparse goals', () => {
		const prompt = buildProgressUpdatePrompt('SYS', {
			goals: [
				{
					id: 'g1',
					title: 'Goal One',
					measurement: '',
					actions: '',
					progress_percent: 0,
					health: 'at_risk',
					status_blurb: '',
					check_frequency: 'daily',
					target_date: null,
				},
				{
					id: 'g2',
					title: 'Goal Two',
					measurement: 'Two done',
					actions: 'Push',
					progress_percent: 90,
					health: 'on_track',
					status_blurb: 'Nearly',
					check_frequency: 'weekly',
					target_date: '2026-12-31',
				},
			],
		});
		expect(prompt).toContain('2 goals are also due for a progress check');
		expect(prompt).toContain('- Achieved when: Not specified.');
		expect(prompt).not.toContain('- Last status: \n');
		expect(prompt).toContain('deadline 2026-12-31');
		expect(prompt).toContain('- Suggested actions: Push');
	});

	// The run is progress-first: the summary rewrite and the tasks it is written from lead, and the
	// goal section only exists when goals are actually due. A project with none still gets a full
	// prompt.
	it('buildProgressUpdatePrompt leads with the summary and omits the goal section entirely', () => {
		const prompt = buildProgressUpdatePrompt('SYS', {
			goals: [],
			activityCandidates: {
				actioned: [
					{
						identifier: 'PA-1',
						title: 'Card payments',
						status: 'in_progress',
						actor: 'Engineer',
						at: '2026-01-01T00:00:00Z',
						excerpt: 'Cards clear in staging.',
					},
				],
				created: [],
				closed: [],
			},
		});
		expect(prompt).toContain('Refresh this project');
		expect(prompt).toContain('## What moved');
		expect(prompt).toContain('`PA-1` Card payments');
		expect(prompt).toContain('Cards clear in staging.');
		// The candidates are raw material, never a list to reproduce.
		expect(prompt).toContain('not a list to reproduce');
		// An empty group says so rather than being dropped silently.
		expect(prompt).toContain('(nothing yet)');
		// No goals due: the whole goal section is absent, not an empty heading.
		expect(prompt).not.toContain('## Goals due for a check');
		expect(prompt).not.toContain('update_goal_progress');
	});

	// A partial or absent candidates object must render, not throw — it is a pure formatter.
	it('buildProgressUpdatePrompt tolerates a context with no candidates', () => {
		const prompt = buildProgressUpdatePrompt('SYS', { goals: [] });
		expect(prompt).toContain('## What moved');
		expect(prompt).toContain('(nothing yet)');
	});

	it('buildTaskPrompt renders the retry block with exit code and output tails', () => {
		const prompt = buildTaskPrompt('SYS', makeTask(), {
			previous_failure: { exit_code: 3, stderr_tail: 'boom', stdout_tail: 'last words' },
			retry_count: 2,
			max_retries: 5,
		});
		expect(prompt).toContain('## Retry Attempt 2/5');
		expect(prompt).toContain('**Exit code:** 3');
		expect(prompt).toContain('boom');
		expect(prompt).toContain('last words');
	});

	it('buildTaskPrompt omits the exit-code line for a null exit code and falls back on an empty description', () => {
		const prompt = buildTaskPrompt('SYS', makeTask({ description: '' }), {
			previous_failure: { exit_code: null, stderr_tail: 'err only' },
			retry_count: 1,
			max_retries: 3,
		});
		expect(prompt).toContain('No description provided.');
		expect(prompt).not.toContain('**Exit code:**');
		expect(prompt).toContain('err only');
	});

	it('buildTaskPrompt renders rules and progress summary sections when present', () => {
		const prompt = buildTaskPrompt(
			'SYS',
			makeTask({ rules: 'Test everything', progress_summary: 'Halfway' }),
		);
		expect(prompt).toContain('### Rules for this task\nTest everything');
		expect(prompt).toContain('### Progress Summary\nHalfway');
	});

	it('mention handoff falls back to "(empty)" excerpt and "none" tasks', () => {
		const prompt = buildTaskPrompt(
			'SYS',
			makeTask(),
			{ source: WakeupSource.Mention },
			{
				mentionContext: {
					authorName: 'Admin',
					excerpt: '',
					openTickets: [],
					triggeringCommentId: 'c-1',
				},
			},
		);
		expect(prompt).toContain('## Mention Handoff');
		expect(prompt).toContain('> (empty)');
		expect(prompt).toContain('### Your open tasks\nnone');
	});

	it('reply handoff falls back for empty excerpts, no referenced tasks, and a slugless responder', () => {
		const prompt = buildTaskPrompt(
			'SYS',
			makeTask(),
			{ source: WakeupSource.Reply },
			{
				replyContext: {
					responderName: 'Sam',
					responderSlug: null,
					replyExcerpt: '',
					originalExcerpt: '',
					referencedTasks: [],
				},
			},
		);
		expect(prompt).toContain('## Reply Received');
		expect(prompt).toContain(`Sam replied on ${taskIdentifier}`);
		expect(prompt).not.toContain('(@');
		expect(prompt).toContain('### Tasks referenced by the reply\nnone');
		// Both the reply and original excerpts render the empty quote fallback.
		expect(prompt.match(/> \(empty\)/g)?.length).toBe(2);
	});
});

describe('small helpers (direct)', () => {
	it('formatReactionLine maps glyphs, labels, and fallbacks', () => {
		expect(formatReactionLine(undefined)).toBeNull();
		expect(formatReactionLine([])).toBeNull();
		const groups: ReactionGroup[] = [
			{
				kind: 'ack',
				members: [
					{ slug: 'dev', display_name: 'Dev' },
					{ slug: null, display_name: 'Human' },
					{ slug: null, display_name: null },
				],
			},
			{ kind: 'wave', members: [{ slug: 'qa', display_name: 'QA' }] },
		] as unknown as ReactionGroup[];
		expect(formatReactionLine(groups)).toBe('Reactions: ✓ @dev, Human, someone · wave @qa');
	});

	it('shellQuoteArg quotes only what needs quoting', () => {
		expect(shellQuoteArg('')).toBe("''");
		expect(shellQuoteArg('plain-arg_1.0')).toBe('plain-arg_1.0');
		expect(shellQuoteArg('has space')).toBe("'has space'");
		expect(shellQuoteArg("it's")).toBe(`'it'\\''s'`);
	});

	it('buildProviderEnv composes quiet env, static env, and the auth-method credential var', () => {
		const anthropicKey = buildProviderEnv(AiProvider.Anthropic, {
			configId: 'c1',
			value: 'sk-ant-x',
			authMethod: AiAuthMethod.ApiKey,
			defaultModel: null,
		} as any);
		expect(anthropicKey).toContain('ANTHROPIC_API_KEY=sk-ant-x');

		const anthropicSub = buildProviderEnv(AiProvider.Anthropic, {
			configId: 'c2',
			value: 'oauth-token',
			authMethod: AiAuthMethod.Subscription,
			defaultModel: null,
		} as any);
		expect(anthropicSub).toContain('CLAUDE_CODE_OAUTH_TOKEN=oauth-token');

		// OpenAI subscription auth is file-mounted — no credential env var at all.
		const openaiSub = buildProviderEnv(AiProvider.OpenAI, {
			configId: 'c3',
			value: '{"tokens":{}}',
			authMethod: AiAuthMethod.Subscription,
			defaultModel: null,
		} as any);
		expect(openaiSub.some((e) => e.includes('{"tokens":{}}'))).toBe(false);

		// Gemini runtime env is stamped for Google.
		const google = buildProviderEnv(AiProvider.Google, {
			configId: 'c4',
			value: 'AIza-key',
			authMethod: AiAuthMethod.ApiKey,
			defaultModel: null,
		} as any);
		expect(google.some((e) => e.endsWith('=AIza-key'))).toBe(true);

		// DeepSeek routes Claude Code at its own base URL via staticEnv.
		const deepseek = buildProviderEnv(AiProvider.DeepSeek, {
			configId: 'c5',
			value: 'sk-ds',
			authMethod: AiAuthMethod.ApiKey,
			defaultModel: null,
		} as any);
		expect(deepseek.some((e) => e.startsWith('ANTHROPIC_BASE_URL='))).toBe(true);
	});

	it('prompt path helpers agree on the per-run file name', () => {
		expect(getContainerPromptPath('run-1')).toBe('/workspace/.hezo/prompts/run-1.txt');
		expect(getHostPromptPath('/data', 'team', 'proj', 'run-1').endsWith('/prompts/run-1.txt')).toBe(
			true,
		);
	});
});

describe('context loaders (direct edge cases)', () => {
	it('loadMentionContext returns null without a comment id or with an unknown comment', async () => {
		expect(await loadMentionContext(db, agentId, teamId, {})).toBeNull();
		expect(
			await loadMentionContext(db, agentId, teamId, {
				comment_id: '00000000-0000-0000-0000-000000000000',
			}),
		).toBeNull();
	});

	it('loadMentionContext extracts text from nested (non-string) comment content', async () => {
		const comment = await db.query<{ id: string }>(
			`INSERT INTO task_comments (task_id, author_member_id, content_type, content)
			 VALUES ($1, $2, 'text', $3::jsonb) RETURNING id`,
			[taskId, agentId, JSON.stringify({ nested: { text: 'inner body' } })],
		);
		const ctx = await loadMentionContext(db, agentId, teamId, {
			comment_id: comment.rows[0].id,
		});
		expect(ctx).not.toBeNull();
		expect(ctx!.excerpt).toBe('inner body');
		// Agent-authored → the member_agents title resolves as author.
		expect(ctx!.authorName).toBe(agentTitle);
		await db.query('DELETE FROM task_comments WHERE id = $1', [comment.rows[0].id]);
	});

	it('loadReplyContext returns null for missing ids and missing rows', async () => {
		expect(await loadReplyContext(db, {})).toBeNull();
		expect(
			await loadReplyContext(db, {
				comment_id: '00000000-0000-0000-0000-000000000000',
				triggering_comment_id: '00000000-0000-0000-0000-000000000000',
			}),
		).toBeNull();
		const reply = await db.query<{ id: string }>(
			`INSERT INTO task_comments (task_id, author_member_id, content_type, content)
			 VALUES ($1, NULL, 'text', $2::jsonb) RETURNING id`,
			[taskId, JSON.stringify({ text: 'orphan reply' })],
		);
		expect(
			await loadReplyContext(db, {
				comment_id: reply.rows[0].id,
				triggering_comment_id: '00000000-0000-0000-0000-000000000000',
			}),
		).toBeNull();
		await db.query('DELETE FROM task_comments WHERE id = $1', [reply.rows[0].id]);
	});

	it('loadSpawnedFromTask returns null with no provenance and collapses parent==spawner', async () => {
		expect(await loadSpawnedFromTask(db, makeTask())).toBeNull();

		const parentRes = await app.request(`/api/projects/${projectSlug}/tasks`, {
			method: 'POST',
			headers: { ...authHeader(adminToken), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				project_id: projectId,
				title: 'Both Parent',
				description: 'd',
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
		expect(out!.parentLine).toContain('Both Parent');
		expect(out!.spawnLine).toBeNull();

		// Parent-only provenance (no spawning run) keeps spawnLine null too.
		const parentOnly = await loadSpawnedFromTask(db, makeTask({ parent_task_id: parent.id }));
		expect(parentOnly).not.toBeNull();
		expect(parentOnly!.parentLine).toContain('Both Parent');
		expect(parentOnly!.spawnLine).toBeNull();

		await db.query('DELETE FROM heartbeat_runs WHERE id = $1', [run.rows[0].id]);
		await db.query('DELETE FROM tasks WHERE id = $1', [parent.id]);
	});

	it('loadAgentAttachmentsForComments short-circuits on an empty id list', async () => {
		const out = await loadAgentAttachmentsForComments(
			db,
			[],
			masterKeyManager,
			'http://127.0.0.1:47081',
		);
		expect(out.size).toBe(0);
	});
});
