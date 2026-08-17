import { CommentContentType, TaskStatus, WakeupSource } from '@hezo/shared';
import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MasterKeyManager } from '../src/crypto/master-key';
import type { Db } from '../src/db/database';
import type { Env } from '../src/lib/types';
import {
	buildTaskPrompt,
	loadCatchUpSinceLastRun,
	loadCommentHistory,
	loadCommentWakeContext,
	loadMentionContext,
	loadReplyContext,
	loadSpawnedFromTask,
	RECENT_COMMENTS_LIMIT,
} from '../src/services/agent-runner';
import { getAgentSystemPrompt } from '../src/services/documents';
import { resolveSystemPrompt } from '../src/services/template-resolver';
import { safeClose } from './helpers';
import {
	authHeader,
	createTestApp,
	createTestProject,
	createTestTeam,
	projectSlugFor,
} from './helpers/app';

let app: Hono<Env>;
let db: Db;
let token: string;
let masterKeyManager: MasterKeyManager;

let teamId: string;
let projectId: string;
let projectSlug: string;
let captainMemberId: string;
let architectMemberId: string;

const TRIGGERING_TASK: Parameters<typeof buildTaskPrompt>[1] = {
	id: 'filled-below',
	identifier: 'filled-below',
	title: 'Captain PRD task',
	description: 'Project definition and roadmap.',
	status: 'in_progress',
	priority: 'high',
	project_id: 'filled-below',
	rules: null,
	progress_summary: null,
};

beforeAll(async () => {
	const ctx = await createTestApp();
	app = ctx.app;
	db = ctx.db;
	token = ctx.token;
	masterKeyManager = ctx.masterKeyManager;

	const typesRes = await app.request('/api/team-templates', { headers: authHeader(token) });
	const typeId = (await typesRes.json()).data.find(
		(t: Record<string, unknown>) => t.name === 'App Team',
	).id;

	const teamRes = await createTestTeam(db, {
		name: 'Mention Handoff Prompt Co',
		template_id: typeId,
	});
	const teamData = (await teamRes.json()).data;
	teamId = teamData.id;

	const agentsRes = await app.request(`/api/projects/${await projectSlugFor(db, teamId)}/agents`, {
		headers: authHeader(token),
	});
	const agents = (await agentsRes.json()).data as Array<{ id: string; slug: string }>;
	captainMemberId = agents.find((a) => a.slug === 'captain')!.id;
	architectMemberId = agents.find((a) => a.slug === 'architect')!.id;

	const projectRes = await createTestProject(db, teamId, {
		name: 'Handoff project',
		description: 'Test',
	});
	const projectData = (await projectRes.json()).data;
	projectId = projectData.id;
	projectSlug = projectData.slug;
});

afterAll(async () => {
	await safeClose(db);
});

async function createTriggeringTaskWithComment(commentText: string): Promise<{
	triggeringTaskId: string;
	triggeringIdentifier: string;
	commentId: string;
}> {
	const taskRes = await app.request(`/api/projects/${projectSlug}/tasks`, {
		method: 'POST',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify({
			project_id: projectId,
			title: "Captain's PRD task",
			assignee_id: captainMemberId,
		}),
	});
	const task = (await taskRes.json()).data as { id: string; identifier: string };

	const commentInsert = await db.query<{ id: string }>(
		`INSERT INTO task_comments (task_id, author_member_id, content_type, content)
		 VALUES ($1, $2, $3::comment_content_type, $4::jsonb)
		 RETURNING id`,
		[task.id, captainMemberId, CommentContentType.Text, JSON.stringify({ text: commentText })],
	);

	return {
		triggeringTaskId: task.id,
		triggeringIdentifier: task.identifier,
		commentId: commentInsert.rows[0].id,
	};
}

async function createArchitectTicket(
	title: string,
	status: TaskStatus = TaskStatus.Backlog,
): Promise<{ id: string; identifier: string }> {
	const res = await app.request(`/api/projects/${projectSlug}/tasks`, {
		method: 'POST',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify({
			project_id: projectId,
			title,
			assignee_id: architectMemberId,
		}),
	});
	const data = (await res.json()).data as { id: string; identifier: string };

	if (status !== TaskStatus.Backlog) {
		await app.request(`/api/projects/${projectSlug}/tasks/${data.id}`, {
			method: 'PATCH',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ status }),
		});
	}
	return data;
}

