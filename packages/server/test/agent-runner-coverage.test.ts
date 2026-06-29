import type { PGlite } from '@electric-sql/pglite';
import { AiAuthMethod, AiProvider, HeartbeatRunKind, WakeupSource } from '@hezo/shared';
import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Env } from '../src/lib/types';
import {
	buildCoachReviewPrompt,
	buildProviderEnv,
	buildTaskPrompt,
	createHeartbeatRun,
	formatReactionLine,
	type HeartbeatRunBroadcast,
	loadMentionContext,
	loadReplyContext,
	loadSpawnedFromTask,
	recordRunCostAndEnforce,
	type TaskInfo,
} from '../src/services/agent-runner';
import type { ReactionGroup } from '../src/services/reactions';
import { safeClose } from './helpers';
import {
	authHeader,
	createAgentRun,
	createTestApp,
	createTestProject,
	createTestTeam,
} from './helpers/app';

let app: Hono<Env>;
let db: PGlite;
let adminToken: string;
let teamId: string;
let projectId: string;
let projectSlug: string;
let taskId: string;
let agentId: string;
let agentSlug: string | null;

beforeAll(async () => {
	const ctx = await createTestApp();
	app = ctx.app;
	db = ctx.db;
	adminToken = ctx.token;

	const typesRes = await app.request('/api/team-templates', { headers: authHeader(adminToken) });
	const typeId = (await typesRes.json()).data.find(
		(t: { name: string }) => t.name === 'Startup',
	).id;

	const teamRes = await createTestTeam(db, { name: 'Coverage Co', template_id: typeId });
	teamId = (await teamRes.json()).data.id;

	const projectRes = await createTestProject(db, teamId, { name: 'Coverage Project' });
	const projectData = (await projectRes.json()).data;
	projectId = projectData.id;
	projectSlug = projectData.slug;

	const agentsRes = await app.request(`/api/projects/${projectSlug}/agents`, {
		headers: authHeader(adminToken),
	});
	const firstAgent = (await agentsRes.json()).data[0];
	agentId = firstAgent.id;
	agentSlug = firstAgent.slug ?? null;

	const taskRes = await app.request(`/api/projects/${projectSlug}/tasks`, {
		method: 'POST',
		headers: { ...authHeader(adminToken), 'Content-Type': 'application/json' },
		body: JSON.stringify({
			project_id: projectId,
			title: 'Coverage Task',
			description: 'Test description',
			assignee_id: agentId,
		}),
	});
	taskId = (await taskRes.json()).data.id;
});

afterAll(async () => {
	await safeClose(db);
});

function makeTaskInfo(overrides: Partial<TaskInfo> = {}): TaskInfo {
	return {
		id: taskId,
		identifier: 'CV-1',
		title: 'Coverage Task',
		description: 'Test description',
		status: 'backlog',
		priority: 'medium',
		project_id: projectId,
		rules: null,
		progress_summary: null,
		...overrides,
	};
}

const noopBroadcast = (extra: Partial<HeartbeatRunBroadcast> = {}): HeartbeatRunBroadcast => ({
	teamId,
	projectId,
	taskId,
	memberId: agentId,
	...extra,
});

// ── buildTaskPrompt (pure) ────────────────────────────────────────────────

