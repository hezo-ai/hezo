import type { PGlite } from '@electric-sql/pglite';
import { CommentContentType, WakeupSource } from '@hezo/shared';
import type { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { MasterKeyManager } from '../src/crypto/master-key';
import type { Env } from '../src/lib/types';
import { safeClose } from './helpers';
import {
	authHeader,
	createTestApp,
	createTestProject,
	instanceCeoId,
	mintAgentToken,
} from './helpers/app';

let app: Hono<Env>;
let db: PGlite;
let token: string;
let masterKeyManager: MasterKeyManager;

let teamId: string;
let teamSlug: string;
let projectId: string;
let projectSlug: string;
let productLeadId: string;
let architectId: string;
let captainId: string;
let engineerId: string;

interface WakeupRow {
	id: string;
	member_id: string;
	source: string;
	payload: { source?: string; task_id?: string; comment_id?: string };
}

async function wakeupsForComment(commentId: string): Promise<WakeupRow[]> {
	const res = await db.query<WakeupRow>(
		`SELECT id, member_id, source::text AS source, payload
		 FROM agent_wakeup_requests
		 WHERE payload->>'comment_id' = $1
		 ORDER BY created_at ASC`,
		[commentId],
	);
	return res.rows;
}

// Inserts an task directly so no side-effect wakeups fire (the REST
// create-task path queues an assignment wakeup that would coalesce with
// the comment wakeups we're trying to observe).
async function insertTask(assigneeId: string, title: string): Promise<string> {
	const meta = await db.query<{ task_prefix: string; number: number }>(
		`SELECT p.task_prefix, next_project_task_number(p.id) AS number
		 FROM projects p WHERE p.id = $1`,
		[projectId],
	);
	const n = meta.rows[0].number;
	const res = await db.query<{ id: string }>(
		`INSERT INTO tasks (team_id, project_id, assignee_id, number, identifier, title, status, priority, labels)
		 VALUES ($1, $2, $3, $4, $5, $6, 'backlog'::task_status, 'medium'::task_priority, '[]'::jsonb)
		 RETURNING id`,
		[teamId, projectId, assigneeId, n, `${meta.rows[0].task_prefix}-${n}`, title],
	);
	return res.rows[0].id;
}

async function setup(
	assigneeId: string,
	authorAgentId: string,
	title: string,
): Promise<{ taskId: string; agentToken: string }> {
	const taskId = await insertTask(assigneeId, title);
	const { token: agentToken } = await mintAgentToken(
		db,
		masterKeyManager,
		authorAgentId,
		teamId,
		taskId,
	);
	return { taskId, agentToken };
}

async function postMcpComment(
	agentToken: string,
	taskId: string,
	content: string,
): Promise<string> {
	const res = await app.request('/mcp', {
		method: 'POST',
		headers: { ...authHeader(agentToken), 'Content-Type': 'application/json' },
		body: JSON.stringify({
			jsonrpc: '2.0',
			method: 'tools/call',
			params: {
				name: 'create_comment',
				arguments: { project: projectId, task_id: taskId, content },
			},
			id: 1,
		}),
	});
	expect(res.status).toBe(200);
	const body = (await res.json()) as {
		result: { content: Array<{ type: string; text: string }> };
	};
	const inserted = JSON.parse(body.result.content[0].text) as { id: string };
	return inserted.id;
}

async function postAgentApiComment(
	agentToken: string,
	taskId: string,
	text: string,
): Promise<string> {
	const res = await app.request(`/agent-api/tasks/${taskId}/comments`, {
		method: 'POST',
		headers: { ...authHeader(agentToken), 'Content-Type': 'application/json' },
		body: JSON.stringify({
			content_type: CommentContentType.Text,
			content: { text },
		}),
	});
	expect(res.status).toBe(201);
	return (await res.json()).data.id;
}

beforeAll(async () => {
	const ctx = await createTestApp();
	app = ctx.app;
	db = ctx.db;
	token = ctx.token;
	masterKeyManager = ctx.masterKeyManager;

	const typesRes = await app.request('/api/team-templates', { headers: authHeader(token) });
	const typeId = (await typesRes.json()).data.find(
		(t: Record<string, unknown>) => t.name === 'Startup',
	).id;

	const teamRes = await app.request('/api/teams', {
		method: 'POST',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify({
			name: 'Comment Wakeups Co',
			template_id: typeId,
		}),
	});
	const teamData = (await teamRes.json()).data;
	teamId = teamData.id;
	teamSlug = teamData.slug;

	projectSlug = (await (await createTestProject(db, teamId, { name: 'Setup Project' })).json()).data
		.slug;
	const agentsRes = await app.request(`/api/projects/${projectSlug}/agents`, {
		headers: authHeader(token),
	});
	const agents = (await agentsRes.json()).data as Array<{ id: string; slug: string }>;
	captainId = agents.find((a) => a.slug === 'captain')!.id;
	architectId = agents.find((a) => a.slug === 'architect')!.id;
	productLeadId = agents.find((a) => a.slug === 'product-lead')!.id;
	engineerId = agents.find((a) => a.slug === 'engineer')!.id;

	const projectRes = await createTestProject(db, teamId, {
		name: 'Test Project',
		description: 'x',
	});
	const projectData = (await projectRes.json()).data;
	projectId = projectData.id;
	projectSlug = projectData.slug;
});

afterAll(async () => {
	await safeClose(db);
});

beforeEach(async () => {
	await db.query('DELETE FROM agent_wakeup_requests');
});

describe('MCP create_comment fires mention-only wakeups', () => {
	it('wakes a mentioned agent who is not the author or assignee', async () => {
		const { taskId, agentToken } = await setup(captainId, productLeadId, 'Captain roadmap ticket');
		const commentId = await postMcpComment(
			agentToken,
			taskId,
			'@architect please review the PRD when you get a chance.',
		);

		const wakeups = await wakeupsForComment(commentId);
		const mention = wakeups.find(
			(w) => w.source === WakeupSource.Mention && w.member_id === architectId,
		);
		expect(mention).toBeDefined();
		expect(mention?.payload.source).toBe(WakeupSource.Mention);
		expect(mention?.payload.task_id).toBe(taskId);
	});

	it('does not wake the assignee when a plain (non-mentioning) comment is posted', async () => {
		const { taskId, agentToken } = await setup(architectId, productLeadId, 'Architecture task');
		const commentId = await postMcpComment(agentToken, taskId, 'Added context for you.');

		const wakeups = await wakeupsForComment(commentId);
		expect(wakeups).toEqual([]);
	});

	it('wakes only @-mentioned agents, not the assignee, on a mention-bearing comment', async () => {
		const { taskId, agentToken } = await setup(captainId, productLeadId, 'Cross-team ticket');
		const commentId = await postMcpComment(
			agentToken,
			taskId,
			'@architect take a look — Captain please weigh in.',
		);

		const wakeups = await wakeupsForComment(commentId);
		const mentionTargets = wakeups
			.filter((w) => w.source === WakeupSource.Mention)
			.map((w) => w.member_id);
		expect(mentionTargets).toEqual([architectId]);
		expect(wakeups.some((w) => w.source === WakeupSource.Comment)).toBe(false);
	});

	it('skips self-mentions', async () => {
		const { taskId, agentToken } = await setup(architectId, architectId, 'Architect own ticket');
		const commentId = await postMcpComment(
			agentToken,
			taskId,
			'@architect reminding myself to do this.',
		);

		const wakeups = await wakeupsForComment(commentId);
		expect(wakeups).toEqual([]);
	});

	it('ignores @mentions inside fenced code blocks', async () => {
		const { taskId, agentToken } = await setup(captainId, productLeadId, 'PRD draft');
		const commentId = await postMcpComment(
			agentToken,
			taskId,
			'Example snippet:\n```\nsend to @architect later\n```\nno real mention here.',
		);

		const wakeups = await wakeupsForComment(commentId);
		expect(wakeups.some((w) => w.member_id === architectId)).toBe(false);
	});

	it('does not wake an unknown slug', async () => {
		const { taskId, agentToken } = await setup(captainId, productLeadId, 'Unknown mention');
		const commentId = await postMcpComment(agentToken, taskId, '@not-a-real-agent please help');

		const wakeups = await wakeupsForComment(commentId);
		expect(wakeups.filter((w) => w.source === WakeupSource.Mention)).toEqual([]);
	});

	it('does not wake on the passive @@<slug> form', async () => {
		const { taskId, agentToken } = await setup(captainId, productLeadId, 'Passive plan table');
		const commentId = await postMcpComment(
			agentToken,
			taskId,
			'Planning chain: BE-2 → @@architect, BE-3 → @@product-lead.',
		);

		const wakeups = await wakeupsForComment(commentId);
		expect(wakeups).toEqual([]);
	});

	it('wakes only the @-mentioned agent when @@ and @ are mixed in the same comment', async () => {
		const { taskId, agentToken } = await setup(captainId, captainId, 'Mixed passive + active');
		const commentId = await postMcpComment(
			agentToken,
			taskId,
			'Plan: BE-2 → @@product-lead (already routed). @architect please confirm scope here.',
		);

		const wakeups = await wakeupsForComment(commentId);
		const mentionTargets = wakeups
			.filter((w) => w.source === WakeupSource.Mention)
			.map((w) => w.member_id);
		expect(mentionTargets).toEqual([architectId]);
		expect(wakeups.some((w) => w.member_id === productLeadId)).toBe(false);
	});

	it('wakes the HQ CEO when @ceo is mentioned, scoped to the task team', async () => {
		const ceoId = await instanceCeoId(db);
		const { taskId, agentToken } = await setup(captainId, engineerId, 'Escalate to CEO');
		const commentId = await postMcpComment(
			agentToken,
			taskId,
			'@ceo can you weigh in on priorities here?',
		);

		const wakeups = await wakeupsForComment(commentId);
		const ceoWake = wakeups.find((w) => w.member_id === ceoId);
		expect(ceoWake).toBeDefined();
		if (!ceoWake) throw new Error('expected a CEO mention wakeup');
		expect(ceoWake.source).toBe(WakeupSource.Mention);
		expect(ceoWake.payload.task_id).toBe(taskId);

		// The CEO lives in HQ, but the wakeup carries the task's (non-HQ) team so
		// the run executes scoped to this project (the run-team split).
		const teamCheck = await db.query<{ team_id: string }>(
			'SELECT team_id FROM agent_wakeup_requests WHERE id = $1',
			[ceoWake.id],
		);
		expect(teamCheck.rows[0]?.team_id).toBe(teamId);
	});
});

describe('agent-api POST comments fires mention-only wakeups', () => {
	it('wakes a mentioned agent on an agent-api-posted comment', async () => {
		const { taskId, agentToken } = await setup(
			captainId,
			productLeadId,
			'Captain roadmap ticket 2',
		);
		const commentId = await postAgentApiComment(
			agentToken,
			taskId,
			'@architect could you weigh in on §FR-20?',
		);

		const wakeups = await wakeupsForComment(commentId);
		const mention = wakeups.find(
			(w) => w.source === WakeupSource.Mention && w.member_id === architectId,
		);
		expect(mention).toBeDefined();
	});

	it('does not wake the assignee on a plain agent-api comment from a different agent', async () => {
		const { taskId, agentToken } = await setup(architectId, productLeadId, 'Architecture task 2');
		const commentId = await postAgentApiComment(agentToken, taskId, 'More context for you here.');

		const wakeups = await wakeupsForComment(commentId);
		expect(wakeups).toEqual([]);
	});

	it('skips non-text content types even when they contain @-mentions', async () => {
		const { taskId, agentToken } = await setup(captainId, productLeadId, 'Trace ticket');
		const res = await app.request(`/agent-api/tasks/${taskId}/comments`, {
			method: 'POST',
			headers: { ...authHeader(agentToken), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				content_type: CommentContentType.Trace,
				content: { text: '@architect tool output' },
			}),
		});
		expect(res.status).toBe(201);
		const commentId = (await res.json()).data.id;

		const wakeups = await wakeupsForComment(commentId);
		expect(wakeups).toEqual([]);
	});
});