describe('mention handoff prompt (integration)', () => {
	it('renders the handoff block with triggering task + author + open tasks', async () => {
		const { triggeringTaskId, triggeringIdentifier, commentId } =
			await createTriggeringTaskWithComment('@architect please bring the spec up to date');

		const specTicket = await createArchitectTicket('Spec draft', TaskStatus.InProgress);
		const prdTicket = await createArchitectTicket('Review PRD');

		const wakeupPayload = {
			source: WakeupSource.Mention,
			task_id: triggeringTaskId,
			comment_id: commentId,
		};

		const ctx = await loadMentionContext(db, architectMemberId, teamId, wakeupPayload);
		expect(ctx).not.toBeNull();
		expect(ctx?.authorName).toBeTruthy();
		expect(ctx?.excerpt).toContain('bring the spec up to date');
		expect(ctx?.triggeringCommentId).toBe(commentId);
		expect(ctx?.openTickets.map((t) => t.identifier).sort()).toEqual(
			[specTicket.identifier, prdTicket.identifier].sort(),
		);

		const prompt = buildTaskPrompt(
			'System prompt',
			{
				...TRIGGERING_TASK,
				id: triggeringTaskId,
				identifier: triggeringIdentifier,
				project_id: projectId,
			},
			wakeupPayload,
			{ mentionContext: ctx },
		);

		expect(prompt).toContain('## Mention Handoff');
		expect(prompt).toContain(triggeringIdentifier);
		expect(prompt).toContain(specTicket.identifier);
		expect(prompt).toContain(prdTicket.identifier);
		expect(prompt).toContain('> @architect please bring the spec up to date');
		expect(prompt).toContain('Handling an @-mention');
		expect(prompt).toContain('parent_task_id');
		expect(prompt).toContain(commentId);
		expect(prompt).toContain(`add_reaction(comment_id='${commentId}', kind='ack')`);
	});

	it('renders "none" when the mentioned agent has no open tasks', async () => {
		// Fresh team to isolate state — the architect in this team has no tickets.
		const typesRes = await app.request('/api/team-templates', { headers: authHeader(token) });
		const typeId = (await typesRes.json()).data.find(
			(t: Record<string, unknown>) => t.name === 'App Team',
		).id;
		const teamRes = await createTestTeam(db, {
			name: 'No Tasks Co',
			template_id: typeId,
		});
		const soloTeam = (await teamRes.json()).data;
		const soloTeamId = soloTeam.id;
		const agentsRes = await app.request(
			`/api/projects/${await projectSlugFor(db, soloTeam.id)}/agents`,
			{
				headers: authHeader(token),
			},
		);
		const agents = (await agentsRes.json()).data as Array<{ id: string; slug: string }>;
		const captain = agents.find((a) => a.slug === 'captain')!;
		const architect = agents.find((a) => a.slug === 'architect')!;
		const projRes = await createTestProject(db, soloTeamId, {
			name: 'No tasks',
			description: 'x',
		});
		const soloProject = (await projRes.json()).data;
		const soloProjectId = soloProject.id;
		const taskRes = await app.request(`/api/projects/${soloProject.slug}/tasks`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				project_id: soloProjectId,
				title: 'Captain task only',
				assignee_id: captain.id,
			}),
		});
		const triggering = (await taskRes.json()).data as { id: string; identifier: string };

		const commentInsert = await db.query<{ id: string }>(
			`INSERT INTO task_comments (task_id, author_member_id, content_type, content)
			 VALUES ($1, $2, $3::comment_content_type, $4::jsonb)
			 RETURNING id`,
			[
				triggering.id,
				captain.id,
				CommentContentType.Text,
				JSON.stringify({ text: '@architect weigh in' }),
			],
		);

		const payload = {
			source: WakeupSource.Mention,
			task_id: triggering.id,
			comment_id: commentInsert.rows[0].id,
		};
		const ctx = await loadMentionContext(db, architect.id, soloTeamId, payload);
		expect(ctx?.openTickets.length).toBe(0);

		const prompt = buildTaskPrompt(
			'System',
			{
				id: triggering.id,
				identifier: triggering.identifier,
				title: 'Captain task only',
				description: 'x',
				status: 'backlog',
				priority: 'medium',
				project_id: soloProjectId,
				rules: null,
				progress_summary: null,
			},
			payload,
			{ mentionContext: ctx },
		);
		expect(prompt).toContain('### Your open tasks\nnone');
	});

	it('keeps the sub-task / peer / top-level triage guidance in the resolved architect prompt via SHARED_INSTRUCTIONS', async () => {
		const { triggeringTaskId, triggeringIdentifier, commentId } =
			await createTriggeringTaskWithComment('@architect review please');
		const wakeupPayload = {
			source: WakeupSource.Mention,
			task_id: triggeringTaskId,
			comment_id: commentId,
		};
		const ctx = await loadMentionContext(db, architectMemberId, teamId, wakeupPayload);

		// The triage guidance now lives in SHARED_INSTRUCTIONS, appended at resolve
		// time rather than baked into the stored role template.
		const architectSystemPrompt = await getAgentSystemPrompt(db, teamId, architectMemberId);
		const resolvedSystemPrompt = await resolveSystemPrompt(db, architectSystemPrompt, {
			teamId,
			projectId,
			taskId: triggeringTaskId,
			agentId: architectMemberId,
		});

		const prompt = buildTaskPrompt(
			resolvedSystemPrompt,
			{
				...TRIGGERING_TASK,
				id: triggeringTaskId,
				identifier: triggeringIdentifier,
				project_id: projectId,
			},
			wakeupPayload,
			{ mentionContext: ctx },
		);
		expect(prompt).not.toContain('"Tracking this on {your_ticket_identifier}."');
		expect(prompt).toContain('Handling an @-mention');
		expect(prompt).toContain('sub-task');
		expect(prompt).toContain('peer');
		expect(prompt).toContain('top-level');
		expect(prompt).toContain('Check before you create');
		// The "Assigned to you" branch says to do what the comment asks *in this run*,
		// which read literally tells a manager to personally execute feedback that
		// belongs to a sub-task it already delegated and that is still open. The
		// carve-out has to survive into the resolved prompt alongside the triage flow.
		expect(prompt).toContain('"do what it asks" means making sure it **lands**');
		expect(prompt).toContain(
			'**New instructions on work you have already delegated** under **Sub-Tasks & Delegation**',
		);
	});

	it('injects the full comment verbatim — no truncation, no code stripping', async () => {
		const longBody = `Here is a proposal:\n\`\`\`\n${'payload'.repeat(100)}\n\`\`\`\nand ${'x'.repeat(700)} tail`;
		const { triggeringTaskId, commentId } = await createTriggeringTaskWithComment(longBody);

		const ctx = await loadMentionContext(db, architectMemberId, teamId, {
			source: WakeupSource.Mention,
			task_id: triggeringTaskId,
			comment_id: commentId,
		});
		expect(ctx).not.toBeNull();
		const comment = ctx?.excerpt ?? '';
		// The whole comment is present: the fenced code block survives and the long
		// tail is not cut off at 500 chars.
		expect(comment).toContain('payload'.repeat(100));
		expect(comment).toContain('x'.repeat(700));
		expect(comment).toContain('```');
		expect(comment).not.toContain('[code omitted]');
		expect(comment.endsWith('…')).toBe(false);
	});
});