describe('buildTaskPrompt — fallback branches', () => {
	it('renders the no-description fallback when description is empty', () => {
		const prompt = buildTaskPrompt('SYS', makeTaskInfo({ description: '' }));
		expect(prompt).toContain('No description provided.');
		// No optional sections present.
		expect(prompt).not.toContain('### Rules for this task');
		expect(prompt).not.toContain('### Progress Summary');
	});

	it('renders the mention handoff with empty open-ticket list and empty excerpt', () => {
		const prompt = buildTaskPrompt(
			'SYS',
			makeTaskInfo(),
			{ source: WakeupSource.Mention },
			{
				mentionContext: {
					authorName: 'Alice',
					excerpt: '',
					openTickets: [],
					triggeringCommentId: 'cmt-1',
				},
			},
		);
		expect(prompt).toContain('## Mention Handoff');
		// Empty ticket list collapses to "none".
		expect(prompt).toContain('### Your open tickets\nnone');
		// Empty excerpt renders the placeholder block.
		expect(prompt).toContain('> (empty)');
	});

	it('renders the mention handoff with a populated open-ticket list and a multi-line excerpt', () => {
		const prompt = buildTaskPrompt(
			'SYS',
			makeTaskInfo(),
			{ source: WakeupSource.Mention },
			{
				mentionContext: {
					authorName: 'Bob',
					excerpt: 'line one\nline two',
					openTickets: [
						{ identifier: 'CV-9', title: 'Other', status: 'backlog', priority: 'high' },
					],
					triggeringCommentId: 'cmt-2',
				},
			},
		);
		expect(prompt).toContain('- CV-9 — Other (backlog, high)');
		expect(prompt).toContain('> line one');
		expect(prompt).toContain('> line two');
	});

	it('renders the reply handoff with empty excerpts, no referenced tasks, and no responder slug', () => {
		const prompt = buildTaskPrompt(
			'SYS',
			makeTaskInfo(),
			{ source: WakeupSource.Reply },
			{
				replyContext: {
					responderName: 'Carol',
					responderSlug: null,
					replyExcerpt: '',
					originalExcerpt: '',
					referencedTasks: [],
				},
			},
		);
		expect(prompt).toContain('## Reply Received');
		// No slug → bare name, no "(@slug)".
		expect(prompt).toContain('Carol replied on');
		expect(prompt).not.toContain('(@');
		// Empty excerpts → placeholder blocks; no referenced tasks → "none".
		expect(prompt).toContain('> (empty)');
		expect(prompt).toContain('### Tickets referenced by the reply\nnone');
	});

	it('renders the reply handoff with a responder slug, excerpts, and referenced tasks', () => {
		const prompt = buildTaskPrompt(
			'SYS',
			makeTaskInfo(),
			{ source: WakeupSource.Reply },
			{
				replyContext: {
					responderName: 'Dave',
					responderSlug: 'dave',
					replyExcerpt: 'reply body',
					originalExcerpt: 'original body',
					referencedTasks: [{ identifier: 'CV-5', title: 'Ref', status: 'in_progress' }],
				},
			},
		);
		expect(prompt).toContain('Dave (@dave)');
		expect(prompt).toContain('> reply body');
		expect(prompt).toContain('> original body');
		expect(prompt).toContain('- CV-5 — Ref (in_progress)');
	});
});

// ── formatReactionLine (pure) ─────────────────────────────────────────────

describe('formatReactionLine', () => {
	it('returns null for undefined or empty groups', () => {
		expect(formatReactionLine(undefined)).toBeNull();
		expect(formatReactionLine([])).toBeNull();
	});

	it('uses the known glyph for ack and slug labels for agent reactors', () => {
		const line = formatReactionLine([
			{
				kind: 'ack',
				you_reacted: false,
				members: [{ id: 'm1', slug: 'captain', display_name: 'Cap' }],
			},
		]);
		expect(line).toBe('Reactions: ✓ @captain');
	});

	it('falls back to the raw kind glyph and display_name when no slug', () => {
		const line = formatReactionLine([
			{
				// A kind with no entry in REACTION_GLYPH falls back to the raw kind string.
				kind: 'thumbsup' as ReactionGroup['kind'],
				you_reacted: false,
				members: [{ id: 'm2', slug: null, display_name: 'Admin' }],
			},
		]);
		expect(line).toBe('Reactions: thumbsup Admin');
	});

	it('falls back to "someone" when a member has neither slug nor display name', () => {
		const line = formatReactionLine([
			{
				kind: 'ack',
				you_reacted: false,
				members: [{ id: 'm3', slug: null, display_name: null }],
			},
		]);
		expect(line).toBe('Reactions: ✓ someone');
	});
});

// ── buildProviderEnv (pure) ───────────────────────────────────────────────