describe('admin POST comments honors wake_assignee opt-in', () => {
	async function postAdminComment(taskId: string, body: Record<string, unknown>): Promise<string> {
		const res = await app.request(`/api/projects/${projectSlug}/tasks/${taskId}/comments`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify(body),
		});
		expect(res.status).toBe(201);
		return (await res.json()).data.id;
	}

	it('wakes the assignee when wake_assignee is true', async () => {
		const taskId = await insertTask(architectId, 'Admin wake true');
		const commentId = await postAdminComment(taskId, {
			content_type: CommentContentType.Text,
			content: { text: 'Take a look when you can.' },
			wake_assignee: true,
		});

		const wakeups = await wakeupsForComment(commentId);
		expect(wakeups).toHaveLength(1);
		expect(wakeups[0].source).toBe(WakeupSource.Comment);
		expect(wakeups[0].member_id).toBe(architectId);
		expect(wakeups[0].payload.task_id).toBe(taskId);
		expect(wakeups[0].payload.comment_id).toBe(commentId);
	});

	it('does not wake the assignee when wake_assignee is false', async () => {
		const taskId = await insertTask(architectId, 'Admin wake false');
		const commentId = await postAdminComment(taskId, {
			content_type: CommentContentType.Text,
			content: { text: 'Just a note.' },
			wake_assignee: false,
		});

		const wakeups = await wakeupsForComment(commentId);
		expect(wakeups).toEqual([]);
	});

	it('does not wake the assignee when wake_assignee is omitted', async () => {
		const taskId = await insertTask(architectId, 'Admin wake omitted');
		const commentId = await postAdminComment(taskId, {
			content_type: CommentContentType.Text,
			content: { text: 'No flag at all.' },
		});

		const wakeups = await wakeupsForComment(commentId);
		expect(wakeups).toEqual([]);
	});

	it('does not double-fire when the assignee is also @-mentioned', async () => {
		const taskId = await insertTask(architectId, 'Admin wake mention overlap');
		const commentId = await postAdminComment(taskId, {
			content_type: CommentContentType.Text,
			content: { text: '@architect please weigh in.' },
			wake_assignee: true,
		});

		const wakeups = await wakeupsForComment(commentId);
		expect(wakeups).toHaveLength(1);
		expect(wakeups[0].source).toBe(WakeupSource.Mention);
		expect(wakeups[0].member_id).toBe(architectId);
	});

	it('ignores wake_assignee when posted via the agent-api', async () => {
		const { taskId, agentToken } = await setup(architectId, productLeadId, 'Agent flag ignored');
		const res = await app.request(`/agent-api/tasks/${taskId}/comments`, {
			method: 'POST',
			headers: { ...authHeader(agentToken), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				content_type: CommentContentType.Text,
				content: { text: 'Plain agent comment.' },
				wake_assignee: true,
			}),
		});
		expect(res.status).toBe(201);
		const commentId = (await res.json()).data.id;

		const wakeups = await wakeupsForComment(commentId);
		expect(wakeups).toEqual([]);
	});
});