describe('reply handoff prompt (integration)', () => {
	async function seedReplyScenario(): Promise<{
		triggeringTaskId: string;
		triggeringIdentifier: string;
		triggeringCommentId: string;
		replyCommentId: string;
		newTicket: { id: string; identifier: string; title: string };
	}> {
		const { triggeringTaskId, triggeringIdentifier, commentId } =
			await createTriggeringTaskWithComment('@architect please take point on this');

		const newTicketRes = await app.request(`/api/projects/${projectSlug}/tasks`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				project_id: projectId,
				title: 'Follow-up work on architecture',
				assignee_id: architectMemberId,
			}),
		});
		const newTicket = (await newTicketRes.json()).data as {
			id: string;
			identifier: string;
			title: string;
		};

		const replyInsert = await db.query<{ id: string }>(
			`INSERT INTO task_comments (task_id, author_member_id, content_type, content)
			 VALUES ($1, $2, $3::comment_content_type, $4::jsonb)
			 RETURNING id`,
			[
				triggeringTaskId,
				architectMemberId,
				CommentContentType.Text,
				JSON.stringify({ text: `Got it — carrying this forward on ${newTicket.identifier}.` }),
			],
		);

		return {
			triggeringTaskId,
			triggeringIdentifier,
			triggeringCommentId: commentId,
			replyCommentId: replyInsert.rows[0].id,
			newTicket,
		};
	}

	it('loads the reply excerpt, original excerpt, and referenced new task', async () => {
		const { triggeringCommentId, replyCommentId, newTicket } = await seedReplyScenario();
		const ctx = await loadReplyContext(db, {
			source: WakeupSource.Reply,
			task_id: 'ignored-by-loader',
			comment_id: replyCommentId,
			triggering_comment_id: triggeringCommentId,
		});
		expect(ctx).not.toBeNull();
		expect(ctx?.replyExcerpt).toContain(newTicket.identifier);
		expect(ctx?.originalExcerpt).toContain('please take point');
		expect(ctx?.referencedTasks.map((i) => i.identifier)).toContain(newTicket.identifier);
		expect(ctx?.responderName).toBeTruthy();
		expect(ctx?.responderSlug).toBe('architect');
	});

	it('renders a Reply Handoff block when the wakeup source is Reply', async () => {
		const { triggeringTaskId, triggeringIdentifier, triggeringCommentId, replyCommentId } =
			await seedReplyScenario();
		const payload = {
			source: WakeupSource.Reply,
			task_id: triggeringTaskId,
			comment_id: replyCommentId,
			triggering_comment_id: triggeringCommentId,
		};
		const ctx = await loadReplyContext(db, payload);
		const prompt = buildTaskPrompt(
			'System',
			{
				...TRIGGERING_TASK,
				id: triggeringTaskId,
				identifier: triggeringIdentifier,
				project_id: projectId,
			},
			payload,
			{ replyContext: ctx },
		);
		expect(prompt).toContain('## Reply Received');
		expect(prompt).toContain('replied on');
		expect(prompt).toContain('### Their reply');
		expect(prompt).toContain('### Tasks referenced by the reply');
		expect(prompt).toContain('may choose to wait');
	});

	it('returns null when the wakeup payload is missing reply ids', async () => {
		const ctx = await loadReplyContext(db, {
			source: WakeupSource.Reply,
			task_id: 'x',
		});
		expect(ctx).toBeNull();
	});

	it('extracts the reply excerpt when the body is a bare string (web-composer shape)', async () => {
		const { triggeringTaskId, commentId: triggeringCommentId } =
			await createTriggeringTaskWithComment('Please review and approve the PRD.');

		const replyInsert = await db.query<{ id: string }>(
			`INSERT INTO task_comments (task_id, author_member_id, content_type, content)
			 VALUES ($1, NULL, $2::comment_content_type, $3::jsonb)
			 RETURNING id`,
			[triggeringTaskId, CommentContentType.Text, JSON.stringify('APPROVED')],
		);

		const ctx = await loadReplyContext(db, {
			source: WakeupSource.Reply,
			task_id: triggeringTaskId,
			comment_id: replyInsert.rows[0].id,
			triggering_comment_id: triggeringCommentId,
		});

		expect(ctx?.replyExcerpt).toBe('APPROVED');
		expect(ctx?.originalExcerpt).toContain('approve the PRD');
	});
});