describe('buildProviderEnv', () => {
	it('omits the credential env var on subscription auth (file-mount delivery)', () => {
		// OpenAI/Codex delivers a subscription credential via auth.json, not env, so
		// the credentialEnvByAuthMethod lookup yields no var and the value is excluded.
		const out = buildProviderEnv(AiProvider.OpenAI, {
			value: 'subscription-blob',
			authMethod: AiAuthMethod.Subscription,
		});
		expect(out.some((e) => e.includes('subscription-blob'))).toBe(false);
	});

	it('includes the credential env var on api-key auth', () => {
		const out = buildProviderEnv(AiProvider.Anthropic, {
			value: 'sk-ant-xyz',
			authMethod: AiAuthMethod.ApiKey,
		});
		expect(out.some((e) => e.endsWith('=sk-ant-xyz'))).toBe(true);
	});
});

// ── loadSpawnedFromTask (DB) ──────────────────────────────────────────────

describe('loadSpawnedFromTask', () => {
	it('returns only a parent line when the task has a parent but no spawning run', async () => {
		const parentRes = await app.request(`/api/projects/${projectSlug}/tasks`, {
			method: 'POST',
			headers: { ...authHeader(adminToken), 'Content-Type': 'application/json' },
			body: JSON.stringify({ project_id: projectId, title: 'Parent Task', assignee_id: agentId }),
		});
		const parent = (await parentRes.json()).data;

		const result = await loadSpawnedFromTask(
			db,
			makeTaskInfo({ parent_task_id: parent.id, created_by_run_id: null }),
		);
		expect(result).not.toBeNull();
		expect(result!.parentLine).toContain(`${parent.identifier} — Parent Task`);
		expect(result!.spawnLine).toBeNull();
	});

	it('returns only a spawn line when the task came from another task run', async () => {
		const spawningTaskRes = await app.request(`/api/projects/${projectSlug}/tasks`, {
			method: 'POST',
			headers: { ...authHeader(adminToken), 'Content-Type': 'application/json' },
			body: JSON.stringify({ project_id: projectId, title: 'Spawning Task', assignee_id: agentId }),
		});
		const spawningTask = (await spawningTaskRes.json()).data;
		const runId = await createAgentRun(db, agentId, teamId, spawningTask.id);

		const result = await loadSpawnedFromTask(
			db,
			makeTaskInfo({ parent_task_id: null, created_by_run_id: runId }),
		);
		expect(result).not.toBeNull();
		expect(result!.parentLine).toBeNull();
		expect(result!.spawnLine).toContain(`${spawningTask.identifier} — Spawning Task`);
	});

	it('does not set a spawn line when the spawning run belongs to the same task', async () => {
		const runId = await createAgentRun(db, agentId, teamId, taskId);
		const result = await loadSpawnedFromTask(
			db,
			makeTaskInfo({ parent_task_id: null, created_by_run_id: runId }),
		);
		// Self-referential run → no provenance.
		expect(result).toBeNull();
	});

	it('ignores a created_by_run_id whose run row is missing', async () => {
		const result = await loadSpawnedFromTask(
			db,
			makeTaskInfo({
				parent_task_id: null,
				created_by_run_id: '00000000-0000-0000-0000-000000000000',
			}),
		);
		expect(result).toBeNull();
	});
});

// ── loadMentionContext (DB) ───────────────────────────────────────────────

describe('loadMentionContext', () => {
	it('returns null when the triggering comment id does not exist', async () => {
		const result = await loadMentionContext(db, agentId, teamId, {
			comment_id: '00000000-0000-0000-0000-000000000000',
		});
		expect(result).toBeNull();
	});

	it('falls back to the Admin author name when the comment has no resolvable author', async () => {
		// A comment with a NULL author_member_id makes both LEFT JOINs miss, so the
		// COALESCE yields NULL and the JS `?? 'Admin'` fallback fires.
		const commentRes = await db.query<{ id: string }>(
			`INSERT INTO task_comments (task_id, author_member_id, content_type, content)
			 VALUES ($1, NULL, 'text', $2::jsonb) RETURNING id`,
			[taskId, JSON.stringify({ text: 'hello there' })],
		);

		const result = await loadMentionContext(db, agentId, teamId, {
			comment_id: commentRes.rows[0].id,
		});
		expect(result).not.toBeNull();
		expect(result!.authorName).toBe('Admin');
		expect(result!.excerpt).toBe('hello there');
		// The agent is assigned the seeded task, so the open-tickets list is populated.
		expect(result!.openTickets.length).toBeGreaterThan(0);
	});
});

