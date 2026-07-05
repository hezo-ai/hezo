import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MasterKeyManager } from '../src/crypto/master-key';
import type { Db } from '../src/db/database';
import type { Env } from '../src/lib/types';
import { safeClose } from './helpers';
import {
	authHeader,
	createTestApp,
	createTestProject,
	createTestTeam,
	mintAgentToken,
} from './helpers/app';

let app: Hono<Env>;
let db: Db;
let token: string;
let masterKeyManager: MasterKeyManager;
let teamId: string;
let teamSlug: string;
let internalProjectId: string;
let projectId: string;
let projectSlug: string;
let taskId: string;
let agentId: string;
let agentSlug: string;

beforeAll(async () => {
	const ctx = await createTestApp();
	app = ctx.app;
	db = ctx.db;
	token = ctx.token;
	masterKeyManager = ctx.masterKeyManager;

	const teamRes = await createTestTeam(db, { name: 'Comment Co' });
	const teamData = (await teamRes.json()).data;
	teamId = teamData.id;
	teamSlug = teamData.slug;

	const projectRes = await createTestProject(db, teamId, {
		name: 'Main',
		description: 'Test project.',
	});
	const projectData = (await projectRes.json()).data;
	projectId = projectData.id;
	projectSlug = projectData.slug;
	internalProjectId = projectId;

	const agentRes = await app.request(`/api/projects/${projectSlug}/agents`, {
		method: 'POST',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify({ title: 'Comment Bot' }),
	});
	const agent = (await agentRes.json()).data;
	agentId = agent.id;
	agentSlug = agent.slug;

	const taskRes = await app.request(`/api/projects/${projectSlug}/tasks`, {
		method: 'POST',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify({ project_id: projectId, title: 'Test Task', assignee_id: agentId }),
	});
	taskId = (await taskRes.json()).data.id;
});

afterAll(async () => {
	await safeClose(db);
});

describe('comments CRUD', () => {
	it('creates a text comment', async () => {
		const res = await app.request(`/api/projects/${projectSlug}/tasks/${taskId}/comments`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				content_type: 'text',
				content: { text: 'Hello world' },
			}),
		});
		expect(res.status).toBe(201);
		const body = await res.json();
		expect(body.data.content_type).toBe('text');
		expect(body.data.content.text).toBe('Hello world');
	});

	it('lists comments in order', async () => {
		// Add another comment
		await app.request(`/api/projects/${projectSlug}/tasks/${taskId}/comments`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				content_type: 'text',
				content: { text: 'Second comment' },
			}),
		});

		const res = await app.request(`/api/projects/${projectSlug}/tasks/${taskId}/comments`, {
			headers: authHeader(token),
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.data.length).toBeGreaterThanOrEqual(2);
		// Ordered by created_at ASC
		expect(body.data[0].content.text).toBe('Hello world');
	});

	it('labels admin-authored comments as "Admin" and agent-authored as the agent title', async () => {
		const { token: agentToken } = await mintAgentToken(
			db,
			masterKeyManager,
			agentId,
			teamId,
			null,
			{
				projectId: internalProjectId,
			},
		);
		await app.request(`/api/projects/${projectSlug}/tasks/${taskId}/comments`, {
			method: 'POST',
			headers: { ...authHeader(agentToken), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				content_type: 'text',
				content: { text: 'From the agent' },
			}),
		});

		const res = await app.request(`/api/projects/${projectSlug}/tasks/${taskId}/comments`, {
			headers: authHeader(token),
		});
		const body = await res.json();
		const agentComment = body.data.find(
			(c: { content: { text?: string } }) => c.content.text === 'From the agent',
		);
		const adminComment = body.data.find(
			(c: { content: { text?: string } }) => c.content.text === 'Hello world',
		);
		expect(agentComment.author_name).toBe('Comment Bot');
		expect(adminComment.author_name).toBe('Admin');
	});
});

