import type { PGlite } from '@electric-sql/pglite';
import { CommentContentType, TaskStatus, WakeupSource } from '@hezo/shared';
import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Env } from '../src/lib/types';
import {
	buildTaskPrompt,
	loadMentionContext,
	loadReplyContext,
	loadSpawnedFromTask,
} from '../src/services/agent-runner';
import { getAgentSystemPrompt } from '../src/services/documents';
import { safeClose } from './helpers';
import { authHeader, createTestApp, createTestProject } from './helpers/app';

let app: Hono<Env>;
let db: PGlite;
let token: string;

let teamId: string;
let teamSlug: string;
let projectId: string;
let projectSlug: string;
let captainMemberId: string;
let architectMemberId: string;

const TRIGGERING_TASK: Parameters<typeof buildTaskPrompt>[1] = {
	id: 'filled-below',
	identifier: 'filled-below',
	title: 'Captain PRD ticket',
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

	const typesRes = await app.request('/api/team-templates', { headers: authHeader(token) });
	const typeId = (await typesRes.json()).data.find(
		(t: Record<string, unknown>) => t.name === 'Startup',
	).id;

	const teamRes = await app.request('/api/teams', {
		method: 'POST',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify({
			name: 'Mention Handoff Prompt Co',
			template_id: typeId,
		}),
	});
	const teamData = (await teamRes.json()).data;
	teamId = teamData.id;
	teamSlug = teamData.slug;

	const agentsRes = await app.request(`/api/projects/internal-${teamSlug}/agents`, {
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
			title: "Captain's PRD ticket",
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
	it('renders the handoff block with triggering ticket + author + open tickets', async () => {
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
		expect(prompt).toContain('## Handling @-mentions');
		expect(prompt).toContain('parent_task_id');
	});

	it('renders "none" when the mentioned agent has no open tickets', async () => {
		// Fresh team to isolate state — the architect in this team has no tickets.
		const typesRes = await app.request('/api/team-templates', { headers: authHeader(token) });
		const typeId = (await typesRes.json()).data.find(
			(t: Record<string, unknown>) => t.name === 'Startup',
		).id;
		const teamRes = await app.request('/api/teams', {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				name: 'No Tickets Co',
				template_id: typeId,
			}),
		});
		const soloTeam = (await teamRes.json()).data;
		const soloTeamId = soloTeam.id;
		const agentsRes = await app.request(`/api/projects/internal-${soloTeam.slug}/agents`, {
			headers: authHeader(token),
		});
		const agents = (await agentsRes.json()).data as Array<{ id: string; slug: string }>;
		const captain = agents.find((a) => a.slug === 'captain')!;
		const architect = agents.find((a) => a.slug === 'architect')!;
		const projRes = await createTestProject(db, soloTeamId, {
			name: 'No tickets',
			description: 'x',
		});
		const soloProject = (await projRes.json()).data;
		const soloProjectId = soloProject.id;
		const taskRes = await app.request(`/api/projects/${soloProject.slug}/tasks`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				project_id: soloProjectId,
				title: 'Captain ticket only',
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
				title: 'Captain ticket only',
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
		expect(prompt).toContain('### Your open tickets\nnone');
	});

	it('keeps the sub-task / peer / top-level guidance in the architect system prompt via the shared partial', async () => {
		const { triggeringTaskId, triggeringIdentifier, commentId } =
			await createTriggeringTaskWithComment('@architect review please');
		const wakeupPayload = {
			source: WakeupSource.Mention,
			task_id: triggeringTaskId,
			comment_id: commentId,
		};
		const ctx = await loadMentionContext(db, architectMemberId, teamId, wakeupPayload);

		const architectSystemPrompt = await getAgentSystemPrompt(db, teamId, architectMemberId);

		const prompt = buildTaskPrompt(
			architectSystemPrompt,
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
		expect(prompt).toContain('## Handling @-mentions');
		expect(prompt).toContain('sub-task');
		expect(prompt).toContain('peer');
		expect(prompt).toContain('top-level');
		expect(prompt).toContain('check-before-create');
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

	it('loads the reply excerpt, original excerpt, and referenced new ticket', async () => {
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
		expect(prompt).toContain('### Tickets referenced by the reply');
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
	it('renders "Parent ticket" when parent_task_id matches the spawning run', async () => {
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
				parent_task_id: parent.id,
				created_by_run_id: run.rows[0].id,
			},
			undefined,
			{ spawnedFrom: spawn },
		);
		expect(prompt).toContain(`**Parent ticket:** ${parent.identifier}`);
		expect(prompt).not.toContain('**Spawned from:**');
	});

	it('renders "Spawned from" when a sibling/top-level ticket has no structural parent', async () => {
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
				parent_task_id: null,
				created_by_run_id: run.rows[0].id,
			},
			undefined,
			{ spawnedFrom: spawn },
		);
		expect(prompt).toContain(`**Spawned from:** ${spawning.identifier}`);
		expect(prompt).not.toContain('**Parent ticket:**');
	});

	it('returns null for an orphan ticket (no parent, no created_by_run_id)', async () => {
		const spawn = await loadSpawnedFromTask(db, {
			id: '00000000-0000-0000-0000-000000000000',
			identifier: 'MHP-orphan',
			title: 'Orphan',
			description: '',
			status: 'backlog',
			priority: 'medium',
			project_id: projectId,
			rules: null,
			parent_task_id: null,
			created_by_run_id: null,
		});
		expect(spawn).toBeNull();
	});
});