// ── loadReplyContext (DB) ─────────────────────────────────────────────────

describe('loadReplyContext', () => {
	it('returns null when the triggering comment id is absent from the payload', async () => {
		const result = await loadReplyContext(db, { comment_id: 'only-a-reply-id' });
		expect(result).toBeNull();
	});

	it('returns null when the reply comment row is missing', async () => {
		const result = await loadReplyContext(db, {
			comment_id: '00000000-0000-0000-0000-000000000000',
			triggering_comment_id: '00000000-0000-0000-0000-000000000001',
		});
		expect(result).toBeNull();
	});

	it('returns null when the original comment row is missing', async () => {
		const reply = await db.query<{ id: string }>(
			`INSERT INTO task_comments (task_id, author_member_id, content_type, content)
			 VALUES ($1, $2, 'text', $3::jsonb) RETURNING id`,
			[taskId, agentId, JSON.stringify({ text: 'a reply' })],
		);
		const result = await loadReplyContext(db, {
			comment_id: reply.rows[0].id,
			triggering_comment_id: '00000000-0000-0000-0000-000000000002',
		});
		expect(result).toBeNull();
	});

	it('resolves referenced tasks named in the reply body', async () => {
		const original = await db.query<{ id: string }>(
			`INSERT INTO task_comments (task_id, author_member_id, content_type, content)
			 VALUES ($1, $2, 'text', $3::jsonb) RETURNING id`,
			[taskId, agentId, JSON.stringify({ text: 'original comment' })],
		);
		const taskIdentifier = (
			await db.query<{ identifier: string }>('SELECT identifier FROM tasks WHERE id = $1', [taskId])
		).rows[0].identifier;
		const reply = await db.query<{ id: string }>(
			`INSERT INTO task_comments (task_id, author_member_id, content_type, content)
			 VALUES ($1, $2, 'text', $3::jsonb) RETURNING id`,
			[taskId, agentId, JSON.stringify({ text: `see ${taskIdentifier} for context` })],
		);

		const result = await loadReplyContext(db, {
			comment_id: reply.rows[0].id,
			triggering_comment_id: original.rows[0].id,
		});
		expect(result).not.toBeNull();
		expect(result!.referencedTasks.some((t) => t.identifier === taskIdentifier)).toBe(true);
		// Author is an agent → slug populated, name from member_agents.title.
		expect(result!.responderSlug).toBeTruthy();
	});
});

// ── buildCoachReviewPrompt (DB) ───────────────────────────────────────────