describe('spawned-from prompt line', () => {
	it('renders "Parent task" when parent_task_id matches the spawning run', async () => {
		const taskRes = await app.request(`/api/projects/${projectSlug}/tasks`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				project_id: projectId,
				title: 'Parent Captain work',
				assignee_id: captainMemberId,
			}),
		});
		const parent = (await taskRes.json()).data as { id: string; identifier: string };

		const run = await db.query<{ id: string }>(
			`INSERT INTO heartbeat_runs (member_id, team_id, task_id, status, started_at)
			 VALUES ($1, $2, $3, 'running'::heartbeat_run_status, now())
			 RETURNING id`,
			[captainMemberId, teamId, parent.id],
		);

		const subRes = await db.query<{ id: string; identifier: string }>(
			`INSERT INTO tasks (team_id, project_id, assignee_id, parent_task_id, created_by_run_id, number, identifier, title, description, status, priority, labels)
			 VALUES ($1, $2, $3, $4, $5, next_project_task_number($2), 'MHP-sub', 'Sub work', '', 'backlog'::task_status, 'medium'::task_priority, '[]'::jsonb)
			 RETURNING id, identifier`,
			[teamId, projectId, architectMemberId, parent.id, run.rows[0].id],
		);
		const sub = subRes.rows[0];

		const spawn = await loadSpawnedFromTask(db, {
			id: sub.id,
			identifier: sub.identifier,
			title: 'Sub work',
			description: '',
			status: 'backlog',
			priority: 'medium',
			project_id: projectId,
			rules: null,
			progress_summary: null,
			parent_task_id: parent.id,
			created_by_run_id: run.rows[0].id,
		});
		expect(spawn?.parentLine).toContain(parent.identifier);
		expect(spawn?.spawnLine).toBeNull();

		const prompt = buildTaskPrompt(
			'System',
			{
				id: sub.id,
				identifier: sub.identifier,
				title: 'Sub work',
				description: '',
				status: 'backlog',
				priority: 'medium',
				project_id: projectId,
				rules: null,
				progress_summary: null,
				parent_task_id: parent.id,
				created_by_run_id: run.rows[0].id,
			},
			undefined,
			{ spawnedFrom: spawn },
		);
		expect(prompt).toContain(`**Parent task:** ${parent.identifier}`);
		expect(prompt).not.toContain('**Spawned from:**');
	});

	it('renders "Spawned from" when a sibling/top-level task has no structural parent', async () => {
		const taskRes = await app.request(`/api/projects/${projectSlug}/tasks`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				project_id: projectId,
				title: 'Spawning Captain work',
				assignee_id: captainMemberId,
			}),
		});
		const spawning = (await taskRes.json()).data as { id: string; identifier: string };

		const run = await db.query<{ id: string }>(
			`INSERT INTO heartbeat_runs (member_id, team_id, task_id, status, started_at)
			 VALUES ($1, $2, $3, 'running'::heartbeat_run_status, now())
			 RETURNING id`,
			[captainMemberId, teamId, spawning.id],
		);

		const topRes = await db.query<{ id: string; identifier: string }>(
			`INSERT INTO tasks (team_id, project_id, assignee_id, created_by_run_id, number, identifier, title, description, status, priority, labels)
			 VALUES ($1, $2, $3, $4, next_project_task_number($2), 'MHP-top', 'Top-level follow-up', '', 'backlog'::task_status, 'medium'::task_priority, '[]'::jsonb)
			 RETURNING id, identifier`,
			[teamId, projectId, architectMemberId, run.rows[0].id],
		);
		const top = topRes.rows[0];

		const spawn = await loadSpawnedFromTask(db, {
			id: top.id,
			identifier: top.identifier,
			title: 'Top-level follow-up',
			description: '',
			status: 'backlog',
			priority: 'medium',
			project_id: projectId,
			rules: null,
			progress_summary: null,
			parent_task_id: null,
			created_by_run_id: run.rows[0].id,
		});
		expect(spawn?.parentLine).toBeNull();
		expect(spawn?.spawnLine).toContain(spawning.identifier);

		const prompt = buildTaskPrompt(
			'System',
			{
				id: top.id,
				identifier: top.identifier,
				title: 'Top-level follow-up',
				description: '',
				status: 'backlog',
				priority: 'medium',
				project_id: projectId,
				rules: null,
				progress_summary: null,
				parent_task_id: null,
				created_by_run_id: run.rows[0].id,
			},
			undefined,
			{ spawnedFrom: spawn },
		);
		expect(prompt).toContain(`**Spawned from:** ${spawning.identifier}`);
		expect(prompt).not.toContain('**Parent task:**');
	});

	it('returns null for an orphan task (no parent, no created_by_run_id)', async () => {
		const spawn = await loadSpawnedFromTask(db, {
			id: '00000000-0000-0000-0000-000000000000',
			identifier: 'MHP-orphan',
			title: 'Orphan',
			description: '',
			status: 'backlog',
			priority: 'medium',
			project_id: projectId,
			rules: null,
			progress_summary: null,
			parent_task_id: null,
			created_by_run_id: null,
		});
		expect(spawn).toBeNull();
	});
});

