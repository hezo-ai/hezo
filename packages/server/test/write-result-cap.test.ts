import { COMMENT_TEXT_MAX_CHARS } from '@hezo/shared';
import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../src/db/database';
import type { Env } from '../src/lib/types';
import { MCP_RESULT_BYTE_LIMIT, oversizedWriteAck } from '../src/mcp/tools';
import { commentWriteAck, fitCommentForDelivery } from '../src/services/comment-wakeups';
import { safeClose } from './helpers';
import { authHeader, createTestApp, createTestProject, createTestTeam } from './helpers/app';

let app: Hono<Env>;
let db: Db;
let token: string;
let projectId: string;

beforeAll(async () => {
	const ctx = await createTestApp();
	app = ctx.app;
	db = ctx.db;
	token = ctx.token;
	const typesRes = await app.request('/api/team-templates', { headers: authHeader(token) });
	const typeId = (await typesRes.json()).data.find(
		(t: Record<string, unknown>) => t.name === 'App Team',
	).id;
	const teamRes = await createTestTeam(db, { name: 'Write Cap Co', template_id: typeId });
	const teamId = (await teamRes.json()).data.id;
	const projectRes = await createTestProject(db, teamId, {
		name: 'Write Cap Project',
		description: 'write cap',
	});
	projectId = (await projectRes.json()).data.id;
});

afterAll(async () => {
	await safeClose(db);
});

async function callTool(toolName: string, args: Record<string, unknown>): Promise<unknown> {
	const res = await app.request('/mcp', {
		method: 'POST',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify({
			jsonrpc: '2.0',
			method: 'tools/call',
			params: { name: toolName, arguments: args },
			id: 1,
		}),
	});
	const body = (await res.json()) as { result: { content: Array<{ text: string }> } };
	const text = body.result.content[0].text;
	if (text.startsWith('MCP error')) throw new Error(`${toolName}: ${text}`);
	return JSON.parse(text);
}

async function newTask(title: string): Promise<{ id: string; identifier: string }> {
	const created = (await callTool('create_task', {
		project: projectId,
		title,
		assignee_slug: 'engineer',
	})) as {
		id?: string;
		identifier?: string;
		error?: string;
	};
	if (!created.id || !created.identifier)
		throw new Error(`create_task: ${JSON.stringify(created)}`);
	return { id: created.id, identifier: created.identifier };
}

async function commentCount(taskId: string): Promise<number> {
	const r = await db.query<{ n: string }>(
		`SELECT count(*) AS n FROM task_comments WHERE task_id = $1 AND content_type = 'text'`,
		[taskId],
	);
	return Number(r.rows[0].n);
}

describe('oversizedWriteAck', () => {
	it('keeps the identifiers of what was written and drops everything else', () => {
		const result = {
			id: 'c1',
			public_id: '20260922000000',
			content: { text: 'x'.repeat(100_000) },
			search_tsv: "'x':1",
		};
		const ack = oversizedWriteAck(result, 200_000, MCP_RESULT_BYTE_LIMIT) as Record<
			string,
			unknown
		>;
		expect(ack.result_truncated).toBe(true);
		expect(ack.note).toContain('Do not repeat the call');
		expect(ack.id).toBe('c1');
		expect(ack.public_id).toBe('20260922000000');
		expect(ack).not.toHaveProperty('search_tsv');
		expect(JSON.stringify(ack)).not.toContain('xxxx');
	});

	it('acknowledges every item of a batch by index and id', () => {
		const result = Array.from({ length: 3 }, (_, index) => ({
			index,
			ok: true,
			task: { id: `t${index}`, identifier: `WC-${index}`, description: 'y'.repeat(40_000) },
		}));
		const ack = oversizedWriteAck(result, 120_000, MCP_RESULT_BYTE_LIMIT) as {
			items: Array<{ index: number; ok: boolean; task: { id: string; identifier: string } }>;
		};
		expect(ack.items.map((i) => i.task.identifier)).toEqual(['WC-0', 'WC-1', 'WC-2']);
		expect(ack.items.every((i) => i.ok)).toBe(true);
		expect(JSON.stringify(ack)).not.toContain('yyyy');
	});

	it('still says the write succeeded when even the identifiers do not fit', () => {
		const result = Array.from({ length: 5_000 }, (_, index) => ({ index, id: `id-${index}` }));
		const ack = oversizedWriteAck(result, 900_000, 1_000) as Record<string, unknown>;
		expect(ack.result_truncated).toBe(true);
		expect(ack.size_bytes).toBe(900_000);
		expect(ack).not.toHaveProperty('items');
	});
});