describe('explicit reply wakeups via parent_comment_id', () => {
	async function insertCommentBy(
		taskId: string,
		authorMemberId: string | null,
		text: string,
	): Promise<string> {
		const res = await db.query<{ id: string }>(
			`INSERT INTO task_comments (task_id, author_member_id, content_type, content)
			 VALUES ($1, $2, 'text'::comment_content_type, $3::jsonb)
			 RETURNING id`,
			[taskId, authorMemberId, JSON.stringify({ text })],
		);
		return res.rows[0].id;
	}

	async function setTeamSetting(key: string, value: unknown): Promise<void> {
		await db.query(`UPDATE teams SET settings = settings || $1::jsonb WHERE id = $2`, [
			JSON.stringify({ [key]: value }),
			teamId,
		]);
	}

	async function postMcpReply(
		agentToken: string,
		taskId: string,
		text: string,
		parentCommentId: string,
	): Promise<string> {
		const res = await app.request('/mcp', {
			method: 'POST',
			headers: { ...authHeader(agentToken), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				jsonrpc: '2.0',
				method: 'tools/call',
				params: {
					name: 'create_comment',
					arguments: {
						project: projectId,
						task_id: taskId,
						content: text,
						parent_comment_id: parentCommentId,
					},
				},
				id: 1,
			}),
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as { result: { content: Array<{ text: string }> } };
		const inserted = JSON.parse(body.result.content[0].text) as { id?: string; error?: string };
		if (!inserted.id) throw new Error(`MCP reply rejected: ${inserted.error}`);
		return inserted.id;
	}

	beforeEach(async () => {
		await db.query('DELETE FROM agent_wakeup_requests');
		await db.query('DELETE FROM heartbeat_runs');
		await db.query('DELETE FROM task_comments');
		await setTeamSetting('wake_mentioner_on_reply', true);
	});

	it('wakes the parent comment author when an agent replies via MCP create_comment', async () => {
		const taskId = await insertTask(captainId, 'Reply basic MCP');
		const parentId = await insertCommentBy(taskId, captainId, 'Please proceed with the plan.');
		const { token: architectToken } = await mintAgentToken(
			db,
			masterKeyManager,
			architectId,
			teamId,
			taskId,
		);

		const replyId = await postMcpReply(architectToken, taskId, 'On it.', parentId);

		const wakeups = await wakeupsForComment(replyId);
		expect(wakeups.filter((w) => w.source === WakeupSource.Reply)).toHaveLength(1);
		const reply = wakeups.find((w) => w.source === WakeupSource.Reply)!;
		expect(reply.member_id).toBe(captainId);
		expect(reply.payload.task_id).toBe(taskId);
		expect(reply.payload.comment_id).toBe(replyId);
		expect((reply.payload as Record<string, unknown>).triggering_comment_id).toBe(parentId);
		expect((reply.payload as Record<string, unknown>).responder_member_id).toBe(architectId);
	});

	it('also fires when the reply is posted via the agent-api', async () => {
		const taskId = await insertTask(captainId, 'Reply agent-api');
		const parentId = await insertCommentBy(taskId, captainId, 'Thoughts?');
		const { token: architectToken } = await mintAgentToken(
			db,
			masterKeyManager,
			architectId,
			teamId,
			taskId,
		);

		const res = await app.request(`/agent-api/tasks/${taskId}/comments`, {
			method: 'POST',
			headers: { ...authHeader(architectToken), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				content_type: CommentContentType.Text,
				content: { text: 'Acknowledged.' },
				parent_comment_id: parentId,
			}),
		});
		expect(res.status).toBe(201);
		const replyId = (await res.json()).data.id;

		const wakeups = await wakeupsForComment(replyId);
		expect(wakeups.some((w) => w.source === WakeupSource.Reply && w.member_id === captainId)).toBe(
			true,
		);
	});

	it('fires when a Admin (human) user posts the reply', async () => {
		const taskId = await insertTask(architectId, 'Admin reply');
		const parentId = await insertCommentBy(taskId, architectId, 'Update from architect.');

		const res = await app.request(`/api/projects/${projectSlug}/tasks/${taskId}/comments`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				content_type: CommentContentType.Text,
				content: { text: 'Thanks, please continue.' },
				parent_comment_id: parentId,
			}),
		});
		expect(res.status).toBe(201);
		const replyId = (await res.json()).data.id;

		const wakeups = await wakeupsForComment(replyId);
		const reply = wakeups.find((w) => w.source === WakeupSource.Reply);
		expect(reply).toBeDefined();
		expect(reply!.member_id).toBe(architectId);
		expect((reply!.payload as Record<string, unknown>).responder_member_id).toBe(null);
	});

	it('does not wake when the parent author is a human (no member id)', async () => {
		const taskId = await insertTask(architectId, 'Human parent');
		const parentId = await insertCommentBy(taskId, null, 'Admin user kicked this off.');
		const { token: architectToken } = await mintAgentToken(
			db,
			masterKeyManager,
			architectId,
			teamId,
			taskId,
		);

		const replyId = await postMcpReply(architectToken, taskId, 'Looking into it.', parentId);
		const wakeups = await wakeupsForComment(replyId);
		expect(wakeups.filter((w) => w.source === WakeupSource.Reply)).toEqual([]);
	});

	it('does not wake when the agent replies to its own earlier comment', async () => {
		const taskId = await insertTask(architectId, 'Self reply');
		const parentId = await insertCommentBy(taskId, architectId, 'First note.');
		const { token: architectToken } = await mintAgentToken(
			db,
			masterKeyManager,
			architectId,
			teamId,
			taskId,
		);

		const replyId = await postMcpReply(architectToken, taskId, 'Follow-up note.', parentId);
		const wakeups = await wakeupsForComment(replyId);
		expect(wakeups.filter((w) => w.source === WakeupSource.Reply)).toEqual([]);
	});

	it('suppresses reply wakeups when wake_mentioner_on_reply is false', async () => {
		await setTeamSetting('wake_mentioner_on_reply', false);
		const taskId = await insertTask(captainId, 'Reply disabled');
		const parentId = await insertCommentBy(taskId, captainId, '@architect please take a look.');
		const { token: architectToken } = await mintAgentToken(
			db,
			masterKeyManager,
			architectId,
			teamId,
			taskId,
		);

		const replyId = await postMcpReply(architectToken, taskId, 'Following up.', parentId);
		const wakeups = await wakeupsForComment(replyId);
		expect(wakeups.filter((w) => w.source === WakeupSource.Reply)).toEqual([]);
	});

	it('dedupes reply wakeups with mention wakeups when the reply also @-mentions the parent author', async () => {
		const taskId = await insertTask(captainId, 'Reply overlap mention');
		const parentId = await insertCommentBy(taskId, captainId, 'Please proceed.');
		const { token: architectToken } = await mintAgentToken(
			db,
			masterKeyManager,
			architectId,
			teamId,
			taskId,
		);

		const replyId = await postMcpReply(
			architectToken,
			taskId,
			'@captain done — follow-up in new ticket.',
			parentId,
		);

		const wakeups = await wakeupsForComment(replyId);
		const ceoWakeups = wakeups.filter((w) => w.member_id === captainId);
		expect(ceoWakeups).toHaveLength(1);
		expect(ceoWakeups[0].source).toBe(WakeupSource.Mention);
	});

	it('rejects parent_comment_id from a different task', async () => {
		const taskA = await insertTask(captainId, 'Task A');
		const taskB = await insertTask(architectId, 'Task B');
		const parentIdInA = await insertCommentBy(taskA, captainId, 'Comment in A.');
		const { token: architectToken } = await mintAgentToken(
			db,
			masterKeyManager,
			architectId,
			teamId,
			taskB,
		);

		const res = await app.request('/mcp', {
			method: 'POST',
			headers: { ...authHeader(architectToken), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				jsonrpc: '2.0',
				method: 'tools/call',
				params: {
					name: 'create_comment',
					arguments: {
						project: projectId,
						task_id: taskB,
						content: 'Cross-task reply.',
						parent_comment_id: parentIdInA,
					},
				},
				id: 1,
			}),
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as { result: { content: Array<{ text: string }> } };
		const result = JSON.parse(body.result.content[0].text) as { id?: string; error?: string };
		expect(result.error).toContain('parent_comment_id');
		expect(result.id).toBeUndefined();
	});

	it('does not fire reply wakeup when parent_comment_id is omitted', async () => {
		const taskId = await insertTask(captainId, 'No parent');
		await insertCommentBy(taskId, captainId, '@architect please take a look.');
		const { token: architectToken } = await mintAgentToken(
			db,
			masterKeyManager,
			architectId,
			teamId,
			taskId,
		);

		const replyId = await postMcpComment(architectToken, taskId, 'Acknowledging.');
		const wakeups = await wakeupsForComment(replyId);
		expect(wakeups.filter((w) => w.source === WakeupSource.Reply)).toEqual([]);
	});
});