describe('buildCoachReviewPrompt', () => {
	it('renders rules, progress summary, non-text comments, and reactions', async () => {
		const reviewTaskRes = await app.request(`/api/projects/${projectSlug}/tasks`, {
			method: 'POST',
			headers: { ...authHeader(adminToken), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				project_id: projectId,
				title: 'Review Me',
				description: '',
				assignee_id: agentId,
			}),
		});
		const reviewTask = (await reviewTaskRes.json()).data;

		// A text comment plus a non-text (action) comment exercise both formatting arms.
		const textComment = await db.query<{ id: string }>(
			`INSERT INTO task_comments (task_id, author_member_id, content_type, content)
			 VALUES ($1, $2, 'text', $3::jsonb) RETURNING id`,
			[reviewTask.id, agentId, JSON.stringify({ text: 'did the work' })],
		);
		await db.query(
			`INSERT INTO task_comments (task_id, author_member_id, content_type, content)
			 VALUES ($1, $2, 'action', $3::jsonb)`,
			[reviewTask.id, agentId, JSON.stringify({ verb: 'closed', detail: 'all done' })],
		);
		// A reaction on the text comment exercises the reaction-line attach branch.
		await db.query(
			`INSERT INTO comment_reactions (comment_id, member_id, kind) VALUES ($1, $2, 'ack')`,
			[textComment.rows[0].id, agentId],
		);

		const prompt = await buildCoachReviewPrompt(
			db,
			'SYS',
			makeTaskInfo({
				id: reviewTask.id,
				identifier: reviewTask.identifier,
				title: 'Review Me',
				description: '',
				rules: 'follow the rules',
				progress_summary: 'made progress',
			}),
			teamId,
		);

		expect(prompt).toContain('## Review Completed Ticket');
		expect(prompt).toContain('### Rules\nfollow the rules');
		expect(prompt).toContain('### Progress Summary\nmade progress');
		// Empty description still renders the fallback.
		expect(prompt).toContain('No description provided.');
		expect(prompt).toContain('did the work');
		// Non-text comment serialized as JSON.
		expect(prompt).toContain('all done');
		// Reaction line attached under its comment.
		expect(prompt).toContain('✓');
		// Assignee agent appears in the involved-agents list.
		expect(prompt).toContain('slug:');
	});

	it('renders the no-comments and no-agents fallbacks for an untouched task', async () => {
		// A task with no comments: the involved-agents query is scoped to a team that
		// owns no members for this task (a fresh empty team), so both the comment log
		// and the agent list collapse to their fallbacks.
		const bareTaskRes = await app.request(`/api/projects/${projectSlug}/tasks`, {
			method: 'POST',
			headers: { ...authHeader(adminToken), 'Content-Type': 'application/json' },
			body: JSON.stringify({ project_id: projectId, title: 'Bare Review', assignee_id: agentId }),
		});
		const bareTask = (await bareTaskRes.json()).data;
		const emptyTeam = await db.query<{ id: string }>(
			`INSERT INTO teams (name, slug) VALUES ('Empty Team', 'empty-team-cov') RETURNING id`,
		);

		const prompt = await buildCoachReviewPrompt(
			db,
			'SYS',
			makeTaskInfo({
				id: bareTask.id,
				identifier: bareTask.identifier,
				title: 'Bare Review',
				rules: null,
				progress_summary: null,
			}),
			emptyTeam.rows[0].id,
		);
		expect(prompt).toContain('No comments on this task.');
		expect(prompt).toContain('No agents identified.');
		// No rules/progress sections.
		expect(prompt).not.toContain('### Rules\n');
		expect(prompt).not.toContain('### Progress Summary\n');
	});
});

// ── createHeartbeatRun (DB) ───────────────────────────────────────────────