describe('recent comments block + comment-wake handoff (integration)', () => {
	async function createTaskWithNComments(
		count: number,
	): Promise<{ id: string; identifier: string }> {
		const taskRes = await app.request(`/api/projects/${projectSlug}/tasks`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				project_id: projectId,
				title: 'Recent comments task',
				assignee_id: captainMemberId,
			}),
		});
		const task = (await taskRes.json()).data as { id: string; identifier: string };
		for (let n = 1; n <= count; n++) {
			// Explicit, strictly-increasing created_at so "latest 5" ordering is deterministic
			// (bare now() can collide across fast inserts in the same second).
			await db.query(
				`INSERT INTO task_comments (task_id, author_member_id, content_type, content, created_at)
				 VALUES ($1, $2, $3::comment_content_type, $4::jsonb, now() + ($5 || ' seconds')::interval)`,
				[
					task.id,
					captainMemberId,
					CommentContentType.Text,
					JSON.stringify({ text: `comment number ${n}` }),
					n,
				],
			);
		}
		return task;
	}

	const commentText = (c: { content: Record<string, unknown> }): string =>
		String((c.content as { text?: unknown }).text ?? '');

	it('loads exactly the latest N comments in chronological order (drops older ones)', async () => {
		const total = RECENT_COMMENTS_LIMIT + 3;
		const task = await createTaskWithNComments(total);
		const recent = await loadCommentHistory(
			db,
			task.id,
			masterKeyManager,
			'http://127.0.0.1:47081',
			{
				limit: RECENT_COMMENTS_LIMIT,
			},
		);

		expect(recent.length).toBe(RECENT_COMMENTS_LIMIT);
		// Only the newest RECENT_COMMENTS_LIMIT survive, oldest-first within that window.
		const expected = Array.from(
			{ length: RECENT_COMMENTS_LIMIT },
			(_, i) => `comment number ${total - RECENT_COMMENTS_LIMIT + 1 + i}`,
		);
		expect(recent.map(commentText)).toEqual(expected);
	});

	it('renders the Recent Comments block with the list_comments pointer and omits older comments', async () => {
		const total = RECENT_COMMENTS_LIMIT + 3;
		const task = await createTaskWithNComments(total);
		const recent = await loadCommentHistory(
			db,
			task.id,
			masterKeyManager,
			'http://127.0.0.1:47081',
			{
				limit: RECENT_COMMENTS_LIMIT,
			},
		);

		const prompt = buildTaskPrompt(
			'System prompt',
			{
				id: task.id,
				identifier: task.identifier,
				title: 'Recent comments task',
				description: 'x',
				status: 'in_progress',
				priority: 'medium',
				project_id: projectId,
				rules: null,
				progress_summary: null,
			},
			undefined,
			{ recentComments: recent },
		);

		expect(prompt).toContain(`### Recent Comments (latest ${RECENT_COMMENTS_LIMIT})`);
		expect(prompt).toContain(`comment number ${total}`); // newest is present
		expect(prompt).not.toContain('comment number 1'); // oldest is dropped
		// With no previous run to catch up from, the whole thread is the context.
		expect(prompt).toContain('call `list_comments` to read the thread');
		expect(prompt).not.toContain('### Since your last run');
	});

	it('points a returning agent at what is new rather than the whole thread', async () => {
		const task = await createTaskWithNComments(RECENT_COMMENTS_LIMIT + 3);
		const recent = await loadCommentHistory(
			db,
			task.id,
			masterKeyManager,
			'http://127.0.0.1:47081',
			{ limit: RECENT_COMMENTS_LIMIT },
		);

		const prompt = buildTaskPrompt(
			'System prompt',
			{
				id: task.id,
				identifier: task.identifier,
				title: 'Catch-up task',
				description: 'x',
				status: 'in_progress',
				priority: 'medium',
				project_id: projectId,
				rules: null,
				progress_summary: null,
			},
			undefined,
			{
				recentComments: recent,
				catchUp: { since: '2026-08-17T04:00:00.000Z', newRows: 4, newComments: 2 },
			},
		);

		expect(prompt).toContain('### Since your last run');
		expect(prompt).toContain('4 new thread rows, 2 of them written by someone');
		expect(prompt).toContain(
			`list_comments(task_id: "${task.identifier}", since: "2026-08-17T04:00:00.000Z")`,
		);
		// The whole-thread instruction is exactly what this replaces.
		expect(prompt).not.toContain('call `list_comments` to read the thread');
	});

	it('references the waking comment for a WakeupSource.Comment (assignee) wake and tags it in the thread', async () => {
		const taskRes = await app.request(`/api/projects/${projectSlug}/tasks`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				project_id: projectId,
				title: 'Style guide task',
				assignee_id: captainMemberId,
			}),
		});
		const task = (await taskRes.json()).data as { id: string; identifier: string };

		// A human (admin) comment — author_member_id NULL — carrying the new instruction.
		const commentInsert = await db.query<{ id: string }>(
			`INSERT INTO task_comments (task_id, author_member_id, content_type, content)
			 VALUES ($1, NULL, $2::comment_content_type, $3::jsonb)
			 RETURNING id`,
			[
				task.id,
				CommentContentType.Text,
				JSON.stringify({ text: 'Please follow the new style guide: no emdashes, use hyphens.' }),
			],
		);
		const commentId = commentInsert.rows[0].id;

		const payload = {
			source: WakeupSource.Comment,
			task_id: task.id,
			comment_id: commentId,
		};

		const wakeCtx = await loadCommentWakeContext(db, payload);
		expect(wakeCtx).not.toBeNull();
		expect(wakeCtx?.authorName).toBe('Admin');
		expect(wakeCtx?.excerpt).toContain('no emdashes');
		expect(wakeCtx?.commentId).toBe(commentId);

		const recent = await loadCommentHistory(
			db,
			task.id,
			masterKeyManager,
			'http://127.0.0.1:47081',
			{
				limit: RECENT_COMMENTS_LIMIT,
			},
		);
		const prompt = buildTaskPrompt(
			'System prompt',
			{
				id: task.id,
				identifier: task.identifier,
				title: 'Style guide task',
				description: 'x',
				status: 'in_progress',
				priority: 'medium',
				project_id: projectId,
				rules: null,
				progress_summary: null,
			},
			payload,
			{ commentWakeContext: wakeCtx, recentComments: recent, wakingCommentId: commentId },
		);

		expect(prompt).toContain('## New Comment on Your Task');
		expect(prompt).toContain('> Please follow the new style guide: no emdashes, use hyphens.');
		// The same comment is tagged inside the Recent Comments thread.
		expect(prompt).toContain('← the comment that woke you');
	});

	it('renders the Recent Comments block alongside a mention handoff', async () => {
		const taskRes = await app.request(`/api/projects/${projectSlug}/tasks`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				project_id: projectId,
				title: 'Mention + recent',
				assignee_id: captainMemberId,
			}),
		});
		const task = (await taskRes.json()).data as { id: string; identifier: string };
		const commentInsert = await db.query<{ id: string }>(
			`INSERT INTO task_comments (task_id, author_member_id, content_type, content)
			 VALUES ($1, $2, $3::comment_content_type, $4::jsonb)
			 RETURNING id`,
			[
				task.id,
				captainMemberId,
				CommentContentType.Text,
				JSON.stringify({ text: '@architect please update the spec' }),
			],
		);
		const commentId = commentInsert.rows[0].id;
		const payload = {
			source: WakeupSource.Mention,
			task_id: task.id,
			comment_id: commentId,
		};
		const mentionCtx = await loadMentionContext(db, architectMemberId, teamId, payload);
		const recent = await loadCommentHistory(
			db,
			task.id,
			masterKeyManager,
			'http://127.0.0.1:47081',
			{
				limit: RECENT_COMMENTS_LIMIT,
			},
		);

		const prompt = buildTaskPrompt(
			'System prompt',
			{
				id: task.id,
				identifier: task.identifier,
				title: 'Mention + recent',
				description: 'x',
				status: 'in_progress',
				priority: 'high',
				project_id: projectId,
				rules: null,
				progress_summary: null,
			},
			payload,
			{ mentionContext: mentionCtx, recentComments: recent, wakingCommentId: commentId },
		);

		expect(prompt).toContain('## Mention Handoff');
		expect(prompt).toContain(`### Recent Comments (latest ${RECENT_COMMENTS_LIMIT})`);
	});

	it('SHARED_INSTRUCTIONS directs every agent to read the thread before acting', async () => {
		const captainSystemPrompt = await getAgentSystemPrompt(db, teamId, captainMemberId);
		const resolved = await resolveSystemPrompt(db, captainSystemPrompt, {
			teamId,
			projectId,
			agentId: captainMemberId,
		});
		expect(resolved).toContain('Read the thread before you act');
		expect(resolved).toContain('list_comments');
	});
});