describe('mention wakeup idempotency by (task, mentioned, author)', () => {
	async function backdateWakeup(wakeupId: string, seconds = 5): Promise<void> {
		await db.query(
			`UPDATE agent_wakeup_requests
			 SET created_at = now() - ($1 || ' seconds')::interval
			 WHERE id = $2`,
			[String(seconds), wakeupId],
		);
	}

	async function queuedMentionsFor(taskId: string, mentionedId: string): Promise<WakeupRow[]> {
		const res = await db.query<WakeupRow>(
			`SELECT id, member_id, source::text AS source, payload
			 FROM agent_wakeup_requests
			 WHERE source = 'mention'::wakeup_source
			   AND status = 'queued'::wakeup_status
			   AND member_id = $1
			   AND payload->>'task_id' = $2
			 ORDER BY created_at ASC`,
			[mentionedId, taskId],
		);
		return res.rows;
	}

	it('collapses repeated @-mentions by the same author of the same agent on the same task', async () => {
		const { taskId, agentToken } = await setup(captainId, productLeadId, 'Idempotent retry');

		const firstCommentId = await postAgentApiComment(
			agentToken,
			taskId,
			'@architect please confirm scope.',
		);
		const firstWakeups = await queuedMentionsFor(taskId, architectId);
		expect(firstWakeups).toHaveLength(1);
		expect(firstWakeups[0].payload.comment_id).toBe(firstCommentId);

		await backdateWakeup(firstWakeups[0].id);

		const secondCommentId = await postAgentApiComment(
			agentToken,
			taskId,
			'@architect bumping this — still need a confirm.',
		);
		expect(secondCommentId).not.toBe(firstCommentId);

		const afterSecond = await queuedMentionsFor(taskId, architectId);
		expect(afterSecond).toHaveLength(1);
		expect(afterSecond[0].id).toBe(firstWakeups[0].id);
		expect(afterSecond[0].payload.comment_id).toBe(firstCommentId);
	});

	it('collapses queued wakeups when different authors mention the same agent on the same task', async () => {
		const taskId = await insertTask(captainId, 'Two authors, one target');
		const { token: productLeadToken } = await mintAgentToken(
			db,
			masterKeyManager,
			productLeadId,
			teamId,
			taskId,
		);
		const { token: engineerToken } = await mintAgentToken(
			db,
			masterKeyManager,
			engineerId,
			teamId,
			taskId,
		);

		await postAgentApiComment(productLeadToken, taskId, '@architect spec ready for review.');
		const afterFirst = await queuedMentionsFor(taskId, architectId);
		expect(afterFirst).toHaveLength(1);
		await backdateWakeup(afterFirst[0].id);

		await postAgentApiComment(engineerToken, taskId, '@architect peer-review note from engineer.');
		const afterSecond = await queuedMentionsFor(taskId, architectId);
		expect(afterSecond).toHaveLength(1);
		expect(afterSecond[0].id).toBe(afterFirst[0].id);
	});

	it('lets a new wakeup be created once the queued one transitions out of queued', async () => {
		const { taskId, agentToken } = await setup(captainId, productLeadId, 'Drain and re-mention');

		await postAgentApiComment(agentToken, taskId, '@architect please weigh in.');
		const queued = await queuedMentionsFor(taskId, architectId);
		expect(queued).toHaveLength(1);

		await db.query(
			`UPDATE agent_wakeup_requests SET status = 'completed'::wakeup_status WHERE id = $1`,
			[queued[0].id],
		);

		await postAgentApiComment(agentToken, taskId, '@architect new ask after drain.');
		const afterDrain = await queuedMentionsFor(taskId, architectId);
		expect(afterDrain).toHaveLength(1);
		expect(afterDrain[0].id).not.toBe(queued[0].id);
	});

	it('collapses repeated @-mentions across admin and agent authors', async () => {
		const taskId = await insertTask(captainId, 'Admin scoping');

		const firstAdmin = await app.request(`/api/projects/${projectSlug}/tasks/${taskId}/comments`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				content_type: CommentContentType.Text,
				content: { text: '@architect please respond.' },
			}),
		});
		expect(firstAdmin.status).toBe(201);
		const afterFirstAdmin = await queuedMentionsFor(taskId, architectId);
		expect(afterFirstAdmin).toHaveLength(1);
		await backdateWakeup(afterFirstAdmin[0].id);

		const secondAdmin = await app.request(`/api/projects/${projectSlug}/tasks/${taskId}/comments`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				content_type: CommentContentType.Text,
				content: { text: '@architect bumping again from the admin.' },
			}),
		});
		expect(secondAdmin.status).toBe(201);
		const afterSecondAdmin = await queuedMentionsFor(taskId, architectId);
		expect(afterSecondAdmin).toHaveLength(1);
		expect(afterSecondAdmin[0].id).toBe(afterFirstAdmin[0].id);

		await backdateWakeup(afterSecondAdmin[0].id);
		const { token: productLeadToken } = await mintAgentToken(
			db,
			masterKeyManager,
			productLeadId,
			teamId,
			taskId,
		);
		await postAgentApiComment(productLeadToken, taskId, '@architect agent-side ping.');
		const afterAgent = await queuedMentionsFor(taskId, architectId);
		expect(afterAgent).toHaveLength(1);
		expect(afterAgent[0].id).toBe(afterSecondAdmin[0].id);
	});
});
