import { CommentContentType, TaskStatus } from '@hezo/shared';
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
let projectId: string;
let projectSlug: string;
let captainId: string;

async function insertTask(assigneeId: string, title: string): Promise<string> {
	const meta = await db.query<{ task_prefix: string; number: number }>(
		`SELECT p.task_prefix, next_project_task_number(p.id) AS number
		 FROM projects p WHERE p.id = $1`,
		[projectId],
	);
	const n = meta.rows[0].number;
	const res = await db.query<{ id: string }>(
		`INSERT INTO tasks (team_id, project_id, assignee_id, number, identifier, title, status, priority, labels)
		 VALUES ($1, $2, $3, $4, $5, $6, 'in_progress'::task_status, 'medium'::task_priority, '[]'::jsonb)
		 RETURNING id`,
		[teamId, projectId, assigneeId, n, `${meta.rows[0].task_prefix}-${n}`, title],
	);
	return res.rows[0].id;
}

async function mcpCall(
	callerToken: string,
	name: string,
	args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
	const res = await app.request('/mcp', {
		method: 'POST',
		headers: { ...authHeader(callerToken), 'Content-Type': 'application/json' },
		body: JSON.stringify({
			jsonrpc: '2.0',
			method: 'tools/call',
			params: { name, arguments: args },
			id: 1,
		}),
	});
	expect(res.status).toBe(200);
	const body = (await res.json()) as {
		result: { content: Array<{ type: string; text: string }> };
	};
	return JSON.parse(body.result.content[0].text) as Record<string, unknown>;
}

async function patchStatus(
	callerToken: string,
	taskIdArg: string,
	status: TaskStatus,
): Promise<Response> {
	return app.request(`/api/projects/${projectSlug}/tasks/${taskIdArg}`, {
		method: 'PATCH',
		headers: { ...authHeader(callerToken), 'Content-Type': 'application/json' },
		body: JSON.stringify({ status }),
	});
}

/**
 * The incident shape: the task's own assignee posts an active @admin question.
 * Returns the asking agent's token and run so tests can close (or fail to
 * close) the task as that same agent, and asserts the fan-out actually landed
 * rows — otherwise the gate assertions below would pass vacuously.
 */
async function postAdminAsk(taskIdArg: string): Promise<{ agentToken: string; runId: string }> {
	const { token: agentToken, runId } = await mintAgentToken(
		db,
		masterKeyManager,
		captainId,
		teamId,
		taskIdArg,
	);
	const created = await mcpCall(agentToken, 'create_comment', {
		project: projectId,
		task_id: taskIdArg,
		content: '@admin — is the license change intentional? This gates the final sign-off.',
	});
	expect(created.id).toBeTruthy();
	const mentions = await db.query('SELECT 1 FROM admin_mentions WHERE comment_id = $1', [
		created.id,
	]);
	expect(mentions.rows.length).toBeGreaterThan(0);
	return { agentToken, runId };
}

async function humanReply(taskIdArg: string, text: string): Promise<void> {
	const res = await app.request(`/api/projects/${projectSlug}/tasks/${taskIdArg}/comments`, {
		method: 'POST',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify({ content_type: CommentContentType.Text, content: { text } }),
	});
	expect(res.status).toBe(201);
}

async function finishRun(runId: string): Promise<void> {
	await db.query(
		`UPDATE heartbeat_runs SET status = 'succeeded'::heartbeat_run_status WHERE id = $1`,
		[runId],
	);
}

async function taskStatus(taskIdArg: string): Promise<string> {
	const r = await db.query<{ status: string }>(
		'SELECT status::text AS status FROM tasks WHERE id = $1',
		[taskIdArg],
	);
	return r.rows[0].status;
}

beforeAll(async () => {
	const ctx = await createTestApp();
	app = ctx.app;
	db = ctx.db;
	token = ctx.token;
	masterKeyManager = ctx.masterKeyManager;

	const teamRes = await createTestTeam(db, { name: 'Admin Ask Gate Co' });
	teamId = (await teamRes.json()).data.id;
	const projectRes = await createTestProject(db, teamId, { name: 'Gate Project' });
	const projectData = (await projectRes.json()).data;
	projectId = projectData.id;
	projectSlug = projectData.slug;

	const agentsRes = await app.request(`/api/projects/${projectSlug}/agents`, {
		headers: authHeader(token),
	});
	const agents = (await agentsRes.json()).data as Array<{ id: string; slug: string }>;
	captainId = agents.find((a) => a.slug === 'captain')!.id;
});

afterAll(async () => {
	await safeClose(db);
});