// What an agent returning to a task is told to read. Without this the prompt says
// "read the thread", which on a task open for months means re-reading everything
// every run - the shape that cost one production run millions of tokens.
describe('catch-up since the agent last ran on a task', () => {
	async function seedTask(title: string): Promise<string> {
		const r = await db.query<{ id: string }>(
			`INSERT INTO tasks (team_id, project_id, number, identifier, title)
			 VALUES ($1, $2, $3, $4, $5) RETURNING id`,
			[teamId, projectId, Math.floor(Math.random() * 100000) + 5000, `CU-${title}`, title],
		);
		return r.rows[0].id;
	}

	async function seedFinishedRun(taskId: string, finishedAt: string): Promise<string> {
		const r = await db.query<{ id: string }>(
			`INSERT INTO heartbeat_runs (team_id, member_id, task_id, status, started_at, finished_at)
			 VALUES ($1, $2, $3, 'succeeded'::heartbeat_run_status, $4::timestamptz, $4::timestamptz)
			 RETURNING id`,
			[teamId, captainMemberId, taskId, finishedAt],
		);
		return r.rows[0].id;
	}

	async function seedComment(taskId: string, type: string, at: string, runId?: string) {
		await db.query(
			`INSERT INTO task_comments (task_id, content_type, content, created_at, created_by_run_id)
			 VALUES ($1, $2::comment_content_type, $3::jsonb, $4::timestamptz, $5)`,
			[taskId, type, JSON.stringify({ text: 'x', kind: 'status_change' }), at, runId ?? null],
		);
	}

	it('returns nothing on the agent first run on a task', async () => {
		const taskId = await seedTask('first');
		expect(
			await loadCatchUpSinceLastRun(db, captainMemberId, taskId, crypto.randomUUID()),
		).toBeNull();
	});

	it('counts what landed after the previous run, excluding run markers', async () => {
		const taskId = await seedTask('counts');
		await seedFinishedRun(taskId, '2026-03-01T10:00:00Z');
		await seedComment(taskId, 'text', '2026-03-01T09:00:00Z'); // before, ignored
		await seedComment(taskId, 'text', '2026-03-01T11:00:00Z');
		await seedComment(taskId, 'text', '2026-03-01T12:00:00Z');
		await seedComment(taskId, 'system', '2026-03-01T13:00:00Z');
		await seedComment(taskId, 'run', '2026-03-01T14:00:00Z');

		const current = await seedFinishedRun(taskId, '2026-03-01T15:00:00Z');
		const catchUp = await loadCatchUpSinceLastRun(db, captainMemberId, taskId, current);
		expect(catchUp).not.toBeNull();
		expect(new Date(catchUp!.since).toISOString()).toBe('2026-03-01T10:00:00.000Z');
		// Two text rows plus the system row; the run marker is not part of the read.
		expect(catchUp!.newRows).toBe(3);
		expect(catchUp!.newComments).toBe(2);
	});

	it('does not count the run own writes back to it', async () => {
		const taskId = await seedTask('self');
		await seedFinishedRun(taskId, '2026-03-02T10:00:00Z');
		const current = await seedFinishedRun(taskId, '2026-03-02T12:00:00Z');
		await seedComment(taskId, 'text', '2026-03-02T11:00:00Z', current);

		const catchUp = await loadCatchUpSinceLastRun(db, captainMemberId, taskId, current);
		expect(catchUp!.newRows).toBe(0);
	});

	it('measures from the latest previous run, not the first', async () => {
		const taskId = await seedTask('latest');
		await seedFinishedRun(taskId, '2026-03-03T08:00:00Z');
		await seedFinishedRun(taskId, '2026-03-03T14:00:00Z');
		await seedComment(taskId, 'text', '2026-03-03T10:00:00Z'); // between the two
		await seedComment(taskId, 'text', '2026-03-03T15:00:00Z');

		const current = await seedFinishedRun(taskId, '2026-03-03T16:00:00Z');
		const catchUp = await loadCatchUpSinceLastRun(db, captainMemberId, taskId, current);
		expect(new Date(catchUp!.since).toISOString()).toBe('2026-03-03T14:00:00.000Z');
		expect(catchUp!.newRows).toBe(1);
	});
});