describe('fitCommentForDelivery', () => {
	it('leaves a message under the cap untouched', () => {
		expect(fitCommentForDelivery('short answer', ['qa'])).toBe('short answer');
	});

	it('cuts a long message to the cap and keeps the mentions it must deliver', () => {
		const fitted = fitCommentForDelivery(`${'z'.repeat(COMMENT_TEXT_MAX_CHARS)} @qa-engineer`, [
			'qa-engineer',
		]);
		expect(fitted.length).toBeLessThanOrEqual(COMMENT_TEXT_MAX_CHARS);
		expect(fitted).toContain("The full message is in this run's log.");
		expect(fitted.endsWith('@qa-engineer')).toBe(true);
	});
});

describe('commentWriteAck', () => {
	it('reports the length of the text, never the text', () => {
		const ack = commentWriteAck({
			id: 'c1',
			public_id: 'p1',
			task_id: 't1',
			content: { text: 'hello world' },
			created_at: '2026-09-22T00:00:00Z',
		});
		expect(ack.content_length).toBe(11);
		expect(ack).not.toHaveProperty('content');
		expect(ack.parent_comment_id).toBeNull();
	});
});

describe('create_comment returns an acknowledgement and enforces the cap', () => {
	it('returns the comment ids without echoing the text or the search column', async () => {
		const task = await newTask('Ack task');
		const res = (await callTool('create_comment', {
			project: projectId,
			task_id: task.id,
			content: 'A short note',
		})) as Record<string, unknown>;
		expect(res.id).toBeTruthy();
		expect(res.public_id).toBeTruthy();
		expect(res.content_length).toBe('A short note'.length);
		expect(res).not.toHaveProperty('content');
		expect(res).not.toHaveProperty('search_tsv');
	});

	it('refuses a comment over the cap and saves nothing', async () => {
		const task = await newTask('Cap task');
		const res = (await callTool('create_comment', {
			project: projectId,
			task_id: task.id,
			content: 'b'.repeat(COMMENT_TEXT_MAX_CHARS + 1),
		})) as { error?: string };
		expect(res.error).toContain(`the limit is ${COMMENT_TEXT_MAX_CHARS}`);
		expect(res.error).toContain('Nothing was posted');
		expect(await commentCount(task.id)).toBe(0);
	});

	it('refuses the same comment over REST', async () => {
		const task = await newTask('REST cap task');
		const res = await app.request(`/api/projects/${projectId}/tasks/${task.id}/comments`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ content: { text: 'c'.repeat(COMMENT_TEXT_MAX_CHARS + 1) } }),
		});
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: { code: string } };
		expect(body.error.code).toBe('COMMENT_TOO_LONG');
		expect(await commentCount(task.id)).toBe(0);
	});
});

describe('an oversized write result is acknowledged, not reported as a failure', () => {
	it('creates a large batch once and tells the caller not to repeat it', async () => {
		const items = Array.from({ length: 10 }, (_, i) => ({
			title: `Batch ${i}`,
			description: 'lorem ipsum '.repeat(800),
			assignee_slug: 'engineer',
		}));
		const res = (await callTool('create_tasks', { project: projectId, items })) as {
			error?: string;
			result_truncated?: boolean;
			items?: Array<{ ok: boolean }>;
		};
		expect(res.error).toBeUndefined();
		expect(res.result_truncated).toBe(true);
		expect(res.items).toHaveLength(10);
		const created = await db.query<{ n: string }>(
			`SELECT count(*) AS n FROM tasks WHERE project_id = $1 AND title LIKE 'Batch %'`,
			[projectId],
		);
		expect(Number(created.rows[0].n)).toBe(10);
	});
});