describe('closure rules — unanswered @admin ask blocks done (REST PATCH)', () => {
	it('rejects done from an agent while an @admin ask is unanswered', async () => {
		const taskId = await insertTask(captainId, 'Blocked by open ask');
		const { agentToken } = await postAdminAsk(taskId);

		const res = await patchStatus(agentToken, taskId, TaskStatus.Done);
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: { message: string } };
		expect(body.error.message).toMatch(/@admin/);
		expect(body.error.message).toMatch(/in_progress|review/);
		expect(await taskStatus(taskId)).toBe(TaskStatus.InProgress);
	});

	it('lets a human close through an unanswered ask', async () => {
		const taskId = await insertTask(captainId, 'Human closes anyway');
		const { runId } = await postAdminAsk(taskId);
		await finishRun(runId);

		const res = await patchStatus(token, taskId, TaskStatus.Done);
		expect(res.status).toBe(200);
		expect(await taskStatus(taskId)).toBe(TaskStatus.Done);
	});

	it('allows done once a human replied after the ask', async () => {
		const taskId = await insertTask(captainId, 'Answered ask');
		const { agentToken } = await postAdminAsk(taskId);
		await humanReply(taskId, 'Yes — the change is intentional. Proceed.');

		const res = await patchStatus(agentToken, taskId, TaskStatus.Done);
		expect(res.status).toBe(200);
		expect(await taskStatus(taskId)).toBe(TaskStatus.Done);
	});

	it('does not count a NULL-author system comment as an answer', async () => {
		const taskId = await insertTask(captainId, 'System comment is no answer');
		const { agentToken } = await postAdminAsk(taskId);
		await db.query(
			`INSERT INTO task_comments (task_id, author_member_id, content_type, content)
			 VALUES ($1, NULL, 'system'::comment_content_type, '{"text":"status changed"}'::jsonb)`,
			[taskId],
		);

		const res = await patchStatus(agentToken, taskId, TaskStatus.Done);
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: { message: string } };
		expect(body.error.message).toMatch(/@admin/);
	});

	it('leaves cancelled ungated', async () => {
		const taskId = await insertTask(captainId, 'Cancel with open ask');
		const { agentToken } = await postAdminAsk(taskId);

		const res = await patchStatus(agentToken, taskId, TaskStatus.Cancelled);
		expect(res.status).toBe(200);
		expect(await taskStatus(taskId)).toBe(TaskStatus.Cancelled);
	});

	it('does not count a human comment posted before the ask', async () => {
		const taskId = await insertTask(captainId, 'Earlier comment is no answer');
		await humanReply(taskId, 'Some earlier, unrelated context.');
		const { agentToken } = await postAdminAsk(taskId);

		const res = await patchStatus(agentToken, taskId, TaskStatus.Done);
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: { message: string } };
		expect(body.error.message).toMatch(/@admin/);
	});
});

describe('closure rules — unanswered @admin ask blocks done (MCP update_task)', () => {
	it('returns an error for an agent while the ask is unanswered, then succeeds after a human reply', async () => {
		const taskId = await insertTask(captainId, 'MCP gate check');
		const { agentToken } = await postAdminAsk(taskId);

		const blocked = await mcpCall(agentToken, 'update_task', {
			project: projectId,
			task_id: taskId,
			status: TaskStatus.Done,
		});
		expect(String(blocked.error)).toMatch(/@admin/);
		expect(await taskStatus(taskId)).toBe(TaskStatus.InProgress);

		await humanReply(taskId, 'Answered — go ahead.');
		const allowed = await mcpCall(agentToken, 'update_task', {
			project: projectId,
			task_id: taskId,
			status: TaskStatus.Done,
		});
		expect(allowed.error).toBeUndefined();
		expect(await taskStatus(taskId)).toBe(TaskStatus.Done);
	});

	it('does not gate a human admin calling over MCP', async () => {
		const taskId = await insertTask(captainId, 'MCP human bypass');
		const { runId } = await postAdminAsk(taskId);
		await finishRun(runId);

		const result = await mcpCall(token, 'update_task', {
			project: projectId,
			task_id: taskId,
			status: TaskStatus.Done,
		});
		expect(result.error).toBeUndefined();
		expect(await taskStatus(taskId)).toBe(TaskStatus.Done);
	});
});

describe('create_comment advisory — active ask on a terminal task', () => {
	it('warns an agent posting an active mention on a done task', async () => {
		const taskId = await insertTask(captainId, 'Ask on closed task');
		await db.query(`UPDATE tasks SET status = 'done'::task_status WHERE id = $1`, [taskId]);
		const { token: agentToken } = await mintAgentToken(
			db,
			masterKeyManager,
			captainId,
			teamId,
			taskId,
		);

		const result = await mcpCall(agentToken, 'create_comment', {
			project: projectId,
			task_id: taskId,
			content: '@admin — one more question about this.',
		});
		expect(String(result.warning)).toMatch(/terminal/);
		expect(String(result.warning)).toMatch(/ask BEFORE closing/);
	});

	it('does not warn on an open task', async () => {
		const taskId = await insertTask(captainId, 'Ask on open task');
		const { token: agentToken } = await mintAgentToken(
			db,
			masterKeyManager,
			captainId,
			teamId,
			taskId,
		);

		const result = await mcpCall(agentToken, 'create_comment', {
			project: projectId,
			task_id: taskId,
			content: '@admin — a question while the task is open.',
		});
		expect(result.warning).toBeUndefined();
	});

	it('does not warn for a passive @@admin reference on a done task', async () => {
		const taskId = await insertTask(captainId, 'Passive reference on closed task');
		await db.query(`UPDATE tasks SET status = 'done'::task_status WHERE id = $1`, [taskId]);
		const { token: agentToken } = await mintAgentToken(
			db,
			masterKeyManager,
			captainId,
			teamId,
			taskId,
		);

		const result = await mcpCall(agentToken, 'create_comment', {
			project: projectId,
			task_id: taskId,
			content: 'Wrapped up — @@admin signed off earlier.',
		});
		expect(result.warning).toBeUndefined();
	});
});