describe('createHeartbeatRun', () => {
	it('creates a goal-check run with no task and flips no status', async () => {
		const wakeup = await db.query<{ id: string }>(
			`INSERT INTO agent_wakeup_requests (member_id, team_id, source, status, payload, claimed_at)
			 VALUES ($1, $2, $3::wakeup_source, 'claimed'::wakeup_status, '{}'::jsonb, now())
			 RETURNING id`,
			[agentId, teamId, WakeupSource.OnDemand],
		);
		const runId = await createHeartbeatRun(
			db,
			{ id: agentId, title: 'Agent', team_id: teamId, slug: agentSlug },
			teamId,
			null,
			noopBroadcast({ taskId: null }),
			wakeup.rows[0].id,
			null,
			HeartbeatRunKind.GoalCheck,
		);
		const row = await db.query<{ task_id: string | null; kind: string }>(
			'SELECT task_id, kind FROM heartbeat_runs WHERE id = $1',
			[runId],
		);
		expect(row.rows[0].task_id).toBeNull();
		expect(row.rows[0].kind).toBe(HeartbeatRunKind.GoalCheck);
	});

	it('does not flip status to in_progress when the task is not in backlog', async () => {
		const inProgTaskRes = await app.request(`/api/projects/${projectSlug}/tasks`, {
			method: 'POST',
			headers: { ...authHeader(adminToken), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				project_id: projectId,
				title: 'Already Moving',
				assignee_id: agentId,
			}),
		});
		const movingTask = (await inProgTaskRes.json()).data;
		await db.query(`UPDATE tasks SET status = 'in_progress'::task_status WHERE id = $1`, [
			movingTask.id,
		]);

		const wakeup = await db.query<{ id: string }>(
			`INSERT INTO agent_wakeup_requests (member_id, team_id, source, status, payload, claimed_at)
			 VALUES ($1, $2, $3::wakeup_source, 'claimed'::wakeup_status, '{}'::jsonb, now())
			 RETURNING id`,
			[agentId, teamId, WakeupSource.OnDemand],
		);
		const runId = await createHeartbeatRun(
			db,
			{ id: agentId, title: 'Agent', team_id: teamId, slug: agentSlug },
			teamId,
			makeTaskInfo({
				id: movingTask.id,
				identifier: movingTask.identifier,
				status: 'in_progress',
				assignee_id: agentId,
			}),
			noopBroadcast({ taskId: movingTask.id }),
			wakeup.rows[0].id,
			{ member_id: agentId, name: 'Trigger Person' },
		);
		expect(runId).toBeTruthy();
		// Status stayed in_progress (not re-flipped from backlog).
		const t = await db.query<{ status: string }>('SELECT status FROM tasks WHERE id = $1', [
			movingTask.id,
		]);
		expect(t.rows[0].status).toBe('in_progress');
		// The Run comment carries the triggered-by actor metadata.
		const comment = await db.query<{ content: Record<string, unknown> }>(
			`SELECT content FROM task_comments WHERE task_id = $1 AND content_type = 'run' ORDER BY created_at DESC LIMIT 1`,
			[movingTask.id],
		);
		expect(comment.rows[0].content.actor_name).toBe('Trigger Person');
	});
});

// ── recordRunCostAndEnforce (DB) ──────────────────────────────────────────

describe('recordRunCostAndEnforce', () => {
	it('is a no-op when usage is null', async () => {
		const before = await db.query<{ c: number }>('SELECT COUNT(*)::int AS c FROM cost_entries');
		await recordRunCostAndEnforce(db, 'irrelevant', null, noopBroadcast());
		const after = await db.query<{ c: number }>('SELECT COUNT(*)::int AS c FROM cost_entries');
		expect(after.rows[0].c).toBe(before.rows[0].c);
	});

	it('is a no-op when cost is zero', async () => {
		const before = await db.query<{ c: number }>('SELECT COUNT(*)::int AS c FROM cost_entries');
		await recordRunCostAndEnforce(
			db,
			'irrelevant',
			{ inputTokens: 100, outputTokens: 50, costCents: 0 },
			noopBroadcast(),
		);
		const after = await db.query<{ c: number }>('SELECT COUNT(*)::int AS c FROM cost_entries');
		expect(after.rows[0].c).toBe(before.rows[0].c);
	});

	it('records a cost_entries row and broadcasts it when cost is positive', async () => {
		const broadcasts: Array<{ table: string }> = [];
		const wsManager = {
			broadcast: (_room: string, event: { table?: string }) => {
				if (event.table) broadcasts.push({ table: event.table });
			},
		} as unknown as HeartbeatRunBroadcast['wsManager'];

		const runId = await createAgentRun(db, agentId, teamId, taskId);
		await recordRunCostAndEnforce(
			db,
			runId,
			{ inputTokens: 1000, outputTokens: 500, costCents: 7 },
			noopBroadcast({ wsManager }),
		);

		const entry = await db.query<{ amount_cents: number }>(
			`SELECT amount_cents FROM cost_entries WHERE description = $1`,
			[`Agent run ${runId}`],
		);
		expect(entry.rows.length).toBe(1);
		expect(entry.rows[0].amount_cents).toBe(7);
		expect(broadcasts.some((b) => b.table === 'cost_entries')).toBe(true);
	});
});