describe('comment @mention wakeups', () => {
	it('creates a mention wakeup when comment contains @agent-slug', async () => {
		await db.query('DELETE FROM agent_wakeup_requests WHERE team_id = $1', [teamId]);

		const res = await app.request(`/api/projects/${projectSlug}/tasks/${taskId}/comments`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				content_type: 'text',
				content: { text: `@${agentSlug} take a look at this` },
			}),
		});
		expect(res.status).toBe(201);

		await new Promise((r) => setTimeout(r, 100));

		const wakeups = await db.query(
			"SELECT * FROM agent_wakeup_requests WHERE member_id = $1 AND source = 'mention'",
			[agentId],
		);
		expect(wakeups.rows.length).toBeGreaterThanOrEqual(1);
	});
});

describe('comment wakeups on assigned tasks', () => {
	let assignedTaskId: string;

	beforeAll(async () => {
		const taskRes = await app.request(`/api/projects/${projectSlug}/tasks`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				project_id: projectId,
				title: 'Agent Assigned for Comment Test',
				assignee_id: agentId,
			}),
		});
		assignedTaskId = (await taskRes.json()).data.id;
		// Wait for the fire-and-forget assignment wakeup to be committed
		await new Promise((r) => setTimeout(r, 100));
	});

	it('does not wake the assignee when a plain admin comment is posted', async () => {
		await db.query('DELETE FROM agent_wakeup_requests WHERE team_id = $1', [teamId]);

		const res = await app.request(`/api/projects/${projectSlug}/tasks/${assignedTaskId}/comments`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				content_type: 'text',
				content: { text: 'Please prioritize this' },
			}),
		});
		expect(res.status).toBe(201);

		await new Promise((r) => setTimeout(r, 100));

		const wakeups = await db.query(
			'SELECT * FROM agent_wakeup_requests WHERE member_id = $1 AND team_id = $2',
			[agentId, teamId],
		);
		expect(wakeups.rows.length).toBe(0);
	});

	it('wakes the assigned agent only on a mention-bearing comment (mention source, no comment source)', async () => {
		await db.query('DELETE FROM agent_wakeup_requests WHERE team_id = $1', [teamId]);

		const res = await app.request(`/api/projects/${projectSlug}/tasks/${assignedTaskId}/comments`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				content_type: 'text',
				content: { text: `@${agentSlug} please check this` },
			}),
		});
		expect(res.status).toBe(201);

		await new Promise((r) => setTimeout(r, 100));

		const mentionWakeups = await db.query(
			"SELECT * FROM agent_wakeup_requests WHERE member_id = $1 AND source = 'mention'",
			[agentId],
		);
		expect(mentionWakeups.rows.length).toBe(1);

		const commentWakeups = await db.query(
			"SELECT * FROM agent_wakeup_requests WHERE member_id = $1 AND source = 'comment'",
			[agentId],
		);
		expect(commentWakeups.rows.length).toBe(0);
	});

	it('propagates a per-comment effort override onto the mention wakeup payload', async () => {
		await db.query('DELETE FROM agent_wakeup_requests WHERE team_id = $1', [teamId]);

		const res = await app.request(`/api/projects/${projectSlug}/tasks/${assignedTaskId}/comments`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				content_type: 'text',
				content: { text: `@${agentSlug} please think harder about this.` },
				effort: 'max',
			}),
		});
		expect(res.status).toBe(201);

		await new Promise((r) => setTimeout(r, 100));

		const wakeups = await db.query<{ payload: Record<string, unknown> }>(
			"SELECT payload FROM agent_wakeup_requests WHERE member_id = $1 AND source = 'mention'",
			[agentId],
		);
		expect(wakeups.rows.length).toBe(1);
		expect(wakeups.rows[0].payload.effort).toBe('max');
	});

	it('silently ignores an invalid effort value (does not block commenting)', async () => {
		await db.query('DELETE FROM agent_wakeup_requests WHERE team_id = $1', [teamId]);

		const res = await app.request(`/api/projects/${projectSlug}/tasks/${assignedTaskId}/comments`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				content_type: 'text',
				content: { text: `@${agentSlug} typical effort` },
				effort: 'not-a-real-level',
			}),
		});
		expect(res.status).toBe(201);

		await new Promise((r) => setTimeout(r, 100));

		const wakeups = await db.query<{ payload: Record<string, unknown> }>(
			"SELECT payload FROM agent_wakeup_requests WHERE member_id = $1 AND source = 'mention'",
			[agentId],
		);
		expect(wakeups.rows.length).toBe(1);
		expect(wakeups.rows[0].payload.effort).toBeUndefined();
	});
});
